import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

// Auth CSS from user-supplied vibetalk-auth-ui.html, green remapped to the
// homepage system (brand #00A651, accent #16A34A, buttons #15803D, mint
// #DCFCE7/#F0FDF4, neutrals #111827/#374151/#6B7280/#E5E7EB) + overrides.
export const AUTH_CSS = `.auth-shell {
    --green: #15803d;
    --green-dark: #14532d;
    --green-deep: #14532d;
    --mint: #f0fdf4;
    --mint-pale: #f0fdf4;
    --ink: #14532d;
    --muted: #374151;
    --line: #f0fdf4;
    --surface: #ffffff;
    --bg: #f0fdf4;
    --shadow: 0 24px 80px rgba(20, 83, 45, .09);
    --radius-xl: 30px;
  }
  .auth-shell, .auth-shell * { box-sizing: border-box; }
  
  .auth-shell {
    min-height: 100vh;
    color: var(--ink);
    background:
      radial-gradient(circle at 9% 8%, rgba(220, 252, 231, .40), transparent 24rem),
      radial-gradient(circle at 88% 86%, rgba(240, 253, 244, .52), transparent 27rem),
      var(--bg);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow-x: clip;
  }
  .auth-shell button, .auth-shell input { font: inherit; }
  .auth-shell button { -webkit-tap-highlight-color: transparent; }
  .auth-shell .ambient {
    pointer-events: none; position: fixed; z-index: 0; border-radius: 50%; filter: blur(1px);
    opacity: .65; animation: auth-drift 13s ease-in-out infinite alternate;
  }
  .auth-shell .ambient.one { width: 230px; height: 230px; left: -120px; top: 34%; background: rgba(0, 166, 81, .19); }
  .auth-shell .ambient.two { width: 300px; height: 300px; right: -170px; top: 6%; background: rgba(0, 166, 81, .13); animation-delay: -5s; }
  .auth-shell .ambient.three { width: 180px; height: 180px; right: 25%; bottom: -110px; background: rgba(220, 252, 231, .26); animation-delay: -8s; }
  @keyframes auth-drift { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(22px,-18px,0) scale(1.08); } }

  .auth-shell .page-shell { position: relative; z-index: 1; width: min(1180px, calc(100% - 56px)); min-height: 100vh; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(420px, .92fr); align-items: center; gap: clamp(44px, 7vw, 100px); padding: 38px 0; background: #FFFFFF; color-scheme: light; }
  .auth-shell .story { min-width: 0; position: relative; padding: 10px 0 26px; }
  .auth-shell .brand { display: inline-flex; gap: 12px; align-items: center; text-decoration: none; color: inherit; }
  .auth-shell .brand-mark { position: relative; width: 46px; height: 46px; border-radius: 15px; display: grid; place-items: center; color: white; font-size: 31px; font-weight: 850; letter-spacing: -3px; background: linear-gradient(145deg, #15803d 0%, #14532d 100%); box-shadow: 0 8px 20px rgba(20, 83, 45, .22), inset 0 1px 0 rgba(255, 255, 255, .28); }
  .auth-shell .brand-mark::after { content: ""; position: absolute; width: 8px; height: 8px; border-radius: 50%; background: #00a651; top: 9px; right: 8px; box-shadow: 0 0 0 3px rgba(255, 255, 255, .12); }
  .auth-shell .brand-word { font-size: 18px; font-weight: 780; letter-spacing: -.6px; line-height: 1.15; }
  .auth-shell .brand-sub { display: block; font-size: 11px; color: var(--muted); font-weight: 550; margin-top: 4px; letter-spacing: .2px; }
  .auth-shell .eyebrow { display: inline-flex; align-items: center; gap: 8px; margin: 62px 0 20px; padding: 8px 12px; border: 1px solid #f0fdf4; background: rgba(255, 255, 255, .7); border-radius: 999px; color: #15803d; font-weight: 700; font-size: 12px; letter-spacing: .25px; box-shadow: 0 4px 15px rgba(20, 83, 45, .035); }
  .auth-shell .live-dot { width: 7px; height: 7px; border-radius: 50%; background: #15803d; box-shadow: 0 0 0 4px #f0fdf4; }
  .auth-shell h1 { max-width: 590px; margin: 0; font-size: clamp(42px, 4.6vw, 64px); line-height: 1.05; letter-spacing: -3.2px; font-weight: 790; }
  .auth-shell h1 span { color: var(--green); }
  .auth-shell .story-copy { max-width: 470px; margin: 22px 0 0; color: #6b7280; line-height: 1.75; font-size: 16px; }
  .auth-shell .benefits { display: flex; flex-wrap: wrap; gap: 12px 20px; margin-top: 28px; color: #15803d; font-size: 13px; font-weight: 650; }
  .auth-shell .benefit { display: inline-flex; align-items: center; gap: 8px; }
  .auth-shell .benefit svg { color: var(--green); width: 17px; height: 17px; }
  .auth-shell .preview-wrap { position: relative; margin-top: 44px; max-width: 505px; min-height: 285px; }
  .auth-shell .preview-glow { position: absolute; inset: 42px 35px 0; background: #dcfce7; border-radius: 40px; filter: blur(27px); opacity: .6; }
  .auth-shell .chat-preview { position: relative; background: rgba(255, 255, 255, .92); border: 1px solid rgba(240, 253, 244, .95); border-radius: 26px; box-shadow: 0 18px 50px rgba(20, 83, 45, .095); padding: 19px; transform: rotate(-1.2deg); animation: auth-card-float 6s ease-in-out infinite; }
  @keyframes auth-card-float { 0%,100% { transform: translateY(0) rotate(-1.2deg); } 50% { transform: translateY(-8px) rotate(-.2deg); } }
  .auth-shell .preview-top { display:flex; align-items:center; gap: 11px; padding-bottom: 15px; border-bottom: 1px solid #f0fdf4; }
  .auth-shell .avatar { flex: 0 0 auto; display:grid; place-items:center; width: 42px; height:42px; border-radius:15px; background: linear-gradient(145deg,#f0fdf4,#dcfce7); color:#14532d; font-weight:800; }
  .auth-shell .preview-person { font-size: 13px; font-weight: 760; }
  .auth-shell .preview-status { display:flex; align-items:center; gap:5px; margin-top:4px; color:#6b7280; font-size:11px; }
  .auth-shell .preview-actions { margin-left:auto; color:#6b7280; letter-spacing:3px; font-weight:800; }
  .auth-shell .messages { padding: 18px 2px 4px; display:flex; flex-direction:column; gap:10px; }
  .auth-shell .bubble { max-width: 79%; padding: 11px 13px 8px; border-radius: 15px; color: #14532d; font-size: 12px; line-height: 1.45; box-shadow: 0 2px 7px rgba(20, 83, 45, .025); }
  .auth-shell .bubble.in { align-self:flex-start; background:#f0fdf4; border-bottom-left-radius:5px; }
  .auth-shell .bubble.out { align-self:flex-end; background:#f0fdf4; border-bottom-right-radius:5px; }
  .auth-shell .bubble time { display:block; text-align:right; color:#6b7280; font-size:9px; padding-top:4px; }
  .auth-shell .typing { width: 57px; height: 28px; display:flex; align-items:center; justify-content:center; gap:4px; background:#f0fdf4; border-radius:14px; border-bottom-left-radius:5px; }
  .auth-shell .typing i { width:4px; height:4px; background:#00a651; border-radius:50%; animation: auth-typing 1.2s infinite ease-in-out; }
  .auth-shell .typing i:nth-child(2) { animation-delay:.15s; } .auth-shell .typing i:nth-child(3) { animation-delay:.3s; }
  @keyframes auth-typing { 0%, 60%, 100% { transform: translateY(0); opacity:.48; } 30% { transform: translateY(-4px); opacity:1; } }
  .auth-shell .floating-note { position:absolute; right:-12px; bottom:12px; display:flex; align-items:center; gap:9px; background:#fff; border:1px solid #f0fdf4; border-radius:15px; padding:12px 14px; box-shadow:0 12px 30px rgba(20, 83, 45, .1); transform:rotate(2deg); animation: auth-note-float 5s ease-in-out infinite; }
  @keyframes auth-note-float { 0%,100% { transform:translateY(0) rotate(2deg); } 50% { transform:translateY(-7px) rotate(1deg); } }
  .auth-shell .note-icon { width:30px;height:30px;border-radius:10px;background:#f0fdf4;display:grid;place-items:center;color:#15803d; }
  .auth-shell .note-title { font-size:11px; font-weight:750; } .auth-shell .note-caption { font-size:10px; color:#6b7280; margin-top:3px; }
  .auth-shell .story-foot { margin-top: 32px; color:#6b7280; font-size:11px; }

  .auth-shell .auth-side { min-width: 0; }
  .auth-shell .auth-card { padding: clamp(25px, 3.5vw, 42px); background: rgba(255, 255, 255, .92); border:1px solid rgba(240, 253, 244, .94); border-radius: var(--radius-xl); box-shadow: var(--shadow); backdrop-filter: blur(16px); }
  .auth-shell .mobile-brand { display:none; }
  .auth-shell .auth-intro { margin-bottom:26px; }
  .auth-shell .auth-heading { margin: 0; font-size: 29px; line-height:1.2; letter-spacing:-1.1px; font-weight:780; }
  .auth-shell .auth-subheading { margin: 10px 0 0; font-size: 13px; color:#6b7280; line-height:1.6; }
  .auth-shell .auth-switch { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:5px; margin-top:17px; color:#6b7280; font-size:12px; text-align:center; }
  .auth-shell .auth-switch p { margin:0; }
  .auth-shell .auth-switch .text-link { font-size:12px; padding:4px 2px; }
  .auth-shell .outline-join-btn { width:100%; min-height:48px; margin-top:13px; border:1px solid #dcfce7; border-radius:14px; background:#f0fdf4; color:#14532d; font-size:13px; font-weight:750; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:9px; transition:background .2s, border-color .2s, transform .2s, box-shadow .2s; }
  .auth-shell .outline-join-btn:hover { background:#f0fdf4; border-color:#dcfce7; box-shadow:0 5px 16px rgba(20, 83, 45, .07); transform:translateY(-1px); }
  .auth-shell .outline-join-btn:active { transform:scale(.99); }
  .auth-shell .outline-join-btn svg { width:17px; height:17px; }
  .auth-shell .outline-join-btn[hidden] { display:none; }
  .auth-shell .field-list { display:flex; flex-direction:column; gap:15px; }
  .auth-shell .field { position:relative; transition:opacity .22s, transform .22s; }
  .auth-shell .field[hidden] { display:none; }
  .auth-shell .field-label { display:block; margin:0 0 7px 2px; color:#374151; font-size:12px; font-weight:700; }
  .auth-shell .input-wrap { position:relative; }
  .auth-shell .field-icon { position:absolute; top:50%; left:16px; transform:translateY(-50%); width:19px; height:19px; color:#6b7280; pointer-events:none; transition:color .2s; }
  .auth-shell .field input { width:100%; height:53px; border:1px solid #f0fdf4; outline:none; border-radius:14px; padding:0 46px; background:#f0fdf4; color:#14532d; font-size:14px; transition:border-color .2s, box-shadow .2s, background .2s; }
  .auth-shell .field input::placeholder { color:#6b7280; }
  .auth-shell .field input:focus { border-color:#15803d; background:#fff; box-shadow:0 0 0 4px rgba(21, 128, 61, .11); }
  .auth-shell .input-wrap:focus-within .field-icon { color:var(--green); }
  .auth-shell .password-toggle { position:absolute; top:50%; right:10px; transform:translateY(-50%); border:0; background:transparent; color:#6b7280; width:34px; height:34px; border-radius:9px; display:grid; place-items:center; cursor:pointer; }
  .auth-shell .password-toggle:hover { color:var(--green-dark); background:#f0fdf4; }
  .auth-shell .password-toggle svg { width:18px; height:18px; }
  .auth-shell .form-meta { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:17px 1px 0; color:#6b7280; font-size:12px; }
  .auth-shell .remember { display:inline-flex; gap:8px; align-items:center; cursor:pointer; user-select:none; }
  .auth-shell .remember input { appearance:none; width:15px; height:15px; border:1px solid #dcfce7; border-radius:4px; background:white; display:grid; place-items:center; margin:0; cursor:pointer; }
  .auth-shell .remember input:checked { background:var(--green); border-color:var(--green); }
  .auth-shell .remember input:checked::after { content:"✓"; color:#fff; font-size:10px; font-weight:800; }
  .auth-shell .text-link { border:0; padding:2px 0; background:none; color:#14532d; font-size:12px; font-weight:700; cursor:pointer; text-decoration:none; }
  .auth-shell .text-link:hover { color:#14532d; text-decoration:underline; }
  .auth-shell .primary-btn { width:100%; min-height:54px; margin-top:23px; border:0; border-radius:15px; background:linear-gradient(105deg,#15803d,#14532d); color:white; font-size:14px; font-weight:780; letter-spacing:.1px; box-shadow:0 9px 20px rgba(21, 128, 61, .18), inset 0 1px 0 rgba(255, 255, 255, .22); cursor:pointer; display:flex; align-items:center; justify-content:center; gap:9px; transition:transform .2s, box-shadow .2s, filter .2s; }
  .auth-shell .primary-btn:hover { transform:translateY(-2px); filter:saturate(1.07); box-shadow:0 13px 25px rgba(21, 128, 61, .24), inset 0 1px 0 rgba(255, 255, 255, .22); }
  .auth-shell .primary-btn:active { transform:translateY(0) scale(.99); }
  .auth-shell .primary-btn svg { width:17px; height:17px; }
  .auth-shell .maker-credit { margin-top:24px; text-align:center; color:#6b7280; font-size:12px; line-height:1.6; letter-spacing:.1px; }
  .auth-shell .maker-credit strong { color:#14532d; font-weight:800; letter-spacing:.65px; }

  /* Status feedback */
  .auth-shell .toast-region { position:fixed; z-index:20; left:50%; bottom:25px; transform:translateX(-50%); width:min(440px, calc(100% - 32px)); pointer-events:none; }
  .auth-shell .toast { display:flex; align-items:flex-start; gap:10px; background:#14532d; color:#f0fdf4; border:1px solid rgba(255, 255, 255, .08); box-shadow:0 15px 45px rgba(20, 83, 45, .22); border-radius:14px; padding:14px 16px; font-size:12px; line-height:1.5; opacity:0; transform:translateY(12px); transition:opacity .24s, transform .24s; }
  .auth-shell .toast.show { opacity:1; transform:translateY(0); }
  .auth-shell .toast svg { flex:0 0 auto; width:17px;height:17px;color:#00a651; margin-top:1px; }
  .auth-shell .toast strong { display:block; font-size:12px; margin-bottom:2px; }


  @media (max-width: 930px) {
    .auth-shell .page-shell { width:min(510px, calc(100% - 38px)); grid-template-columns:1fr; gap:0; padding:26px 0 24px; align-items:start; }
    .auth-shell .story { display:none; }
    .auth-shell .auth-side { padding-top:0; }
    .auth-shell .auth-card { padding:0; border:0; background:transparent; box-shadow:none; backdrop-filter:none; }
    .auth-shell .mobile-brand { display:flex; flex-direction:column; align-items:center; text-align:center; margin:3px 0 26px; }
    .auth-shell .mobile-brand .brand-mark { width:62px;height:62px;border-radius:20px;font-size:40px; letter-spacing:-4px; }
    .auth-shell .mobile-brand .brand-mark::after { width:9px;height:9px;top:12px;right:10px; }
    .auth-shell .mobile-brand-name { margin-top:13px; font-size:25px; font-weight:790; letter-spacing:-1px; }
    .auth-shell .mobile-brand-tagline { margin-top:5px; color:#6b7280; font-size:12px; }
    .auth-shell .auth-intro { margin-bottom:23px; }
    .auth-shell .auth-heading { text-align:center; font-size:25px; }
    .auth-shell .auth-subheading { text-align:center; max-width:310px; margin:9px auto 0; }
    .auth-shell .field-list { gap:14px; }
    .auth-shell .field input { height:58px; border-radius:15px; padding-left:48px; font-size:15px; }
    .auth-shell .field-icon { left:17px; }
    .auth-shell .primary-btn { min-height:58px; border-radius:16px; font-size:15px; }
  }
  @media (max-width: 400px) {
    .auth-shell .page-shell { width:calc(100% - 30px); padding-top:22px; }
    .auth-shell .mobile-brand { margin-bottom:23px; }
    .auth-shell .mobile-brand .brand-mark { width:56px;height:56px;border-radius:18px;font-size:36px; }
    .auth-shell .mobile-brand-name { font-size:23px; }
    .auth-shell .auth-heading { font-size:23px; }
    .auth-shell .form-meta { font-size:11px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .auth-shell, .auth-shell *, .auth-shell *::before, .auth-shell *::after { animation-duration:.01ms !important; animation-iteration-count:1 !important; scroll-behavior:auto !important; transition-duration:.01ms !important; }
  }
/* Homepage-green match overrides (VibeTalk homepage system) */
.auth-shell {--green:#00A651;--green-dark:#15803D;--green-deep:#14532D;--mint:#DCFCE7;--mint-pale:#F0FDF4;--ink:#111827;--muted:#6B7280;--line:#E5E7EB;--surface:#ffffff;--bg:#FFFFFF;}
.auth-shell .brand-mark {background:none !important;box-shadow:none;overflow:hidden;padding:0;}
.auth-shell .brand-mark::after {display:none;}
.auth-shell .brand-mark img {display:block;width:100%;height:100%;object-fit:cover;}
.auth-shell h1 span {color:#00A651;}
.auth-shell .primary-btn {background:#15803D !important;box-shadow:0 9px 20px rgba(21,128,61,.18), inset 0 1px 0 rgba(255,255,255,.22);}
.auth-shell .primary-btn:hover {background:#166534 !important;}
.auth-shell .primary-btn:active {background:#14532D !important;}
.auth-shell .eyebrow {color:#15803D;border-color:#D1FAE5;}
.auth-shell .live-dot {background:#22C55E;box-shadow:0 0 0 4px #DCFCE7;}
.auth-shell .outline-join-btn {border-color:#D1FAE5;background:#F0FDF4;color:#15803D;}
.auth-shell .note-icon {background:#DCFCE7;color:#15803D;}
`;

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

export function IconMail() {
  return (
    <svg className="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}

export function IconLock() {
  return (
    <svg className="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <path d="M12 14v3" />
    </svg>
  );
}

export function IconPerson() {
  return (
    <svg className="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </svg>
  );
}

export function IconKey() {
  return (
    <svg className="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9 2 2-2 2 1.5 1.5-2.5 2.5-1.5-1.5-3 3" />
    </svg>
  );
}

export function IconEye({ off = false }: { off?: boolean }) {
  if (off) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
        <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7c1.2 0 2.3-.2 3.3-.6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconArrow() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function AuthShell({
  heading,
  subheading,
  children,
}: {
  heading: string;
  subheading: string;
  children: ReactNode;
}) {
  // Audit-2 M18: the auth pages are a fixed LIGHT design rendered
  // via their own scoped CSS (.page-shell carries the white
  // background + light color-scheme). The old effect mutated <html>
  // (.dark removal, colorScheme, body background) post-paint and
  // restored it on cleanup — a flash plus store/DOM disagreement.
  // Auth uses zero `dark:` classes, so <html> is never touched now;
  // the theme store owns it.
  return (
    <div className="auth-shell">
      <style>{AUTH_CSS}</style>
      <div className="ambient one" aria-hidden="true" />
      <div className="ambient two" aria-hidden="true" />
      <div className="ambient three" aria-hidden="true" />
      <main className="page-shell">
        <section className="story" aria-label="About VibeTalk">
          <Link to="/" className="brand" aria-label="VibeTalk home">
            <span className="brand-mark" aria-hidden="true">
              <img src="/logo-mark.png" alt="" />
            </span>
            <span>
              <span className="brand-word">VibeTalk</span>
              <span className="brand-sub">A little closer, everywhere.</span>
            </span>
          </Link>
          <div className="eyebrow">
            <span className="live-dot" /> YOUR SPACE. YOUR PEOPLE.
          </div>
          <h1>
            Good conversations
            <br />
            feel like <span>home.</span>
          </h1>
          <p className="story-copy">
            One simple place to stay connected. Pick up a conversation on Android or web,
            share a thought, and keep your people close.
          </p>
          <div className="benefits">
            <span className="benefit"><CheckIcon /> Android + web</span>
            <span className="benefit"><CheckIcon /> Simple by design</span>
            <span className="benefit"><CheckIcon /> Made for your circle</span>
          </div>
          <div className="preview-wrap" aria-label="Decorative chat preview">
            <div className="preview-glow" />
            <div className="chat-preview">
              <div className="preview-top">
                <div className="avatar">H</div>
                <div>
                  <div className="preview-person">The good ones ✨</div>
                  <div className="preview-status">
                    <span className="live-dot" style={{ width: 6, height: 6, boxShadow: "none" }} /> 4
                    people in this room
                  </div>
                </div>
                <div className="preview-actions">···</div>
              </div>
              <div className="messages">
                <div className="bubble in">
                  Anyone up for chai and a catch-up? ☕<time>4:16 PM</time>
                </div>
                <div className="bubble out">
                  Always. Give me 10 minutes 😄<time>4:16 PM&nbsp; ✓✓</time>
                </div>
                <div className="bubble in">
                  Perfect. Same room, same people 💚<time>4:17 PM</time>
                </div>
                <div className="typing" aria-label="Someone is typing">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
            <div className="floating-note">
              <span className="note-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
                </svg>
              </span>
              <span>
                <span className="note-title">Your people, in sync</span>
                <span className="note-caption" style={{ display: "block" }}>
                  Conversations that move with you
                </span>
              </span>
            </div>
          </div>
          <div className="story-foot">
            © {new Date().getFullYear()} VibeTalk · Made for meaningful moments
          </div>
        </section>

        <section className="auth-side" aria-label="Account access">
          <div className="mobile-brand">
            <span className="brand-mark" aria-hidden="true">
              <img src="/logo-mark.png" alt="" />
            </span>
            <div className="mobile-brand-name">VibeTalk</div>
            <div className="mobile-brand-tagline">Native Android &amp; web connected chat</div>
          </div>
          <div className="auth-card">
            <div className="auth-intro">
              <h2 className="auth-heading">{heading}</h2>
              <p className="auth-subheading">{subheading}</p>
            </div>
            {children}
            {/* M91: the old footer claimed agreement to Terms + a
                Privacy Policy that don't exist anywhere (no pages,
                no links) — a hollow legal claim. Dropped instead of
                inventing legal text; real Terms/Privacy pages are a
                separate task where Hamza reviews the actual text. */}
            <div className="maker-credit">
              Made with 🤍 by <strong>HAMZA CYBER</strong>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
