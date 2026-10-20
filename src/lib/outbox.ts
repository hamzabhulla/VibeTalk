/**
 * Offline outbox (WhatsApp-style): messages composed while offline are queued
 * in IndexedDB and auto-sent when connectivity returns.
 *
 * Audit-3 A4-N21: the outbox stores bodies PLAINTEXT at rest in
 * IndexedDB — local-device exposure (anyone with the device / browser
 * profile can read queued messages). E2EE rooms' entries are envelopes,
 * so their bodies are ciphertext, but non-E2EE text and attachment
 * blobs sit in the clear. The flush encrypts before sending
 * (queue-time encryption for E2EE rooms), so nothing leaves the device
 * unencrypted. A stranded entry for a deleted room rests until the
 * queue is cleared — deliberately no TTL / auto-drop: dropping would
 * silently lose the user's unsent message.
 */

export type OutboxEntry = {
  id: string; // client-generated uuid
  roomId: string;
  userId: string;
  body: string;
  type: "text" | "image" | "video" | "audio" | "file";
  fileName?: string;
  fileMime?: string;
  fileSize?: number;
  fileBlob?: Blob;
  createdAt: number;
  // Audit-2 H9: server rejections per entry. At OUTBOX_MAX_FAILURES the
  // entry is quarantined (automatic flushes skip it; the user retries
  // or deletes it). Old entries lack these fields — read as 0 / false.
  failures?: number;
  lastFailedAt?: number;
  quarantined?: boolean;
  // Audit-2 M29: queue-time E2EE — the body is ALREADY an E2E1:
  // envelope; flush must send it as-is, never re-encrypt. Old
  // entries lack this field — read as false (flush encrypts them).
  encrypted?: boolean;
};

/** Audit-2 H9: server rejections before an entry is quarantined. */
export const OUTBOX_MAX_FAILURES = 3;

/**
 * Audit-3 A4-N35: queue caps — an uncapped outbox grows without bound
 * while offline (IndexedDB quota errors, huge flushes). 200 entries /
 * 2 GB total (a 1 GB file + text headroom). queueMessage throws
 * OutboxFullError past either cap; callers surface its message.
 */
export const OUTBOX_MAX_ENTRIES = 200;
export const OUTBOX_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export class OutboxFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxFullError";
  }
}

/**
 * Audit-2 H9: is this flush failure transient (retry later, don't count)
 * or a server rejection (the entry is likely poisoned — count it)?
 * - Transient: network-level failures, and E2EE keys not ready yet
 *   (local, never sent). An outage must NOT quarantine the whole queue.
 * - Poison: anything else — the server refused this entry (not a
 *   member, room deleted, E2EE plaintext rejected, ...). Later entries
 *   may still send fine, so the flush continues past it.
 */
export function classifyFlushError(err: unknown): "transient" | "poison" {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "E2EENotReadyError") return "transient";
  if (err instanceof TypeError) return "transient";
  // Audit-6 E-N2: a nullish rejection (a promise rejected with no
  // reason) crashed the property reads below — the classifier
  // throwing INSIDE the flush's catch aborted the whole flush
  // instead of counting the entry. A reason-less failure carries
  // no transient signal; count it (poison) and move on.
  if (err === null || err === undefined) return "poison";
  // Audit-5 B3-LOW: poison checks must beat message substrings. A
  // bare 502/503/504 or "network" match against the error MESSAGE
  // classified a poisoned entry as transient (e.g. a server
  // rejection whose message mentioned "503") — the transient
  // branch never counts and breaks the flush, so one poisoned
  // entry stalled the queue forever. Prefer REAL signals: any real
  // HTTP status is a server ANSWER, not a connectivity failure —
  // the server refused THIS entry (poison; it counts toward
  // quarantine and the flush continues past it).
  const e = err as {
    status?: number;
    originalResponse?: { getStatus?: () => number };
  };
  const status = e.status ?? e.originalResponse?.getStatus?.() ?? 0;
  if (Number.isFinite(status) && status !== 0) return "poison";
  const msg = err instanceof Error ? err.message : "";
  // Audit-6 E-N1: a statusless DEFINITIVE refusal whose text
  // happens to contain an outage word still classified transient
  // ("storage quota: network volume full" -> matched "network" ->
  // never counted, never quarantined, flush stalled behind it
  // forever — the LOW-10 residual). Per-entry refusal phrases win
  // over the outage substrings below; a genuine connectivity
  // failure's message contains none of these.
  // Audit-7 E1: the phrase list was narrower than real refusal
  // wording — two more executed shapes slipped through on their
  // outage words: "not a member of this network group (room
  // deleted)" (matched "network") and "message too long: upload
  // timed out on server" (matched "timed out"). "not a member" is
  // the server's own refusal text (chat.functions); "message too
  // long" is anchored to "message" so a genuine "took too long"
  // network complaint still classifies transient below.
  if (
    /quota|storage (?:is )?full|volume full|disk full|too large|message too long|unsupported|not allowed|not a member|room (?:was )?deleted/i.test(
      msg,
    )
  ) {
    return "poison";
  }
  // No status at all (a real outage): match the message — but a
  // bare status code inside the message is poison, not transient.
  if (
    !/^[45]\d\d\b/.test(msg.trimStart()) &&
    /failed to fetch|network|offline|load failed|timeout|timed out|econn|eai_again/i.test(
      msg,
    )
  ) {
    return "transient";
  }
  return "poison";
}

const DB_NAME = "tokenchat-outbox";
const STORE = "messages";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("roomId", "roomId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Audit-3 A4-N4: the caller may pin the entry id. The send path does
 * so: the entry id IS the server idempotency key (clientId), so a
 * message whose first send attempt inserted but whose response was
 * lost re-sends with the SAME key and dedupes instead of duplicating.
 * When omitted, a fresh UUID is generated (offline-first branches).
 */
export async function queueMessage(
  entry: Omit<OutboxEntry, "id" | "createdAt"> & { id?: string },
): Promise<OutboxEntry> {
  const full: OutboxEntry = {
    ...entry,
    id: entry.id ?? crypto.randomUUID(),
    createdAt: Date.now(),
  };
  const db = await openDb();
  // Audit-3 A4-N35: enforce the queue caps before the put. Same-id
  // re-queues (the A4-N4 retry path) don't count against the cap —
  // the put below overwrites the existing entry, it doesn't add one.
  let existing: OutboxEntry[];
  try {
    existing = await new Promise<OutboxEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as OutboxEntry[]);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    // Audit-6 E-N6: this read-failure path used to reject WITHOUT
    // closing — the one leaked connection in the module (every
    // other path closes).
    db.close();
    throw err;
  }
  const others = existing.filter((e) => e.id !== full.id);
  if (others.length >= OUTBOX_MAX_ENTRIES) {
    db.close();
    throw new OutboxFullError(
      "Outbox is full (200 messages) — send or delete queued messages first.",
    );
  }
  const entryBytes = (e: OutboxEntry) =>
    (e.fileSize ?? e.fileBlob?.size ?? 0) + new TextEncoder().encode(e.body ?? "").length;
  const totalBytes = others.reduce((sum, e) => sum + entryBytes(e), 0) + entryBytes(full);
  if (totalBytes > OUTBOX_MAX_TOTAL_BYTES) {
    db.close();
    throw new OutboxFullError(
      "Outbox is full (2 GB) — send or delete queued messages first.",
    );
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(full);
    tx.oncomplete = () => {
      db.close();
      resolve(full);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getQueuedMessages(): Promise<OutboxEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("createdAt").getAll();
    req.onsuccess = () => {
      db.close();
      resolve((req.result as OutboxEntry[]).sort((a, b) => a.createdAt - b.createdAt));
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

/**
 * Audit-3 A4-N3: the outbox is namespaced by userId. The old shape
 * filtered by roomId only, so on a shared browser Bob saw Alice's
 * queued bubbles rendered as his own — and the next flush SENT them
 * as Bob's messages (flush attributes to the current session).
 * The userId param is REQUIRED (not optional) so no call site can
 * forget the filter. Sign-out does NOT clear the store: entries are
 * dormant for other users and survive for their owner's next login
 * (clearing would delete a user's unsent queue — data loss).
 */
export async function getQueuedForRoom(roomId: string, userId: string): Promise<OutboxEntry[]> {
  const all = await getQueuedMessages();
  return all.filter((e) => e.roomId === roomId && e.userId === userId);
}

export async function removeQueuedMessage(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Audit-2 H9: patch an entry in place (failure counting, quarantine, retry). */
export async function updateQueuedMessage(
  id: string,
  patch: Partial<Pick<OutboxEntry, "failures" | "lastFailedAt" | "quarantined">>,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const existing = req.result as OutboxEntry | undefined;
      if (existing) {
        store.put({ ...existing, ...patch });
      } else {
        // Audit-6 E-N7: a patch for a missing entry used to vanish
        // silently. The flush patches entries it just read, so a
        // miss means the entry was removed mid-flush — worth a log
        // line (M13 never-swallow pattern), not a silent resolve.
        console.warn(`[outbox] updateQueuedMessage: no entry ${id} — patch dropped (removed mid-flush?).`);
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function countQueued(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => {
      db.close();
      resolve(req.result);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}
