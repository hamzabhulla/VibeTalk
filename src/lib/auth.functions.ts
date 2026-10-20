import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { randomBase64Url } from "@/lib/random";
import { checkRateLimit, checkRateLimitKey } from "@/lib/rate-limit";
import { dbErr } from "@/lib/db-error";
import { passwordPolicyError } from "@/lib/password-policy";
import { isUserOnline } from "@/lib/presence";
import type { Database } from "@/integrations/supabase/types";

// H37: the profile patch typed as the real profiles Update — passing a
// bare Record<string, unknown> to .update() was a type error the build
// never caught (Vite strips types without checking).
type ProfileUpdate = Database["public"]["Tables"]["profiles"]["Update"];

/**
 * H15: find a FRESH unconfirmed account for this email (a possible
 * orphan from an earlier signup attempt whose pending-row insert
 * failed/crashed). The admin API has no email filter, so this scans
 * listUsers — fine at this app's scale. Only accounts that are
 * unconfirmed AND created within the last 5 minutes qualify: a retry
 * happens right after the first attempt, so anything older is
 * someone else's account, not this signup's orphan.
 */
async function findRecentUnconfirmedUser(email: string) {
  // Audit-2 L84: paginate (was page 1 only — an orphan past the
  // first 1000 users was never found). Bounded at 10 pages (10k
  // users) so a pathological user count can't loop forever.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) return null;
    const users = data?.users ?? [];
    const user = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (user) {
      if (user.email_confirmed_at) return null;
      if (Date.now() - new Date(user.created_at).getTime() > 5 * 60 * 1000) return null;
      return user;
    }
    if (users.length < 1000) return null;
  }
  return null;
}

// Audit-4 C1: is this DB error "the password_setup_pending table does
// not exist yet" (SQL not run)? The setup flow tolerates the missing
// table (legacy metadata-flag fallback) so signup/setup keep working
// until §C1 SQL runs — but a missing table must never be mistaken for
// "not pending".
function isPendingTableMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /password_setup_pending.*does not exist|Could not find the table.*password_setup_pending/i.test(
    error.message ?? "",
  );
}

/**
 * Audit-4 M2: duplicate-email detection by error CODE, not message
 * substring. Redeem used to match "already registered" in the
 * message — a GoTrue wording change would silently reopen the
 * registered-email oracle (distinct error) and break orphan
 * adoption. GoTrue's duplicate code is "email_exists" (the same
 * code changeEmail already checks, Audit-2 M14). The message check
 * survives ONLY as a fallback when no code is present (older GoTrue
 * / proxied errors) — a missing code degrades to the old behavior
 * instead of reopening the oracle. A present-but-different code
 * returns false: the message is never consulted when a code exists.
 */
function isDuplicateEmailError(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "email_exists") return true;
  if (typeof error.code !== "undefined" && error.code !== null) return false;
  return typeof error.message === "string" && error.message.toLowerCase().includes("already registered");
}

// Create an account from an email + display name (the /join flow).
// Invite tokens were REMOVED 2026-10-20 (owner order) — signup no
// longer needs a code. The protections that made the old token flow
// safe now carry the weight on their own: the account is created
// UNCONFIRMED (H12) with a SERVER-GENERATED RANDOM password
// (audit-2 H1), so a verification link clicked by anyone but the
// email owner yields no login — the owner sets their own password
// after verifying (password_setup_pending + /set-password). The
// join page collects no password.
export const registerWithEmail = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        email: z.string().email().max(255),
        displayName: z.string().trim().min(1).max(40),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    // Per-IP rate limit BEFORE any work: 10 signups / 10 min. A
    // legit user signs up once; this is the account-creation spam
    // control that remains now that no invite token gates signup.
    await checkRateLimit("email-signup", 10, 600);

    // 1. Create the account UNCONFIRMED with a random password
    // nobody knows (H1/H12 — see the header comment).
    const { data: created, error: signErr } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: randomBase64Url(32),
      email_confirm: false,
      user_metadata: {
        display_name: data.displayName,
        // Audit-2 H1: the owner must set their password after
        // verifying (forced setup — /auth/callback routes flagged
        // sessions to /set-password, and the _app layout guards
        // flagged sessions).
        password_setup_pending: true,
      },
    });
    if (signErr || !created?.user) {
      // H15: idempotent retry. If the email is already registered,
      // the account may be THIS flow's orphan (createUser succeeded
      // in an earlier attempt but the pending-row insert
      // failed/crashed). If the existing account is a fresh
      // unconfirmed one, adopt it and return success — the retry
      // succeeds instead of dead-ending.
      if (isDuplicateEmailError(signErr)) {
        const orphan = await findRecentUnconfirmedUser(data.email);
        // Audit-2 H1: only adopt an orphan created by THIS flow
        // (password_setup_pending flag). An account without the
        // flag carries a password somebody chose — adopting it
        // would hand them a verified account via a clicked link.
        if (orphan && (orphan.user_metadata as Record<string, unknown> | null)?.password_setup_pending === true) {
          // Audit-6 A6-LOW-2 ordering, kept: the pending row goes
          // in and a REAL insert failure throws — a confirmed
          // account with NO server-side pending row would silently
          // lose the set-password path. A duplicate (23505) means an
          // earlier attempt already inserted the row — that IS the
          // desired end state. Table-missing stays tolerated
          // (pre-SQL the metadata flag carries setup state).
          const { error: orphanPendingErr } = await supabaseAdmin
            .from("password_setup_pending")
            .insert({ user_id: orphan.id });
          if (
            orphanPendingErr &&
            !isPendingTableMissing(orphanPendingErr) &&
            orphanPendingErr.code !== "23505"
          ) {
            console.warn(
              "[signup] pending-row insert failed for adopted orphan",
              orphan.id,
              orphanPendingErr.message,
            );
            throw new Error("Account setup could not be completed — please try again.");
          }
          return { ok: true };
        }
        // Audit-2 H4 (registered-status oracle): the email IS
        // registered but it is not this flow's orphan. Return the
        // SAME { ok: true } as a success — the caller sees the
        // identical "Check your inbox" screen. A distinct error
        // would give anyone an oracle for ANY email (registered
        // or not).
        return { ok: true };
      }
      // Audit-4 M2: never leak the raw admin error to the client —
      // it can carry internals (and a distinct "already registered"
      // text is itself the oracle). Log it server-side, throw
      // generic.
      console.warn("[signup] createUser failed:", signErr?.message ?? signErr);
      throw new Error("Could not create account — please try again later.");
    }

    // 2. Audit-4 C1: record the setup-pending state SERVER-SIDE
    // (see vibetalk-audit4-fixes.sql §C1). The user_metadata flag
    // written at createUser is a UX hint only — any session can
    // overwrite its own metadata, so it must never be the
    // authorization for a password set. A failure here removes the
    // account and a retry starts clean (createUser -> "already
    // registered" -> orphan adoption, which inserts the row).
    const { error: pendingErr } = await supabaseAdmin
      .from("password_setup_pending")
      .insert({ user_id: created.user.id });
    if (pendingErr && !isPendingTableMissing(pendingErr)) {
      const { error: delErr1 } = await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      let delErr = delErr1;
      if (delErr) {
        const retry = await supabaseAdmin.auth.admin.deleteUser(created.user.id);
        delErr = retry.error;
      }
      if (delErr) {
        console.warn("[signup] pending-row cleanup failed for user", created.user.id, delErr.message);
      }
      throw new Error("Account setup could not be completed — please try again.");
    }
    // (Table missing = pre-SQL legacy: the metadata flag carries
    // setup state until §C1 runs; completePasswordSetup falls back.)

    return { ok: true };
  });

// Audit-4 C1: password setup goes through the SERVER, gated on the
// server-side password_setup_pending row — never on user_metadata,
// which any session can overwrite via updateUser({ data }) (the old
// /set-password flow trusted exactly that flag, so a stolen session
// could flip it and reach the password-set form). The row is created
// only by the signup server functions and consumed here (one-time) or by
// clearPasswordSetupPending (password reset). Pre-SQL (table
// missing) the flow falls back to the admin-read metadata flag —
// same behaviour as before, no setup regression until §C1 runs.
export const getPasswordSetupPending = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const { data: row, error } = await supabaseAdmin
      .from("password_setup_pending")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!error) return { pending: !!row };
    if (isPendingTableMissing(error)) {
      const { data: userRes, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (userErr || !userRes?.user) throw new Error("Something went wrong — please try again later.");
      return {
        pending:
          (userRes.user.user_metadata as Record<string, unknown> | null)?.password_setup_pending === true,
      };
    }
    throw new Error("Something went wrong — please try again later.");
  });

export const completePasswordSetup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ password: z.string().min(1).max(256) }).parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    // Rate limit FIRST (per-user bucket — one account's flood must
    // not block others).
    await checkRateLimitKey(`setup-password:${userId}`, 5, 600);
    // Server-side policy check: the client's check is UX only.
    const pwError = passwordPolicyError(data.password);
    if (pwError) throw new Error(pwError);
    const { data: row, error: rowError } = await supabaseAdmin
      .from("password_setup_pending")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (rowError && !isPendingTableMissing(rowError)) {
      throw new Error("Something went wrong — please try again later.");
    }
    const serverPending = !rowError && !!row;
    let legacyPending = false;
    if (!serverPending && rowError && isPendingTableMissing(rowError)) {
      const { data: userRes, error: userErr } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (userErr || !userRes?.user) throw new Error("Something went wrong — please try again later.");
      legacyPending =
        (userRes.user.user_metadata as Record<string, unknown> | null)?.password_setup_pending === true;
    }
    if (!serverPending && !legacyPending) {
      throw new Error("Password setup is not pending for this account.");
    }
    // The server-verified pending state is the authorization: set the
    // password via the ADMIN API (the client never calls updateUser
    // with a password for setup) and clear the metadata hint in the
    // same call so the _app bounce stops firing.
    const { error: setErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: data.password,
      user_metadata: { password_setup_pending: false },
    });
    if (setErr) throw new Error("Could not set the password — please try again.");
    if (serverPending) {
      const { error: delErr } = await supabaseAdmin
        .from("password_setup_pending")
        .delete()
        .eq("user_id", userId);
      if (delErr) {
        // Password IS set; the row survives. A retry re-sets the same
        // password and consumes the row — safe. Surface a distinct
        // error so the user retries instead of assuming completion.
        throw new Error("Password was set but setup could not be marked complete — please try again.");
      }
    }
    return { ok: true };
  });

// Mark setup complete without changing the password (password-reset
// flow: the reset itself sets a usable password). Also clears the
// metadata hint so the _app bounce stops firing — this is the
// stale-flag healer the /set-password page calls when the server
// says setup is not pending.
export const clearPasswordSetupPending = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context;
    const { error } = await supabaseAdmin
      .from("password_setup_pending")
      .delete()
      .eq("user_id", userId);
    if (error && !isPendingTableMissing(error)) {
      throw new Error("Something went wrong — please try again later.");
    }
    const { error: metaErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: { password_setup_pending: false },
    });
    if (metaErr) throw new Error("Something went wrong — please try again later.");
    return { ok: true };
  });

// Audit-4 M1: server-side password policy for the remaining setters.
// completePasswordSetup (C1) already enforces the policy server-side;
// register, reset-password, and change-password called GoTrue
// directly after a client-only check, so a console/curl call bypassed
// min-8, the blocklist, and the 72-byte cap. Each setter below goes
// through the server, which enforces passwordPolicyError before any
// GoTrue call. Honest residual (same as C1): a stolen session can
// still call GoTrue's updateUser directly — GoTrue's API is public
// and no app code can disable that. What these fns close is the
// APP's own flows: every password the app sets is policy-checked
// server-side.
/**
 * Audit-6 A6-INFO-4: the register confirmation resend used to
 * pass a fully client-supplied redirectTo into emailRedirectTo —
 * the only bound was GoTrue's dashboard allowlist (a live setting
 * code cannot verify). Defense in depth: only the two production
 * origins (and localhost, for dev) with the exact /auth/callback
 * path are honored; anything else falls back to the canonical
 * production callback instead of the caller's URL.
 */
function safeEmailRedirectTo(raw: string | undefined): string {
  const FALLBACK = "https://hc.hcroom.workers.dev/auth/callback";
  if (!raw) return FALLBACK;
  try {
    const u = new URL(raw);
    const prodOrigin =
      u.origin === "https://hc.hcroom.workers.dev" ||
      u.origin === "https://vibetalk-one.vercel.app";
    const devOrigin =
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    if ((prodOrigin || devOrigin) && u.pathname === "/auth/callback") {
      // Audit-7 A3: `raw` used to be returned verbatim — a userinfo
      // URL (https://user:pass@hc.hcroom.workers.dev/auth/callback)
      // passes this check because URL.origin excludes userinfo, and
      // the embedded credentials then rode into the confirmation
      // email's redirect link. Return the parsed URL with userinfo
      // stripped; everything else (path/query) is preserved.
      u.username = "";
      u.password = "";
      return u.toString();
    }
  } catch {
    // unparseable — fall through to the fallback
  }
  return FALLBACK;
}

export const registerWithPassword = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        email: z.string().trim().email(),
        password: z.string().min(1).max(256),
        displayName: z.string().trim().min(1).max(40),
        redirectTo: z.string().url().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    // Rate limit FIRST (per-IP bucket — unauthenticated endpoint, same
    // pattern as the email signup's "email-signup" bucket): account-creation spam.
    await checkRateLimit("register", 10, 600);
    // Server-side policy check: the client's check is UX only.
    const pwError = passwordPolicyError(data.password);
    if (pwError) throw new Error(pwError);
    const email = data.email.trim().toLowerCase();
    const { error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: data.password,
      email_confirm: false,
      user_metadata: { display_name: data.displayName },
    });
    if (error) {
      // Duplicate email -> NEUTRAL success (no oracle): the caller
      // shows "Check your inbox" for fresh and existing addresses
      // alike, and no mail is sent for the existing one. Code-first
      // detection (Audit-4 M2): isDuplicateEmailError.
      if (isDuplicateEmailError(error)) {
        return { ok: true };
      }
      // Audit-4 M2: never leak the raw admin error to the client.
      console.warn("[register] createUser failed:", error.message ?? error);
      throw new Error("Could not create account — please try again later.");
    }
    // Confirmation email: admin.createUser does not reliably send
    // one, so trigger it explicitly. Best-effort — if this fails
    // (e.g. GoTrue already sent one and the resend hits the
    // per-email frequency guard), the register page's manual resend
    // button covers it. Never fail the signup over the mail send.
    try {
      await supabaseAdmin.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: safeEmailRedirectTo(data.redirectTo) },
      });
    } catch (err) {
      console.warn(
        "[register] confirmation resend failed (manual resend covers it):",
        err instanceof Error ? err.message : err,
      );
    }
    return { ok: true };
  });

export const resetPasswordWithPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ password: z.string().min(1).max(256) }).parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    // Rate limit FIRST (per-user bucket — one account's flood must
    // not block others).
    await checkRateLimitKey(`reset-password:${userId}`, 5, 600);
    // Server-side policy check: the client's check is UX only.
    const pwError = passwordPolicyError(data.password);
    if (pwError) throw new Error(pwError);
    // The recovery session authenticates this call (requireSupabaseAuth).
    // Clear the setup-pending metadata flag too: a reset sets a usable
    // password, so setup is done (the pending ROW is cleared by the
    // client's clearPending() call, as before).
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: data.password,
      user_metadata: { password_setup_pending: false },
    });
    if (error) throw dbErr(error, "Could not set your password — please try again.");
    return { ok: true };
  });

export const changePasswordWithPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ newPassword: z.string().min(1).max(256) }).parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    // Rate limit FIRST (per-user bucket).
    await checkRateLimitKey(`change-password:${userId}`, 5, 600);
    // Server-side policy check: the client's check is UX only.
    // The current-password re-auth stays client-side (account-security
    // reauthenticate) — this fn only sets the new password on an
    // authenticated (freshly re-authed) session.
    const pwError = passwordPolicyError(data.newPassword);
    if (pwError) throw new Error(pwError);
    // Password ONLY — never touch user_metadata here.
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: data.newPassword,
    });
    if (error) throw dbErr(error, "Could not change your password — please try again.");
    return { ok: true };
  });

// Get current user's profile (used by guards & UI). No roles — every user
// is a normal user. The is_public read is best-effort: until
// vibetalk-e2ee-visibility.sql runs, the column doesn't exist yet and we
// fall back to public (true) instead of breaking the page.
/**
 * Desktop-redesign fix (2026-10-20): since audit-2 §M53 the
 * heartbeat writes ONLY the `presence` table — `profiles.
 * last_seen_at` is frozen forever. getMe returned the raw profiles
 * row, so the signed-in user ALWAYS saw themselves as "Offline" on
 * their own Profile page (root-caused from Hamza's live screenshot:
 * active session, "Member · Offline"). Overlay the presence row's
 * timestamp exactly like attachPresence does for other users
 * (chat.functions.ts): presence wins when present; any failure
 * keeps the profiles timestamps and never breaks getMe.
 */
async function mergeSelfPresence<T extends { last_seen_at?: string | null; is_online?: boolean | null }>(
  client: typeof supabaseAdmin,
  userId: string,
  profile: T | null,
): Promise<T | null> {
  if (!profile) return profile;
  try {
    const { data, error } = await client
      .from("presence")
      .select("last_seen_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (!error && data?.last_seen_at) {
      profile.last_seen_at = data.last_seen_at;
      profile.is_online = isUserOnline(data.last_seen_at);
    }
  } catch (err) {
    console.warn("[getMe] presence merge failed — keeping profiles timestamps:", err);
  }
  return profile;
}

export const getMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const base =
      "id, display_name, avatar_url, bio, custom_status, is_online, last_seen_at, message_count, created_at";
    const privacyCols =
      "is_public, is_avatar_public, is_name_public, is_bio_public, is_status_public, show_notification_previews";
    const privacyDefaults = {
      is_public: true,
      is_avatar_public: true,
      is_name_public: true,
      is_bio_public: true,
      is_status_public: true,
      // Audit-2 L70: previews ON by default (pre-SQL / missing column).
      show_notification_previews: true,
    };
    const { data, error } = await supabase
      .from("profiles")
      .select(`${base}, ${privacyCols}`)
      .eq("id", userId)
      .maybeSingle();
    if (!error) return { userId, profile: await mergeSelfPresence(supabase, userId, data) };
    // Tolerate missing privacy columns (SQL not run yet): retry without the
    // per-section columns, then without is_public — defaults are public.
    const { data: fallback, error: fallbackError } = await supabase
      .from("profiles")
      .select(`${base}, is_public`)
      .eq("id", userId)
      .maybeSingle();
    if (!fallbackError)
      // M86: defaults FIRST, real data on top — the old order
      // ({...fallback, ...privacyDefaults}) let the all-true defaults
      // overwrite any per-section value the row actually carried.
      // Today the fallback query doesn't select those columns, so
      // this is identical behaviour; the order is what keeps it
      // correct if the fallback select ever grows them.
      return {
        userId,
        profile: await mergeSelfPresence(
          supabase,
          userId,
          fallback ? { ...privacyDefaults, ...fallback, is_public: fallback.is_public ?? true } : null,
        ),
      };
    const { data: baseOnly, error: baseError } = await supabase
      .from("profiles")
      .select(base)
      .eq("id", userId)
      .maybeSingle();
    if (baseError) {
      // Audit-4 L10: never throw the raw PostgREST error — it can
      // carry table/column names (e.g. "column profiles.X does not
      // exist") to the client. Log server-side, throw generic.
      console.warn("[getMe] profile fetch failed:", baseError.message ?? baseError);
      throw new Error("Could not load your profile — please try again.");
    }
    return {
      userId,
      // Audit-7 A4: defaults FIRST, real data on top — this path
      // still had the pre-M86 order ({...baseOnly, ...privacyDefaults}),
      // so the all-true defaults would overwrite a real per-section
      // value if the base select ever grew a privacy column. Today
      // it selects none, so behaviour is identical; the order is
      // the fix, matching the fallback path above.
      profile: await mergeSelfPresence(supabase, userId, baseOnly ? { ...privacyDefaults, ...baseOnly } : null),
    };
  });

// Update the signed-in user's public profile (incl. profile visibility:
// isPublic=false hides the profile from the People list / discovery).
// Audit-2 M66: server-side avatar validation. The client-side
// checks in uploadAvatar are UX only (bypassable — anyone can PUT bytes
// directly to storage; the INSERT policy only checks the folder
// prefix, and the stored content-type is attacker-set). So updateProfile
// verifies the stored object itself before accepting the path: it must
// exist, be <= 5 MB (server-measured size via info(), then the
// downloaded Blob's size as ground truth — the pre-download gate keeps
// a giant fake avatar from forcing a giant download), and its BYTES
// must start with a raster image signature (magic bytes). SVG is
// rejected: it is a document format that can carry script, and this
// app has no SVG sanitizer. Existing stored SVG avatars keep rendering
// via <img> (safe — the image context never executes scripts) and
// signAvatar now downloads on direct navigation; only NEW SVG uploads
// are rejected. Storage errors fail CLOSED (the avatar change is
// rejected rather than accepted unverified).
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MAGIC: { name: string; check: (b: Uint8Array) => boolean }[] = [
  {
    name: "PNG",
    check: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    name: "JPEG",
    check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    name: "GIF",
    check: (b) =>
      b.length >= 6 &&
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  },
  {
    name: "WebP",
    check: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  {
    name: "AVIF",
    check: (b) =>
      b.length >= 12 &&
      b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
      b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && (b[11] === 0x66 || b[11] === 0x73),
  },
  {
    name: "BMP",
    check: (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d,
  },
];
async function assertValidAvatarFile(path: string): Promise<void> {
  const { data: info, error: infoError } = await supabaseAdmin.storage
    .from("chat-attachments")
    .info(path);
  if (infoError || !info) throw new Error("Avatar file not found — upload it again.");
  if (typeof info.size === "number" && info.size > AVATAR_MAX_BYTES) {
    throw new Error("Avatar must be under 5 MB.");
  }
  const { data: blob, error: dlError } = await supabaseAdmin.storage
    .from("chat-attachments")
    .download(path);
  if (dlError || !blob) throw new Error("Could not read the avatar file — upload it again.");
  if (blob.size > AVATAR_MAX_BYTES) throw new Error("Avatar must be under 5 MB.");
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (!AVATAR_MAGIC.some((m) => m.check(head))) {
    throw new Error(
      "Avatar must be a PNG, JPEG, GIF, WebP, AVIF, or BMP image (SVG is not supported).",
    );
  }
}

export const updateProfile = createServerFn({ method: "POST" })  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        // H41: ALL fields optional — partial semantics. `undefined` =
        // "don't touch this field" (the visibility/privacy toggles send
        // only the one field they change); `null` = clear the field
        // (the profile editors send null for a cleared bio/status).
        // Previously displayName was required and undefined bio/status
        // were mapped to NULL — a toggle tapped before the profile
        // loaded wiped bio/status and overwrote the display name with
        // the auth-metadata fallback (possibly a raw email).
        displayName: z.string().trim().min(1).max(40).optional(),
        bio: z.string().trim().max(160).nullable().optional(),
        customStatus: z.string().trim().max(60).nullable().optional(),
        avatarPath: z.string().max(500).nullable().optional(),
        isPublic: z.boolean().optional(),
        isAvatarPublic: z.boolean().optional(),
        isNamePublic: z.boolean().optional(),
        isBioPublic: z.boolean().optional(),
        isStatusPublic: z.boolean().optional(),
        // Audit-2 L70: lock-screen privacy — hide message previews.
        showNotificationPreviews: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    // Audit-5 B1-LOW: no limiter here let one account loop this fn —
    // each call can cost a storage info()+download (<= 5 MB) plus an
    // admin updateUserById (egress/cost amplification). Rate limit
    // FIRST, per user (M1 pattern): 20 saves / 10 min is far above
    // any human editing session.
    await checkRateLimitKey(`update-profile:${userId}`, 20, 600);
    // Audit-4 L45: validate whenever a non-null path is provided —
    // the old `if (data.avatarPath)` was falsy for `""`, so an
    // empty string SKIPPED the prefix/`..`/filename checks and
    // assertValidAvatarFile, yet the patch builder below (which
    // keys on `!== undefined`) still wrote `avatar_url: ""`.
    // `null` is the clear signal (H41) and skips validation;
    // `""` now flows into the checks and is rejected as invalid
    // (it doesn't start with the expected prefix). No client
    // sends `""` — both editors only include avatarPath for a
    // real upload — so this rejects only direct-call input.
    if (data.avatarPath !== undefined && data.avatarPath !== null) {
      const expectedPrefix = `${userId}/profile/`;
      // Audit-2 L88: the old check let `<userId>/profile/` (empty
      // filename) pass — the trailing "" contains no "/".
      const filename = data.avatarPath.slice(expectedPrefix.length);
      if (
        !data.avatarPath.startsWith(expectedPrefix) ||
        data.avatarPath.includes("..") ||
        !filename ||
        filename.includes("/")
      ) {
        throw new Error("Invalid avatar path.");
      }
      // Audit-2 M66: verify the stored bytes (see assertValidAvatarFile).
      await assertValidAvatarFile(data.avatarPath);
    }
    // H41: partial patch — only provided fields are written. A field
    // the caller didn't send (undefined) is left alone, never wiped.
    const patch: ProfileUpdate = {
      ...(data.displayName !== undefined ? { display_name: data.displayName } : {}),
      ...(data.bio !== undefined ? { bio: data.bio } : {}),
      ...(data.customStatus !== undefined ? { custom_status: data.customStatus } : {}),
      ...(data.avatarPath !== undefined ? { avatar_url: data.avatarPath } : {}),
      ...(data.isPublic !== undefined ? { is_public: data.isPublic } : {}),
      ...(data.isAvatarPublic !== undefined ? { is_avatar_public: data.isAvatarPublic } : {}),
      ...(data.isNamePublic !== undefined ? { is_name_public: data.isNamePublic } : {}),
      ...(data.isBioPublic !== undefined ? { is_bio_public: data.isBioPublic } : {}),
      ...(data.isStatusPublic !== undefined ? { is_status_public: data.isStatusPublic } : {}),
      ...(data.showNotificationPreviews !== undefined
        ? { show_notification_previews: data.showNotificationPreviews }
        : {}),
    };
    // Nothing to update (caller sent no fields) — succeed without a
    // pointless empty UPDATE.
    if (Object.keys(patch).length === 0) return { ok: true, warning: null };
    const PRIVACY_KEYS = ["is_public", "is_avatar_public", "is_name_public", "is_bio_public", "is_status_public", "show_notification_previews"];
    // M88: .select("id") so we know whether any row was actually
    // updated — a plain UPDATE matching 0 rows is NOT an error in
    // Supabase, so a missing profile used to report { ok: true }.
    let { data: updated, error } = await supabaseAdmin
      .from("profiles")
      .update(patch)
      .eq("id", userId)
      .select("id");
    let warning: string | null = null;
    // Until the visibility/privacy SQL runs, the privacy columns don't exist:
    // save everything else and report the privacy gap as a WARNING, not a
    // failure (H16). Throwing here made the user see an error even though
    // the profile saved — and skipped the auth-metadata sync below, so
    // user_metadata.display_name drifted from profiles.display_name
    // (AppShell / mobile-shell read the name from user_metadata).
    // Hoisted: TS doesn't narrow `error` inside the .some() callback,
    // so reading error.message there was "'error' is possibly 'null'".
    const errorMessage = error?.message ?? "";
    if (error && PRIVACY_KEYS.some((k) => errorMessage.includes(k))) {
      // Rebuild without the privacy keys — the retry saves everything
      // else. Typed as ProfileUpdate via the cast (fromEntries is
      // untyped); the keys come from `patch`, so the shape is exact.
      const rest = Object.fromEntries(
        Object.entries(patch).filter(([k]) => !PRIVACY_KEYS.includes(k)),
      ) as ProfileUpdate;
      // H41: if the caller sent ONLY privacy fields, the retry has
      // nothing to save — skip the empty UPDATE, report the warning.
      if (Object.keys(rest).length === 0) {
        error = null;
        warning =
          "Profile saved, but privacy settings need vibetalk-profile-privacy.sql run in Supabase first.";
      } else {
        const retry = await supabaseAdmin
          .from("profiles")
          .update(rest)
          .eq("id", userId)
          .select("id");
        updated = retry.data;
        error = retry.error;
        if (!error) {
          warning =
            "Profile saved, but privacy settings need vibetalk-profile-privacy.sql run in Supabase first.";
        }
      }
    }
    if (error) {
      // Audit-4 L10: never throw the raw PostgREST error — it can
      // carry table/column names to the client. Log server-side,
      // throw generic (callers toast err.message — see
      // profile-dialog / _app/profile — and branch on nothing
      // specific, so a generic message changes no behaviour).
      console.warn("[updateProfile] profile update failed:", error.message ?? error);
      throw new Error("Could not save your profile — please try again.");
    }
    // M88: 0 updated rows = the profile row doesn't exist — don't
    // report success (and don't run the metadata sync as if the
    // save happened). When the privacy-only branch ran, no UPDATE
    // executed at all (updated is null), so probe existence directly.
    if (!updated || updated.length === 0) {
      const { data: exists } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("id", userId)
        .maybeSingle();
      if (!exists) throw new Error("Profile not found — nothing was saved.");
    }
    // Keep the auth metadata display name in sync (used for initials).
    // Only when the caller actually sent a display name — a
    // privacy-only toggle must not touch metadata. Best-effort: a
    // metadata-sync failure must not turn a saved profile into a
    // reported failure — it becomes a warning instead.
    if (data.displayName !== undefined) {
      // M87: updateUserById does NOT throw on failure — it resolves
      // with { error }. The old code awaited without capturing the
      // result, so a resolved error was silently discarded and the
      // caller got { ok: true, warning: null } while user_metadata
      // drifted from profiles.display_name. Check the resolved
      // error too (same resolve-vs-throw trap as the query builders).
      try {
        const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
          user_metadata: { display_name: data.displayName },
        });
        if (metaError) throw dbErr(metaError, "Could not save your profile — please try again.");
      } catch {
        warning = warning ?? "Profile saved, but the display name could not be synced.";
      }
    }
    return { ok: true, warning };
  });
