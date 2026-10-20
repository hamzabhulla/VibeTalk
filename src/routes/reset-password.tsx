import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { clearPasswordSetupPending, resetPasswordWithPolicy } from "@/lib/auth.functions";
import type { Session } from "@supabase/supabase-js";
import { pkceDeviceMismatchMessage, safeLinkErrorMessage } from "@/lib/link-errors";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, passwordPolicyError } from "@/lib/password-policy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";

/**
 * Audit-2 H2 (fail-closed): is this session the product of a RECOVERY
 * code exchange? A PKCE `code` carries no type — Supabase usually does
 * NOT forward ?type= on the redirect, so exchangeCodeForSession
 * converts ANY valid code (signup, email-change, recovery) into a
 * session. A signup code opened on /reset-password used to show the
 * password form: victim's signup code + this page = password takeover
 * without the original password. The ?type= param is attacker-forged
 * (anyone can append &type=recovery), so it is NEVER trusted — this
 * check runs unconditionally after every exchange:
 *  1. Signup code -> THIS exchange just confirmed the email, so
 *     email_confirmed_at is ~equal to the JWT iat (both GoTrue server
 *     time, so no client-clock skew). A real recovery exchange leaves
 *     an old (or null) email_confirmed_at. 30s window: the attacker's
 *     exchange confirms ~instantly; a legit confirm-then-reset
 *     round-trip (email delivery alone) cannot fit in 30s.
 *  2. Email-change code -> email_change_sent_at is recent while
 *     recovery_sent_at is not (a recovery code implies a recent reset
 *     request). Reject when the change timestamp is the only recent one.
 * Any undecodable token fails CLOSED.
 */
function isRecoverySession(session: Session | null): boolean {
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
  if (user.email_confirmed_at) {
    const confirmedAt = new Date(user.email_confirmed_at).getTime();
    // Audit-3 A2-N7: a confirm-then-reset round-trip CAN fit in 30s
    // (email arrives in 2–5s). Accept when a real reset request
    // post-dates the confirmation: recovery_sent_at after
    // email_confirmed_at and recent to this exchange.
    const recoveryAfterConfirm =
      user.recovery_sent_at !== null &&
      user.recovery_sent_at !== undefined &&
      new Date(user.recovery_sent_at).getTime() > confirmedAt &&
      issuedAt - new Date(user.recovery_sent_at).getTime() < 3_600_000 &&
      issuedAt - new Date(user.recovery_sent_at).getTime() >= -60_000;
    if (issuedAt - confirmedAt < 30_000 && !recoveryAfterConfirm) return false;
  }
  const HOUR = 3_600_000;
  const changeRecent = user.email_change_sent_at
    ? issuedAt - new Date(user.email_change_sent_at).getTime() < HOUR
    : false;
  const recoveryRecent = user.recovery_sent_at
    ? issuedAt - new Date(user.recovery_sent_at).getTime() < HOUR
    : false;
  if (changeRecent && !recoveryRecent) return false;
  return true;
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

export const Route = createFileRoute("/reset-password")({
  component: ResetPassword,
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
    meta: [{ title: "Reset password — VibeTalk" }],
  }),
});

/**
 * Handles the password-reset link: Supabase redirects here with ?code=… —
 * we exchange it for a recovery session, then let the user set a new
 * password. Mirrors /auth/callback's exchange pattern.
 */
function ResetPassword() {
  const navigate = useNavigate();
  const clearPending = useServerFn(clearPasswordSetupPending);
  const resetPassword = useServerFn(resetPasswordWithPolicy);
  const [status, setStatus] = useState<"working" | "ready" | "error" | "done">(
    "working",
  );
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  // M89: the delayed /rooms navigation is a timer fired from an event
  // handler (no effect to clean up in) — keep its id in a ref and
  // clear it on unmount, so a manual navigation inside the 1.2s
  // window isn't overridden by the stale timer.
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
    },
    [],
  );

  // Audit-5 B2-INFO: once the session is established, scrub the
  // single-use credentials (code / hash access+refresh tokens) out
  // of the URL — they sat in the address bar and history for as
  // long as the reset form was open. replaceState keeps path only.
  const scrubResetUrl = () => {
    try {
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      // cosmetic only — never block the reset flow
    }
  };
  useEffect(() => {
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
          // Audit-2 L22: same allowlist mapping as /auth/callback —
          // never reflect the URL-derived description.
          throw new Error(safeLinkErrorMessage(desc, "reset"));
        }
        // M92: mirror of /auth/callback — a signup/confirmation code
        // opened here used to show the password form. A non-recovery
        // ?type=… belongs on /auth/callback; redirect it there with
        // the exact query+hash preserved. (PKCE usually doesn't
        // forward type, so absent = proceed as before.)
        const linkType = params.get("type");
        if (linkType && linkType !== "recovery") {
          window.location.replace(
            `/auth/callback${window.location.search}${window.location.hash}`,
          );
          return;
        }
        const code = params.get("code");
        if (code) {
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
          // Audit-2 H2: provenance check (see isRecoverySession). On
          // rejection the exchange already minted a session — destroy
          // it (global revoke, local fallback) so the code holder keeps
          // no session, then error. Showing the form is not the only
          // leak: the minted session itself is victim access.
          if (!isRecoverySession(data.session)) {
            // Audit-4 L8: honor destroySession's result — if the
            // minted session survived, say so (the generic error
            // alone would hide that /rooms is still reachable).
            const { cleared: destroyed } = await destroySession();
            throw new Error(
              destroyed
                ? "This link isn't a password-reset link. Request a fresh reset link from the login page."
                : "This link isn't a password-reset link. Request a fresh reset link from the login page. We couldn't end the session it created — close this tab and clear this site's data before continuing.",
            );
          }
          scrubResetUrl();
          setStatus("ready");
          return;
        }
        // Hash flow (audit-2 H3): the OLD code treated hash presence +
        // ANY getSession() result as proof — a fake hash
        // (#type=recovery&access_token=<redacted> + a pre-existing normal session
        // opened the password form (local-access takeover on an unlocked
        // device). The hash is attacker-controlled, so presence proves
        // nothing. The ONLY proof is GoTrue validating the hash's
        // tokens: setSession() with the hash's access + refresh tokens
        // fails for forged tokens and establishes the session FROM the
        // hash for real ones. Then the H2 provenance check rejects
        // non-recovery hashes (e.g. a signup hash with a forged
        // type=recovery) and destroys the minted session.
        const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        // M92: a non-recovery hash belongs on /auth/callback —
        // redirect it there intact instead of erroring.
        const hashType = hash.get("type");
        if (hashType && hashType !== "recovery") {
          window.location.replace(
            `/auth/callback${window.location.search}${window.location.hash}`,
          );
          return;
        }
        const hashAccess = hash.get("access_token");
        const hashRefresh = hash.get("refresh_token");
        if (hash.get("type") === "recovery" && hashAccess && hashRefresh) {
          const { data, error: setErr } = await supabase.auth.setSession({
            access_token: hashAccess,
            refresh_token: hashRefresh,
          });
          if (setErr || !data.session) {
            throw new Error("Invalid or expired reset link.");
          }
          if (!isRecoverySession(data.session)) {
            // Audit-4 L8: honor destroySession's result (see code path).
            const { cleared: destroyed } = await destroySession();
            throw new Error(
              destroyed
                ? "This link isn't a password-reset link. Request a fresh reset link from the login page."
                : "This link isn't a password-reset link. Request a fresh reset link from the login page. We couldn't end the session it created — close this tab and clear this site's data before continuing.",
            );
          }
          scrubResetUrl();
          setStatus("ready");
          return;
        }
        throw new Error("No reset code found in the link.");
      } catch (err) {
        setStatus("error");
        const raw =
          err instanceof Error ? err.message : "Reset failed. The link may have expired.";
        // M51: a PKCE verifier error means the link was opened on a
        // different device/browser than the reset request — explain.
        setMessage(pkceDeviceMismatchMessage(raw, "reset") ?? raw);
      }
    })();
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // M57: shared password policy (was: min-8 only, no max).
    const pwError = passwordPolicyError(password);
    if (pwError) {
      toast.error(pwError);
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      // Audit-4 M1: set the password through the server fn — the
      // policy is enforced server-side there (the old client
      // updateUser let a console/curl call bypass it). The server
      // fn also clears the password_setup_pending metadata flag.
      await resetPassword({ data: { password } });
      // Audit-4 C1: the reset sets a usable password, so setup is
      // done — clear the server-side pending row too (best-effort:
      // the password is already set; a lingering row is inert and
      // the metadata flag above is already false).
      await clearPending().catch((e) => {
        console.warn("[reset-password] could not clear setup-pending row:", e);
      });
      // Audit-2 M7: a reset must kill every session, not just this
      // recovery one — a stolen session survives a password change
      // otherwise. Global revoke, then re-login with the new password.
      const { revoked: revokedEverywhere } = await destroySession();
      setStatus("done");
      toast.success(
        revokedEverywhere
          ? "Password updated. You've been signed out everywhere — please sign in with your new password."
          : "Password updated, but other devices could not be signed out.",
      );
      navTimerRef.current = setTimeout(() => navigate({ to: "/login", search: { next: undefined }, replace: true }), 1200);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not update the password.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="surface-3d w-full max-w-md rounded-2xl p-8 text-center">
        {status === "working" && (
          <>
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
            <h1 className="mt-4 text-xl font-semibold">Checking your reset link…</h1>
            <p className="mt-1 text-sm text-muted-foreground">One moment.</p>
          </>
        )}
        {status === "ready" && (
          <form onSubmit={onSubmit} className="text-left">
            <h1 className="text-center text-xl font-semibold">Choose a new password</h1>
            <p className="mt-1 text-center text-sm text-muted-foreground">
              At least 8 characters.
            </p>
            <div className="mt-6 space-y-3">
              <Input
                type="password"
                placeholder="New password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Input
                type="password"
                placeholder="Confirm new password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="mt-5 w-full" disabled={busy}>
              {busy ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
        {status === "done" && (
          <>
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
            <h1 className="mt-4 text-xl font-semibold">Password updated!</h1>
            <p className="mt-1 text-sm text-muted-foreground">Taking you to the login page…</p>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="mx-auto h-10 w-10 text-destructive" />
            <h1 className="mt-4 text-xl font-semibold">Reset link invalid</h1>
            <p className="mt-1 text-sm text-muted-foreground">{message}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Request a fresh link from the login page.
            </p>
            <Button
              className="mt-6 w-full gradient-primary text-primary-foreground"
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
