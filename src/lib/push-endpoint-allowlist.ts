/**
 * Audit-2 M48: Web Push endpoint + key validation (shared by the save
 * path in push.functions.ts and the send path in
 * webpush-send.server.ts). Pure — no Node APIs, so both server files
 * can import it at top level.
 *
 * Without this, any authenticated user could save an arbitrary
 * endpoint (e.g. a victim's webhook or an internal URL) and the
 * server would POST VAPID-signed requests to it on every message —
 * an SSRF / spam amplifier. The allowlist covers every real browser
 * push service: FCM (Chrome/Edge/Brave/Opera/Samsung), Mozilla
 * (Firefox), Apple (Safari), Microsoft (Edge on Windows/WNS).
 */

/** Exact-match push-service hosts. */
const PUSH_ENDPOINT_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
];

/** Suffix-match push-service domains (bare domain + any subdomain). */
const PUSH_ENDPOINT_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

/** True when the endpoint belongs to a supported push service. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // Audit-6 E-N4: an endpoint with embedded credentials
  // (https://user:pass@host/…) was accepted and stored verbatim.
  // No real push service uses userinfo; reject it rather than
  // persisting someone else's credentials in the subscriptions
  // table (and echoing them in every send).
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (PUSH_ENDPOINT_HOSTS.includes(host)) return true;
  for (const suffix of PUSH_ENDPOINT_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * True when `value` is base64url decoding to exactly `expectedLength`
 * bytes (optionally with `firstByte` as the first byte). `atob` is
 * global in browsers and Node 16+, so no Buffer is needed.
 */
export function isValidBase64UrlBytes(
  value: unknown,
  expectedLength: number,
  firstByte?: number,
): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return false;
  }
  if (binary.length !== expectedLength) return false;
  if (firstByte !== undefined && binary.charCodeAt(0) !== firstByte) return false;
  return true;
}

/** Web Push spec: p256dh is a 65-byte UNCOMPRESSED P-256 point (0x04 prefix). */
export function isValidP256dh(value: unknown): boolean {
  return isValidBase64UrlBytes(value, 65, 0x04);
}

/** Web Push spec: auth is a 16-byte secret. */
export function isValidPushAuth(value: unknown): boolean {
  return isValidBase64UrlBytes(value, 16);
}
