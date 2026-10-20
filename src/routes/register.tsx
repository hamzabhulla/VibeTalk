import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { registerWithPassword } from "@/lib/auth.functions";
import { useAuth } from "@/lib/auth-context";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, passwordPolicyError } from "@/lib/password-policy";
import { useResendCooldown } from "@/lib/use-cooldown";
import { safeNextPath } from "@/lib/safe-next";
import { toast } from "sonner";
import { AuthShell, IconArrow, IconEye, IconLock, IconMail, IconPerson } from "@/components/auth-shell";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
  // M39: accept the same ?next= return-to param as /login (mirrors
  // login's validateSearch) so a deep link survives login → register.
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Create account — VibeTalk" },
      {
        name: "description",
        content: "Create your free VibeTalk account with email verification.",
      },
      { property: "og:title", content: "Create account — VibeTalk" },
      { property: "og:description", content: "Create your free VibeTalk account." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function RegisterPage() {
  const { session, loading } = useAuth();
  const register = useServerFn(registerWithPassword);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  // M62: resend cooldown (60s).
  const resendCooldown = useResendCooldown(60);
  const { next } = Route.useSearch();

  // Audit-2 L26: same shared safeNextPath as /login (see
  // src/lib/safe-next.ts). Audit-3 L26-wiring: full-document replace,
  // NOT navigate({ to: safeNext }) — `to` is a pure pathname, so the
  // built location would carry the query/hash inside the pathname
  // with empty search (it lands only via the pushState + load
  // re-parse — contract-violating and fragile). Replace keeps
  // M39 (no back-button loop to /register).
  const safeNext = safeNextPath(next);
  const goNext = useCallback(() => {
    window.location.replace(safeNext);
  }, [safeNext]);

  useEffect(() => {
    if (!loading && session) goNext();
  }, [loading, session, goNext]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // M52: HTML `required` accepts whitespace-only ("   ").
    if (!displayName.trim()) {
      toast.error("Please enter a display name.");
      return;
    }
    // M57: shared password policy (was: HTML minLength only, no max).
    const pwError = passwordPolicyError(password);
    if (pwError) {
      toast.error(pwError);
      return;
    }
    setBusy(true);
    try {
      // Audit-4 M1: register through the server fn — the password
      // policy is enforced server-side there. The old client signUp
      // let a console/curl call bypass min-8, the blocklist, and the
      // 72-byte cap. The server fn returns no session: with Confirm
      // email ON (this project's setting) there is never a session
      // at signup, so the flow is always "Check your inbox" (the
      // old data.session branch never fired here).
      await register({
        data: {
          email: email.trim(),
          password,
          displayName: displayName.trim(),
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      setEmailSent(true);
    } catch (err) {
      // Audit-4 L9: never toast the raw server error. A GoTrue /
      // admin error detail here would be an enumeration oracle if
      // email-confirm is ever turned off (and leaks internals even
      // today). Only two messages are safe to surface: the
      // rate-limit message (reveals nothing about the email — same
      // pattern as join's probe) and a transport failure (my
      // network, not the account — L3 pattern). Everything else
      // gets the same generic message the server fn itself uses.
      const msg = err instanceof Error ? err.message : "";
      if ((err as { name?: string } | null)?.name === "AuthRetryableFetchError") {
        toast.error("Could not create account — check your connection and try again.");
      } else if (msg.includes("Too many attempts")) {
        toast.error(msg);
      } else {
        toast.error("Could not create account — please try again later.");
      }
    } finally {
      setBusy(false);
    }
  };

  // M53: one-click resend for the verification email (mirrors /join).
    // Without it, "try registering again" re-submits the same email —
    // for an already-confirmed account signUp silently returns a
    // fake user with no email sent, so the user waits for a mail
    // that never comes.
  // Audit-3 A2-N2: neutral resend (same as /login + /auth/callback) —
  // GoTrue's resend distinguishes a confirmed account (error) from an
  // unconfirmed one (success); toasting the raw error was a
  // confirmed-account enumeration oracle. Every non-transport outcome
  // shows the identical neutral message + starts the cooldown; only a
  // transport failure (AuthRetryableFetchError) may report a failure.
  const RESEND_NEUTRAL =
    "If this email has an unverified account, a verification link is on its way.";
  const onResend = async () => {
    // Audit-3 A2-N8: handler-level cooldown gate (see login.tsx).
    if (resendCooldown.coolingDown) return;
    // Audit-4 L4: L16 email guard (same as login's onResend).
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

  if (emailSent) {
    return (
      <AuthShell
        heading="Check your inbox"
        // M61: "We sent" promised delivery the app can't guarantee
        // (Supabase returns success for duplicates too, and a
        // misconfigured SMTP sends nothing). "On its way" + the
        // resend button below is the honest version.
        subheading={`A verification link is on its way to ${email}. Click it to activate your account, then log in.`}
      >
        <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
          <p style={{ fontSize: 14, color: "#374151", lineHeight: 1.7 }}>
            Didn&apos;t get it? Check spam, or resend the verification email.
          </p>
          <button
            type="button"
            className="primary-btn"
            style={{ marginTop: 12 }}
            onClick={onResend}
            disabled={resendBusy || resendCooldown.coolingDown}
          >
            <span>
              {resendBusy
                ? "Sending…"
                : resendCooldown.coolingDown
                  ? `Resend in ${resendCooldown.remaining}s`
                  : "Resend verification email"}
            </span>
            <IconArrow />
          </button>
          <Link to="/login" search={{ next }} className="primary-btn" style={{ marginTop: 12 }}>
            <span>Go to login</span>
            <IconArrow />
          </Link>
        </div>
        <div className="auth-switch">
          <p>Already have an account?</p>
          <Link to="/login" search={{ next }} className="text-link">Log in</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Create your account" subheading="Join your people. Your room is waiting.">
      <form onSubmit={onSubmit}>
        <div className="field-list">
          <div className="field">
            <label className="field-label" htmlFor="displayName">Display name</label>
            <div className="input-wrap">
              <IconPerson />
              <input
                id="displayName"
                name="displayName"
                type="text"
                placeholder="What should people call you?"
                autoComplete="name"
                maxLength={40}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>
          </div>
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
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
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
        <button className="primary-btn" type="submit" disabled={busy}>
          <span>{busy ? "Creating account…" : "Create Account"}</span>
          <IconArrow />
        </button>
      </form>
      <div className="auth-switch">
        <p>Already have an account?</p>
        <Link to="/login" search={{ next }} className="text-link">Log in</Link>
      </div>
      {/* Audit-3 A3-06: carry ?next= into /join (see login.tsx). */}
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
    </AuthShell>
  );
}
