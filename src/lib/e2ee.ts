/**
 * End-to-end encryption for text messages in E2EE group rooms.
 *
 * Cryptography (all WebCrypto, zero dependencies):
 *   - Identity: ECDH P-256 keypair per browser. Private key in IndexedDB
 *     (origin-scoped, never sent anywhere). Public key published to
 *     profiles.e2e_public_key so others can encrypt for you.
 *   - Per message: a fresh random AES-GCM-256 message key encrypts the text.
 *     The message key is wrapped (AES-GCM) once per recipient with a KEK
 *     derived via ECDH + HKDF-SHA256 from the sender's private key and the
 *     recipient's public key.
 *   - Wire format: `E2E1:` + base64url(JSON { v, s, n, c, k: { userId: { n, c } } }).
 *     The server stores this opaque string as messages.body — it can never
 *     read the plaintext.
 *   - Audit-2 H31 (v2 envelopes): the message ciphertext is AES-GCM-bound
 *     to the room + sender (AAD = `vibetalk-e2ee-v2:<roomId>:<senderId>`),
 *     so a copied envelope fails authentication in any other room or
 *     under any other sender id (no replay / misattribution). v1
 *     envelopes (no `v`, pre-H31) still decrypt via the legacy path
 *     (no AAD) so old history keeps working. The server validates
 *     envelope SHAPE on send/edit (validateE2EEnvelope) — garbage
 *     `E2E1:` blobs can no longer poison a room.
 *
 * Scope (honest limits, Milestone 1):
 *   - Text messages in NEW group rooms created with the E2EE toggle only.
 *     DMs stay plaintext for now (DM E2EE needs the DM-creation RPC changed).
 *   - Attachments / voice messages are NOT encrypted yet (stored as before).
 *   - No forward secrecy / ratchet: the identity KEK is static per keypair.
 *     Each message still gets its own random message key.
 *   - Keys are per-BROWSER: opening the app in a second browser generates a
 *     new keypair and publishes it (overwriting the old public key). The new
 *     browser can send/receive new messages but cannot read messages that
 *     were encrypted for the old keypair. The sender always wraps for their
 *     own LOCAL keypair, so their own sent messages always decrypt in the
 *     browser that sent them.
 *   - Audit-2 H11: a profile row holds ONE published key, so publishing is
 *     deliberately rare — viewing an E2EE room or decrypting NEVER
 *     publishes (a second device merely opening the room used to rotate
 *     the profile key and break the first device's decryption). Publish
 *     happens only when this browser generates its keypair (its first
 *     send in an E2EE room), plus one retry if that publish failed
 *     (e.g. the e2e column didn't exist yet). Residual single-key limit:
 *     a second device's first SEND still rotates the published key, so
 *     the first device stops receiving new messages (it keeps its own
 *     history). Per-user multiple public keys (wrap for every device)
 *     is the real fix — it needs a new table + SQL and is out of scope.
 *   - If a room member has no public key yet (never opened an E2EE-capable
 *     client), sending is BLOCKED with the member's name — we never silently
 *     fall back to plaintext inside an E2EE room.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const E2EE_PREFIX = "E2E1:";

export function isEncryptedBody(body: string | null | undefined): boolean {
  return !!body && body.startsWith(E2EE_PREFIX);
}

/** True when the envelope carries a wrapped key for this user. False means
 *  the message was sent before this user joined the room (or before they
 *  had keys) — it can never decrypt, and must not render as an error. */
export function hasWrappedKey(body: string | null | undefined, userId: string): boolean {
  if (!isEncryptedBody(body)) return false;
  try {
    const json = new TextDecoder().decode(b64urlDecode(body!.slice(E2EE_PREFIX.length)));
    const env = JSON.parse(json) as WireEnvelope;
    return !!env.k?.[userId];
  } catch {
    return false;
  }
}

/** Audit-3 A4-N20: true when the envelope can't even be parsed (bad
 *  base64 / bad JSON / no wrapped-key map) — a CORRUPT envelope, not a
 *  pre-join message. Callers map this to "Couldn't decrypt this
 *  message" instead of the misleading "Sent before you joined". */
export function isCorruptEnvelope(body: string | null | undefined): boolean {
  if (!isEncryptedBody(body)) return false;
  try {
    const json = new TextDecoder().decode(b64urlDecode(body!.slice(E2EE_PREFIX.length)));
    const env = JSON.parse(json) as WireEnvelope;
    return typeof env.k !== "object" || env.k === null;
  } catch {
    return true;
  }
}


const DB_NAME = "vibetalk-e2ee";
const STORE = "keys";
const IDB_KEY = (userId: string) => `keypair:${userId}`;

// Audit-6 C-N4: ONE shared connection, cached — the old idb()
// opened a brand-new connection on EVERY operation and never
// closed any of them (executed: 10 decryptBody calls -> 10
// indexedDB.open(), 0 close() — handle churn on long decrypt
// passes). A failed open clears the cache so the next call retries
// fresh; a versionchange (another tab upgraded the DB) closes and
// clears it too.
let idbPromise: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  if (!idbPromise) {
    idbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          idbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        idbPromise = null;
        reject(req.error);
      };
    });
  }
  return idbPromise;
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  additionalData?: Uint8Array,
) {
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, "AES-GCM", false, [
    "encrypt",
  ]);
  const nonce = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce.buffer as ArrayBuffer,
      ...(additionalData ? { additionalData: additionalData.buffer as ArrayBuffer } : {}),
    },
    key,
    plaintext.buffer as ArrayBuffer,
  );
  return { nonce: b64urlEncode(nonce), ciphertext: b64urlEncode(new Uint8Array(ct)) };
}

async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  nonceB64: string,
  ctB64: string,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, "AES-GCM", false, [
    "decrypt",
  ]);
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64urlDecode(nonceB64).buffer as ArrayBuffer,
      ...(additionalData ? { additionalData: additionalData.buffer as ArrayBuffer } : {}),
    },
    key,
    b64urlDecode(ctB64).buffer as ArrayBuffer,
  );
  return new Uint8Array(pt);
}

async function importPublicKey(rawB64: string): Promise<CryptoKey> {
  const raw = b64urlDecode(rawB64);
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

async function exportPublicKeyRaw(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return b64urlEncode(new Uint8Array(raw));
}

async function deriveKek(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const kek = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt.buffer as ArrayBuffer,
      info: new TextEncoder().encode("vibetalk-e2ee-v1"),
    },
    hkdfKey,
    256,
  );
  return new Uint8Array(kek);
}

/**
 * M5: validate a base64url P-256 uncompressed public-key point: exactly
 * 65 bytes, 0x04 prefix, and (x, y) on the curve y² = x³ - 3x + b (mod p).
 * BigInt arithmetic (no WebCrypto dependency — this also runs in the
 * publish server fn). A garbage key stored here would brick every other
 * member's sends to any room this user is in.
 */
function isValidP256Point(rawB64: string): boolean {
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(rawB64);
  } catch {
    return false;
  }
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  const bytesToBigInt = (b: Uint8Array): bigint => {
    let n = 0n;
    for (const byte of b) n = (n << 8n) | BigInt(byte);
    return n;
  };
  const x = bytesToBigInt(raw.slice(1, 33));
  const y = bytesToBigInt(raw.slice(33, 65));
  const p = BigInt("0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF");
  const b = BigInt("0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B");
  if (x >= p || y >= p) return false;
  const mod = (n: bigint): bigint => ((n % p) + p) % p;
  return mod(y * y) === mod(mod(x * x * x) - 3n * x + b);
}

/** Publish my public key so others can encrypt for me. Best-effort: fails
 *  silently until vibetalk-e2ee-visibility.sql adds the column. */
export const publishE2EEKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ publicKey: z.string().min(10).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    // M5: reject garbage keys at publish time — a malformed key would
    // brick every other member's sends to any room this user is in.
    if (!isValidP256Point(data.publicKey)) {
      throw new Error("Invalid encryption key — not a valid P-256 public key.");
    }
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ e2e_public_key: data.publicKey })
      .eq("id", context.userId);
    if (error) throw error;
    return { ok: true };
  });

/** Public keys of a room's members (membership-checked). Members without a
 *  key come back with e2e_public_key null. */
export const getRoomMemberKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: membership } = await supabase
      .from("room_members")
      .select("room_id")
      .eq("room_id", data.roomId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) throw new Error("Not a member of this room.");
    const { data: members, error } = await supabaseAdmin
      .from("room_members")
      .select("user_id")
      .eq("room_id", data.roomId);
    if (error) throw error;
    const ids = (members ?? []).map((m) => m.user_id);
    if (ids.length === 0) return [] as { user_id: string; e2e_public_key: string | null; display_name: string }[];
    // e2e_public_key may not exist until the SQL runs — fall back to nulls.
    // Audit-2 M63: the display_name is privacy-filtered with the same
    // "Someone" rule as the profile view (C3) + the H30 gate — the
    // names surface in E2EENotReadyError ("X hasn't set up encryption
    // yet"), so a private-name member's real name used to leak to the
    // whole room. is_name_public === false -> "Someone". is_public ===
    // false (hidden) + viewer is not an existing DM contact ->
    // "Someone" (shared room does NOT count as contact, per H30).
    // Self always sees their own name. Pre-§4 (privacy columns
    // missing, 42703) falls back to the bare read below — the columns
    // default to public, matching the view's coalesce(..., true).
    const { data: profiles, error: pErr } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name, e2e_public_key, is_name_public, is_public")
      .in("id", ids);
    if (pErr) {
      // Audit-3 A8-N6: fall back ONLY on 42703 (missing privacy
      // columns — pre-SQL). Any other error fails CLOSED (throw):
      // the bare read below has no is_name_public filter / H30
      // gate, so a transient/RLS error must never downgrade to
      // real names (the H35 rule every other privacy path uses).
      if ((pErr as { code?: string }).code !== "42703") throw pErr;
      const { data: basic } = await supabaseAdmin
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      return (basic ?? []).map((p) => ({
        user_id: p.id,
        e2e_public_key: null as string | null,
        display_name: p.display_name ?? "Someone",
      }));
    }
    // DM-contact check runs ONLY when a non-self member is hidden
    // (same optimization as fetchPublicProfiles' H30 gate).
    const hiddenIds = (profiles ?? [])
      .filter((p) => p.id !== userId && (p as { is_public?: boolean }).is_public === false)
      .map((p) => p.id);
    const contacts = new Set<string>();
    if (hiddenIds.length > 0) {
      const { data: myRooms } = await supabaseAdmin
        .from("room_members")
        .select("room_id, rooms(is_dm)")
        .eq("user_id", userId);
      const dmIds = (myRooms ?? [])
        .filter((r) => (r.rooms as { is_dm?: boolean } | null)?.is_dm === true)
        .map((r) => r.room_id);
      if (dmIds.length > 0) {
        const { data: peers } = await supabaseAdmin
          .from("room_members")
          .select("user_id")
          .in("room_id", dmIds)
          .in("user_id", hiddenIds);
        for (const peer of peers ?? []) contacts.add(peer.user_id);
      }
    }
    return (profiles ?? []).map((p) => {
      const isSelf = p.id === userId;
      // Self always sees their own name (same as the C3 view's
      // `p.id = auth.uid()` branch); the filter is for OTHER members.
      const namePrivate = !isSelf && (p as { is_name_public?: boolean }).is_name_public === false;
      const hiddenFromViewer =
        !isSelf && (p as { is_public?: boolean }).is_public === false && !contacts.has(p.id);
      return {
        user_id: p.id,
        e2e_public_key: (p as { e2e_public_key?: string | null }).e2e_public_key ?? null,
        display_name: namePrivate || hiddenFromViewer ? "Someone" : (p.display_name ?? "Someone"),
      };
    });
  });

export type LocalKeypair = {
  /**
   * Audit-2 M67: the private key is stored as a NON-extractable
   * CryptoKey (IndexedDB structured-clone), NEVER as an exportable
   * JWK. Any script running on the app origin (XSS) could previously
   * read the JWK out of IndexedDB and decrypt the user's entire E2EE
   * history (no forward secrecy). A non-extractable CryptoKey cannot
   * be exported — it can only be USED via the WebCrypto API while the
   * page is open, which is inherent to the app itself using it.
   * generateKey(..., false, ...) leaves the PUBLIC key exportable
   * (verified: publicKey.extractable stays true), so publicRaw is
   * still obtainable at generation time.
   */
  privateKey: CryptoKey;
  publicRaw: string;
  /**
   * Audit-2 H11: whether this public key was successfully published to
   * profiles.e2e_public_key. `false` = generated but publish failed
   * (retry on next send). `undefined` = legacy entry (pre-H11) — needs
   * the Audit-3 A4-N8 verify against the server key (see
   * ensureKeypair). `true` = settled: the local key IS the published
   * key. (Pre-Audit-5 wording also called a foreign server key
   * "settled — no action"; Audit-5 B3-HIGH showed that let a key
   * published from a briefly stolen session persist forever, so
   * ensureKeypair now reclaims instead — see there.)
   */
  published?: boolean;
};

/** Load my keypair from this browser ONLY — no generation, no publish. */
type LegacyLocalKeypair = {
  privateJwk: JsonWebKey;
  publicRaw: string;
  published?: boolean;
};

async function loadKeypair(userId: string): Promise<LocalKeypair | undefined> {
  const stored = await idbGet<LocalKeypair | LegacyLocalKeypair>(IDB_KEY(userId));
  if (!stored?.publicRaw) return undefined;
  if ("privateKey" in stored && stored.privateKey instanceof CryptoKey) return stored;
  // One-time migration: a pre-M67 entry stored the private key as an
  // exportable JWK. Import it as NON-extractable and overwrite the
  // entry, so the JWK stops existing in IndexedDB after the next load.
  if ("privateJwk" in stored && stored.privateJwk) {
    try {
      const privateKey = await crypto.subtle.importKey(
        "jwk",
        stored.privateJwk,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      );
      const migrated: LocalKeypair = {
        privateKey,
        publicRaw: stored.publicRaw,
        published: stored.published,
      };
      try {
        await idbSet(IDB_KEY(userId), migrated);
      } catch {
        /* migration write failed — in-memory pair still works; retry next load */
      }
      return migrated;
    } catch {
      return undefined; // corrupt legacy entry: caller regenerates / cannot decrypt
    }
  }
  return undefined;
}

/**
 * Load my keypair from this browser, or generate + store + publish it.
 * Both halves are stored together so the public key never needs to be
 * re-derived from the private scalar (WebCrypto can't do that).
 *
 * Audit-2 H11: publish happens ONLY on generation (this browser's first
 * send in an E2EE room — the only caller is encryptForRoom), plus one
 * retry if that publish failed (published === false). A stored keypair
 * is NEVER re-published: the published key belongs to whichever device
 * published it, and re-publishing on every send/view/decrypt is what
 * rotated the profile key and broke the other device's decryption.
 * Audit-3 A4-N8: legacy keypairs (published === undefined) get ONE
 * verify against the server's published key (passed in by the caller
 * from its memberKeys snapshot) — publish only if the server has NO
 * key or the IDENTICAL key (publishing the identical key cannot
 * rotate anything); a DIFFERENT server key means another device
 * published — settle without publishing.
 */
/**
 * Audit-5 B3-HIGH: set when ensureKeypair reclaimed a foreign
 * published key (see there). The send flow drains it to warn the
 * user once per reclaim. A boolean, not a counter: repeated
 * reclaims before a drain still warrant exactly one warning.
 */
let keyReclaimNotice = false;
export function takeKeyReclaimNotice(): boolean {
  const notice = keyReclaimNotice;
  keyReclaimNotice = false;
  return notice;
}

export async function ensureKeypair(
  userId: string,
  serverPublicKey?: string | null,
): Promise<LocalKeypair> {
  const stored = await loadKeypair(userId);
  if (stored) {
    let result = stored;
    // Audit-5 B3-HIGH: the server has a DIFFERENT key published for
    // this user than the keypair this browser holds. publishE2EEKey
    // accepts any valid point for the session user (an ECDH key
    // cannot sign, so the server cannot demand proof of possession
    // without a new challenge protocol), so a briefly stolen session
    // can publish the ATTACKER's key as the victim's — senders then
    // encrypt to the attacker, and the access survived password
    // change + global sign-out because nothing re-validated the key
    // afterwards; this code used to settle on the foreign key
    // silently ("another device's key"). The local keypair is the
    // one this browser can prove possession of (it holds the private
    // key), so it wins: re-publish it (reclaim) and flag it so the
    // send flow can warn the user (takeKeyReclaimNotice). A genuine
    // second device re-publishes its own key on ITS next send, the
    // same as before. Best-effort — a failed reclaim is retried on
    // the next send.
    if (typeof serverPublicKey === "string" && serverPublicKey !== stored.publicRaw) {
      try {
        await publishE2EEKey({ data: { publicKey: stored.publicRaw } });
        keyReclaimNotice = true;
        result = { ...stored, published: true };
        await idbSet(IDB_KEY(userId), result);
      } catch {
        /* reclaim retried on next send */
      }
      return result;
    }
    // Publish retry only for post-H11 keypairs whose first publish
    // failed (e.g. the e2e column didn't exist yet).
    if (stored.published === false) {
      try {
        await publishE2EEKey({ data: { publicKey: stored.publicRaw } });
        result = { ...stored, published: true };
        await idbSet(IDB_KEY(userId), result);
      } catch {
        /* publish later */
      }
    } else if (stored.published === undefined && serverPublicKey !== undefined) {
      // Audit-3 A4-N8: legacy keypair — the publish outcome was never
      // recorded, so a failed first publish left the user permanently
      // keyless (everyone's sends to shared E2EE rooms blocked).
      // serverPublicKey === undefined = caller had no snapshot:
      // leave as-is; a later send that can verify will settle it.
      try {
        if (serverPublicKey === null) {
          await publishE2EEKey({ data: { publicKey: stored.publicRaw } });
        }
        result = { ...stored, published: true };
        await idbSet(IDB_KEY(userId), result);
      } catch {
        /* verify/publish later */
      }
    }
    return result;
  }
  // Audit-2 M67: extractable = false. The private key is never
  // exported — it goes straight into IndexedDB as a CryptoKey.
  // (The public key stays exportable; exportPublicKeyRaw still works.)
  const kp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const publicRaw = await exportPublicKeyRaw(kp.publicKey);
  const pair: LocalKeypair = { privateKey: kp.privateKey, publicRaw, published: false };
  await idbSet(IDB_KEY(userId), pair);
  try {
    await publishE2EEKey({ data: { publicKey: publicRaw } });
    // M67: return the truthful pair — the pre-M67 code returned `pair`
    // (published: false) even after a successful publish. No caller
    // reads the flag today, but a stale return value is a trap.
    const publishedPair: LocalKeypair = { ...pair, published: true };
    await idbSet(IDB_KEY(userId), publishedPair);
    return publishedPair;
  } catch {
    /* publish later */
  }
  return pair;
}

export class E2EENotReadyError extends Error {
  missingNames: string[];
  constructor(missingNames: string[]) {
    super(
      missingNames.length === 1
        ? `${missingNames[0]} hasn't set up encryption yet`
        : `${missingNames.join(", ")} haven't set up encryption yet`,
    );
    this.missingNames = missingNames;
  }
}

type WireEnvelope = {
  /** Envelope version. Absent = v1 (legacy, no AAD binding). 2 = room +
   * sender bound via AES-GCM AAD (audit-2 H31). Unknown versions must
   * NOT decrypt (fail closed) — a future v3 needs a client that knows
   * its format. */
  v?: number;
  /** Audit-4 M4: the room this envelope was encrypted for (plaintext,
   * server-checkable). The AAD still binds the ciphertext; `r` lets
   * the SERVER reject a verbatim cross-room replay before storing
   * it (a replay passes the shape + recipient checks but can never
   * decrypt in the other room). Absent = pre-M4 envelope (legacy
   * tolerance — the server allows it, the AAD still fails closed). */
  r?: string;
  /** Sender's public key (raw uncompressed point) — recipients need it to
   *  derive the shared ECDH secret. Without it, only the sender could
   *  unwrap (ECDH is symmetric: ECDH(senderPriv, recipPub) ==
   *  ECDH(recipPriv, senderPub)). */
  s: string;
  n: string;
  c: string;
  k: Record<string, { n: string; c: string }>;
};

/**
 * Audit-2 H31: AAD binding the v2 envelope to ONE room + ONE sender.
 * The envelope's `s` already proves possession of the wrapper's private
 * key, but nothing bound it to a room — a member could copy a real
 * envelope from room A and re-post it in room B (the UI would attribute
 * A's content to the forwarder). With AAD = room + sender, a replayed
 * envelope fails authentication in any other room (or under any other
 * sender id) and decrypts to null. Copy-paste re-encryption (the
 * forwarder decrypts, then encrypts the plaintext themself) is NOT
 * prevented — no E2EE chat can prevent that; what dies is the verbatim
 * envelope replay + misattribution.
 */
function e2eeAad(roomId: string, senderId: string): Uint8Array {
  return new TextEncoder().encode(`vibetalk-e2ee-v2:${roomId}:${senderId}`);
}

/**
 * Audit-2 H31: server-side envelope shape validation (sendMessage /
 * editMessage). The old gate was prefix-only (`startsWith("E2E1:")`) —
 * a member could store `E2E1:garbage`, `E2E1:` + base64(`{}`), or an
 * envelope with an empty `k` (no wrapped keys), and every client
 * would fail decrypting it (poisoning). This validates structure only
 * — it cannot check that the sender really holds the private key for
 * `s` (that proof is the decrypt itself, client-side). Accepts v1
 * (legacy, already stored) + v2; rejects unknown versions, malformed
 * base64/JSON, bad P-256 sender keys, wrong nonce/salt sizes, empty
 * `k`, a missing sender entry (encryptForRoom always wraps for
 * itself), and non-UUID recipient keys.
 */
export function validateE2EEnvelope(body: string | null | undefined, senderId: string): boolean {
  try {
    if (!isEncryptedBody(body)) return false;
    const json = new TextDecoder().decode(b64urlDecode(body!.slice(E2EE_PREFIX.length)));
    const env = JSON.parse(json) as Partial<WireEnvelope> | null;
    if (!env || typeof env !== "object" || Array.isArray(env)) return false;
    if (env.v !== undefined && env.v !== 1 && env.v !== 2) return false;
    // Audit-4 M4: the room binding, when present, must be a string —
    // a non-string `r` is malformed (the server skips a non-string
    // `r`, so garbage here would dodge the replay check).
    if (env.r !== undefined && typeof env.r !== "string") return false;
    if (typeof env.s !== "string" || !isValidP256Point(env.s)) return false;
    if (typeof env.n !== "string" || b64urlDecode(env.n).length !== 12) return false;
    if (typeof env.c !== "string" || b64urlDecode(env.c).length < 16) return false;
    if (!env.k || typeof env.k !== "object" || Array.isArray(env.k)) return false;
    const keys = Object.keys(env.k);
    if (keys.length === 0) return false;
    // The sender always wraps for themself (LOCAL keypair) — an
    // envelope without the sender's own entry is malformed.
    if (!keys.includes(senderId)) return false;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const uid of keys) {
      if (!uuidRe.test(uid)) return false;
      const entry = env.k[uid];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      if (typeof entry.n !== "string" || typeof entry.c !== "string") return false;
      const parts = entry.n.split(".");
      if (parts.length !== 2) return false;
      if (b64urlDecode(parts[0]).length !== 16) return false; // salt
      if (b64urlDecode(parts[1]).length !== 12) return false; // wrap nonce
      if (b64urlDecode(entry.c).length < 16) return false; // wrapped key + tag
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Audit-4 M4: the room an E2E1: envelope claims it was encrypted for
 * (WireEnvelope.r). The server compares it to the target room at
 * insert/edit time and rejects a verbatim cross-room replay. Returns
 * null when the envelope is unparseable or carries no `r` (pre-M4
 * envelope — callers treat that as legacy-tolerated, not as a match).
 */
export function getE2EEnvelopeRoom(body: string | null | undefined): string | null {
  try {
    if (!isEncryptedBody(body)) return null;
    const json = new TextDecoder().decode(b64urlDecode(body!.slice(E2EE_PREFIX.length)));
    const env = JSON.parse(json) as Partial<WireEnvelope> | null;
    if (!env || typeof env !== "object" || Array.isArray(env)) return null;
    return typeof env.r === "string" ? env.r : null;
  } catch {
    return null;
  }
}

/**
 * Audit-5 B3-HIGH: the envelope's format version (WireEnvelope.v).
 * Absent `v` = the pre-H31 legacy format = 1. Returns null when the
 * body is unparseable or `v` is a non-number. The server requires
 * v === 2 on the WRITE path (chat.functions sendMessage/editMessage):
 * only v2 ciphertext is bound to its room + sender via AAD — a v1
 * envelope's `r` field is unauthenticated JSON anyone can forge. The
 * READ path (decryptBody) still accepts v1 so pre-H31 history keeps
 * opening.
 */
export function getE2EEnvelopeVersion(body: string | null | undefined): number | null {
  try {
    if (!isEncryptedBody(body)) return null;
    const json = new TextDecoder().decode(b64urlDecode(body!.slice(E2EE_PREFIX.length)));
    const env = JSON.parse(json) as Partial<WireEnvelope> | null;
    if (!env || typeof env !== "object" || Array.isArray(env)) return null;
    if (env.v === undefined) return 1;
    return typeof env.v === "number" ? env.v : null;
  } catch {
    return null;
  }
}

/**
 * Audit-3 A4-N6: the recipient set of an E2E1: envelope (the `k`
 * key set). The server compares it to current membership at
 * insert/edit time and rejects envelopes wrapping for non-members
 * (a member removed after the sender's key fetch). Returns [] when
 * the envelope is unparseable — callers run validateE2EEnvelope
 * first, so a valid envelope always yields its key set here.
 */
export function getE2EEnvelopeRecipients(body: string | null | undefined): string[] {
  try {
    if (!isEncryptedBody(body)) return [];
    const json = new TextDecoder().decode(b64urlDecode(body!.slice(E2EE_PREFIX.length)));
    const env = JSON.parse(json) as Partial<WireEnvelope> | null;
    if (!env || typeof env !== "object" || Array.isArray(env)) return [];
    if (!env.k || typeof env.k !== "object" || Array.isArray(env.k)) return [];
    return Object.keys(env.k);
  } catch {
    return [];
  }
}

/**
 * Encrypt plaintext for every member of a room. The sender's own entry is
 * wrapped for their LOCAL keypair (so own messages always decrypt in the
 * sending browser even if the published public key was overwritten by
 * another browser).
 */
export async function encryptForRoom(
  roomId: string,
  plaintext: string,
  myUserId: string,
  memberKeys: { user_id: string; e2e_public_key: string | null; display_name: string }[],
): Promise<string> {
  // Audit-3 A4-N8: hand ensureKeypair the server's published key for
  // self (from the memberKeys snapshot just fetched) so legacy
  // keypairs (published === undefined) can be verified + published.
  // undefined = self not in the snapshot: no verify possible.
  const serverKeyForSelf = memberKeys.find((m) => m.user_id === myUserId)?.e2e_public_key;
  const { privateKey, publicRaw } = await ensureKeypair(myUserId, serverKeyForSelf);

  // Recipients: everyone with a key; self uses the LOCAL public key.
  const recipients: { userId: string; publicRaw: string; displayName: string }[] = [];
  const missing: string[] = [];
  for (const m of memberKeys) {
    if (m.user_id === myUserId) {
      recipients.push({ userId: m.user_id, publicRaw, displayName: m.display_name });
      continue;
    }
    if (!m.e2e_public_key) {
      missing.push(m.display_name);
      continue;
    }
    recipients.push({ userId: m.user_id, publicRaw: m.e2e_public_key, displayName: m.display_name });
  }
  if (missing.length > 0) throw new E2EENotReadyError(missing);

  const messageKey = randomBytes(32);
  const { nonce, ciphertext } = await aesGcmEncrypt(
    messageKey,
    new TextEncoder().encode(plaintext),
    // Audit-2 H31: bind the ciphertext to this room + this sender
    // (AAD). A replayed envelope fails authentication anywhere else.
    e2eeAad(roomId, myUserId),
  );
  const wrapped: Record<string, { n: string; c: string }> = {};
  for (const r of recipients) {
    let pub: CryptoKey;
    try {
      pub = await importPublicKey(r.publicRaw);
    } catch {
      // M5: a stored garbage key (published before publish-side
      // validation) must not brick the room with a raw WebCrypto error
      // — surface the offending member so they can re-publish.
      throw new E2EENotReadyError([r.displayName]);
    }
    const salt = randomBytes(16);
    const kek = await deriveKek(privateKey, pub, salt);
    const w = await aesGcmEncrypt(kek, messageKey);
    wrapped[r.userId] = { n: `${b64urlEncode(salt)}.${w.nonce}`, c: w.ciphertext };
  }
  const envelope: WireEnvelope = { v: 2, r: roomId, s: publicRaw, n: nonce, c: ciphertext, k: wrapped };
  const json = JSON.stringify(envelope);
  return `${E2EE_PREFIX}${b64urlEncode(new TextEncoder().encode(json))}`;
}

/** Decrypt one stored body with my local private key. Returns null when the
 *  body isn't encrypted or can't be decrypted (wrong key / tampered).
 *  Audit-2 H31: v2 envelopes are room + sender bound (AAD) — the caller
 *  MUST pass the message's roomId + senderId (messages.user_id); a v2
 *  envelope without them fails closed (null). v1 envelopes (no `v`)
 *  decrypt via the legacy path (no AAD) so pre-H31 history keeps
 *  working. An unknown `v` fails closed. */
export async function decryptBody(
  body: string | null | undefined,
  myUserId: string,
  opts?: { roomId?: string; senderId?: string },
): Promise<string | null> {
  if (!isEncryptedBody(body)) return body ?? null;
  try {
    const json = new TextDecoder().decode(
      b64urlDecode(body!.slice(E2EE_PREFIX.length)),
    );
    const env = JSON.parse(json) as WireEnvelope;
    const mine = env.k[myUserId];
    if (!mine || !env.s) return null;
    // Audit-4 M4: the envelope names the room it was encrypted for.
    // A stored replay (pre-fix server, or a server that didn't check)
    // must not decrypt under a different room's context — fail fast
    // instead of relying on the AAD failure alone. When the caller
    // passes no roomId the check is skipped (the v2 AAD path below
    // still fails closed without it).
    if (typeof env.r === "string" && opts?.roomId && env.r !== opts.roomId) return null;
    // H31: v2 needs the binding context; anything else fails closed.
    // Audit-3 A4-N6 (v1, ACCEPTED risk): v1 envelopes (no `v`) carry
    // NO room/sender AAD, so a copied v1 envelope still decrypts when
    // re-posted elsewhere. Accepted because dropping v1 decryption
    // would make all pre-H31 history unreadable; all NEW sends are
    // v2 (encryptForRoom stamps v: 2), so no new v1 envelopes are
    // created.
    const aad =
      env.v === 2
        ? opts?.roomId && opts?.senderId
          ? e2eeAad(opts.roomId, opts.senderId)
          : null
        : env.v === undefined || env.v === 1
          ? undefined
          : null;
    if (aad === null) return null;
    const [saltB64, wrapNonce] = mine.n.split(".");
    // Audit-2 H11: LOCAL-ONLY load. Decrypting must never generate or
    // publish a keypair — a fresh browser merely VIEWING undecryptable
    // messages used to publish a new key and break the other device's
    // decryption. No local private key → this message can never decrypt
    // here (its wrapped key was for a different public key).
    const local = await loadKeypair(myUserId);
    if (!local) return null;
    const privateKey = local.privateKey;
    // Unwrap needs ECDH(myPrivate, senderPublic) — the sender's public key
    // travels in the envelope. ECDH(myPriv, myPub) would be a different
    // secret and would NOT unwrap anyone else's message.
    const senderPublic = await importPublicKey(env.s);
    const kek = await deriveKek(privateKey, senderPublic, b64urlDecode(saltB64));
    const messageKey = await aesGcmDecrypt(kek, wrapNonce, mine.c);
    const pt = await aesGcmDecrypt(messageKey, env.n, env.c, aad);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}
