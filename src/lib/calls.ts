/**
 * Real 1:1 voice + video calls over WebRTC.
 *
 * Media flows peer-to-peer (no media server). Signaling (invite / offer /
 * answer / ICE / end) travels over Supabase Realtime broadcast channels:
 * every user subscribes to `call:<theirUserId>` and signals are sent to the
 * recipient's channel. Call history is stored in the `calls` table when it
 * exists (see supabase/vibetalk-calls.sql) — if the table has not been
 * created yet, calls still work and history is simply not persisted.
 *
 * Only 1:1 calls are supported. Group/room calls would need an SFU and are
 * intentionally not attempted here.
 */
import { supabase } from "@/integrations/supabase/client";

export type CallType = "voice" | "video";
export type CallDirection = "incoming" | "outgoing";
export type CallStatus = "idle" | "calling" | "ringing" | "in-call" | "ended";
export type CallOutcome = "completed" | "missed" | "declined" | "failed" | "cancelled";

export type CallSignal =
  | {
      kind: "invite";
      callId: string;
      from: string;
      fromName: string;
      type: CallType;
    }
  | { kind: "accept"; callId: string; from: string }
  | { kind: "decline"; callId: string; from: string }
  // Audit-2 C1: offer/answer/ice carry an HMAC over the payload
  // (HMAC-SHA256 with the per-call secret from the invite row). The
  // receiver verifies it before touching the PeerConnection — a spoofed
  // offer must never reach setRemoteDescription. `mac` is absent only
  // when the sender has no secret (table missing / pre-fix client),
  // which the receiver treats as fail-closed unless the whole call is
  // in the degraded (table-missing) mode.
  // Audit-2 L43: offer/answer carry the sender's CURRENT call type.
  // A mid-call video toggle changes the sender's type (voice<->video)
  // but the peer never learned it, so the peer's history row kept the
  // stale type. Optional: pre-fix peers omit it and the receiver keeps
  // its own type. (Not MAC-covered — like fromName on invites, it is
  // informational; a flipped value can only mislabel a history row,
  // never redirect media.)
  | { kind: "offer"; callId: string; from: string; sdp: RTCSessionDescriptionInit; mac?: string; type?: CallType }
  | { kind: "answer"; callId: string; from: string; sdp: RTCSessionDescriptionInit; mac?: string; type?: CallType }
  | { kind: "ice"; callId: string; from: string; candidate: RTCIceCandidateInit; mac?: string }
  | {
      kind: "end";
      callId: string;
      from: string;
      // Audit-2 M40: set only by the caller cancelling while "calling"
      // — the callee records "cancelled" instead of "missed". Absent
      // everywhere else (timeout, tab close, failure, hangup), where
      // "missed"/"completed" stay correct. The row check still gates
      // the signal; the reason only picks the local history label.
      reason?: "cancelled";
    }
  // Callee's app was closed and missed our offer — ask the caller to re-send
  // it once the callee reconstructed ringing from the persisted invite.
  | { kind: "offer-request"; callId: string; from: string };

export type CallRecord = {
  id: string;
  user_id: string;
  peer_id: string;
  peer_name: string;
  type: CallType;
  direction: CallDirection;
  status: CallOutcome;
  duration_seconds: number;
  started_at: string;
  ended_at: string | null;
};

/**
 * Audit-2 L45: TURN configuration status, derived from the three
 * VITE_TURN_* vars. NEVER returns the credential value — only whether
 * one is set (the credential ships in the public JS bundle, so it
 * must be treated as public; see .env.example).
 */
export type TurnStatus = {
  /** All three vars set — TURN is actually used. */
  configured: boolean;
  /** Some-but-not-all vars set — the client silently ran STUN-only. */
  partial: boolean;
  /** Names of the vars that are missing (empty when none missing). */
  missing: ("VITE_TURN_URLS" | "VITE_TURN_USERNAME" | "VITE_TURN_CREDENTIAL")[];
  urls: string[];
  hasUsername: boolean;
  hasCredential: boolean;
};

export function getTurnStatus(): TurnStatus {
  const urls = (import.meta.env.VITE_TURN_URLS as string | undefined)
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean) ?? [];
  const hasUsername = Boolean(import.meta.env.VITE_TURN_USERNAME as string | undefined);
  const hasCredential = Boolean(import.meta.env.VITE_TURN_CREDENTIAL as string | undefined);
  const setCount = [urls.length > 0, hasUsername, hasCredential].filter(Boolean).length;
  const missing: TurnStatus["missing"] = [];
  if (urls.length === 0) missing.push("VITE_TURN_URLS");
  if (!hasUsername) missing.push("VITE_TURN_USERNAME");
  if (!hasCredential) missing.push("VITE_TURN_CREDENTIAL");
  return {
    configured: setCount === 3,
    partial: setCount > 0 && setCount < 3,
    missing,
    urls,
    hasUsername,
    hasCredential,
  };
}

let turnPartialWarned = false;

// Audit-4 L21: a partial TURN config used to fail silently
// (STUN-only, no diagnostic) — Audit-2 L45 made it warn LOUDLY
// in the console, but console-only is invisible to the user, who
// got a silent call failure behind symmetric NAT. The engine
// method below ALSO fires onTurnPartial so the provider toasts
// it (once per process, like the console warn — the config
// cannot change mid-session, and a toast per call would spam).
// (Not at module import / engine construction: the warn belongs
// to the moment a call actually needs the relay.)

/**
 * H29: ICE servers — STUN always, TURN when configured via env (never
 * hardcoded). Without TURN, calls fail when both peers are behind
 * symmetric NAT / restrictive carrier NAT (common on mobile data):
 * STUN-only ICE finds no path and the call never connects. TURN is the
 * relay fallback (tried after P2P, so it never hurts a P2P call).
 * Set VITE_TURN_URLS (comma-separated), VITE_TURN_USERNAME,
 * VITE_TURN_CREDENTIAL. Free options: Metered OpenRelay (public,
 * no card) or Cloudflare Calls TURN.
 * Audit-2 L45: the credential ships in the public JS bundle by design
 * (client-side TURN is inherently public) — operators must use a
 * restricted / rate-limited credential only. Ephemeral server-minted
 * TURN credentials (time-limited HMAC, the preferred shape) are NOT
 * yet implemented — the static credential remains until then.
 */
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  const status = getTurnStatus();
  if (status.configured) {
    servers.push({
      urls: status.urls,
      username: import.meta.env.VITE_TURN_USERNAME as string,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string,
    });
  }
  return servers;
}

const ICE_SERVERS: RTCIceServer[] = buildIceServers();

const RING_TIMEOUT_MS = 30_000;
// Audit-5 B3-MEDIUM: offer-request carries no MAC-able payload and
// `from` is self-asserted, so a row-verified request can still be a
// channel peer impersonating the callee during a live ring — bound
// the churn to one re-send per call per this window. The genuine
// flow asks once per pickup attempt and waits 5s for the offer
// (waitForOffer); a re-sent offer already in flight serves a
// duplicate ask, so dropping repeats inside the window loses
// nothing.
const OFFER_RESEND_COOLDOWN_MS = 5_000;
// Audit-2 M38: how long a sibling remembers a callId taken in
// another tab (a call never lives this long; the entry is only for
// dropping duplicate invite redeliveries).
const TAKEN_TTL_MS = 5 * 60 * 1000;
// M24: cap the pre-answer ICE candidate buffer. A real call produces
// a handful of candidates (typically 5-15); 50 is generous headroom.
const MAX_PENDING_ICE = 50;

/** Exported so the provider can mint the callId BEFORE starting the call —
 * the invite row must be written (createCallInvite) before the Realtime
 * invite signal goes out, or the callee's server-side verification (C4)
 * would find no row and drop a real call. */
export function newCallId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `call-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

/** Persist one history row for the current user. Non-fatal (calls still
 *  work when history can't be saved), but failures are LOGGED — the old
 *  code swallowed everything, including the Supabase `{error}` object,
 *  so lost call history was invisible. */
async function recordCallRow(row: Omit<CallRecord, "id">): Promise<void> {
  try {
    const { error } = await supabase.from("calls").insert(row);
    // M19: check the returned error object — supabase-js returns
    // {error} instead of throwing, and the old code discarded it.
    if (error) console.warn("[calls] recordCallRow failed:", error.message);
  } catch (err) {
    // M19: log instead of swallowing (e.g. table missing, RLS, DB down).
    console.warn("[calls] recordCallRow failed:", err);
  }
}

export async function listCalls(opts?: {
  limit?: number;
  cursor?: string | null;
}): Promise<{ calls: CallRecord[]; nextCursor: string | null }> {
  // M19: THROW on error instead of returning [] — the old code made a
  // failure (missing table / RLS / DB down) indistinguishable from
  // genuinely empty history. Callers render a distinct error state.
  // Audit-2 L49: bounded cursor pages (was a hard .limit(50) with no
  // way to see older history). Cursor is opaque
  // `<started_at>|<id>` from the previous page's nextCursor; the
  // keyset condition (started_at, id) keeps ties deterministic —
  // same shape as listRooms (A8-N30). Default 50, as before.
  const limit = opts?.limit ?? 50;
  let cursorOr: string | null = null;
  if (opts?.cursor) {
    const [t, id] = opts.cursor.split("|");
    if (
      !t ||
      !id ||
      Number.isNaN(Date.parse(t)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ) {
      throw new Error("Invalid cursor.");
    }
    cursorOr = `started_at.lt.${t},and(started_at.eq.${t},id.lt.${id})`;
  }
  let q = supabase
    .from("calls")
    .select("*")
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (cursorOr) q = q.or(cursorOr);
  const { data, error } = await q;
  if (error) {
    console.warn("[calls] listCalls failed:", error.message);
    throw error;
  }
  const fetched = (data ?? []) as CallRecord[];
  const hasMore = fetched.length > limit;
  const page = fetched.slice(0, limit);
  return {
    calls: page,
    nextCursor: hasMore ? `${page[page.length - 1].started_at}|${page[page.length - 1].id}` : null,
  };
}

/** Small two-tone ringtone via WebAudio — no audio asset needed. */
class Ringer {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Audit-2 L46: vibration runs on its OWN timer, independent of
  // AudioContext — a browser without AudioContext (or where its
  // construction throws) used to return before any timer was set,
  // so the phone neither rang nor buzzed.
  private vibrateTimer: ReturnType<typeof setInterval> | null = null;

  /** Incoming ring: two short high beeps, every 1.4s. */
  async start() {
    await this.startPattern({
      freq: 880,
      offsets: [0, 0.25],
      interval: 1400,
      beepLen: 0.22,
      // M28: vibrate with the ring — when the tab is visible the SW
      // push is suppressed, so the push payload's vibrate never
      // fires and a foreground incoming call would be ringtone-only.
      // Same pattern as the push payload (1.3s, just under the 1.4s
      // beep interval, so each beep re-triggers it = continuous pulse).
      vibrate: [200, 100, 200, 100, 200, 100, 400],
    });
  }

  // M26: caller-side ringback — a single longer low tone, every 2s, so
  // the caller hears "ringing" (and can tell it apart from being
  // called) until accept/decline/timeout. Distinct from the incoming
  // ring so the caller never mistakes it for an incoming call.
  // No vibration: the caller already knows they're calling.
  async startRingback() {
    await this.startPattern({ freq: 440, offsets: [0], interval: 2000, beepLen: 1.0 });
  }

  private async startPattern(pattern: {
    freq: number;
    offsets: number[];
    interval: number;
    beepLen: number;
    vibrate?: number[];
  }) {
    // Audit-2 L46: start vibration FIRST, on its own timer, before
    // touching AudioContext — if AC is missing or its construction
    // throws below, the phone still buzzes. The double-start guard
    // covers both timers (a vibration-only start leaves `timer`
    // null, so the guard must also check `vibrateTimer`).
    if (this.timer || this.vibrateTimer) return;
    const vibratePattern = pattern.vibrate;
    if (vibratePattern) {
      const buzz = () => {
        try {
          navigator.vibrate?.(vibratePattern);
        } catch {
          /* vibration unavailable */
        }
      };
      this.vibrateTimer = setInterval(buzz, pattern.interval);
      buzz();
    }
    try {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return; // Audio unavailable — vibration above keeps going.
      this.ctx = new AC();
      // H28: browsers start an AudioContext "suspended" without a prior
      // user gesture — beeps scheduled on a suspended context are silent
      // while the UI claims the phone is ringing. Resume before the
      // first beep. (Callers fire-and-forget start(), so async is safe.)
      // The timer is set synchronously BEFORE the await so a second
      // start() in the resume gap still hits the double-start guard;
      // stop() clears it + nulls ctx, so the post-await ctx check below
      // aborts an in-flight start that stop() already cancelled.
      const beep = () => {
        if (!this.ctx) return;
        // Audit-2 L46: no vibration here anymore — it runs on its
        // own timer above (see startPattern), so a missing
        // AudioContext can't silence the buzz.
        const t = this.ctx.currentTime;
        for (const offset of pattern.offsets) {
          const osc = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = pattern.freq;
          gain.gain.setValueAtTime(0.0001, t + offset);
          gain.gain.exponentialRampToValueAtTime(0.12, t + offset + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + pattern.beepLen);
          osc.connect(gain).connect(this.ctx.destination);
          osc.start(t + offset);
          osc.stop(t + offset + pattern.beepLen + 0.05);
        }
      };
      this.timer = setInterval(beep, pattern.interval);
      await this.ctx.resume().catch(() => undefined);
      if (!this.ctx) return; // stop() ran while we awaited resume.
      beep();
    } catch {
      /* audio unavailable */
    }
  }

  stop() {
    try {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      // Audit-2 L46: stop the vibration timer too.
      if (this.vibrateTimer) clearInterval(this.vibrateTimer);
      this.vibrateTimer = null;
      void this.ctx?.close().catch(() => undefined);
      this.ctx = null;
      // M28: cancel any ongoing vibration (vibrate(0) stops it).
      try {
        navigator.vibrate?.(0);
      } catch {
        /* vibration unavailable */
      }
    } catch {
      /* ignore */
    }
  }
}

export type CallAction = "accept" | "decline" | "end";

export type CallState = {
  status: CallStatus;
  type: CallType;
  direction: CallDirection;
  peerId: string;
  peerName: string;
  callId: string | null;
  isMuted: boolean;
  isVideoOn: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** Seconds since the call connected (0 while ringing/calling). */
  elapsedSeconds: number;
  /**
   * Audit-3 A5-N7: true while a video upgrade tapped during
   * calling/ringing is queued (no camera track exists yet). The
   * overlay shows the Video button as pending and tapping it
   * cancels the queue. Cleared on apply / cancel / finish.
   */
  videoUpgradeQueued: boolean;
  /**
   * Audit-2 C2: true when this call runs in the DEGRADED mode — the
   * call_invites table positively does not exist, so no signal could
   * be verified. The overlay shows a persistent banner while true.
   * Cleared by the IDLE_STATE reset in finish().
   */
  verificationDegraded: boolean;
  /**
   * Audit-2 M35: which call action is currently in flight (null =
   * none). The overlay disables the running action's button and
   * shows a busy label instead of silently dropping the tap.
   * End/Decline stay enabled while an accept is in flight — they
   * pre-empt it (acceptCancelled) instead of being swallowed.
   */
  actionPending: CallAction | null;
};

/** Fired once per finished call so the provider can post the chat entry. */
export type CallFinishedInfo = {
  callId: string;
  peerId: string;
  peerName: string;
  type: CallType;
  direction: "incoming" | "outgoing";
  status: CallOutcome;
  durationSeconds: number;
};

/**
 * Server-side signal verification callbacks (C4, policy tightened by
 * audit-2 C2). The Realtime channel is public, so `signal.from` is
 * self-asserted and spoofable — the engine must not trust it. The
 * provider implements these with server fns (call_invites row =
 * server-side truth):
 * - verifyInvite: the invite row must exist, be ringing + fresh, with
 *   caller == signal.from and matching type. Returns the server's
 *   caller_name (never trust the signal's fromName) + the per-call HMAC
 *   secret + whether the table positively does not exist.
 * - verifyCallStatus: the invite row's status must equal the expected
 *   event AND signal.from must be the other participant. Returns
 *   tableMissing so the engine can tell "no table" apart from "no".
 * - reportCallEvent: write accepted/declined/ended to the invite row
 *   BEFORE sending the matching signal (best-effort).
 *
 * Audit-2 C2 policy — three outcomes, never conflated:
 * - VERIFIED (server confirmed) -> proceed.
 * - REFUTED (server said no / mismatch) -> drop.
 * - UNKNOWN (the verification call itself threw: network / 500 /
 *   timeout) -> ONE retry, then FAIL CLOSED (drop). "The server could
 *   not be reached" is not "the server approved".
 * The ONLY fail-open case is a positively confirmed missing table
 * (tableMissing): the call proceeds in the degraded mode, with the
 * persistent banner (CallState.verificationDegraded) — never silent.
 */
export type CallVerification = {
  verifyInvite: (
    callId: string,
    from: string,
    type: CallType,
  ) => Promise<{
    ok: boolean;
    fromName: string | null;
    // Audit-2 C1: the per-call HMAC secret from the invite row (callee
    // side). The engine caches it and uses it to verify offer/answer/
    // ice MACs. NULL when the row predates the §C1 SQL -> fail closed.
    secret?: string | null;
    // True when the call_invites table positively does not exist:
    // the whole call runs in the degraded, unverified mode (C2 owns
    // the retry + banner policy; C1 only plumbs the flag).
    tableMissing?: boolean;
  }>;
  verifyCallStatus: (
    callId: string,
    expectedStatus: "accepted" | "declined" | "ended" | "ringing",
    expectedFrom: string,
    myId: string,
  ) => Promise<{ ok: boolean; tableMissing: boolean }>;
  reportCallEvent: (
    callId: string,
    event: "accepted" | "declined" | "ended",
  ) => Promise<{
    ok: boolean;
    applied: boolean;
    terminal: boolean;
    // Audit-2 M38: true when an "accepted" report landed on a row
    // already "accepted" — another tab took the call. The loser
    // unwinds quietly instead of going in-call.
    alreadyAccepted?: boolean;
  }>;
};

/**
 * Audit-2 C1 — payload authentication for offer/answer/ice.
 *
 * Threat: the Realtime channel is public and `from` is self-asserted,
 * so anyone who saw a real invite (callId + peer ids are broadcast)
 * could send a spoofed `offer` with `from = <real peer>` and the engine
 * would call setRemoteDescription(attacker SDP) — the victim's media
 * then flows to the attacker (DTLS fingerprint in the attacker's SDP
 * matches the attacker's own certificate, so the handshake succeeds).
 * Row-existence checks do NOT stop this: a spoofed signal claims the
 * real peer's id, and the row genuinely exists between me and that
 * peer. Only a secret shared by exactly the two participants can
 * authenticate the payload.
 *
 * Mechanism: the server generates one random 256-bit secret per call
 * (see createCallInvite) and stores it on the invite row, whose SELECT
 * policy is participant-only. Every offer/answer/ice carries
 * HMAC-SHA256(secret, callId || kind || canonicalJson(payload)). The
 * receiver verifies before touching the PeerConnection.
 *
 * Canonicalization: JSON with recursively sorted object keys, so the
 * sender's stringify and the receiver's stringify of the same parsed
 * payload always agree (plain JSON.stringify depends on key order,
 * which a JSON round-trip could in principle change).
 */
function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Audit-4 M8: canonicalJson must be JSON-round-trip-stable — the
 * sender MACs the ORIGINAL object, the receiver MACs the object
 * AFTER the Realtime broadcast's JSON round-trip. JSON.stringify
 * DROPS undefined-valued (and function/symbol-valued) object keys
 * and maps undefined array elements to null — but the old code
 * emitted `"key":undefined` for an undefined key, so a sender-side
 * RTCIceCandidateInit with `usernameFragment: undefined` (what
 * toJSON() produces when the fragment is absent) MAC'd differently
 * from the receiver's key-dropped copy, and legitimate ICE was
 * dropped as a MAC mismatch. Now the same drop/null rules as
 * JSON.stringify apply, so both sides agree on every payload.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => {
      const v = obj[k];
      return v !== undefined && typeof v !== "function" && typeof v !== "symbol";
    })
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export async function computeSignalMac(
  secret: string,
  kind: "offer" | "answer" | "ice",
  callId: string,
  payload: unknown,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64urlDecode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msg = new TextEncoder().encode(`${callId}\n${kind}\n${canonicalJson(payload)}`);
  const sig = await crypto.subtle.sign("HMAC", key, msg);
  return b64urlEncode(new Uint8Array(sig));
}

export async function verifySignalMac(
  secret: string | null | undefined,
  kind: "offer" | "answer" | "ice",
  callId: string,
  payload: unknown,
  mac: string | undefined,
): Promise<boolean> {
  if (!secret || !mac) return false;
  try {
    const expected = b64urlDecode(await computeSignalMac(secret, kind, callId, payload));
    const actual = b64urlDecode(mac);
    if (actual.length !== expected.length) return false;
    // Audit-6 C-N5: constant-time compare — the old `===`
    // early-exited on the first differing character, leaking match
    // progress in principle. (Practical exploitability over
    // Realtime jitter is nil; this is cheap hardening.) Byte length
    // is not secret: HMAC-SHA256 output is always 32 bytes.
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
    return diff === 0;
  } catch {
    return false;
  }
}

export const IDLE_STATE: CallState = {
  status: "idle",
  type: "voice",
  direction: "outgoing",
  peerId: "",
  peerName: "",
  callId: null,
  isMuted: false,
  isVideoOn: false,
  localStream: null,
  remoteStream: null,
  elapsedSeconds: 0,
  verificationDegraded: false,
  actionPending: null,
  videoUpgradeQueued: false,
};

/**
 * Imperative call engine. One instance per app (owned by CallProvider).
 * Listeners get a snapshot of CallState on every change.
 */
export class CallEngine {
  private myId: string;
  private myName: string;
  private listeners = new Set<(s: CallState) => void>();
  private state: CallState = { ...IDLE_STATE };
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  // M25: video-upgrade tapped before the call connected (during
  // calling/ringing). Applied when the call reaches in-call.
  private pendingVideoUpgrade = false;
  // Audit-2 L44: mirror of pendingVideoUpgrade — a video-OFF queued
  // while "calling" (see setVideoEnabled), applied at the first
  // in-call renegotiation.
  private pendingVideoDowngrade = false;
  // Audit-2 M34: renegotiation failure bookkeeping — a failed
  // re-offer used to be swallowed while the UI claimed video was
  // on. One retry, then revert + surface (see
  // handleRenegotiateFailure). Cleared with the other timers.
  private renegotiateFailures = 0;
  private renegotiateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // H30: an offer that arrived before its invite (Realtime delivery
  // order isn't guaranteed). Buffered instead of dropped; the invite
  // handler applies it once the invite is server-verified. The MAC
  // rides along and is verified at APPLY time (the secret is only
  // known once the invite is verified) — never at buffer time.
  private pendingOffer: {
    callId: string;
    from: string;
    sdp: RTCSessionDescriptionInit;
    mac?: string;
  } | null = null;
  // Audit-5 B3-MEDIUM: per-call offer-request re-send cooldown —
  // row verification can't tell the genuine callee from an
  // impersonator, so at most one re-sent offer per call per
  // OFFER_RESEND_COOLDOWN_MS.
  private lastOfferResendCallId: string | null = null;
  private lastOfferResendAt = 0;
  // Audit-6 C-N2: at most one M37 end-verification re-check per
  // call per window (see the `end` branch).
  private lastEndRecheckCallId: string | null = null;
  private lastEndRecheckAt = 0;
  // Audit-2 C1: per-call HMAC secret (server-generated, invite row).
  // Caller: set by startCall from createCallInvite's return. Callee:
  // set by the invite handler from verifyInvite's return. Cleared in
  // teardownPeer — a stale secret must never authenticate a new call.
  private callSecret: string | null = null;
  // Audit-2 C1/C2: true only when the call_invites table positively
  // does not exist (verifyInvite reported tableMissing). In that
  // degraded mode there is no secret and no verification at all —
  // C2 owns the banner + retry policy. In every other mode a payload
  // signal without a valid MAC is dropped.
  private signalAuthDegraded = false;
  // Set when the callee picked the call from the push notification while the
  // app was closed: once the re-sent offer lands, accept automatically.
  private pendingAutoAction: "accept" | "decline" | null = null;
  private channels = new Map<string, ReturnType<typeof supabase.channel>>();
  // Audit-2 L47: ONE shared subscribe-wait per peer channel. The old
  // sendSignal attached its own subscribe + 2s timeout per send, so a
  // burst of ICE candidates stacked N subscribes and each send waited
  // up to 2s in series. Concurrent sends now share one promise; it is
  // dropped once settled so a later send re-waits fresh if the
  // channel still isn't joined (subscribe failed silently).
  private channelReady = new Map<string, Promise<void>>();
  // Audit-2 L50: waiters for the offer acceptCall is waiting on.
  // The old code polled `pc.remoteDescription` every 100ms; now an
  // offer landing (either apply site below) wakes the waiter
  // immediately, and teardownPeer wakes it on unwind — the 100ms
  // poll is gone. The deadline itself is still wall-clock
  // (Date.now), enforced by waitForOffer's re-arming timer chain.
  private offerWaiters = new Set<() => void>();
  // Audit-4 L19: the last offer setRemoteDescription failure
  // (invalid SDP with a valid MAC — the caller signed a broken
  // offer, or an SDP incompatibility). acceptCall throws this
  // instead of the wrong "Offer never arrived" when the offer DID
  // arrive but could not be applied. Cleared on a successful
  // apply (offer-request recovery re-sent a good offer) and in
  // teardownPeer (fresh call = fresh state).
  private offerApplyError: Error | null = null;
  private ownChannel: ReturnType<typeof supabase.channel> | null = null;
  // Audit-4 M9: pending incoming-channel subscribe retry (cleared in
  // stop() — a torn-down engine must never resubscribe).
  private ownChannelRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // Audit-2 M38: cross-tab coordination. Every tab subscribes the
  // same `call:<userId>` channel, so every tab rings for an incoming
  // call — without this, tab 1 accepting left tab 2 ringing 30s, and
  // both tabs could accept (two answers, media flip). The first tab
  // to take a call broadcasts `call-taken`; siblings quietly reset
  // (no report/signal/history — the taking tab owns the call).
  // BroadcastChannel never echoes to the sender. Guarded for SSR /
  // old browsers (no channel = single-tab behaviour).
  private tabChannel: BroadcastChannel | null = null;
  // Audit-2 M38: callIds already taken in another tab (from
  // `call-taken`), with the time seen. A duplicate invite redelivery
  // for a taken call is dropped instead of re-ringing. Pruned after
  // TAKEN_TTL_MS (a call never lives that long).
  private takenCallIds = new Map<string, number>();
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  // Audit-3 A5-N1: caller-side watchdog — in-call via the accept
  // signal but no answer (remote description) within 10s. The ICE
  // watchdog never fires here: with no remote description the
  // connectionState stays "new" and no event fires. Cleared in
  // clearTimers() (every exit) + when the answer lands.
  private answerWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  // H31: ICE recovery — grace timer + one restartIce() attempt per call.
  // A 1–2s network blip (Wi-Fi ↔ mobile handover, tunnel) must not kill
  // the call instantly. Reset in createPeer (new call = fresh attempt).
  private iceRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestartAttempted = false;
  // H32: double-tap guard for accept/decline/end. All three await
  // (getUserMedia, signals) while status is still "ringing"/"in-call",
  // so a second tap (or notification-tap + overlay-tap) would run the
  // body twice (double getUserMedia + double answer, double decline +
  // double finish). First tap wins; the flag clears in `finally`.
  // Audit-2 M35: the guard is now the ACTION NAME (null = none),
  // mirrored into state.actionPending for the overlay's busy UI.
  // End/Decline PRE-EMPT an in-flight accept (acceptCancelled) —
  // the old boolean silently dropped them while accept waited on
  // the getUserMedia permission prompt, then the accept completed
  // and the user was suddenly in-call. The pre-empting action takes
  // over the guard; the accept's `finally` only clears the guard it
  // still owns.
  private actionInProgress: CallAction | null = null;
  // Audit-2 M35: set by End/Decline when they pre-empt an in-flight
  // accept — the accept unwinds at its next checkpoint (and stops
  // any just-granted tracks) instead of resurrecting the call.
  // Reset at every acceptCall entry.
  private acceptCancelled = false;
  private connectedAt = 0;
  private startedAtIso = "";
  private ringer = new Ringer();
  private started = false;
  private onCallFinished: ((info: CallFinishedInfo) => void) | null = null;
  private verify: CallVerification | null = null;
  // Audit-2 C2: fired when an invite is dropped because verification
  // itself failed (unknown, not refuted) — the provider toasts
  // "Couldn't verify caller" so the silent drop is user-visible.
  private onUnverifiedInvite: (() => void) | null = null;
  // Audit-2 M34: fired when a video toggle's re-offer failed twice
  // (after one retry) — the provider toasts so the UI never claims
  // video is on when the peer never got it.
  private onVideoToggleFailed: ((direction: "on" | "off") => void) | null = null;
  // Audit-4 L21: fired when the TURN config is PARTIAL (some but
  // not all of URLS/USERNAME/CREDENTIAL set) — the provider
  // toasts it. Console-only warning was invisible to the user,
  // who got a silent call failure behind symmetric NAT.
  private onTurnPartial: ((missing: TurnStatus["missing"]) => void) | null = null;

  constructor(
    myId: string,
    myName: string,
    opts?: {
      onCallFinished?: (info: CallFinishedInfo) => void;
      verify?: CallVerification;
      onUnverifiedInvite?: () => void;
      // Audit-2 M34: a video toggle whose re-offer failed twice
      // (after one retry) — the provider surfaces it as a toast.
      onVideoToggleFailed?: (direction: "on" | "off") => void;
      // Audit-4 L21: partial TURN config — the provider surfaces
      // it as a toast (console-only was invisible to the user).
      onTurnPartial?: (missing: TurnStatus["missing"]) => void;
    },
  ) {
    this.myId = myId;
    this.myName = myName;
    this.onCallFinished = opts?.onCallFinished ?? null;
    this.verify = opts?.verify ?? null;
    this.onUnverifiedInvite = opts?.onUnverifiedInvite ?? null;
    this.onVideoToggleFailed = opts?.onVideoToggleFailed ?? null;
    this.onTurnPartial = opts?.onTurnPartial ?? null;
  }

  get snapshot(): CallState {
    return { ...this.state };
  }

  /**
   * Audit-4 L18: true when the in-flight accept was pre-empted by
   * the user's own Decline/End. The overlay reads this in its
   * accept catch to SUPPRESS the "Could not answer" toast — a
   * pre-empted accept's failure is moot (the call already ended
   * deliberately). Reset at every acceptCall entry; only
   * meaningful while/just after an accept is in flight.
   */
  get acceptWasCancelled(): boolean {
    return this.acceptCancelled;
  }

  subscribe(fn: (s: CallState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  /** Start listening for incoming calls. Call once after login. */
  start() {
    if (this.started) return;
    this.started = true;
    // Audit-2 M38: cross-tab coordination (see tabChannel field).
    if (typeof BroadcastChannel !== "undefined") {
      try {
        this.tabChannel = new BroadcastChannel("vibetalk-call");
        this.tabChannel.onmessage = (e) => {
          const d = e.data as { type?: unknown; callId?: unknown } | null;
          if (d?.type === "call-taken" && typeof d.callId === "string" && d.callId) {
            this.takenCallIds.set(d.callId, Date.now());
            this.handleSiblingTaken(d.callId);
          }
        };
      } catch {
        this.tabChannel = null;
      }
    }
    this.ownChannel = this.channelFor(this.myId);
    this.ownChannel.on("broadcast", { event: "call-signal" }, (msg) => {
      const signal = (msg as { payload?: CallSignal }).payload;
      if (signal) void this.handleSignal(signal);
    });
    this.subscribeOwnChannel();
  }

  /**
   * Audit-4 M9: (re)subscribe the incoming-call channel with
   * bounded exponential backoff. A failed subscribe used to be
   * final — the app looked fine but no invite could ever arrive
   * until a full reload. Retries run only while the engine is
   * started; stop() clears any pending retry (and nulls
   * ownChannel), so a torn-down engine is never resurrected by a
   * CLOSED callback from its own teardown. Backoff: 1s, 2s, 4s,
   * 8s, 16s, then 30s — a transient blip recovers in a second; a
   * dead socket doesn't spin. No attempt cap: the engine stays
   * started for the whole session, so giving up would reintroduce
   * the original bug (silently deaf until reload).
   */
  private subscribeOwnChannel(attempt = 0): void {
    const ch = this.ownChannel;
    if (!ch || !this.started) return;
    void ch.subscribe((status) => {
      if (status === "SUBSCRIBED") return;
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        console.warn(`[calls] incoming-call channel subscribe failed: ${status} — retrying`);
        // Retry only if this channel is still the engine's own
        // channel and the engine is still started.
        if (!this.started || this.ownChannel !== ch) return;
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        if (this.ownChannelRetryTimer) clearTimeout(this.ownChannelRetryTimer);
        this.ownChannelRetryTimer = setTimeout(() => {
          this.ownChannelRetryTimer = null;
          this.subscribeOwnChannel(attempt + 1);
        }, delay);
      }
    });
  }

  stop() {
    // Audit-2 M37: hang up BEFORE tearing down the channels — the
    // unload hangup needs the live peer channel for its sync `end`.
    // Covers logout + unmount; pagehide calls hangupOnUnload()
    // directly (the page is dying anyway, no teardown needed).
    this.hangupOnUnload();
    // Audit-2 M38: a dying tab's call is taken (ended) — tell
    // siblings to stop ringing it instead of timing out at 30s.
    this.broadcastTaken(this.state.callId);
    // Audit-2 M38: close the cross-tab channel.
    try {
      this.tabChannel?.close();
    } catch {
      /* ignore */
    }
    this.tabChannel = null;
    this.started = false;
    // Audit-4 M9: cancel any pending incoming-channel subscribe
    // retry — a stopped engine must never resubscribe.
    if (this.ownChannelRetryTimer) clearTimeout(this.ownChannelRetryTimer);
    this.ownChannelRetryTimer = null;
    this.ringer.stop();
    this.clearTimers();
    for (const ch of this.channels.values()) {
      try {
        void supabase.removeChannel(ch);
      } catch {
        /* ignore */
      }
    }
    this.channels.clear();
    // Audit-2 L47: drop any in-flight shared subscribe-waits with
    // the channels they belonged to (a stop()ed engine never sends
    // again; a restarted engine waits fresh).
    this.channelReady.clear();
    this.ownChannel = null;
    void this.teardownPeer();
  }

  /**
   * Audit-2 M38: tell sibling tabs this call is taken (accepted,
   * declined, ended, or timed out). Siblings quietly reset — they
   * send no report/signal and write no history row; this tab owns
   * the call. No-op without a callId or without a channel.
   */
  private broadcastTaken(callId: string | null): void {
    if (!callId) return;
    // Audit-2 M39: record locally too — BroadcastChannel never
    // echoes to the sender, so without this a duplicate invite for
    // a call THIS tab declined would hit the server again (a
    // terminal no-op report) instead of being dropped at the
    // taken-check.
    this.takenCallIds.set(callId, Date.now());
    if (!this.tabChannel) return;
    try {
      this.tabChannel.postMessage({ type: "call-taken", callId });
    } catch {
      /* best-effort — a closed channel must not break the call */
    }
  }

  /** Audit-2 M38: has this callId been taken in another tab (fresh)? */
  private isCallTaken(callId: string): boolean {
    const now = Date.now();
    for (const [id, at] of this.takenCallIds) {
      if (now - at > TAKEN_TTL_MS) this.takenCallIds.delete(id);
    }
    return this.takenCallIds.has(callId);
  }

  /**
   * Audit-2 M38: QUIET reset — stop ringing and go back to idle
   * WITHOUT reporting, signalling, or writing history (the tab that
   * took the call owns all of those). Used by handleSiblingTaken
   * (BroadcastChannel) and by the already-accepted unwind in
   * acceptCall. An in-flight accept in this tab unwinds at its M35
   * checkpoints (status is no longer "ringing").
   */
  private quietReset(): void {
    this.ringer.stop();
    this.clearTimers();
    this.pendingAutoAction = null;
    void this.teardownPeer();
    this.set({ ...IDLE_STATE });
  }
  /** Audit-2 M38: a sibling tab took the call this tab is ringing —
   * quiet-reset it (never yanks an in-call / outgoing call). */
  private handleSiblingTaken(callId: string): void {
    if (this.state.callId !== callId) return;
    if (this.state.status !== "ringing") return;
    this.quietReset();
  }

  private channelFor(userId: string) {
    let ch = this.channels.get(userId);
    if (!ch) {
      // Audit-2 H15 (KNOWN RESIDUAL — read before "fixing" this):
      // this channel is PUBLIC — any authenticated client can publish
      // to any `call:<userId>`, so a stranger can send a direct
      // Realtime invite that never touches the server gate
      // (assertCanCall runs only in createCallInvite/notifyIncomingCall).
      // The defence is the C2 fail-closed verification in
      // processSignal/verifyInviteSignal: an invite with NO server row
      // is DROPPED (no ring, no attacker-chosen name shown), even when
      // verification itself flakes (one retry, then fail closed).
      // Refuted drops are SILENT by design — a toast per spoofed invite
      // would be a toast-spam vector. Only the UNVERIFIED drop (a real
      // call possibly lost to a network failure) toasts (C2).
      // Transport-layer gating (Supabase Realtime Authorization: RLS
      // policies on realtime.messages + `config: { private: true }` on
      // every channel + the dashboard "Allow public access" toggle OFF)
      // could restrict publishing to the two participants, but it is
      // all-or-nothing, duplicates assertCanCall in SQL (no rate
      // limits), and a wrong policy breaks ALL realtime (calls + any
      // broadcast). It is NOT shipped — it needs a staging test with
      // two real clients before anyone enables it.
      ch = supabase.channel(`call:${userId}`);
      this.channels.set(userId, ch);
    }
    return ch;
  }

  /** Wake every acceptCall offer-waiter (offer landed or call unwound). */
  private notifyOfferWaiters(): void {
    for (const wake of [...this.offerWaiters]) wake();
    this.offerWaiters.clear();
  }

  /**
   * Audit-2 L50: wait for the offer to land (remoteDescription set)
   * or the call to unwind, until the wall-clock deadline. Event-
   * driven: notifyOfferWaiters resolves the promise the moment the
   * offer applies or teardownPeer runs. The deadline is enforced by
   * a re-arming setTimeout chain (a single throttled 5s timer in a
   * background tab fires late, so the chain re-checks the deadline
   * instead of trusting one timer).
   */
  private waitForOffer(deadlineMs: number): Promise<void> {
    return new Promise((resolve) => {
      // Fast path: already arrived, already unwound, already
      // pre-empted, or the offer already FAILED (Audit-4 L19 — a
      // parked waiter after a failed apply could only resolve at
      // the deadline; acceptCall throws the recorded cause).
      if (!this.pc || this.pc.remoteDescription || this.state.status !== "ringing" || this.acceptCancelled || this.offerApplyError) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        this.offerWaiters.delete(onWake);
      };
      const onWake = () => {
        cleanup();
        resolve();
      };
      const arm = () => {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) {
          cleanup();
          resolve();
          return;
        }
        timer = setTimeout(() => {
          timer = null;
          arm();
        }, Math.min(remaining, 1000));
      };
      this.offerWaiters.add(onWake);
      arm();
    });
  }

  /**
   * Shared subscribe-wait for one peer channel (Audit-2 L47 — see
   * the channelReady field). Resolves on SUBSCRIBED or after a 2s
   * cap (a silent subscribe failure must not hang the send forever).
   */
  private waitChannelReady(userId: string, ch: ReturnType<typeof supabase.channel>): Promise<void> {
    const status = (ch as unknown as { state?: string }).state;
    if (status === "joined") return Promise.resolve();
    let ready = this.channelReady.get(userId);
    if (!ready) {
      ready = new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        try {
          void ch.subscribe((s) => {
            if (s === "SUBSCRIBED") finish();
          });
          setTimeout(finish, 2000);
        } catch {
          finish();
        }
      });
      this.channelReady.set(userId, ready);
      void ready.then(() => {
        if (this.channelReady.get(userId) === ready) this.channelReady.delete(userId);
      });
    }
    return ready;
  }

  /**
   * Send a signal to the peer. Returns true if the broadcast was
   * delivered ("ok"). H33: the result used to be ignored — a failed
   * send dropped the invite/offer silently while the UI showed
   * "Calling…" for 30s. Callers that must fail fast (startCall's
   * invite, acceptCall's accept/answer) check the return and throw;
   * best-effort callers (decline/end) just let the warn + the peer's
   * own detection handle it.
   */
  private async sendSignal(toUserId: string, signal: CallSignal): Promise<boolean> {
    const ch = this.channelFor(toUserId);
    // broadcast send needs a subscribed channel — wait for SUBSCRIBED
    // via the shared per-channel promise (Audit-2 L47).
    await this.waitChannelReady(toUserId, ch);
    // Audit-2 C1: authenticate the payload. Only offer/answer/ice carry
    // SDP/ICE (media-directing payload); invite/accept/decline/end/
    // offer-request are verified against the server row instead (C4).
    // No secret (table missing / pre-fix row) -> send without a MAC;
    // the receiver drops it unless the call is in degraded mode.
    if (signal.kind === "offer" || signal.kind === "answer" || signal.kind === "ice") {
      const payload = signal.kind === "ice" ? signal.candidate : signal.sdp;
      if (this.callSecret) {
        let mac: string;
        try {
          mac = await computeSignalMac(this.callSecret, signal.kind, signal.callId, payload);
        } catch (err) {
          // Audit-3 A5-N13: a MAC-compute failure must fail the send.
          // The old code sent the payload WITHOUT a mac and the peer
          // dropped it silently — the caller rang on with no
          // diagnostic pointing at the real cause. No secret at all
          // (degraded / pre-fix row) still sends unsigned below, as
          // before — the receiver drops it unless degraded.
          console.warn(`[calls] signal (${signal.kind}) MAC compute failed — not sending unauthenticated`, err);
          return false;
        }
        signal = { ...signal, mac };
      }
    }
    const result = await ch.send({ type: "broadcast", event: "call-signal", payload: signal });
    if (result !== "ok") {
      console.warn(`[calls] signal (${signal.kind}) not delivered: ${result}`);
      return false;
    }
    return true;
  }

  private clearTimers() {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = null;
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    if (this.iceRecoveryTimer) clearTimeout(this.iceRecoveryTimer);
    this.iceRecoveryTimer = null;
    // Audit-3 A5-N1: the answer watchdog must not fire after teardown
    // (it would finish() a NEW call) — every exit goes through here.
    if (this.answerWatchdogTimer) clearTimeout(this.answerWatchdogTimer);
    this.answerWatchdogTimer = null;
    // Audit-2 M34: a pending renegotiation retry must not fire
    // after teardown (it could revert a NEW call's video state).
    if (this.renegotiateRetryTimer) clearTimeout(this.renegotiateRetryTimer);
    this.renegotiateRetryTimer = null;
  }

  private async teardownPeer() {
    this.clearTimers();
    this.ringer.stop();
    // Audit-2 L50: the call unwound — wake any acceptCall waiting
    // for an offer that will now never arrive (its post-wait guards
    // return silently when pc is gone).
    this.notifyOfferWaiters();
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.pendingIce = [];
    this.pendingOffer = null;
    // Audit-4 L19: fresh call = fresh offer-apply state.
    this.offerApplyError = null;
    this.pendingVideoUpgrade = false;
    this.pendingVideoDowngrade = false;
    // Audit-3 A5-N6: the renegotiation retry budget is per-call in
    // intent — reset it here so a failed re-offer in call A can't
    // steal call B's one retry. Also clears the single-flight
    // createPeer cache (A5-N11) — a new call builds a fresh pc.
    this.renegotiateFailures = 0;
    this.peerCreation = null;
    // Audit-2 C1: never let a finished call's secret authenticate a
    // later call (a new call mints a fresh secret via createCallInvite).
    this.callSecret = null;
    this.signalAuthDegraded = false;
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
    }
    this.localStream = null;
    this.remoteStream = null;
  }

  // Audit-3 A5-N11: single-flight peer creation. acceptCall and the
  // offer case can race (`if (!this.pc)` both pass before either
  // assigns) and orphan a PeerConnection whose onicecandidate keeps
  // firing stray candidates. Concurrent createPeer calls for the
  // same peer share one promise — exactly one pc exists.
  private peerCreation: { peerId: string; promise: Promise<RTCPeerConnection> } | null = null;
  private createPeer(peerId: string): Promise<RTCPeerConnection> {
    if (this.peerCreation && this.peerCreation.peerId === peerId) {
      return this.peerCreation.promise;
    }
    const promise = this.buildPeer(peerId);
    this.peerCreation = { peerId, promise };
    // A rejected creation must not poison later calls for this peer.
    promise.catch(() => {
      if (this.peerCreation?.promise === promise) this.peerCreation = null;
    });
    return promise;
  }

  // Audit-4 L21: partial TURN -> console warn (as before) PLUS
  // onTurnPartial so the provider toasts it — console-only was
  // invisible to the user. Once per process (module flag above).
  private warnIfTurnPartial(): void {
    if (turnPartialWarned) return;
    const status = getTurnStatus();
    if (!status.partial) return;
    turnPartialWarned = true;
    console.warn(
      `[calls] TURN is PARTIALLY configured (missing: ${status.missing.join(", ")}) — running STUN-only. ` +
        `Calls behind symmetric NAT / restrictive carrier NAT may fail with no other diagnostic. ` +
        `Set all three of VITE_TURN_URLS, VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL — or none of them.`,
    );
    this.onTurnPartial?.(status.missing);
  }

  private async buildPeer(peerId: string): Promise<RTCPeerConnection> {
    // Audit-2 L45: surface a partial TURN config at call time.
    this.warnIfTurnPartial();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // New call = fresh ICE-recovery attempt (H31).
    this.iceRestartAttempted = false;
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        void this.sendSignal(peerId, {
          kind: "ice",
          callId: this.state.callId ?? "",
          from: this.myId,
          candidate: e.candidate.toJSON(),
        });
      }
    };
    pc.ontrack = (e) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
        this.set({ remoteStream: this.remoteStream });
        // When the peer removes video mid-call, the track ends / leaves the
        // stream — re-render so the overlay drops back to the voice layout.
        this.remoteStream.addEventListener("removetrack", () => {
          this.set({ remoteStream: this.remoteStream });
        });
      }
      for (const track of e.streams[0]?.getTracks() ?? []) {
        if (!this.remoteStream.getTracks().some((t) => t.id === track.id)) {
          this.remoteStream.addTrack(track);
          track.addEventListener("ended", () => {
            this.set({ remoteStream: this.remoteStream });
          });
        }
      }
    };
    // Mid-call track changes (camera added/removed) must be renegotiated:
    // without this, adding video during a voice call never reaches the peer.
    // Only auto-negotiate once connected — the initial offer/answer is sent
    // explicitly by startCall/acceptCall, and a non-stable state means an
    // offer is already in flight (glare: let the peer's offer win).
    pc.onnegotiationneeded = () => {
      // Audit-2 M34: a failed re-offer must surface (retry → revert
      // + toast), not vanish while the UI claims video is on.
      void this.renegotiate(peerId).then((ok) => {
        if (ok) this.renegotiateFailures = 0;
        else this.handleRenegotiateFailure();
      });
    };
    // H31: transient disconnects (Wi-Fi ↔ mobile handover, tunnel)
    // must not kill the call instantly. "disconnected" → 5s grace
    // (the network may recover on its own) → one pc.restartIce()
    // (the next createOffer via onnegotiationneeded carries the new
    // ICE credentials) → 5s more grace → only then finish("failed").
    // "failed" (ICE gave up) → restart immediately, then 5s grace.
    // "connected" cancels any pending recovery. Audit-2 H18: on a
    // one-sided failure the peer does NOT necessarily notice — finish()
    // itself sends the end signal + row report for the "failed"
    // outcome (see finish), so the peer is told instead of hanging.
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        if (this.iceRecoveryTimer) clearTimeout(this.iceRecoveryTimer);
        this.iceRecoveryTimer = null;
        this.iceRestartAttempted = false;
        return;
      }
      if (pc.connectionState === "disconnected") {
        if (this.iceRecoveryTimer) return; // already recovering
        this.iceRecoveryTimer = setTimeout(() => {
          this.iceRecoveryTimer = null;
          if (pc.connectionState === "connected" || pc.connectionState === "connecting") return;
          if (!this.iceRestartAttempted) {
            this.iceRestartAttempted = true;
            try {
              pc.restartIce();
            } catch {
              /* fall through to the second grace period */
            }
            this.iceRecoveryTimer = setTimeout(() => {
              this.iceRecoveryTimer = null;
              if (pc.connectionState === "connected" || pc.connectionState === "connecting") return;
              void this.finish("failed");
            }, 5_000);
            return;
          }
          void this.finish("failed");
        }, 5_000);
        return;
      }
      if (pc.connectionState === "failed") {
        if (this.iceRecoveryTimer) return;
        if (!this.iceRestartAttempted) {
          this.iceRestartAttempted = true;
          try {
            pc.restartIce();
          } catch {
            /* fall through to the grace period */
          }
        }
        this.iceRecoveryTimer = setTimeout(() => {
          this.iceRecoveryTimer = null;
          if (pc.connectionState === "connected" || pc.connectionState === "connecting") return;
          void this.finish("failed");
        }, 5_000);
      }
    };
    return pc;
  }

  /**
   * Audit-2 L44: apply a video downgrade queued while "calling".
   * The flag is kept (not cleared) when the pc isn't stable yet —
   * the accept-signal transition fires while still in
   * "have-local-offer" (answer not applied), where renegotiate()
   * early-returns and would otherwise eat the queued downgrade.
   * The answer transition retries once stable.
   */
  private async applyPendingVideoDowngrade(): Promise<void> {
    if (!this.pendingVideoDowngrade) return;
    if (this.state.status !== "in-call" || !this.pc) return;
    if (this.pc.signalingState !== "stable") return;
    this.pendingVideoDowngrade = false;
    await this.renegotiate(this.state.peerId);
  }

  /** Apply a video upgrade queued during calling/ringing (M25). */
  private async applyPendingVideoUpgrade(): Promise<void> {
    if (!this.pendingVideoUpgrade) return;
    this.pendingVideoUpgrade = false;
    this.set({ videoUpgradeQueued: false });
    if (this.state.status !== "in-call") return;
    try {
      await this.setVideoEnabled(true);
    } catch {
      // Audit-3 A5-N7: a camera failure here used to be swallowed —
      // and the old comment was wrong: the queued path never touches
      // the camera at tap time, so no error could have surfaced then.
      // Surface it via the M34 callback (provider toast: tap the
      // video button to try again); the call stays voice.
      this.onVideoToggleFailed?.("on");
    }
  }

  /**
   * Audit-2 L43: apply the peer's call type from an offer/answer.
   * Upgrade-only: a peer "video" upgrades the local type (the call
   * involved video, so this side's history must say video too); a
   * peer "voice" must NEVER downgrade a local "video" — this side
   * may have its own camera on (asymmetric video is legitimate).
   */
  private applyPeerType(type: CallType | undefined): void {
    if (type === "video" && this.state.type !== "video") this.set({ type: "video" });
  }

  /** Send a fresh offer for a mid-call change (camera on/off).
   * Returns true when the re-offer was delivered (or when no
   * re-offer was needed — glare: the peer's offer wins and the
   * local change rides in the answer), false on a real failure.
   * Audit-2 M34: the old empty catch swallowed failures while the
   * UI claimed video was on; callers now act on the return value. */
  private async renegotiate(peerId: string): Promise<boolean> {
    if (this.state.status !== "in-call" || !this.pc) return true;
    if (this.pc.signalingState !== "stable") return true;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const delivered = await this.sendSignal(peerId, {
        kind: "offer",
        callId: this.state.callId ?? "",
        from: this.myId,
        sdp: offer,
        // Audit-2 L43: the peer learns the new type from the re-offer.
        type: this.state.type,
      });
      if (!delivered) throw new Error("Renegotiation offer not delivered.");
      return true;
    } catch (err) {
      // Raced with an incoming offer (glare) — the peer's offer wins,
      // ours is dropped; the local change rides in the answer.
      if (err instanceof Error && err.name === "InvalidStateError") return true;
      // Audit-7 C1: the failure may have happened AFTER our offer was
      // set locally (the send is a separate transport — media can be
      // healthy while signaling fails). Left in place, that
      // UNDELIVERED offer parks the pc in "have-local-offer", and the
      // M34 retry's glare guard above reads it as an in-flight offer
      // and reports a vacuous success — the failure counter resets,
      // the peer never gets the re-offer, and the revert + toast never
      // happen (UI claims video is on). The offer never left this
      // device, so rolling it back loses nothing: the pc returns to
      // "stable" and the retry makes a real second attempt with a
      // fresh offer, after which revert + surface fire as designed.
      // Only roll back in "have-local-offer" — any other state means
      // the state machine is being driven by the peer's offer, which
      // must not be disturbed. The state is read through a fresh local:
      // the guard at the top of this function narrowed
      // this.pc.signalingState to "stable" for TS (TS2367), but the
      // awaits since then can have moved the real state.
      const pcAtFailure = this.pc;
      if (pcAtFailure && pcAtFailure.signalingState === "have-local-offer") {
        try {
          await pcAtFailure.setLocalDescription({ type: "rollback" });
        } catch {
          /* best-effort — the failure below is still reported */
        }
      }
      console.warn("[calls] renegotiate failed:", err);
      return false;
    }
  }

  /** Audit-2 M34: a renegotiation failure used to be swallowed —
   * the UI said video was on while the peer never got it. First
   * failure: one retry after 1.5s. Second failure: revert + surface
   * (callback → provider toast). Direction comes from the local
   * tracks: a live video track means the toggle was ON. Video-OFF
   * has no state revert — local state is already truthful (track
   * stopped); only the peer may still show the last frame. */
  private handleRenegotiateFailure() {
    if (this.state.status !== "in-call") return;
    this.renegotiateFailures += 1;
    if (this.renegotiateFailures === 1) {
      this.renegotiateRetryTimer = setTimeout(() => {
        this.renegotiateRetryTimer = null;
        if (this.state.status !== "in-call" || !this.pc) return;
        void this.renegotiate(this.state.peerId).then((ok) => {
          if (ok) this.renegotiateFailures = 0;
          else this.handleRenegotiateFailure();
        });
      }, 1500);
      return;
    }
    // Second failure: revert + surface.
    this.renegotiateFailures = 0;
    if (this.renegotiateRetryTimer) {
      clearTimeout(this.renegotiateRetryTimer);
      this.renegotiateRetryTimer = null;
    }
    const turningOn =
      this.localStream?.getVideoTracks().some((t) => t.enabled) ?? false;
    if (turningOn) {
      // Undo the toggle: stop + remove the local video track so the
      // camera doesn't stay live while the UI says video is off.
      if (this.localStream) {
        for (const track of this.localStream.getVideoTracks()) {
          try {
            track.stop();
          } catch {
            /* ignore */
          }
          try {
            this.localStream.removeTrack(track);
          } catch {
            /* ignore */
          }
        }
      }
      // Audit-3 A5-N8 (same rule as setVideoEnabled(false)): only
      // downgrade the call type when the peer has no live video
      // track either — reverting MY failed toggle must not rewrite
      // a call that still carries peer video to "voice".
      const peerHasVideo = (this.remoteStream?.getVideoTracks() ?? []).some(
        (t) => t.readyState === "live",
      );
      this.set({ isVideoOn: false, type: peerHasVideo ? this.state.type : "voice" });
      this.onVideoToggleFailed?.("on");
    } else {
      this.onVideoToggleFailed?.("off");
    }
  }

  private armRingTimeout() {
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = setTimeout(() => {
      if (this.state.status === "calling" || this.state.status === "ringing") {
        // Caller timing out: tell the callee to stop ringing immediately
        // instead of leaving them ringing until their own timeout fires.
        // C4: report the end to the server row BEFORE sending the signal.
        // The callee's timeout also reports, so the row never stays
        // "ringing" forever (no phantom ringing on a later recovery).
        const { callId, peerId } = this.state;
        void (async () => {
          if (callId) await this.reportEvent(callId, "ended");
          // M20: notify the peer in BOTH directions. The old code only
          // sent `end` when outgoing, so a timing-out callee stopped
          // ringing locally while the caller kept showing "Calling…"
          // until their own (slightly later) timer fired. The callee's
          // `end` matches its "ended" report, so the caller's C4
          // verification passes and the caller finishes "missed".
          if (callId) {
            void this.sendSignal(peerId, {
              kind: "end",
              callId,
              from: this.myId,
            });
          }
        })();
        void this.finish("missed");
      }
    }, RING_TIMEOUT_MS);
  }

  private startElapsed() {
    this.connectedAt = Date.now();
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = setInterval(() => {
      this.set({ elapsedSeconds: Math.floor((Date.now() - this.connectedAt) / 1000) });
    }, 1000);
  }

  /** Caller: start a 1:1 call. `callId` may be supplied by the provider
   * (which writes the invite row first — see newCallId); otherwise one is
   * minted here. `opts.secret` is the per-call HMAC secret from
   * createCallInvite (audit-2 C1) — cached before the offer goes out so
   * the callee can verify the offer's MAC. `opts.degraded` is true only
   * when the call_invites table positively does not exist. */
  async startCall(
    peerId: string,
    peerName: string,
    type: CallType,
    callId = newCallId(),
    opts?: { secret?: string | null; degraded?: boolean },
  ): Promise<void> {
    // Audit-4 L16: treat the 600 ms "ended" flash as idle here too —
    // same as the invite path (A5-N5) and ringFromInvite. A redial
    // in that window used to throw "Already in a call." AFTER the
    // provider had written a NEW invite row — the provider catch
    // then reported "ended" on the brand-new row + an "Already in a
    // call." toast (wasted row + user-visible error). The 600 ms
    // timer only fires while status is still "ended", so starting a
    // new call here can't be clobbered by it.
    if (this.state.status !== "idle" && this.state.status !== "ended") throw new Error("Already in a call.");
    if (!peerId || peerId === this.myId) throw new Error("Cannot call yourself.");
    // Audit-2 C1: cache the secret before the offer goes out.
    this.callSecret = opts?.secret ?? null;
    this.signalAuthDegraded = opts?.degraded ?? false;
    this.startedAtIso = new Date().toISOString();
    this.set({
      status: "calling",
      type,
      direction: "outgoing",
      peerId,
      peerName,
      callId,
      isMuted: false,
      isVideoOn: type === "video",
      elapsedSeconds: 0,
      // Audit-2 C2: degraded (table missing) -> banner shows.
      verificationDegraded: opts?.degraded ?? false,
    });
    try {
      // Audit-3 A5-N3: arm the ring timeout BEFORE the permission
      // prompt — a never-answered prompt must time out (30s) instead
      // of sitting in "calling" forever. Re-armed after the offer
      // send below, so the callee still gets a full ring window.
      this.armRingTimeout();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video",
      });
      // Audit-3 A5-N3: End may have pre-empted the start while the
      // permission prompt was open (or a new call started) — unwind
      // WITHOUT resurrecting the call, and stop the just-granted
      // tracks so the mic/camera doesn't stay live after the call
      // ended. The local `stream` (not this.localStream) is stopped
      // so a concurrent new call's stream is never clobbered. Same
      // checkpoint pattern as acceptCall's M35. (Read via snapshot:
      // the entry guard narrowed this.state.status to "idle", so a
      // direct comparison would trip TS2367; the getter's declared
      // CallState return type carries the full union.)
      const snap = this.snapshot;
      if (snap.status !== "calling" || snap.callId !== callId) {
        for (const track of stream.getTracks()) {
          try {
            track.stop();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      this.localStream = stream;
      this.set({ localStream: this.localStream });
      this.pc = await this.createPeer(peerId);
      for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      // H33: fail fast if the invite can't be delivered — the callee
      // never rang, so there's nothing to clean up on their side.
      // (The offer send stays best-effort: H30's offer-request recovery
      // covers a dropped offer.)
      const inviteSent = await this.sendSignal(peerId, {
        kind: "invite",
        callId,
        from: this.myId,
        fromName: this.myName,
        type,
      });
      if (!inviteSent) {
        throw new Error("Call invite could not be delivered — check your connection.");
      }
      await this.sendSignal(peerId, {
        kind: "offer",
        callId,
        from: this.myId,
        sdp: offer,
        // Audit-2 L43: invariant — every offer carries the sender's type.
        type,
      });
      this.armRingTimeout();
      // M26: caller-side ringback — the callee is being rung now, so
      // the caller hears "ringing" instead of silence until
      // accept/decline/timeout (the accept/answer cases stop it;
      // finish() stops it on every other exit).
      this.ringer.startRingback();
    } catch (err) {
      // Audit-2 H16: the invite row was written (ringing) BEFORE
      // startCall ran. A start failure (mic/camera denied, invite
      // undeliverable) must NOT leave it ringing — within the
      // freshness window (CALL_INVITE_FRESHNESS_MS, Audit-4 M10)
      // the callee's recovery (getPendingInvites)
      // would ring for a call whose caller already failed, and an
      // accept would become a ghost in-call (H17). Report "ended"
      // BEFORE finish() so the row is dead by the time the callee
      // could recover it. Best-effort (reportEvent swallows errors):
      // if the network is down, the report fails silently and the
      // 5-min server cleanup is the backstop (H17 guards the accept).
      await this.reportEvent(callId, "ended");
      await this.finish("failed");
      throw err;
    }
  }

  /** Callee: accept the ringing call. */
  async acceptCall(): Promise<void> {
    if (this.state.status !== "ringing" || !this.state.callId) return;
    if (this.actionInProgress) return;
    this.actionInProgress = "accept";
    this.acceptCancelled = false;
    this.set({ actionPending: "accept" });
    const { peerId, type, callId } = this.state;
    // Audit-3 A5-N1: set once the accept is reported (see below) —
    // the catch branches on it: reported → end, not decline.
    let acceptReported = false;
    try {
      this.ringer.stop();
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video",
      });
      // Audit-2 M35: End/Decline may have pre-empted the accept
      // while the permission prompt was open — unwind WITHOUT
      // resurrecting the call, and stop the just-granted tracks so
      // the mic/camera doesn't stay live after the call ended.
      if (this.acceptCancelled || this.state.status !== "ringing") {
        for (const track of this.localStream.getTracks()) {
          try {
            track.stop();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      this.set({ localStream: this.localStream });
      if (!this.pc) this.pc = await this.createPeer(peerId);
      for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);
      // H30: the offer may never have arrived (Realtime drop /
      // out-of-order delivery). Don't decline — ask the caller to
      // re-send it and wait briefly. Only decline (via the catch below)
      // if the offer still hasn't arrived — the caller is gone.
      if (!this.pc.remoteDescription) {
        await this.sendSignal(peerId, {
          kind: "offer-request",
          callId,
          from: this.myId,
        });
        const deadline = Date.now() + 5_000;
        // Audit-2 L50: event-driven wait (was a 100ms poll loop) —
        // resolves the moment the offer lands (notifyOfferWaiters)
        // or the call unwinds (teardownPeer), or at the deadline.
        // The ring timeout / hangup / End/Decline pre-emption cases
        // the old loop checked inline are covered by the post-wait
        // guards below (pc gone → silent return; pre-empted →
        // the acceptCancelled check after the answer).
        await this.waitForOffer(deadline);
        if (!this.pc) return;
        if (!this.pc.remoteDescription) {
          // Audit-4 L19: the offer DID arrive but setRemoteDescription
          // rejected it (invalid SDP, valid MAC) — throw the true
          // cause, not "Offer never arrived".
          if (this.offerApplyError) throw this.offerApplyError;
          throw new Error("Offer never arrived — the caller may have hung up.");
        }
      }
      // The offer may have arrived before accept; it is stored on the pc via handleSignal.
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      // Audit-2 M35: End/Decline may have pre-empted the accept
      // during the answer — do NOT report "accepted" or send
      // accept/answer after the call already ended.
      if (this.acceptCancelled || this.state.status !== "ringing") return;
      // C4: report the accept to the server row BEFORE sending the accept
      // signal, so the caller's verification finds it.
      const acceptRes = await this.reportEvent(callId, "accepted");
      // Audit-3 A5-N1: from here on, a throw must NOT decline (see the
      // catch) — the accept was reported (or attempted: a lost
      // response may still have landed), so the catch ends the call
      // instead. The early returns below (alreadyAccepted / terminal)
      // return normally and never reach the catch.
      acceptReported = true;
      // Audit-2 M38: another tab took the call in the same instant
      // (the row is the arbiter — BroadcastChannel can't close a
      // sub-task window). Unwind quietly: no accept/answer signals,
      // no in-call. The winning tab owns the call.
      if (acceptRes.alreadyAccepted) {
        this.quietReset();
        return;
      }
      // Audit-2 H17: the row is the source of truth. If it is already
      // TERMINAL (caller timed out / failed / hung up before Pick), the
      // accept did NOT land — do NOT send accept/answer and do NOT go
      // in-call. The old code proceeded anyway: callee alone in-call,
      // mic live, no peer, no timeout, and a phantom "completed" history
      // row contradicting the caller's "missed". finish("missed"):
      // the call ended before pickup. No decline signal: the caller is
      // gone, and the row is already terminal. Unknown (report failed /
      // degraded mode) still proceeds — the write may have landed with
      // a lost response, and the caller verifies the accept signal
      // against the row.
      if (!this.signalAuthDegraded && acceptRes.terminal) {
        // Audit-3 A5-R1: the row went terminal while this tab was
        // accepting. If a SIBLING tab took it (its declineBusyCall
        // wrote the callee-side "declined" history row + fired
        // onCallFinished), this tab must NOT finish("missed") — that
        // wrote a SECOND history row (missed) for one call. Unwind
        // quietly instead: the sibling owns the outcome. If no
        // sibling took it (caller timed out / failed / hung up),
        // the callee still needs its own "missed" row — finish().
        // The taken flag is reliable here because declineBusyCall
        // broadcasts BEFORE its (slow) decline signal, so the flag
        // lands ~a full report round-trip before this branch runs.
        if (this.isCallTaken(callId)) {
          this.quietReset();
          return;
        }
        await this.finish("missed");
        return;
      }
      // H33: fail fast if the accept/answer can't be delivered — the
      // caller never learns the accept, so decline (via the catch) is
      // the correct outcome.
      // Audit-2 M38: checkpoint before the sends — a sibling tab may
      // have taken the call mid-accept (quiet reset flipped the
      // status); the accept/answer must NOT go out after that, or
      // the caller gets a second answer and the media flips.
      if (this.acceptCancelled || this.state.status !== "ringing") return;
      const acceptSent = await this.sendSignal(peerId, { kind: "accept", callId, from: this.myId });
      if (!acceptSent) {
        throw new Error("Accept could not be delivered — the caller may have hung up.");
      }
      const answerSent = await this.sendSignal(peerId, {
        kind: "answer",
        callId,
        from: this.myId,
        sdp: answer,
        // Audit-2 L43: invariant — every answer carries the sender's type.
        type: this.state.type,
      });
      if (!answerSent) {
        throw new Error("Answer could not be delivered — the caller may have hung up.");
      }
      // Audit-2 M35: last checkpoint — an End that landed during the
      // accept/answer sends must not be undone by this set.
      if (this.acceptCancelled || this.state.status !== "ringing") return;
      this.set({ status: "in-call", isVideoOn: type === "video" });
      // Audit-2 M38: this tab took the call — sibling tabs must
      // stop ringing it.
      this.broadcastTaken(callId);
      // M25: a video upgrade queued during ringing applies now that
      // the call is connected.
      void this.applyPendingVideoUpgrade();
      // Audit-2 L44: a video-OFF queued while calling applies here too.
      void this.applyPendingVideoDowngrade();
      // Order matters: clearTimers() also stops the elapsed timer, so stop
      // the ring timeout FIRST, then start the elapsed timer.
      this.clearTimers();
      this.startElapsed();
    } catch (err) {
      // Accept failed. Clear the guard first so the fallback isn't
      // blocked by this accept's guard — but only if this accept
      // still owns it (an End/Decline pre-emption already took it
      // over, and the call is already ending).
      if (this.actionInProgress === "accept") {
        this.actionInProgress = null;
        this.set({ actionPending: null });
      }
      if (acceptReported) {
        // Audit-3 A5-N1: the accept was already reported (and the
        // accept signal may already be out — the caller may be
        // in-call). Do NOT decline: a decline after an accept
        // contradicts the row, and the caller's decline handler
        // ignores in-call declines, so the caller would strand
        // in-call with a live mic. End instead — finish("failed")
        // reports "ended" + sends "end" (H18) and records a failed
        // row, so the caller exits too.
        await this.finish("failed");
      } else {
        // The accept never reached the row — declining is consistent:
        // the caller never saw an accept, so it never went in-call.
        await this.declineCall();
      }
      throw err;
    } finally {
      if (this.actionInProgress === "accept") {
        this.actionInProgress = null;
        this.set({ actionPending: null });
      }
    }
  }

  /** Callee: decline the ringing call. */
  async declineCall(): Promise<void> {
    if (this.state.status !== "ringing" || !this.state.callId) return;
    // Audit-2 M35: a decline/end already in flight blocks a second
    // decline (double-tap protection). An ACCEPT in flight does NOT
    // block — Decline pre-empts it (the accept unwinds at its next
    // checkpoint instead of landing after the user declined).
    if (this.actionInProgress === "decline" || this.actionInProgress === "end") return;
    if (this.actionInProgress === "accept") this.acceptCancelled = true;
    this.actionInProgress = "decline";
    this.set({ actionPending: "decline" });
    const { peerId, callId } = this.state;
    try {
      // C4: report the decline to the server row BEFORE sending the signal.
      const declineRes = await this.reportEvent(callId, "declined");
      // Audit-2 M39: a sibling tab already accepted this call — do
      // NOT send a decline signal or record a declined row for a
      // live call; unwind quietly like the accept path does.
      if (declineRes.alreadyAccepted) {
        this.quietReset();
        return;
      }
      // Audit-4 M6: the report says the row is ALREADY terminal and
      // this decline did NOT land (caller hung up / timed out, or
      // another tab declined first) — same guard as declineBusyCall.
      // The old code ignored `terminal` and proceeded to send a
      // decline signal to a gone caller AND finish("declined"),
      // writing a SECOND declined history row for one call (the
      // sibling's declineBusyCall already wrote one) and
      // contradicting the row's real outcome (missed/ended).
      // Unwind quietly: no signal, no finish, no second row.
      if (declineRes.terminal && !declineRes.applied) {
        this.quietReset();
        return;
      }
      // Audit-3 A5-N12: finish() must run even if the signal send
      // throws (channel torn down mid-send) — otherwise the call
      // stays "ringing" until the ring timeout / ICE detection.
      try {
        await this.sendSignal(peerId, { kind: "decline", callId, from: this.myId });
      } finally {
        await this.finish("declined");
      }
    } finally {
      if (this.actionInProgress === "decline") {
        this.actionInProgress = null;
        this.set({ actionPending: null });
      }
    }
  }

  /**
   * Reconstruct ringing from a persisted invite — used when the callee's app
   * was fully closed and they tapped Pick/Reject in the push notification.
   * The original offer broadcast was missed, so ask the caller to re-send
   * it. If the user tapped Pick, auto-accept the moment the offer lands.
   */
  async ringFromInvite(
    invite: {
      callId: string;
      from: string;
      fromName: string;
      type: CallType;
      // Audit-2 C1: per-call HMAC secret from the invite row.
      secret?: string | null;
    },
    autoAction: "accept" | "decline" | null,
  ): Promise<void> {
    // Audit-3 A5-N5: the 600 ms "ended" flash counts as idle here
    // too — a recovered invite in that window must ring, not be
    // skipped (same window as the invite case above).
    if (this.state.status !== "idle" && this.state.status !== "ended") return;
    this.startedAtIso = new Date().toISOString();
    this.pendingAutoAction = autoAction;
    // Audit-2 C1: the recovered invite carries the per-call secret —
    // cache it so the re-sent offer's MAC verifies. A recovered invite
    // always came from a real row (getCallInvite / getPendingInvites),
    // so this path is never degraded.
    this.callSecret = invite.secret ?? null;
    this.signalAuthDegraded = false;
    this.set({
      status: "ringing",
      type: invite.type,
      direction: "incoming",
      peerId: invite.from,
      peerName: invite.fromName,
      callId: invite.callId,
      isMuted: false,
      isVideoOn: false,
      elapsedSeconds: 0,
      // Recovered invites always came from a real row -> never degraded.
      verificationDegraded: false,
    });
    if (!this.pc) this.pc = await this.createPeer(invite.from);
    this.ringer.start();
    this.armRingTimeout();
    if (autoAction === "decline") {
      await this.declineCall();
      return;
    }
    await this.sendSignal(invite.from, {
      kind: "offer-request",
      callId: invite.callId,
      from: this.myId,
    });
  }

  /**
   * Audit-2 M36: busy-decline for a call that is NOT the active one —
   * used by the push-notification tap path (the overlay), which
   * bypassed the engine's Realtime busy-decline (processSignal) and
   * left the new caller ringing 30s to "missed". Reports "declined"
   * to the invite row first (so the caller's verification passes),
   * then sends the decline signal to the caller. Does NOT touch the
   * active call's state.
   * Audit-2 M39: also writes the callee's history row (status
   * "declined") + fires onCallFinished (the provider invalidates
   * ["calls"], so the attempt shows in the Calls tab; the chat
   * entry is skipped for incoming calls, as in finish()). A
   * duplicate decline (row already terminal — e.g. the push-tap
   * path AND the Realtime path both fired) is skipped via the
   * report's terminal flag, so one attempt yields exactly one row.
   */
  async declineBusyCall(
    callId: string,
    from: string,
    type: CallType,
    fromName: string,
  ): Promise<void> {
    const res = await this.reportEvent(callId, "declined");
    // Already terminal (declined/ended by another path) — nothing
    // left to decline, and no second history row.
    // Audit-2 M39: already accepted by a sibling tab — the row must
    // not flip to "declined", and no declined history row either.
    if ((res.terminal && !res.applied) || res.alreadyAccepted) return;
    // Audit-3 A5-R1: broadcast BEFORE the decline signal — a sibling
    // tab mid-accept reads the row as terminal ~a round-trip later
    // and must see the taken flag by then, or it finish("missed")s a
    // second history row for this one call. The signal send below
    // awaits a subscribe round-trip (up to 2s), so broadcasting
    // after it left the sibling's check racing a still-unposted
    // flag. The caller still gets its decline signal right after.
    // Audit-2 M38: sibling tabs are ringing this call too — tell
    // them it is taken so they stop instead of ringing to 30s.
    this.broadcastTaken(callId);
    await this.sendSignal(from, {
      kind: "decline",
      callId,
      from: this.myId,
    });
    // Audit-2 M39: the callee's own history row for the attempt.
    const now = new Date().toISOString();
    void recordCallRow({
      user_id: this.myId,
      peer_id: from,
      peer_name: fromName,
      type,
      direction: "incoming",
      status: "declined",
      duration_seconds: 0,
      started_at: now,
      ended_at: now,
    });
    try {
      this.onCallFinished?.({
        callId,
        peerId: from,
        peerName: fromName,
        type,
        direction: "incoming",
        status: "declined",
        durationSeconds: 0,
      });
    } catch {
      // Best-effort; the decline itself already landed.
    }
  }

  /**
   * Audit-2 M37: SYNCHRONOUS best-effort `end` broadcast for unload
   * (pagehide) and stop(). The async sendSignal awaits a subscribe
   * round-trip that never completes during unload, so the peer would
   * hang until the ring timeout / ICE detection. The channel is
   * already subscribed while a call is live, and the underlying
   * socket send is synchronous — during pagehide it usually gets
   * out. No await, no state change. If the socket is already dead,
   * this throws nothing and the peer falls back to ICE detection /
   * the ring timeout / the 5-min row cleanup.
   */
  private sendEndSignalSync(): void {
    try {
      const { status, direction, peerId, callId } = this.state;
      if (!callId) return;
      if (status !== "ringing" && status !== "calling" && status !== "in-call") return;
      const ch = this.channels.get(peerId);
      if (!ch) return;
      void ch.send({
        type: "broadcast",
        event: "call-signal",
        payload: {
          kind: "end",
          callId,
          from: this.myId,
          // Audit-3 A5-N18: a caller cancelling while "calling" must
          // reach the callee as "cancelled", not "missed" — endCall
          // attaches reason: "cancelled"; the tab-close path must too.
          ...(status === "calling" && direction === "outgoing"
            ? { reason: "cancelled" as const }
            : {}),
        },
      });
    } catch {
      /* best-effort — unload may still drop it */
    }
  }

  /**
   * Audit-2 M37: hang up when the tab is closing / the app is going
   * away (pagehide, logout, unmount). The `end` signal goes out
   * SYNCHRONOUSLY first — stop() tears the channels down immediately
   * after, so anything chained behind an await (e.g. getSession)
   * would find the channel gone. The report PATCH follows right
   * after (keepalive, fire-and-forget). The peer's C4 verification
   * requires the row to say "ended" before it accepts the signal,
   * and the signal usually beats the PATCH — the peer re-checks the
   * row once after 2s for exactly this race (see the `end` case).
   * The server fn can't take a beacon (its body must be
   * seroval-serialized, its URL is a build-time fn id, and it needs
   * an auth header), so the report PATCHes the row directly via
   * PostgREST under the narrow §M37 RLS policy (participants may set
   * status='ended' on live rows only) — same keepalive pattern as
   * presence markOffline. The response is never read.
   */
  hangupOnUnload(): void {
    const { status, callId } = this.state;
    if (!callId) return;
    if (status !== "ringing" && status !== "calling" && status !== "in-call") return;
    // Signal first (sync — the channel may be gone by the next tick).
    this.sendEndSignalSync();
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        const token = data.session?.access_token;
        if (!token) return;
        const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
        const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
        if (!base || !key) return;
        // Audit-4 L20: the PATCH must NOT flip a TERMINAL row. A
        // sibling tab may already have declined (row "declined") —
        // an unconditional PATCH flipped it to "ended", so the
        // caller dropped the real decline, stayed "Calling…" to
        // the timeout, and recorded "missed". The PostgREST
        // `or=(status.eq.ringing,status.eq.accepted)` precondition
        // makes the PATCH a no-op on terminal rows (declined /
        // ended) — the same terminal guard reportCallEvent
        // enforces server-side. The §M37 RLS policy is out of
        // scope for this finding.
        void fetch(`${base}/rest/v1/call_invites?id=eq.${encodeURIComponent(callId)}&or=(status.eq.ringing,status.eq.accepted)`, {
          method: "PATCH",
          headers: {
            apikey: key,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ status: "ended" }),
          keepalive: true,
        }).catch(() => {
          /* best-effort — unload may still drop it */
        });
      })
      .catch(() => {
        /* best-effort — the sync signal already went out */
      });
  }

  /** Either side: hang up. */
  async endCall(): Promise<void> {
    if (this.state.status === "idle") return;
    // Audit-2 M35: an End already in flight blocks a second End
    // (double-tap protection). A Decline in flight already ends the
    // call — End's intent is satisfied, so it returns (the overlay
    // shows Decline busy). An ACCEPT in flight does NOT block — End
    // pre-empts it (the accept unwinds at its next checkpoint
    // instead of landing after the user hung up).
    if (this.actionInProgress === "end" || this.actionInProgress === "decline") return;
    if (this.actionInProgress === "accept") this.acceptCancelled = true;
    this.actionInProgress = "end";
    this.set({ actionPending: "end" });
    const { peerId, callId } = this.state;
    // Audit-2 M40: the caller cancelling while "calling" is a CANCEL,
    // not a miss — the callee must not get a missed-call ping for a
    // call the caller deliberately aborted. The reason travels on
    // the signal; the callee records "cancelled" (postCallMessage
    // sends no push for it).
    const cancelled = this.state.status === "calling" && this.state.direction === "outgoing";
    try {
      if (callId) {
        // C4: report the end to the server row BEFORE sending the signal.
        await this.reportEvent(callId, "ended");
        // Audit-3 A5-N12: finish() must run even if the signal send
        // throws — see declineCall above.
        try {
          await this.sendSignal(peerId, {
            kind: "end",
            callId,
            from: this.myId,
            ...(cancelled ? { reason: "cancelled" as const } : {}),
          });
        } finally {
          await this.finish(
            this.state.status === "in-call" ? "completed" : cancelled ? "cancelled" : "missed",
          );
        }
      } else {
        await this.finish(
          this.state.status === "in-call" ? "completed" : cancelled ? "cancelled" : "missed",
        );
      }
    } finally {
      if (this.actionInProgress === "end") {
        this.actionInProgress = null;
        this.set({ actionPending: null });
      }
    }
  }

  /** Finish locally: record history, cleanup, back to idle. */
  private async finish(outcome: CallOutcome): Promise<void> {
    // Claim this finish SYNCHRONOUSLY at entry: the state flips to "ended"
    // before the first await, so a second concurrent finish() (peer's `end`
    // signal + onconnectionstatechange, ring timeout + decline, double-tap
    // End/Decline) sees "ended" and returns — exactly one history row and
    // exactly one onCallFinished per call (H3). Previously the guard only
    // checked "idle" and the state flipped after the awaits, so two
    // concurrent finish() calls both recorded a row and both fired the
    // chat-entry callback.
    const { status, direction, peerId, peerName, type, callId } = this.state;
    if (status === "idle" || status === "ended") return;
    const duration =
      status === "in-call" && this.connectedAt
        ? Math.floor((Date.now() - this.connectedAt) / 1000)
        : 0;
    const endedAt = new Date().toISOString();
    const startedAt = this.startedAtIso;
    this.ringer.stop();
    this.pendingAutoAction = null;
    // Flip to "ended" NOW (before any await) — this is the re-entrancy guard.
    this.set({
      ...IDLE_STATE,
      status: "ended",
      type,
      direction,
      peerId,
      peerName,
      callId,
    });
    // Audit-2 M38: this tab finished the call — sibling tabs ringing
    // the same call must stop (ring timeout / decline / peer end).
    this.broadcastTaken(callId);
    // Audit-2 M33: media FIRST — teardownPeer never waits on the
    // network. The old order awaited the history DB write (a
    // Supabase insert with no timeout) before stopping tracks, so
    // a slow/hung DB kept mic/camera live while the UI showed no
    // call. History is fire-and-forget below (errors logged inside
    // recordCallRow); the chat entry must not wait on it either.
    await this.teardownPeer();
    // Audit-2 H18: a FAILED call must tell the peer, like endCall does.
    // The old code assumed "the peer will notice the same disconnect" —
    // true only for symmetric loss. On a one-sided failure (local
    // firewall/NAT kills local ICE while the peer stays connected, or a
    // local pc error the peer never sees), the peer would hang in-call
    // indefinitely: no timeout, no watchdog, mic live. Report + signal,
    // best-effort (a dead network must not block the rest). Only the
    // "failed" outcome signals: endCall / declineCall / the ring timeout
    // already sent their signal before finish(), and the peer's "end"
    // handler finishes with "completed"/"missed" — so there is no echo
    // and no duplicate. (H16's startCall-catch report duplicates this
    // one; the second is a terminal no-op server-side.) This runs
    // AFTER teardown: the "end" signal is not MAC-signed (only
    // offer/answer/ice carry a MAC), so it does not need the secret
    // teardown clears.
    if (outcome === "failed" && callId && peerId) {
      try {
        await this.reportEvent(callId, "ended");
        await this.sendSignal(peerId, { kind: "end", callId, from: this.myId });
      } catch {
        // Best-effort — the history + chat entry below must still run.
      }
    }
    // Record history from this side's perspective (fire-and-forget).
    if (callId && peerId) {
      void recordCallRow({
        user_id: this.myId,
        peer_id: peerId,
        peer_name: peerName,
        type,
        direction,
        status: outcome,
        duration_seconds: duration,
        started_at: startedAt || endedAt,
        ended_at: endedAt,
      });
    }
    // Tell the provider the call finished (fire-and-forget: the chat entry
    // post must never delay teardown). The provider only posts for outgoing
    // calls, so one call yields exactly one chat entry.
    try {
      this.onCallFinished?.({
        callId: callId ?? "",
        peerId,
        peerName,
        type,
        direction,
        status: outcome,
        durationSeconds: duration,
      });
    } catch {
      // Best-effort; the call itself already ended cleanly.
    }
    // Brief "ended" state so the UI can show a closing flash, then idle.
    setTimeout(() => {
      if (this.state.status === "ended") this.set({ ...IDLE_STATE });
    }, 600);
  }

  async setMuted(muted: boolean): Promise<void> {
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) track.enabled = !muted;
    }
    this.set({ isMuted: muted });
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      // M25: before the call is connected, renegotiate() early-returns
      // (it only runs when in-call), so adding a camera track here
      // would leave isVideoOn=true while the peer never gets video
      // and no later re-offer fires — the UI would lie that the call
      // is video. Instead, QUEUE the upgrade: it applies when the
      // call connects (applyPendingVideoUpgrade at the in-call
      // transitions). No track is added and isVideoOn stays false
      // until the upgrade actually applies. During idle/ended there
      // is no call to upgrade — a no-op.
      if (this.state.status === "idle" || this.state.status === "ended") {
        return;
      }
      // Audit-2 L44: NOTE — a video-ON here does NOT clear a queued
      // downgrade. The flag means "re-offer the CURRENT pc state at
      // in-call", which is idempotent: clearing it on ON would lose
      // the downgrade in an OFF->ON->OFF sequence during calling
      // (the final OFF cancels the queued upgrade and returns
      // early, so nothing would re-offer the video-OFF state).
      if (this.state.status === "calling" || this.state.status === "ringing") {
        // Audit-3 A5-N7: mirror the queue in state so the overlay can
        // show a pending Video button (tappable to cancel).
        this.pendingVideoUpgrade = true;
        this.set({ videoUpgradeQueued: true });
        return;
      }
      if (!this.localStream?.getVideoTracks().length) {
        // Turning video on mid-call: acquire a camera track and add it.
        // The pc's negotiationneeded handler sends the re-offer to the peer.
        // Audit-3 A5-N4: capture the callId — the call may have ended
        // (or been replaced) while the camera prompt was open.
        const callIdAtToggle = this.state.callId;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          const [track] = stream.getVideoTracks();
          // Audit-3 A5-N4: the call may have ended while the camera
          // prompt was open — finish()/teardownPeer() already ran, so
          // this.localStream / this.pc are null and nothing below would
          // stop the fresh track (live camera leak + isVideoOn on an
          // idle engine). Stop the track and return WITHOUT touching
          // state. Also covers a new call replacing this one mid-prompt
          // (the toggle belonged to the old call). Same checkpoint
          // pattern as acceptCall's M35 / startCall's A5-N3. The
          // snapshot getter carries the full CallState type, so the
          // entry-guard narrowing on this.state.status can't trip TS2367.
          const snap = this.snapshot;
          if (
            snap.status !== "in-call" ||
            snap.callId !== callIdAtToggle ||
            !this.localStream ||
            !this.pc
          ) {
            if (track) {
              try {
                track.stop();
              } catch {
                /* ignore */
              }
            }
            return;
          }
          if (track) {
            this.localStream.addTrack(track);
            const sender = this.pc.getSenders().find((s) => s.track?.kind === "video");
            if (sender) await sender.replaceTrack(track);
            else this.pc.addTrack(track, this.localStream);
          }
        } catch {
          throw new Error("Camera not available.");
        }
      } else {
        for (const track of this.localStream.getVideoTracks()) track.enabled = true;
      }
      this.set({ isVideoOn: true, type: "video" });
      return;
    }
    // Turning video off mid-call: stop + remove the track so the peer's
    // video goes away too (removal triggers renegotiation). Merely
    // disabling the track would leave the peer staring at a black frame.
    // M25: turning video off before connect cancels a queued upgrade —
    // there is no track to remove yet.
    if (this.pendingVideoUpgrade) {
      // Audit-3 A5-N7: cancelling a queued upgrade — reachable from
      // the overlay's pending Video button (tap again to cancel).
      this.pendingVideoUpgrade = false;
      this.set({ videoUpgradeQueued: false });
      return;
    }
    // Audit-2 L44: remember the pre-toggle type — a video call
    // turned off while "calling" needs a re-offer at connect (the
    // initial offer said video; renegotiate() early-returns outside
    // in-call, so without a queued flag the peer would keep
    // expecting video that never comes).
    const wasVideoCall = this.state.type === "video";
    const pc = this.pc;
    if (this.localStream) {
      for (const track of this.localStream.getVideoTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
        try {
          this.localStream.removeTrack(track);
        } catch {
          /* ignore */
        }
        const sender = pc?.getSenders().find((s) => s.track === track);
        if (sender && pc) {
          try {
            pc.removeTrack(sender);
          } catch {
            /* ignore */
          }
        }
      }
    }
    // Audit-3 A5-N8: only downgrade the call type when the peer has
    // no live video track either — turning off MY camera must not
    // rewrite a call that still carries peer video to "voice"
    // (history row + next re-offer would both lie about it).
    const peerHasVideo = (this.remoteStream?.getVideoTracks() ?? []).some(
      (t) => t.readyState === "live",
    );
    this.set({ isVideoOn: false, type: peerHasVideo ? this.state.type : "voice" });
    // Audit-2 L44: queue the downgrade for the first in-call
    // renegotiation — but ONLY while "calling" (caller side). A
    // callee toggling off while "ringing" needs no flag: their
    // answer SDP already carries no video track.
    if (wasVideoCall && this.state.status === "calling") {
      this.pendingVideoDowngrade = true;
    }
  }

  /**
   * Verify an invite signal against the server-side row (C4, policy
   * tightened by audit-2 C2). Returns the trusted caller name to
   * display + the per-call HMAC secret + whether the table positively
   * does not exist. `drop: true` means the invite must not ring:
   * either the server explicitly refuted it (`unverified: false`) or
   * verification itself failed after one retry (`unverified: true` —
   * the caller gets the "couldn't verify caller" toast).
   */
  private async verifyInviteSignal(
    signal: Extract<CallSignal, { kind: "invite" }>,
  ): Promise<{
    drop: boolean;
    fromName: string;
    secret: string | null;
    tableMissing: boolean;
    unverified: boolean;
  }> {
    // Audit-3 A5-N17: no verify object = fail CLOSED. The old
    // fail-open default trusted every invite when the engine was
    // constructed without verification (CallProvider always passes
    // it today, but a future construction site must not silently
    // get zero verification). unverified: true surfaces the
    // "Couldn't verify caller" toast instead of ringing blind.
    if (!this.verify)
      return {
        drop: true,
        fromName: signal.fromName,
        secret: null,
        tableMissing: false,
        unverified: true,
      };
    const attempt = () =>
      this.verify!.verifyInvite(signal.callId, signal.from, signal.type);
    let res: Awaited<ReturnType<typeof attempt>>;
    try {
      res = await attempt();
    } catch (err) {
      // Audit-2 C2: UNKNOWN is not APPROVED — one retry (a transient
      // blip must not kill a real call), then fail CLOSED.
      console.warn("[calls] invite verification failed, retrying once", err);
      await new Promise((r) => setTimeout(r, 400));
      try {
        res = await attempt();
      } catch {
        console.warn("[calls] invite verification failed twice — dropping unverified invite");
        return {
          drop: true,
          fromName: signal.fromName,
          secret: null,
          tableMissing: false,
          unverified: true,
        };
      }
    }
    if (!res.ok)
      return {
        drop: true,
        fromName: signal.fromName,
        secret: null,
        tableMissing: false,
        unverified: false,
      };
    return {
      drop: false,
      fromName: res.fromName ?? signal.fromName,
      secret: res.secret ?? null,
      tableMissing: res.tableMissing ?? false,
      unverified: false,
    };
  }

  /**
   * Audit-2 C1: verify a payload signal's MAC before it touches the
   * PeerConnection. Returns false (and logs the reason) when the signal
   * must be dropped. Degraded mode (table positively missing) skips
   * verification entirely — C2 owns that policy + banner.
   */
  private async verifyPayloadMac(
    signal: Extract<CallSignal, { kind: "offer" | "answer" | "ice" }>,
  ): Promise<boolean> {
    if (this.signalAuthDegraded) return true;
    if (!this.callSecret) {
      console.warn(
        `[calls] dropped ${signal.kind} — no per-call secret (pre-fix row or failed invite fetch)`,
      );
      return false;
    }
    const payload = signal.kind === "ice" ? signal.candidate : signal.sdp;
    const ok = await verifySignalMac(
      this.callSecret,
      signal.kind,
      signal.callId,
      payload,
      signal.mac,
    );
    if (!ok) {
      console.warn(
        `[calls] dropped ${signal.kind} — MAC mismatch / missing (spoofed or pre-fix sender)`,
      );
    }
    return ok;
  }

  /**
   * Verify an accept/decline/end signal against the server-side row
   * (C4, policy tightened by audit-2 C2). UNKNOWN after one retry ->
   * fail CLOSED (return false). The ONLY fail-open case is a positively
   * confirmed missing table: the call proceeds in the degraded mode
   * and the banner flag is set (never silent).
   */
  private async verifyEventSignal(
    signal: { callId: string; from: string },
    expectedStatus: "accepted" | "declined" | "ended" | "ringing",
  ): Promise<boolean> {
    // Audit-3 A5-N17: no verify object = fail CLOSED (drop the
    // signal) — see verifyInviteSignal above.
    if (!this.verify) return false;
    const attempt = () =>
      this.verify!.verifyCallStatus(
        signal.callId,
        expectedStatus,
        signal.from,
        this.myId,
      );
    let res: Awaited<ReturnType<typeof attempt>>;
    try {
      res = await attempt();
    } catch (err) {
      console.warn(`[calls] ${expectedStatus} verification failed, retrying once`, err);
      await new Promise((r) => setTimeout(r, 400));
      try {
        res = await attempt();
      } catch {
        console.warn(
          `[calls] ${expectedStatus} verification failed twice — dropping unverified signal`,
        );
        return false;
      }
    }
    if (res.tableMissing) {
      this.signalAuthDegraded = true;
      if (!this.state.verificationDegraded) this.set({ verificationDegraded: true });
      return true;
    }
    return res.ok;
  }

  /** Best-effort server-side event write before the matching signal. */
  private async reportEvent(
    callId: string,
    event: "accepted" | "declined" | "ended",
  ): Promise<{ ok: boolean; applied: boolean; terminal: boolean; alreadyAccepted?: boolean }> {
    if (!this.verify) return { ok: false, applied: false, terminal: false };
    try {
      return await this.verify.reportCallEvent(callId, event);
    } catch {
      // Best-effort: unknown, NOT terminal (see the provider callback
      // — a lost response does not mean the write didn't land).
      return { ok: false, applied: false, terminal: false };
    }
  }

  private signalQueue: Promise<void> = Promise.resolve();

  /**
   * Serialize incoming signals (C4). The invite handler awaits a server
   * round-trip; without a queue, the offer that follows it immediately
   * would be processed while state is still "idle" and dropped — the
   * callee's accept would then fail for want of a remote description.
   * Signals are processed strictly in arrival order.
   */
  private handleSignal(signal: CallSignal): void {
    this.signalQueue = this.signalQueue
      .then(() => this.processSignal(signal))
      .catch(() => undefined);
  }

  private async processSignal(signal: CallSignal): Promise<void> {
    // Signals for other calls (stale invites from an earlier call).
    // Audit-2 M38 CORRECTION (the audit's trace was wrong here): the
    // old guard dropped EVERY different-call signal — including a
    // NEW invite while busy — so the busy-decline branch below never
    // ran and the new caller rang 30s to "missed". A new `invite`
    // must reach the invite case (it is row-verified there); every
    // other different-call signal is still stale and dropped.
    if (this.state.callId && signal.callId !== this.state.callId && signal.kind !== "invite") return;
    // C4: the channel is public, so `signal.from` is self-asserted. While
    // a call is active, only signals from the active peer are accepted —
    // a spoofed `end`/`decline`/`offer` from anyone else is dropped.
    // (The `invite` case below is verified against the server row.)
    if (this.state.callId && signal.from !== this.state.peerId && signal.kind !== "invite") return;
    // Audit-2 M38: a duplicate invite for the call already handled
    // here (ringing / in-call / calling / just ended) is ignored — it
    // must NOT auto-decline the offered call, and a redelivery after
    // accept must NOT corrupt the live call's row via the busy branch.
    if (signal.kind === "invite" && this.state.callId === signal.callId) return;

    switch (signal.kind) {
      case "invite": {
        // Audit-2 M38: another tab already took this call — a
        // duplicate invite redelivery must not re-ring it.
        if (this.isCallTaken(signal.callId)) return;
        // C4: verify the invite against the server-side row before ringing.
        // A spoofed invite (no row, stale row, wrong caller/type) is
        // dropped — no phantom ringing, no attacker-controlled caller name.
        const { drop, fromName, secret, tableMissing, unverified } =
          await this.verifyInviteSignal(signal);
        if (drop) {
          // Audit-2 C2: a drop because verification itself failed (not
          // because the server refuted) must be user-visible.
          if (unverified) this.onUnverifiedInvite?.();
          return;
        }
        // Audit-3 A5-N10: an invite for a DIFFERENT call proves the
        // buffered offer's call never materialized — drop the stale
        // slot so a later real out-of-order offer can be buffered
        // (first-buffered-wins would otherwise refuse it).
        if (
          this.pendingOffer &&
          (this.pendingOffer.callId !== signal.callId || this.pendingOffer.from !== signal.from)
        ) {
          this.pendingOffer = null;
        }
        // Audit-2 C1: cache the per-call secret BEFORE any offer is
        // applied — the buffered-offer path below verifies against it.
        this.callSecret = secret;
        this.signalAuthDegraded = tableMissing;
        // Audit-3 A5-N5: treat the 600 ms "ended" flash as idle for
        // the invite path — finish() holds status "ended" only for a
        // cosmetic closing flash, and a new invite in that window
        // used to be auto-DECLINED (with a "declined" history row)
        // for a call the user never saw, even though the callee was
        // actually free. The 600 ms timer only fires while status is
        // still "ended", so ringing a new call here can't be
        // clobbered by it.
        if (this.state.status !== "idle" && this.state.status !== "ended") {
          // Busy: tell the caller we're unavailable. Report the decline
          // to the server row first so the caller's verification passes.
          // Audit-2 M38: consolidated into declineBusyCall (same
          // report + signal) so sibling tabs learn the call is taken.
          await this.declineBusyCall(signal.callId, signal.from, signal.type, fromName);
          return;
        }
        this.startedAtIso = new Date().toISOString();
        this.set({
          status: "ringing",
          type: signal.type,
          direction: "incoming",
          peerId: signal.from,
          peerName: fromName,
          callId: signal.callId,
          isMuted: false,
          isVideoOn: false,
          elapsedSeconds: 0,
          // Audit-2 C2: degraded (table missing) -> banner shows.
          verificationDegraded: tableMissing,
        });
        this.ringer.start();
        this.armRingTimeout();
        // H30: an out-of-order offer buffered before the invite — apply
        // it now so acceptCall's createAnswer() doesn't throw. Only
        // applied if callId + from match the server-verified invite, so
        // a spoofed buffered offer can't hurt.
        if (
          this.pendingOffer &&
          this.pendingOffer.callId === signal.callId &&
          this.pendingOffer.from === signal.from
        ) {
          const buffered = this.pendingOffer;
          this.pendingOffer = null;
          // Audit-2 C1: the buffered offer was stored unverified (no
          // secret existed yet) — verify now, before it touches the pc.
          // A failed MAC drops the offer but the (verified) invite still
          // rings; the caller re-sends via offer-request recovery.
          if (
            !(await this.verifyPayloadMac({
              kind: "offer",
              callId: buffered.callId,
              from: buffered.from,
              sdp: buffered.sdp,
              mac: buffered.mac,
            }))
          ) {
            break;
          }
          if (!this.pc) this.pc = await this.createPeer(buffered.from);
          if (!this.pc.remoteDescription) {
            // Audit-4 L19: setRemoteDescription can throw on an
            // invalid SDP (valid MAC — the caller signed a broken
            // offer, or an SDP incompatibility). The old code let
            // the throw skip notifyOfferWaiters, so acceptCall
            // waited the full 5s and then misdiagnosed it as
            // "Offer never arrived". Record the true cause + wake
            // the waiter so accept fails FAST with the right error.
            try {
              await this.pc.setRemoteDescription(new RTCSessionDescription(buffered.sdp));
              this.offerApplyError = null;
            } catch (err) {
              this.offerApplyError = new Error(
                "Offer could not be applied — " + (err instanceof Error ? err.message : "invalid session description"),
              );
              this.notifyOfferWaiters();
              break;
            }
            // Audit-2 L50: the buffered offer just landed — wake an
            // acceptCall that is waiting for it.
            this.notifyOfferWaiters();
            for (const c of this.pendingIce) {
              try {
                await this.pc.addIceCandidate(new RTCIceCandidate(c));
              } catch {
                /* ignore stale candidate */
              }
            }
            this.pendingIce = [];
          }
        }
        break;
      }
      case "accept": {
        // C4: only act on an accept the callee actually reported.
        if (!(await this.verifyEventSignal(signal, "accepted"))) return;
        // Audit-6 C-N1: the verification awaited — the call may have
        // ended and a NEW call to the same peer started meanwhile.
        // A verified accept for the OLD call must not flip the new
        // one to in-call. Mirror the `end` branch's re-check.
        if (this.state.callId !== signal.callId) return;
        if (this.state.status === "calling") {
          // M26: the call connected — stop the ringback.
          this.ringer.stop();
          this.set({ status: "in-call" });
          // M25: a video upgrade queued during calling applies now.
          void this.applyPendingVideoUpgrade();
      // Audit-2 L44: a video-OFF queued while calling applies here too.
      void this.applyPendingVideoDowngrade();
          this.clearTimers();
          this.startElapsed();
          // Audit-3 A5-N1: arm the answer watchdog — in-call via
          // accept, but if the answer never arrives the pc has no
          // remote description, connectionState stays "new", and the
          // ICE watchdog never fires. 10s, then finish("failed")
          // (H18: reports "ended" + sends "end", so the callee exits
          // too). Armed AFTER clearTimers() so it isn't killed at
          // once; cleared by clearTimers() on every exit + below
          // when the answer lands. Only the caller arms it: the
          // callee always has a remote description (the offer) at
          // in-call, so it can never strand this way.
          if (this.answerWatchdogTimer) clearTimeout(this.answerWatchdogTimer);
          this.answerWatchdogTimer = setTimeout(() => {
            this.answerWatchdogTimer = null;
            if (
              this.state.status === "in-call" &&
              this.state.direction === "outgoing" &&
              this.pc &&
              !this.pc.remoteDescription
            ) {
              void this.finish("failed");
            }
          }, 10_000);
        }
        break;
      }
      case "decline": {
        // C4: only act on a decline the callee actually reported.
        if (!(await this.verifyEventSignal(signal, "declined"))) return;
        // Audit-6 C-N1: same post-await re-check as accept — a stale
        // verified decline for the OLD call must not finish() the
        // live successor call (and mislabel its history row).
        if (this.state.callId !== signal.callId) return;
        if (this.state.status === "calling" || this.state.status === "ringing") {
          await this.finish("declined");
        }
        break;
      }
      case "offer": {
        // H30: out-of-order offer (arrived before the invite — Realtime
        // delivery order isn't guaranteed). Buffer it instead of
        // dropping; the invite handler applies it when ringing starts.
        if (this.state.status === "idle") {
          // Audit-2 M32: first-buffered-wins — a later offer must
          // not overwrite the buffered one. A spoofed offer arriving
          // after the real one would otherwise destroy the real SDP
          // (its own MAC fails at apply time, but the real offer
          // would already be gone). A spoofed offer arriving FIRST
          // still fails MAC at apply time, and offer-request
          // recovery re-fetches the real one.
          if (!this.pendingOffer) {
            this.pendingOffer = {
              callId: signal.callId,
              from: signal.from,
              sdp: signal.sdp,
              mac: signal.mac,
            };
          }
          break;
        }
        // Callee: hold the offer until accept (acceptCall creates the answer).
        // Store it on a peer connection created now so accept is instant.
        // The pc may already exist when ringing was reconstructed from a
        // persisted invite (closed-app pickup) — then only the remote
        // description is still missing.
        if (this.state.status === "ringing" && !this.pc?.remoteDescription) {
          // Audit-2 C1: never apply an unverified offer — a spoofed
          // SDP here would redirect the victim's media to the attacker.
          if (!(await this.verifyPayloadMac(signal))) break;
          if (!this.pc) this.pc = await this.createPeer(signal.from);
          // Audit-4 L19: same guard as the buffered-offer apply
          // above — an invalid SDP must not skip
          // notifyOfferWaiters (accept waited 5s + misdiagnosed
          // "Offer never arrived").
          try {
            await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            this.offerApplyError = null;
          } catch (err) {
            this.offerApplyError = new Error(
              "Offer could not be applied — " + (err instanceof Error ? err.message : "invalid session description"),
            );
            this.notifyOfferWaiters();
            break;
          }
          // Audit-2 L50: the offer just landed — wake an acceptCall
          // that is waiting for it.
          this.notifyOfferWaiters();
          for (const c of this.pendingIce) {
            try {
              await this.pc.addIceCandidate(new RTCIceCandidate(c));
            } catch {
              /* ignore stale candidate */
            }
          }
          this.pendingIce = [];
          // Picked from the push notification while the app was closed:
          // the offer just landed, so accept now.
          if (this.pendingAutoAction === "accept") {
            this.pendingAutoAction = null;
            await this.acceptCall();
          }
          break;
        }
        // Mid-call re-offer (peer turned video on/off): answer it, or the
        // peer's new track never arrives. Glare (both sides offered at
        // once): the callee is polite (rolls back, takes the peer's offer),
        // the caller is impolite (ignores it — its own offer wins).
        if (this.state.status === "in-call" && this.pc) {
          // Audit-2 C1: same gate for mid-call re-offers (video
          // upgrade / glare) — a spoofed re-offer is a media hijack.
          if (!(await this.verifyPayloadMac(signal))) break;
          // Audit-2 L43: the peer's type (video upgrade/downgrade)
          // lands here — upgrade-only, after the MAC gate.
          this.applyPeerType(signal.type);
          try {
            if (this.pc.signalingState === "have-local-offer") {
              if (this.state.direction !== "incoming") break;
              await this.pc.setLocalDescription({ type: "rollback" });
            }
            await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            await this.sendSignal(signal.from, {
              kind: "answer",
              callId: signal.callId,
              from: this.myId,
              sdp: answer,
              // Audit-2 L43: the local change (glare) rides in the
              // answer — carry this side's current type with it.
              type: this.state.type,
            });
          } catch {
            // Stale offer — the connection already carries the latest media.
          }
        }
        break;
      }
      case "answer": {
        // Audit-2 C1: a spoofed answer flips the caller to in-call and
        // points its media at the attacker — verify before applying.
        if (!(await this.verifyPayloadMac(signal))) break;
        // Audit-2 L43: the peer's type lands here — upgrade-only,
        // after the MAC gate.
        this.applyPeerType(signal.type);
        if (this.pc && this.state.status !== "idle") {
          try {
            await this.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          } catch {
            /* duplicate/late answer */
          }
          // Audit-3 A5-N1: the answer landed — the watchdog is no
          // longer needed. Only clear when the remote description
          // actually exists: a failed setRemoteDescription (bad SDP)
          // leaves it null, and the watchdog must keep running.
          if (this.pc.remoteDescription && this.answerWatchdogTimer) {
            clearTimeout(this.answerWatchdogTimer);
            this.answerWatchdogTimer = null;
          }
          for (const c of this.pendingIce) {
            try {
              await this.pc.addIceCandidate(new RTCIceCandidate(c));
            } catch {
              /* ignore */
            }
          }
          this.pendingIce = [];
          if (this.state.status === "calling") {
            // M26: the call connected — stop the ringback.
            this.ringer.stop();
            this.set({ status: "in-call" });
            this.clearTimers();
            this.startElapsed();
          }
          // Audit-2 L44: queued video changes apply AFTER the
          // transition block, not inside it. The caller can reach
          // in-call via the accept signal BEFORE the answer — then
          // this block is skipped (status already in-call) and an
          // apply inside it would never run. The accept-signal path
          // keeps the downgrade flag while the pc is still in
          // "have-local-offer"; this retry — now stable — applies it.
          // (M25 upgrade: same placement; a second run is a no-op —
          // its flag was cleared by the first.)
          void this.applyPendingVideoUpgrade();
          void this.applyPendingVideoDowngrade();
        }
        break;
      }
      case "ice": {
        // M24: drop ICE when no call is active. The old code pushed to
        // pendingIce whenever remoteDescription was falsy — even while
        // idle, because the callId guard above passes when
        // state.callId is null — so a flood of ice signals grew the
        // array unboundedly (memory DoS), and stale candidates from an
        // aborted call could flush into the next call's pc. The queue
        // is also capped so a burst during setup can't grow it
        // without bound. Note: "ended" keeps callId for the 600ms
        // closing flash, so the status check is needed, not just
        // the callId check.
        if (
          !this.state.callId ||
          this.state.status === "idle" ||
          this.state.status === "ended"
        ) {
          break;
        }
        // Audit-2 C1: spoofed ICE points media at the attacker's
        // relay — verify before adding or buffering.
        if (!(await this.verifyPayloadMac(signal))) break;
        // Audit-6 C-N1: the MAC check awaited — re-check the callId
        // before touching the (possibly new) call's peer connection.
        if (this.state.callId !== signal.callId) break;
        if (this.pc?.remoteDescription) {
          try {
            await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } catch {
            /* ignore */
          }
        } else if (this.pendingIce.length < MAX_PENDING_ICE) {
          this.pendingIce.push(signal.candidate);
        }
        break;
      }
      case "end": {
        // Audit-4 M7: an `end` for no active call is a no-op — do NOT
        // verify it (and especially do NOT burn the 2s M37 re-check).
        // While idle, state.callId is null, so the different-call
        // guard above passes any spoofed `end` through — each one
        // stalled the serialized signal queue ~2s + 2 server
        // round-trips, and a flood stalled every legitimate signal
        // behind it. An `end` can only ever act on the active call:
        // status ringing / calling / in-call with a matching
        // callId. (finish() itself no-ops on idle/ended, so this
        // skips nothing the case would have done.)
        if (
          this.state.status === "idle" ||
          this.state.status === "ended" ||
          this.state.callId !== signal.callId
        ) {
          break;
        }
        // C4: only act on an end the peer actually reported.
        // Audit-2 M37: the sender may be unloading — its keepalive
        // PATCH can land AFTER its `end` signal (websocket beats
        // HTTP), so a first verification failure gets ONE re-check
        // after 2s. Acceptance still requires the server row to say
        // "ended", so a spoofed end can't land; the normal flow
        // (report awaited before the signal) never waits.
        let verified = await this.verifyEventSignal(signal, "ended");
        if (!verified) {
          // Audit-6 C-N2: the re-check used to run for EVERY failed
          // verification — a spoofed `end` (which can NEVER verify:
          // no sender PATCH exists) burned the full 2s inside the
          // serialized signal queue, ~2s of stalled signaling per
          // spoof plus 2 server reads, repeatable at will. Bound
          // it: at most ONE re-check per call per 5s. A genuine
          // unload race needs exactly one (the PATCH lands within
          // the 2s), and a real end whose row already reads "ended"
          // verifies on the first attempt anyway.
          const now = Date.now();
          if (
            this.lastEndRecheckCallId === signal.callId &&
            now - this.lastEndRecheckAt < 5_000
          ) {
            return;
          }
          this.lastEndRecheckCallId = signal.callId;
          this.lastEndRecheckAt = now;
          await new Promise((r) => setTimeout(r, 2000));
          if (this.state.callId !== signal.callId) return;
          verified = await this.verifyEventSignal(signal, "ended");
          if (!verified) return;
        }
        // The verification above awaited — the call may have ended,
        // or a new call may have started, while it was in flight.
        // Only finish when this `end` still belongs to the current
        // call (the old `status !== "idle"` check would have
        // finished a NEW call whose `end` this is not).
        if (this.state.callId === signal.callId) {
          // Audit-2 M40: a caller-cancelled ring ends as "cancelled"
          // on the callee side too (no missed-call ping, no "missed"
          // history). An in-call hangup is still "completed"; every
          // other end (timeout, tab close, failure) is "missed".
          await this.finish(
            this.state.status === "in-call"
              ? "completed"
              : signal.reason === "cancelled"
                ? "cancelled"
                : "missed",
          );
        }
        break;
      }
      case "offer-request": {
        // Callee's app was closed and missed our offer — re-send it so the
        // callee can still pick up from the push notification.
        if (
          this.state.status === "calling" &&
          this.state.callId === signal.callId &&
          this.pc
        ) {
          // Audit-5 B3-MEDIUM: a self-asserted `from` was the ONLY
          // gate here — anyone who can post to the (public) call
          // channel could forge offer-requests during the ring
          // window and churn createOffer + re-sent offers. Verify
          // against the server row like every other event signal
          // (C4, and the sendSignal comment already claimed this):
          // the invite must be RINGING with the sender as this
          // call's callee. tableMissing still fails open (degraded
          // mode + banner), as C2 prescribes.
          if (!(await this.verifyEventSignal(signal, "ringing"))) return;
          // The verification awaited — the call may have ended (or
          // the peer connection been torn down) in flight; only
          // re-send for the call that is still ringing out.
          if (
            this.state.status !== "calling" ||
            this.state.callId !== signal.callId ||
            !this.pc
          ) {
            return;
          }
          // Audit-5 B3-MEDIUM: per-call re-send cooldown (see the
          // constant). A row-verified request from the callee can
          // still be a channel peer impersonating them — this bounds
          // the churn the auditor's proof demonstrated (N spoofs ->
          // ~1 offer per window, not N offers).
          const now = Date.now();
          if (
            this.lastOfferResendCallId === signal.callId &&
            now - this.lastOfferResendAt < OFFER_RESEND_COOLDOWN_MS
          ) {
            return;
          }
          this.lastOfferResendCallId = signal.callId;
          this.lastOfferResendAt = now;
          try {
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            await this.sendSignal(signal.from, {
              kind: "offer",
              callId: signal.callId,
              from: this.myId,
              sdp: offer,
              // Audit-3 A5-N9: every offer carries the sender's
              // type (audit-2 L43 invariant) — the re-sent offer
              // used to omit it.
              type: this.state.type,
            });
          } catch {
            // Peer went away mid-retry; the ring timeout will clean up.
          }
        }
        break;
      }
    }
  }
}
