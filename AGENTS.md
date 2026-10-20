# Architecture rules

- VibeTalk is a human-to-human realtime chat, so use the existing chat primitives rather than AI-assistant conversation components.
- Enforce upload limits and attachment ownership at both storage and message creation boundaries because browser checks are bypassable.
- Keep authenticated chat data protected by backend row policies and authenticated server functions.

# Deploy (single source of truth — H36)

- Single pre-deploy build (audit-3 A3-N4): `npm run deploy:build` runs `build` + `build:vercel` back-to-back from current source, each with both parity guards (vite-config + security-headers). ALWAYS run it before EITHER host's upload step — never deploy from a leftover artifact. `build:vercel` deletes the stale `.vercel/output` first (fail-closed: a failed build leaves nothing deployable).
- `build:dev` (audit-3 A3-N7, hardened audit-4 M31) runs typecheck + BOTH parity guards + DEVELOPMENT-mode build, then `scripts/move-dev-output.mjs` moves `.output/` → `.output-dev/` (undeployable: no `.output/` for a plain `nitro deploy --prebuilt`, and the dev wrangler.json is renamed so even `--dir .output-dev` finds no deploy config) + writes a `DEV-BUILD-DO-NOT-DEPLOY` marker. It NEVER runs the worker-name pin — a dev build must never carry the production worker name "hc". Rebuild with `npm run build` for production.
- Cloudflare (audit-2 H37 — worker-name pin): `npm run build` (tsc + vite build + `scripts/pin-worker-name.mjs`, which pins the GENERATED `.output/server/wrangler.json` to `"name": "hc"`) then `npx nitro deploy --prebuilt` from this directory. The deploy config is the GENERATED `.output/server/wrangler.json` (main `index.mjs` + ASSETS binding). There is NO root wrangler config on purpose — a root `wrangler deploy` would ship a broken Worker (raw TS entry, no static assets, no secrets). Never re-add one. The preset generates `"name": "tanstack-start-ts"` (from package.json) — WITHOUT the pin, a plain deploy would CREATE a new `tanstack-start-ts` worker and leave `hc` stale (verified 2026-10-18: the account holds only `hc`; `tanstack-start-ts` 404s). Before every deploy, confirm `.output/server/wrangler.json` says `"name": "hc"` — if it says anything else, do NOT deploy.
- Vercel (audit-2 H36 — the stale-artifact trap): NEVER `vercel deploy --prebuilt` on a leftover `.vercel/output` — on 2026-10-18 it held a stale `sw.js` (6,205 B, no `pushsubscriptionchange`) while `public/sw.js` was 12,984 B, and the live Vercel site served an even older SW (5,839 B). The ONLY Vercel deploy path is: (1) `npm run deploy:build` (fresh artifacts for both hosts — `build:vercel` deletes the stale `.vercel/output` first, then rebuilds it from current source); (2) build the MCP file manifest from THAT fresh output — never from a leftover; (3) deploy via MCP `upload_file` + `create_deployment`; (4) verify live: `curl -s https://vibetalk-one.vercel.app/sw.js | sha1sum` MUST equal `sha1sum public/sw.js`, and `grep -c pushsubscriptionchange` on the live SW MUST be ≥ 1. If the hashes differ, the deploy shipped stale output — rebuild + redeploy. `.vercel/output` is gitignored build output, not source — a stale copy sitting in the tree is a trap, not a deploy input.

# Secrets (M71 — NAMES only, values never stored anywhere)

Two server secrets are required. They live ONLY in the host dashboards,
never in `.env`, never in any checked-in file, never in chat/logs:

- `SUPABASE_SERVICE_ROLE_KEY` — Supabase Dashboard → Settings → API.
- `VAPID_PRIVATE_KEY` — generated with the VAPID keypair (public key is in `.env`).

Where they live per host:

- Cloudflare Worker `hc`: Worker secrets. There is NO root wrangler
  config on purpose (see Deploy), so run from the repo root with the
  generated config: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config .output/server/wrangler.json`
  (build first — the generated config only exists after `npm run build`).
  A bare `wrangler secret put …` from the repo root finds no config and fails.
- Vercel project `vibetalk`: Dashboard → Settings → Environment Variables.

If a host is missing them, every server fn throws
`Missing Supabase environment variable(s): SUPABASE_SERVICE_ROLE_KEY`
— EXCEPT notifyNewMessage (new-message push), which is best-effort
by design: it does NOT throw, but logs a loud throttled
`[push] CONFIG ERROR` (audit-4 L39: re-logged after a 1h cooldown)
and Profile diagnostics shows "Server service key missing"
(audit-2 M73). Push never silently stays off.
`.env.example` lists every var (names only).

# Threat model (audit-2 L19)

- Client-side checks are UX only — anything the browser can do, an
  attacker with a stolen session can do directly against Supabase
  (e.g. calling `supabase.auth.reauthenticate()` in a loop to spam the
  victim's inbox with OTP emails). The app cannot throttle that; the
  real control is GoTrue's server-side email/OTP throttle (Supabase
  Dashboard → Authentication → Rate limits), which 429s rapid sends.
- Same rule for `user_metadata`: any session can overwrite its own
  metadata via `updateUser({ data })`, so metadata is NEVER an
  authorization signal — only a UX hint. The password-setup-pending
  state lives server-side in the `password_setup_pending` table
  (audit-4 C1, `vibetalk-audit4-fixes.sql` §C1); only the server
  functions ever read/write it. Residual, by platform design: a
  stolen session can still call GoTrue `updateUser({ password })`
  directly — no app code can disable that. Platform-level control
  (Hamza to verify it is exposed for this project): GoTrue's
  `SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION` enforces
  reauthentication on password update. Until then the mitigations
  are short-lived sessions, global sign-out on password change (M7),
  and the dashboard rate limits.
- The delete-account dialog's 60s resend cooldown is therefore UX
  (stops accidental double-sends), not a security control. It survives
  dialog close/reopen (the component stays mounted; `reset()` does not
  clear it) but not a page refresh — by design, not a bug.

# Supabase Dashboard settings the app depends on (audit-3 A2-N9)

Code cannot verify these — they live in the dashboard, not the repo.
Recorded here so a fresh project setup does not silently lose them:
- Authentication → Policies → "Leaked password protection"
  (HaveIBeenPwned) MUST be ON — it is the only breach check on
  sign-up / password change. `password-policy.ts` additionally blocks
  a short list of the most common passwords client-side (defence in
  depth), but it cannot check breach databases.
- Authentication → URL Configuration → Site URL =
  `https://hc.hcroom.workers.dev`; Redirect URLs allowlist both hosts.
- Authentication → Rate limits → GoTrue's OTP/email throttle (see
  Threat model above).
