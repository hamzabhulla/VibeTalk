// Audit-3 A3-N1/N2: fail the build if the security-header set drifts
// between its three surfaces — `src/lib/security-headers.ts` (the
// Cloudflare Worker path), `vercel.json` `headers` (the Vercel path),
// and `public/_headers` (Cloudflare static assets). The A3-N1/N2 bug
// was exactly this kind of drift: the policy existed in files that
// never reached the served responses. One policy, three deliveries,
// zero silent divergence.
//
// Wired into `npm run build` and `npm run build:vercel` (before the
// expensive bundling step). Fails closed: any unparseable surface,
// any count mismatch, or any key/value difference exits 1.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Audit-6 F-LOW-1: the default root is the PROJECT ROOT (this
// script's parent dir), not the caller's cwd — the LOW-11 flaw
// class. An explicit argv root is honored verbatim.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(projectRoot, "package.json"))) {
  console.error(
    `[check-security-headers-parity] FATAL: ${projectRoot} does not look like the project root (no package.json) — refusing to continue.`,
  );
  process.exit(1);
}
const root = process.argv[2] ? resolve(process.argv[2]) : projectRoot;
let failures = 0;
/** @param {string} msg */
function fail(msg) {
  failures++;
  console.error(`[check-security-headers-parity] FAIL: ${msg}`);
}

/**
 * Audit-6 F-INFO-1: surface reads used to be bare readFileSync —
 * a missing input died with a raw ENOENT stack instead of this
 * script's clean FAIL style (still fail-closed, just legible,
 * matching the pin scripts' FATAL lines).
 * @param {string} path
 * @param {string} label
 * @returns {string}
 */
function readSurface(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(`${label} is missing or unreadable (${path}) — cannot verify header parity.`);
    process.exit(1);
  }
}

/**
 * @param {Array<[string, string]>} entries
 * @param {string} label
 * @returns {Map<string, string>}
 */
function lowerMap(entries, label) {
  const map = new Map();
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (map.has(key)) fail(`${label}: duplicate header ${k}`);
    map.set(key, v);
  }
  return map;
}

// --- 1. src/lib/security-headers.ts: ["Key", "value"] pairs ---
const tsSrc = readSurface(resolve(root, "src/lib/security-headers.ts"), "src/lib/security-headers.ts");
/** @type {Array<[string, string]>} */
const tsPairs = [...tsSrc.matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,?\s*\]/g)].map((m) => [
  m[1],
  m[2],
]);
if (tsPairs.length !== 7) {
  fail(
    `security-headers.ts: expected exactly 7 SECURITY_HEADERS pairs, found ${tsPairs.length} (constant shape changed — update this check too)`,
  );
}
const tsMap = lowerMap(tsPairs, "security-headers.ts");
if (
  !tsSrc.includes('pathname === "/sw.js"') ||
  !tsSrc.includes('headers.set("Cache-Control", "no-cache")')
) {
  fail("security-headers.ts: missing the /sw.js Cache-Control: no-cache rule (audit-2 M58)");
}

// --- 2. server.ts must actually use the canonical set ---
// Audit-4 M32: the old check was two String.includes — a bare
// DISCARDED call `withSecurityHeaders(response, request); return
// response;` passed it, the build succeeded, and Cloudflare SSR
// shipped ZERO headers (withSecurityHeaders is pure: it returns a
// NEW Response, it never mutates the input). A comment or string
// literal mentioning the call would pass it too. So: strip
// comments + string literals, then require (a) a real import
// binding, (b) at least one VALUE-USED call (`return ...` or
// assignment), and (c) NO other occurrence of the identifier —
// any bare/discarded/callback-passed call fails the build.
const serverRaw = readSurface(resolve(root, "src/server.ts"), "src/server.ts");
/**
 * @param {string} src
 * @returns {string}
 */
function stripCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  // Stack of frames: { kind: "code" | "template", braceDepth }
  const stack = [{ kind: "code", braceDepth: 0 }];
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    const frame = top();
    if (frame.kind === "code") {
      if (c === "/" && next === "/") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && next === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        const q = c;
        i++;
        while (i < n && src[i] !== q) {
          if (src[i] === "\\") i++;
          i++;
        }
        i++;
        // Keep an empty-string placeholder so `from "..."` stays
        // structurally visible while the literal's content is gone.
        out += '""';
        continue;
      }
      if (c === "`") {
        stack.push({ kind: "template", braceDepth: 0 });
        i++;
        continue;
      }
      if (c === "$" && next === "{" && stack.length > 1) {
        frame.braceDepth++;
        out += c + next;
        i += 2;
        continue;
      }
      if (c === "{") {
        frame.braceDepth++;
        out += c;
        i++;
        continue;
      }
      if (c === "}") {
        if (stack.length > 1 && frame.braceDepth === 0) {
          stack.pop();
          i++;
          continue;
        }
        frame.braceDepth--;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    // Inside a template literal: skip everything except ${ ... }.
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      stack.pop();
      out += "``";
      i++;
      continue;
    }
    if (c === "$" && next === "{") {
      stack.push({ kind: "code", braceDepth: 0 });
      out += "${";
      i += 2;
      continue;
    }
    i++;
  }
  return out;
}
const serverSrc = stripCommentsAndStrings(serverRaw);
const importMatch = serverSrc.match(
  /import\s*\{[^}]*\bwithSecurityHeaders\b[^}]*\}\s*from\s*["']["']/,
);
const importPathMatch = serverRaw.match(
  /^\s*import\s*\{[^}]*\bwithSecurityHeaders\b[^}]*\}\s*from\s*["']\.\/lib\/security-headers["']/m,
);
if (!importMatch || !importPathMatch) {
  fail(
    "src/server.ts: must import withSecurityHeaders from ./lib/security-headers (real import, not a comment/string)",
  );
}
const usedCallPattern =
  /(?:return\s*\(?\s*(?:await\s+)?withSecurityHeaders\s*\(|[\w$.\[\]]+\s*=\s*(?:await\s+)?withSecurityHeaders\s*\()/g;
const usedCalls = [...serverSrc.matchAll(usedCallPattern)];
if (usedCalls.length === 0) {
  fail(
    "src/server.ts: withSecurityHeaders MUST be value-used — `return withSecurityHeaders(response, request)` or `response = withSecurityHeaders(...)`. A bare `withSecurityHeaders(response, request);` call discards the new Response (pure function) and ships ZERO headers.",
  );
}
// Any OTHER occurrence = a discarded / callback-passed call.
let remainder = serverSrc;
if (importMatch) remainder = remainder.replace(importMatch[0], " ");
for (const m of usedCalls) remainder = remainder.replace(m[0], " ");
if (/\bwithSecurityHeaders\b/.test(remainder)) {
  fail(
    "src/server.ts: withSecurityHeaders appears outside a value-used call (discarded call / callback / comment) — every call site must use its return value",
  );
}

// --- 3. vercel.json ---
/** @type {{ headers: Array<{ source: string, headers?: Array<{ key: string, value: string }> }> }} */
const vercelJson = JSON.parse(readSurface(resolve(root, "vercel.json"), "vercel.json"));
if (!Array.isArray(vercelJson.headers) || vercelJson.headers.length === 0) {
  fail("vercel.json: no `headers` array");
  process.exit(1);
}
const swEntry = vercelJson.headers[0];
if (
  swEntry.source !== "/sw.js" ||
  !swEntry.headers?.some((h) => h.key.toLowerCase() === "cache-control" && h.value === "no-cache")
) {
  fail(
    "vercel.json: FIRST headers entry must be /sw.js with Cache-Control: no-cache (audit-2 M58)",
  );
}
const catchAll = vercelJson.headers.find((e) => e.source === "/(.*)");
if (!catchAll || !catchAll.headers) {
  fail('vercel.json: missing the "/(.*)" headers entry');
  process.exit(1);
}
// Audit-4 L73: pin the EXACT entry set — the old check only
// required headers[0] to be /sw.js + a /(.*) entry to exist, so
// an EXTRA entry passed and pin-vercel-headers blindly emitted it
// (a third route could carry weakening headers). /(.*) must be
// the second entry, and there must be exactly two.
if (vercelJson.headers.length !== 2 || vercelJson.headers[1].source !== "/(.*)") {
  fail(
    `vercel.json: expected exactly 2 headers entries [/sw.js, /(.*)], found [${vercelJson.headers.map((e) => e.source).join(", ")}] (entry set changed — update this check too)`,
  );
}
const vercelMap = lowerMap(
  catchAll.headers.map((h) => [h.key, h.value]),
  "vercel.json",
);

// --- 4. public/_headers: /* block (+ /sw.js block) ---
const headersText = readSurface(resolve(root, "public/_headers"), "public/_headers");
/** @type {Map<string, Array<[string, string]>>} */
const blocks = new Map();
/** @type {string | null} */
let current = null;
for (const rawLine of headersText.split("\n")) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  if (line.startsWith("/") && !line.includes(":")) {
    // Audit-4 L77: the parser used to `blocks.set(current, [])`
    // unconditionally — a duplicate block header SILENTLY
    // collapsed to the last block's entries. A duplicate /*
    // with DIFFERENT values would have passed the guard while
    // Cloudflare served only one of them. Any duplicate fails
    // the build (even an identical-value one is a mistake —
    // the built .output/public/_headers already carries a
    // pipeline-appended identical /assets/* block, which is
    // harmless but is the pipeline's doing, not the source's).
    // On duplicate, keep the FIRST block's entries (no reset)
    // and let the failure exit the build.
    if (blocks.has(line)) {
      fail(
        `public/_headers: duplicate block ${line} — duplicates used to collapse silently to the last block (a duplicate /* with different values would have passed while shipping only one of them)`,
      );
    } else {
      blocks.set(line, []);
    }
    current = line;
    continue;
  }
  const m = line.match(/^([\w-]+):\s*(.+)$/);
  if (m && current) {
    const entries = blocks.get(current);
    if (entries) entries.push([m[1], m[2]]);
  }
}
if (!blocks.has("/*")) fail("public/_headers: missing the /* block");
const cfMap = lowerMap(blocks.get("/*") ?? [], "public/_headers /*");
const swBlock = blocks.get("/sw.js") ?? [];
if (!swBlock.some(([k, v]) => k.toLowerCase() === "cache-control" && v === "no-cache")) {
  fail("public/_headers: /sw.js block must set cache-control: no-cache (audit-2 M58)");
}
// Audit-4 L73: the old check parsed /* + /sw.js only, so a
// weakening header added to /assets/* passed silently (Cloudflare
// Pages lets a more-specific path override /* for the same header
// name). Pin the EXACT block set + the non-security blocks'
// exact contents: /assets/* may carry ONLY the immutable
// cache-control rule (no security-header overrides), /sw.js ONLY
// cache-control: no-cache. A new block must update this check.
const blockNames = [...blocks.keys()];
for (const expected of ["/*", "/assets/*", "/sw.js"]) {
  if (!blocks.has(expected)) fail(`public/_headers: missing the ${expected} block`);
}
for (const name of blockNames) {
  if (!["/*", "/assets/*", "/sw.js"].includes(name)) {
    fail(`public/_headers: unexpected block ${name} (block set changed — update this check too)`);
  }
}
const assetsBlock = blocks.get("/assets/*") ?? [];
if (
  assetsBlock.length !== 1 ||
  assetsBlock[0][0].toLowerCase() !== "cache-control" ||
  assetsBlock[0][1] !== "public, max-age=31536000, immutable"
) {
  fail(
    `public/_headers: /assets/* block must contain ONLY "cache-control: public, max-age=31536000, immutable", found ${JSON.stringify(assetsBlock)}`,
  );
}
if (
  swBlock.length !== 1 ||
  swBlock[0][0].toLowerCase() !== "cache-control" ||
  swBlock[0][1] !== "no-cache"
) {
  fail(
    `public/_headers: /sw.js block must contain ONLY "cache-control: no-cache", found ${JSON.stringify(swBlock)}`,
  );
}

// --- 5. Compare the three maps ---
/** @type {Array<[string, Map<string, string>]>} */
const comparisons = [
  ["vercel.json", vercelMap],
  ["public/_headers", cfMap],
];
for (const [label, map] of comparisons) {
  for (const [k, v] of tsMap) {
    if (!map.has(k)) fail(`${label}: missing header ${k}`);
    else if (map.get(k) !== v)
      fail(`${label}: ${k} differs:\n  canonical: ${v}\n  ${label}:    ${map.get(k)}`);
  }
  for (const k of map.keys()) {
    if (!tsMap.has(k)) fail(`${label}: extra header ${k} not in security-headers.ts`);
  }
}

if (failures > 0) {
  console.error(
    `[check-security-headers-parity] ${failures} mismatch(es) — fix the drift, do not weaken this check.`,
  );
  process.exit(1);
}
console.log(
  "[check-security-headers-parity] OK: security-headers.ts == vercel.json /(.*) == public/_headers /* (7 headers) + /sw.js no-cache on all surfaces + vercel.json exactly [/sw.js, /(.*)] + _headers exactly [/*, /assets/* (immutable cache-control only), /sw.js]",
);
