// Audit-4 L79: refuse to run `build:vercel` inside a Lovable sandbox.
//
// The preset's defineConfig FORCES nitroOpts.preset =
// "cloudflare-module" when isSandboxEnvironment() is true — even
// for vite.config.vercel.ts, whose explicit `nitro: { preset:
// "vercel" }` is overridden (verified in
// node_modules/@lovable.dev/vite-tanstack-config/dist/index.js).
// isSandboxEnvironment() is exactly:
//   process.env.LOVABLE_SANDBOX === "1" || !!process.env.DEV_SERVER__PROJECT_PATH
// A Vercel build inside a sandbox would therefore silently target
// Cloudflare. Deploys run from this VM (not a sandbox), so failing
// here is fail-closed, not a workflow break.
//
// Wired into `build:vercel` ONLY (first step, before any output is
// touched). `build` / `build:dev` are deliberately NOT gated: a
// Cloudflare build in a sandbox targets Cloudflare anyway, and
// sandbox dev builds are the normal Lovable preview flow.
if (process.env.LOVABLE_SANDBOX === "1" || process.env.DEV_SERVER__PROJECT_PATH) {
  console.error(
    "[check-not-sandbox] FATAL: refusing to run build:vercel inside a Lovable sandbox — " +
      "the preset forces the Cloudflare Nitro preset there, so the Vercel build would silently target Cloudflare. " +
      "Run build:vercel from your own machine, not the sandbox.",
  );
  process.exit(1);
}
console.log("[check-not-sandbox] OK: not a Lovable sandbox — the Vercel Nitro preset applies.");
