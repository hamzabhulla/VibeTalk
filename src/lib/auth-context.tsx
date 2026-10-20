import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { currentPushEndpoint, unsubscribeFromPush } from "@/lib/push-client";
import {
  checkPushEndpoint,
  removeAllPushSubscriptions,
  removePushSubscription,
} from "@/lib/push.functions";

type AuthCtx = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /** Non-null when the initial session check failed (after retry) — the app shows a retry UI instead of forcing a re-login. */
  authError: string | null;
  /** Re-run the initial session check (clears authError). */
  retryAuth: () => void;
  signOut: (options?: { everywhere?: boolean }) => Promise<void>;
};

const Ctx = createContext<AuthCtx | undefined>(undefined);

// Audit-2 M51: multi-tab presence coordination. Each open tab
// registers itself in a localStorage registry (tabId -> last-seen
// ms) and touches its entry on every heartbeat. On unload a tab
// unregisters itself FIRST (synchronous) and only marks the user
// offline when no OTHER live tab remains — closing one of two tabs
// must not flip the user offline. Entries older than the TTL are
// dead tabs (crashed, never unregistered) and are pruned + ignored.
// localStorage is synchronous, which is exactly what an unload
// handler needs (BroadcastChannel handshakes can't complete there).
// Storage failures (private mode quotas) fail open: the tab just
// isn't counted, and the 120s staleness rule stays the authority.
const PRESENCE_TABS_KEY = "vibetalk-presence-tabs";
const PRESENCE_TAB_TTL_MS = 120_000;
// Audit-2 L25: bound for the best-effort offline mark in signOut — a
// hung PATCH must never hang sign-out itself (the 120s staleness rule
// still marks the user offline if the write never lands).
const OFFLINE_MARK_TIMEOUT_MS = 3000;

/**
 * Audit-5 B5-LOW: how far markOffline backdates presence.last_seen_at.
 * Must EXCEED the 120s staleness window (isUserOnline) so the user
 * reads offline immediately, and stay INSIDE presence_write_own's
 * WITH CHECK window (now() - 5 minutes, audit2 §M53 / A8-N12) so
 * RLS admits the write. 150s satisfies both.
 */
const PRESENCE_OFFLINE_BACKDATE_MS = 150_000;

function readPresenceTabs(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PRESENCE_TABS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [id, ts] of Object.entries(parsed)) {
      if (typeof ts === "number" && Number.isFinite(ts)) out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function writePresenceTabs(tabs: Record<string, number>): void {
  try {
    localStorage.setItem(PRESENCE_TABS_KEY, JSON.stringify(tabs));
  } catch {
    /* presence registry is best-effort */
  }
}

/** Register/touch this tab's entry and prune dead tabs' entries. */
function touchPresenceTab(tabId: string): void {
  const tabs = readPresenceTabs();
  const now = Date.now();
  for (const [id, ts] of Object.entries(tabs)) {
    if (now - ts > PRESENCE_TAB_TTL_MS) delete tabs[id];
  }
  tabs[tabId] = now;
  writePresenceTabs(tabs);
}

/** Remove this tab's entry (unload + effect cleanup). */
function unregisterPresenceTab(tabId: string): void {
  const tabs = readPresenceTabs();
  delete tabs[tabId];
  writePresenceTabs(tabs);
}

/** True when another tab has touched the registry within the TTL. */
function otherPresenceTabsAlive(tabId: string): boolean {
  const tabs = readPresenceTabs();
  const now = Date.now();
  let pruned = false;
  for (const [id, ts] of Object.entries(tabs)) {
    if (now - ts > PRESENCE_TAB_TTL_MS) {
      delete tabs[id];
      pruned = true;
    }
  }
  if (pruned) writePresenceTabs(tabs);
  return Object.entries(tabs).some(([id, ts]) => id !== tabId && now - ts <= PRESENCE_TAB_TTL_MS);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const removePush = useServerFn(removePushSubscription);
  const removeAllPush = useServerFn(removeAllPushSubscriptions);
  const checkPush = useServerFn(checkPushEndpoint);
  const [loading, setLoading] = useState(true);
  // Audit-2 M15: the initial session check can hang or fail transiently.
  const [authError, setAuthError] = useState<string | null>(null);
  const [authAttempt, setAuthAttempt] = useState(0);
  const retryAuth = () => {
    setAuthError(null);
    setLoading(true);
    // Fresh check = fresh refs (a stale signedOut flag from an
    // earlier sign-out must not veto the new check).
    signedOutRef.current = false;
    sessionKnownRef.current = null;
    setAuthAttempt((n) => n + 1);
  };
  // M15: refs the in-flight check consults so it never clobbers a
  // session the subscription already delivered (or resurrects one
  // after a mid-check sign-out — the retry stretches that window to
  // ~10s). sessionKnownRef holds the known session's user id.
  const sessionKnownRef = useRef<string | null>(null);
  const signedOutRef = useRef(false);

  // Audit-2 M52: cache the access token in memory (refreshed on
  // every session change, including TOKEN_REFRESHED) so unload
  // handlers never need an async getSession() — on unload the page
  // can die before that promise resolves, and the offline PATCH
  // would never be sent.
  const tokenRef = useRef<{ token: string; uid: string } | null>(null);
  useEffect(() => {
    tokenRef.current = session
      ? { token: session.access_token, uid: session.user.id }
      : null;
  }, [session]);
  // Audit-2 M52: double-fire guard — beforeunload + pagehide both
  // fire on one close; the offline PATCH must go out exactly once.
  const offlineSentRef = useRef(false);
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (_e === "SIGNED_OUT") signedOutRef.current = true;
      // A live session from the subscription clears a stale check error
      // and ends loading — the stored session is proof enough, even if
      // the getSession() call below is still hanging.
      if (s) {
        sessionKnownRef.current = s.user.id;
        setAuthError(null);
        setLoading(false);
      } else {
        sessionKnownRef.current = null;
      }
    });

    // Audit-2 M15: getSession() with a 5s timeout + 1 retry. The old
    // code had only a .catch: a hang left the app on "Loading…"
    // forever, and a transient failure (network blip, valid session in
    // storage) forced a re-login. Now a double failure surfaces
    // authError (the layout shows Retry) instead of redirecting.
    let cancelled = false;
    const loadSession = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { data } = await Promise.race([
            supabase.auth.getSession(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Session check timed out")), 5000),
            ),
          ]);
          if (cancelled) return;
          // A mid-check sign-out wins: a stale getSession result must
          // not resurrect the session.
          if (signedOutRef.current) return;
          if (data.session) {
            sessionKnownRef.current = data.session.user.id;
            setSession(data.session);
            setAuthError(null);
            setLoading(false);
          } else if (!sessionKnownRef.current) {
            // No session anywhere — genuinely logged out. If the
            // subscription already delivered one, don't wipe it
            // with this null.
            setSession(null);
            setAuthError(null);
            setLoading(false);
          }
          return;
        } catch (err) {
          if (cancelled) return;
          console.warn(`[auth] getSession failed (attempt ${attempt + 1}/2):`, err);
          if (attempt === 0) continue;
          // Don't clobber a subscription-delivered session with an
          // error state (its loading is already false).
          if (signedOutRef.current || sessionKnownRef.current) return;
          setAuthError("Couldn't check your session — check your connection and try again.");
          setLoading(false);
        }
      }
    };
    void loadSession();

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [authAttempt]);

  // Presence uses the authenticated heartbeat function; readers treat stale heartbeats as offline.
  useEffect(() => {
    if (!session?.user) return;
    // Audit-2 M51: this tab's registry id. Random per mount (a
    // remount re-registers; the cleanup unregisters the old id).
    const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    touchPresenceTab(tabId);
    const heartbeat = () => {
      // Audit-2 M51: NO document.hidden gate — the old check froze
      // presence the moment the tab went to the background, so the
      // user looked offline 120s later with the app still open.
      // Audit-4 L47: the 25s timer is throttled by the browser
      // itself in hidden tabs (~1/min) — against the old 70s window
      // that left only a 10s margin, so a slow heartbeat RPC or
      // scheduling jitter pushed the gap past 70s and background-tab
      // users flickered "offline". The 120s window leaves 60s of
      // margin over the throttled cadence.
      touchPresenceTab(tabId);
      // Never swallow the error: a failing heartbeat is exactly how
      // presence silently froze at account-creation time (last_seen_at
      // never updated). Surface it in the console so it stays visible.
      void supabase.rpc("touch_presence").then(({ error }) => {
        if (error) console.warn("[presence] touch_presence failed:", error.message);
      });
    };
    heartbeat();
    const onVisibility = () => heartbeat();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", heartbeat);
    const timer = setInterval(heartbeat, 25_000);
    // M90: best-effort offline mark on tab close. A plain supabase
    // update would be cancelled mid-flight on unload, so use a
    // keepalive fetch to PostgREST (same RLS: own row only).
    // pagehide covers mobile browsers that never fire beforeunload.
    // If both fail (crash, killed tab), the 120s staleness rule still
    // marks the user offline — it stays the authority.
    const markOffline = (e?: Event) => {
      // bfcache: pagehide fires with persisted=true when the page is
      // parked, not closed — it may come back. Don't mark offline
      // (and don't unregister the tab) for a parked page.
      if (e && "persisted" in e && (e as PageTransitionEvent).persisted) return;
      // Audit-2 M51: only the LAST tab marks offline. Unregister
      // first (synchronous), then check for other live tabs.
      unregisterPresenceTab(tabId);
      if (otherPresenceTabsAlive(tabId)) return;
      // Audit-2 M52: double-fire guard (beforeunload + pagehide).
      if (offlineSentRef.current) return;
      offlineSentRef.current = true;
      // Audit-2 M52: NO async getSession() here — the old code
      // awaited it first, and the page often died before it
      // resolved, so the fetch never went out. The token is cached
      // in tokenRef (refreshed on every session change). fetch with
      // keepalive is the only option: sendBeacon can't set the
      // apikey/Authorization headers this PATCH needs.
      const cached = tokenRef.current;
      if (!cached) return;
      // Audit-5 B5-LOW: profiles.is_online is frozen post-M53 (no
      // reader, no updater) — the old PATCH wrote a column nobody
      // reads, leaving a ghost online dot until the 120s staleness
      // window. Write the presence row instead: backdate
      // last_seen_at past the staleness window so the user reads
      // offline immediately. PostgREST upsert (merge-duplicates).
      void fetch(
        `${import.meta.env.VITE_SUPABASE_URL as string}/rest/v1/presence`,
        {
          method: "POST",
          headers: {
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
            Authorization: `Bearer ${cached.token}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify([
            {
              user_id: cached.uid,
              last_seen_at: new Date(Date.now() - PRESENCE_OFFLINE_BACKDATE_MS).toISOString(),
            },
          ]),
          keepalive: true,
        },
      ).catch(() => {
        /* best-effort — unload may still drop it */
      });
    };
    window.addEventListener("beforeunload", markOffline);
    window.addEventListener("pagehide", markOffline);
    // Audit-2 M52: a bfcache-restored page is alive again — reset the
    // double-fire guard so its eventual real close can mark offline.
    const onPageShow = () => {
      offlineSentRef.current = false;
    };
    window.addEventListener("pageshow", onPageShow);

    return () => {
      unregisterPresenceTab(tabId);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", heartbeat);
      window.removeEventListener("beforeunload", markOffline);
      window.removeEventListener("pagehide", markOffline);
      window.removeEventListener("pageshow", onPageShow);
      clearInterval(timer);
    };
  }, [session?.user]);

  const value: AuthCtx = {
    session,
    user: session?.user ?? null,
    loading,
    authError,
    retryAuth,
    signOut: async (options?: { everywhere?: boolean }) => {
      // M90: mark offline BEFORE the session is cleared — after
      // signOut there is no authenticated session to write with.
      // Best-effort: a failure here must not block signing out (the
      // 120s staleness rule still marks the user offline; a failed
      // write only delays that by ≤120s).
      const uid = session?.user?.id;
      if (uid) {
        // Audit-2 L25: the offline PATCH used to be awaited with no
        // timeout — a hung request hung sign-out itself. Best-effort
        // means bounded: race it against the timeout (same pattern
        // as the M15 session check). The losing request is NOT
        // cancelled — if it lands late, the offline mark is still
        // correct. On timeout, the 120s staleness rule covers us.
        try {
          const { error: offlineError } = await Promise.race([
            // Audit-5 B5-LOW: presence row, not the frozen
            // profiles.is_online column (see the unload path).
            supabase
              .from("presence")
              .upsert(
                {
                  user_id: uid,
                  last_seen_at: new Date(Date.now() - PRESENCE_OFFLINE_BACKDATE_MS).toISOString(),
                },
                { onConflict: "user_id" },
              ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("offline mark timed out")), OFFLINE_MARK_TIMEOUT_MS),
            ),
          ]);
          if (offlineError) console.warn("[presence] mark offline failed:", offlineError.message);
        } catch (err) {
          console.warn("[presence] mark offline failed:", err instanceof Error ? err.message : err);
        }
      }
      // Audit-2 M8: `everywhere` revokes ALL refresh tokens (global)
      // AND deletes ALL of the user's push rows — otherwise the other
      // devices keep receiving message previews after "sign out
      // everywhere" (their service workers are session-less). The
      // per-endpoint revoke below is skipped in this mode: removeAll
      // already covers this device too. A removeAll failure is
      // best-effort (warn only) — the session revoke is the critical
      // part and still runs. Default stays local: signing out on the
      // phone must not kick the desktop (M48).
      if (options?.everywhere) {
        try {
          await removeAllPush();
        } catch (err) {
          console.warn(
            "[push] remove-all on sign-out-everywhere failed — other devices may keep receiving pushes:",
            err,
          );
        }
        const { error } = await supabase.auth.signOut({ scope: "global" });
        if (error) throw error;
        return;
      }
      // Audit-2 H20: revoke THIS browser's push subscription BEFORE
      // the session is cleared — otherwise the push_subscriptions row
      // survives logout and the logged-out browser keeps receiving
      // notifications (sender name + message preview) for the next
      // user of this shared device. Only this endpoint is removed
      // (other devices keep theirs). Best-effort: a failure must not
      // block signing out (the session is still cleared), but it is
      // logged — a network-down logout leaves the row alive until the
      // next successful revoke (the SW is session-less by design, so
      // the row is the only control). No live endpoint → nothing to
      // revoke (a stale row for a dead endpoint can't be delivered to,
      // and 404/410 cleanup removes it).
      try {
        if (await currentPushEndpoint()) {
          await unsubscribeFromPush(
            async (endpoint) => {
              await removePush({ data: { endpoint } });
            },
            async (endpoint) => checkPush({ data: { endpoint } }),
          );
        }
      } catch (err) {
        console.warn("[push] revoke on logout failed — subscription row may survive:", err);
      }
      // M48: scope 'local' — the SDK default is 'global', which
      // revokes the session on EVERY device (a user signing out on
      // their phone does not expect their desktop to be kicked).
      // Local clears only this browser's session. Errors THROW so
      // callers can surface them (M47) instead of navigating away
      // while the session is still alive.
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw error;
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
