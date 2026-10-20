import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { registerWithEmail } from "@/lib/auth.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useResendCooldown } from "@/lib/use-cooldown";
import { toast } from "sonner";
import { AuthShell, IconArrow, IconMail, IconPerson } from "@/components/auth-shell";

export const Route = createFileRoute("/join")({
  component: JoinPage,
  // Audit-3 A3-06: accept the same ?next= return-to param as
  // /login and /register, and pass it back through the login links
  // below (the /login → /join → /login detour used to drop it).
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Join — VibeTalk" },
      { name: "description", content: "Create your VibeTalk account." },
      { property: "og:title", content: "Join — VibeTalk" },
      { property: "og:description", content: "Create your VibeTalk account." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function JoinPage() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const { session, loading } = useAuth();
  const signup = useServerFn(registerWithEmail);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  // Audit-2 M10: the old code claimed "sent" before anything was
  // sent. `emailSent` only means "signup done, on the verify step" —
  // track the actual resend outcome separately so the copy claims
  // "sent" only after a resend SUCCEEDS (failures toast an error
  // and stay in the not-sent state).
  const [resendSent, setResendSent] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  // M62: resend cooldown (60s).
  const resendCooldown = useResendCooldown(60);

  // M40: signed-in users must not create a NEW account from inside
  // a session (it would create a second account by confusion). Same
  // session redirect as /login and /register.
  useEffect(() => {
    if (!loading && session) navigate({ to: "/rooms", replace: true });
  }, [loading, session, navigate]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Audit-2 L14: register (M52) rejects whitespace-only names instantly;
    // join sent the raw name and left the failure to the server zod.
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      toast.error("Please enter a display name.");
      return;
    }
    setBusy(true);
    try {
      // M56: trim — server zod .email() rejects surrounding whitespace.
      // Audit-2 H1: NO password is collected here. The server creates
      // the account with a random password (a self-chosen password +
      // a clicked verification link = account pre-hijack). The owner
      // sets their password after verifying (/set-password).
      await signup({ data: { email: email.trim(), displayName: trimmedName } });
      // Audit-2 H1: NO auto-resend. The old code sent the verification
      // email immediately, so a signup using a VICTIM's email got the
      // app itself to spam the victim with the "verify" link that
      // completes the hijack. The user taps Send below when ready.
      // (A determined attacker can still resend via Supabase's public
      // API — but post-H1 the password is random, so a clicked link
      // yields no login for them.)
      setEmailSent(true);
      setResendSent(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not join";
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  // Audit-3 A2-N2: neutral resend (same as /login + /auth/callback) —
  // GoTrue's resend distinguishes a confirmed account (error) from an
  // unconfirmed one (success); toasting the raw error was a
  // confirmed-account enumeration oracle. Every non-transport outcome
  // shows the identical neutral message + starts the cooldown, AND
  // flips resendSent (the "Check your inbox" view is itself a UI
  // distinguisher — it must flip for confirmed/unconfirmed/nonexistent
  // alike). Only a transport failure may report a send failure.
  const RESEND_NEUTRAL =
    "If this email has an unverified account, a verification link is on its way.";
  const onResend = async () => {
    // Audit-3 A2-N8: handler-level cooldown gate (see login.tsx).
    if (resendCooldown.coolingDown) return;
    // Audit-4 L4: L16 email guard (same as login's onResend) — an
    // empty/invalid email burned a Supabase call + a cooldown and
    // showed the neutral "on its way" toast for a link never sent.
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
      // Audit-2 M9: emailRedirectTo — without it the verification link
      // goes to the dashboard Site URL (standing issue: still
      // localhost), breaking join on any host. Same as register/login.
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: trimmedEmail,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      resendCooldown.start();
      setResendSent(true);
      toast.success(RESEND_NEUTRAL);
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "AuthRetryableFetchError") {
        toast.error("Could not send — check your connection and try again.");
      } else {
        resendCooldown.start();
        setResendSent(true);
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
        heading={resendSent ? "Check your inbox" : "Verify your email"}
        subheading={
          // Audit-4 L4: same M61 copy fix as /register — "We sent"
          // promised delivery the app can't guarantee (GoTrue
          // returns success for duplicates too, and a misconfigured
          // SMTP sends nothing). The resendSent flip itself stays:
          // A2-N2 requires it for confirmed/unconfirmed/nonexistent
          // alike (the view must not distinguish them).
          resendSent
            ? `A verification link is on its way to ${email}. After verifying, you'll set your password, then log in.`
            : `Tap below to send the verification link to ${email}. After verifying, you'll set your password, then log in.`
        }
      >
        <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
          <p style={{ fontSize: 14, color: "#374151", lineHeight: 1.7 }}>
            {resendSent
              ? "Check spam if it doesn't arrive."
              : "After tapping send, check spam if it doesn't arrive."}
          </p>
          <button
            type="button"
            className="primary-btn"
            style={{ marginTop: 20 }}
            onClick={onResend}
            disabled={resendBusy || resendCooldown.coolingDown}
          >
            <span>
              {resendBusy
                ? "Sending…"
                : resendCooldown.coolingDown
                  ? `Resend in ${resendCooldown.remaining}s`
                  : resendSent
                    ? "Resend verification email"
                    : "Send verification email"}
            </span>
            <IconArrow />
          </button>
          <Link to="/login" search={{ next }} className="primary-btn" style={{ marginTop: 12 }}>
            <span>Go to login</span>
            <IconArrow />
          </Link>
          <button
            type="button"
            className="text-link"
            style={{ marginTop: 16, background: "none", border: "none", cursor: "pointer" }}
            onClick={() => {
              setEmailSent(false);
              setResendSent(false);
            }}
          >
            Use a different email
          </button>
        </div>
        <div className="auth-switch">
          <p>Already have an account?</p>
          <Link to="/login" search={{ next }} className="text-link">Log in</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Create your account" subheading="Enter your details to get started.">
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
        </div>
        <button className="primary-btn" type="submit" disabled={busy}>
          <span>{busy ? "Creating…" : "Create account"}</span>
          <IconArrow />
        </button>
      </form>
      <div className="auth-switch">
        <p>Prefer a regular sign in?</p>
        <Link to="/login" search={{ next }} className="text-link">Log in</Link>
      </div>
    </AuthShell>
  );
}
