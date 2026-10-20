/* VibeTalk service worker: Web Push notifications + tap-to-open. */

// Take over immediately on update: without skipWaiting + claim, an old SW
// keeps controlling open tabs (and would render call pushes as plain,
// action-less message notifications) until every tab is closed.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// M37: the browser rotates push subscriptions (expiry / key rotation).
// Without this handler the server keeps the old endpoint and pushes
// fail until the user reopens the app (the __root self-heal only runs
// on mount). Re-subscribe here, hand the new keys to an open tab so it
// can save them immediately, and fall back to a "changed" signal (the
// next app-open self-heal re-subscribes + saves) if the VAPID key
// isn't available to the SW yet.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function swIdbGet(key) {
  return new Promise((resolve) => {
    try {
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
          const tx = req.result.transaction("config", "readonly");
          const get = tx.objectStore("config").get(key);
          get.onsuccess = () => resolve(get.result ?? null);
          get.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Audit-5 LOW-7: write/delete companion to swIdbGet (same DB +
// "config" store). Passing undefined deletes the key. Never
// rejects — callers treat storage as best-effort, like swIdbGet.
function swIdbWrite(key, value) {
  return new Promise((resolve) => {
    try {
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
          const store = req.result.transaction("config", "readwrite").objectStore("config");
          const op = value === undefined ? store.delete(key) : store.put(value, key);
          op.onsuccess = () => resolve();
          op.onerror = () => resolve();
        } catch {
          resolve();
        }
      };
      req.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Audit-4 L27: per-tag serialization for grouped notifications.
// Two concurrent pushes used to both getNotifications({tag})
// before either showNotification ran — both computed count = 1
// and the second replaced the first, losing the "2 new messages"
// aggregation. Chaining each tag's count+show on the previous
// one makes the second push see the first's notification.
// Per-tag (not global): different rooms don't block each other.
// The returned promise never rejects (a failed show must not
// poison the chain — the caller logs it itself). Entries are
// deleted once settled so the Map doesn't grow one entry per
// room tag for the SW's lifetime.
const groupShowQueue = new Map();
function showGroupedNotification(tag, show) {
  const prev = groupShowQueue.get(tag) || Promise.resolve();
  const next = prev.then(show, show).catch(() => {});
  groupShowQueue.set(tag, next);
  next.then(() => {
    if (groupShowQueue.get(tag) === next) groupShowQueue.delete(tag);
  });
  return next;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      // Re-subscribe so the browser holds a fresh subscription (the
      // __root self-heal saves it on the next app open).
      try {
        const vapidKey = await swIdbGet("vapidPublicKey");
        if (vapidKey) {
          await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidKey),
          });
        }
      } catch {
        // fall through — notify open clients to re-subscribe
      }
      // Audit-2 H24: post ONLY a "changed" signal — never the new
      // keys. The SW cannot verify the IDB VAPID key is still current
      // (Audit-2 M72: it is the SERVER key, stashed by PushEffects at
      // login; after a rotation with no login since, the IDB key is
      // STALE), so a re-subscribe under it produces a stale-key
      // subscription the tab must NOT save blindly. The tab
      // re-derives the live subscription and runs the
      // VAPID-staleness check (subscribeToPush) before saving.
      // If no tab is open, the re-subscription above means the next
      // app-open self-heal saves the fresh subscription.
      try {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of clients) {
          try {
            client.postMessage({ type: "vibetalk-push-subscription-changed" });
          } catch {
            // try the next client
          }
        }
      } catch {
        // no clients — the next app-open self-heal handles it
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  // Audit-3 A7-L21: an empty / malformed / non-object payload used to
  // fall through to a phantom "New message" notification
  // (a push with no payload is not a message — drop it silently).
  // Audit-4 L36: the old drop condition (no keys at all) still
  // let a 1-key payload like {tag:"x"} fall through to a phantom
  // "VibeTalk / New message" notification — a payload with
  // nothing to say. Now a payload must carry a title or a body
  // to show at all (the server always sends both; a title-only
  // or body-only payload still shows with the other defaulted).
  // Forging one needs the VAPID private key, but a phantom from
  // a malformed/legacy push is still noise.
  if (!data || typeof data !== "object" || Array.isArray(data) || (!data.title && !data.body)) {
    return;
  }
  const title = data.title || "VibeTalk";
  const body = data.body || "New message";
  const tag = data.tag || "hcroom-msg";
  const roomId = data.roomId || null;

  event.waitUntil(
    (async () => {
      // If the user is actively looking at the app, stay silent — the open
      // page shows its own in-app notification instead. Test pushes are
      // exempt: they exist to prove delivery while the user is watching.
      // Calls follow the same rule: a visible tab already shows the ringing
      // overlay + plays the ringtone, so no duplicate system notification.
      // H40: suppress ONLY when a visible client is inside the authed app
      // (/rooms, /people, /calls, /profile — the _app layout where
      // MessageNotifier/CallProvider mount). A visible /, /login, /join,
      // or any other non-app page has no in-app notifier, so a push
      // there must still show a system notification — otherwise the
      // message/call is silently lost.
      try {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        const inApp = (c) => {
          try {
            const pathname = new URL(c.url).pathname;
            return /^\/(rooms|people|calls|profile)(\/|$)/.test(pathname);
          } catch {
            return false;
          }
        };
        if (
          tag !== "hcroom-test" &&
          clients.some((c) => c.visibilityState === "visible" && inApp(c))
        )
          return;
      } catch {
        // fall through and show the notification
      }

      // Incoming call: Pick / Reject actions, vibration, NOT silent, and
      // requireInteraction so it stays up while the phone rings.
      // Audit-2 L67: showNotification can throw (invalid actions /
      // payload) — a thrown call notification means NO ring at all.
      // Retry without actions so the call still rings.
      if (data.kind === "incoming-call") {
        const callOptions = {
          body,
          tag: data.tag || `hcroom-call-${data.callId || "unknown"}`,
          renotify: true,
          requireInteraction: true,
          silent: false,
          vibrate: Array.isArray(data.vibrate) ? data.vibrate : [200, 100, 200, 100, 200, 100, 400],
          actions: Array.isArray(data.actions) ? data.actions : [],
          icon: "/favicon.ico",
          badge: "/favicon.ico",
          data: {
            kind: "incoming-call",
            callId: data.callId || null,
            from: data.from || null,
            fromName: data.fromName || null,
            callType: data.callType || "voice",
          },
        };
        try {
          await self.registration.showNotification(title, callOptions);
        } catch (err) {
          console.warn("[sw] showNotification with actions failed, retrying without actions:", err);
          const { actions, ...noActions } = callOptions;
          // Audit-4 L37: the retry itself was UNGUARDED — if it
          // also threw, waitUntil rejected and there was no ring
          // at all. Guard it, and degrade once more to a minimal
          // notification (no vibrate/icon/badge — a bad vibrate
          // pattern or icon from the payload was the likely
          // second failure) so the call still rings. `data` is
          // KEPT so a body tap still routes to the call
          // (notificationclick reads data.callId); there are no
          // Pick/Reject actions on the minimal notification.
          try {
            await self.registration.showNotification(title, noActions);
          } catch (err2) {
            console.warn("[sw] showNotification without actions failed, retrying minimal:", err2);
            try {
              await self.registration.showNotification(title, {
                body,
                tag: callOptions.tag,
                renotify: true,
                requireInteraction: true,
                silent: false,
                data: callOptions.data,
              });
            } catch (err3) {
              // Audit-2 L67: a thrown call notification means NO
              // ring — log it (the Realtime invite is the
              // remaining path; the in-app overlay rings when a
              // tab is open). waitUntil must NOT reject.
              console.warn("[sw] minimal call notification failed — no ring:", err3);
            }
          }
        }
        return;
      }
      // Group by chat: count how many undismissed notifications this chat
      // already has, so the user sees "3 new messages" instead of one ping
      // replacing another silently. Audit-3 A7-L20: test pushes are
      // exempt — a second undismissed test push must show its own test
      // body, not a rewritten "2 new messages".
      // Audit-4 L27: run the count+show through the per-tag queue
      // (see showGroupedNotification) — without it, two concurrent
      // pushes both count 1 and the second replaces the first.
      await showGroupedNotification(tag, async () => {
        // Audit-5 LOW-7 (closes audit-4 L27's PARTIAL): the old
        // count came from getNotifications({tag}) — but a same-tag
        // showNotification REPLACES the previous one, so the list
        // holds at most 1 entry per tag and the count could never
        // exceed 2 (3 pushes read ["m", "2 new messages",
        // "2 new messages"]). Keep the counter in IDB instead —
        // it survives SW restarts and doesn't depend on the
        // notification list. Cleared on click/close (below).
        let count = 1;
        if (tag !== "hcroom-test") {
          try {
            const prev = await swIdbGet("ncount:" + tag);
            count = (typeof prev === "number" && prev > 0 ? prev : 0) + 1;
            if (count > 99) count = 99;
            await swIdbWrite("ncount:" + tag, count);
          } catch {
            count = 1;
          }
        }
        const displayBody = count > 1 ? `${count} new messages` : body;
        // Audit-2 L67: a thrown showNotification drops the message
        // silently — log it (the push still counted as delivered).
        try {
          await self.registration.showNotification(title, {
            body: displayBody,
            tag,
            renotify: true,
            // Chat notifications vibrate + sound like a normal chat app; the
            // OS default alone came through silent on some phones.
            vibrate: [200, 100, 200],
            silent: false,
            icon: "/favicon.ico",
            badge: "/favicon.ico",
            data: { roomId },
          });
        } catch (err) {
          console.warn("[sw] showNotification failed:", err);
        }
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Audit-5 LOW-7: the tap opens the chat — clear this tag's
  // message counter so the next push counts from 1 again.
  event.waitUntil(swIdbWrite("ncount:" + (event.notification.tag || ""), undefined));
  const data = event.notification.data || {};

  // Incoming call: Pick / Reject (or a plain tap = just bring the app up).
  if (data.kind === "incoming-call") {
    const action = event.action; // "accept" | "decline" | "" (body tap)
    const callId = data.callId || "";
    event.waitUntil(
      (async () => {
        // M22: only hand the tap to a client INSIDE the app (where
        // CallProvider + the SW message listener mount). The old code
        // posted to clients[0], which could be the landing page or
        // /login — no listener there, so the tap was consumed and lost,
        // and the SW never tried the next client. Prefer the focused
        // app tab (the one the user is looking at); otherwise the
        // first app tab. If no app tab exists, fall through to
        // openWindow with ?call=... (C3).
        const isAppClient = (c) => {
          try {
            const p = new URL(c.url).pathname;
            return /^\/(rooms|people|calls|profile)(\/|$)/.test(p);
          } catch {
            return false;
          }
        };
        try {
          const clients = await self.clients.matchAll({
            type: "window",
            includeUncontrolled: true,
          });
          const appClients = clients.filter(isAppClient);
          const target = appClients.find((c) => c.focused) || appClients[0];
          if (target) {
            try {
              // A live tab already has (or can fetch) the ringing state —
              // hand the tap to it instead of reloading.
              // M21: a PLAIN tap (body, no action) must also post a
              // message — the old code only focused, so a tab that
              // missed the Realtime invite never recovered (the
              // pending-invite effect runs only on mount). The recover
              // message makes the tab re-check pending invites.
              const payload =
                action === "accept" || action === "decline"
                  ? {
                      type: "vibetalk-call-action",
                      action,
                      callId,
                      from: data.from || null,
                      callType: data.callType || "voice",
                    }
                  : {
                      type: "vibetalk-call-recover",
                      callId,
                      from: data.from || null,
                      callType: data.callType || "voice",
                    };
              // Audit-2 M57: postMessage is fire-and-forget — a tab
              // that is still loading (CallProvider not mounted yet)
              // loses the message with NO error, and the SW never
              // fell back. Ask for an ack over a MessageChannel port;
              // the client acks as soon as its listener is mounted.
              // No ack in 1500ms → the tab is still loading (or its
              // listener is gone): navigate it to the ?call= URL so
              // the tap's intent survives — the ?call= effect runs on
              // mount. A plain tap reloads the tab in place instead
              // (mount recovery re-checks pending invites; yanking
              // the tab to /rooms would drop its conversation view).
              // Race note: if the tab mounts + acts in the same tick
              // the timeout fires, both paths run — benign: the
              // ?call= handler for an already-accepted same-callId
              // tap just toasts "Already in a call.", and a declined
              // one finds the invite already terminal.
              const acked = await new Promise((resolve) => {
                let settled = false;
                const timer = setTimeout(() => {
                  if (!settled) {
                    settled = true;
                    resolve(false);
                  }
                }, 1500);
                const mc = new MessageChannel();
                mc.port1.onmessage = () => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  resolve(true);
                };
                try {
                  target.postMessage(payload, [mc.port2]);
                } catch {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  resolve(false);
                }
              });
              try {
                await target.focus();
              } catch {
                // focusing is cosmetic; the action still lands
              }
              if (acked) return;
              const fallbackUrl =
                action === "accept" || action === "decline"
                  ? `/rooms?call=${action}&callId=${encodeURIComponent(callId)}&from=${encodeURIComponent(data.from || "")}&callType=${encodeURIComponent(data.callType || "voice")}`
                  : target.url;
              try {
                await target.navigate(fallbackUrl);
                return;
              } catch {
                // fall through to openWindow
              }
            } catch {
              // fall through to openWindow
            }
          }
        } catch {
          // fall through to openWindow
        }
        // No live tab: open the app itself (inside _app, where CallProvider
        // mounts) with the action in the URL so it can reconstruct ringing
        // from the persisted invite and act on it. MUST NOT open "/":
        // the landing page has no CallProvider and no ?call= handling,
        // so the action would silently be lost (audit C3). If the user
        // is logged out, the _app guard redirects to /login?next=... and
        // login sends them back to this URL with params intact.
        const url =
          action === "accept" || action === "decline"
            ? `/rooms?call=${action}&callId=${encodeURIComponent(callId)}&from=${encodeURIComponent(data.from || "")}&callType=${encodeURIComponent(data.callType || "voice")}`
            : "/rooms";
        try {
          await self.clients.openWindow(url);
        } catch {
          // nothing more we can do
        }
      })(),
    );
    return;
  }

  const roomId = data.roomId;
  const url = roomId ? `/rooms/${roomId}` : "/rooms";

  event.waitUntil(
    (async () => {
      try {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        // M34: don't hijack the first tab. A message click used to
        // focus + navigate clients[0] no matter what it was doing
        // (mid-compose, wrong view) — and re-navigating a tab that
        // was ALREADY on the room lost its scroll/composer state.
        // 1. A tab already on the target room — focus only, no
        //    navigation, so its state survives.
        const onRoom = clients.find((c) => {
          try {
            return new URL(c.url).pathname === url;
          } catch {
            return false;
          }
        });
        if (onRoom) {
          try {
            await onRoom.focus();
            // Audit-2 L74: focus alone left the room showing the
            // pre-notification state (the message that triggered the
            // notification wasn't in the list yet). Ask the tab to
            // refresh this room's queries — the app handles it
            // (see __root.tsx SW-message effect).
            // Audit-4 L26: the old postMessage was fire-and-forget
            // (like the pre-M57 call path) — a tab still loading
            // (listener not mounted) lost the refresh with no
            // error. Mirror M57: ask for an ack over a
            // MessageChannel port and reload the tab if none
            // arrives in 1500ms — the reload re-fetches the room,
            // so the refresh intent survives. The tab was still
            // loading, so the reload loses ~no state (drafts
            // live in localStorage/outbox).
            const acked = await new Promise((resolve) => {
              let settled = false;
              const timer = setTimeout(() => {
                if (!settled) {
                  settled = true;
                  resolve(false);
                }
              }, 1500);
              const mc = new MessageChannel();
              mc.port1.onmessage = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(true);
              };
              try {
                onRoom.postMessage({ type: "vibetalk-refresh-room", roomId }, [mc.port2]);
              } catch {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(false);
              }
            });
            if (acked) return;
            // No ack: reload the tab in place.
            await onRoom.navigate(onRoom.url);
            return;
          } catch {
            // fall through
          }
        }
        // 2. A BACKGROUND tab — navigate it (the user isn't looking
        //    at it, and the focused tab's composer state is
        //    preserved). Prefer an app tab; any background tab works
        //    (navigating to /rooms loads the app).
        const isAppTab = (c) => {
          try {
            return /^\/(rooms|people|calls|profile)(\/|$)/.test(new URL(c.url).pathname);
          } catch {
            return false;
          }
        };
        const bg =
          clients.find((c) => !c.focused && isAppTab(c)) || clients.find((c) => !c.focused);
        if (bg) {
          try {
            await bg.focus();
            await bg.navigate(url);
            return;
          } catch {
            // fall through to openWindow
          }
        }
        // 3. Every tab is focused (or on the wrong view) — open a
        //    new window instead of stealing the focused tab.
      } catch {
        // fall through to openWindow
      }
      try {
        await self.clients.openWindow(url);
      } catch {
        // nothing more we can do
      }
    })(),
  );
});

// Audit-5 LOW-7: a dismissed (swiped-away) notification also clears
// its message counter — a dismissal means the user caught up or
// discarded it, so the next push must count from 1 again. The
// existence guard covers browsers that fire close on replacement:
// a replaced notification is immediately followed by a new one
// with the same tag, so the counter is kept.
self.addEventListener("notificationclose", (event) => {
  const tag = event.notification.tag || "";
  event.waitUntil(
    (async () => {
      try {
        const remaining = await self.registration.getNotifications({ tag });
        if (remaining.length === 0) {
          await swIdbWrite("ncount:" + tag, undefined);
        }
      } catch {
        // best-effort
      }
    })(),
  );
});
