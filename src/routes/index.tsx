import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/")({
  component: Landing,
  // Audit-4 L80: validate the search keys this route reads
  // (?call=accept|decline&callId=… — stale-call forwarding).
  // All-optional return type: the keys are genuinely absent from
  // the URL when unused, and a required-key return type would
  // make the router demand `search` on every Link/navigate here.
  validateSearch: (
    search: Record<string, unknown>,
  ): { call?: "accept" | "decline"; callId?: string } => ({
    call: search.call === "accept" || search.call === "decline" ? search.call : undefined,
    callId: typeof search.callId === "string" ? search.callId : undefined,
  }),
  head: () => ({
    meta: [
      { title: "VibeTalk — Chat at the speed of thought" },
      {
        name: "description",
        content:
          "VibeTalk — fast, private, real-time chat for friends, teams and communities. Rooms, direct messages, voice notes and read receipts. Free on web and Android.",
      },
      { property: "og:title", content: "VibeTalk — Chat at the speed of thought" },
      {
        property: "og:description",
        content:
          "VibeTalk — fast, private, real-time chat for friends, teams and communities. Free on web and Android.",
      },
      { property: "og:type", content: "website" },
      // Audit-2 L11: og:url + canonical both point at the Cloudflare host
      // (the preferred host across the two deployments) so search engines
      // don't split the landing across duplicate URLs.
      { property: "og:url", content: "https://hc.hcroom.workers.dev/" },
      { property: "og:image", content: "https://hc.hcroom.workers.dev/og-image.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:type", content: "image/png" },
      { property: "og:image:alt", content: "VibeTalk — Chat at the speed of thought" },
      // Was "summary": it overrode the root route's summary_large_image,
      // so the large og:image would have rendered as a small card.
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#00A651" },
      { name: "color-scheme", content: "light" },
    ],
    links: [
      { rel: "canonical", href: "https://hc.hcroom.workers.dev/" },
    ],
  }),
});

// EXACT approved HTML from user-uploaded VibeTalk_Homepage_Preview.html (2026-10-17).
// CSS + body markup preserved verbatim; only the inline <script> was moved into useEffect
// so it runs after React mounts (scripts inside dangerouslySetInnerHTML do not execute).
const LANDING_CSS = `.landing{
        /* Brand green system */
        --green-brand:#00A651;
        --green-600:#16A34A;
        --green-500:#22C55E;
        --green-700:#15803D;
        --green-800:#166534;
        --green-900:#14532D;
        --green-100:#DCFCE7;
        --mint-tint:#F0FDF4;
        --mint-line:#D1FAE5;
        /* Neutrals */
        --bg:#FFFFFF;
        --bg-alt:#F9FAFB;
        --text:#111827;
        --body:#374151;
        --muted:#6B7280;
        --subtle:#9CA3AF;
        --border:#E5E7EB;
        --border-strong:#D1D5DB;
        --bubble-in:#F3F4F6;
        --nav-bg:#FFFFFF;
        --phone-frame:#111827;
        --phone-screen:#FFFFFF;
        --shadow-phone:0 24px 60px rgba(17,24,39,.14);
        --shadow-card:0 1px 2px rgba(17,24,39,.04);
        --font:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
      }
      .landing, .landing *{box-sizing:border-box}
      /* Audit-3 A1-F7: the auth CTAs are rewritten by the L7 effect after
         auth resolves; until then they show the wrong (logged-out) labels
         to logged-in users. Keep them invisible until the effect runs
         (body[data-l7-ready]) so there is no flicker of the wrong CTA. */
      .landing .nav-signin,.landing .menu-signin,.landing .hero-ctas a[href='/login'],.landing .nav-actions a[href='/register'],.landing .mobile-menu-actions a[href='/register']{visibility:hidden}
      body[data-l7-ready] .landing .nav-signin,body[data-l7-ready] .landing .menu-signin,body[data-l7-ready] .landing .hero-ctas a[href='/login'],body[data-l7-ready] .landing .nav-actions a[href='/register'],body[data-l7-ready] .landing .mobile-menu-actions a[href='/register']{visibility:visible}
      /* Audit-2 L10: scroll-behavior only works on the element that
         scrolls — the document, not .landing (height:auto, no overflow).
         html:has(.landing) puts it on the real scroller, scoped to
         landing pages. */
      .landing{height:auto}
      html:has(.landing){scroll-behavior:smooth}
      .landing [id]{scroll-margin-top:84px}
      .landing{
        margin:0;font-family:var(--font);color:var(--body);background:var(--bg);
        min-height:100vh;color-scheme:light;
        -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
        line-height:1.6;font-size:16px;
      }
      .landing h1, .landing h2, .landing h3{color:var(--text);letter-spacing:-0.025em;line-height:1.1;margin:0}
      .landing h2{font-size:clamp(2rem,3.5vw,2.5rem);font-weight:700}
      .landing h3{font-size:20px;font-weight:600;letter-spacing:-0.01em;line-height:1.3}
      .landing p{margin:0}
      .landing a{color:inherit}
      .landing a:focus-visible, .landing button:focus-visible{outline:2px solid var(--green-600);outline-offset:2px;border-radius:6px}
      /* Audit-2 L3: skip link — sr-only until focused, then a visible
         pill above the sticky header (z-50). Fixed so it appears at
         the viewport top even when the user Tabs mid-scroll. */
      .landing .skip-link{position:fixed;left:16px;top:16px;z-index:100;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap}
      .landing .skip-link:focus{width:auto;height:auto;overflow:visible;clip:auto;clip-path:none;white-space:normal;background:var(--green-700);color:#fff;font-weight:600;font-size:14px;padding:10px 16px;border-radius:8px;text-decoration:none;outline:2px solid var(--green-700);outline-offset:2px}
      .landing .container{max-width:1200px;margin:0 auto;padding:0 24px}
      .landing section{padding:96px 0}
      .landing .eyebrow{font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--green-700);margin:0 0 16px}

      /* ---------- Buttons ---------- */
      .landing .btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;
        min-height:48px;padding:14px 28px;border-radius:999px;font-weight:600;font-size:16px;
        text-decoration:none;cursor:pointer;border:1px solid transparent;transition:background .18s ease,border-color .18s ease,transform .18s ease;white-space:nowrap}
      .landing .btn svg{flex:none}
      .landing .btn-primary{background:var(--green-700);color:#fff}
      .landing .btn-primary:hover{background:var(--green-800)}
      .landing .btn-secondary{background:var(--bg);color:var(--text);border-color:var(--border-strong)}
      .landing .btn-secondary:hover{border-color:var(--subtle)}
      .landing .btn-sm{min-height:44px;padding:10px 22px;font-size:15px}

      /* ---------- Nav ---------- */
      .landing header{position:sticky;top:0;z-index:50;background:var(--nav-bg);border-bottom:1px solid var(--border)}
      .landing .nav{display:flex;align-items:center;justify-content:space-between;height:68px;gap:24px}
      .landing .logo{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:800;font-size:20px;color:var(--text);letter-spacing:-0.02em}
      .landing .logo-mark{width:34px;height:34px;border-radius:10px;overflow:hidden;display:block}
      .landing .logo-mark img{width:100%;height:100%;object-fit:cover;display:block}
      .landing .nav-links{display:flex;align-items:center;gap:36px}
      .landing .nav-links a{text-decoration:none;font-size:15px;font-weight:500;color:var(--body)}
      .landing .nav-links a:hover{color:var(--text)}
      .landing .nav-actions{display:flex;align-items:center;gap:10px;margin-left:auto;flex:none}
      .landing .nav-signin{text-decoration:none;font-size:15px;font-weight:600;color:var(--text);padding:10px 8px;white-space:nowrap}
      .landing .nav-signin:hover{color:var(--green-700)}
      @media (max-width:1020px){
        .landing .nav-links{gap:24px}
        .landing .nav-app{display:none}
      }
      /* ---------- Mobile nav: hamburger + full-screen menu (Apple-style) ----------
         PC keeps the full navbar. On mobile the bar collapses to one clean row
         (logo + hamburger) — no second row, no crowded bar, nothing overlapping. */
      .landing .hamburger{display:none}
      .landing .noscript-nav{display:none}
      .landing .mobile-menu{position:fixed;inset:0;z-index:60;background:var(--bg);display:flex;flex-direction:column;
        overflow-y:auto;overscroll-behavior:contain;
        padding:0 24px calc(24px + env(safe-area-inset-bottom));opacity:0;visibility:hidden;
        transition:opacity .25s ease,visibility .25s ease}
      .landing .mobile-menu.open{opacity:1;visibility:visible}
      .landing .mobile-menu-top{display:flex;align-items:center;justify-content:space-between;height:60px;flex:none}
      .landing .mobile-menu-links{display:flex;flex-direction:column;gap:4px;margin-top:24px}
      .landing .mobile-menu-links a{text-decoration:none;font-size:22px;font-weight:600;color:var(--text);padding:14px 4px;border-bottom:1px solid var(--border)}
      .landing .mobile-menu-links a:hover{color:var(--green-700)}
      .landing .mobile-menu-actions{display:flex;flex-direction:column;gap:12px;margin-top:auto;padding-top:32px}
      .landing .mobile-menu-actions .btn{width:100%}
      .landing .menu-signin{text-align:center;text-decoration:none;font-size:16px;font-weight:600;color:var(--text);padding:12px}
      .landing .menu-close{width:44px;height:44px;display:grid;place-items:center;background:transparent;border:0;cursor:pointer;font-size:30px;line-height:1;color:var(--text)}
      @media (min-width:861px){
        .landing .mobile-menu{display:none !important}
      }
      @media (max-width:860px){
        .landing .nav{height:60px;flex-wrap:nowrap;padding-top:0;padding-bottom:0}
        .landing .nav-links{display:none}
        .landing .nav-actions{display:none}
        .landing .hamburger{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:6px;
          width:44px;height:44px;flex:none;background:transparent;border:0;cursor:pointer;padding:0}
        /* Audit-2 L5: no-JS fallback — the <noscript> block below the header
           is the nav when JS is off (desktop nav is display:none here). */
        .landing .noscript-nav{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;justify-content:center;padding:12px 16px;background:var(--bg-alt);border-bottom:1px solid var(--border)}
        .landing .noscript-nav a:not(.btn){font-size:14px;font-weight:600;color:var(--text);text-decoration:none;display:inline-block;padding:4px 0;min-height:24px}
        .landing .hamburger span{display:block;width:22px;height:2px;border-radius:2px;background:var(--text)}
      }
      @media (max-width:480px){
        .landing .nav{height:60px;gap:12px}
        .landing .logo{font-size:18px}
        .landing .logo-mark{width:30px;height:30px;border-radius:9px}
      }

      /* ---------- Hero ---------- */
      .landing .hero{padding:40px 0 96px;overflow:hidden}
      .landing .hero-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:64px;align-items:center}
      .landing .live-pill{display:inline-flex;align-items:center;gap:8px;background:var(--green-100);color:var(--green-800);
        font-size:13px;font-weight:600;padding:6px 14px 6px 10px;border-radius:999px;margin-bottom:28px}
      .landing .dot{width:8px;height:8px;border-radius:50%;background:var(--green-500);position:relative;flex:none}
      .landing .dot::after{content:"";position:absolute;inset:-4px;border-radius:50%;background:rgba(34,197,94,.25);animation:vt-landing-pulse 2s ease-out infinite}
      @keyframes vt-landing-pulse{0%{transform:scale(.5);opacity:1}100%{transform:scale(1.3);opacity:0}}
      .landing h1{font-size:clamp(2.75rem,5vw,4rem);font-weight:800;line-height:1.06}
      .landing h1 .hl{color:var(--green-600)}
      .landing .hero-sub{font-size:18px;line-height:1.65;color:var(--muted);max-width:34rem;margin:24px 0 36px}
      .landing .hero-ctas{display:flex;gap:14px;flex-wrap:wrap}
      .landing .hero-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:28px;font-size:14px;color:var(--muted)}
      .landing .hero-meta .sep{width:4px;height:4px;border-radius:50%;background:var(--border-strong)}
      .landing .hero-meta svg{color:var(--green-600)}

      /* ---------- Phone mockup ---------- */
      .landing .phone-wrap{position:relative;display:flex;justify-content:center}
      .landing .phone{width:340px;max-width:86vw;aspect-ratio:340/700;background:var(--phone-frame);border-radius:46px;padding:11px;box-shadow:var(--shadow-phone);position:relative}
      .landing .phone-screen{background:var(--phone-screen);border-radius:36px;height:100%;display:flex;flex-direction:column;overflow:hidden}
      .landing .notch{width:104px;height:24px;background:var(--phone-frame);border-radius:999px;margin:10px auto 4px;flex:none}
      .landing .chat-head{display:flex;align-items:center;gap:10px;padding:10px 16px 12px;border-bottom:1px solid var(--border)}
      .landing .avatar{width:38px;height:38px;border-radius:50%;background:var(--green-100);color:var(--green-800);display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}
      .landing .chat-head .who{flex:1;min-width:0}
      .landing .chat-head .name{font-size:15px;font-weight:600;color:var(--text);line-height:1.25}
      .landing .chat-head .status{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);line-height:1.25}
      .landing .chat-head .status .dot{width:7px;height:7px}
      .landing .chat-head .status .dot::after{display:none}
      .landing .chat-body{flex:1;padding:18px 14px;display:flex;flex-direction:column;gap:10px;overflow:hidden}
      .landing .msg{max-width:78%;padding:9px 13px;font-size:13.5px;line-height:1.45;border-radius:18px;position:relative;animation:vt-landing-rise .45s ease both}
      .landing .msg .time{display:block;font-size:10.5px;margin-top:3px;opacity:.65;text-align:right}
      .landing .msg-in{background:var(--bubble-in);color:var(--text);border-bottom-left-radius:5px;align-self:flex-start}
      .landing .msg-out{background:var(--green-100);color:var(--green-900);border-bottom-right-radius:5px;align-self:flex-end}
      .landing .msg-out .ticks{color:var(--green-600);font-weight:700;letter-spacing:-2px}
      @keyframes vt-landing-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      .landing .typing{align-self:flex-start;background:var(--bubble-in);border-radius:18px;border-bottom-left-radius:5px;padding:12px 14px;display:none;gap:5px}
      .landing .typing.on{display:flex}
      .landing .typing span{width:7px;height:7px;border-radius:50%;background:var(--subtle);animation:vt-landing-blink 1.2s infinite}
      .landing .typing span:nth-child(2){animation-delay:.15s}
      .landing .typing span:nth-child(3){animation-delay:.3s}
      @keyframes vt-landing-blink{0%,60%,100%{opacity:.3}30%{opacity:1}}
      .landing .chat-input{display:flex;align-items:center;gap:8px;padding:10px 12px 16px;border-top:1px solid var(--border)}
      .landing .chat-input .field{flex:1;background:var(--bubble-in);border-radius:999px;padding:9px 14px;font-size:13px;color:var(--body)} /* M5: --muted on --bubble-in = 4.39:1 (AA fail), --body passes */
      .landing .send-btn{width:38px;height:38px;border-radius:50%;background:var(--green-700);color:#fff;display:grid;place-items:center;flex:none;border:0}
      .landing .float-card{position:absolute;left:2%;bottom:16%;max-width:calc(100vw - 32px);background:var(--bg);border:1px solid var(--border);border-radius:14px;
        box-shadow:0 12px 32px rgba(17,24,39,.10);padding:12px 16px;display:flex;align-items:center;gap:10px;animation:vt-landing-floaty 5s ease-in-out infinite}
      .landing .float-card .fc-icon{width:34px;height:34px;border-radius:10px;background:var(--green-100);color:var(--green-700);display:grid;place-items:center;flex:none}
      .landing .float-card .fc-title{font-size:13.5px;font-weight:600;color:var(--text);line-height:1.3}
      .landing .float-card .fc-sub{font-size:12px;color:var(--muted);line-height:1.3}
      @keyframes vt-landing-floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
      @media (max-width:980px){
        .landing .hero-grid{grid-template-columns:1fr;gap:56px;justify-items:center}
        /* Mobile hero redesign (Apple-style centered hero): left-aligned text
           next to a centered mockup read as a lopsided right-side gap, and the
           headline wrapped with "thought." orphaned on its own line. Centered
           layout + balanced headline = symmetric margins, no stray space. */
        .landing .hero{padding:32px 0 72px;text-align:center}
        .landing .hero-sub{margin-left:auto;margin-right:auto}
        .landing .hero-ctas{justify-content:center}
        .landing .hero-meta{justify-content:center}
        .landing h1{text-wrap:balance}
        /* The floating card is left-anchored over the mockup, which made the
           product shot look off-center on mobile — hidden here so the mockup
           stands clean and centered. Desktop keeps the card. */
        .landing .float-card{display:none}
      }

      /* ---------- Trust strip ---------- */
      .landing .trust{border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:28px 0}
      .landing .trust-row{display:flex;align-items:center;justify-content:center;gap:14px 44px;flex-wrap:wrap;font-size:14.5px;font-weight:500;color:var(--muted)}
      .landing .trust-row .t{display:inline-flex;align-items:center;gap:8px}
      .landing .trust-row svg{color:var(--green-600)}

      /* ---------- Section heads ---------- */
      .landing .sec-head{max-width:640px;margin:0 auto 56px;text-align:center}
      .landing .sec-head .sub{font-size:18px;color:var(--muted);margin-top:16px;line-height:1.6}

      /* ---------- Features ---------- */
      .landing .features{background:var(--bg-alt)}
      .landing .feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
      @media (max-width:980px){ .landing .feat-grid{grid-template-columns:repeat(2,1fr)} }
      @media (max-width:620px){ .landing .feat-grid{grid-template-columns:1fr} }
      .landing .card{background:var(--bg);border:1px solid var(--border);border-radius:16px;padding:28px;box-shadow:var(--shadow-card)}
      .landing .icon-chip{width:48px;height:48px;border-radius:12px;background:var(--green-100);color:var(--green-700);display:grid;place-items:center;margin-bottom:20px}
      .landing .card p{font-size:15.5px;color:var(--muted);margin-top:10px;line-height:1.6}

      /* ---------- Showcase ---------- */
      .landing .show-grid{display:grid;grid-template-columns:1fr 1fr;gap:72px;align-items:center}
      @media (max-width:880px){ .landing .show-grid{grid-template-columns:1fr;gap:44px} }
      /* Overflow guard: grid items default to min-width:auto, so one nowrap
         line (.r-last, min-content 247px) forced the showcase grid to 410px
         and made the whole page slide sideways. min-width:0 lets the track
         shrink and the ellipsis clip the line instead. Same guard on the
         other grids so no section can ever push the page wider. */
      .landing .show-grid > *, .landing .feat-grid > *, .landing .steps > *, .landing .foot-grid > *, .landing .hero-grid > *{min-width:0}
      .landing .panel{min-width:0}
      .landing .room-list > *{min-width:0}
      .landing .room{min-width:0;overflow:hidden}
      .landing .checks li{min-width:0}
      .landing .checks li > span{min-width:0}
      .landing{overflow-x:clip}
      .landing .checks{list-style:none;margin:28px 0 0;padding:0;display:grid;gap:14px}
      .landing .checks li{display:flex;gap:12px;align-items:flex-start;font-size:16px;color:var(--body)}
      .landing .checks .ck{width:24px;height:24px;border-radius:50%;background:var(--green-100);color:var(--green-700);display:grid;place-items:center;flex:none;margin-top:1px}
      .landing .checks b{color:var(--text);font-weight:600}
      .landing .panel{background:var(--mint-tint);border:1px solid var(--mint-line);border-radius:24px;padding:32px}
      .landing .room-list{display:grid;gap:12px}
      .landing .room{display:flex;align-items:center;gap:14px;background:var(--bg);border:1px solid var(--border);border-radius:16px;padding:14px 16px}
      .landing .room .avatar{width:44px;height:44px;font-size:15px}
      .landing .room .r-main{flex:1;min-width:0}
      .landing .room .r-name{display:flex;justify-content:space-between;gap:12px;font-size:15px;font-weight:600;color:var(--text)}
      .landing .room .r-name-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .landing .room .r-name time,.landing .room .r-name .r-time{flex:none;white-space:nowrap;font-size:12px;font-weight:400;color:var(--muted)}
      .landing .room .r-last{font-size:13.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .landing .badge{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--green-700);color:#fff;font-size:11.5px;font-weight:700;display:grid;place-items:center;flex:none} /* M5: white on green-600 = 3.30:1 (AA fail), green-700 = 5.02:1 */
      .landing .room .pin{color:var(--muted);flex:none}
      .landing .voice-note{display:flex;align-items:center;gap:10px}
      .landing .voice-note .play{width:30px;height:30px;border-radius:50%;background:var(--green-700);color:#fff;display:grid;place-items:center;flex:none}
      .landing .wave{display:flex;align-items:center;gap:2.5px;height:22px}
      .landing .wave i{width:3px;border-radius:2px;background:var(--green-600);display:block}

      /* ---------- How it works ---------- */
      .landing .how{background:var(--mint-tint)}
      .landing .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
      @media (max-width:880px){ .landing .steps{grid-template-columns:1fr} }
      .landing .step{background:var(--bg);border:1px solid var(--mint-line);border-radius:16px;padding:28px}
      .landing .step-num{width:40px;height:40px;border-radius:50%;background:var(--green-700);color:#fff;font-weight:700;font-size:16px;display:grid;place-items:center;margin-bottom:20px}
      .landing .step p{font-size:15.5px;color:var(--muted);margin-top:10px}

      /* ---------- Download CTA ---------- */
      .landing .cta-panel{background:var(--mint-tint);border:1px solid var(--mint-line);border-radius:24px;padding:64px 48px;text-align:center;color:var(--body)}
      .landing .cta-panel h2{color:var(--text)}
      .landing .cta-panel .sub{font-size:18px;margin:16px auto 0;max-width:32rem;color:var(--muted)}
      .landing .cta-actions{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-top:36px}
      .landing .cta-panel .btn-secondary{background:#fff;color:var(--text);border-color:var(--border-strong)}
      .landing .cta-panel .btn-secondary:hover{border-color:var(--subtle)}
      .landing .cta-note{margin-top:24px;font-size:13.5px;color:var(--muted);display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
      .landing .cta-note span{display:inline-flex;align-items:center;gap:6px}
      .landing .cta-note svg{color:var(--green-600)}
      @media (max-width:620px){ .landing .cta-panel{padding:48px 24px} }

      /* ---------- Footer ---------- */
      .landing footer{border-top:1px solid var(--border);background:var(--bg-alt);padding:64px 0 0}
      .landing .foot-grid{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:40px;padding-bottom:48px}
      @media (max-width:880px){ .landing .foot-grid{grid-template-columns:1fr 1fr} }
      @media (max-width:520px){ .landing .foot-grid{grid-template-columns:1fr} }
      .landing .foot-tag{font-size:14.5px;color:var(--muted);margin-top:14px;max-width:22rem}
      .landing footer h3{font-size:14px;font-weight:600;color:var(--text);margin:0 0 16px}
      .landing .foot-links{list-style:none;margin:0;padding:0;display:grid;gap:10px}
      .landing .foot-links a{text-decoration:none;font-size:14px;color:var(--muted);display:inline-block;padding:4px 0;min-height:24px}
      .landing .foot-links a:hover{color:var(--text)}
      .landing .foot-bottom{border-top:1px solid var(--border);padding:22px 0 calc(22px + env(safe-area-inset-bottom));display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;font-size:13.5px;color:var(--muted)}
      .landing .credit{font-weight:600;color:var(--body)}

      /* ---------- Responsive polish: every PC width + mobile ---------- */
      @media (min-width:1440px){
        .landing .container{max-width:1240px}
        .landing .hero{padding:48px 0 112px}
      }
      @media (max-width:1100px){
        .landing section{padding:80px 0}
        .landing .hero-grid{gap:48px}
        .landing .show-grid{gap:48px}
      }
      @media (max-width:760px){
        .landing section{padding:64px 0}
        .landing .container{padding:0 20px}
        .landing .sec-head{margin-bottom:40px}
        .landing .sec-head .sub, .landing .hero-sub{font-size:16.5px}
        .landing .panel{padding:22px}
        .landing .room{padding:12px 14px}
      }
      @media (max-width:560px){
        .landing .hero-ctas{flex-direction:column;align-items:stretch}
        .landing .hero-ctas .btn{width:100%}
        .landing .hero-meta{gap:8px}
        .landing .cta-actions{flex-direction:column;align-items:stretch}
        .landing .cta-actions .btn{width:100%}
        .landing .trust-row{gap:10px 22px;justify-content:flex-start}
      }
      @media (max-width:400px){
        .landing section{padding:52px 0}
        .landing .container{padding:0 16px}
        .landing h1{font-size:2.35rem}
        .landing h2{font-size:1.7rem}
        .landing .phone{border-radius:38px;padding:9px}
        .landing .phone-screen{border-radius:30px}
        .landing .card, .landing .step{padding:22px}
        .landing .live-pill{font-size:12px}
      }
      @media (prefers-reduced-motion: reduce){
        .landing, .landing *, .landing *::before, .landing *::after{animation:none !important;transition:none !important}
        html:has(.landing){scroll-behavior:auto}
      }
      /* M66: the old sonner fix (section[aria-label^="Notifications"] with
         position:fixed + transform) is REMOVED — M65 scoped the
         "section{padding:96px 0}" leak it was patching, so the rule is
         dead (the Toaster lives in __root, outside .landing). Keeping it
         would only risk its "transform" re-parenting sonner's fixed
         toasts to the section box. */`;


const LANDING_HTML = `<a class="skip-link" href="#top">Skip to content</a>
    <header>
      <div class="container nav">
        <a class="logo" href="#top" aria-label="VibeTalk home">
          <span class="logo-mark" aria-hidden="true">
            <img src="/logo-mark.png" alt="" />
          </span>
          VibeTalk
        </a>
        <nav class="nav-links" aria-label="Main">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#download">Download</a>
        </nav>
        <div class="nav-actions">
          <a class="btn btn-secondary btn-sm nav-app" href="/VibeTalk.apk" download>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Get the app
          </a>
          <a class="nav-signin" href="/login">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/register">Sign up</a>
        </div>
        <button class="hamburger" id="hamburger" aria-label="Open menu" aria-expanded="false" aria-controls="mobileMenu">
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>

    <!-- Audit-2 L5: no-JS fallback. With JS on this block never renders
         (noscript contents stay raw text) and the hamburger menu owns
         mobile nav. With JS off the hamburger is dead, so this static
         nav is the only path to Sign in / Sign up at <=860px. -->
    <noscript>
      <style>.landing .hamburger{display:none !important}</style>
      <div class="noscript-nav">
        <a href="#features">Features</a>
        <a href="#how">How it works</a>
        <a href="#download">Download</a>
        <a href="/VibeTalk.apk" download>Get the app</a>
        <a href="/login">Sign in</a>
        <a class="btn btn-primary btn-sm" href="/register">Sign up</a>
      </div>
    </noscript>

    <div class="mobile-menu" id="mobileMenu" role="dialog" aria-modal="true" aria-label="Menu" aria-hidden="true">
      <div class="mobile-menu-top">
        <a class="logo" href="#top" aria-label="VibeTalk home">
          <span class="logo-mark" aria-hidden="true">
            <img src="/logo-mark.png" alt="" />
          </span>
          VibeTalk
        </a>
        <button class="menu-close" id="menuClose" aria-label="Close menu">&times;</button>
      </div>
      <nav class="mobile-menu-links" aria-label="Mobile">
        <a href="#features">Features</a>
        <a href="#how">How it works</a>
        <a href="#download">Download</a>
      </nav>
      <div class="mobile-menu-actions">
        <a class="btn btn-secondary" href="/VibeTalk.apk" download>Get the app</a>
        <a class="menu-signin" href="/login">Sign in</a>
        <a class="btn btn-primary" href="/register">Sign up</a>
      </div>
    </div>

    <main id="top" tabindex="-1">
      <!-- ============ HERO ============ -->
      <section class="hero">
        <div class="container hero-grid">
          <div>
            <span class="live-pill"><span class="dot" aria-hidden="true"></span> Live — real-time chat, right now</span>
            <h1>Chat at the <span class="hl">speed</span> of thought.</h1>
            <!-- Audit-3 A1-F1: was "share the link" — no room join-link
                 mechanism exists (a shared /rooms/<id> URL is a dead end
                 for non-members), so the copy now describes the real
                 mechanism: the room creator adds members from the menu. -->
            <p class="hero-sub">Fast, private, real-time messaging for friends, teams and communities. Open a room, add your people from the room menu, and talk — no friction, no noise.</p>
            <div class="hero-ctas">
              <a class="btn btn-primary" href="/VibeTalk.apk" download>
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download for Android
              </a>
              <a class="btn btn-secondary" href="/login">Open web app</a>
            </div>
            <div class="hero-meta">
              <span class="t" style="display:inline-flex;align-items:center;gap:6px">
                <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                Private rooms
              </span>
              <span class="sep" aria-hidden="true"></span>
              <span>Free to use</span>
              <span class="sep" aria-hidden="true"></span>
              <span>Android 7.0+ · 11 MB</span>
            </div>
          </div>

          <div class="phone-wrap" aria-hidden="true">
            <div class="phone">
              <div class="phone-screen">
                <div class="notch"></div>
                <div class="chat-head">
                  <div class="avatar">S</div>
                  <div class="who">
                    <div class="name">Sunday Squad</div>
                    <div class="status"><span class="dot"></span> Sara is online</div>
                  </div>
                  <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                </div>
                <div class="chat-body" id="chatBody">
                  <div class="msg msg-in">Match photos are up! The last over was unreal<span class="time">9:41 AM</span></div>
                  <div class="msg msg-out">Saw them — that catch deserves its own highlight reel <span class="ticks">✓✓</span><span class="time">9:42 AM</span></div>
                  <div class="msg msg-in">Voice note coming, too long to type<span class="time">9:42 AM</span></div>
                  <div class="typing" id="typing"><span></span><span></span><span></span></div>
                </div>
                <div class="chat-input">
                  <div class="field">Message…</div>
                  <button class="send-btn" tabindex="-1" aria-hidden="true">
                    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                  </button>
                </div>
              </div>
            </div>
            <div class="float-card">
              <span class="fc-icon">
                <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </span>
              <span>
                <span class="fc-title">Delivered instantly</span><br />
                <span class="fc-sub">Read receipts on every message</span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ TRUST STRIP ============ -->
      <div class="trust">
        <div class="container trust-row">
          <span class="t"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg> Real-time delivery</span>
          <span class="t"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Private rooms &amp; invite control</span>
          <span class="t"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg> Voice messages</span>
          <span class="t"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> Push notifications</span>
          <span class="t"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg> Web + Android</span>
        </div>
      </div>

      <!-- ============ FEATURES ============ -->
      <section class="features" id="features" tabindex="-1">
        <div class="container">
          <div class="sec-head">
            <p class="eyebrow">Features</p>
            <h2>Everything a conversation needs. Nothing it doesn’t.</h2>
            <p class="sub">Built around speed and privacy — the essentials, done properly.</p>
          </div>
          <div class="feat-grid">
            <article class="card">
              <div class="icon-chip"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
              <h3>Real-time, zero lag</h3>
              <p>Messages land the moment they’re sent. Typing indicators and live presence keep every conversation feeling face-to-face.</p>
            </article>
            <article class="card" id="private-rooms">
              <div class="icon-chip"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
              <h3>Private by default</h3>
              <p>Rooms stay invite-only unless you open them up. You decide exactly who gets in — no strangers wandering into your space.</p>
            </article>
            <article class="card">
              <div class="icon-chip"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div>
              <h3>Rooms &amp; direct messages</h3>
              <p>Group rooms for your crew, one-to-one threads for everything else — pin, mute and organise them your way.</p>
            </article>
            <article class="card" id="voice-messages">
              <div class="icon-chip"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></div>
              <h3>Voice messages</h3>
              <p>Too long to type? Hold, speak, send. Voice notes play right inside the thread, waveform and all.</p>
            </article>
            <article class="card" id="read-receipts">
              <div class="icon-chip"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/><polyline points="13 6 22 6" opacity="0"/><path d="M11 17l-5-5"/><path d="M20 6 9 17l-5-5" opacity="0"/></svg></div>
              <h3>Read receipts</h3>
              <p>One tick sent, two ticks seen — by everyone in the room. No more “did you get my message?”</p>
            </article>
            <article class="card">
              <div class="icon-chip"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></div>
              <h3>Everywhere you are</h3>
              <p>Full experience in the browser, native app on Android — with push notifications so you never miss a reply.</p>
            </article>
          </div>
        </div>
      </section>

      <!-- ============ SHOWCASE ============ -->
      <section>
        <div class="container show-grid">
          <div>
            <p class="eyebrow">Your inbox, organised</p>
            <h2>Every conversation, one clean list.</h2>
            <ul class="checks">
              <li><span class="ck"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span><b>Pin what matters</b> — keep your most important chats at the top.</span></li>
              <li><span class="ck"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span><b>Mute the noise</b> — silence busy rooms without leaving them.</span></li>
              <li><span class="ck"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span><b>Unread counts</b> — see at a glance exactly where you’re needed.</span></li>
              <li><span class="ck"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span><b>Reactions &amp; replies</b> — respond in a tap, edit or delete when you need to.</span></li>
            </ul>
          </div>
          <div class="panel" aria-hidden="true">
            <div class="room-list">
              <div class="room">
                <div class="avatar">S</div>
                <div class="r-main">
                  <div class="r-name"><span class="r-name-text">Sunday Squad</span> <time datetime="09:42">9:42 AM</time></div>
                  <div class="r-last">You: Saw them — that catch deserves…</div>
                </div>
                <svg aria-hidden="true" class="pin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l1 7 2.5 2.5a1 1 0 0 1-.7 1.5H6.2a1 1 0 0 1-.7-1.5L8 10z"/></svg>
              </div>
              <div class="room">
                <div class="avatar" style="background:var(--bubble-in);color:var(--body)">A</div>
                <div class="r-main">
                  <div class="r-name"><span class="r-name-text">Ayesha</span> <time datetime="09:15">9:15 AM</time></div>
                  <div class="r-last voice-note">
                    <span class="play"><svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
                    <span class="wave">
                      <i style="height:8px"></i><i style="height:14px"></i><i style="height:20px"></i><i style="height:12px"></i><i style="height:18px"></i><i style="height:9px"></i><i style="height:15px"></i><i style="height:11px"></i><i style="height:17px"></i><i style="height:8px"></i>
                    </span>
                    <span style="font-size:12px;color:var(--muted)">0:42</span>
                  </div>
                </div>
                <span class="badge">2</span>
              </div>
              <div class="room">
                <div class="avatar" style="background:var(--bubble-in);color:var(--body)">D</div>
                <div class="r-main">
                  <div class="r-name"><span class="r-name-text">Design Review</span> <span class="r-time">Yesterday</span></div>
                  <div class="r-last">Bilal: New homepage is looking sharp</div>
                </div>
                <span class="badge">5</span>
              </div>
              <div class="room">
                <div class="avatar" style="background:var(--bubble-in);color:var(--body)">F</div>
                <div class="r-main">
                  <div class="r-name"><span class="r-name-text">Family</span> <span class="r-time">Yesterday</span></div>
                  <div class="r-last">Ammi: Dinner at 8, don’t be late</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ HOW IT WORKS ============ -->
      <section class="how" id="how" tabindex="-1">
        <div class="container">
          <div class="sec-head">
            <p class="eyebrow">How it works</p>
            <h2>Talking in under two minutes.</h2>
            <!-- Audit-3 A1-F1: "invite your people" read as link-invites; the real mechanism is adding members from the room menu. -->
            <p class="sub">No complicated setup. Create an account, open a room, add your people from the room menu.</p>
          </div>
          <div class="steps">
            <div class="step">
              <div class="step-num">1</div>
              <h3>Create your account</h3>
              <p>Sign up free with your email — verify it, set your password, and you're in.</p>
            </div>
            <div class="step">
              <div class="step-num">2</div>
              <h3>Open a room</h3>
              <p>Start a private room for your group, or a direct message with one person. You control access.</p>
            </div>
            <div class="step">
              <div class="step-num">3</div>
              <h3>Start talking</h3>
              <p>Text, voice notes, reactions and read receipts — everything updates live for everyone in the room.</p>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ DOWNLOAD CTA ============ -->
      <section id="download" tabindex="-1">
        <div class="container">
          <div class="cta-panel">
            <h2>Get VibeTalk free.</h2>
            <p class="sub">Take the conversation with you. Native Android app, or straight in your browser — same account, same rooms.</p>
            <div class="cta-actions">
              <a class="btn btn-primary" href="/VibeTalk.apk" download>
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download for Android
              </a>
              <a class="btn btn-secondary" href="/login">Use VibeTalk on the web</a>
            </div>
            <div class="cta-note">
              <span><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Free</span>
              <span><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 11 MB</span>
              <span><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Android 7.0+</span>
              <span><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 2-minute setup</span>
            </div>
            <p style="margin-top:18px;font-size:13px;color:var(--muted)">Installing the APK? You may need to allow “install from unknown sources” for your browser — just this once.</p>
            <p style="margin-top:8px;font-size:12px;color:var(--muted);word-break:break-all">SHA-256: <code>c2131062707990450d5051fdf1c8df712547a7d1e258835813cbf9ff757f0850</code></p>
          </div>
        </div>
      </section>
    </main>

    <!-- ============ FOOTER ============ -->
    <footer>
      <div class="container">
        <div class="foot-grid">
          <div>
            <a class="logo" href="#top" aria-label="VibeTalk home">
              <span class="logo-mark" aria-hidden="true">
                <img src="/logo-mark.png" alt="" />
              </span>
              VibeTalk
            </a>
            <p class="foot-tag">Fast, private, real-time chat for friends, teams and communities.</p>
          </div>
          <div>
            <h3>Product</h3>
            <ul class="foot-links">
              <li><a href="#features">Features</a></li>
              <li><a href="#how">How it works</a></li>
              <li><a href="#download">Download</a></li>
              <li><a href="/login">Web app</a></li>
            </ul>
          </div>
          <div>
            <h3>Get the app</h3>
            <ul class="foot-links">
              <li><a href="/VibeTalk.apk" download>Android (APK)</a></li>
              <li><a href="/login">VibeTalk Web</a></li>
            </ul>
          </div>
          <div>
            <h3>At a glance</h3>
            <ul class="foot-links">
              <li><a href="#private-rooms">Private rooms</a></li>
              <li><a href="#voice-messages">Voice messages</a></li>
              <li><a href="#read-receipts">Read receipts</a></li>
            </ul>
          </div>
        </div>
        <div class="foot-bottom">
          <span>© <span data-year>2026</span> VibeTalk. All rights reserved.</span>
          <span class="credit">Made with 🤍 by HAMZA CYBER</span>
        </div>
      </div>
    </footer>

`;

function Landing() {
  const { session, loading } = useAuth();
  useEffect(() => {
    // Insurance for stale ?call= URLs (old service worker installs or
    // shared links): the landing page has no CallProvider and cannot
    // handle call actions. Forward them into the app, where CallProvider
    // consumes them. The new SW opens /rooms?call=... directly, so this
    // only fires for legacy URLs. (audit C3)
    const search = new URLSearchParams(window.location.search);
    const callParam = search.get("call");
    if (callParam === "accept" || callParam === "decline") {
      if (search.get("callId")) {
        window.location.replace(`/rooms${window.location.search}`);
        return;
      }
      // Audit-2 L6: accept/decline WITHOUT a callId is a stale URL — strip
      // the dead params in place instead of forwarding them to /rooms,
      // where the consumer would ignore them and never clean them.
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("call");
        url.searchParams.delete("callId");
        url.searchParams.delete("from");
        url.searchParams.delete("callType");
        window.history.replaceState(null, "", url.toString());
      } catch {
        // URL cleanup is cosmetic; the landing still renders.
      }
    }

    // Audit-2 M18: the landing is a fixed LIGHT design, rendered via
    // its own scoped .landing CSS (background + color-scheme there).
    // The old code mutated <html> (.dark removal, colorScheme,
    // body background) in a post-paint effect and restored it on
    // cleanup — a second flash, and store/DOM disagreement (a
    // cross-tab toggle re-added .dark on top of the light landing).
    // <html> is never touched here now; the theme store owns it.
    // L2: save the previous body overflow the same way — openMenu used
    // to overwrite it and closeMenu/cleanup unconditionally cleared it
    // to "", which would silently kill any other scroll lock active on
    // this page (a future modal/toast/call overlay).
    const prevBodyOverflow = document.body.style.overflow;

    // Chat animation — same logic as the approved HTML file's inline script.
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let cancelled = false;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const chatBody = document.getElementById("chatBody");
    const typing = document.getElementById("typing");
    if (chatBody && typing && !reduce) {
      const script: Array<{ who: "out" | "in"; text: string }> = [
        { who: "out", text: "Perfect. Sending the plan to the group now" },
        { who: "in", text: "Already pinned it — check the top of the room" },
        { who: "out", text: "That was fast. This is why I switched" },
      ];
      const times = ["9:43 AM", "9:44 AM", "9:44 AM"];
      let i = 0;
      const addMsg = () => {
        if (cancelled || i >= script.length) {
          typing.classList.remove("on");
          return;
        }
        typing.classList.add("on");
        const item = script[i];
        const t = times[i];
        timers.push(
          setTimeout(() => {
            if (cancelled) return;
            typing.classList.remove("on");
            const el = document.createElement("div");
            el.className = "msg " + (item.who === "out" ? "msg-out" : "msg-in");
            el.textContent = item.text;
            const time = document.createElement("span");
            time.className = "time";
            if (item.who === "out") {
              const ticks = document.createElement("span");
              ticks.className = "ticks";
              ticks.textContent = "✓✓ ";
              time.appendChild(ticks);
            }
            time.appendChild(document.createTextNode(t));
            el.appendChild(time);
            chatBody.insertBefore(el, typing);
            const msgs = chatBody.querySelectorAll(".msg");
            if (msgs.length > 5) msgs[0].remove();
            i++;
            timers.push(setTimeout(addMsg, 2200));
          }, 1600),
        );
      };
      timers.push(setTimeout(addMsg, 1800));
    }

    // Mobile hamburger menu (Apple-style full-screen overlay).
    const hamburger = document.getElementById("hamburger");
    const mobileMenu = document.getElementById("mobileMenu");
    const menuClose = document.getElementById("menuClose");
    // M68: focus trap + inert background + focus return. Without these,
    // keyboard/screen-reader users could Tab straight through the
    // opaque overlay into the page behind it, and closing left focus
    // on a now-hidden element (falling back to <body>).
    let menuOpen = false;
    const focusables = () =>
      Array.from(
        mobileMenu?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null);
    const setBackgroundInert = (inert: boolean) => {
      // The menu's siblings inside .landing (header/main/footer) are
      // the background — :scope keeps nested <header>s (none today)
      // out of it.
      mobileMenu?.parentElement
        ?.querySelectorAll(":scope > header, :scope > main, :scope > footer, :scope > .skip-link")
        .forEach((el) => {
          if (inert) {
            el.setAttribute("inert", "");
            el.setAttribute("aria-hidden", "true");
          } else {
            el.removeAttribute("inert");
            el.removeAttribute("aria-hidden");
          }
        });
    };
    const openMenu = () => {
      menuOpen = true;
      mobileMenu?.classList.add("open");
      hamburger?.setAttribute("aria-expanded", "true");
      // L3: the label must follow the state — a screen-reader user on
      // an already-open menu used to hear "Open menu" (wrong affordance).
      hamburger?.setAttribute("aria-label", "Close menu");
      mobileMenu?.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
      setBackgroundInert(true);
      // Land keyboard focus inside the menu (on the escape hatch),
      // not on the hamburger now hidden behind the overlay.
      menuClose?.focus();
    };
    const closeMenu = (returnFocus = true) => {
      menuOpen = false;
      mobileMenu?.classList.remove("open");
      hamburger?.setAttribute("aria-expanded", "false");
      hamburger?.setAttribute("aria-label", "Open menu");
      mobileMenu?.setAttribute("aria-hidden", "true");
      // L2: restore the saved overflow instead of clearing to "".
      document.body.style.overflow = prevBodyOverflow;
      setBackgroundInert(false);
      // Dismissals (Escape / close button) return focus to the
      // hamburger. Link clicks pass false — the anchor navigation
      // provides the context, and stealing focus back to the top
      // would yank the user away from where they just navigated.
      if (returnFocus) hamburger?.focus();
    };
    const onMenuKey = (e: KeyboardEvent) => {
      if (!menuOpen) return;
      if (e.key === "Escape") {
        closeMenu(true);
        return;
      }
      if (e.key === "Tab") {
        const items = focusables();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (!mobileMenu?.contains(document.activeElement)) {
          // Focus escaped somehow — pull it back into the menu.
          e.preventDefault();
          first.focus();
        }
      }
    };
    const onHamburgerClick = () => openMenu();
    const onMenuCloseClick = () => closeMenu(true);
    // M6: same-page anchor links used to leave focus on the menu link,
    // which is visibility:hidden + aria-hidden after closeMenu — a
    // focused-element-must-not-be-hidden violation, and the anchor jump
    // scrolls but never moves focus. Move focus to the target section
    // (tabindex="-1" set statically in LANDING_HTML) so the
    // keyboard/screen-reader user lands where they navigated.
    // Non-anchor links (/login, /register, /VibeTalk.apk) navigate away,
    // so they only get closeMenu(false).
    const onMenuLinkClick = (e: MouseEvent) => {
      const href =
        (e.currentTarget as HTMLAnchorElement | null)?.getAttribute("href") ?? "";
      closeMenu(false);
      if (!href.startsWith("#") || href.length < 2) return;
      document.getElementById(href.slice(1))?.focus({ preventScroll: true });
    };
    hamburger?.addEventListener("click", onHamburgerClick);
    menuClose?.addEventListener("click", onMenuCloseClick);
    mobileMenu?.querySelectorAll("a").forEach((a) => a.addEventListener("click", onMenuLinkClick));
    document.addEventListener("keydown", onMenuKey);
    // L1: resizing to desktop (≥861px) hides the menu + hamburger via
    // CSS, but the scroll lock + inert background only clear in
    // closeMenu — without this, a widened window stays scroll-locked
    // with no visible way to close. closeMenu(false): no focus return
    // (the hamburger is hidden at desktop width).
    const desktopMq = window.matchMedia("(min-width: 861px)");
    const onDesktopWidth = () => {
      if (desktopMq.matches) closeMenu(false);
    };
    desktopMq.addEventListener("change", onDesktopWidth);

    return () => {
      cancelled = true;
      timers.forEach((t) => clearTimeout(t));
      hamburger?.removeEventListener("click", onHamburgerClick);
      menuClose?.removeEventListener("click", onMenuCloseClick);
      mobileMenu?.querySelectorAll("a").forEach((a) => a.removeEventListener("click", onMenuLinkClick));
      document.removeEventListener("keydown", onMenuKey);
      desktopMq.removeEventListener("change", onDesktopWidth);
      // L2: restore the saved overflow (same as closeMenu).
      document.body.style.overflow = prevBodyOverflow;
    };

  }, []);

  // Audit-3 A1-F10: the footer year is rendered from the clock, not a
  // hardcoded literal (the static "2026" in LANDING_HTML is only the
  // no-JS fallback).
  useEffect(() => {
    document.querySelectorAll(".landing [data-year]").forEach((el) => {
      el.textContent = String(new Date().getFullYear());
    });
  }, []);

  // Audit-2 L7: a logged-in visitor used to see Sign in / Sign up and
  // took an extra hop (/login bounces back to /rooms). The CTAs live
  // in the static LANDING_HTML string, so they are rewritten in place
  // by this effect (same DOM-effect pattern as the rest of this file).
  // Originals are stashed in data-l7-* attrs so a sign-out (e.g. from
  // another tab) restores them instead of leaving stale "Open app".
  useEffect(() => {
    if (loading) return;
    // Audit-3 A1-F7: auth has resolved — reveal the CTAs (CSS keeps
    // them visibility:hidden until this flag is set).
    document.body.dataset.l7Ready = "1";
    const q = <T extends Element>(sel: string) =>
      document.querySelector<T>(`.landing ${sel}`);
    const relabel = (el: HTMLAnchorElement | null, text: string, href: string) => {
      if (!el) return;
      if (el.dataset.l7Orig === undefined) {
        el.dataset.l7Orig = el.textContent ?? "";
        el.dataset.l7Href = el.getAttribute("href") ?? "";
      }
      el.textContent = text;
      el.setAttribute("href", href);
    };
    const retarget = (el: HTMLAnchorElement | null, href: string) => {
      if (!el) return;
      if (el.dataset.l7Href === undefined) {
        el.dataset.l7Href = el.getAttribute("href") ?? "";
      }
      el.setAttribute("href", href);
    };
    const hide = (el: HTMLElement | null) => {
      if (!el) return;
      if (el.dataset.l7OrigDisplay === undefined) {
        el.dataset.l7OrigDisplay = el.style.display;
      }
      el.style.display = "none";
    };
    if (session) {
      relabel(q<HTMLAnchorElement>(".nav-signin"), "Open app", "/rooms");
      relabel(q<HTMLAnchorElement>(".menu-signin"), "Open app", "/rooms");
      retarget(q<HTMLAnchorElement>(".hero-ctas a[href='/login']"), "/rooms");
      hide(q<HTMLElement>(".nav-actions a[href='/register']"));
      hide(q<HTMLElement>(".mobile-menu-actions a[href='/register']"));
    } else {
      // Logged out: restore anything a previous session rewrote.
      document.querySelectorAll(".landing [data-l7-orig]").forEach((el) => {
        const a = el as HTMLAnchorElement;
        a.textContent = a.dataset.l7Orig ?? "";
        if (a.dataset.l7Href !== undefined) a.setAttribute("href", a.dataset.l7Href);
        delete a.dataset.l7Orig;
        delete a.dataset.l7Href;
      });
      document.querySelectorAll(".landing [data-l7-href]").forEach((el) => {
        const a = el as HTMLAnchorElement;
        a.setAttribute("href", a.dataset.l7Href ?? "");
        delete a.dataset.l7Href;
      });
      document.querySelectorAll(".landing [data-l7-orig-display]").forEach((el) => {
        const h = el as HTMLElement;
        h.style.display = h.dataset.l7OrigDisplay ?? "";
        delete h.dataset.l7OrigDisplay;
      });
    }
    // Audit-4 L54: the gate MUST be cleared on unmount. l7Ready
    // lives on <body>, outside React's tree, so it survived client
    // navigation — an SPA revisit re-rendered the logged-out CTA
    // text with the flag already present, flashing the wrong
    // labels until this effect re-ran. The cleanup also runs
    // before a dep-change re-run (same commit, no paint between),
    // so the flag is re-set immediately after. Note the old
    // session branch returned early with NO cleanup — the
    // if/else restructure registers it on both paths.
    return () => {
      delete document.body.dataset.l7Ready;
    };
  }, [session, loading]);

  // Audit-2 L12: the APK is Android-only. On non-Android a click used to
  // silently download an 11.5MB file the device can't run. Intercept it:
  // confirm() offers "download anyway" (e.g. to send it to a phone) or
  // the web app instead. Android UA skips the gate entirely. (The
  // noscript APK link has no JS, so it keeps its plain download.)
  useEffect(() => {
    const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    if (/Android/i.test(navigator.userAgent) || uaData?.platform === "Android") return;
    const onApkClick = (e: MouseEvent) => {
      const downloadAnyway = window.confirm(
        "VibeTalk.apk only works on Android phones. OK = download it anyway (e.g. to send it to your phone). Cancel = open the web app instead.",
      );
      if (!downloadAnyway) {
        e.preventDefault();
        window.location.href = "/login";
      }
    };
    // Audit-3 A1-F6: middle-click fires `auxclick`, not `click` — the
    // same gate must run there or the warning is bypassed. Context-menu
    // "open in new tab" cannot be intercepted (accepted limitation).
    const onApkAuxClick = (e: MouseEvent) => {
      if (e.button !== 1) return;
      onApkClick(e);
    };
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('.landing a[href="/VibeTalk.apk"]'),
    );
    links.forEach((a) => {
      a.addEventListener("click", onApkClick);
      a.addEventListener("auxclick", onApkAuxClick);
    });
    return () =>
      links.forEach((a) => {
        a.removeEventListener("click", onApkClick);
        a.removeEventListener("auxclick", onApkAuxClick);
      });
  }, []);

  return (
    <>
      <style>{LANDING_CSS}</style>
      {/* M65: the landing styles are scoped under .landing (see
          LANDING_CSS) so they can't leak onto app-wide elements. */}
      <div className="landing" dangerouslySetInnerHTML={{ __html: LANDING_HTML }} />
    </>
  );
}
