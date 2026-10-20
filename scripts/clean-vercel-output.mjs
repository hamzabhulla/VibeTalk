#!/usr/bin/env node
/**
 * Audit-3 A3-N4: fail-closed stale-artifact guard — delete the leftover
 * `.vercel/output` BEFORE a `build:vercel` run, so a failed build can
 * never leave a stale artifact that looks deployable (the H36 trap: a
 * stale `.vercel/output` shipped an old sw.js). `build:vercel`
 * regenerates it from current source; a failed build leaves NOTHING
 * to deploy. `.vercel/output` is gitignored build output, not source.
 *
 * Usage: node scripts/clean-vercel-output.mjs (first step of build:vercel)
 *
 * Audit-4 L81: the target is resolved against THIS script's own
 * location (scripts/ -> project root), NEVER process.cwd() — a bare
 * ".vercel/output" run from the wrong directory would delete
 * ANOTHER project's output (or nothing). Fail-closed: if the
 * resolved root holds no package.json, exit 1 without deleting.
 */
import { rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(projectRoot, ".vercel", "output");
if (!existsSync(join(projectRoot, "package.json"))) {
  console.error(
    `[clean-vercel-output] FATAL: expected package.json at ${projectRoot} — refusing to delete anything`,
  );
  process.exit(1);
}
if (existsSync(out)) {
  rmSync(out, { recursive: true, force: true });
  console.log("[clean-vercel-output] removed stale .vercel/output");
} else {
  console.log("[clean-vercel-output] no stale .vercel/output");
}
