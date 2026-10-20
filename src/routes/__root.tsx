import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  Link,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";

import appCss from "../styles.css?url";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { handleAuthEventForCache } from "@/lib/auth-cache";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { isNotificationsEnabled } from "@/lib/notifications";
import { pushSupported, subscribeToPush, pushSubscriptionVapidStale, resolveVapidPublicKey, serviceWorkerReady, type PushKeys } from "@/lib/push-client";
import { savePushSubscription, checkPushEndpoint, getVapidPublicKey } from "@/lib/push.functions";
import { recordPushHealFailure, clearPushHealFailure } from "@/lib/push-heal";

function NotFoundComponent() {
  // Audit-2 L30: a logged-in user who mistypes a URL got only "Go
  // home" (public landing) with no way back to their chats. The
  // notFound slot renders inside <AuthProvider> (RootComponent), so
  // useAuth() is safe here. While the session is still loading the
  // logged-out exit is the safe default — "/" is a valid exit for
  // everyone (the landing shows "Open app" to logged-in users).
  const { session } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-gradient">404</h1>
        <h2 className="mt-4 text-xl font-semibold">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist.
        </p>
        <div className="mt-6">
          <Link
            to={session ? "/rooms" : "/"}
            className="inline-flex items-center justify-center rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-md hover:opacity-90"
          >
            {session ? "Back to chats" : "Go home"}
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-6 inline-flex items-center justify-center rounded-md gradient-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-md"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "VibeTalk — Private real-time conversations" },
      {
        // Audit-3 A1-F2: signup is open by email — "Invite-only" was false.
        name: "description",
        content: "Private real-time chat with rooms and presence.",
      },
      { property: "og:title", content: "VibeTalk — Private real-time conversations" },
      { name: "twitter:title", content: "VibeTalk — Private real-time conversations" },
      {
        property: "og:description",
        content: "Private real-time chat with rooms and presence.",
      },
      {
        name: "twitter:description",
        content: "Private real-time chat with rooms and presence.",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
      // Audit-3 A1-F3: og:image + theme-color live in the ROOT head so
      // every route inherits them (previously only `/` had them, so
      // sharing /login etc. produced a text-only preview). Values match
      // the landing's own head (same Cloudflare-host URL) — the landing
      // overrides with identical values. Canonical/og:url stay per-route
      // (they are page-specific; the landing sets its own).
      { property: "og:image", content: "https://hc.hcroom.workers.dev/og-image.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:alt", content: "VibeTalk — Chat at the speed of thought" },
      { name: "twitter:image", content: "https://hc.hcroom.workers.dev/og-image.png" },
      { name: "theme-color", content: "#00A651" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Audit-3 A1-F4: explicit icon links (the favicon previously worked
      // only via the browser's implicit /favicon.ico request).
      { rel: "icon", href: "/favicon.ico" },
      { rel: "apple-touch-icon", href: "/og-image.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        // M69: Inter was declared (landing --font + auth-shell) but never
        // loaded, so both always fell back to system-ui. Added here
        // (weights the landing + auth shell actually use).
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700;800&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

/**
 * Audit-2 M18: blocking theme script — runs BEFORE first paint, so a
 * stored-light user never sees a dark frame. It mirrors
 * readInitialTheme() in use-theme.ts (stored value wins, else
 * prefers-color-scheme: light, else dark). The <html> below keeps
 * className="dark" (the no-JS default) + suppressHydrationWarning so
 * React neither warns about nor reverts the script's pre-paint
 * correction. Both hosts' CSPs allow 'unsafe-inline' scripts.
 */
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}var d=document.documentElement;d.classList.toggle('dark',t==='dark');d.style.colorScheme=t;}catch(e){}})();`;

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Audit-2 M1: the push effects (SW-message re-save + self-heal) live
 * here, INSIDE <AuthProvider>, so they can gate on the real session.
 * Both call AUTHENTICATED server fns — running them logged out fired
 * those fns for anonymous visitors on / and /login, and the auth
 * rejection was recorded as a push-heal failure that haunted the next
 * login. With the gate, logged-out runs make ZERO server calls and
 * record NOTHING. The SW-registration effect stays in RootComponent
 * (registering the SW needs no session).
 */
function PushEffects() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const savePush = useServerFn(savePushSubscription);
  const checkEndpoint = useServerFn(checkPushEndpoint);
  const getVapidKey = useServerFn(getVapidPublicKey);

  // Audit-2 M72: stash the SERVER VAPID public key where the SW
  // can read it (IndexedDB) so the SW's pushsubscriptionchange
  // handler can re-subscribe under the authoritative key. Lives
  // in PushEffects (session-gated) because the key comes from an
  // authenticated server fn — RootComponent renders for
  // anonymous visitors too, and M1 forbids authed calls logged
  // out. Anonymous browsers hold no push subscription anyway;
  // the next logged-in open re-stashes + heals.
  // Audit-4 L28: stash ONLY the server key — NEVER the VITE_
  // fallback. The old code stashed resolveVapidPublicKey() =
  // serverKey ?? fallback, so a server-fn failure/null wrote the
  // bundled VITE_ key to IDB as if it were the server key, and
  // the SW re-subscribed under a possibly-drifted key. The
  // fallback is for the live subscribe path only, never the stash.
  useEffect(() => {
    if (!session?.user) return;
    let alive = true;
    void (async () => {
      try {
        // Server says no key (null/empty) -> DELETE the stashed
        // key: a leftover would claim a server key exists when
        // the server has none. Server fn throws (transient) ->
        // write nothing, keep the previously-stashed
        // authoritative key.
        const res = await getVapidKey();
        if (!alive || !("indexedDB" in window)) return;
        const serverKey =
          typeof res?.publicKey === "string" && res.publicKey.trim() !== "" ? res.publicKey.trim() : null;
        const req = indexedDB.open("vibetalk-sw", 1);
        req.onupgradeneeded = () => {
          try {
            req.result.createObjectStore("config");
          } catch {
            // store already exists
          }
        };
        req.onsuccess = () => {
          try {
            const tx = req.result.transaction("config", "readwrite");
            if (serverKey) {
              tx.objectStore("config").put(serverKey, "vapidPublicKey");
            } else {
              tx.objectStore("config").delete("vapidPublicKey");
            }
          } catch {
            // best-effort
          }
        };
        req.onerror = () => {};
      } catch {
        // best-effort — a transient failure keeps the old stash
      }
    })();
    return () => {
      alive = false;
    };
  }, [session?.user]);

  // Audit-2 M1: session-gated (see PushEffects header).
  // M37 + Audit-2 H24: the SW re-subscribes on pushsubscriptionchange
  // and signals an open tab — the tab re-derives the LIVE subscription
  // and saves it via the authenticated server fn right away (no gap
  // until the next app open). H24: the old handler saved the SW-posted
  // keys directly (savePush({ data: d.keys })) with NO VAPID-staleness
  // check — after a rotation with no tab open, the SW's IDB key is
  // stale, so the saved row was a stale-key subscription (server sends
  // with the new key → 401 → broken push). The SW no longer posts keys
  // at all; this handler always goes through subscribeToPush, which
  // drops a stale sub and subscribes fresh under the current SERVER
  // key — Audit-3 A7-N1: the getter was missing here, so
  // subscribeToPush fell back to the bundled VITE_ key and the
  // re-saved row was under the wrong key (every send 401d after a
  // rotation). The getter is passed, same as the self-heal below.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      // Audit-2 M1: never call authed server fns logged out — the SW
      // message fires for any open tab, including / and /login.
      if (!session?.user) return;
      const d = e.data as { type?: string; roomId?: string } | null;
      if (d?.type === "vibetalk-refresh-room") {
        // Audit-4 L26: ack the SW's postMessage (M57 pattern) —
        // without this, a click on a still-loading tab loses the
        // refresh (no listener yet, no error). The SW reloads the
        // tab if no ack arrives in 1500ms. Ack = "listener
        // mounted", not "refresh done" — post it BEFORE handling.
        try {
          e.ports?.[0]?.postMessage({ type: "vibetalk-refresh-room-ack", roomId: d.roomId ?? null });
        } catch {
          // Ack is best-effort; the SW's reload fallback covers a miss.
        }
        // Audit-2 L74: the SW focused an already-open room tab after
        // a notification click — the message that triggered the
        // notification wasn't in the list yet. Refresh this room's
        // queries (the same keys A7-N2's room channel invalidates).
        if (d.roomId) {
          void queryClient.invalidateQueries({ queryKey: ["messages", d.roomId] });
          void queryClient.invalidateQueries({ queryKey: ["receipts", d.roomId] });
          void queryClient.invalidateQueries({ queryKey: ["member-count", d.roomId] });
        }
        return;
      }
      if (d?.type !== "vibetalk-push-subscription-changed") return;
      if (!isNotificationsEnabled() || !pushSupported()) return;
      if (Notification.permission !== "granted") return;
      void (async () => {
        try {
          // Audit-3 A7-N1: pass the server-VAPID getter (same as the
          // self-heal below) — without it, subscribeToPush falls back
          // to the bundled VITE_ key, and after a rotation the
          // re-saved row is under the wrong key (sends 401).
          await subscribeToPush((s: PushKeys) => savePush({ data: s }), () => getVapidKey());
        } catch {
          // best-effort — the Profile toggle remains the manual path
        }
      })();
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [savePush, getVapidKey, session]);

  // Audit-2 M1: session-gated (see PushEffects header).
  // Self-heal the push subscription: if the user enabled notifications but
  // the browser/server registrations drifted apart (cleared data, expired
  // 404/410 cleanup, etc.), silently repair it so push keeps working.
  // M99: also re-runs when the tab becomes visible / the window regains
  // focus — a subscription that expires mid-session used to stay broken
  // until a reload. Failures are recorded (push-heal.ts) and surfaced
  // in the Profile diagnostics instead of being swallowed. Re-runs are
  // throttled to one per 60s so focus flapping doesn't spam the server.
  useEffect(() => {
    let alive = true;
    let healing = false;
    let lastRun = 0;
    const runHeal = async () => {
      // Audit-2 M1: SESSION GATE — the heal calls authed server fns
      // (checkEndpoint / savePush). Logged out (or while auth is still
      // loading) it must not run at all: the old code fired them for
      // anonymous visitors on / and /login, and the auth rejection
      // got recorded as a push-heal failure that haunted the next
      // login's Profile diagnostics. Gated BEFORE the throttle so a
      // logged-out run never consumes a heal slot.
      if (!session?.user) return;
      if (healing) return;
      if (Date.now() - lastRun < 60_000) return;
      healing = true;
      try {
        if (!isNotificationsEnabled() || !pushSupported()) {
          clearPushHealFailure();
          return;
        }
        if (Notification.permission !== "granted") return;
        // Audit-2 L78: lastRun is stamped only once the heal actually
        // proceeds past the no-op early returns — the old code
        // stamped it before them, so a notifications-OFF page visit
        // consumed the 60s heal slot and the next real run (toggle
        // ON within 60s) was throttled away.
        lastRun = Date.now();
        // Audit-4 L29: bounded wait for the SW registration (see
        // serviceWorkerReady) — a hung `ready` used to stick here
        // with healing=true forever and no failure recorded. The
        // timeout rejects into the catch below (failure recorded,
        // finally resets healing).
        const reg = await serviceWorkerReady();
        const sub = await reg.pushManager.getSubscription();
        // Audit-2 M72: staleness is judged against the SERVER key.
        const effectiveKey = await resolveVapidPublicKey(() => getVapidKey());
        if (!sub || pushSubscriptionVapidStale(sub, effectiveKey)) {
          // Browser lost it — or it was created under a rotated-out
          // VAPID key (M38: every send would 401/403). Resubscribe
          // and save (subscribeToPush drops a stale sub first).
          // Audit-4 M17: subscribeToPush returns null (no VAPID key
          // / empty keys) WITHOUT throwing — the old code fell
          // through to clearPushHealFailure() and diagnostics went
          // green while push was still broken. A null return is a
          // failed heal: record it and return (do NOT clear).
          if (alive) {
            const repaired = await subscribeToPush((s: PushKeys) => savePush({ data: s }), () => getVapidKey());
            if (!repaired) {
              recordPushHealFailure(
                "Push repair failed — no subscription created (server push keys missing or subscription keys empty).",
              );
              return;
            }
          }
        } else {
          // Browser has it — make sure the server does too.
          const { registered } = await checkEndpoint({
            data: { endpoint: sub.endpoint },
          });
          if (!registered && alive) {
            const json = sub.toJSON();
            // Audit-4 L30: guard the re-save like subscribeToPush
            // does — an empty p256dh/auth fails the server Zod
            // refinements, throws, and was recorded as a heal
            // failure on every 60s cycle. A keyless subscription
            // can't be re-saved; record it (don't clear) so
            // diagnostics name the cause instead of retrying
            // forever. Repair = toggle notifications off and on
            // (drops the keyless sub, subscribes fresh).
            const p256dh = json.keys?.p256dh ?? "";
            const auth = json.keys?.auth ?? "";
            if (!p256dh || !auth) {
              recordPushHealFailure(
                "Push repair failed — this browser's subscription has no encryption keys. Turn notifications off and on again to create a fresh subscription.",
              );
              return;
            }
            await savePush({
              data: {
                endpoint: sub.endpoint,
                p256dh,
                auth,
              },
            });
          }
        }
        if (alive) clearPushHealFailure();
      } catch (err) {
        // M99: no longer swallowed — Profile diagnostics show it.
        // Audit-2 M1: AUTH errors are not push failures — a session
        // that expired mid-heal must not be recorded as "Push repair
        // failed" (the SIGNED_OUT handler clears the record instead).
        if (alive) {
          const msg = err instanceof Error ? err.message : "Push repair failed";
          const isAuthError =
            /unauthenticated|not authenticated|unauthorized|jwt|session expired|no session|missing.*token/i.test(msg);
          if (!isAuthError) {
            recordPushHealFailure(msg);
          }
        }
      } finally {
        healing = false;
      }
    };
    void runHeal();
    const onVisible = () => {
      if (document.visibilityState === "visible") void runHeal();
    };
    const onFocus = () => {
      void runHeal();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [savePush, checkEndpoint, session]);
  return null;
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  // Audit-2 H5: scope the React Query cache to one USER (see
  // handleAuthEventForCache). clear() runs synchronously inside this
  // callback, before the next paint / redirect lands.
  const lastUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // Audit-3 A2-N10: PASSWORD_RECOVERY also swaps the session (a
      // recovery link for a different user) — it must clear the cache
      // like SIGNED_IN does (see handleAuthEventForCache).
      if (
        event !== "SIGNED_IN" &&
        event !== "SIGNED_OUT" &&
        event !== "USER_UPDATED" &&
        event !== "PASSWORD_RECOVERY"
      )
        return;
      // Audit-2 M1: a heal failure recorded while logged out is an
      // AUTH failure, not a push failure — clear it on sign-out so
      // the next login's Profile diagnostics don't show a stale
      // "Push repair failed" for a session that no longer exists.
      if (event === "SIGNED_OUT") clearPushHealFailure();
      lastUserIdRef.current = handleAuthEventForCache(event, session, queryClient, lastUserIdRef.current);
      router.invalidate();
    });
    return () => subscription.unsubscribe();
  }, [router, queryClient]);

  // Register the push service worker once (drives background notifications).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    let updateCleanup: (() => void) | undefined;
    // M75: update flow. The old code was fire-and-forget — an open tab
    // could run a stale SW + stale app shell forever with no user-
    // visible update path. Now: check on mount + hourly + on tab
    // return, and when an UPDATE installs, prompt for a reload.
    // (No auto-reload: the user may have a half-typed message.)
    const promptReload = () => {
      // Audit-2 M58: stable id — without it, every update fired a
      // NEW infinite toast (they stacked; only the Reload button
      // dismisses them). Sonner replaces the toast with the same id.
      toast("A new version of VibeTalk is available.", {
        id: "sw-update",
        description: "Reload to pick up the latest fixes.",
        duration: Infinity,
        action: {
          label: "Reload",
          onClick: () => window.location.reload(),
        },
      });
    };
    void navigator.serviceWorker
      // Audit-2 M58: updateViaCache "none" — the SW script (and its
      // imports) must bypass the HTTP cache on update checks, or a
      // cached sw.js can keep serving for hours despite the hourly
      // registration.update(). (public/_headers + vercel.json also
      // send Cache-Control: no-cache for /sw.js, covering the
      // initial registration fetch, which DOES use the HTTP cache.)
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        if (cancelled) return;
        // Audit-3 A3-03: a worker already WAITING when this tab
        // registers (installed by another tab moments earlier) never
        // fires onupdatefound here — prompt immediately instead of
        // waiting for the next update cycle.
        if (registration.waiting && navigator.serviceWorker.controller) {
          promptReload();
        }
        const checkForUpdate = () => {
          registration.update().catch(() => {
            // Offline or unreachable — next check will retry.
          });
        };
        // onupdatefound fires on first install too; only prompt when
        // a controller already exists (i.e. this IS an update).
        registration.onupdatefound = () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.onstatechange = () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              promptReload();
            }
          };
        };
        // The SW skipWaiting()s + claims, so a waiting worker takes
        // over on the next navigation; check eagerly instead.
        checkForUpdate();
        const hourly = window.setInterval(checkForUpdate, 60 * 60 * 1000);
        const onVisible = () => {
          if (document.visibilityState === "visible") checkForUpdate();
        };
        document.addEventListener("visibilitychange", onVisible);
        updateCleanup = () => {
          window.clearInterval(hourly);
          document.removeEventListener("visibilitychange", onVisible);
        };
      })
      .catch((err) => {
        // Service worker unavailable (e.g. unsupported browser); in-app
        // notifications still work while the tab is open.
        console.warn("[sw] registration failed:", err);
      });
    return () => {
      cancelled = true;
      updateCleanup?.();
    };
  }, []);

  // Push effects live in <PushEffects /> below (inside <AuthProvider>).




  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <PushEffects />
        <Outlet />
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
