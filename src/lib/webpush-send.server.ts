/**
 * Web Push sender (RFC 8291 "aes128gcm" + VAPID), implemented on WebCrypto so
 * it runs inside Cloudflare Workers (no Node http/tls needed).
 *
 * The crypto core was verified against the reference `http_ece` implementation:
 * our ciphertext decrypts correctly with it, and our VAPID JWT verifies.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAllowedPushEndpoint } from "@/lib/push-endpoint-allowlist";
import { NOTIFICATION_PREVIEW_HIDDEN } from "@/lib/notifications";

/**
 * Audit-2 M73: config errors must NOT be swallowed like delivery
 * failures. A missing SUPABASE_SERVICE_ROLE_KEY (or VAPID key) breaks
 * EVERY push, forever — and notifyNewMessage used to return silently,
 * so the message sent fine while push never fired. Log loudly, but
 * throttled: without dedup, every message would spam the same line.
 * Audit-4 L39: the old once-per-process dedup meant a RECURRING
 * break of the same kind was never logged again (keys break ->
 * fixed -> break again -> silence). Throttle instead: a repeat
 * logs again after the cooldown, so a recurring break re-appears
 * in the logs within at most an hour, while a continuous break
 * doesn't spam. Delivery failures (per-subscription 4xx/5xx/network)
 * are still swallowed by design — push must never break sending.
 */
const PUSH_CONFIG_ERROR_LOG_COOLDOWN_MS = 3_600_000;
const lastPushConfigErrorLog = new Map<string, number>();
function logPushConfigErrorThrottled(message: string): void {
  const now = Date.now();
  const last = lastPushConfigErrorLog.get(message);
  if (last !== undefined && now - last < PUSH_CONFIG_ERROR_LOG_COOLDOWN_MS) return;
  lastPushConfigErrorLog.set(message, now);
  console.error(`[push] CONFIG ERROR — ${message}`);
}

/**
 * M72: single source for the VAPID subject (sender-contact URL, the
 * `sub` claim). Was a hardcoded Cloudflare origin triplicated at 3 call
 * sites, so Vercel-sent pushes misidentified their origin and one edit
 * left the other two drifting. Set VAPID_SUBJECT per host; default is
 * the Cloudflare origin (Vercel: https://vibetalk-one.vercel.app).
 */
export function vapidSubject(): string {
  // Audit-3 A3-N12: warn once per process when the default is in use —
  // the default is correct for Cloudflare and wrong for Vercel, and a
  // missing Vercel var previously failed silently (misidentified `sub`).
  if (!process.env.VAPID_SUBJECT && !vapidSubjectWarned) {
    vapidSubjectWarned = true;
    console.warn(
      "[push] VAPID_SUBJECT unset — defaulting to the Cloudflare origin. " +
        "On Vercel set VAPID_SUBJECT=https://vibetalk-one.vercel.app.",
    );
  }
  return process.env.VAPID_SUBJECT || "https://hc.hcroom.workers.dev";
}

const te = new TextEncoder();

// Audit-3 A3-N12: one-time flag for the unset-VAPID_SUBJECT warning.
let vapidSubjectWarned = false;

export type PushSubscriptionJSON = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

function b64urlEncode(bytes: Uint8Array<ArrayBuffer>): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmacSha256(
  keyBytes: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

async function hkdfExtract(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  // HKDF-Extract(salt, IKM) = HMAC-SHA-256(key=salt, data=IKM)
  return hmacSha256(salt, ikm);
}

async function hkdfExpand(
  prk: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  len: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(len);
  let t = new Uint8Array(0);
  let pos = 0;
  let counter = 1;
  while (pos < len) {
    const data = new Uint8Array(t.length + info.length + 1);
    data.set(t, 0);
    data.set(info, t.length);
    data[data.length - 1] = counter;
    t = await hmacSha256(prk, data);
    const take = Math.min(t.length, len - pos);
    out.set(t.subarray(0, take), pos);
    pos += take;
    counter++;
  }
  return out;
}

/** Encrypt a push payload per RFC 8291 (content encoding "aes128gcm"). */
/**
 * Audit-4 L33: the subscription's stored keys are provably
 * corrupt (bad base64, wrong length, or a point not on P-256).
 * The subscription can NEVER receive a push, so sendWebPush
 * maps this — and ONLY this — to synthetic 410 ("gone") for
 * the callers' 404/410 cleanup. Any OTHER throw from
 * encryptPush (a transient WebCrypto failure in generateKey /
 * deriveBits / encrypt) propagates as-is and must NOT delete a
 * healthy subscription.
 */
export class InvalidSubscriptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSubscriptionKeyError";
  }
}

export async function encryptPush(
  sub: PushSubscriptionJSON,
  plaintext: string,
): Promise<{
  body: Uint8Array<ArrayBuffer>;
  localPublicKey: Uint8Array<ArrayBuffer>;
  salt: Uint8Array<ArrayBuffer>;
}> {
  // Audit-4 L33: the decode + length checks are pure functions
  // of the stored keys — a failure here is deterministic key
  // corruption, never transient. Each key is decoded separately
  // so the error names the bad one.
  let subPub: Uint8Array<ArrayBuffer>;
  try {
    subPub = b64urlDecode(sub.p256dh);
  } catch (err) {
    throw new InvalidSubscriptionKeyError(
      `p256dh is not valid base64url: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let authSecret: Uint8Array<ArrayBuffer>;
  try {
    authSecret = b64urlDecode(sub.auth);
  } catch (err) {
    throw new InvalidSubscriptionKeyError(
      `auth is not valid base64url: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (subPub.length !== 65) throw new InvalidSubscriptionKeyError("p256dh must be 65 bytes");
  // Audit-4 M13: the auth secret must be 16 bytes (RFC 8291 §3.3).
  // A wrong-length auth used to "encrypt successfully" (HKDF
  // accepts any-length inputs) into a ciphertext no browser could
  // ever decrypt — silently lost, no throw, so sendWebPush's M56
  // synthetic-410 cleanup never fired and the corrupt row was
  // retried on every message forever. Now it throws like a bad
  // p256dh, and the row gets deleted as gone.
  if (authSecret.length !== 16) throw new InvalidSubscriptionKeyError("auth must be 16 bytes");

  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  // Audit-4 L33: importKey of a 65-byte raw point fails with
  // DataError ONLY when the point is not on P-256 (corrupt key).
  // Any other failure (OperationError, …) is transient — re-throw
  // it so sendWebPush does NOT map it to 410 and delete a
  // healthy subscription.
  let remoteKey: CryptoKey;
  try {
    remoteKey = await crypto.subtle.importKey(
      "raw",
      subPub,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "DataError") {
      throw new InvalidSubscriptionKeyError("p256dh is not a valid P-256 point");
    }
    throw err;
  }
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: remoteKey }, eph.privateKey, 256),
  );

  const info = concat(te.encode("WebPush: info\0"), subPub, ephPub);
  const secret = await hkdfExpand(await hkdfExtract(authSecret, ecdh), info, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, secret);
  const cek = await hkdfExpand(prk, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, te.encode("Content-Encoding: nonce\0"), 12);

  // Single record: plaintext || 0x02 padding delimiter, then AES-128-GCM.
  const pt = concat(te.encode(plaintext), new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, pt),
  );

  // Record header: salt(16) || rs=uint32be(4096) || idlen=uint8(65) || ephemeral pubkey(65)
  const header = new Uint8Array(21);
  header.set(salt, 0);
  header[16] = 0x00;
  header[17] = 0x00;
  header[18] = 0x10;
  header[19] = 0x00;
  header[20] = 65;
  return { body: concat(header, ephPub, ct), localPublicKey: ephPub, salt };
}

function derToRaw(der: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  // SEQUENCE { INTEGER r, INTEGER s }
  const lenByte = der[1];
  let o = lenByte < 0x80 ? 2 : lenByte === 0x81 ? 3 : 4;
  const takeInt = (): Uint8Array<ArrayBuffer> => {
    if (der[o++] !== 0x02) throw new Error("bad DER integer tag");
    let len = der[o++];
    if (len === 0x81) len = der[o++];
    else if (len === 0x82) len = (der[o++] << 8) | der[o++];
    let v = der.subarray(o, o + len);
    o += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error("bad DER integer length");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  return concat(takeInt(), takeInt());
}

/**
 * Normalize an ECDSA P-256 signature to raw 64-byte R||S.
 * Node's WebCrypto already returns raw; browsers/Workers return DER.
 */
function ecdsaSigToRaw(sig: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  // DER for P-256 is always 70-72 bytes; 64 bytes can only be raw R||S.
  if (sig.length === 64) return sig;
  return derToRaw(sig);
}

/** Build the `Authorization` header value for a VAPID-authenticated push. */
export async function vapidAuthHeader(
  audience: string,
  vapidPublicKeyB64: string,
  vapidPrivateKeyB64: string,
  subject: string,
): Promise<string> {
  // Audit-2 M73: a malformed key must throw a VAPID-marked error, not
  // a bare atob/WebCrypto message ("Invalid character") — the
  // notifyNewMessage config-error scan classifies by message, and an
  // unmarked error would be swallowed again as a delivery failure.
  let pub: Uint8Array<ArrayBuffer>;
  try {
    pub = b64urlDecode(vapidPublicKeyB64);
  } catch {
    throw new Error("VAPID public key is not valid base64url");
  }
  if (pub.length !== 65) throw new Error("VAPID public key must be 65 bytes");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pub.subarray(1, 33)),
    y: b64urlEncode(pub.subarray(33, 65)),
    d: vapidPrivateKeyB64,
  };
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("VAPID private key is not a valid P-256 key");
  }
  const h = b64urlEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64urlEncode(
    te.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const data = te.encode(`${h}.${p}`);
  const rawSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  const sig = b64urlEncode(ecdsaSigToRaw(new Uint8Array(rawSig)));
  return `vapid t=${h}.${p}.${sig}, k=${vapidPublicKeyB64}`;
}

export async function sendWebPush(
  sub: PushSubscriptionJSON,
  plaintext: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  // Audit-2 L77: default TTL 86400 (24h) — a chat notification
  // delivered a day late is stale/misleading. 3600s (1h) is the
  // default; callers that need less (missed-call ping 300s, call
  // invite 30s) pass it explicitly and are unaffected.
  ttlSeconds = 3600,
): Promise<{ ok: boolean; status: number }> {
  // Audit-2 M48: defense in depth — even a row saved before the
  // save-time allowlist (or written by another path) must never make
  // the server POST to an arbitrary URL. status 0 = never sent (not
  // an HTTP status); callers only delete on 404/410, so a skipped
  // endpoint is never cleaned up by mistake.
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    console.warn("[push] refusing to send to non-push-service endpoint");
    return { ok: false, status: 0 };
  }
  // Audit-2 M61: fit the payload BEFORE encrypting (see fitPushPayload).
  const fitted = fitPushPayload(plaintext);
  // Audit-2 M56: a subscription whose stored keys are undecryptable
  // (legacy row saved before M48's save-time validation — bad base64,
  // wrong length, or a point that is not on P-256) used to THROW out
  // of encryptPush, bypassing every caller's 404/410 cleanup — the
  // row lived forever and threw on every message. The keys are
  // provably corrupt, so the subscription can NEVER receive a push:
  // report it as 410 ("gone") so all three callers' existing
  // 404/410 cleanup deletes the row (M49-scoped). This is NOT an
  // HTTP 410 from a push service — no request was sent. Server-side
  // failures (vapidAuthHeader, fetch) still throw: a bad VAPID key
  // or a network blip must never delete subscriptions (H21).
  // Audit-4 L33: ONLY InvalidSubscriptionKeyError maps to 410 — the
  // old catch-all mapped EVERY encryptPush throw there, so a
  // transient WebCrypto failure would have deleted a healthy
  // subscription via the callers' 404/410 cleanup. A transient
  // failure re-throws (like vapidAuthHeader/fetch); callers
  // contain it per-subscription (allSettled) and keep the row.
  let body: Uint8Array<ArrayBuffer>;
  try {
    ({ body } = await encryptPush(sub, fitted));
  } catch (err) {
    if (err instanceof InvalidSubscriptionKeyError) {
      console.warn(
        "[push] deleting subscription with undecryptable keys (never sent):",
        err.message,
      );
      return { ok: false, status: 410 };
    }
    throw err;
  }
  const audience = new URL(sub.endpoint).origin;
  const auth = await vapidAuthHeader(audience, vapid.publicKey, vapid.privateKey, vapid.subject);
  // Audit-2 H22: a hanging push service must not hang the caller
  // (sendMessage awaited this). 5s cap — the request is already sent
  // by then, so an abort only cuts the response wait, not delivery.
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: String(ttlSeconds),
      Urgency: "high",
      Authorization: auth,
    },
    body: body as unknown as BodyInit,
    signal: AbortSignal.timeout(5000),
  });
  // Audit-2 M61: 413 = payload too large — a PAYLOAD problem, not a
  // dead subscription. Log it (the row must NOT be deleted — callers
  // only delete on 404/410, and this is neither). With fitPushPayload
  // in place this should be rare (a field other than title/body
  // blowing up, or a push service with a sub-4096 limit).
  if (res.status === 413) {
    console.warn("[push] payload too large (HTTP 413) — subscription kept, not deleted.");
  }
  return { ok: res.ok, status: res.status };
}

/**
 * Audit-2 M61: Web Push payloads are capped at 4096 bytes (RFC 8291).
 * A long room name (no server-side cap) + a 120-char preview can push
 * the JSON over the limit -> the push service 413s -> the row was
 * kept (correctly) but EVERY message re-413d forever. Fix: truncate
 * title/body to fit BEFORE encrypting, so the push delivers (shorter)
 * instead of failing. Single choke point — all three callers
 * (notifyNewMessage, notifyIncomingCall, sendTestPush) go through
 * sendWebPush, so one fit here covers them all.
 *
 * Budget: 3980 plaintext bytes, leaving ~116 bytes for encryption
 * overhead (21-byte header + 65-byte ephemeral key + 16-byte GCM tag
 * + padding delimiter). Truncation is UTF-8-byte-aware (iterates code
 * points, never splits a multi-byte char or surrogate pair) and adds
 * "…". Body is cut first (the variable part), then title. Non-JSON
 * payloads, or JSON without string title/body, pass through untouched
 * (nothing safe to truncate).
 */
export function fitPushPayload(plaintext: string): string {
  const BUDGET = 3980;
  const enc = new TextEncoder();
  if (enc.encode(plaintext).length <= BUDGET) return plaintext;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return plaintext;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.title !== "string" && typeof obj.body !== "string") return plaintext;
  const truncateTo = (s: string, maxBytes: number): string => {
    if (enc.encode(s).length <= maxBytes) return s;
    let used = 0;
    let out = "";
    for (const ch of s) {
      const n = enc.encode(ch).length;
      if (used + n + 3 > maxBytes) break; // +3 reserves "…" (3 bytes)
      out += ch;
      used += n;
    }
    return out + "…";
  };
  const sizeOf = () => enc.encode(JSON.stringify(obj)).length;
  // Cut the body first, then the title, until the payload fits.
  // If the body alone can absorb the overflow, cut only the body.
  // If it cannot (body smaller than the overflow), leave the body
  // intact and cut the title instead — clobbering a short body to
  // "…" would destroy information the title cut can preserve.
  if (typeof obj.body === "string") {
    const over = sizeOf() - BUDGET;
    const bodyBytes = enc.encode(obj.body).length;
    if (over > 0 && over <= bodyBytes) {
      obj.body = truncateTo(obj.body, bodyBytes - over);
    }
  }
  if (sizeOf() > BUDGET && typeof obj.title === "string") {
    const over = sizeOf() - BUDGET;
    obj.title = truncateTo(obj.title, Math.max(0, enc.encode(obj.title).length - over));
  }
  // Audit-4 L24: the two cuts above each assume the OTHER field
  // can stay intact — when the overflow exceeds EACH of body and
  // title individually, the title cut bottoms out at "…" and the
  // payload is STILL over budget (413, row kept, push fails).
  // Cut the body too in that case: both fields at "…" is the
  // minimum this fn can reach; if even that doesn't fit, the
  // overflow lives in other fields, which this fn never
  // truncates (caller gets the 413 either way).
  if (sizeOf() > BUDGET && typeof obj.body === "string") {
    const over = sizeOf() - BUDGET;
    obj.body = truncateTo(obj.body, Math.max(0, enc.encode(obj.body).length - over));
  }
  return JSON.stringify(obj);
}

/**
 * Fan out a Web Push to every room member (except the sender) that has a
 * registered push subscription. Best-effort: failures never break sending.
 */
/**
 * Audit-4 M18: fetch ALL pages of a PostgREST select. An un-ranged
 * select is capped at 1000 rows, so a fan-out query over a big room
 * silently dropped every member past 1000 (no log, no error).
 * `fetchPage` receives the range for one page; pages run until a
 * short page. Returns `{ rows, error }` — the first page error
 * aborts the fetch (callers fail closed on it). Callers with an
 * `.in()` filter must ALSO chunk the id list (see the subs/prefs
 * queries below) — a >1000-id IN list blows up the URL.
 */
async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: { message?: string; code?: string } | null }>,
): Promise<{ rows: T[]; error: { message?: string; code?: string } | null }> {
  const rows: T[] = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error };
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return { rows, error: null };
}

export async function notifyNewMessage(
  roomId: string,
  senderId: string,
  messagePreview: string,
  // H34: push TTL. Default 1h for normal messages (Audit-2 L77 —
  // the old 24h default delivered day-old notifications); the
  // missed-call ping passes 300s — a "missed call" delivered hours
  // later is stale/misleading (the user would think it's a new
  // missed call).
  ttlSeconds = 3600,
): Promise<void> {
  try {
    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    // Audit-2 M73: a missing VAPID key is a CONFIG error, not a
    // delivery failure — the old silent return hid a dead push
    // pipeline behind normally-sending messages.
    if (!vapidPublic || !vapidPrivate) {
      logPushConfigErrorThrottled(
        "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing — push disabled until the VAPID keys are configured.",
      );
      return;
    }

    // Muted chats never push. M33: fail CLOSED on the members query
    // error — the old code fell back to unfiltered members, so a
    // missing is_muted column (chat-actions SQL unrun) silently
    // ignored every mute. When the mute state is unknown, don't push:
    // a missed notification is safer than violating a mute.
    // Audit-4 M18: paginated (see fetchAllPages) — the old
    // un-ranged select silently dropped members past 1000.
    const { rows: members, error: membersError } = await fetchAllPages(async (from, to) =>
      supabaseAdmin
        .from("room_members")
        .select("user_id, is_muted")
        .eq("room_id", roomId)
        .neq("user_id", senderId)
        .range(from, to),
    );
    if (membersError) {
      console.warn(
        "[notifyNewMessage] members query failed — skipping push (mute state unknown):",
        membersError?.message,
      );
      return;
    }
    const memberIds = members.filter((m) => !m.is_muted).map((m) => m.user_id);
    if (memberIds.length === 0) return;

    // Audit-2 M59: the subs-query error was swallowed (error not even
    // destructured) — a failed query (RLS, missing table, timeout)
    // silently sent no push at all. Log with the room id and return;
    // the members-query above already logs the same way.
    // Audit-4 M18: paginated + IN-list chunked (500 ids) — the old
    // un-ranged select silently dropped subs past 1000, and a
    // >1000-id IN list blows up the URL.
    const subs: { endpoint: string; p256dh: string; auth: string; user_id: string }[] = [];
    let subsError: { message?: string } | null = null;
    {
      const IN_CHUNK = 500;
      for (let i = 0; i < memberIds.length && !subsError; i += IN_CHUNK) {
        const chunk = memberIds.slice(i, i + IN_CHUNK);
        const { rows, error } = await fetchAllPages(async (from, to) =>
          supabaseAdmin
            .from("push_subscriptions")
            .select("endpoint, p256dh, auth, user_id")
            .in("user_id", chunk)
            .range(from, to),
        );
        subs.push(...rows);
        subsError = error;
      }
    }
    if (subsError) {
      console.warn(
        "[notifyNewMessage] push_subscriptions query failed — no push sent:",
        subsError.message,
      );
      return;
    }
    if (!subs || subs.length === 0) return;

    // Audit-4 H4: privacy-filtered sender name — the old code read
    // display_name raw, so a sender with Name->Private still had
    // their real name in every recipient's push title. Same rule as
    // callerNameForCallee (chat.functions.ts): is_name_public=false
    // -> "Someone" for everyone; is_public=false -> "Someone"
    // except for the sender's DM contacts, who still see the real
    // name. 42703 -> the privacy columns don't exist yet (pre-SQL),
    // so no privacy setting exists to honor — fall back to
    // display_name. Any OTHER profile error fails closed to
    // "Someone" (a transient error must never leak a private name).
    const [{ data: profile, error: profileError }, { data: room }] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("display_name, is_name_public, is_public")
        .eq("id", senderId)
        .maybeSingle(),
      supabaseAdmin.from("rooms").select("name").eq("id", roomId).maybeSingle(),
    ]);
    let senderProfile: {
      display_name?: string | null;
      is_name_public?: boolean;
      is_public?: boolean;
    } | null = profile;
    if (profileError && (profileError as { code?: string }).code === "42703") {
      const { data: base } = await supabaseAdmin
        .from("profiles")
        .select("display_name")
        .eq("id", senderId)
        .maybeSingle();
      senderProfile = base;
    }
    const publicName = senderProfile?.display_name || "Someone";
    const nameGloballyHidden = senderProfile?.is_name_public === false;
    const profileHidden = senderProfile?.is_public === false;
    // DM contacts still see the real name when only the whole
    // profile is hidden. Fail CLOSED: a lookup error -> empty set ->
    // everyone sees "Someone" (never a private name).
    const nameVisibleTo = new Set<string>();
    if (profileHidden && !nameGloballyHidden) {
      try {
        const { data: myRooms } = await supabaseAdmin
          .from("room_members")
          .select("room_id, rooms(is_dm)")
          .eq("user_id", senderId);
        const dmIds = (myRooms ?? [])
          .filter((r) => (r.rooms as { is_dm?: boolean } | null)?.is_dm === true)
          .map((r) => r.room_id);
        if (dmIds.length > 0) {
          const { data: peers } = await supabaseAdmin
            .from("room_members")
            .select("user_id")
            .in("room_id", dmIds)
            .in("user_id", memberIds);
          for (const p of peers ?? []) nameVisibleTo.add(p.user_id);
        }
      } catch {
        // Fail closed — nameVisibleTo stays empty.
      }
    }
    const roomName = room?.name || "VibeTalk";
    const titleFor = (recipientId: string) => {
      const senderName =
        nameGloballyHidden || (profileHidden && !nameVisibleTo.has(recipientId))
          ? "Someone"
          : publicName;
      return roomName === "General" ? senderName : `${senderName} · ${roomName}`;
    };
    // Audit-2 L70: per-recipient preview preference (lock-screen
    // privacy). Recipients with show_notification_previews=false get
    // only "New message" — no sender text / message body on the lock
    // screen. Pre-SQL the column doesn't exist (42703) -> fail open
    // to previews ON (current behaviour); a real query failure is
    // warned but also fails open (a missed preview beats a crash).
    const previewsOff = new Set<string>();
    {
      // Audit-4 M18: paginated + IN-list chunked (500 ids), same as
      // the subs query — the old un-ranged select silently dropped
      // prefs past 1000, defaulting those members to previews ON.
      // Audit-4 M22: retry a TRANSIENT prefs failure once — the old
      // code failed open (empty previewsOff) on the first error, so
      // a network blip sent full previews to members who turned
      // them off. A missing-column error (42703, pre-SQL) is
      // permanent — fail open immediately without a wasted retry.
      const prefs: { id: string; show_notification_previews?: boolean | null }[] = [];
      let prefsError: { message?: string; code?: string } | null = null;
      const IN_CHUNK = 500;
      for (let attempt = 0; attempt < 2; attempt++) {
        prefs.length = 0;
        prefsError = null;
        for (let i = 0; i < memberIds.length && !prefsError; i += IN_CHUNK) {
          const chunk = memberIds.slice(i, i + IN_CHUNK);
          const { rows, error } = await fetchAllPages(async (from, to) =>
            supabaseAdmin
              .from("profiles")
              .select("id, show_notification_previews")
              .in("id", chunk)
              .range(from, to),
          );
          prefs.push(...rows);
          prefsError = error;
        }
        if (!prefsError || prefsError.code === "42703") break;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 100));
      }
      if (prefsError) {
        console.warn(
          "[notifyNewMessage] preview-preference lookup failed — sending full previews:",
          prefsError.message,
        );
      } else {
        for (const p of prefs ?? []) {
          if (p.show_notification_previews === false) previewsOff.add(p.id);
        }
      }
    }
    const fullBody = messagePreview || "sent you a message";
    // H4: titles are per-recipient (the sender's name may be visible
    // to a DM contact but hidden from everyone else).
    const payloadFor = (recipientId: string) =>
      JSON.stringify({
        title: titleFor(recipientId),
        body: fullBody,
        roomId,
        tag: `hcroom-msg-${roomId}`,
      });
    // Audit-4 M12: the hidden payload's title is nameless and
    // roomless ("VibeTalk") — the old code kept the per-recipient
    // title, so the lock screen still learned who + which room
    // while the body said "New message". roomId/tag stay (they
    // route the tap, they are not displayed).
    const hiddenPayloadFor = () =>
      JSON.stringify({
        title: "VibeTalk",
        body: NOTIFICATION_PREVIEW_HIDDEN,
        roomId,
        tag: `hcroom-msg-${roomId}`,
      });

    // Audit-2 H22: cap the fan-out — the old code fired one parallel
    // fetch per subscription (a big room = unbounded parallel fetches,
    // and one hanging push service held the whole sendMessage up to
    // the Worker timeout). Batches of 10, each batch bounded by the
    // 5s sendWebPush timeout. Call/test pushes fan out to a single
    // user's devices (1–3 subs), so they need no cap.
    const PUSH_FANOUT_CONCURRENCY = 10;
    const sendOne = async (s: (typeof subs)[number]) => {
      const result = await sendWebPush(
        { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
        // Audit-2 L70: this recipient's preview preference picks
        // the payload (full preview vs "New message").
        previewsOff.has(s.user_id) ? hiddenPayloadFor() : payloadFor(s.user_id),
        {
          publicKey: vapidPublic,
          privateKey: vapidPrivate,
          subject: vapidSubject(), // M72: was a hardcoded literal
        },
        ttlSeconds,
      );
      // Audit-2 H21: delete ONLY on 404/410 — the only deterministic
      // "subscription gone" signals. 401/403 was treated as "VAPID
      // auth dead" (rotated-out key), but it also fires for
      // server-side problems: VAPID public/private mismatch, a wrong
      // VAPID_SUBJECT, server clock skew (JWT exp 12h). One bad key
      // deploy made EVERY send 401 and wiped EVERY subscription in
      // a single sweep — closed-app users' push stayed dead until
      // they reopened the app. On 401/403 the row is KEPT (no
      // quarantine flag: a flag with no un-quarantine trigger would
      // strand rows; the recovery paths — key fixed → next send
      // succeeds, or genuine rotation → M38 client staleness check
      // re-subscribes fresh — both converge on this row) and the
      // failure is logged as a server alert. 429/500 stay transient.
      // Drop dead subscriptions so we stop trying.
      if (!result.ok && (result.status === 404 || result.status === 410)) {
        // Audit-2 M49: scope the delete to THIS user's row. The
        // endpoint is browser-scoped, not account-scoped — two users
        // sharing one browser profile have the SAME endpoint, and an
        // endpoint-only delete wiped the other user's row too.
        await supabaseAdmin
          .from("push_subscriptions")
          .delete()
          .eq("endpoint", s.endpoint)
          .eq("user_id", s.user_id);
      } else if (!result.ok && (result.status === 401 || result.status === 403)) {
        console.warn(
          `[push] VAPID auth failed (HTTP ${result.status}) — subscription kept, not deleted. Check VAPID keys / subject / server clock.`,
        );
      }
    };
    // Audit-3 A7-N4: bound the WHOLE fan-out — H22 capped concurrency
    // (10) and each send (5s), but batches ran sequentially, so a big
    // room with a slow/hanging push service cost (subs/10) × 5s while
    // sendMessage awaited (past Worker limits; the sender saw an
    // error/timeout for a message that actually sent, and might retry
    // → duplicate). Overall 10s deadline: batches past it are skipped
    // and logged. The message row is already inserted, so skipping
    // delivery is strictly better than failing the send. A batch that
    // starts before the deadline still runs to completion (worst case
    // ~15s), never abandoned mid-flight.
    const FANOUT_DEADLINE_MS = 10_000;
    const fanoutStart = Date.now();
    let skippedSubs = 0;
    for (let i = 0; i < subs.length; i += PUSH_FANOUT_CONCURRENCY) {
      if (Date.now() - fanoutStart >= FANOUT_DEADLINE_MS) {
        skippedSubs = subs.length - i;
        break;
      }
      const results = await Promise.allSettled(subs.slice(i, i + PUSH_FANOUT_CONCURRENCY).map(sendOne));
      // Audit-2 M73 (extension of the audit's named fix): sendWebPush
      // THROWS on a malformed VAPID key (vapidAuthHeader) — without
      // this scan, allSettled would swallow that config error exactly
      // like the supabaseAdmin throw. Fetch/network rejections stay
      // swallowed (transient delivery failures).
      for (const r of results) {
        if (r.status === "rejected" && r.reason instanceof Error && /VAPID/i.test(r.reason.message)) {
          logPushConfigErrorThrottled(`VAPID key problem — push not sent: ${r.reason.message}`);
        }
      }
    }
    // Audit-3 A7-N4: log skipped subs so a deadline-truncated fan-out
    // is visible (not silent partial delivery).
    if (skippedSubs > 0) {
      console.warn(
        `[push] fan-out deadline (${FANOUT_DEADLINE_MS}ms) hit — skipped ${skippedSubs} of ${subs.length} subscription(s) for room ${roomId}.`,
      );
    }
  } catch (err) {
    // Push is best-effort; never let it break message sending. But a
    // CONFIG error (missing service-role key -> supabaseAdmin
    // construction throw) must be loud — Audit-2 M73.
    if (err instanceof Error && /Missing Supabase environment variable/.test(err.message)) {
      logPushConfigErrorThrottled(`${err.message} — push disabled until the service-role key is configured.`);
    } else {
      // Audit-4 M14: the old code swallowed EVERY other error
      // silently — push lost with no trace while the message sent.
      // Log with room + sender so the failure is diagnosable.
      // Still best-effort: never rethrown, never breaks the send.
      console.warn(
        `[push] notifyNewMessage failed for room ${roomId} sender ${senderId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
