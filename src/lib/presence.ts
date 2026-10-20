/**
 * Presence helper: the DB `is_online` flag is write-once (touch_presence only
 * ever sets it true), so every reader MUST use the heartbeat staleness check
 * instead of trusting the raw column. Heartbeat runs every 25s while the app
 * is visible; 120s of silence means offline.
 *
 * Audit-2 L69: `last_seen_at` is written by the SERVER clock, but the
 * old check compared it against the CLIENT clock — a device clock
 * ±3 min off lied about online/offline. The app records the
 * server-client skew once per load (from getServerSupabaseConfig's
 * serverNowMs, see _app.tsx) and this check uses the corrected now.
 * Default skew 0 (no correction) until the first measurement lands.
 *
 * Audit-4 L47: the window is 120s (was 70s). Hidden-tab timers
 * throttle to ~1/min, so background-tab heartbeats arrive ~60s
 * apart — against a 70s window that left only a 10s margin, and
 * a slow heartbeat RPC or scheduling jitter pushed the gap past
 * 70s, so background-tab users flickered "offline". 120s leaves
 * 60s of margin over the throttled cadence. Cost: a crashed /
 * killed tab (no keepalive markOffline) shows "Online now" for
 * up to 120s instead of 70s — clean closes still mark offline
 * immediately via the keepalive PATCH.
 */
import { formatDistance } from "date-fns";

let clockSkewMs = 0;

/** Audit-4 L47: heartbeat staleness window (see the header comment). */
export const PRESENCE_STALENESS_MS = 120_000;

/** Audit-6 C-N3: largest believable clock skew — one hour. */
const MAX_CLOCK_SKEW_MS = 3_600_000;

export function setClockSkew(serverNowMs: number): void {
  if (!Number.isFinite(serverNowMs)) return;
  const skew = serverNowMs - Date.now();
  // Audit-6 C-N3: the old guard accepted ANY finite value — one
  // poisoned measurement (a bogus serverNowMs) pinned the session
  // with a huge skew: a year-old last_seen_at read "online"
  // (skew = -now) and a just-seen user read "offline" (skew =
  // +now), and the 5-min modify window inverted with it (both
  // read serverAlignedNowMs / isUserOnline). Real device skew is
  // minutes (L69 saw ±3 min); anything past ±1h is a broken clock
  // or a bad source — ignore the measurement and keep the last
  // good skew (the app re-measures every load).
  if (Math.abs(skew) > MAX_CLOCK_SKEW_MS) return;
  clockSkewMs = skew;
}

export function isUserOnline(lastSeenAt: string | null | undefined): boolean {
  if (!lastSeenAt) return false;
  return Date.now() + clockSkewMs - new Date(lastSeenAt).getTime() < PRESENCE_STALENESS_MS;
}

/**
 * Audit-5 B2-LOW: the clock-skew-corrected now (same correction
 * isUserOnline uses). Compare server-issued timestamps (message
 * created_at) against this, not Date.now() — a skewed client clock
 * otherwise shows/hides time-gated UI wrongly (the 5-min
 * edit/delete window, server enforces it anyway).
 */
export function serverAlignedNowMs(): number {
  return Date.now() + clockSkewMs;
}

/**
 * Audit-4 L43: format a SERVER-stamped timestamp (`last_seen_at`)
 * as relative time against the SKEW-CORRECTED now. The call sites
 * used to pass the raw stamp to formatDistanceToNow, which compares
 * against the uncorrected client clock — a device clock ±3 min off
 * showed "Last seen 3 minutes ago" for someone online right now
 * (or "in 3 minutes" for a just-seen user when the client clock
 * runs behind). isUserOnline already used the corrected now; the
 * displayed text did not. formatDistance with an explicit base
 * date is exactly formatDistanceToNow with a corrected "now".
 * Missing/invalid stamps return "" — the call sites already guard
 * with truthiness, so this is only a backstop.
 */
export function formatServerRelativeTime(stamp: string | null | undefined): string {
  if (!stamp) return "";
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return "";
  return formatDistance(date, new Date(Date.now() + clockSkewMs), { addSuffix: true });
}
