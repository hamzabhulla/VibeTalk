import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import {
  clearPasswordSetupPending,
  completePasswordSetup,
  getPasswordSetupPending,
} from "@/lib/auth.functions";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, passwordPolicyError } from "@/lib/password-policy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/set-password")({
  component: SetPassword,
  // Audit-4 L80: this route consumes no search keys.
  validateSearch: () => ({}),
  head: () => ({
    meta: [{ title: "Set your password — VibeTalk" }],
  }),
});

/**
 * Audit-2 H1 (account pre-hijack): invite-redeem accounts are created
 * with a SERVER-GENERATED RANDOM password nobody knows, so a redeemer
 * can never log in with a password they chose. The owner finishes setup
 * here after verifying their email: /auth/callback routes flagged
 * sessions (user_metadata.password_setup_pending === true) here, and
 * the _app layout guards flagged sessions on every protected page.
 *
 * Audit-4 C1: the metadata flag is a UX HINT ONLY — any session can
 * overwrite its own metadata via updateUser({ data }), so the flag
 * must never be the authorization for a password set. The real gate
 * is the server-side password_setup_pending row: this page verifies
 * it with the server before showing the form, and the submit goes
 * through completePasswordSetup (admin API), never a client
 * updateUser call with a password.
 */
// Audit-5 B2-HIGH: completePasswordSetup / clearPasswordSetupPending
// clear the metadata flag SERVER-side (admin API), but the client
// session's JWT still carries the old flag until it refreshes — the
// _app bounce reads the stale flag and loops /rooms ↔ /set-password
// until the ~1h auto-refresh. Pull a fresh token explicitly after
// every server-side flag change. Best-effort: on failure the old
// (pre-fix) behaviour is the backstop, not a new break.
async function refreshClientSession(): Promise<void> {
  try {
    const { error } = await supabase.auth.refreshSession();
    if (error) console.warn("[set-password] session refresh failed:", error.message);
  } catch (err) {
    console.warn("[set-password] session refresh threw:", err instanceof Error ? err.message : err);
  }
}

function SetPassword() {
  const navigate = useNavigate();
  const { session, loading } = useAuth();
  const [status, setStatus] = useState<"checking" | "ready" | "done" | "error">("checking");
  const [checkAttempt, setCheckAttempt] = useState(0);
  const checkPending = useServerFn(getPasswordSetupPending);
  const completeSetup = useServerFn(completePasswordSetup);
  const clearPending = useServerFn(clearPasswordSetupPending);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    // Audit-5 B2-HIGH: this effect is the mount-time GATE only. Once
    // the flow has moved on (form shown / done / error), a session
    // change must not re-run the gate's navigations — in particular
    // the post-submit session refresh would bounce the user to
    // /rooms before the "Password set!" screen shows.
    if (status !== "checking") return;
    if (loading) return;
    if (!session) {
      navigate({ to: "/login", search: { next: "/set-password" }, replace: true });
      return;
    }
    if ((session.user.user_metadata as Record<string, unknown> | null)?.password_setup_pending !== true) {
      // Already set up (or landed here by accident) — nothing to do.
      navigate({ to: "/rooms", replace: true });
      return;
    }
    // Audit-4 C1: verify with the SERVER before showing the form —
    // the metadata flag above is only the UX hint. A flipped flag
    // reaches this page but never the submit.
    let cancelled = false;
    (async () => {
      try {
        const res = await checkPending();
        if (cancelled) return;
        if (res.pending) {
          setStatus("ready");
          return;
        }
        // Stale flag (metadata true, server false): heal it so the
        // _app bounce stops firing, refresh the client session so
        // the bounce actually sees the cleared flag (B2-HIGH), then
        // leave.
        await clearPending().catch(() => null);
        await refreshClientSession();
        if (cancelled) return;
        navigate({ to: "/rooms", replace: true });
      } catch {
        // Fail CLOSED: never show the form without server proof.
        // No auto-navigation here — the _app bounce reads the
        // metadata flag, so navigating away on a transient error
        // would bounce straight back (loop). The error state below
        // offers Retry / Go to chats instead.
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, session, navigate, checkPending, clearPending, checkAttempt, status]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
      // Audit-4 C1: the password is set by the SERVER (admin API),
      // gated on the server-side pending row — never by a client
      // updateUser call trusting the metadata flag.
      await completeSetup({ data: { password } });
      // Audit-5 B2-HIGH: the server cleared the setup flag — refresh
      // the client session so the _app bounce doesn't read the stale
      // JWT and bounce /rooms -> /set-password in a loop. The 1200ms
      // "done" timer below still runs: the mount gate is status-
      // guarded, so this refresh no longer navigates away early.
      await refreshClientSession();
      // M7 deliberately NOT applied here: this is first-time setup,
      // not rotation — the account was just created by the email
      // signup flow, so no other-device session exists to revoke.
      // A global sign-out here would only kick the user to login for
      // no security gain.
      setStatus("done");
      toast.success("Password set. Welcome to VibeTalk!");
      navTimerRef.current = setTimeout(() => navigate({ to: "/rooms", replace: true }), 1200);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not set the password.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="surface-3d w-full max-w-md rounded-2xl p-8 text-center">
        {status === "checking" && (
          <>
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" />
            <h1 className="mt-4 text-xl font-semibold">Checking your account…</h1>
            <p className="mt-1 text-sm text-muted-foreground">One moment.</p>
          </>
        )}
        {status === "ready" && (
          <form onSubmit={onSubmit} className="text-left">
            <h1 className="text-center text-xl font-semibold">Set your password</h1>
            <p className="mt-1 text-center text-sm text-muted-foreground">
              Finish setting up your account — choose a password you&apos;ll remember.
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
                maxLength={PASSWORD_MAX_LENGTH}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="mt-6 w-full gradient-primary text-primary-foreground" disabled={busy}>
              {busy ? "Setting password…" : "Set password & continue"}
            </Button>
          </form>
        )}
        {status === "done" && (
          <>
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
            <h1 className="mt-4 text-xl font-semibold">Password set!</h1>
            <p className="mt-1 text-sm text-muted-foreground">Taking you to your chats…</p>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="mx-auto h-10 w-10 text-destructive" />
            <h1 className="mt-4 text-xl font-semibold">Couldn&apos;t verify setup</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              We couldn&apos;t confirm this account still needs a password. Try again, or go to your
              chats — setup will be offered again if it&apos;s still pending.
            </p>
            <Button
              type="button"
              className="mt-6 w-full gradient-primary text-primary-foreground"
              onClick={() => {
                setStatus("checking");
                setCheckAttempt((c) => c + 1);
              }}
            >
              Try again
            </Button>
            {/* Audit-5 B2-MEDIUM: navigate WITHOUT clearPending(). The
                error state means the server check FAILED (transient) —
                it is not a verdict of "not pending". Clearing here
                deleted the one-time pending row, so a user who IS
                still pending lost the setup offer forever,
                contradicting the copy above. If setup is still
                pending, the _app bounce brings them right back here
                (the form re-verifies); if not, the heal path clears
                the stale flag. */}
            <Button
              type="button"
              variant="ghost"
              className="mt-2 w-full"
              onClick={() => navigate({ to: "/rooms", replace: true })}
            >
              Go to chats
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
