import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkRateLimitKey } from "@/lib/rate-limit";
import { dbErr } from "@/lib/db-error";
import {
  isAllowedPushEndpoint,
  isValidP256dh,
  isValidPushAuth,
} from "@/lib/push-endpoint-allowlist";

// Audit-2 M48: the old schema accepted ANY url + any 10–200-char
// keys — an authenticated user could point the server's VAPID-signed
// POSTs at a victim's webhook (SSRF/spam amplifier). Endpoints are
// now allowlisted to real push services and keys must decode to
// their spec'd byte lengths.
const subscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(1000)
    .refine(isAllowedPushEndpoint, {
      message: "Push endpoint must belong to a supported push service (Google, Mozilla, Apple, or Microsoft).",
    }),
  p256dh: z.string().refine(isValidP256dh, {
    message: "p256dh must be a 65-byte uncompressed P-256 key (base64url).",
  }),
  auth: z.string().refine(isValidPushAuth, {
    message: "auth must be a 16-byte secret (base64url).",
  }),
});

/** Host of a push endpoint (e.g. fcm.googleapis.com) — identifies a
 * device's push service WITHOUT leaking the full endpoint URL back
 * to the client (Audit-2 L71). Shared by sendTestPush results and
 * listPushSubscriptions. */
function pushEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "unknown";
  }
}
const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20;

/** Save (or refresh) this device's Web Push subscription for the current user. */
export const savePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => subscriptionSchema.parse(d))
  .handler(async ({ data, context }) => {
    // Audit-2 M48: per-user cap — one account must not fan every
    // message out to unlimited endpoints. This check is the
    // fast-path friendly error; the ATOMIC enforcement is the
    // §L40 trigger (enforce_push_subscription_cap) — the old
    // check-then-upsert here let two concurrent saves both pass
    // and both insert (TOCTOU). Refreshing an already-saved
    // endpoint is always allowed; only NEW endpoints count.
    const { data: existing, error: listError } = await context.supabase
      .from("push_subscriptions")
      .select("endpoint")
      .eq("user_id", context.userId);
    if (listError) throw dbErr(listError, "Could not update notifications — please try again.");
    const alreadySaved = (existing ?? []).some((r) => r.endpoint === data.endpoint);
    if (!alreadySaved && (existing ?? []).length >= MAX_PUSH_SUBSCRIPTIONS_PER_USER) {
      throw new Error(
        `Too many push subscriptions for this account (max ${MAX_PUSH_SUBSCRIPTIONS_PER_USER}). Remove one from the Registered devices list below.`,
      );
    }
    const { error } = await context.supabase.from("push_subscriptions").upsert(
      {
        user_id: context.userId,
        endpoint: data.endpoint,
        p256dh: data.p256dh,
        auth: data.auth,
      },
      { onConflict: "user_id,endpoint" },
    );
    if (error) throw dbErr(error, "Could not update notifications — please try again.");
    return { ok: true };
  });

/** Remove this device's Web Push subscription (user turned notifications off). */
export const removePushSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ endpoint: z.string().min(1).max(1000) }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", context.userId)
      .eq("endpoint", data.endpoint);
    if (error) throw dbErr(error, "Could not update notifications — please try again.");
    // Audit-4 L15: this delete runs under RLS (context.supabase),
    // and an RLS-filtered delete affects 0 rows WITHOUT erroring —
    // so "no error" does NOT prove the row is gone. Verify the row
    // is actually gone: 0 rows deleted because it was already gone
    // is success; a SURVIVING row means RLS blocked the delete.
    const { data: remaining, error: checkError } = await context.supabase
      .from("push_subscriptions")
      .select("endpoint")
      .eq("user_id", context.userId)
      .eq("endpoint", data.endpoint)
      .maybeSingle();
    if (checkError) throw dbErr(checkError, "Could not update notifications — please try again.");
    if (remaining) throw new Error("Could not remove the push subscription — please try again.");
    return { ok: true };
  });

/** Remove ALL push subscriptions for the current user (used when the browser
 * subscription is already gone but server rows survive). */
export const removeAllPushSubscriptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw dbErr(error, "Could not update notifications — please try again.");
    // Audit-4 L15: the audit's "mitigated by caller count-check"
    // note was stale — NO caller uses countPushSubscriptions, so
    // the verification moves INTO this fn (same RLS-filtered
    // 0-row hazard as removePushSubscription above). The caller
    // (sign-out-everywhere) treats a throw as best-effort warn.
    const { count, error: countError } = await context.supabase
      .from("push_subscriptions")
      .select("endpoint", { count: "exact", head: true })
      .eq("user_id", context.userId);
    if (countError) throw dbErr(countError, "Could not update notifications — please try again.");
    if ((count ?? 0) > 0)
      throw new Error("Could not remove all push subscriptions — please try again.");
    return { ok: true };
  });

/** Audit-2 L72: how many push-subscription rows the current user
 * still has — the read half of removeAll verification (an
 * RLS-filtered delete affects 0 rows without erroring, so the
 * caller must verify the count reached 0). */
export const countPushSubscriptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { count, error } = await context.supabase
      .from("push_subscriptions")
      .select("endpoint", { count: "exact", head: true })
      .eq("user_id", context.userId);
    if (error) throw dbErr(error, "Could not update notifications — please try again.");
    return { count: count ?? 0 };
  });

/**
 * Audit-2 M72: the server's VAPID public key — the SINGLE source of
 * truth for push subscriptions. The client used to subscribe with
 * VITE_VAPID_PUBLIC_KEY (a second copy of the same keypair); if the
 * operator rotated one var and not the other, the browser subscribed
 * under key A while the server signed with key B -> every push 401'd
 * silently. Now the client resolves the key server-first (see
 * resolveVapidPublicKey in push-client.ts) and only falls back to the
 * VITE_ var when this fn is unavailable. Authenticated like every
 * other push fn (the key is public — it is sent to the push service —
 * but there is no reason to serve it anonymously).
 */
export const getVapidPublicKey = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null }));

/**
 * Audit-4 L34: is this probe error a GENUINELY missing
 * push_subscriptions table? Mirrors C1's isPendingTableMissing:
 * 42P01 / PGRST205 / a "does not exist" message naming this
 * table. Any other error (RLS/permission/policy — e.g. a policy
 * calling a function that doesn't exist, 42883) is NOT a
 * missing table; checkPushSetup reports it as probeError so the
 * UI doesn't tell the user to run SQL that cannot help.
 */
function isPushTableMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  // Tight on purpose: a bare "push_subscriptions ... does not
  // exist" would also match a missing FUNCTION named e.g.
  // can_view_push_subscriptions (42883) — that is a broken
  // policy, NOT a missing table. Require the exact Postgres
  // `relation "..." does not exist` or PostgREST
  // `Could not find the table '...' in the schema cache` forms.
  return (
    /relation "([^"]*\.)?push_subscriptions" does not exist/.test(error.message ?? "") ||
    /Could not find the table '([^']*\.)?push_subscriptions' in the schema cache/.test(error.message ?? "")
  );
}

/**
 * Diagnose the push pipeline: is the table there, are the VAPID keys
 * configured? Per-user/per-device registration is answered by
 * checkPushEndpoint (used in the Profile diagnostics), NOT here.
 */
export const checkPushSetup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // M100: the old code counted ALL rows (subscriptionCount) — a
    // global user/device count leaked to any authenticated caller,
    // and no caller read it. Dropped; the head-only select still
    // probes table existence via tableMissing.
    const { error: tableError } = await context.supabase
      .from("push_subscriptions")
      .select("id", { head: true });
    // Audit-3 A7-N8: the raw PostgREST/DB message never leaves the
    // server — it is logged here, and the client gets only the
    // stable flags (the renders show fixed strings).
    // Audit-4 L34: only a GENUINE missing-table error sets
    // tableMissing — the old code reported ANY probe error as
    // "table missing", and the UI told the user to run SQL that
    // cannot help (the table exists; the probe failed for
    // another reason). Other errors set probeError so the UI
    // says the check itself failed.
    const tableMissing = isPushTableMissing(tableError);
    if (tableError) {
      console.warn("[push] checkPushSetup push_subscriptions probe failed:", tableError.message);
    }
    return {
      tableOk: !tableError,
      tableMissing,
      probeError: Boolean(tableError) && !tableMissing,
      vapidConfigured: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
      // Audit-2 M73: the service-role key is what lets the server READ
      // push_subscriptions for other users (notifyNewMessage). Without
      // it, messages send fine but push never fires — and the old
      // notifyNewMessage swallowed that silently. Surfaced here so
      // Profile diagnostics can say it out loud.
      serviceRoleConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    };
  });

/**
 * Audit-4 L25: fingerprint of a push endpoint for per-device
 * results. sendTestPush results used to carry only endpointHost,
 * so two Chrome devices both reported fcm.googleapis.com and a
 * `{sent:1,total:2}` couldn't say WHICH device failed. This
 * FNV-1a fingerprint distinguishes devices without leaking the
 * full endpoint URL back to the client (Audit-2 L71). Display
 * disambiguation only — NOT a security identifier; collisions
 * across one user's handful of devices are negligible (~n²/2³³).
 */
function endpointFingerprint(endpoint: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < endpoint.length; i++) {
    h ^= endpoint.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Send a real test push to all of this user's registered devices.
 * Used from Profile to verify push actually arrives in this browser.
 */
export const sendTestPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Audit-3 A8-N18: per-user test-push throttle — an authenticated
    // user could otherwise hammer test pushes to their own devices
    // (self-targeted spam + push-service load). 5/min; fail CLOSED
    // if the rate-limit RPC/table is missing (Audit-4 H7) — the
    // §H4 SQL is required. Per-user, not per-IP: the fn is authenticated.
    await checkRateLimitKey(`test-push:${context.userId}`, 5, 60);
    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    if (!vapidPublic || !vapidPrivate) throw new Error("Push keys not configured on server.");
    const { data: subs, error } = await context.supabase
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("user_id", context.userId);
    if (error) throw dbErr(error, "Could not send the test notification — please try again.");
    if (!subs || subs.length === 0)
      throw new Error("No push subscriptions for this account on any device.");
    const { sendWebPush, vapidSubject } = await import("@/lib/webpush-send.server");
    const payload = JSON.stringify({
      title: "VibeTalk test 🔔",
      body: "Push notifications are working on this device.",
      tag: "hcroom-test",
      roomId: null,
    });
    const results = await Promise.allSettled(
      subs.map((s) =>
        sendWebPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, payload, {
          publicKey: vapidPublic,
          privateKey: vapidPrivate,
          subject: vapidSubject(), // M72: was a hardcoded literal
        }).then((r) => ({ result: r, endpoint: s.endpoint })),
      ),
    );
    // Mirror notifyNewMessage: drop dead subscriptions so a stale
    // endpoint doesn't make every future test report failure forever.
    // Audit-2 H21: delete ONLY on 404/410. 401/403 also fires for
    // server-side problems (bad VAPID key / subject / clock skew) —
    // deleting on it wiped every subscription in one sweep on a
    // single bad deploy. Row kept + logged instead.
    for (const r of results) {
      if (r.status === "fulfilled") {
        const { result, endpoint } = r.value;
        if (!result.ok && (result.status === 404 || result.status === 410)) {
          // Audit-2 M49: explicit user_id filter (RLS already scopes
          // this to the caller's rows; the filter makes it true even
          // if the policy ever regresses).
          // Audit-4 L35: CHECK the delete error — the old code
          // awaited the delete but never looked at `error`, so a
          // failed cleanup silently retried on every next test
          // (the dead row survived, and nothing said why). Log it
          // with the endpoint fingerprint (not the raw endpoint —
          // L25 posture). The test result itself is unchanged: the
          // push already failed, and the cleanup is best-effort.
          const { error: deleteError } = await context.supabase
            .from("push_subscriptions")
            .delete()
            .eq("endpoint", endpoint)
            .eq("user_id", context.userId);
          if (deleteError) {
            console.warn(
              "[push] sendTestPush dead-subscription cleanup failed — the dead row survives and the next test will report it again (endpointId, error):",
              endpointFingerprint(endpoint),
              deleteError.message,
            );
          }
        } else if (!result.ok && (result.status === 401 || result.status === 403)) {
          console.warn(
            `[push] VAPID auth failed (HTTP ${result.status}) on test push — subscription kept, not deleted. Check VAPID keys / subject / server clock.`,
          );
        }
      }
    }
    const sent = results.filter((r) => r.status === "fulfilled" && r.value.result.ok).length;
    // Audit-2 L71: per-device results — {sent, total} alone couldn't
    // say WHICH device failed. endpointHost (the push-service host,
    // e.g. fcm.googleapis.com) distinguishes devices without
    // leaking the full endpoint URL back to the client.
    // Audit-4 L25: endpointHost alone COLLAPSES when devices share
    // a push host (two Chrome devices both report
    // fcm.googleapis.com). endpointId (a fingerprint of the
    // endpoint) disambiguates them.
    // Audit-4 L40: the host helper is module-scope (pushEndpointHost)
    // so listPushSubscriptions shares it instead of duplicating it.
    return {
      sent,
      total: subs.length,
      results: results.map((r, i) => {
        const host = pushEndpointHost(subs[i].endpoint);
        const endpointId = endpointFingerprint(subs[i].endpoint);
        if (r.status === "fulfilled") {
          return { endpointHost: host, endpointId, ok: r.value.result.ok, status: r.value.result.status };
        }
        return { endpointHost: host, endpointId, ok: false, status: 0 };
      }),
    };
  });

/**
 * Audit-4 L40: list THIS user's push subscriptions for the
 * "Registered devices" UI — the per-device removal the cap error
 * points at. Returns ONLY the row id + push-service host +
 * endpoint fingerprint + whether the row is the caller's current
 * device. The full endpoint URL and the p256dh/auth keys NEVER
 * leave the server (Audit-2 L71 posture): removal goes through
 * removePushSubscriptionById, keyed on the row id.
 */
export const listPushSubscriptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ endpoint: z.string().max(1000).nullable().optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("push_subscriptions")
      .select("id, endpoint")
      .eq("user_id", context.userId)
      .order("endpoint");
    if (error) throw dbErr(error, "Could not update notifications — please try again.");
    return {
      subscriptions: (rows ?? []).map((r) => ({
        id: r.id as string,
        endpointHost: pushEndpointHost(r.endpoint),
        endpointId: endpointFingerprint(r.endpoint),
        isThisDevice: data.endpoint != null && r.endpoint === data.endpoint,
      })),
    };
  });

/**
 * Audit-4 L40: remove ONE push subscription by row id (the
 * "Registered devices" UI). Same verify-gone pattern as
 * removePushSubscription (Audit-4 L15): an RLS-filtered delete
 * affects 0 rows WITHOUT erroring, so "no error" does NOT prove
 * the row is gone. A foreign id is indistinguishable from an
 * already-gone row (the caller cannot see it under RLS) and
 * reports success — the row survives, untouched, which is the
 * same false-success shape removePushSubscription already has;
 * there is no way for the caller to delete another user's row.
 */
export const removePushSubscriptionById = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", context.userId)
      .eq("id", data.id);
    if (error) throw dbErr(error, "Could not update notifications — please try again.");
    const { data: remaining, error: checkError } = await context.supabase
      .from("push_subscriptions")
      .select("id")
      .eq("user_id", context.userId)
      .eq("id", data.id)
      .maybeSingle();
    if (checkError) throw dbErr(checkError, "Could not update notifications — please try again.");
    if (remaining) throw new Error("Could not remove the push subscription — please try again.");
    return { ok: true };
  });

/** Does this exact push endpoint exist for the current user? */
export const checkPushEndpoint = createServerFn({ method: "POST" })  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ endpoint: z.string().min(1).max(1000) }).parse(d))
  .handler(async ({ data, context }) => {
    const { count, error } = await context.supabase
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .eq("endpoint", data.endpoint);
    if (error) throw dbErr(error, "Could not update notifications — please try again.");
    return { registered: (count ?? 0) > 0 };
  });
