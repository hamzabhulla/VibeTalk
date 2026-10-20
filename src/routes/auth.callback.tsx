import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session } from "@supabase/supabase-js";
import { pkceDeviceMismatchMessage, safeLinkErrorMessage } from "@/lib/link-errors";
import { useResendCooldown } from "@/lib/use-cooldown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

export const Route = createFileRoute("/auth/callback")({
  component: AuthCallback,
  // Audit-4 L80: validate the Supabase email-link search keys
  // (code / error / error_description / type).
  // All-optional return type (see index.tsx): the keys are
  // genuinely absent from the URL when unused.
  validateSearch: (
    search: Record<string, unknown>,
  ): { code?: string; error?: string; error_description?: string; type?: string } => ({
    code: typeof search.code === "string" ? search.code : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    error_description:
      typeof search.error_description === "string" ? search.error_description : undefined,
    type: typeof search.type === "string" ? search.type : undefined,
  }),
  head: () => ({
    meta: [{ title: "Verifying… — VibeTalk" }],
  }),
});

/**
 * Audit-3 A2-N1 (fail-closed): is this session provably the product of a
 * SIGNUP / INVITE verification exchange? A PKCE `code` carries no type —
 * Supabase usually does NOT forward ?type= on the redirect, so
 * exchangeCodeForSession converts ANY valid code (signup, invite,
 * recovery, email-change) into a session. Before this fix, a victim's
 * recovery code opened here minted a live session and landed in /rooms
 * WITHOUT a password change — a stealth takeover (the reset path at
 * least forces a password change the victim notices). The ?type=
 * param is attacker-forged (anyone can append it), so it is NEVER
 * trusted — this check runs unconditionally after every exchange:
 *  1. Email-change code -> rejected HERE (any `email_change_sent_at`
 *     at all rejects): an email-change exchange itself freshly
 *     confirms the new address, so the confirmation timestamp cannot
 *     distinguish it from signup — the change timestamp is the only
 *     signal. A legitimate signup/invite exchange ALWAYS has
 *     `email_change_sent_at === null` (a fresh user has never changed
 *     their email), so presence — not a 1h window — is the gate.
 *     (Deliberately stricter than reset-password's 1h window: there
 *     an old change + recent recovery must still count as recovery;
 *     here any change history proves the exchange is not a
 *     signup/invite one.) Email-change exchanges are NOT rejected
 *     by the page — they are accepted by the sibling
 *     `isEmailChangeSession` (Audit-3 A2-N5); the two predicates are
 *     mutually exclusive and partition code types between them.
 *  2. Recovery code -> the exchange never freshly confirms the email
 *     (recovery doesn't confirm), so email_confirmed_at is old/null.
 *     Reject when the confirmation is not from THIS exchange.
 *  3. Signup code -> THIS exchange just confirmed the email,
 *     so email_confirmed_at is ~equal to the JWT iat (both GoTrue
 *     server time, so no client-clock skew). Accept within 30s.
 * Any undecodable token fails CLOSED. The 30s window MUST match the
 * twin `isRecoverySession` in reset-password.tsx — if one changes,
 * change both (the three predicates partition code types: verification
 * + email-change here, recovery in reset-password).
 */
function isVerificationSession(session: Session | null): boolean {
  if (!session) return false;
  const user = session.user;
  let issuedAt = 0;
  try {
    const payload = JSON.parse(
      atob(session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { iat?: number };
    issuedAt = (payload.iat ?? 0) * 1000;
  } catch {
    return false;
  }
  if (!issuedAt) return false;
  // Email-change exchange: reject on ANY change history (see the
  // doc comment above) — even a >1h-old change code is not a
  // signup/invite exchange.
  if (user.email_change_sent_at) return false;
  // Only an exchange that confirmed the email RIGHT NOW counts:
  // signup + invite. Anything else (recovery, stale re-clicks,
  // forged tokens) fails closed.
  if (!user.email_confirmed_at) return false;
  const confirmedAt = new Date(user.email_confirmed_at).getTime();
  // Audit-4 L1: lower bound — a token issued LONG BEFORE the
  // confirmation (negative diff) must not pass. Same GoTrue clock
  // stamps both values, so -60s covers clock weirdness (mirrors
  // reset-password's isRecoverySession skew tolerance); anything
  // earlier is a replayed/stale token, not this exchange.
  const diff = issuedAt - confirmedAt;
  return diff >= -60_000 && diff < 30_000;
}

/**
 * Audit-3 A2-N5: is this session provably the product of an
 * EMAIL-CHANGE confirmation exchange? The sibling of
 * `isVerificationSession` — the two predicates are mutually exclusive
 * (verification requires `email_change_sent_at === null`, this one
 * requires it non-null) and together with reset-password's
 * `isRecoverySession` they partition code types between the pages.
 * Accept when ALL hold:
 *  1. A change email was sent for this user (`email_change_sent_at`
 *     non-null). A signup/invite exchange never has one; a recovery
 *     exchange has `recovery_sent_at` instead.
 *  2. NO recent recovery email (same 1h window as
 *     `isRecoverySession`): an old change + a fresh recovery must
 *     count as recovery, not as a change. Fail closed on ambiguity.
 *  3. The session came from THIS exchange: both call sites check the
 *     just-exchanged session, so this is a coarse, skew-tolerant
 *     (10 min) freshness bound — defence in depth for future callers,
 *     not the primary signal. Undecodable token fails CLOSED.
 * Deliberately does NOT require `email_confirmed_at` to be fresh:
 * an email-change user confirmed their ORIGINAL email long ago —
 * GoTrue keeps that timestamp — so freshness of confirmation would
 * wrongly reject every legitimate change.
 */
function isEmailChangeSession(session: Session | null): boolean {
  if (!session) return false;
  const user = session.user;
  if (!user.email_change_sent_at) return false;
  if (user.recovery_sent_at) {
    const recoveryAt = new Date(user.recovery_sent_at).getTime();
    if (Date.now() - recoveryAt < 3_600_000) return false;
  }
  let issuedAt = 0;
  try {
    const payload = JSON.parse(
      atob(session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { iat?: number };
    issuedAt = (payload.iat ?? 0) * 1000;
  } catch {
    return false;
  }
  if (!issuedAt) return false;
  return Date.now() - issuedAt < 600_000;
}

/**
 * Destroy the current session: global revoke (retried once),
 * local clear, VERIFIED via getSession. Returns TWO signals —
 * call sites must pick the one they need:
 * - `revoked`: the GLOBAL revoke succeeded (other devices signed
 *   out). The M7 post-reset toast branches on this.
 * - `cleared`: NO session remains in THIS browser's storage
 *   (verified). The provenance-rejection sites branch on this.
 * Audit-4 L8: the old version returned a single boolean ("global
 * revoke succeeded") and the provenance call sites IGNORED it — if
 * global + local both failed, the minted session survived in
 * storage and the link-opener could still reach /rooms behind the
 * "invalid link" error. Fail-closed: if verification itself
 * throws, cleared is false.
 */
async function destroySession(): Promise<{ revoked: boolean; cleared: boolean }> {
  let revoked = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await supabase.auth
      .signOut({ scope: "global" })
      .catch(() => ({ error: new Error("signOut threw") }));
    if (!error) {
      revoked = true;
      break;
    }
  }
  // Belt-and-braces: global success already clears local storage,
  // but a failed global revoke must not leave storage behind.
  await supabase.auth.signOut({ scope: "local" }).catch(() => null);
  let cleared = false;
  try {
    const { data } = await supabase.auth.getSession();
    cleared = !data.session;
  } catch {
    cleared = false;
  }
  return { revoked, cleared };
}

/**
 * Handles the email verification link: Supabase redirects here with
 * ?code=… — we exchange it for a session, then send the user to /rooms.
 */
function AuthCallback() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"working" | "ok" | "error">("working");
  const [message, setMessage] = useState("");
  // Audit-3 A2-N5: which accepted flow landed here — the success view
  // says "Email updated!" for a change, "Email verified!" otherwise.
  const [flow, setFlow] = useState<"verified" | "email-change">("verified");
  // Audit-2 L21: the error view was a dead end (only "Go to login").
  // An expired link now offers a resend right here — the same
  // guarded, neutral, cooldown-gated resend as /login's onResend
  // (L16 guard, M11 neutral message: no account oracle).
  const [resendEmail, setResendEmail] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const resendCooldown = useResendCooldown(60);
  // Audit-6 A6-INFO-3: once the exchange settles (either way),
  // scrub the single-use credentials (?code= / hash access+refresh
  // tokens) out of the URL — INFO-6 covered /reset-password; this
  // page kept them in the address bar + history indefinitely, and
  // the error view never navigates away. replaceState keeps path.
  const scrubCallbackUrl = () => {
    try {
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      // cosmetic only — never block the callback flow
    }
  };
  const RESEND_NEUTRAL =
    "If this email has an unverified account, a verification link is on its way.";
  const onResend = async () => {
    // Audit-3 A2-N8: handler-level cooldown gate (see login.tsx).
    if (resendCooldown.coolingDown) return;
    const trimmedEmail = resendEmail.trim();
    if (!trimmedEmail) {
      toast.error("Enter your email address first.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error("Enter a valid email address.");
      return;
    }
    // Audit-6 A6-LOW-1: this was the 6th resend handler and the one
    // the INFO-7 ref-gate missed — the state gate above reads stale
    // state within a tick, so a same-tick double-invoke fired two
    // resends. Reserve via the ref-backed gate like the other five.
    if (!resendCooldown.tryReserve()) return;
    setResendBusy(true);
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: trimmedEmail,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      resendCooldown.start();
      toast.success(RESEND_NEUTRAL);
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "AuthRetryableFetchError") {
        toast.error("Could not send — check your connection and try again.");
      } else {
        resendCooldown.start();
        toast.success(RESEND_NEUTRAL);
      }
    } finally {
      resendCooldown.release();
      setResendBusy(false);
    }
  };

  useEffect(() => {
    // M89: the delayed /rooms navigation is a timer — store its id
    // and clear it on unmount, so a user who navigates away inside
    // the 1.2s window doesn't get yanked back by a stale timer.
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        // M49: Supabase redirects REJECTED links with
        // ?error=access_denied&error_description=… (and no code).
        // Surface the real, actionable reason (expired / already used)
        // instead of a generic "no code found".
        const linkError = params.get("error");
        if (linkError) {
          const desc = params.get("error_description");
          // Audit-2 L22: map the URL-derived description to the
          // allowlist — never reflect attacker text (and never
          // interpolate the raw error code either).
          throw new Error(safeLinkErrorMessage(desc, "verify"));
        }
        // M92: don't exchange a code meant for another flow. A
        // recovery code opened here used to mint a session and land
        // in /rooms WITHOUT a password change. Supabase may forward
        // ?type=… on the PKCE redirect (usually it doesn't — the
        // query check is defensive); the hash flow always carries
        // it, checked below. Redirect with the exact query+hash
        // preserved so the code/token survives on the right page.
        if (params.get("type") === "recovery") {
          window.location.replace(
            `/reset-password${window.location.search}${window.location.hash}`,
          );
          return;
        }
        const code = params.get("code");
        if (!code) {
          // M50: only show success for a session that PROVABLY came
          // from a verification link in THIS page load (H17 pattern).
          // The hash must carry an access_token — that is the proof
          // the session was established from the email link, not from
          // a pre-existing login. A plain getSession() fallback is
          // rejected: otherwise visiting /auth/callback while logged
          // in shows a false "Email verified!" with no link clicked
          // and no code exchanged.
          const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
          // M92: a recovery hash (type=recovery) belongs on
          // /reset-password, not here — redirect it there intact.
          if (hash.get("type") === "recovery") {
            window.location.replace(
              `/reset-password${window.location.search}${window.location.hash}`,
            );
            return;
          }
          // Audit-2 H3: the OLD code treated hash presence + ANY
          // getSession() result as proof — a fake hash + a pre-existing
          // session showed a false "Email verified!". Same fix as
          // /reset-password: setSession() validates the hash's tokens
          // with GoTrue; forged tokens fail, real ones establish the
          // session FROM the hash. (Impact here was false-success only
          // — no password form — but a false "verified" is still a lie.)
          // No sign-out on failure: unlike /reset-password, no session
          // was minted here — a pre-existing session is the visitor's
          // own and stays untouched.
          const hashAccess = hash.get("access_token");
          const hashRefresh = hash.get("refresh_token");
          if (hashAccess && hashRefresh) {
            const { data, error: setErr } = await supabase.auth.setSession({
              access_token: hashAccess,
              refresh_token: hashRefresh,
            });
            if (setErr || !data.session) {
              throw new Error("Invalid or expired verification link.");
            }
            // Audit-3 A2-N1: provenance check — a recovery / email-change
            // hash must not mint a session here. On rejection, destroy
            // the minted session (stealth-session kill) and show a
            // generic error (no code-type oracle). Audit-3 A2-N5: an
            // email-change exchange IS accepted, via
            // isEmailChangeSession — the two predicates partition.
            const emailChanged = isEmailChangeSession(data.session);
            if (!isVerificationSession(data.session) && !emailChanged) {
              // Audit-4 L8: honor destroySession's result — if the
              // minted session survived, say so (the generic error
              // alone would hide that /rooms is still reachable).
              const { cleared: destroyed } = await destroySession();
              throw new Error(
                destroyed
                  ? "This link isn't valid for email verification."
                  : "This link isn't valid for email verification. We couldn't end the session it created — close this tab and clear this site's data before continuing.",
              );
            }
            setFlow(emailChanged ? "email-change" : "verified");
            scrubCallbackUrl();
            setStatus("ok");
            // Audit-2 H1: a flagged session (invite-redeem account that
            // hasn't set a password yet) goes to /set-password, not
            // /rooms — the account has no usable password until setup.
            const dest =
              (data.session.user.user_metadata as Record<string, unknown> | null)
                ?.password_setup_pending === true
                ? "/set-password"
                : "/rooms";
            timer = setTimeout(() => navigate({ to: dest, replace: true }), 1200);
            return;
          }
          throw new Error("No verification code found in the link.");
        }
        const { data: exchanged, error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) throw error;
        // Audit-3 A2-N1: provenance check (same as the hash path above).
        // A recovery code opened here used to mint a session with no
        // password change; now the minted session is destroyed.
        // Audit-3 A2-N5: email-change accepted via isEmailChangeSession.
        const emailChanged = isEmailChangeSession(exchanged?.session ?? null);
        if (!isVerificationSession(exchanged?.session ?? null) && !emailChanged) {
          // Audit-4 L8: honor destroySession's result (see hash path).
          const { cleared: destroyed } = await destroySession();
          throw new Error(
            destroyed
              ? "This link isn't valid for email verification."
              : "This link isn't valid for email verification. We couldn't end the session it created — close this tab and clear this site's data before continuing.",
          );
        }
        setFlow(emailChanged ? "email-change" : "verified");
        scrubCallbackUrl();
        setStatus("ok");
        // Audit-2 H1: same flagged-session routing as the hash path.
        const dest =
          (exchanged?.session?.user.user_metadata as Record<string, unknown> | null)
            ?.password_setup_pending === true
            ? "/set-password"
            : "/rooms";
        timer = setTimeout(() => navigate({ to: dest, replace: true }), 1200);
      } catch (err) {
        scrubCallbackUrl();
        setStatus("error");
        const raw =
          err instanceof Error ? err.message : "Verification failed. The link may have expired.";
        // M51: a PKCE verifier error means the link was opened on a
        // different device/browser than the signup — explain + remedy.
        setMessage(pkceDeviceMismatchMessage(raw, "verify") ?? raw);
      }
    })();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [navigate]);

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="surface-3d w-full max-w-md rounded-2xl p-8 text-center">
        {status === "working" && (
          <>
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
            <h1 className="mt-4 text-xl font-semibold">Verifying your email…</h1>
            <p className="mt-1 text-sm text-muted-foreground">One moment.</p>
          </>
        )}
        {status === "ok" && (
          <>
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
            <h1 className="mt-4 text-xl font-semibold">
              {flow === "email-change" ? "Email updated!" : "Email verified!"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">Taking you to your chats…</p>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="mx-auto h-10 w-10 text-destructive" />
            <h1 className="mt-4 text-xl font-semibold">Verification failed</h1>
            <p className="mt-1 text-sm text-muted-foreground">{message}</p>
            <div className="mt-6 space-y-3 text-left">
              <label
                htmlFor="callback-resend-email"
                className="text-sm font-medium leading-none"
              >
                Get a new verification link
              </label>
              <Input
                id="callback-resend-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={resendEmail}
                onChange={(e) => setResendEmail(e.target.value)}
              />
              <Button
                className="w-full gradient-primary text-primary-foreground"
                onClick={() => void onResend()}
                disabled={resendBusy || resendCooldown.coolingDown}
              >
                {resendBusy
                  ? "Sending…"
                  : resendCooldown.coolingDown
                    ? `Resend in ${resendCooldown.remaining}s`
                    : "Resend verification link"}
              </Button>
            </div>
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => navigate({ to: "/login", search: { next: undefined } })}
            >
              Go to login
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
