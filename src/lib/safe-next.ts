/**
 * Audit-2 L26: ONE validator for the `?next=` return-to param, shared
 * by /login and /register (they used to each inline the same
 * string-prefix check, which missed backslash / encoded-slash edges
 * and mangled query+fragment on re-assembly).
 *
 * Rules:
 * - Reject control chars + backslashes anywhere (raw or %-encoded:
 *   `/\evil.com`, `/%5cevil.com` used to pass the prefix check and
 *   reach the router, where WHATWG URL rules treat `\` as `/`).
 * - Parse with `new URL(next, origin)` and require the SAME origin
 *   (kills `//evil.com`, `https://evil.com`, `javascript:…`).
 * - Validate the DECODED pathname too: `/%2F%2Fevil.com` decodes to
 *   `//evil.com` (protocol-relative) — the raw pathname check misses
 *   it. The decoded form is used ONLY for validation; the returned
 *   string keeps the encoded, normalized pathname.
 * - Allowlist: only real app routes (`/`, `/rooms…`, `/people`,
 *   `/calls`, `/profile`). Auth routes (`/login`, `/register`,
 *   `/join`, `/reset-password`, `/auth/callback`, `/set-password`)
 *   are NOT destinations — `?next=/login` used to navigate back to
 *   /login after login (loop-ish re-fire). Anything else → /rooms.
 * - The whole `?search#hash` is returned intact (callers pass it
 *   straight to `window.location.replace(safeNext)` — no manual
 *   param re-assembly, so fragments survive and `+` round-trips).
 *   Audit-3 L26-wiring: do NOT pass it to `navigate({ to })` — the
 *   router treats `to` as a pure pathname, so the built location
 *   carries the query/hash inside the pathname with empty search
 *   (a full-cycle test showed it landing only via the pushState +
 *   load re-parse — no 404 reproduced, but contract-violating and
 *   fragile for anything reading the built location). A
 *   full-document replace lets the browser parse it natively.
 *
 * Honest limit: TanStack Router's search model is single-value-per-
 * key (its qss encoder uses `URLSearchParams.set`), so a duplicate
 * key (`?x=1&x=2`) is re-shaped by the router into `?x=[1,2]`
 * (values preserved, shape changed) IF it ever goes through a router
 * navigation. Post-login uses `location.replace`, so the raw string
 * survives intact there. No app flow generates duplicate keys (callIds
 * are single UUIDs), so this costs nothing in practice — but the
 * validator deliberately does NOT mangle the string itself; any
 * reshaping would be the router's.
 */
const ALLOWED_PREFIXES = ["/rooms", "/people", "/calls", "/profile"];

function isAllowedAppPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function safeNextPath(next: string | null | undefined): string {
  const FALLBACK = "/rooms";
  if (!next) return FALLBACK;
  // Raw control chars (C0 + DEL + C1) / backslash.
  // eslint-disable-next-line no-control-regex -- matching control chars IS the check: reject redirect targets carrying them.
  if (/[\u0000-\u001f\u007f-\u009f\\]/.test(next)) return FALLBACK;
  // Encoded backslash (%5c) / encoded C0 controls + DEL (%00-%1f, %7f)
  // ANYWHERE in the string — including query values. No legitimate
  // return-to URL ever carries an encoded control character, and the
  // audit requires them rejected outright.
  if (/%5c/i.test(next)) return FALLBACK;
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(next)) return FALLBACK;
  let url: URL;
  try {
    url = new URL(next, window.location.origin);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== window.location.origin) return FALLBACK;
  // Decoded-pathname validation (see header: /%2F%2Fevil.com).
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return FALLBACK; // malformed % sequence
  }
  // eslint-disable-next-line no-control-regex -- matching control chars IS the check: reject redirect targets carrying them.
  if (decoded.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/.test(decoded)) return FALLBACK;
  if (!isAllowedAppPath(decoded)) return FALLBACK;
  return `${url.pathname}${url.search}${url.hash}`;
}
