# VibeTalk

**Chat at the speed of thought — real-time messaging, voice notes, and calls in a responsive web app.**

[![Live demo](https://img.shields.io/badge/demo-live-00A651?style=flat-square)](https://vibetalk.hamzabhulla.workers.dev)
[![Android](https://img.shields.io/badge/Android-APK-3DDC84?style=flat-square&logo=android&logoColor=white)](https://vibetalk.hamzabhulla.workers.dev/VibeTalk.apk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)

[![VibeTalk — Chat at the speed of thought](public/og-image.png)](https://vibetalk.hamzabhulla.workers.dev)

VibeTalk is a full-stack messaging app built with **React, TypeScript, TanStack Start, and Supabase**. It combines direct messages, group rooms, live presence, voice notes, WebRTC voice/video calls, reactions, read receipts, and push notifications in a responsive web app.

> **Project status:** Portfolio / active development. Some features depend on your Supabase schema, auth settings, push credentials, and hosting configuration — see [Getting started](#-getting-started).

## 👀 Quick look

| | |
| --- | --- |
| **What it is** | A full-stack chat app: DMs and group rooms, voice notes, WebRTC calls, reactions, read receipts, and push notifications |
| **Try it** | [Live demo](https://vibetalk.hamzabhulla.workers.dev) · [Android APK](https://vibetalk.hamzabhulla.workers.dev/VibeTalk.apk) |
| **Stack** | React 19 · TypeScript · TanStack Start · Supabase (Auth, Postgres, Realtime, Storage) · Tailwind CSS 4 · Cloudflare Workers |
| **Engineering highlights** | • Row Level Security plus server-side authorization, with privileged access kept on the server<br>• Optional end-to-end encrypted group text (AES-GCM, per-recipient wrapped keys) for private rooms<br>• Separate Cloudflare Workers and Vercel deployment targets with parity checks |
| **Read first** | [Features](#-features) · [Architecture](#-architecture) · [Technical decisions](#-technical-decisions) · [Security notes](#-security-and-privacy-notes) |
| **Code to look at** | `src/lib/` (server functions, E2EE, push) · `supabase/migrations/` (schema and RLS) · `scripts/` (parity guards) |

## 🚀 Try it

| | |
| --- | --- |
| 🌐 **Web app** | [vibetalk.hamzabhulla.workers.dev](https://vibetalk.hamzabhulla.workers.dev) — [sign up](https://vibetalk.hamzabhulla.workers.dev/register) with your email, or [sign in](https://vibetalk.hamzabhulla.workers.dev/login) if you already have an account |
| 🤖 **Android** | [Download the APK](https://vibetalk.hamzabhulla.workers.dev/VibeTalk.apk) (Android 7.0+, ~11 MB). You may need to allow "install from unknown sources" for your browser once. The app is built for local testing and demos. |

## Screenshots

| Chat | Voice notes | Home |
| --- | --- | --- |
| ![Chat](docs/screenshots/VibeTalk-Chat-View.png) | ![Voice notes](docs/screenshots/VibeTalk-Voicenote.png) | ![Rooms](docs/screenshots/VibeTalk-HomeScreen.png) |

| Messages | Direct message thread |
| --- | --- |
| ![Messages](docs/screenshots/chat-view.png) | ![Direct message](docs/screenshots/image.png) |

## ✨ Features

**💬 Messaging**
- Direct conversations and group rooms with live updates and membership controls
- Emoji reactions, message editing/deletion, copy controls, and read-receipt details
- Typing status, online/last-seen presence, and unread counts
- Pin and mute conversations to keep your inbox organised

**🎙️ Voice and calls**
- Record and play voice notes, with server-side checks for attachment ownership and allowed MIME types
- Browser-based WebRTC voice/video calls with call invitations, history, and status handling

**🔐 Privacy and security**
- Private, invite-controlled rooms and private profile discovery
- Configurable notification previews
- Optional end-to-end encrypted **group text** (AES-GCM with per-recipient wrapped message keys) — see [limits](#-security-and-privacy-notes)

**🔔 Accounts and notifications**
- Registration, sign-in, password reset/change, profile editing, visibility settings, and account deletion
- Service-worker push notifications with per-device subscriptions and test notifications

**📱 Platform**
- Responsive desktop and mobile layouts (profile, people, rooms, and calls views)
- Web app plus an Android APK
- Separate Cloudflare Workers and Vercel build targets with parity checks to prevent stale or mismatched deployments

## 🧰 Tech stack

| Area | Technologies |
| --- | --- |
| UI | React 19, TypeScript, Tailwind CSS 4, Radix UI, Lucide |
| Framework | TanStack Start, TanStack Router, TanStack React Query, Vite |
| Backend and data | Supabase Auth, PostgreSQL, Row Level Security, Realtime, Storage |
| Calls | WebRTC with STUN/TURN configuration |
| Notifications | Service Worker, Web Push, VAPID |
| Forms and validation | Zod, React Hook Form |
| Hosting | Cloudflare Workers (live demo), Vercel (supported target) |
| Code quality | TypeScript checks, ESLint, Prettier, build/config guard scripts |

## 🧩 Architecture

```mermaid
flowchart TD
    A[Responsive React UI] --> B[TanStack Start server functions]
    A <--> C[Supabase client]
    B --> D[Supabase Auth]
    B --> E[PostgreSQL with Row Level Security]
    B --> F[Supabase Storage]
    A <--> G[Supabase Realtime]
    A <--> H[WebRTC peer connection]
    B --> I[Web Push with VAPID]
    J[Service Worker] --> K[Browser notifications]
    I --> J
```

- **Client:** React routes and components handle the responsive UI, realtime subscriptions, media capture, and browser APIs.
- **Server:** TanStack Start server functions run authenticated operations and keep privileged service-role access server-side.
- **Data:** Supabase provides auth, relational data, storage, and realtime events. Row Level Security is part of the authorization boundary.
- **Calls:** WebRTC handles the peer connection; signaling and call state go through the app and Supabase-backed functions/channels.
- **Notifications:** The service worker handles background notifications; server-side Web Push uses VAPID credentials.

## 🧠 Technical decisions

The hardest problems in a chat app are rarely visible in the UI. These are the main engineering decisions behind VibeTalk, why they were made, and what they cost. Several came out of internal security and reliability reviews.

### 1. Authorization: never trust the browser

**Challenge.** Anything the browser does — checks, hidden buttons, form limits — can be bypassed by someone with a valid session. In a chat app, a missing server-side check is a private-data leak.

**Decision.** Authenticated chat data is protected by **database row policies (Supabase Row Level Security)** and **authenticated server functions**. The service-role key exists only in the hosting project environment.

```mermaid
flowchart LR
    B["Browser - untrusted"] -->|"user session"| P["PostgreSQL with Row Level Security"]
    B -->|"authenticated call"| F["Server functions"]
    F -->|"privileged key, server only"| P
    F --> S["Storage"]
    B -->|"upload"| S
```

Rules that came out of the audits:

- Upload limits and attachment ownership are enforced **both at the storage layer and when the message is created**, because browser-side checks are bypassable.
- `user_metadata` is never an authorization signal — any session can edit its own metadata. State such as "password setup pending" lives in a server-side table that only server functions read or write.
- Settings that code can't verify (leaked-password protection, the auth redirect-URL allowlist, auth rate limits) are recorded as dashboard requirements, so a fresh project doesn't silently lose them.

**Trade-off.** Some risk is inherent to the platform: a stolen session can still call the auth API directly. The app can't remove that, so it limits the damage with short-lived sessions, global sign-out flows, and server-side checks.

### 2. Realtime delivery that never blocks sending

**Challenge.** Messages should appear instantly for connected users and still notify people whose tab is closed — and a broken notification service must never stop a message from being sent.

**Decision.**

- Messages live in PostgreSQL and are delivered to connected clients through **Supabase Realtime**, so there is no custom WebSocket server to run and secure.
- For closed or background tabs, a **service worker** receives **Web Push (VAPID)** notifications. Subscriptions are per device, and the service worker handles `pushsubscriptionchange` so subscriptions stay current.
- **Push is best-effort by design.** The new-message push function does not throw when push configuration is missing, so sending always wins. Instead it logs a throttled configuration error (repeated logs are rate-limited).

```mermaid
sequenceDiagram
    participant A as Sender
    participant S as Server and database
    participant R as Recipient app
    participant W as Recipient service worker
    A->>S: Send message, authenticated
    S-->>R: Realtime update when the app is open
    S-->>W: Web Push, best effort, never blocks the message
    W-->>R: Browser notification when the app is closed
```

**Trade-off.** A misconfigured server can miss notifications while chat keeps working. The diagnostics exist so that failure is visible instead of silent.

### 3. WebRTC calls across real networks

**Challenge.** Browsers behind home routers, mobile carriers, and corporate firewalls can't always reach each other directly, and a call needs a way to exchange connection details before any media flows.

**Decision.**

- **Signaling** — the offer, answer, and network candidates — is coordinated through the app and Supabase-backed functions/channels. Call invitations, status, and history are tracked in the app.
- Once connected, media flows between browsers over WebRTC; the app doesn't run a media server.
- **STUN/TURN servers are configurable** through build-time variables (`VITE_TURN_*`). Without a TURN relay, calls can fail for users behind restrictive NATs or firewalls; with one, the relay covers those cases.

```mermaid
sequenceDiagram
    participant C as Caller
    participant G as Signaling via app and Supabase
    participant E as Callee
    participant N as STUN and TURN
    C->>G: Call invitation and offer
    G-->>E: Invitation and offer
    E->>G: Answer
    G-->>C: Answer
    C->>N: Discover network paths
    E->>N: Discover network paths
    C-->>E: Media, direct or relayed through TURN
```

**Trade-off and next step.** `VITE_` variables are public, so TURN credentials placed there are visible to users and must be restricted and rate-limited. The planned improvement is short-lived TURN credentials minted by the server.

### 4. Shipping to two hosts without shipping stale code

**Challenge.** VibeTalk deploys to Cloudflare Workers and Vercel. Once, a leftover build folder carried an outdated service worker — about half the size of the current one and missing push-subscription logic.

**Decision.**

```mermaid
flowchart LR
    A["Current source"] --> B["npm run deploy:build"]
    B --> C["Cloudflare build"]
    B --> D["Vercel build, clears old output first"]
    C --> E["Config and security header parity checks"]
    D --> E
    E --> F["Deploy"]
    F --> G["Compare live sw.js hash to source"]
```

- One command rebuilds **both** targets from current source, and each build runs configuration and security-header parity checks.
- The Vercel build deletes previous output first, so a failed build leaves nothing deployable.
- After deploying, the live service worker's hash is compared with the source file.
- Development builds are moved to a non-deployable folder with a marker file. There is deliberately no root Cloudflare config, because deploying from one would ship a Worker without assets or secrets.

**Trade-off.** More ceremony per deploy, in exchange for never shipping mismatched artifacts.

## 🔧 Getting started

### Prerequisites

- Node.js 22 (or a compatible supported release) and npm
- A Supabase project with the required schema, policies, storage, and auth settings
- *Optional:* VAPID keys for background push notifications
- *Optional:* a restricted, rate-limited TURN credential for calls across restrictive networks

### 1. Clone and install

```bash
git clone https://github.com/hamzabhulla/VibeTalk.git
cd VibeTalk
npm ci
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL used by server-side code |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key used by the server-side Supabase client |
| `VITE_SUPABASE_URL` | Supabase URL compiled into the browser bundle; must match `SUPABASE_URL` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser-facing publishable key |
| `VITE_SUPABASE_PROJECT_ID` | Project identifier used by client configuration |
| `VAPID_PUBLIC_KEY` | Public VAPID key for Web Push |
| `VITE_VAPID_PUBLIC_KEY` | Build-time VAPID public key; keep it paired with the server key |
| `VAPID_SUBJECT` | *Optional* VAPID contact URL |
| `VITE_TURN_URLS` | *Optional* STUN/TURN server URL(s) for WebRTC |
| `VITE_TURN_USERNAME` | *Optional* TURN username |
| `VITE_TURN_CREDENTIAL` | *Optional* TURN credential — anything prefixed `VITE_` is exposed in the client bundle |

> **Never** put privileged credentials in `.env.example`, source control, screenshots, issue reports, or `VITE_` variables. `SUPABASE_SERVICE_ROLE_KEY` and `VAPID_PRIVATE_KEY` belong in your hosting platform's secret store.

The server-side and browser-side Supabase values must point to the **same project** — a mismatch causes auth failures that look like session bugs.

### 3. Set up Supabase

1. Create or select a Supabase project.
2. Apply the SQL in `supabase/migrations/` in order, using your normal Supabase migration workflow.
3. Review the extra `supabase/vibetalk-*.sql` files before applying them. They include audit/fix scripts and consolidated snapshots — **do not blindly run every SQL file**, as some overlap.
4. Confirm Row Level Security protects profiles, rooms, memberships, messages, reactions, calls, and other user-scoped data.
5. Set your Supabase Auth site and redirect URLs for local and production domains.
6. Add the required server secrets to your host before enabling push or any privileged database access.

[`AGENTS.md`](AGENTS.md) documents additional deployment and Supabase dashboard assumptions — read it before changing security-sensitive configuration.

### 4. Run locally

```bash
npm run dev
```

For a production-style build and preview:

```bash
npm run build
npm run preview
```

## 📜 Scripts

<details>
<summary><strong>Show all npm scripts</strong></summary>

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run typecheck` | Run the TypeScript compiler without emitting files |
| `npm run lint` | Lint source, scripts, Vite configs, and the service worker |
| `npm run build` | Type-check, verify config/header parity, and build the Cloudflare target |
| `npm run build:vercel` | Clean stale output, run guards, and build the Vercel target |
| `npm run deploy:build` | Run both production builds and their guard checks |
| `npm run build:dev` | Development build into a separate, non-deployable output directory |
| `npm run check:vite-parity` | Check Cloudflare and Vercel Vite configs stay aligned |
| `npm run check:security-headers-parity` | Check security-header parity across hosts |
| `npm run format` | Format with Prettier |

</details>

## 🌐 Deployment

VibeTalk ships build configuration for **Cloudflare Workers** (used by the live demo) and **Vercel**. Guard scripts compare configuration and security headers and help prevent stale output from being deployed.

Before deploying:

1. Set all environment variables and server-side secrets on the target host.
2. Make sure Supabase Auth redirect URLs and the browser/server Supabase configuration match the deployment.
3. Follow the build/deploy sequence in [`AGENTS.md`](AGENTS.md) for your host.
4. Verify the service worker, auth, realtime messaging, calls, and push notifications after deploying.
5. Never deploy a development build or a stale output directory.

## 🔒 Security and privacy notes

- Authorization is enforced on the server and in Supabase Row Level Security — client-side checks are not a security boundary.
- Service-role credentials and VAPID private keys stay server-side. `VITE_*` variables are visible in the compiled bundle.
- Optional E2EE applies to **text messages in newly created group rooms where E2EE is enabled**. Attachments and voice notes are **not** covered by that layer, so the app as a whole should not be described as fully end-to-end encrypted.
- WebRTC call security and text-message E2EE are separate concerns; review the call/signaling threat model before making security claims about calls.
- Review the SQL migration history and the threat-model notes in `AGENTS.md` before production use.

This README describes the implementation in the repository. It is not a security audit or a guarantee that any deployment is correctly configured.

## 📁 Project structure

<details>
<summary><strong>Show project structure</strong></summary>

```text
.
├── public/                   # Static assets, service worker, Android APK, social preview
├── scripts/                  # Build, deployment, and parity guard scripts
├── src/
│   ├── components/           # Chat UI, call overlay, voice notes, profile and mobile UI
│   ├── hooks/                # Shared React hooks
│   ├── integrations/supabase/# Supabase clients, auth middleware, generated types
│   ├── lib/                  # Server functions, calls, E2EE, push, uploads, security helpers
│   ├── routes/               # Landing, auth, rooms, people, calls, and profile routes
│   ├── server.ts             # Server entry and error handling
│   └── router.tsx            # Router setup
├── supabase/
│   ├── migrations/           # Ordered database migrations
│   └── vibetalk-*.sql        # Additional SQL scripts and consolidated snapshots
├── AGENTS.md                 # Architecture, security, and deployment rules
├── .env.example              # Environment template (no secret values)
├── vite.config.ts            # Cloudflare-targeted Vite config
└── vite.config.vercel.ts     # Vercel-targeted Vite config
```

</details>

## 🚧 Known limitations

- Push notifications need correct VAPID configuration, a working service worker, browser permission, and host-side secrets.
- Calls behind restrictive NATs or firewalls may need valid STUN/TURN configuration.
- TURN settings are currently client-provided; don't embed privileged or long-lived TURN credentials in the client bundle.
- E2EE covers group text only (see above).
- There is no automated test suite yet — type-checking, linting, and build guard scripts are available.

## 🧭 Roadmap

- Automated tests for authorization boundaries, messaging, E2EE envelope handling, push delivery, and call lifecycle edge cases
- Browser end-to-end tests for sign-up, direct/group messaging, attachments, notifications, and calling
- Ephemeral, server-minted TURN credentials
- Key lifecycle and multi-device recovery for E2EE
- A repeatable clean-environment database bootstrap and deployment verification checklist

## 🤝 Contributing

Issues and pull requests are welcome. For a change:

1. Open an issue describing the problem or proposed behavior.
2. Keep authorization checks on the server and in database policies.
3. Run `npm run typecheck`, `npm run lint`, and the relevant build checks.
4. Include tests or reproducible verification steps for behavior changes.
5. Don't commit `.env`, secrets, local Wrangler state, generated output, or personal data.

## 📄 License

Released under the [MIT License](LICENSE).

## 👤 Author

Made by **Hamza Bhulla** — [@hamzabhulla](https://github.com/hamzabhulla)

Built with React, TypeScript, TanStack, Supabase, Tailwind CSS, Radix UI, and the wider open-source ecosystem.
