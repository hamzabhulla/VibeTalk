import { useEffect, useRef } from "react";

/**
 * M80: object-URL lifecycle for image previews. `URL.createObjectURL`
 * leaks the blob until revoked — every re-pick and every unmount used
 * to leak one. This hook revokes the previous URL on replace and
 * whatever remains on unmount. Callers keep their own state for
 * rendering; they pass the new URL through `set()` and call `clear()`
 * when discarding the preview (e.g. dialog close).
 */
export function useObjectUrl() {
  const ref = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (ref.current) URL.revokeObjectURL(ref.current);
    },
    [],
  );
  const set = (url: string | null) => {
    if (ref.current) URL.revokeObjectURL(ref.current);
    ref.current = url;
    return url;
  };
  const clear = () => set(null);
  return { set, clear };
}
