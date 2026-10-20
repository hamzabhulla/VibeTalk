import { useEffect, useRef, useState } from "react";

/**
 * M62: resend cooldown — after a successful send, the button stays
 * disabled for `seconds` with a live countdown. Prevents resend spam
 * (email volume) without depending on Supabase's generic throttle,
 * whose error surfaces as a cryptic toast. Start ONLY on success —
 * a failed send must stay immediately retryable.
 *
 * Audit-5 B2-INFO: the gates are REF-backed. React `remaining`
 * (state) doesn't update within the same tick, so a handler that
 * only consulted `coolingDown` let a same-tick second invoke
 * through — two resend emails before the first finished.
 * Handlers now: entry `tryReserve()` (false when cooling or a
 * send is already in flight), `start()` on success (arms the
 * cooldown + releases the reservation), `release()` on a failed
 * send (stays retryable, per M62). State still drives the UI.
 */
export function useResendCooldown(seconds = 60) {
  const [remaining, setRemaining] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const coolingRef = useRef(false);
  const inFlightRef = useRef(false);
  const tryReserve = () => {
    if (coolingRef.current || inFlightRef.current) return false;
    inFlightRef.current = true;
    return true;
  };
  const release = () => {
    inFlightRef.current = false;
  };
  const start = () => {
    if (coolingRef.current) return false;
    inFlightRef.current = false;
    coolingRef.current = true;
    setRemaining(seconds);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          if (timer.current) clearInterval(timer.current);
          coolingRef.current = false;
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return true;
  };
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );
  return { remaining, start, tryReserve, release, coolingDown: remaining > 0 };
}
