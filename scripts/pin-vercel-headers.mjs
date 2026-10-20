// Audit-3 A3-N2: emit the `vercel.json` header set as `routes` with
// `headers` in `.vercel/output/config.json`.
//
// The documented Vercel deploy path uploads `.vercel/output` via MCP
// — a PREBUILT deployment whose routing/headers come ONLY from
// `.vercel/output/config.json`. `vercel.json` is not inside
// `.vercel/output`, so Vercel never applies its `headers` to a
// prebuilt deploy: the live site served zero app headers (the only
// HSTS was Vercel's platform default `max-age=63072000; ...; preload`,
// NOT the configured `max-age=31536000; includeSubDomains`).
//
// This post-build step (wired into `npm run build:vercel`) converts
// `vercel.json` `headers` into config.json routes, preserving the
// array order (so the `/sw.js` no-cache route stays FIRST, per
// audit-2 M58) and the preset's own routes untouched after them.
// Routes use `continue: true` so routing falls through to the
// preset's `filesystem` / `/__server` routes after headers apply.
//
// Idempotent (Audit-4 L71): the routes this script emitted on the
// previous run are recorded in `.pin-vercel-headers.snapshot.json`
// (gitignored, project root) as exact { src, headers } pairs. On
// re-run, ONLY routes exactly matching the snapshot are removed —
// never by shape. The old shape filter (headers + continue:true,
// no dest/handle) would have deleted a legitimate future preset
// route with that shape (e.g. Nitro emitting its own catch-all
// header route), silently dropping the preset's headers. If the
// config already contains shape-matching routes but there is NO
// snapshot to identify them, the script REFUSES (fail-closed) —
// delete `.vercel/output` and re-run `build:vercel` (which cleans
// first, so the normal path never hits this).
//
// Routing-survival check (Audit-4 L71): after the rewrite, the
// script verifies the preset's `filesystem` handle route and the
// `/__server` dest route still exist BEFORE writing anything. If
// either is missing, it fails the build instead of shipping a
// config that serves nothing.
//
// Audit-4 L76: also deletes `.vercel/output/static/_headers`
// (Vite copies public/ verbatim; Vercel ignores `_headers`, so it
// would otherwise ship as a publicly-fetchable /_headers).
//
// Audit-4 L78: also asserts the Nitro preset's `/assets/(.*)`
// immutable route still exists in the final config — vercel.json
// declares no /assets/* rule, so a preset upgrade dropping it
// would silently lose immutable caching on Vercel.
//
// Fails the build if `vercel.json` or `config.json` is
// missing/unparseable, or if `vercel.json` has no `headers` array
// — a deploy must never proceed silently headerless.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Audit-6 F-LOW-1: the default root is the PROJECT ROOT (this
// script's parent dir), not the caller's cwd — the LOW-11 flaw
// class. An explicit argv root is honored verbatim.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(projectRoot, "package.json"))) {
  console.error(
    `[pin-vercel-headers] FATAL: ${projectRoot} does not look like the project root (no package.json) — refusing to continue.`,
  );
  process.exit(1);
}
const root = process.argv[2] ? resolve(process.argv[2]) : projectRoot;

/**
 * @param {string} message
 * @returns {never}
 */
function fatal(message) {
  console.error(`[pin-vercel-headers] FATAL: ${message}`);
  process.exit(1);
}

/**
 * @param {string} path
 * @param {string} label
 * @returns {any}
 */
function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    fatal(`${label} not found at ${path} — refusing to continue (a deploy without it would ship headerless).`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fatal(`${label} at ${path} is not valid JSON.`);
  }
}

// Key order-insensitive deep equality for { src, headers } pairs
// (JSON round-trips preserve insertion order, but don't bet the
// removal on it).
/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

// vercel.json `source` uses `(.*)` segments; config.json `src` is a
// regex. Anchor it: "/sw.js" -> "^/sw\\.js$", "/(.*)" -> "^/.*$".
/**
 * @param {string} source
 * @returns {string}
 */
function sourceToSrc(source) {
  const parts = source.split("(.*)");
  const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^${escaped.join(".*")}$`;
}

/** @type {{ headers: Array<{ source: string, headers: Array<{ key: string, value: string }> }> }} */
const vercelJson = readJson(resolve(root, "vercel.json"), "vercel.json");
if (!Array.isArray(vercelJson.headers) || vercelJson.headers.length === 0) {
  fatal("vercel.json has no `headers` array — refusing to emit an empty header set.");
}

const configPath = resolve(root, ".vercel/output/config.json");
/** @type {{ routes: Array<{ src?: string, headers?: Record<string, string>, continue?: boolean, dest?: string, handle?: string }> }} */
const config = readJson(configPath, ".vercel/output/config.json");
if (!Array.isArray(config.routes)) {
  fatal(".vercel/output/config.json has no `routes` array — refusing to guess the route shape.");
}

/** @type {Array<{ src?: string, headers?: Record<string, string>, continue?: boolean, dest?: string, handle?: string }>} */
const headerRoutes = vercelJson.headers.map((entry) => ({
  src: sourceToSrc(entry.source),
  // Lowercase keys to match the preset's own route style
  // ("cache-control" on the /assets route). Header names are
  // case-insensitive; Vercel sends them as configured.
  headers: Object.fromEntries(entry.headers.map((h) => [h.key.toLowerCase(), h.value])),
  continue: true,
}));

// Audit-4 L71: remove ONLY the routes this script emitted on the
// previous run (exact snapshot match — src + headers). A
// vercel.json header VALUE change (e.g. a CSP edit) still removes
// the stale emission, because the snapshot records the PREVIOUS
// emission, not the current one.
const snapshotPath = resolve(root, ".pin-vercel-headers.snapshot.json");
/** @type {{ routes?: Array<{ src: string, headers: Record<string, string> }> } | null} */
let snapshot = null;
let snapshotExists = false;
try {
  snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  snapshotExists = true;
} catch (err) {
  const code = /** @type {{ code?: unknown }} */ (err).code;
  if (code !== "ENOENT") {
    fatal(`snapshot at ${snapshotPath} is not valid JSON — refusing to guess which routes are ours.`);
  }
}
if (snapshotExists && (!snapshot || !Array.isArray(snapshot.routes))) {
  fatal(`snapshot at ${snapshotPath} has no \`routes\` array — refusing to guess which routes are ours.`);
}
const recordedKeys = new Set(
  (snapshot?.routes ?? []).map((r) => `${r.src}\n${stableStringify(r.headers)}`),
);
const shapeMatches = config.routes.filter(
  (r) => r.headers && r.continue === true && !r.dest && !r.handle,
);
if (!snapshotExists && shapeMatches.length > 0) {
  fatal(
    `config already contains ${shapeMatches.length} header route(s) (headers + continue:true, no dest/handle) but no snapshot file exists to identify which ones this script emitted — refusing to guess (a future preset route could be deleted). Delete .vercel/output and re-run build:vercel (it cleans first).`,
  );
}
const presetRoutes = config.routes.filter(
  (r) => !recordedKeys.has(`${r.src}\n${stableStringify(r.headers ?? null)}`),
);

const newRoutes = [...headerRoutes, ...presetRoutes];

// Audit-4 L71: verify routing survives BEFORE writing anything —
// a config without the filesystem handle or the /__server
// fallback serves nothing.
if (!newRoutes.some((r) => r.handle === "filesystem")) {
  fatal("routing-survival check failed: no { handle: \"filesystem\" } route in the rewritten config — refusing to write it.");
}
if (!newRoutes.some((r) => typeof r.dest === "string" && r.dest.includes("__server"))) {
  fatal("routing-survival check failed: no route with a /__server dest in the rewritten config — refusing to write it.");
}

// Audit-4 L78: the /assets/* immutable rule comes SOLELY from the
// Nitro preset's generated route — vercel.json declares no
// /assets/* rule (L73 pins vercel.json to exactly [/sw.js,
// /(.*)]). If a preset upgrade drops or weakens that route,
// Vercel assets lose immutable caching with NOTHING noticing
// (perf, not security — but a silent regression). Fail the build
// instead: the final config must still carry the preset route
// with the exact immutable cache-control value.
const assetsRoute = newRoutes.find((r) => r.src === "/assets/(.*)");
const assetsCacheControl = assetsRoute?.headers
  ? Object.entries(assetsRoute.headers).find(([k]) => k.toLowerCase() === "cache-control")?.[1]
  : undefined;
if (assetsCacheControl !== "public, max-age=31536000, immutable") {
  fatal(
    "preset /assets/(.*) immutable route missing or weakened in the rewritten config — Vercel assets would lose immutable caching. If the Nitro preset dropped it, declare the rule in vercel.json (and update the L73 exact-entry check) instead of shipping without it.",
  );
}

// Audit-4 L76: Vercel does NOT consume `_headers` (Cloudflare
// Pages-only), but Vite copies public/ verbatim into
// .vercel/output/static/ — so the file shipped inside the Vercel
// deploy and was publicly fetchable at /_headers. Content is only
// public header policy (no secrets), but there is no reason to
// publish the policy file itself. Delete it from the Vercel
// output. public/_headers itself STAYS — the Cloudflare build
// needs it. Only static/ is served as static files, so this is
// the one copy that could be fetched. Unlink failure is FATAL:
// a deploy must not proceed with the file present.
const vercelStaticHeaders = resolve(root, ".vercel/output/static/_headers");
if (existsSync(vercelStaticHeaders)) {
  try {
    unlinkSync(vercelStaticHeaders);
  } catch {
    fatal(
      `could not remove ${vercelStaticHeaders} from the Vercel output — refusing to ship a publicly-fetchable /_headers.`,
    );
  }
  console.log("[pin-vercel-headers] removed Cloudflare-only _headers from the Vercel static output");
}

// Snapshot first: if the config write then fails, the stale
// snapshot is harmless (its routes simply won't be found next
// run, so nothing is wrongly removed).
writeFileSync(
  snapshotPath,
  `${JSON.stringify({ routes: headerRoutes.map(({ src, headers }) => ({ src, headers })) }, null, 2)}\n`,
);
writeFileSync(configPath, `${JSON.stringify({ ...config, routes: newRoutes }, null, 2)}\n`);
console.log(
  `[pin-vercel-headers] emitted ${headerRoutes.length} header routes into ${configPath} (first: ${headerRoutes[0]?.src})`,
);
