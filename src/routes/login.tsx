import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useResendCooldown } from "@/lib/use-cooldown";
import { safeNextPath } from "@/lib/safe-next";
import { PASSWORD_MIN_LENGTH } from "@/lib/password-policy";
import { toast } from "sonner";
import { AuthShell, IconArrow, IconEye, IconLock, IconMail } from "@/components/auth-shell";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Log in — VibeTalk" },
      { name: "description", content: "Log in to your private VibeTalk workspace." },
      { property: "og:title", content: "Log in — VibeTalk" },
      { property: "og:description", content: "Log in to your private VibeTalk workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function LoginPage() {
  const { session, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  // M62: resend cooldown (60s) — shared by the verification resend
  // and the reset "Send again" button.
  const resendCooldown = useResendCooldown(60);
  const { next } = Route.useSearch();

  // Audit-2 L26: destination after login — validated by the shared
  // safeNextPath (URL parsing + same-origin + app-route allowlist).
  // Audit-3 L26-wiring: do NOT pass the whole validated string to
  // navigate({ to }) — the router treats `to` as a PURE pathname, so
  // the built location has the query/hash baked into the pathname
  // with an EMPTY search. A full-cycle test with the real router
  // showed every shape landing correctly (no 404 reproduced — the
  // audit stopped at the intermediate location; history.pushState +
  // load re-parses the URL), but the usage is contract-violating
  // and fragile: anything reading the built location (e.g. a future
  // validateSearch) sees empty search. A full-document replace lets
  // the browser parse the query/hash natively and the router boots
  // on the correct location; replace semantics keep M39 (Back from
  // the destination does not return to /login).
  const safeNext = safeNextPath(next);
  const goNext = useCallback(() => {
    window.location.replace(safeNext);
  }, [safeNext]);

  useEffect(() => {
    if (!loading && session) goNext();
  }, [loading, session, goNext]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // M56: trim — "user@example.com " (autofill/paste trailing space)
      // fails on login while register (which trims) succeeds.
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) {
        // Audit-2 M11: NEVER surface GoTrue's raw message — "Email not
        // confirmed" + a conditional resend box told an attacker the
        // account exists AND is unconfirmed (account-existence oracle).
        // Every login failure gets the identical generic message.
        toast.error("Invalid email or password.");
        return;
      }
      toast.success("Welcome back!");
      goNext();
    } catch (err) {
      // H14: without this, a throw (network failure, …) skipped
      // setBusy(false) and left the button stuck on "Signing in…"
      // with no error shown.
      // Audit-6 A6-INFO-5: the raw err.message no longer reaches
      // the toast (the L9 sanitization was never applied here).
      // Same house pattern as register/join: only a transport
      // failure and the app's own rate-limit message may surface;
      // everything else is generic (no account oracle, no
      // server internals).
      const msg = err instanceof Error ? err.message : "";
      if ((err as { name?: string } | null)?.name === "AuthRetryableFetchError") {
        toast.error("Could not sign in — check your connection and try again.");
      } else if (msg.includes("Too many attempts")) {
        toast.error(msg);
      } else {
        toast.error("Could not sign in — please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  // Audit-2 M11: the resend outcome must not become an oracle either
  // — a GoTrue "already confirmed" error would reveal the account IS
  // confirmed. Every GoTrue outcome (sent, already-confirmed, no such
  // account) gets the SAME neutral message + cooldown; only a
  // retryable transport failure (AuthRetryableFetchError — my network,
  // not the account) reports a send failure. The link below is
  // ALWAYS visible, never conditioned on the login error, so its
  // presence reveals nothing.
  const RESEND_NEUTRAL =
    "If this email has an unverified account, a verification link is on its way.";
  const onResend = async () => {
    // Audit-3 A2-N8: handler-level cooldown gate (same as
    // sendResetEmail) — the button's `disabled` state alone does not
    // stop a same-tick double-click or programmatic double-invocation.
    if (resendCooldown.coolingDown) return;
    // Audit-2 L16: this is a plain click, not a form submit — the
    // browser's required/type=email validation never runs. Without a
    // guard, an empty email burned a Supabase call + a cooldown and
    // showed "link is on its way" for a link that was never sent.
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      toast.error("Enter your email address first.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error("Enter a valid email address.");
      return;
    }
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

  const onSendReset = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendResetEmail();
  };

  // M61: extracted so the reset-sent "didn't get it" view can re-send
  // (the old view only offered "Back to login" — no re-check path).
  const sendResetEmail = async () => {
    // Audit-2 M13: gate the HANDLER too, not just the button — "Back
    // to login" → "Forgot password?" re-rendered the form with an
    // ungated submit, bypassing the cooldown the sent-view enforces.
    if (resendCooldown.coolingDown) return;
    // Audit-4 L3: same guards as onResend — the "Send again" button
    // calls this directly (not a form submit), so the browser's
    // required/type=email validation never runs there. Without a
    // guard, an empty/invalid email burned a Supabase call + a
    // cooldown.
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      toast.error("Enter your email address first.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error("Enter a valid email address.");
      return;
    }
    if (!resendCooldown.tryReserve()) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      resendCooldown.start();
      setResetSent(true);
    } catch (err) {
      // Audit-4 L3: never toast the raw GoTrue error (mirrors
      // onResend). AuthRetryableFetchError = network — say so.
      // Anything else gets the neutral sent view: GoTrue returns
      // success for nonexistent emails anyway, so the view leaks
      // nothing and reveals no error detail.
      if ((err as { name?: string } | null)?.name === "AuthRetryableFetchError") {
        toast.error("Could not send — check your connection and try again.");
      } else {
        resendCooldown.start();
        setResetSent(true);
      }
    } finally {
      resendCooldown.release();
      setBusy(false);
    }
  };

  // Audit-2 L28: never flash the form to a logged-in user. While
  // the session is still loading a hard navigate here showed the
  // full form for a beat before the redirect fired; and gating on
  // `loading` alone would still flash one frame after load (the
  // redirect runs in an effect). `session` closes that frame too —
  // a session here always means "about to redirect", never "show
  // the form". Same early-return pattern as _app.
  if (loading || session) {
    return (
      <div className="min-h-screen grid place-items-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <AuthShell
      heading={forgot ? "Reset your password" : "Welcome back"}
      subheading={
        forgot
          ? "Enter your email and we'll send you a reset link."
          : "Your conversations are just a sign-in away."
      }
    >
      {forgot ? (
        resetSent ? (
          <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
            <p style={{ fontSize: 14, color: "#374151", lineHeight: 1.7 }}>
              {/* M61: no unconditional "we sent" — Supabase returns
                  success for non-existent emails too (anti-enumeration),
                  and a misconfigured SMTP means no mail goes out at
                  all. The conditional copy is honest about both. */}
              If an account exists for <strong>{email}</strong>, a password
              reset link is on its way. The link expires soon.
            </p>
            <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.7, marginTop: 10 }}>
              Didn&apos;t get it? Check spam, or send it again.
            </p>
            <button
              className="primary-btn"
              type="button"
              style={{ marginTop: 10 }}
              onClick={() => void sendResetEmail()}
              disabled={busy || resendCooldown.coolingDown}
            >
              <span>
                {busy
                  ? "Sending…"
                  : resendCooldown.coolingDown
                    ? `Send again in ${resendCooldown.remaining}s`
                    : "Send again"}
              </span>
              <IconArrow />
            </button>
            <button
              className="text-link"
              type="button"
              onClick={() => {
                setForgot(false);
                setResetSent(false);
              }}
            >
              Back to login
            </button>
          </div>
        ) : (
          <form onSubmit={onSendReset} noValidate={false}>
            <div className="field-list">
              <div className="field">
                <label className="field-label" htmlFor="reset-email">
                  Email address
                </label>
                <div className="input-wrap">
                  <IconMail />
                  <input
                    id="reset-email"
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>
            <button
              className="primary-btn"
              type="submit"
              disabled={busy || resendCooldown.coolingDown}
            >
              <span>
                {busy
                  ? "Sending…"
                  : resendCooldown.coolingDown
                    ? `Send again in ${resendCooldown.remaining}s`
                    : "Send reset link"}
              </span>
              <IconArrow />
            </button>
            <div style={{ textAlign: "center", marginTop: 14 }}>
              <button
                className="text-link"
                type="button"
                onClick={() => setForgot(false)}
              >
                Back to login
              </button>
            </div>
          </form>
        )
      ) : (
      <>
      <form onSubmit={onSubmit} noValidate={false}>
        <div className="field-list">
          <div className="field">
            <label className="field-label" htmlFor="email">Email address</label>
            <div className="input-wrap">
              <IconMail />
              <input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="password">Password</label>
            <div className="input-wrap">
              <IconLock />
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                placeholder="At least 8 characters"
                autoComplete="current-password"
                minLength={PASSWORD_MIN_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                className="password-toggle"
                type="button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((v) => !v)}
              >
                <IconEye off={showPassword} />
              </button>
            </div>
          </div>
        </div>
        <div className="form-meta">
          {/* M63: the "Keep me signed in" checkbox was dead — `remember`
              was never read, and the session ALWAYS persisted to
              localStorage (storage is fixed at client creation). A
              checkbox promising session-only login was a false
              security expectation, so it was removed rather than
              wired to a storage layer it can't control. */}
          <button
            className="text-link"
            type="button"
            onClick={() => setForgot(true)}
          >
            Forgot password?
          </button>
        </div>
        <button className="primary-btn" type="submit" disabled={busy}>
          <span>{busy ? "Signing in…" : "Log In"}</span>
          <IconArrow />
        </button>
      </form>
      <div style={{ textAlign: "center", marginTop: 14 }}>
        <p style={{ fontSize: 13, color: "#6B7280", lineHeight: 1.7 }}>
          Didn&apos;t get a verification email?{" "}
          <button
            type="button"
            className="text-link"
            onClick={onResend}
            disabled={resendBusy || resendCooldown.coolingDown}
          >
            {resendBusy
              ? "Sending…"
              : resendCooldown.coolingDown
                ? `Resend in ${resendCooldown.remaining}s`
                : "Resend it"}
          </button>
        </p>
      </div>
      <div className="auth-switch">
        <p>New to VibeTalk?</p>
        <Link to="/register" search={{ next }} className="text-link">Create account</Link>
      </div>
      {/* Audit-3 A3-06: carry ?next= into /join so the join → login
          leg can carry it back (otherwise the deep link is lost). */}
      <Link to="/join" search={{ next }} className="outline-join-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <circle cx="8" cy="15" r="4" />
          <path d="m11 12 9-9 2 2-2 2 1.5 1.5-2.5 2.5-1.5-1.5-3 3" />
        </svg>
        Join with Email
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </Link>
      </>
      )}
    </AuthShell>
  );
}
