import { useSyncExternalStore } from "react";

/**
 * Audit-2 M17: SSR-safe breakpoint. The old hook read matchMedia in
 * the state INITIALIZER — on the server `typeof window === "undefined"`
 * made it `false` (mobile shell in the SSR HTML), while on the client
 * the same initializer returned `true` on a desktop viewport: a
 * hydration mismatch, a mobile→desktop swap on first paint, and
 * wrong-branch queries firing before the swap.
 *
 * Now the value is a module-level store: `null` while unknown
 * (server AND first client render — identical trees, zero
 * mismatch), computed once in the subscribe effect, then cached for
 * every later mount (client-side navigation never re-flashes the
 * placeholder). Consumers render a query-free placeholder while
 * `null`. Pure-CSS switching was NOT used: both branches would mount
 * and fire both sets of queries/channels (the double-subscription
 * M16 just removed).
 */
let current: boolean | null = null;
const listeners = new Set<() => void>();
let subscribed = false;
let mq: MediaQueryList | null = null;

function setCurrent(value: boolean) {
  if (value !== current) {
    current = value;
    for (const listener of listeners) listener();
  }
}

function onMediaChange(e: MediaQueryListEvent) {
  setCurrent(e.matches);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!subscribed && typeof window !== "undefined") {
    subscribed = true;
    mq = window.matchMedia("(min-width: 768px)");
    setCurrent(mq.matches);
    mq.addEventListener("change", onMediaChange);
  }
  return () => {
    listeners.delete(cb);
    // Audit-4 L51: when the LAST subscriber leaves, remove the
    // matchMedia listener too and reset `subscribed` — the old
    // cleanup left the breakpoint listener alive for the page
    // lifetime, and a later mount never re-subscribed. The store
    // is still a singleton while anyone is subscribed; `current`
    // keeps its last value, and a remount re-reads mq.matches, so
    // a breakpoint change while unsubscribed is picked up fresh.
    if (listeners.size === 0 && mq) {
      mq.removeEventListener("change", onMediaChange);
      mq = null;
      subscribed = false;
    }
  };
}

/** `null` = breakpoint not known yet (SSR / pre-hydration). Never use truthiness — check `=== null` first. */
export function useIsDesktop(): boolean | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
