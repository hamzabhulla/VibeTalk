// Audit-2 H37: pin the generated Cloudflare worker name to "hc".
//
// The Nitro/Cloudflare preset generates .output/server/wrangler.json with
// "name": "tanstack-start-ts" (derived from package.json's name), but the
// production worker is "hc". A plain `npx nitro deploy --prebuilt` reads
// that generated config, so it would CREATE a new "tanstack-start-ts"
// worker and leave "hc" stale. Verified 2026-10-18 via the Cloudflare
// API: the account holds exactly one worker ("hc", modified at the last
// deploy); "tanstack-start-ts" 404s — past deploys reached "hc" only via
// an undocumented override, and the next plain deploy would have missed.
//
// This post-build step (wired into `npm run build`) pins the generated
// config to "hc" and FAILS the build if the config is missing or
// unparseable — a deploy can never proceed with the wrong name.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_NAME = "vibetalk";
// Audit-6 F-LOW-1: the default target resolves against the PROJECT
// ROOT (this script's parent dir), not the caller's cwd — the
// LOW-11 flaw class. Run from a foreign directory, the old default
// read/wrote a foreign .output tree (or failed confusingly); a
// lookalike foreign tree could even take a silent wrong-tree pin.
// An explicit argv path is honored verbatim (callers/tests).
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(projectRoot, "package.json"))) {
  console.error(
    `[pin-worker-name] FATAL: ${projectRoot} does not look like the project root (no package.json) — refusing to continue.`,
  );
  process.exit(1);
}
const target = process.argv[2]
  ? resolve(process.argv[2])
  : join(projectRoot, ".output/server/wrangler.json");

let raw;
try {
  raw = readFileSync(target, "utf8");
} catch {
  console.error(
    `[pin-worker-name] FATAL: ${target} not found — refusing to continue (a deploy without this config would target the wrong worker).`,
  );
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(raw);
} catch {
  console.error(`[pin-worker-name] FATAL: ${target} is not valid JSON.`);
  process.exit(1);
}

// Verify-then-write (Audit-4 L72): ALL assertions run BEFORE the
// name pin is written, so a failing check leaves the file
// untouched. A failed build never deploys, so the ordering only
// matters for the artifact on disk — but a half-pinned artifact
// after a failed build is a trap (it looks deployable).

// Audit-3 A3-N13: the pin used to assert only `name`. If the preset ever
// changes the entry point or the static-assets binding, a plain deploy
// would ship a broken Worker (no entry / no static assets) while the pin
// still passed — fail closed on both, like the missing-file case above.
if (cfg.main !== "index.mjs") {
  console.error(
    `[pin-worker-name] FATAL: expected "main": "index.mjs" in ${target}, got ${JSON.stringify(cfg.main)} — refusing to continue.`,
  );
  process.exit(1);
}
if (cfg.assets?.binding !== "ASSETS") {
  console.error(
    `[pin-worker-name] FATAL: expected assets.binding "ASSETS" in ${target}, got ${JSON.stringify(cfg.assets?.binding)} — refusing to continue.`,
  );
  process.exit(1);
}
console.log(`[pin-worker-name] entry main="index.mjs", assets.binding="ASSETS" OK`);

// Audit-4 L72: the pin used to assert only name/main/binding. If
// the preset changes the asset directory, compat flags, bundling,
// or module rules, a plain deploy would serve the wrong assets /
// changed compat semantics while the pin still passed — assert
// them all, fail closed.
if (cfg.assets?.directory !== "../public") {
  console.error(
    `[pin-worker-name] FATAL: expected assets.directory "../public" in ${target}, got ${JSON.stringify(cfg.assets?.directory)} — refusing to continue.`,
  );
  process.exit(1);
}
// compatibility_date is deliberately NOT exact-pinned: the preset
// rolls it (build date — "latest"). Guard the meaningful bounds
// instead: valid YYYY-MM-DD, >= 2024-09-19 (Workers Static Assets
// need that or later, per Nitro docs), and not more than a day in
// the future (a day's grace covers the build machine's timezone
// vs the UTC date the preset stamps).
if (
  typeof cfg.compatibility_date !== "string" ||
  !/^\d{4}-\d{2}-\d{2}$/.test(cfg.compatibility_date) ||
  Number.isNaN(Date.parse(cfg.compatibility_date))
) {
  console.error(
    `[pin-worker-name] FATAL: expected compatibility_date to be a valid YYYY-MM-DD date in ${target}, got ${JSON.stringify(cfg.compatibility_date)} — refusing to continue.`,
  );
  process.exit(1);
}
if (cfg.compatibility_date < "2024-09-19") {
  console.error(
    `[pin-worker-name] FATAL: compatibility_date ${cfg.compatibility_date} is older than 2024-09-19 (Workers Static Assets need that or later) — refusing to continue.`,
  );
  process.exit(1);
}
if (Date.parse(cfg.compatibility_date) > Date.now() + 86_400_000) {
  console.error(
    `[pin-worker-name] FATAL: compatibility_date ${cfg.compatibility_date} is more than a day in the future — refusing to continue.`,
  );
  process.exit(1);
}
if (JSON.stringify([...(cfg.compatibility_flags ?? [])].sort()) !== JSON.stringify(["nodejs_compat"])) {
  console.error(
    `[pin-worker-name] FATAL: expected compatibility_flags ["nodejs_compat"] in ${target}, got ${JSON.stringify(cfg.compatibility_flags)} — refusing to continue.`,
  );
  process.exit(1);
}
if (cfg.no_bundle !== true) {
  console.error(
    `[pin-worker-name] FATAL: expected no_bundle true in ${target}, got ${JSON.stringify(cfg.no_bundle)} — refusing to continue.`,
  );
  process.exit(1);
}
if (
  JSON.stringify(cfg.rules) !==
  JSON.stringify([{ type: "ESModule", globs: ["**/*.mjs", "**/*.js"] }])
) {
  console.error(
    `[pin-worker-name] FATAL: expected rules [{ type: "ESModule", globs: ["**/*.mjs", "**/*.js"] }] in ${target}, got ${JSON.stringify(cfg.rules)} — refusing to continue.`,
  );
  process.exit(1);
}
console.log(
  `[pin-worker-name] assets.directory="../public", compatibility_date=${cfg.compatibility_date}, compatibility_flags=["nodejs_compat"], no_bundle=true, rules OK`,
);

// All assertions passed — now pin the name (the only field the
// script corrects rather than asserts).
let dirty = false;
if (cfg.name !== WORKER_NAME) {
  console.error(
    `[pin-worker-name] pinning worker name ${JSON.stringify(cfg.name)} -> ${JSON.stringify(WORKER_NAME)} in ${target}`,
  );
  cfg.name = WORKER_NAME;
  dirty = true;
} else {
  console.log(`[pin-worker-name] worker name already ${JSON.stringify(WORKER_NAME)}`);
}

// Deploy fix (2026-10-20): the server runtime reads SUPABASE_URL +
// SUPABASE_PUBLISHABLE_KEY from the Worker's env at request time.
// The Nitro preset does NOT carry them into the generated config
// (the Lovable-era pipeline did), so the first deploy of the new
// build reached production with BOTH missing — every server fn
// threw "Missing Supabase environment variable(s)" (live-verified
// via wrangler tail: People/Chats dead). Both values are PUBLIC
// (the publishable key ships in every client bundle); the source
// of truth is the project .env's VITE_-prefixed pair. Inject them
// as plain vars on every build so a deploy can never lose them
// again. Fail closed if .env lacks them.
{
  let envText = "";
  try {
    envText = readFileSync(join(projectRoot, ".env"), "utf8");
  } catch {
    console.error(`[pin-worker-name] FATAL: ${join(projectRoot, ".env")} not readable — cannot inject the Worker's public Supabase vars.`);
    process.exit(1);
  }
  /** @param {string} key */
  const fromEnv = (key) => {
    const m = envText.match(new RegExp(`^${key}="?([^"\\n]+)"?\\s*$`, "m"));
    return m ? m[1].trim() : null;
  };
  const supabaseUrl = fromEnv("VITE_SUPABASE_URL");
  const publishableKey = fromEnv("VITE_SUPABASE_PUBLISHABLE_KEY");
  const vapidPublicKey = fromEnv("VITE_VAPID_PUBLIC_KEY");
  if (!supabaseUrl || !publishableKey || !vapidPublicKey) {
    console.error(
      "[pin-worker-name] FATAL: .env is missing VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY or VITE_VAPID_PUBLIC_KEY — refusing to produce a Worker config without its runtime env.",
    );
    process.exit(1);
  }
  cfg.vars = {
    ...(cfg.vars ?? {}),
    SUPABASE_URL: supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    // The server's push pipeline reads VAPID_PUBLIC_KEY at runtime
    // (push.functions.ts getVapidPublicKey / diagnostics / send
    // paths). Same incident class as the Supabase pair: missing on
    // the 2026-10-20 deploy -> Profile showed "Server push keys
    // not configured". The private half stays a dashboard secret.
    VAPID_PUBLIC_KEY: vapidPublicKey,
  };
  dirty = true;
  console.log("[pin-worker-name] injected vars SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY + VAPID_PUBLIC_KEY (public values from .env)");
}

if (dirty) {
  writeFileSync(target, `${JSON.stringify(cfg, null, 2)}\n`);
}

// Audit-7 F2: the pipeline APPENDS its own generated /assets/*
// block to the copied public/_headers, so the shipped file carried
// the immutable-cache rule two (in some flavors three) times and
// Cloudflare served a duplicated Cache-Control value — harmless,
// but the artifact should be clean. The source guard
// (check-security-headers-parity, Audit-4 L77) rightly treats a
// duplicate in the SOURCE as an error; the duplication is the
// pipeline's doing, so it is removed here, in the built artifact.
// A repeated block whose headers DIFFER from the first is a real
// conflict — fail closed, like everything else in this script.
{
  const headersPath = join(projectRoot, ".output/public/_headers");
  if (!existsSync(headersPath)) {
    console.error(
      `[pin-worker-name] FATAL: ${headersPath} not found — a Cloudflare build without its _headers would ship without security headers.`,
    );
    process.exit(1);
  }
  const lines = readFileSync(headersPath, "utf8").split("\n");
  /** @type {Array<string>} */
  const preamble = [];
  /** @type {Array<{ path: string, lines: Array<string> }>} */
  const blocks = [];
  /** @type {{ path: string, lines: Array<string> } | null} */
  let cur = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const isPathLine =
      !/^\s/.test(line) && trimmed.startsWith("/") && !trimmed.includes(":");
    if (isPathLine) {
      cur = { path: trimmed, lines: [line] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  /** @type {Map<string, string>} */
  const seen = new Map();
  /** @type {Array<{ path: string, lines: Array<string> }>} */
  const kept = [];
  let dropped = 0;
  for (const block of blocks) {
    // Signature: path + header lines — comments and blank lines
    // inside a block don't change what it serves.
    const signature = block.lines
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"))
      .join("\n");
    const firstSignature = seen.get(block.path);
    if (firstSignature === undefined) {
      seen.set(block.path, signature);
      kept.push(block);
    } else if (firstSignature === signature) {
      dropped++;
    } else {
      console.error(
        `[pin-worker-name] FATAL: ${headersPath} has two DIFFERENT ${block.path} blocks — refusing to guess which one should ship.`,
      );
      process.exit(1);
    }
  }
  if (dropped > 0) {
    const out = [...preamble, ...kept.flatMap((b) => b.lines)].join("\n");
    writeFileSync(headersPath, out);
    console.log(
      `[pin-worker-name] _headers: dropped ${dropped} pipeline-appended duplicate block(s); ${kept.length} block(s) remain`,
    );
  } else {
    console.log("[pin-worker-name] _headers: no duplicate blocks");
  }
}
