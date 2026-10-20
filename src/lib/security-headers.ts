/**
 * Audit-3 A3-N1: the canonical security-header set for Cloudflare SSR
 * responses. `src/server.ts` applies these to EVERY Worker response
 * (normal + branded-error) via `withSecurityHeaders`.
 *
 * KEEP IN SYNC with `vercel.json` `headers` and `public/_headers` —
 * `scripts/check-security-headers-parity.mjs` fails the build on
 * drift. The CSP string is IDENTICAL in all three surfaces (copy it
 * verbatim; do not "improve" one copy).
 *
 * Audit-3 A3-N3: connect-src is tightened to this app's Supabase
 * project ref only (both hosts share the one project, so the same
 * string serves both).
 *
 * Audit-4 L70: `navigate-to 'self'` IS added — every
 * full-document navigation in the app is same-origin (all
 * location.replace targets are relative paths or safeNextPath
 * output, which enforces same-origin + an allowlisted route set;
 * no window.open, no external links, no mailto/tel). It hardens
 * against any future/injected navigation to an external URL.
 *
 * The other L70 directives are DELIBERATELY absent:
 * - report-uri / report-to: no reporting endpoint exists.
 *   Pointing at the SPA fallback would 200-OK the reports into
 *   HTML and silently drop them. A real endpoint is a new server
 *   surface, not a one-line CSP change.
 * - trusted-types / require-trusted-types-for: would break the
 *   two static dangerouslySetInnerHTML sinks (THEME_INIT_SCRIPT
 *   in __root, LANDING_HTML in index) — React sets innerHTML via
 *   the DOM API without TrustedHTML. Needs a Trusted Types
 *   policy migration, not a CSP one-liner.
 * - Cross-Origin-Embedder-Policy / Cross-Origin-Resource-Policy:
 *   require-corp would block cross-origin loads that send no CORP
 *   (Supabase storage signed URLs, Google Fonts) — attachments /
 *   fonts break. CORP: same-origin on the app's own responses
 *   would break cross-origin og-image fetches (link previews).
 *   No cross-origin-isolation need (no SharedArrayBuffer).
 *
 * Why every response, not just text/html: `_headers` already sends
 * this same set on `/*` (assets included), so Worker responses
 * behave uniformly whether they come from the asset binding or
 * Worker code. CSP on a JSON/XHR response is ignored by browsers;
 * HSTS / nosniff / framing headers are correct everywhere.
 */

/** The 7 security headers, in the same order as vercel.json / _headers. */
export const SECURITY_HEADERS: Array<[string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Permissions-Policy", "camera=(self), microphone=(self), geolocation=()"],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  [
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https://fkxgyhnivsaijzwpwpjf.supabase.co; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://fkxgyhnivsaijzwpwpjf.supabase.co wss://fkxgyhnivsaijzwpwpjf.supabase.co; media-src 'self' blob: https://fkxgyhnivsaijzwpwpjf.supabase.co; object-src 'none'; frame-src 'none'; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; navigate-to 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  ],
];

/**
 * Return `response` with the security headers applied. Responses are
 * immutable, so this rebuilds one with the same body/status and a
 * copied header set. The body stream is transferred, never read —
 * safe to call after `normalizeCatastrophicSsrResponse` (which only
 * ever reads a clone).
 *
 * Set-Cookie care: `Headers` iteration merges duplicate Set-Cookie
 * values into one comma-joined header (breaks `Expires=` dates), so
 * individual cookies are restored via `getSetCookie()` when present.
 *
 * `/sw.js` also gets `Cache-Control: no-cache` (Audit-2 M58): assets
 * normally come from the binding + `_headers`, but if the Worker
 * itself ever serves the SW script, it must never be cached.
 */
export function withSecurityHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of SECURITY_HEADERS) {
    headers.set(key, value);
  }
  if (new URL(request.url).pathname === "/sw.js") {
    headers.set("Cache-Control", "no-cache");
  }
  const getSetCookie = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(response.headers);
    if (cookies.length > 0) {
      headers.delete("set-cookie");
      for (const cookie of cookies) {
        headers.append("set-cookie", cookie);
      }
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
