import { getRequest } from "@tanstack/react-start/server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Audit-2 H4: per-IP rate limiting for unauthenticated endpoints
 * (the signup functions — account-creation spam). The bucket lives
 * in the rate_limits table and the
 * increment is a single atomic upsert (public.check_rate_limit), so
 * concurrent floods can't overshoot the limit and the limit holds
 * across worker instances (in-memory Maps would not).
 */

/**
 * Audit-3 A2-N3 / A8-N4: real client IP — trust ONLY headers the edge
 * sets from the TCP peer. Header authority per host:
 *   1. `cf-connecting-ip` — Cloudflare (hc.hcroom.workers.dev). Set by
 *      Cloudflare's edge; the client cannot forge it. Audit-4 M28:
 *      trusted ONLY when the Host is the Cloudflare deployment —
 *      on any other host (Vercel, localhost) the header is
 *      client-controlled, and a forged `cf-connecting-ip: <fresh-IP>`
 *      per request used to yield a fresh rate-limit bucket each time
 *      (the per-IP limiter never tripped on Vercel). Ignored there;
 *      the fallbacks below still resolve the real IP.
 *   2. `x-vercel-forwarded-for` — Vercel (vibetalk-one.vercel.app).
 *      Vercel's own copy of the client IP: per Vercel's request-header
 *      docs it is identical to `x-forwarded-for` but cannot be
 *      overwritten by a proxy on top of Vercel, and custom XFF values
 *      are only honoured for Enterprise Trusted Proxy customers — so a
 *      client-supplied XFF never reaches us through this header.
 *      First entry: Vercel's chain is sanitised with the real client
 *      leftmost (a single IP in practice). Audit-4 L11: trusted ONLY
 *      when the Host is the Vercel deployment — on the Cloudflare
 *      host there is no Vercel edge, so a forged xvff would be
 *      trusted there (same class as M28's cf-on-Vercel hole).
 *   3. `x-forwarded-for` LAST entry — last resort, ONLY on hosts
 *      that are NOT a known production host (localhost/dev). The old
 *      code took the FIRST entry, which the client supplies. The last
 *      entry is the one the immediate upstream edge/proxy appended —
 *      the peer it actually saw — so rotating the leftmost entries
 *      cannot rotate the bucket. Audit-4 L11: on a KNOWN production
 *      host the edge ALWAYS sets its header (1)/(2) — if neither is
 *      present, the request did not come through the edge, so XFF is
 *      fully attacker-controlled and must never bucket the limiter
 *      (a forged XFF per request used to yield a fresh bucket each
 *      time). Return null there → the shared "unknown" bucket
 *      (fail-closed: a flood exhausts one shared budget instead of
 *      bypassing the limiter). NOTE: a custom domain added later
 *      must join the host checks below, or it falls back to XFF.
 * If no header yields an IP, returns null and checkRateLimit falls
 * back to the shared "unknown" bucket (a flood then exhausts one
 * shared budget — fail-closed for the limiter).
 */
export function getClientIp(): string | null {
  try {
    const req = getRequest();
    const first = (h: string | null): string | null => {
      if (!h) return null;
      const v = h.split(",")[0].trim();
      return v ? v : null;
    };
    const last = (h: string | null): string | null => {
      if (!h) return null;
      const parts = h
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : null;
    };
    const host = req.headers.get("host")?.split(":")[0].trim().toLowerCase();
    const cf =
      // Audit-4 M28: cf-connecting-ip is edge-set (trustworthy)
      // ONLY on the Cloudflare deployment. Host is the routing
      // hostname the edge served — strip any port, compare
      // case-insensitively. Any other host → the header is
      // client-controlled → ignore it.
      host === "hc.hcroom.workers.dev" ? first(req.headers.get("cf-connecting-ip")) : null;
    if (cf) return cf;
    const xvff =
      // Audit-4 L11: x-vercel-forwarded-for is edge-set ONLY on
      // the Vercel deployment (same reasoning as M28's cf check).
      host === "vibetalk-one.vercel.app"
        ? first(req.headers.get("x-vercel-forwarded-for"))
        : null;
    if (xvff) return xvff;
    // Audit-4 L11: on a known production host, missing edge headers
    // mean the request bypassed the edge — XFF is attacker-controlled.
    if (host === "hc.hcroom.workers.dev" || host === "vibetalk-one.vercel.app") return null;
    return last(req.headers.get("x-forwarded-for"));
  } catch {
    return null;
  }
}

/**
 * Spend one attempt from the per-IP bucket; throw when exhausted.
 * Audit-4 H7: FAIL CLOSED on any RPC error — the old fail-open
 * return let a missing RPC/table (SQL not run) silently disable
 * EVERY limiter, so account-creation spam ran
 * unthrottled. A limiter error now blocks the action: the §H4 SQL
 * (rate_limits + check_rate_limit RPC) is required for the app to
 * work, and a transient DB error fails the same way the flow's own
 * DB work would fail anyway. If no IP is resolvable, the bucket
 * falls back to "unknown" (shared bucket — still limits floods
 * from unidentifiable sources, at the cost of shared quota).
 */
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const ip = getClientIp() ?? "unknown";
  await checkRateLimitKey(`ip:${ip}:${bucket}`, limit, windowSeconds);
}

/**
 * Audit-2 H29: spend one attempt from an ARBITRARY key's bucket (same
 * atomic RPC as checkRateLimit, but keyed by the caller instead of the
 * IP). notifyIncomingCall counts attempts per (caller, callee) pair:
 * the old row-count limit never tripped on a reused callId (the
 * ignoreDuplicates upsert creates no new row), so a fixed callId in a
 * loop sent unlimited pushes. Attempts are counted, not rows — the
 * 11th notify to the same callee within 60s is rejected. Audit-4 H7:
 * fail CLOSED on any RPC error (see checkRateLimit) — never fail open.
 */
export async function checkRateLimitKey(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    // Audit-4 H7: FAIL CLOSED — an RPC error (missing function/table,
    // timeout, RLS) must never disable the limiter. The old code
    // returned here, so a missing §H4 SQL silently allowed unlimited
    // attempts everywhere this limiter guards.
    console.error("[rate-limit] limiter unavailable, blocking:", error.message);
    throw new Error("Rate limit check failed — please try again.");
  }
  // data !== true covers false (limited) AND null/undefined (an
  // unexpected RPC result — never treat it as "allowed").
  if (data !== true) {
    throw new Error("Too many attempts — please wait a minute and try again.");
  }
}
