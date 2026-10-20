/** Browser-side Web Push subscription helpers. */

export type PushKeys = { endpoint: string; p256dh: string; auth: string };

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Audit-4 L29: `navigator.serviceWorker.ready` can hang forever
 * (a wedged SW registration) — every awaiter used to stick with
 * no timeout, no error, no recovery. The heal set healing=true
 * before awaiting it, so one hung `ready` blocked every later
 * heal for the session with no failure recorded. Race it
 * against a timeout; on timeout REJECT so callers take their
 * normal failure path (heal records + resets healing;
 * unsubscribe throws so the toggle doesn't claim OFF;
 * currentPushEndpoint returns null via its catch). 10s is
 * generous for a slow device's SW install, but bounds the hang.
 */
const SW_READY_TIMEOUT_MS = 10_000;
export function serviceWorkerReady(timeoutMs: number = SW_READY_TIMEOUT_MS): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Service worker registration timed out — the service worker did not become ready.")),
      timeoutMs,
    );
  });
  return Promise.race([navigator.serviceWorker.ready, timeout]).finally(() => clearTimeout(timer));
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * M38: is this browser subscription stale w.r.t. the CURRENT VAPID key?
 * After a VAPID key rotation, a subscription created under the old key
 * fails every send with 401/403 — and the old subscribeToPush reused
 * it blindly (`existing ?? subscribe(...)`), so push silently died
 * for that browser until the user toggled. Compare the subscription's
 * recorded applicationServerKey against the current env key. Fail
 * open (not stale) when either side is unavailable.
 */
export function pushSubscriptionVapidStale(
  sub: PushSubscription,
  vapidKey?: string | null,
): boolean {
  try {
    // Audit-2 M72: compare against the EFFECTIVE key (server key when
    // resolveVapidPublicKey provided one) — the VITE_ var is only the
    // fallback. Callers that resolved the key pass it in.
    // Audit-2 L68: the key is trimmed first — a copied key with a
    // trailing newline/space is a DIFFERENT key to urlBase64 decode
    // and would have flagged every subscription stale. An empty
    // key after trim means "unavailable" (fail open); a non-empty
    // key that fails to parse is FAIL-VISIBLE (stale) with a warn —
    // the old catch swallowed it as "not stale" and push died
    // silently on a malformed key.
    const rawKey = vapidKey ?? (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined);
    const key = rawKey?.trim();
    if (!key) return false;
    const recorded = sub.options?.applicationServerKey as ArrayBuffer | null | undefined;
    if (!recorded) return false;
    const expected = urlBase64ToUint8Array(key);
    const actual = new Uint8Array(recorded);
    if (actual.length !== expected.length) return true;
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) return true;
    }
    return false;
  } catch (err) {
    console.warn("[push] could not compare subscription VAPID key — treating as stale:", err);
    return true;
  }
}
/**
 * Audit-2 M72: resolve the VAPID public key the client must subscribe
 * with. The SERVER key (via getVapidPublicKey) is authoritative —
 * subscribing with it makes drift impossible by construction. The
 * VITE_ var is only a fallback when the server fn is unavailable
 * (pre-deploy, network error) or the server has no key configured.
 * The server key is fetched at most once per page load (a rotation
 * mid-session is picked up on the next load). A failed fetch is NOT
 * cached — the next call retries.
 */
let cachedServerVapidKey: string | null | undefined;
export async function resolveVapidPublicKey(
  getServerVapidKey?: () => Promise<{ publicKey?: string | null } | null>,
): Promise<string | null> {
  // Audit-4 L23: an empty/whitespace-only key is NOT a key — the
  // old `??` kept "" as a real value, bypassing the fallback and
  // caching "" for the page load (subscribeToPush then returned
  // null even though a valid fallback key existed). Normalize to
  // null on both sides so the fallback actually applies.
  const rawFallback = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  const fallback = rawFallback && rawFallback.trim() !== "" ? rawFallback.trim() : null;
  if (!getServerVapidKey) return fallback;
  if (cachedServerVapidKey !== undefined) return cachedServerVapidKey ?? fallback;
  try {
    const res = await getServerVapidKey();
    const raw = res?.publicKey;
    const serverKey = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
    cachedServerVapidKey = serverKey;
    return serverKey ?? fallback;
  } catch (err) {
    console.warn("[push] could not fetch the server VAPID key, falling back to the bundled key:", err);
    return fallback;
  }
}

export async function subscribeToPush(
  save: (sub: PushKeys) => Promise<unknown>,
  getServerVapidKey?: () => Promise<{ publicKey?: string | null } | null>,
): Promise<PushKeys | null> {
  if (!pushSupported()) return null;
  if (Notification.permission === "denied") return null;
  // Audit-2 M72: subscribe with the SERVER key (see
  // resolveVapidPublicKey) — never with a possibly-drifted copy.
  const vapidKey = await resolveVapidPublicKey(getServerVapidKey);
  // Audit-2 L97: a missing VAPID key used to fail silently here
  // (subscribeToPush returned null, toggle did nothing). Diagnostics
  // already show "Server push keys not configured" — log it too so
  // a console trace explains the dead toggle.
  if (!vapidKey) {
    console.warn("[push] no VAPID public key available — push subscription skipped (server keys not configured).");
    return null;
  }
  // Audit-4 L29: bounded wait for the SW registration (see
  // serviceWorkerReady) — a hung `ready` used to stick here.
  const reg = await serviceWorkerReady();
  const existing = await reg.pushManager.getSubscription();
  // M38: a subscription created under a rotated-out VAPID key fails
  // every send with 401/403 — drop it and subscribe fresh instead of
  // reusing it blindly.
  const stale = existing ? pushSubscriptionVapidStale(existing, vapidKey) : false;
  if (existing && stale) {
    try {
      await existing.unsubscribe();
    } catch {
      // best-effort — the fresh subscribe below replaces it
    }
  }
  const sub =
    existing && !stale
      ? existing
      : await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey) as unknown as ArrayBuffer,
        });
  const json = sub.toJSON();
  const keys: PushKeys = {
    endpoint: sub.endpoint,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
  };
  if (!keys.p256dh || !keys.auth) return null;
  await save(keys);
  return keys;
}

/**
 * Remove THIS browser's push subscription (server row + browser subscription).
 * M31: the old version swallowed the server-delete failure
 * (`remove(endpoint).catch(() => undefined)`) and the outer catch
 * swallowed everything else — so a failed delete left the
 * push_subscriptions row alive, the OFF flag was already false (so the
 * __root self-heal never repaired it), and the server kept pushing to
 * a browser whose user had turned notifications OFF. Now the delete
 * is retried + VERIFIED via `check`, and a failure THROWS so the
 * caller can surface it and must not claim OFF.
 * Audit-4 H3: the old !sub branch called removeAll() — deleting EVERY
 * push row for the user — whenever this browser had no live
 * subscription. Toggling notifications OFF on a phone with no live
 * sub silently killed desktop push while the UI said only this
 * device was off. Now the !sub branch removes NOTHING: without a
 * live subscription there is no device-scoped endpoint to remove,
 * and a stale row for a dead endpoint is self-cleaning (the push
 * service 404/410s it and the server deletes it). removeAll lives
 * ONLY in the explicit sign-out-everywhere path (auth-context),
 * never in a per-device toggle.
 * Audit-4 L22: the old !pushSupported() branch returned SILENTLY
 * (success without removing or verifying anything) and the
 * toggles claimed OFF. Now it THROWS — this fn's contract is
 * "throws unless the removal is verified", and a caller that
 * forgets the pushSupported() guard must fail loudly, not claim
 * OFF. The toggles guard the call themselves (a browser that
 * never supported push has no row to remove — the toggle skips
 * the call and claims OFF for the local/in-tab part only).
 * Residual: a row orphaned by push support flipping true→false
 * after enrollment can't be enumerated (no endpoint) — it
 * self-cleans via 404/410 on first delivery, per H3 above.
 */
export async function unsubscribeFromPush(
  remove: (endpoint: string) => Promise<unknown>,
  check?: (endpoint: string) => Promise<{ registered: boolean }>,
): Promise<void> {
  // Audit-4 L22: no silent success — without push support there
  // is no endpoint to remove or verify. Callers guard with
  // pushSupported() (toggles do); this throw is for a caller
  // that forgets the guard.
  if (!pushSupported())
    throw new Error("Push is not supported in this browser — the subscription could not be removed or verified.");
  // Audit-4 L29: bounded wait (see serviceWorkerReady) — a
  // hung `ready` used to stick here with no error.
  const reg = await serviceWorkerReady();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) {
    // No live subscription — nothing device-scoped to remove (H3).
    return;
  }
  const endpoint = sub.endpoint;
  // Delete the server row (retry once), then VERIFY it's gone. A
  // successful delete call does NOT prove the row is gone (an
  // RLS-filtered delete affects 0 rows without erroring) — only the
  // check proves it.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await remove(endpoint);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (lastErr) throw lastErr;
  if (check) {
    const { registered } = await check(endpoint);
    if (registered) {
      // Row survived the delete (RLS / race) — don't claim OFF.
      throw new Error("Push subscription could not be removed — please try again.");
    }
  }
  // Browser-side unsubscribe is best-effort: the server row is gone,
  // so no push will be sent to this endpoint either way.
  try {
    await sub.unsubscribe();
  } catch {
    /* best-effort */
  }
}

/** The endpoint of this browser's current push subscription, if any. */
export async function currentPushEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  try {
    // Audit-4 L29: bounded wait (see serviceWorkerReady) — a
    // hung `ready` used to stick here; the catch returns null.
    const reg = await serviceWorkerReady();
    const sub = await reg.pushManager.getSubscription();
    return sub ? sub.endpoint : null;
  } catch {
    return null;
  }
}
