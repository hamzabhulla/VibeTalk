import { useSyncExternalStore } from "react";

/**
 * M99: push self-heal failure state, shared between __root (the writer)
 * and the Profile diagnostics (the readers). A module-level store in
 * the useTheme pattern — the failure must survive navigation (a toast
 * would vanish) and clear only on a successful heal, a manual
 * notifications toggle, or SIGNED_OUT (audit-2 M1: a failure recorded
 * while logged out is an auth failure, not a push failure, and must
 * not haunt the next login).
 * Audit-2 L75: the stored message is USER-SAFE text, mapped from the
 * raw error by recordPushHealFailure — the old version stored the raw
 * server/SDK message verbatim (unfriendly, potentially leaking
 * internals) in diagnostics. The raw text is console.warned, never
 * stored.
 */
export type PushHealFailure = { at: number; message: string };

let failure: PushHealFailure | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A broken listener must not break the store.
    }
  }
}

export function recordPushHealFailure(raw: string): void {
  const lower = raw.toLowerCase();
  let message: string;
  if (
    lower.includes("denied") ||
    lower.includes("notallowed") ||
    lower.includes("permission")
  ) {
    message = "Notifications permission was denied.";
  } else if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("timeout") ||
    // Audit-7 E2: "timed out" (two words) does not contain the
    // substring "timeout" — a heal failure worded that way fell to
    // the generic toggle-off-and-on hint instead of the connection
    // hint. Same outage class, second spelling.
    lower.includes("timed out") ||
    lower.includes("failed to fetch") ||
    lower.includes("offline")
  ) {
    message = "Could not reach the server — check your connection.";
  } else {
    message = "Push setup failed — toggle notifications off and on to retry.";
  }
  console.warn("[push] self-heal failed:", raw);
  failure = { at: Date.now(), message };
  emit();
}

export function clearPushHealFailure(): void {
  if (failure !== null) {
    failure = null;
    emit();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): PushHealFailure | null {
  return failure;
}

export function usePushHealFailure(): PushHealFailure | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
