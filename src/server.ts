import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { withSecurityHeaders } from "./lib/security-headers";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry")
      .then((m) => (m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry))
      // Audit-4 L66: reset the cache on failure — a transient
      // import rejection used to poison every subsequent request
      // (the same rejected promise awaited forever → branded 500s
      // until the isolate restarted). The next request re-imports
      // instead of re-awaiting the dead promise.
      .catch((err) => {
        serverEntryPromise = undefined;
        throw err;
      });
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

// Audit-3 A3-11 (documented, by design): unmatched URLs render the
// 404 component with HTTP 200 — standard SPA behaviour. A real 404
// status would require detecting the router's not-found render in
// this entry, and the options are both bad in this TanStack Start
// version: (1) body-sniffing for a not-found marker would buffer
// every HTML response (killing SSR streaming) and risks false 404s
// if user content ever contains the marker; (2) re-implementing
// route matching here duplicates the framework's router. The 404
// component itself carries the correct content + exit paths
// (logged-in → "Back to chats", logged-out → "Go home"), so
// crawlers see a real not-found page, just with a 200 status.
export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await normalizeCatastrophicSsrResponse(
        await handler.fetch(request, env, ctx),
      );
      // Audit-4 L75: withSecurityHeaders used to be called OUTSIDE
      // this try — if it threw (204-with-body, malformed
      // request.url, locked body), the Worker fetch threw → the
      // platform served a bare 500 with NO security headers and no
      // branded page. Inside the try, its throw lands in the catch
      // below, which still returns a branded page WITH headers.
      // (Audit-3 A3-N1: headers go on EVERY Worker response — SSR
      // documents, server-fn JSON, and the branded error page.
      // _headers covers the asset binding only.)
      return withSecurityHeaders(response, request);
    } catch (error) {
      console.error(error);
      try {
        return withSecurityHeaders(brandedErrorResponse(), request);
      } catch {
        // withSecurityHeaders itself failed (e.g. request.url is
        // unparseable, so the retry threw too) — last resort: the
        // branded page bare. A platform bare 500 would be worse
        // (no branded page AND no headers either).
        return brandedErrorResponse();
      }
    }
  },
};
