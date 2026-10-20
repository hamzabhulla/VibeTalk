// Vercel build of the same app — SAME Lovable preset as vite.config.ts
// (audit-2 M75). The old file hand-rolled the preset's plugins (tanstackStart
// + nitro + viteReact + tailwindcss + tsConfigPaths + its own VITE_*
// injection) and had ALREADY drifted: it missed the error-logger plugins,
// the devtools plugin, sandbox detection, and the dev NODE_ENV define — and
// any future preset change would silently change Cloudflare without Vercel.
//
// The preset itself supports pinning the Nitro target
// (`nitro: { preset: "vercel" }` — verified in
// node_modules/@lovable.dev/vite-tanstack-config/dist/index.js), so there
// is no reason for a fork: both configs are now thin wrappers over the
// SAME preset and differ ONLY in the Nitro preset (Cloudflare default vs
// Vercel). The preset's default tanstackStart importProtection,
// css.transformer ("lightningcss"), alias/dedupe, optimizeDeps and VITE_*
// injection are byte-identical to what the old hand-rolled file did.
//
// Guard: `npm run check:vite-parity` resolves BOTH configs and fails if
// their plugin-name lists diverge. Build with: vite build --config vite.config.vercel.ts
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Nitro target is the ONLY difference from vite.config.ts
  // (which leaves the preset's cloudflare-module default in place).
  nitro: { preset: "vercel" },
  // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper) — same as vite.config.ts.
  tanstackStart: {
    server: { entry: "server" },
  },
});
