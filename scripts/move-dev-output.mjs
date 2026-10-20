// Audit-4 M31: move a DEVELOPMENT build out of the deployable path.
//
// `vite build --mode development` writes to the SAME `.output/` as
// the production build, and `npx nitro deploy --prebuilt` reads
// `.output/` by default — so `npm run build:dev && npx nitro deploy
// --prebuilt` used to ship a dev build (React dev build, keepNames,
// dev behaviour) to the production worker "hc". Only a prose warning
// stood between a dev build and production.
//
// Fix: after a dev build, move `.output/` -> `.output-dev/` (same
// filesystem, atomic rename), rename the generated wrangler.json so
// even an explicit `--dir .output-dev` deploy finds no deploy
// config, and leave a marker file. After `build:dev`:
//
//   - `.output/` does NOT exist -> a plain `nitro deploy --prebuilt`
//     fails with "not found" instead of shipping the wrong build.
//   - `.output-dev/server/wrangler.json` does NOT exist (renamed to
//     `wrangler.json.dev-build`) -> an explicit `--dir` deploy fails.
//   - The production `.output/` is rebuilt by `npm run build`
//     (which still pins wrangler.json to "hc" via pin-worker-name;
//     build:dev no longer runs the pin at all — a dev build must
//     never carry the production worker name).
//
// Fail-closed: if `.output/` is missing (build failed / interrupted),
// refuse instead of leaving a stale `.output-dev/` in place.
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Audit-5 B4-LOW (mirror of audit-4 L81): resolve against THIS
// script's own location (scripts/ -> project root), NEVER
// process.cwd() — a bare ".output" run from the wrong directory
// would rename ANOTHER directory's output (or nothing). Fail-closed:
// if the resolved root holds no package.json, exit 1 without moving.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(join(projectRoot, "package.json"))) {
  console.error(
    "[move-dev-output] FATAL: no package.json at " +
      projectRoot +
      " — refusing to move anything (wrong project root).",
  );
  process.exit(1);
}

const outDir = join(projectRoot, ".output");
const devDir = join(projectRoot, ".output-dev");

if (!existsSync(outDir)) {
  console.error(
    "[move-dev-output] FATAL: .output/ not found — the dev build did not complete. Refusing to touch .output-dev/.",
  );
  process.exit(1);
}
if (existsSync(devDir)) rmSync(devDir, { recursive: true, force: true });
renameSync(outDir, devDir);

const wrangler = join(devDir, "server/wrangler.json");
if (existsSync(wrangler)) {
  // Un-deployable: nitro deploy needs wrangler.json in the output dir.
  renameSync(wrangler, join(devDir, "server/wrangler.json.dev-build"));
}
writeFileSync(
  join(devDir, "DEV-BUILD-DO-NOT-DEPLOY"),
  "DEV-BUILD-DO-NOT-DEPLOY\n" +
    "Development build (React dev build, keepNames, dev behaviour).\n" +
    "NOT deployable: `nitro deploy --prebuilt` reads .output/ (absent after build:dev)\n" +
    "and this directory has no wrangler.json. Rebuild with `npm run build` for production.\n",
);
console.log("[move-dev-output] dev build moved to .output-dev/ (undeployable).");
