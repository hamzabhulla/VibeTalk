import { createFileRoute, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/app-shell";
import { CallProvider } from "@/components/call-overlay";
import { MessageNotifier } from "@/components/message-notifier";
import { getSetupHealth, getServerSupabaseConfig } from "@/lib/chat.functions";
import { detectSupabaseDrift } from "@/lib/supabase-config";
import { setClockSkew } from "@/lib/presence";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
  // Audit-4 L80: validate the call-action search contract
  // (?call=accept|decline&callId=…&from=…&callType=…) consumed by
  // CallProvider/call-overlay under this layout. The router MERGES
  // each route's validated keys into the match search, so these
  // flow into the child routes' useSearch() too.
  // All-optional return type (see index.tsx): the keys are
  // genuinely absent from the URL when unused.
  validateSearch: (
    search: Record<string, unknown>,
  ): { call?: "accept" | "decline"; callId?: string; from?: string; callType?: string } => ({
    call: search.call === "accept" || search.call === "decline" ? search.call : undefined,
    callId: typeof search.callId === "string" ? search.callId : undefined,
    from: typeof search.from === "string" ? search.from : undefined,
    callType: typeof search.callType === "string" ? search.callType : undefined,
  }),
});

function AppLayout() {
  const { session, loading, authError, retryAuth } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const checkHealth = useServerFn(getSetupHealth);
  // Audit-2 M19: the signature of the last toasted missing-set. The
  // effect re-runs on every session-object change (token refresh,
  // USER_UPDATED) — without this, each re-run stacked another
  // 15-second toast. A plain once-per-mount ref was NOT used: a
  // transient checkHealth failure would then suppress the warning
  // for the whole session, and a mid-session SQL fix / new gap
  // would never re-surface. Signature dedupe: same gap → no
  // re-toast; changed gap → toast again; gap closed → reset.
  // Audit-2 L91: the signature is the missing COUNT, not the table
  // names — the server no longer discloses them (the toast used to
  // print them to every authenticated user).
  const lastHealthToastRef = useRef<string | null>(null);

  // M29: one-time setup-health check — surface a warning instead of
  // silently degrading (call history / closed-app pickup / typing /
  // call entries) when the pending SQL hasn't run. Once per app load
  // (the layout stays mounted across route changes); the toast is
  // dismissible and disappears once the SQL runs. Audit-2 M19: the
  // toast fires once per missing-signature (see lastHealthToastRef),
  // not once per session-object change.
  useEffect(() => {
    if (loading || !session) return;
    let cancelled = false;
    void (async () => {
      try {
        const { incomplete, missingCount } = await checkHealth();
        if (cancelled) return;
        const signature = String(missingCount);
        if (incomplete) {
          if (lastHealthToastRef.current !== signature) {
            lastHealthToastRef.current = signature;
            toast.warning(
              "Database setup incomplete — some features won't work until the pending SQL runs.",
              { duration: 15000, id: "setup-health" },
            );
          }
        } else {
          // Gap closed — a later regression must toast again.
          lastHealthToastRef.current = "";
        }
      } catch {
        // Health check is best-effort; a failure must never block the app.
        // (The ref is untouched, so the next session change retries.)
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, session, checkHealth]);

  // Audit-2 M74: Supabase config-drift check — runs once per app
  // load, independent of the session (drift breaks login itself, so
  // gating on session would hide it from the victim). The fn is
  // unauthenticated by design (it returns only public values — see
  // getServerSupabaseConfig). Signature dedupe mirrors M19: same
  // drift -> no re-toast; drift resolved -> reset so a later
  // regression toasts again.
  const checkDrift = useServerFn(getServerSupabaseConfig);
  const lastDriftToastRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      try {
        const server = await checkDrift();
        if (cancelled) return;
        // Audit-2 L69: record the server-client clock skew so
        // isUserOnline compares server-written last_seen_at against
        // a corrected now (a device clock ±3 min off used to lie).
        setClockSkew(server.serverNowMs);
        const drift = detectSupabaseDrift(
          {
            url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
            projectId: import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined,
          },
          server,
        );
        if (drift) {
          // The audit's "log both at boot" minimum, as a side effect.
          console.error("[config-drift]", drift, {
            clientUrl: import.meta.env.VITE_SUPABASE_URL,
            clientProjectId: import.meta.env.VITE_SUPABASE_PROJECT_ID,
            server,
          });
          if (lastDriftToastRef.current !== drift) {
            lastDriftToastRef.current = drift;
            toast.warning(drift, { duration: 20000, id: "config-drift" });
          }
        } else {
          lastDriftToastRef.current = "";
        }
      } catch {
        // Best-effort; a failed check must never block the app.
        // Audit-4 L44: if this ONE call fails, the skew stayed 0
        // for the whole session. Retry ONCE after 10s (a transient
        // failure) — the drift check is idempotent (same drift ->
        // no re-toast), so re-running it is safe.
        if (!cancelled && retryTimer === null) {
          retryTimer = setTimeout(() => void run(), 10_000);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [checkDrift]);

  // Audit-4 L67 — DOCUMENTED BY DESIGN: this guard is
  // client-side UI routing ONLY, not an authorization boundary.
  // There is no loader/beforeLoad enforcement on any _app route,
  // and SSR renders only this shell + the Loading… gate below —
  // no protected data ever reaches SSR HTML. Real authorization
  // lives in two places: (1) requireSupabaseAuth on every server
  // fn except three deliberately public ones —
  // registerWithEmail, registerWithPassword (the signup flows,
  // all rate-limited) and getServerSupabaseConfig (returns
  // only the Supabase hostname, project ref, and server clock);
  // (2) RLS policies on every table. An unauthenticated caller
  // hitting a server fn directly gets an Unauthorized error, not
  // data — never rely on this redirect for protection.
  useEffect(() => {
    // Audit-2 M15: a failed session CHECK is not "logged out" — the
    // user may have a valid session (transient network failure). Do
    // not redirect to /login while authError is set; the error UI
    // below offers Retry.
    if (!loading && !session && !authError) {
      // Preserve the destination (path + query) so login can send the
      // user back to it — e.g. /rooms?call=accept&callId=... from a
      // closed-app Pick/Reject tap (audit C3). Without this the
      // ?call= params were dropped by the bare /login redirect.
      // Audit-3 A3-05: preserve the fragment too (message anchors
      // survive the login round-trip); safeNextPath already keeps it.
      const dest = location.pathname + location.search + location.hash;
      // M39: replace — without it, Back from /login returns to the
      // protected URL, which re-redirects to /login (back trap).
      navigate({ to: "/login", search: { next: dest }, replace: true });
    }
  }, [loading, session, navigate, location.pathname, location.search, location.hash]);

  // Audit-2 H1: a flagged session (invite-redeem account that verified
  // but hasn't set a password yet) must finish setup before using the
  // app. /set-password is a top-level route (not under _app), so this
  // cannot loop. Skipping setup is not a security hole (the account's
  // password is server-random), but the app must not pretend setup is
  // complete — the user would be locked out on next login.
  // Audit-4 C1: the metadata flag read here is a UX HINT only (any
  // session can overwrite its own metadata) — the real gate is the
  // server-side password_setup_pending row enforced by
  // completePasswordSetup; /set-password verifies it before showing
  // the form and heals a stale flag when the server says not-pending.
  useEffect(() => {
    if (
      !loading &&
      session &&
      (session.user.user_metadata as Record<string, unknown> | null)
        ?.password_setup_pending === true
    ) {
      navigate({ to: "/set-password", replace: true });
    }
  }, [loading, session, navigate]);

  // Audit-2 M15: a failed session check shows an actionable error
  // (Retry) instead of an infinite spinner or a forced re-login.
  if (authError) {
    return (
      <div className="min-h-screen grid place-items-center px-4">
        <div className="w-full max-w-md rounded-2xl p-8 text-center">
          <h1 className="text-xl font-semibold">Couldn&apos;t check your session</h1>
          <p className="mt-1 text-sm text-muted-foreground">{authError}</p>
          <button
            type="button"
            className="mt-6 w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
            onClick={retryAuth}
          >
            Retry
          </button>
          <button
            type="button"
            className="mt-2 w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-muted-foreground"
            // Audit-3 A3-04: preserve the return-to destination (same
            // dest the guard uses) instead of dropping it.
            onClick={() =>
              navigate({
                to: "/login",
                search: { next: location.pathname + location.search + location.hash },
              })
            }
          >
            Go to login
          </button>
        </div>
      </div>
    );
  }

  if (loading || !session) {
    return (
      <div className="min-h-screen grid place-items-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <AppShell>
      <CallProvider>
        <MessageNotifier />
        <Outlet />
      </CallProvider>
    </AppShell>
  );
}
