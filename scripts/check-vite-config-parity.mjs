#!/usr/bin/env node
/**
 * Audit-2 M75 parity guard: resolve BOTH Vite configs (Cloudflare +
 * Vercel) and fail if they diverge. Both configs are thin wrappers
 * over the SAME Lovable preset and must differ ONLY in the Nitro
 * preset (Cloudflare default vs "vercel").
 *
 * Audit-3 A3-N8: plugin NAMES alone cannot catch option drift
 * (different tanstackStart options, different define values), so
 * the guard also compares the resolved `define` map, the app `@`
 * alias, and the tanstackStart option blocks in source. The full
 * resolved alias map is NOT compared: the Nitro preset injects
 * different unenv/node-polyfill aliases per target (Cloudflare
 * ~150 entries vs Vercel 7) — that difference is legitimate, and a
 * strict alias comparison would false-fail every build. The
 * tanstackStart options are compared in SOURCE because the resolved
 * plugin objects carry no options (closure-captured).
 *
 * Audit-3 A3-N4: wired into `build` and `build:vercel` (it never ran
 * in any build before — even a name-level divergence shipped silently).
 *
 * Audit-4 M33: the A3-N8 source checks were still holey —
 *   - only the tanstackStart block was compared, so `vite: {
 *     build: { sourcemap: true, minify: false } }`, a non-`@`
 *     alias, `react:` options, or any other defineConfig key on
 *     ONE config passed silently;
 *   - the Nitro check was a regex on source, so a commented-out
 *     `preset: "vercel"` line matched (false pass / false fail),
 *     and an EXTRA nitro key (e.g. `nitro: { preset: "vercel",
 *     compressPublicAssets: false }`) passed;
 *   - plugin ORDER/options were not compared, and nameless
 *     plugins were invisible (name-set comparison).
 * Fix: compare the ENTIRE defineConfig({...}) argument in source
 * (comments stripped first) key-by-key — every key except `nitro`
 * must be textually identical; CF must have NO `nitro` key and
 * VC's must be exactly `{ preset: "vercel" }`. Any key the preset
 * merges (vite/react/nitro/plugins/envDefine/...) is covered
 * because the comparison is key-agnostic. Resolved backstops
 * (plugin names, define, @ alias) are kept, plus whole-object
 * comparisons of the resolved fields with zero legitimate
 * target difference today (build/base/css/esbuild/server/preview).
 * `ssr` / `environments` / full `resolve` stay EXCLUDED — their
 * diffs are preset/target-explained (workerd vs node conditions,
 * Nitro runtime entry + output paths, preset-injected aliases).
 *
 * Audit-4 L79: the resolved comparisons also run in development
 * mode (`resolveConfig(..., "build", "development")`, matching
 * `build:dev`) — production-only resolution never compared
 * dev-mode define drift. The sandbox-retarget trap (preset
 * forcing cloudflare-module in a Lovable sandbox, even for the
 * Vercel config) is NOT guarded here — see
 * `scripts/check-not-sandbox.mjs`, wired into `build:vercel`.
 *
 * Usage: npm run check:vite-parity
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";

// Audit-7 F1: the config paths were cwd-relative (the last of the
// six build scripts still doing that) — run standalone from any
// other directory, the script died with a raw ENOENT instead of
// checking anything. Resolve from THIS script's location, like
// every sibling script: scripts/ -> project root. Vite's `root`
// is pinned for the same reason: the TanStack plugin resolves
// its router entry against root, which defaults to the cwd.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CF = join(projectRoot, "vite.config.ts");
const VERCEL = join(projectRoot, "vite.config.vercel.ts");

/**
 * @param {string} msg
 * @returns {never}
 */
const fail = (msg) => {
  console.error(`[vite-parity] FAIL: ${msg}`);
  process.exit(1);
};

// --- Comment stripper (JS/TS). Comments are removed; string
// literals are replaced by content-encoding placeholders — the
// placeholder carries the FULL literal text (base64url: no braces,
// commas, colons or quotes inside) so value drift like
// `entry: "server"` -> `entry: "other"` is still visible to the
// comparisons below. (Audit-4 M33: the first version of this guard
// stripped strings to `""`, which made ALL string-value drift
// invisible.) Template literals are one token each, so `${...}`
// code differences are captured too. ---
/**
 * @param {string} s
 * @returns {string}
 */
const encodeStr = (s) => `"__S_${Buffer.from(s, "utf8").toString("base64url")}__"`;
/**
 * @param {string} tok
 * @returns {string | null}
 */
const decodeStr = (tok) => {
  const m = /^"__S_([A-Za-z0-9_-]+)__"$/.exec(tok ?? "");
  return m ? Buffer.from(m[1], "base64url").toString("utf8") : null;
};
/**
 * @param {string} s
 * @returns {string}
 */
const readable = (s) => s.replace(/"__S_[A-Za-z0-9_-]+__"/g, (tok) => JSON.stringify(decodeStr(tok)));
/**
 * @param {string} src
 * @returns {string}
 */
const strip = (src) => {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
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
      let j = i + 1;
      while (j < n && src[j] !== q) {
        if (src[j] === "\\") j++;
        j++;
      }
      out += encodeStr(src.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") j++;
        j++;
      }
      out += encodeStr(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

/**
 * @param {string} s
 * @returns {string}
 */
const norm = (s) =>
  s
    .replace(/\s+/g, " ")
    .replace(/,\s*([}\]])/g, "$1") // trailing commas are inert
    .replace(/;+\s*$/, "")
    .trim();

// Extract the `defineConfig({ ... })` argument object (balanced
// braces) from a comment-stripped source.
/**
 * @param {string} src
 * @param {string} file
 * @returns {string}
 */
const defineConfigArg = (src, file) => {
  const m = /defineConfig\s*\(/.exec(src);
  if (!m) fail(`${file}: no defineConfig(...) call found`);
  const open = src.indexOf("{", m.index);
  if (open < 0) fail(`${file}: defineConfig argument is not an object literal`);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  fail(`${file}: unbalanced braces in defineConfig argument`);
};

// Split a `{ ... }` object body into top-level `key -> value` entries.
/**
 * @param {string} objText
 * @param {string} file
 * @returns {Map<string, string>}
 */
const topLevelEntries = (objText, file) => {
  const body = objText.slice(1, -1);
  const entries = new Map();
  let depth = 0;
  let cur = "";
  const flush = () => {
    const part = cur.trim();
    cur = "";
    if (!part) return;
    const colon = part.indexOf(":");
    if (colon < 0) fail(`${file}: cannot parse defineConfig entry ${JSON.stringify(part)}`);
    const key = part.slice(0, colon).trim();
    const value = norm(part.slice(colon + 1));
    if (entries.has(key)) fail(`${file}: duplicate defineConfig key ${key}`);
    entries.set(key, value);
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    if (c === "," && depth === 0) {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return entries;
};

/**
 * @param {{ plugins: ReadonlyArray<{ name?: string }> }} resolved
 * @returns {Array<string>}
 */
const pluginNames = (resolved) =>
  [
    ...new Set(
      resolved.plugins
        .map((p) => p.name)
        .filter(/** @param {string | undefined} name @returns {name is string} */ (name) => Boolean(name)),
    ),
  ].sort();

/**
 * @param {Record<string, unknown> | undefined | null} o
 * @returns {string}
 */
const sortedJson = (o) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );

const cfRaw = readFileSync(CF, "utf8");
const vercelRaw = readFileSync(VERCEL, "utf8");
const cfSrc = strip(cfRaw);
const vercelSrc = strip(vercelRaw);

// Both files must go through the preset (no hand-rolled plugin lists).
// Raw check pins the exact module path; stripped check proves the
// import is real code, not a comment/string (M32 pattern).
for (const [f, raw, src] of [
  [CF, cfRaw, cfSrc],
  [VERCEL, vercelRaw, vercelSrc],
]) {
  if (!/from\s*["']@lovable\.dev\/vite-tanstack-config["']/.test(raw)) {
    fail(`${f} does not use the shared Lovable preset — hand-rolled configs drift (M75).`);
  }
  if (!/import\s*\{[^}]*\}\s*from\s*"__S_[^"]+__"/.test(src)) {
    fail(`${f}: no real import statement found (preset import may be a comment/string).`);
  }
}

// --- Audit-4 M33: full defineConfig-argument comparison ---
const cfEntries = topLevelEntries(defineConfigArg(cfSrc, CF), CF);
const vcEntries = topLevelEntries(defineConfigArg(vercelSrc, VERCEL), VERCEL);
for (const key of new Set([...cfEntries.keys(), ...vcEntries.keys()])) {
  if (key === "nitro") continue; // handled below — the ONE allowed difference
  const cfVal = cfEntries.get(key);
  const vcVal = vcEntries.get(key);
  if (cfVal === undefined) fail(`${VERCEL} has defineConfig key ${key} that ${CF} lacks`);
  if (vcVal === undefined) fail(`${CF} has defineConfig key ${key} that ${VERCEL} lacks`);
  if (cfVal !== vcVal) {
    fail(
      `defineConfig key ${key} diverged.\n  ${CF}: ${readable(cfVal)}\n  ${VERCEL}: ${readable(vcVal)}`,
    );
  }
}
// Nitro: CF must have NO nitro key (preset cloudflare-module
// default); VC's must be EXACTLY { preset: "vercel" } — no extra
// nitro keys, no commented-out preset (comments are stripped).
if (cfEntries.has("nitro")) {
  fail(`${CF} pins a Nitro block — it must leave the preset default (cloudflare-module) in place.`);
}
const nitroValue = vcEntries.get("nitro");
if (nitroValue === undefined) {
  fail(`${VERCEL} does not pin a Nitro preset.`);
} else {
  // The nitro block must be EXACTLY { preset: "vercel" } — no extra
  // keys, no commented-out preset (comments are stripped).
  const nitroBody = nitroValue.replace(/^\{\s*|\s*\}$/g, "");
  const nitroParts = nitroBody.split(",").map((p) => p.trim()).filter(Boolean);
  const presetVal = nitroParts.length === 1 ? decodeStr(nitroParts[0].split(":")[1]?.trim()) : null;
  if (nitroParts.length !== 1 || presetVal !== "vercel") {
    fail(
      `${VERCEL} nitro block must be exactly { preset: "vercel" } (no extra keys).\n  Found: ${readable(nitroValue)}`,
    );
  }
}

const [cf, vc] = await Promise.all([
  resolveConfig({ configFile: CF, root: projectRoot }, "build", "production"),
  resolveConfig({ configFile: VERCEL, root: projectRoot }, "build", "production"),
]);

const cfNames = pluginNames(cf);
const vcNames = pluginNames(vc);
const onlyCf = cfNames.filter((n) => !vcNames.includes(n));
const onlyVc = vcNames.filter((n) => !cfNames.includes(n));
if (onlyCf.length > 0 || onlyVc.length > 0) {
  fail(
    `plugin lists diverged.\n  Only in ${CF}: ${JSON.stringify(onlyCf)}\n  Only in ${VERCEL}: ${JSON.stringify(onlyVc)}\n  ${CF}: ${JSON.stringify(cfNames)}\n  ${VERCEL}: ${JSON.stringify(vcNames)}`,
  );
}

// Audit-3 A3-N8: the resolved `define` map must be identical — a
// different VITE_* injection or TSS_* flag between hosts is silent
// behavior drift (both configs resolve in the same env here).
if (sortedJson(cf.define) !== sortedJson(vc.define)) {
  const cfKeys = Object.keys(cf.define ?? {});
  const vcKeys = Object.keys(vc.define ?? {});
  const diffKeys = [...new Set([...cfKeys, ...vcKeys])].filter(
    (k) => (cf.define ?? {})[k] !== (vc.define ?? {})[k],
  );
  fail(`resolved define maps diverged on: ${JSON.stringify(diffKeys)}`);
}

// Audit-3 A3-N8: the app `@` path alias must be identical. (The full
// alias map is preset-injected per Nitro target — see header — and
// is deliberately NOT compared.)
/**
 * @param {{ resolve?: { alias?: Array<{ find: string | RegExp }> } }} resolved
 * @returns {{ find: string | RegExp } | undefined}
 */
const atAlias = (resolved) => (resolved.resolve?.alias ?? []).find((a) => a.find === "@");
if (JSON.stringify(atAlias(cf)) !== JSON.stringify(atAlias(vc))) {
  fail(`@ alias diverged: ${JSON.stringify(atAlias(cf))} vs ${JSON.stringify(atAlias(vc))}`);
}

// Audit-4 M33: resolved backstops for fields with zero legitimate
// target difference — an app-level `vite:` drift that somehow
// survived the source comparison surfaces here.
for (const field of /** @type {Array<"build" | "base" | "css" | "esbuild" | "server" | "preview">} */ ([
  "build",
  "base",
  "css",
  "esbuild",
  "server",
  "preview",
])) {
  if (JSON.stringify(cf[field] ?? null) !== JSON.stringify(vc[field] ?? null)) {
    fail(`resolved ${field} diverged between configs (no legitimate target difference for this field)`);
  }
}

// Audit-4 L79: the guard used to resolve production mode ONLY, so
// dev-mode (`build:dev`) define drift was never compared. The
// preset injects mode-dependent defines (e.g. the dev NODE_ENV
// define), and a VITE_* / TSS_* value drifting in development mode
// alone would have shipped silently. Resolve both configs in
// development mode too (command "build", matching `build:dev`)
// and compare the same three things. The resolved-fields backstop
// above stays production-only by design.
const [cfDev, vcDev] = await Promise.all([
  resolveConfig({ configFile: CF, root: projectRoot }, "build", "development"),
  resolveConfig({ configFile: VERCEL, root: projectRoot }, "build", "development"),
]);

const cfDevNames = pluginNames(cfDev);
const vcDevNames = pluginNames(vcDev);
const onlyCfDev = cfDevNames.filter((n) => !vcDevNames.includes(n));
const onlyVcDev = vcDevNames.filter((n) => !cfDevNames.includes(n));
if (onlyCfDev.length > 0 || onlyVcDev.length > 0) {
  fail(
    `dev-mode plugin lists diverged.\n  Only in ${CF}: ${JSON.stringify(onlyCfDev)}\n  Only in ${VERCEL}: ${JSON.stringify(onlyVcDev)}\n  ${CF}: ${JSON.stringify(cfDevNames)}\n  ${VERCEL}: ${JSON.stringify(vcDevNames)}`,
  );
}

if (sortedJson(cfDev.define) !== sortedJson(vcDev.define)) {
  const cfDevKeys = Object.keys(cfDev.define ?? {});
  const vcDevKeys = Object.keys(vcDev.define ?? {});
  const diffDevKeys = [...new Set([...cfDevKeys, ...vcDevKeys])].filter(
    (k) => (cfDev.define ?? {})[k] !== (vcDev.define ?? {})[k],
  );
  fail(`dev-mode resolved define maps diverged on: ${JSON.stringify(diffDevKeys)}`);
}

if (JSON.stringify(atAlias(cfDev)) !== JSON.stringify(atAlias(vcDev))) {
  fail(`dev-mode @ alias diverged: ${JSON.stringify(atAlias(cfDev))} vs ${JSON.stringify(atAlias(vcDev))}`);
}

console.log(`[vite-parity] PASS: ${cfNames.length} plugins, identical in both configs.`);
console.log(`[vite-parity] ${CF} plugin names: ${JSON.stringify(cfNames)}`);
console.log(
  `[vite-parity] define maps identical (${Object.keys(cf.define ?? {}).length} keys); @ alias identical; defineConfig arguments identical except the Nitro preset.`,
);
console.log(
  `[vite-parity] dev-mode: ${cfDevNames.length} plugins identical, define maps identical (${Object.keys(cfDev.define ?? {}).length} keys), @ alias identical.`,
);
