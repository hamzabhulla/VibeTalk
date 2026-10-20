/**
 * Mobile-only app shell — the design Hamza supplied in
 * vibetalk-chat-calls-ui.html, rebuilt with REAL data and REAL calls.
 *
 * Rendered only below the md breakpoint (useIsDesktop() === false). Desktop
 * routes are untouched: they keep the existing two-pane / rail layout.
 *
 * Views: Chats (real rooms + DMs, search, All/Rooms/Direct filters, create
 * room), People (real profiles, Message + voice call), Calls (real call
 * history from the `calls` table + call back), You (real profile, working
 * notifications / appearance / sign out).
 *
 * The prototype's in-shell mock chat screen is NOT duplicated: tapping a
 * chat opens the real conversation at /rooms/$roomId (same messages,
 * reactions, voice notes, attachments, typing as the existing app).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listRooms,
  listDms,
  getThreadPreviews,
  getUnreadCounts,
  getMyMemberships,
  pinChat,
  muteChat,
  leaveChat,
  deleteRoom,
  markRoomRead,
  listUsers,
  getOrCreateDm,
  createRoom,
  deleteOwnAttachmentFile,
  deleteCallHistory,
} from "@/lib/chat.functions";
import { ChatMenu, type ChatMenuState } from "@/components/chat-menu";
import { initialsOf } from "@/lib/initials";
import { fetchAllThreadPreviews } from "@/lib/thread-previews";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getMe, updateProfile, changePasswordWithPolicy } from "@/lib/auth.functions";
import { uploadAvatar } from "@/lib/upload";
import { useObjectUrl } from "@/lib/use-object-url";
import { changeEmail, changePassword } from "@/lib/account-security";
import { usePushHealFailure, clearPushHealFailure } from "@/lib/push-heal";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "@/lib/password-policy";
import { listCalls, getTurnStatus, type CallRecord } from "@/lib/calls";
import { useAuth } from "@/lib/auth-context";
import { useCall } from "@/components/call-overlay";
import { useTheme } from "@/hooks/use-theme";
import { SmartAvatar } from "@/components/smart-avatar";
import { PushDeviceList } from "@/components/push-device-list";
import { DeleteAccountDialog } from "@/components/delete-account-dialog";
import { isUserOnline, formatServerRelativeTime } from "@/lib/presence";
import { callPreviewText } from "@/lib/call-message";
import {
  isNotificationSupported,
  isNotificationsEnabled,
  setNotificationsEnabled,
  getNotificationPermission,
  requestNotificationPermission,
} from "@/lib/notifications";
import {
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  currentPushEndpoint,
  type PushKeys,
} from "@/lib/push-client";
import {
  savePushSubscription,
  removePushSubscription,
  checkPushEndpoint,
  checkPushSetup,
  sendTestPush,
  getVapidPublicKey,
} from "@/lib/push.functions";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

/**
 * Audit-2 M44: system-Back guard for mobile sub-views (create-room
 * form, profile editor, change password/email). These are local
 * state, not routes — without a history entry, Android/system Back
 * exits the whole page and the unsaved draft is lost. While the
 * sub-view is open, one history entry is pushed; Back pops it, and
 * the popstate handler closes the sub-view (or asks before
 * discarding a dirty form). Closing via the in-app Back drops the
 * pushed entry via history.back() in cleanup. Callbacks ride refs
 * so the effect doesn't re-push on every render. Runs in an effect,
 * so it is client-only (no SSR history access).
 */
function useSubViewBack(open: boolean, onBack: () => void, isDirty?: () => boolean) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ vibetalkSubView: true }, "");
    const onPop = () => {
      if (isDirtyRef.current?.()) {
        if (!window.confirm("Discard your changes?")) {
          // The entry is already popped — re-push so Back stays put.
          window.history.pushState({ vibetalkSubView: true }, "");
          return;
        }
      }
      onBackRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // In-app close (not via popstate): drop the pushed entry so the
      // next Back goes to the real previous page, not a phantom one.
      // Audit-3 A6-N13 (documented, by audit option (b)): if the user
      // navigates away (chat row / bottom nav) while a subview is
      // open, the router pushes its entry first, so cleanup sees the
      // NEW entry, does not go back, and the pushed subview entry
      // stays in the stack as a phantom — Back from the conversation
      // lands on it (renders the list, form closed) and a second Back
      // is needed to actually leave. The History API has no
      // arbitrary-entry removal, and an unconditional history.back()
      // here would yank the user back out of the conversation they
      // just opened — so the extra Back is the accepted behaviour.
      if ((window.history.state as { vibetalkSubView?: boolean } | null)?.vibetalkSubView) {
        window.history.back();
      }
    };
  }, [open]);
}

const MOBILE_CSS = `.vt-mobile *{box-sizing:border-box}
.vt-mobile button,.vt-mobile input{font:inherit}
.vt-mobile button{cursor:pointer;-webkit-tap-highlight-color:transparent}
.vt-mobile{position:relative;max-width:480px;width:100%;height:100dvh;min-height:0;margin:auto;background:var(--bg);overflow:hidden;display:flex;flex-direction:column;box-shadow:0 12px 60px rgba(20, 83, 45, .13)}
.vt-mobile .ambient{position:absolute;inset:0 0 auto;height:265px;pointer-events:none;background:radial-gradient(ellipse at 96% 0%,rgba(21, 128, 61, .10),transparent 48%),radial-gradient(ellipse at 0% 30%,rgba(0, 166, 81, .12),transparent 42%);z-index:0}
.vt-mobile .topbar{position:relative;z-index:1;padding:calc(15px + var(--safe-top)) 19px 13px;display:flex;align-items:center;justify-content:space-between;gap:14px;background:rgba(255, 255, 255, .86);backdrop-filter:blur(18px);border-bottom:1px solid rgba(240, 253, 244, .75)}
.vt-mobile .brandline{display:flex;align-items:center;gap:11px;min-width:0}
.vt-mobile .mini-logo{width:39px;height:39px;border-radius:14px;background:linear-gradient(145deg,#15803d,#14532d);color:white;display:grid;place-items:center;font-size:23px;font-weight:400;position:relative;box-shadow:0 5px 12px rgba(20, 83, 45, .16);flex-shrink:0}
.vt-mobile .mini-logo:after{content:"";position:absolute;width:6px;height:6px;border-radius:50%;background:#dcfce7;right:7px;top:7px}
.vt-mobile .title-wrap{min-width:0}
.vt-mobile .app-kicker{font-size:9px;letter-spacing:1.8px;color:var(--green);font-weight:800;margin-bottom:2px}
.vt-mobile .page-title{font-weight:750;letter-spacing:-.65px;font-size:24px;line-height:1.1;margin:0}
.vt-mobile .head-actions{display:flex;align-items:center;gap:8px}
.vt-mobile .icon-btn{border:0;width:42px;height:42px;border-radius:15px;background:#fff;color:#374151;display:grid;place-items:center;transition:transform .18s,background .18s,box-shadow .18s;box-shadow:0 1px 0 rgba(20, 83, 45, .04)}
.vt-mobile .icon-btn:active, .vt-mobile .nav-btn:active{transform:scale(.96)}
.vt-mobile .icon-btn.primary{color:#fff;background:linear-gradient(140deg,var(--green2),var(--green));box-shadow:0 6px 15px rgba(20, 83, 45, .20)}
.vt-mobile .icon-btn svg, .vt-mobile .nav-btn svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.vt-mobile .content{position:relative;z-index:1;flex:1;min-height:0;overflow:auto;padding:16px 17px 18px;scrollbar-width:none}
.vt-mobile .content::-webkit-scrollbar{display:none}
.vt-mobile .screen{display:none;animation:vt-fade-up .24s ease both}
.vt-mobile .screen.active{display:block}
@keyframes vt-fade-up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.vt-mobile .section-head{margin:0 1px 15px}
.vt-mobile .section-head h2{margin:0 0 5px;font-size:23px;letter-spacing:-.6px;font-weight:750}
.vt-mobile .section-head p{margin:0;color:var(--muted);font-size:13px;line-height:1.45}
.vt-mobile .search-wrap{height:47px;display:flex;align-items:center;gap:10px;border:1px solid transparent;border-radius:16px;background:#f0fdf4;padding:0 14px;color:#6b7280;margin:0 0 16px;transition:.2s}
.vt-mobile .search-wrap:focus-within{background:white;border-color:#16a34a;box-shadow:0 0 0 3px rgba(21, 128, 61, .09)}
.vt-mobile .search-wrap svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:1.8;flex-shrink:0}
.vt-mobile .search-wrap input{width:100%;border:0;outline:0;background:transparent;color:var(--ink);font-size:14px}
.vt-mobile .search-wrap input::placeholder{color:#6b7280}
.vt-mobile .filters{display:flex;gap:5px;padding:4px;background:#f0fdf4;border-radius:14px;margin-bottom:10px}
.vt-mobile .filter-btn{position:relative;flex:1;border:0;border-radius:11px;background:transparent;padding:10px 6px;color:#374151;font-size:12px;font-weight:650;transition:.18s}
.vt-mobile .filter-btn.active{background:white;color:var(--green);box-shadow:0 2px 8px rgba(20, 83, 45, .07)}
.vt-mobile .list{display:flex;flex-direction:column;gap:4px}
.vt-mobile .chat-row, .vt-mobile .person-row, .vt-mobile .call-row{display:flex;align-items:center;gap:12px;padding:12px 9px;border-radius:18px;min-height:76px;transition:background .18s;cursor:pointer}
/* Audit-3 A6-N7: a 550ms long-press on a row must not pop the native
   callout / start text selection on top of the ChatMenu (rows only —
   inputs and other selectable text keep their defaults). */
.vt-mobile .chat-row, .vt-mobile .person-row, .vt-mobile .call-row{-webkit-touch-callout:none;user-select:none}
.vt-mobile .chat-row:hover, .vt-mobile .person-row:hover, .vt-mobile .call-row:hover{background:rgba(255, 255, 255, .8)}
.vt-mobile .avatar{width:48px;height:48px;flex:0 0 48px;border-radius:17px;display:grid;place-items:center;background:linear-gradient(145deg,#f0fdf4,#f0fdf4);color:var(--green);font-size:14px;font-weight:750;position:relative;overflow:hidden}
.vt-mobile .avatar svg{width:23px;height:23px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.vt-mobile .avatar .online{position:absolute;right:0;bottom:0;width:12px;height:12px;background:#16a34a;border:2px solid #fff;border-radius:50%}
.vt-mobile .row-main{min-width:0;flex:1}
.vt-mobile .row-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}
.vt-mobile .row-name{font-size:14px;font-weight:740;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vt-mobile .row-time{font-size:10px;color:#6b7280;white-space:nowrap;flex-shrink:0}
.vt-mobile .row-preview{font-size:12px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vt-mobile .row-preview strong{color:#374151;font-weight:600}
.vt-mobile .row-meta{display:flex;align-items:center;gap:7px}
.vt-mobile .unread{background:var(--green);color:white;font-size:10px;min-width:19px;height:19px;padding:0 5px;border-radius:10px;display:grid;place-items:center;font-weight:700}
.vt-mobile .person-row{padding:10px;background:rgba(255, 255, 255, .83);border:1px solid rgba(240, 253, 244, .85);margin-bottom:8px;min-height:74px;box-shadow:0 2px 7px rgba(20, 83, 45, .025)}
.vt-mobile .person-row .avatar{width:46px;height:46px;flex-basis:46px;border-radius:15px}
.vt-mobile .presence{font-size:11px;color:#6b7280;margin-top:4px}
.vt-mobile .row-buttons{display:flex;align-items:center;gap:7px}
.vt-mobile .small-pill{height:37px;padding:0 12px;border:0;background:#f0fdf4;color:var(--green);border-radius:12px;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:750}
.vt-mobile .small-pill svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.8}
.vt-mobile .small-pill.call{width:37px;padding:0;justify-content:center;background:var(--green);color:white;box-shadow:0 4px 10px rgba(20, 83, 45, .16)}
.vt-mobile .calls-tabs{display:flex;align-items:center;justify-content:space-between;margin:2px 2px 10px}
.vt-mobile .calls-tabs .filters{margin:0;width:68%;}
.vt-mobile .text-action{border:0;background:transparent;color:var(--green);font-size:12px;font-weight:700;padding:9px 4px}
.vt-mobile .call-row{padding:11px 8px;min-height:72px}
.vt-mobile .call-type{display:flex;align-items:center;gap:4px;font-size:11px;color:#6b7280;margin-top:5px}
.vt-mobile .call-type svg{width:14px;height:14px;stroke:var(--green);fill:none;stroke-width:2}
.vt-mobile .call-type.missed, .vt-mobile .call-type.missed svg{color:#d45d5d;stroke:#d45d5d}
.vt-mobile .call-back{width:38px;height:38px;border-radius:14px;border:1px solid #f0fdf4;background:white;color:var(--green);display:grid;place-items:center}
.vt-mobile .call-back svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.9}
.vt-mobile .empty-state{padding:48px 20px;text-align:center;color:#6b7280}
.vt-mobile .empty-icon{width:60px;height:60px;border-radius:22px;display:grid;place-items:center;background:#f0fdf4;color:var(--green);margin:0 auto 14px}
.vt-mobile .empty-icon svg{width:27px;height:27px;stroke:currentColor;fill:none;stroke-width:1.7}
.vt-mobile .empty-state h3{font-size:16px;color:var(--ink);margin:0 0 6px}
.vt-mobile .empty-state p{font-size:12px;line-height:1.5;margin:0}
.vt-mobile .bottom-nav{position:relative;z-index:3;display:grid;grid-template-columns:repeat(4,1fr);padding:9px 10px calc(7px + var(--safe-bottom));background:rgba(255, 255, 255, .94);backdrop-filter:blur(20px);border-top:1px solid #f0fdf4}
.vt-mobile .nav-btn{border:0;background:transparent;color:#6b7280;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:3px;font-size:10px;font-weight:650;padding:2px 2px 1px;min-height:42px;transition:color .18s,transform .18s}
.vt-mobile .nav-btn svg{width:21px;height:21px}
.vt-mobile .nav-btn.active{color:var(--green)}
.vt-mobile .nav-btn.active svg{filter:drop-shadow(0 2px 3px rgba(20, 83, 45, .12))}
.vt-mobile .nav-dot{height:3px;width:3px;border-radius:50%;background:transparent}
.vt-mobile .nav-btn.active .nav-dot{background:#15803d}
.vt-mobile .profile-card{border-radius:23px;padding:22px;background:linear-gradient(145deg,#fff,#f0fdf4);border:1px solid #f0fdf4;box-shadow:var(--shadow);text-align:center;margin-bottom:17px}
.vt-mobile .profile-avatar{width:76px;height:76px;border-radius:26px;display:grid;place-items:center;background:linear-gradient(145deg,#15803d,#14532d);color:#fff;font-size:29px;margin:0 auto 13px;box-shadow:0 7px 16px rgba(20, 83, 45, .18)}
.vt-mobile .profile-card h3{font-size:19px;margin:0 0 5px}
/* Audit-3 A6-N8: unbroken long strings (40-char name / 160-char bio
   are legitimate) must wrap instead of overflowing the card. */
.vt-mobile .profile-card h3, .vt-mobile .profile-card p, .vt-mobile .section-head h2{overflow-wrap:anywhere}
.vt-mobile .profile-card p{margin:0;color:var(--muted);font-size:12px}
.vt-mobile .settings-list{background:white;border:1px solid var(--line);border-radius:18px;padding:2px 13px}
.vt-mobile .setting-row{display:flex;align-items:center;gap:12px;padding:14px 2px;border-bottom:1px solid #f0fdf4;color:#15803d;font-size:13px}
.vt-mobile .setting-row:last-child{border-bottom:0}
.vt-mobile .setting-icon{width:35px;height:35px;border-radius:12px;background:#f0fdf4;color:var(--green);display:grid;place-items:center}
.vt-mobile .setting-icon svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8}
.vt-mobile .setting-row span:nth-child(2){flex:1}
.vt-mobile .setting-row .arr{color:#6B7280}
@media(max-width:360px){.vt-mobile .content{padding-left:12px;padding-right:12px}
.vt-mobile .topbar{padding-left:14px;padding-right:14px}
.vt-mobile .page-title{font-size:22px}
.vt-mobile .chat-row{gap:10px;padding-left:6px;padding-right:6px}
.vt-mobile .row-buttons{gap:5px}
.vt-mobile .small-pill{padding:0 9px}
.vt-mobile .small-pill.call{width:35px}}
@media(prefers-reduced-motion:reduce){.vt-mobile *, .vt-mobile *:before, .vt-mobile *:after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
.vt-mobile{--green:#00A651;--green2:#16A34A;--green-dark:#14532D;--mint:#DCFCE7;--mint2:#F0FDF4;--ink:#172B25;--muted:#788A83;--line:#E6EEE9;--surface:#ffffff;--bg:#F7FAF8;--safe-top:env(safe-area-inset-top,0px);--safe-bottom:env(safe-area-inset-bottom,0px);color:#172B25;}
.vt-mobile .mini-logo{background:none !important;box-shadow:none;overflow:hidden;padding:0;}
.vt-mobile .mini-logo:after{display:none;}
.vt-mobile .mini-logo img{width:100%;height:100%;object-fit:cover;display:block;}
.vt-mobile .icon-btn.primary{background:linear-gradient(140deg,#16A34A,#15803D) !important;}
/* Dark mode: NO new design — the light design itself, converted.
   invert() flips light->dark, hue-rotate(180deg) keeps the greens green.
   Photos/videos get counter-inverted so avatars don't turn into negatives. */
.dark .vt-mobile{filter:invert(1) hue-rotate(180deg)}
.dark .vt-mobile img,.dark .vt-mobile video{filter:invert(1) hue-rotate(180deg)}
/* M82: Radix Dialogs + Sonner toasts + the call sheet portal to (or
   render outside) .vt-mobile, so they escaped the filter and rendered
   the global .dark palette while the app showed the inverted-light
   look. Same conversion, no new palette: reset their vars to the
   LIGHT values (verbatim from styles.css :root) and invert, so the
   filter converts light->dark exactly like the app. The dialog
   backdrop stays un-inverted (already a dark dim). The call overlay
   itself is role="dialog" too — excluded here, it gets its own rules
   below (its backdrop + screen-off layer must stay dark/black). */
/* Audit-2 L64 (documented, NOT a bug): these two rules are
   intentionally GLOBAL (not scoped under .vt-mobile) — Radix dialogs
   and Sonner toasts render in portals OUTSIDE .vt-mobile, so a
   .vt-mobile-scoped selector would never match them and they would
   render the raw .dark palette. Do NOT scope these rules. */
.dark [role="dialog"]:not(.vt-call-overlay),.dark section[aria-label^="Notifications"]{--background:#eaf0ec;--foreground:#14231c;--card:#ffffff;--card-foreground:#14231c;--popover:#ffffff;--popover-foreground:#14231c;--primary:#176b4a;--primary-foreground:#ffffff;--secondary:#f1f5f2;--secondary-foreground:#14231c;--muted:#eef2ef;--muted-foreground:#66756d;--accent:#d9eee4;--accent-foreground:#0e563a;--destructive:#ca4b55;--destructive-foreground:#ffffff;--border:#dce5df;--input:#dce5df;--ring:#176b4a;filter:invert(1) hue-rotate(180deg)}
.dark [role="dialog"]:not(.vt-call-overlay) img,.dark [role="dialog"]:not(.vt-call-overlay) video,.dark section[aria-label^="Notifications"] img,.dark section[aria-label^="Notifications"] video{filter:invert(1) hue-rotate(180deg)}
/* Audit-2 M45: the portaled chat menu (see chat-menu.tsx) — same
   treatment as the M82 dialogs: light vars + invert, so it converts
   like the app instead of rendering the global .dark palette. The
   vt-chat-menu class is only added by the mobile shell, so desktop's
   native dark palette is untouched. */
.dark .vt-chat-menu{--background:#eaf0ec;--foreground:#14231c;--card:#ffffff;--card-foreground:#14231c;--popover:#ffffff;--popover-foreground:#14231c;--primary:#176b4a;--primary-foreground:#ffffff;--secondary:#f1f5f2;--secondary-foreground:#14231c;--muted:#eef2ef;--muted-foreground:#66756d;--accent:#d9eee4;--accent-foreground:#0e563a;--destructive:#ca4b55;--destructive-foreground:#ffffff;--border:#dce5df;--input:#dce5df;--ring:#176b4a;filter:invert(1) hue-rotate(180deg)}
/* Audit-3 A6-N1: the call-sheet dark treatment moved to OVERLAY_CSS
   in call-overlay.tsx (mounted by CallProvider on every page, M82) —
   do not re-add a copy here; MOBILE_CSS only mounts inside
   <MobileShell>, so a copy here left conversation pages white. */
/* Profile information editor */
.vt-mobile .back-row{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.vt-mobile .back-row button{border:0;background:transparent;color:var(--green);font-weight:750;font-size:14px;display:flex;align-items:center;gap:6px;padding:6px 0}
.vt-mobile .edit-avatar{width:88px;height:88px;border-radius:28px;margin:4px auto 16px;position:relative;overflow:hidden;display:grid;place-items:center;background:linear-gradient(145deg,#15803d,#14532d);color:#fff;font-size:32px}
.vt-mobile .edit-avatar .change{position:absolute;right:0;bottom:0;left:0;padding:5px 0 4px;background:rgba(0,0,0,.45);color:#fff;font-size:10px;font-weight:700;text-align:center}
.vt-mobile .field{margin-bottom:12px}
.vt-mobile .field label{display:block;font-size:11px;font-weight:750;letter-spacing:.4px;color:var(--muted);margin:0 2px 6px;text-transform:uppercase}
.vt-mobile .field input,.vt-mobile .field textarea{width:100%;border:1px solid var(--line);border-radius:14px;background:#fff;padding:12px 13px;font-size:14px;color:var(--ink);outline:none;font:inherit}
.vt-mobile .field input:focus,.vt-mobile .field textarea:focus{border-color:var(--green)}
.vt-mobile .field textarea{resize:vertical;min-height:64px}
.vt-mobile .privacy-head{margin:18px 2px 8px;font-size:11px;font-weight:750;letter-spacing:.4px;color:var(--muted);text-transform:uppercase}
.vt-mobile .privacy-note{margin:0 2px 10px;font-size:12px;color:var(--muted);line-height:1.5}
.vt-mobile .privacy-row{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:12px 13px;margin-bottom:8px}
.vt-mobile .privacy-row .p-main{flex:1;min-width:0}
.vt-mobile .privacy-row .p-title{font-size:14px;font-weight:700}
.vt-mobile .privacy-row .p-sub{font-size:11px;color:var(--muted);margin-top:1px}
.vt-mobile .mini-switch{width:46px;height:27px;border-radius:999px;border:0;background:#D1D5DB;position:relative;flex-shrink:0;transition:background .18s;padding:0}
.vt-mobile .mini-switch:after{content:"";position:absolute;top:3px;left:3px;width:21px;height:21px;border-radius:50%;background:#fff;transition:left .18s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.vt-mobile .mini-switch.on{background:var(--green2)}
.vt-mobile .mini-switch.on:after{left:22px}
.vt-mobile .save-btn{width:100%;border:0;border-radius:16px;padding:14px;background:linear-gradient(140deg,#16A34A,#15803D);color:#fff;font-size:15px;font-weight:750;margin-top:16px}
.vt-mobile .save-btn:disabled{opacity:.6}
`;

export type MobileView = "chats" | "people" | "calls" | "you";

const TITLES: Record<MobileView, string> = {
  chats: "Messages",
  people: "People",
  calls: "Calls",
  you: "You",
};

const NAV: { view: MobileView; to: string; label: string; icon: string }[] = [
  { view: "chats", to: "/rooms", label: "Chats", icon: "chat" },
  { view: "people", to: "/people", label: "People", icon: "people" },
  { view: "calls", to: "/calls", label: "Calls", icon: "phone" },
  { view: "you", to: "/profile", label: "You", icon: "user" },
];

function Icon({ name }: { name: string }) {
  return (
    <svg aria-hidden="true">
      <use href={`#vt-i-${name}`} />
    </svg>
  );
}

/** The prototype's SVG symbol set, ids namespaced so they can't collide. */
export function MobileIcons() {
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", overflow: "hidden" }}>
      <symbol id="vt-i-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7.2" /><path d="m16.5 16.5 4 4" /></symbol>
      <symbol id="vt-i-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></symbol>
      <symbol id="vt-i-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11.5a7.7 7.7 0 0 1-8 7.5 8.8 8.8 0 0 1-3.6-.8L4 20l1.2-3.4A7.3 7.3 0 0 1 4 12c0-4.1 3.6-7.5 8-7.5s8 3.1 8 7Z" /></symbol>
      <symbol id="vt-i-people" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20" /><circle cx="9.5" cy="7.5" r="3.5" /><path d="M17 4.5a3.5 3.5 0 0 1 0 6.8M21 20v-1.5a4 4 0 0 0-3-3.9" /></symbol>
      <symbol id="vt-i-user" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="7.5" r="3.6" /><path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2" /></symbol>
      <symbol id="vt-i-phone" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7.2 3.5 10 7.8 8.3 10a15 15 0 0 0 5.7 5.7l2.2-1.7 4.3 2.8-.8 3.4a2 2 0 0 1-2.1 1.5C9.2 20.9 3.1 14.8 2.3 6.4a2 2 0 0 1 1.5-2.1Z" /></symbol>
      <symbol id="vt-i-video" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="13" height="12" rx="3" /><path d="m16 10 5-3v10l-5-3" /></symbol>
      <symbol id="vt-i-call-in" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3.5 10 8l-2 2a15 15 0 0 0 6 6l2-2 4.5 3-.8 3.3a2 2 0 0 1-2.1 1.5C9 20.8 3.2 15 2.2 6.4a2 2 0 0 1 1.5-2.1Z" /><path d="M14 4h6v6M20 4l-6 6" /></symbol>
      <symbol id="vt-i-call-out" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3.5 10 8l-2 2a15 15 0 0 0 6 6l2-2 4.5 3-.8 3.3a2 2 0 0 1-2.1 1.5C9 20.8 3.2 15 2.2 6.4a2 2 0 0 1 1.5-2.1Z" /><path d="M14 4h6v6M20 4l-6 6" /></symbol>
      <symbol id="vt-i-missed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 16.5a14.5 14.5 0 0 1 18 0M8 16.5l4 4 4-4M12 20.5V13" /></symbol>
      <symbol id="vt-i-bell" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></symbol>
      <symbol id="vt-i-logout" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 17l5-5-5-5M15 12H3M14 3h4a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-4" /></symbol>
      <symbol id="vt-i-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></symbol>
      {/* Audit-3 A6-N9: distinct You-row icons (sun/moon/eye/key/mail). */}
      <symbol id="vt-i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M6.7 17.3l-1.8 1.8M19.1 4.9l-1.8 1.8" /></symbol>
      <symbol id="vt-i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13.5A8.5 8.5 0 1 1 10.5 4 7 7 0 0 0 20 13.5Z" /></symbol>
      <symbol id="vt-i-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></symbol>
      <symbol id="vt-i-key" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4.5" /><path d="m11.2 11.8 8.3-8.3" /><path d="m16.5 6.5 2.5 2.5" /><path d="m18.5 4.5 2.5 2.5" /></symbol>
      <symbol id="vt-i-mail" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></symbol>
    </svg>
  );
}

export function MobileShell({ view, children }: { view: MobileView; children: ReactNode }) {
  const navigate = useNavigate();
  const action =
    view === "chats"
      ? { label: "New chat", icon: "plus", onClick: () => navigate({ to: "/people" }) }
      : null;
  // M77: the People "Invite person" button was a no-op placeholder —
  // it navigated to /people, the page it was already on. There is no
  // in-app invite/token flow to wire it to (tokens are created
  // manually, outside the app), so the button is removed rather
  // than left promising an invite it can't deliver.
  return (
    <div className="vt-mobile">
      <style>{MOBILE_CSS}</style>
      <MobileIcons />
      <div className="ambient" />
      <header className="topbar">
        <div className="brandline">
          <div className="mini-logo">
            <img src="/logo-mark.png" alt="" />
          </div>
          <div className="title-wrap">
            <div className="app-kicker">VIBETALK</div>
            <h1 className="page-title">{TITLES[view]}</h1>
          </div>
        </div>
        <div className="head-actions">
          {action && (
            <button
              type="button"
              className="icon-btn primary"
              aria-label={action.label}
              title={action.label}
              onClick={action.onClick}
            >
              <Icon name={action.icon} />
            </button>
          )}
        </div>
      </header>
      <main className="content">
        <section className="screen active">{children}</section>
      </main>
      <nav className="bottom-nav" aria-label="Main navigation">
        {NAV.map((item) => (
          <Link
            key={item.view}
            to={item.to}
            className={`nav-btn${view === item.view ? " active" : ""}`}
            aria-current={view === item.view ? "page" : undefined}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            <i className="nav-dot" />
          </Link>
        ))}
      </nav>
    </div>
  );
}

function threadTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  // Audit-4 L57: a malformed non-empty string -> Invalid Date,
  // and every `>=` below is false for it, so it fell through to
  // toLocaleDateString on Invalid Date -> the literal text
  // "Invalid Date" in the row. Return "" like the empty case.
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  const startOfWeek = new Date(startOfToday.getTime() - 6 * 86_400_000);
  if (d >= startOfToday) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d >= startOfYesterday) return "Yesterday";
  if (d >= startOfWeek) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Audit-7 D2 (extended): initials come from the shared
// letters-only initialsOf (@/lib/initials) — the local copy here
// had the same "H(" bug as call-overlay's. (Audit-7's D2 listed
// profile-dialog + call-overlay; this copy and the MobileYou
// inline copy below were found during the fix and unified too.)

/* ---------------------------------- Chats ---------------------------------- */

import { useChatListFilter, setChatListFilter, setChatListSearch, type ChatListFilter } from "@/lib/chat-list-filter";

export function MobileChats() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const list = useServerFn(listRooms);
  const dms = useServerFn(listDms);
  const previews = useServerFn(getThreadPreviews);
  const unreadFn = useServerFn(getUnreadCounts);
  const create = useServerFn(createRoom);
  const membershipsFn = useServerFn(getMyMemberships);
  const doPin = useServerFn(pinChat);
  const doMute = useServerFn(muteChat);
  const doMarkRead = useServerFn(markRoomRead);
  const doLeave = useServerFn(leaveChat);
  const doDeleteRoom = useServerFn(deleteRoom);
  const navigate = useNavigate();
  // Audit-2 M16: search + filter live in the shared chat-list store,
  // not local state — the desktop list (InboxPane) is a different
  // component, and a 768px resize swaps one for the other. Local
  // state would reset; the store survives the swap.
  const { search, filter } = useChatListFilter();
  const [showCreate, setShowCreate] = useState(false);
  const [roomName, setRoomName] = useState("");
  // M97: description field (desktop parity — was missing on mobile).
  const [roomDesc, setRoomDesc] = useState("");
  // Groups are private by default (same as desktop): only added members see them.
  const [isPrivate, setIsPrivate] = useState(true);
  const [isE2EE, setIsE2EE] = useState(false);
  const [creating, setCreating] = useState(false);
  // Audit-2 M28: ref guard for submitRoom (see inbox-pane submit).
  const creatingRef = useRef(false);

  // Audit-2 M41: rooms/dms errors used to render as "No conversations
  // found" — a failed fetch looked exactly like zero chats. Errors
  // now surface (warn + the error state below) instead of
  // masquerading as empty. ANY failure wins over a partial list:
  // a half-loaded inbox could hide the very chat being looked for.
  const {
    data: roomPages,
    isLoading,
    isError: roomsError,
    refetch: refetchRooms,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["rooms"],
    queryFn: ({ pageParam }) =>
      // Audit-4 L59: paginate — the old bare list() showed only the
      // first 200 rooms; rooms 201+ never appeared (no "load more",
      // unlike MobileCalls pagination). Same useInfiniteQuery +
      // Load-more pattern as desktop InboxPane (M5).
      (pageParam ? list({ data: { cursor: pageParam } }) : list())
        .catch((err) => {
          console.warn("[chats] rooms failed:", err);
          throw err;
        }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  // Flatten pages — the threads memo below merges + sorts rooms
  // with DMs, so later pages slot into the same (pinned,
  // last-activity) order instead of appending out of order.
  const rooms = useMemo(
    () => roomPages?.pages.flatMap((p) => p.rooms) ?? [],
    [roomPages],
  );
  const {
    data: dmList,
    isError: dmError,
    refetch: refetchDms,
  } = useQuery({
    queryKey: ["dms"],
    queryFn: () =>
      dms().catch((err) => {
        console.warn("[chats] dms failed:", err);
        throw err;
      }),
  });
  // M79: no more fail-silent [] — a failed unread/preview load used to
  // look exactly like "no messages". Errors now surface (warn + retry
  // banner below) instead of masquerading as empty.
  const {
    data: unreadRows,
    isError: unreadError,
    refetch: refetchUnread,
  } = useQuery({
    queryKey: ["unread-counts"],
    queryFn: () =>
      unreadFn().catch((err) => {
        console.warn("[chats] unread counts failed:", err);
        throw err;
      }),
  });

  const allIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rooms ?? []) ids.add(r.id);
    for (const d of dmList ?? []) ids.add(d.id);
    return Array.from(ids);
  }, [rooms, dmList]);

  const {
    data: previewList,
    isError: previewError,
    refetch: refetchPreviews,
  } = useQuery({
    // Audit-3 A1-L42: never sort the memoized array in place.
    queryKey: ["thread-previews", [...allIds].sort().join(",")],
    enabled: allIds.length > 0,
    queryFn: () =>
      fetchAllThreadPreviews((ids) => previews({ data: { roomIds: ids } }), allIds).catch((err) => {
        console.warn("[chats] thread previews failed:", err);
        throw err;
      }),
  });

  // H19: realtime subscription (desktop InboxPane's "rooms-list" channel,
  // mirrored here as "mobile-rooms-list"). Without it the mobile inbox
  // went stale — a new message / room / DM only appeared after a
  // remount or navigation. Same invalidation set as desktop.
  // Audit-2 M55: track the channel's liveness (room view's rtLive
  // pattern) — a failed subscribe used to fail silently.
  const [chatsLive, setChatsLive] = useState(false);
  const chatsDisconnectedRef = useRef(false);
  useEffect(() => {
    // M35: profiles invalidation throttled (see desktop InboxPane) —
    // presence heartbeats arrive for every user every 25s.
    let alive = true;
    let lastProfilesInvalidate = 0;
    // Audit-2 M30: same coalescing as desktop InboxPane — a burst
    // of N messages used to fire 4 invalidations per message.
    // Leading + trailing throttle at 500ms over the union of
    // dirtied keys. (Profiles keeps its own 15s throttle.)
    const listDirty = new Set<string>();
    let listTimer: number | null = null;
    const flushListDirty = () => {
      for (const key of listDirty) qc.invalidateQueries({ queryKey: [key] });
      listDirty.clear();
    };
    const armListWindow = () => {
      listTimer = window.setTimeout(() => {
        listTimer = null;
        if (listDirty.size > 0) {
          flushListDirty();
          armListWindow();
        }
      }, 500);
    };
    const scheduleListKeys = (...keys: string[]) => {
      for (const k of keys) listDirty.add(k);
      if (listTimer !== null) return;
      flushListDirty();
      armListWindow();
    };
    const ch = supabase
      .channel("mobile-rooms-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms" }, () => {
        scheduleListKeys("rooms", "dms");
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {
        scheduleListKeys("thread-previews", "rooms", "dms", "unread-counts");
      })
      // M44: same gap as desktop InboxPane — pin/mute (room_members)
      // and mark-as-read (read_receipts) from another browser/device.
      // Audit-2 M22: a removed room must vanish / a newly-added room
      // must appear in the list without a refresh.
      .on("postgres_changes", { event: "*", schema: "public", table: "room_members" }, () => {
        scheduleListKeys("my-memberships", "rooms", "dms");
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "read_receipts" }, () => {
        scheduleListKeys("unread-counts");
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "presence" }, () => {
        // Audit-6 B-D1: this binding watched public.profiles — dead
        // since §C3 made profiles own-row-only (postgres_changes
        // honours RLS, so another user's row can never arrive).
        // Presence lives in the presence table now (LOW-13), whose
        // read policy delivers visible users' rows. M35 throttle
        // kept: presence ticks ~25s per online user; the 120s
        // staleness window makes a 15s throttle lossless for
        // display (≤4 refetches/minute).
        const now = Date.now();
        if (now - lastProfilesInvalidate < 15_000) return;
        lastProfilesInvalidate = now;
        qc.invalidateQueries({ queryKey: ["dms"] });
      })
      // Audit-2 M55: status callback (was a bare .subscribe()). On
      // re-SUBSCRIBED after a disconnect, refresh the whole list —
      // events were missed while the socket was down.
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") {
          setChatsLive(true);
          if (chatsDisconnectedRef.current) {
            chatsDisconnectedRef.current = false;
            scheduleListKeys("rooms", "dms", "my-memberships", "thread-previews", "unread-counts");
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          chatsDisconnectedRef.current = true;
          setChatsLive(false);
          console.warn("[mobile-chats] realtime channel lost:", status);
        }
      });
    return () => {
      alive = false;
      if (listTimer !== null) window.clearTimeout(listTimer);
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const unreadMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of unreadRows ?? []) m.set(r.room_id, Number(r.unread_count) || 0);
    return m;
  }, [unreadRows]);
  const previewMap = useMemo(
    () => new Map((previewList ?? []).map((p) => [p.room_id, p])),
    [previewList],
  );

  // H20: per-chat pin/mute state + WhatsApp-style chat menu (long-press),
  // ported from desktop InboxPane. Mobile previously had no pin / mute /
  // mark-read / delete / leave at all.
  // Audit-2 M47: memberships errors used to render as "nothing pinned
  // or muted" — indicators vanished and the menu offered to re-pin an
  // already-pinned chat. The error is now surfaced (banner + menu
  // guard) instead of masquerading as empty.
  const {
    data: memberships,
    isError: membershipsError,
    refetch: refetchMemberships,
  } = useQuery({
    queryKey: ["my-memberships"],
    queryFn: () =>
      membershipsFn().catch((err) => {
        console.warn("[chats] memberships failed:", err);
        throw err;
      }),
  });
  const memberMap = useMemo(() => {
    const m = new Map<string, { pinned: boolean; muted: boolean }>();
    for (const r of memberships ?? [])
      m.set(r.room_id, { pinned: !!r.pinned_at, muted: !!r.is_muted });
    return m;
  }, [memberships]);

  const [chatMenu, setChatMenu] = useState<ChatMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    chatId: string;
    kind: "room" | "direct";
    name: string;
    canDeleteRoom: boolean;
  } | null>(null);
  const lpTimer = useRef<number | null>(null);
  // After a long-press opens the menu, the browser still fires a click on
  // the row when the finger lifts — suppress it so we don't navigate away
  // and unmount the menu. Scoped to the long-pressed row id so taps on
  // OTHER rows still navigate.
  const suppressClickFor = useRef<string | null>(null);
  // Only cancel the long-press on a REAL scroll (12px+), not finger jitter.
  const touchPos = useRef<{ x: number; y: number } | null>(null);
  useEffect(
    () => () => {
      if (lpTimer.current) window.clearTimeout(lpTimer.current);
    },
    [],
  );
  const openChatMenu = (
    t: { id: string; kind: "room" | "direct"; name: string; createdBy?: string | null },
    x: number,
    y: number,
  ) => {
    const mm = memberMap.get(t.id);
    setChatMenu({
      chatId: t.id,
      kind: t.kind,
      name: t.name,
      x,
      y,
      pinned: !!mm?.pinned,
      muted: !!mm?.muted,
      // Audit-2 M47: on a memberships failure the pin/mute state is
      // UNKNOWN, not false — the menu disables those items + retries.
      pinMuteUnknown: membershipsError,
      // Only the room creator can delete a room — there are no admins.
      canDeleteRoom: t.kind === "room" && t.createdBy === user?.id,
    });
  };
  const cancelLongPress = () => {
    if (lpTimer.current) window.clearTimeout(lpTimer.current);
  };
  const refreshChats = () => {
    qc.invalidateQueries({ queryKey: ["rooms"] });
    qc.invalidateQueries({ queryKey: ["dms"] });
    qc.invalidateQueries({ queryKey: ["my-memberships"] });
  };
  // Audit-3 A4-N27: per-chat in-flight guard for pin / mute /
  // mark-read. Rapid double-clicks used to fire duplicate calls
  // (server-side idempotent, but double toasts + wasted round-trips).
  const chatActionInFlightRef = useRef(new Set<string>());
  const onPinChat = async (chatId: string, pinned: boolean) => {
    const key = `pin:${chatId}`;
    if (chatActionInFlightRef.current.has(key)) return;
    chatActionInFlightRef.current.add(key);
    try {
      await doPin({ data: { roomId: chatId, pinned } });
      toast.success(pinned ? "Chat pinned" : "Chat unpinned");
      refreshChats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      chatActionInFlightRef.current.delete(key);
    }
  };
  const onMuteChat = async (chatId: string, muted: boolean) => {
    const key = `mute:${chatId}`;
    if (chatActionInFlightRef.current.has(key)) return;
    chatActionInFlightRef.current.add(key);
    try {
      await doMute({ data: { roomId: chatId, muted } });
      toast.success(muted ? "Notifications muted" : "Notifications unmuted");
      refreshChats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      chatActionInFlightRef.current.delete(key);
    }
  };
  const onMarkChatRead = async (chatId: string) => {
    const key = `read:${chatId}`;
    if (chatActionInFlightRef.current.has(key)) return;
    chatActionInFlightRef.current.add(key);
    try {
      await doMarkRead({ data: { roomId: chatId } });
      qc.invalidateQueries({ queryKey: ["unread-counts"] });
      toast.success("Marked as read");
    } catch (err) {
      // M79: was silently swallowed — the user saw neither an error
      // nor the success toast, so "Mark as read" looked like a no-op.
      console.warn("[chats] mark as read failed:", err);
      toast.error("Couldn't mark as read");
    } finally {
      chatActionInFlightRef.current.delete(key);
    }
  };
  // Audit-2 L31: double-submit guard. `deleting` disables the
  // buttons (visual); `deletingRef` is the airtight guard — state
  // updates are async, so a second click in the same tick could
  // otherwise slip through before the re-render lands.
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const onConfirmDelete = async () => {
    if (!confirmDelete || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    const { chatId, kind, canDeleteRoom } = confirmDelete;
    try {
      if (kind === "direct" || !canDeleteRoom) {
        await doLeave({ data: { roomId: chatId } });
        toast.success(kind === "direct" ? "Chat deleted" : "Left the group");
      } else {
        await doDeleteRoom({ data: { roomId: chatId } });
        toast.success("Room deleted");
      }
      refreshChats();
      // M45: previews/unread also refresh (same as desktop). No
      // navigate-away needed here — the Chats list only shows when
      // no room is open, so the open-room case can't occur.
      qc.invalidateQueries({ queryKey: ["thread-previews"] });
      qc.invalidateQueries({ queryKey: ["unread-counts"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  const threads = useMemo(() => {
    const list: {
      id: string;
      kind: "room" | "direct";
      name: string;
      isE2EE: boolean;
      isPrivate: boolean;
      createdBy: string | null;
      partnerId?: string;
      // M96: desktop fallback fields (room description / DM last seen).
      description?: string | null;
      partnerLastSeen?: string | null;
      lastActivity: string | null;
      pinned: boolean;
      muted: boolean;
    }[] = [];
    for (const r of rooms ?? []) {
      const mm = memberMap.get(r.id);
      list.push({
        id: r.id,
        kind: "room",
        name: r.name,
        isE2EE: !!(r as { is_e2ee?: boolean }).is_e2ee,
        isPrivate: !!(r as { is_private?: boolean }).is_private,
        createdBy: (r as { created_by?: string | null }).created_by ?? null,
        description: (r as { description?: string | null }).description ?? null,
        lastActivity: r.last_activity_at,
        pinned: !!mm?.pinned,
        muted: !!mm?.muted,
      });
    }
    for (const d of dmList ?? []) {
      const mm = memberMap.get(d.id);
      list.push({
        id: d.id,
        kind: "direct",
        name: d.partner?.display_name ?? "Direct message",
        // Audit-2 L36: same as desktop inbox — read the flag from
        // the DM row instead of hardcoding false.
        isE2EE: !!(d as { is_e2ee?: boolean }).is_e2ee,
        isPrivate: false,
        createdBy: null,
        partnerId: d.partner?.id,
        partnerLastSeen: d.partner?.last_seen_at ?? null,
        lastActivity: d.last_activity_at,
        pinned: !!mm?.pinned,
        muted: !!mm?.muted,
      });
    }
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
    });
    return list;
  }, [rooms, dmList, memberMap]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return threads.filter((t) => {
      const okFilter =
        filter === "all" || (filter === "rooms" ? t.kind === "room" : t.kind === "direct");
      // Audit-3 A4-N26: name-only, like desktop — the preview body
      // (raw E2E1: ciphertext in E2EE rooms) must not be searchable.
      const hay = t.name.toLowerCase();
      return okFilter && (!q || hay.includes(q));
    });
  }, [threads, filter, search]);

  // M81: reset to defaults on success AND cancel — an E2EE room
  // created once used to leave E2EE checked for the next room,
  // silently encrypting a room the user didn't ask to encrypt.
  const closeCreateForm = () => {
    setShowCreate(false);
    setRoomName("");
    // M97: description resets with the form (M81 pattern).
    setRoomDesc("");
    setIsPrivate(true);
    setIsE2EE(false);
  };

  // Audit-2 M44: system Back closes the create form instead of
  // exiting the page; a typed name/description asks first.
  useSubViewBack(
    showCreate,
    closeCreateForm,
    () => roomName.trim() !== "" || roomDesc.trim() !== "",
  );

  const submitRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = roomName.trim();
    if (!name) return;
    // Audit-2 M28: ref guard — same double-submit race as the desktop
    // create form (state flips async; fast double-Enter → two rooms).
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      // M97: description passed (server zod: optional, max 280).
      // Empty → undefined → server stores null (not "").
      const room = await create({
        data: { name, description: roomDesc.trim() || undefined, isPrivate, isE2EE },
      });
      setRoomName("");
      closeCreateForm();
      // Audit-2 L63: desktop's toast tells the user where to add
      // members; mobile's bare "Room created" left a private room
      // with only its creator and no hint.
      toast.success(
        isPrivate ? "Private room created — add members from the room menu" : "Room created",
      );
      navigate({ to: "/rooms/$roomId", params: { roomId: room.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create room");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <>
      {/* Audit-2 M55: visible when the chats realtime channel is down. */}
      {!chatsLive && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
          style={{ margin: "0 4px 6px" }}
          title="Live updates disconnected — new messages may need a refresh"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          Reconnecting…
        </span>
      )}
      <label className="search-wrap">
        <Icon name="search" />
        <input
          type="search"
          // M85: was "Search chats and people" — this matches chats
          // (+ preview bodies), never people.
          placeholder="Search chats"
          autoComplete="off"
          aria-label="Search chats"
          value={search}
          onChange={(e) => setChatListSearch(e.target.value)}
        />
      </label>
      <div className="filters" role="tablist" aria-label="Filter chats">
        {(["all", "rooms", "direct"] as ChatListFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={`filter-btn${filter === f ? " active" : ""}`}
            onClick={() => setChatListFilter(f)}
          >
            {f === "all" ? "All" : f === "rooms" ? "Rooms" : "Direct"}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="text-action"
        style={{ margin: "2px 4px 10px" }}
        onClick={() => (showCreate ? closeCreateForm() : setShowCreate(true))}
      >
        {showCreate ? "Cancel" : "New room +"}
      </button>
      {/* M79: retry surface — unread/preview failures used to render
          as an empty-looking list with no hint anything failed. */}
      {(unreadError || previewError || membershipsError) && (
        <button
          type="button"
          onClick={() => {
            if (unreadError) void refetchUnread();
            if (previewError) void refetchPreviews();
            if (membershipsError) void refetchMemberships();
          }}
          style={{
            display: "block",
            width: "100%",
            padding: "10px 12px",
            margin: "0 0 12px",
            borderRadius: 12,
            background: "#FEF3C7",
            color: "#92400E",
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
            border: "1px solid #FDE68A",
            cursor: "pointer",
          }}
        >
          Couldn&apos;t load chat data — tap to retry
        </button>
      )}
      {showCreate && (
        <form onSubmit={submitRoom} style={{ marginBottom: 12 }}>
          <div className="search-wrap">
            <input
              type="text"
              placeholder="Room name…"
              autoComplete="off"
              aria-label="Room name"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              maxLength={60}
            />
            <button type="submit" className="filter-btn active" disabled={creating}>
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
          <div className="search-wrap" style={{ marginTop: 8 }}>
            <input
              type="text"
              placeholder="Description (optional)…"
              autoComplete="off"
              aria-label="Room description"
              value={roomDesc}
              onChange={(e) => setRoomDesc(e.target.value)}
              maxLength={280}
            />
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
              fontSize: 13,
              fontWeight: 600,
              color: "#374151",
            }}
          >
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            Private group — only added members can see it
          </label>
          {!isPrivate && (
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6B7280" }}>
              Public group — anyone signed in can see and join it.
            </p>
          )}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
              fontSize: 13,
              fontWeight: 600,
              color: "#374151",
            }}
          >
            <input
              type="checkbox"
              checked={isE2EE}
              onChange={(e) => setIsE2EE(e.target.checked)}
            />
            End-to-end encrypted — only members can read messages
          </label>
          {/* Audit-3 A6-N12: desktop's blocked-send warning, verbatim. */}
          <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6B7280" }}>
            Members without encryption set up can&apos;t be sent messages.
          </p>
        </form>
      )}
      <div className="list">
        {isLoading ? (
          <div className="empty-state">
            <h3>Loading chats…</h3>
          </div>
        ) : roomsError || dmError ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="search" />
            </div>
            <h3>Couldn&apos;t load chats</h3>
            <p>Your conversations didn&apos;t load. Check your connection and try again.</p>
            <button
              type="button"
              className="filter-btn active"
              style={{ marginTop: 12 }}
              onClick={() => {
                if (roomsError) void refetchRooms();
                if (dmError) void refetchDms();
              }}
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="search" />
            </div>
            <h3>No conversations found</h3>
            <p>Try another name or switch the filter.</p>
          </div>
        ) : (
          filtered.map((t) => {
            const preview = previewMap.get(t.id);
            const unread = unreadMap.get(t.id) ?? 0;
            const mine = preview?.user_id === user?.id;
            // M96: desktop fallback port — a no-message conversation
            // used to render a blank preview line. Rooms fall back to
            // the description ("No messages yet"), DMs to Online /
            // Last-seen (same text as desktop inbox-pane).
            const fallback =
              t.kind === "room"
                ? (t.description ?? "").trim() || "No messages yet"
                : isUserOnline(t.partnerLastSeen ?? null)
                  ? "Online now"
                  : t.partnerLastSeen
                    ? `Last seen ${formatServerRelativeTime(t.partnerLastSeen)}`
                    : "Offline";
            const previewText = preview
              ? preview.type === "image"
                ? `${mine ? "You" : preview.display_name}: 📷 Photo`
                : preview.type === "video"
                  ? `${mine ? "You" : preview.display_name}: 🎬 Video`
                  : preview.type === "audio"
                    ? `${mine ? "You" : preview.display_name}: 🎤 Voice message`
                  : preview.type === "file"
                    ? `${mine ? "You" : preview.display_name}: 📎 File`
                    : preview.type === "call"
                      ? `${mine ? "You" : preview.display_name}: ${callPreviewText(preview.body)}`
                      // Audit-3 A4-N32: lock label only in E2EE rooms.
                      : (preview.body ?? "").trim().startsWith("E2E1:") && t.isE2EE
                      ? `${mine ? "You" : preview.display_name}: 🔒 Encrypted message`
                      : `${mine ? "You" : preview.display_name}: ${(preview.body ?? "").trim()}`
              : fallback;
            return (
              <Link
                key={t.id}
                to="/rooms/$roomId"
                params={{ roomId: t.id }}
                className="chat-row"
                style={{ textDecoration: "none", color: "inherit" }}
                onKeyDown={(e) => {
                  // Audit-4 M26: keyboard opener for the chat menu —
                  // the row previously had only onContextMenu +
                  // onTouchStart, so a keyboard-only user could never
                  // Pin/Mute/Mark-as-read/Delete/Leave. Shift+F10 is
                  // the standard context-menu key; preventDefault
                  // stops the browser's own contextmenu event (which
                  // would re-open the menu at 0,0). The Menu key
                  // fires contextmenu natively — the handler below
                  // falls back to the row rect when its coordinates
                  // are (0,0).
                  if (e.key === "F10" && e.shiftKey) {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    openChatMenu(t, rect.right, rect.top + rect.height / 2);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Audit-4 M26: a keyboard-triggered contextmenu
                  // (Menu key) has clientX/Y = 0 — anchor to the row
                  // instead of the top-left corner.
                  if (e.clientX === 0 && e.clientY === 0) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    openChatMenu(t, rect.right, rect.top + rect.height / 2);
                  } else {
                    openChatMenu(t, e.clientX, e.clientY);
                  }
                }}
                onTouchStart={(e) => {
                  if (e.touches.length !== 1) return;
                  const touch = e.touches[0];
                  touchPos.current = { x: touch.clientX, y: touch.clientY };
                  cancelLongPress();
                  lpTimer.current = window.setTimeout(() => {
                    suppressClickFor.current = t.id;
                    openChatMenu(t, touch.clientX, touch.clientY);
                    // Audit-2 L51: NO 600ms clear timer — the old timer
                    // cleared the suppress while the finger was still
                    // down on a >600ms hold, so the lift-click navigated
                    // and unmounted the just-opened menu. The suppress
                    // now lives until the next click consumes it (below)
                    // or the menu closes (ChatMenu onClose).
                  }, 550);
                }}
                onTouchMove={(e) => {
                  const p = touchPos.current;
                  const touch = e.touches[0];
                  if (p && touch && Math.hypot(touch.clientX - p.x, touch.clientY - p.y) > 12) {
                    cancelLongPress();
                  }
                }}
                onTouchEnd={cancelLongPress}
                onTouchCancel={cancelLongPress}
                onClick={(e) => {
                  // Audit-2 L51: the long-press suppress is consumed by
                  // the NEXT click. Same row → swallow it (the lift
                  // after the hold). Any other row → clear and let it
                  // navigate normally (a stale suppress must never eat
                  // a later, unrelated tap).
                  if (suppressClickFor.current === t.id) {
                    e.preventDefault();
                    suppressClickFor.current = null;
                  } else if (suppressClickFor.current !== null) {
                    suppressClickFor.current = null;
                  }
                }}
              >
                <div className="avatar">
                  {t.kind === "room" ? (
                    t.isPrivate ? (
                      "🔒"
                    ) : (
                      "#"
                    )
                  ) : t.partnerId ? (
                    <SmartAvatar
                      userId={t.partnerId}
                      name={t.name}
                      className="h-full w-full rounded-[17px]"
                      fallbackClassName="rounded-[17px] bg-transparent text-inherit"
                    />
                  ) : (
                    initialsOf(t.name)
                  )}
                </div>
                <div className="row-main">
                  <div className="row-top">
                    <span className="row-name">
                      {t.name}
                      {t.isE2EE ? " 🔒" : ""}
                      {t.pinned ? " 📌" : ""}
                      {t.muted ? " 🔇" : ""}
                    </span>
                    <span className="row-time">{threadTime(t.lastActivity)}</span>
                  </div>
                  <div className="row-preview">{previewText}</div>
                </div>
                {unread > 0 && (
                  <div className="row-meta">
                    <span className="unread">{unread > 99 ? "99+" : unread}</span>
                  </div>
                )}
              </Link>
            );
          })
        )}
      </div>

      {/* Audit-4 L59: rooms beyond the first 200 are one tap away
          (M5 desktop parity; MobileCalls "Load older calls" pattern). */}
      {!isLoading && !roomsError && filtered.length > 0 && hasNextPage && (
        <div style={{ display: "flex", justifyContent: "center", padding: "12px 0" }}>
          <button
            type="button"
            className="small-pill"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? "Loading…" : "Load more chats"}
          </button>
        </div>
      )}

      {/* WhatsApp-style chat menu (long-press on a row) */}
      <ChatMenu
        menu={chatMenu}
        inMobileShell
        // Audit-2 L51: a menu dismissed without a click (Escape /
        // backdrop / item action) must also release the long-press
        // suppress — otherwise the next tap on the same row is eaten.
        onClose={() => {
          suppressClickFor.current = null;
          setChatMenu(null);
        }}
        onPin={onPinChat}
        onMute={onMuteChat}
        onMarkRead={onMarkChatRead}
        onRetryPinMute={() => void refetchMemberships()}
        onDelete={(chatId) => {
          const t = threads.find((x) => x.id === chatId);
          if (t)
            setConfirmDelete({
              chatId,
              kind: t.kind,
              name: t.name,
              canDeleteRoom: t.kind === "room" && t.createdBy === user?.id,
            });
        }}
      />

      {/* Confirm delete / leave */}
      <Dialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirmDelete?.kind === "direct"
                ? "Delete this chat?"
                : confirmDelete?.canDeleteRoom
                  ? "Delete this room?"
                  : "Leave this group?"}
            </DialogTitle>
            <DialogDescription>
              {confirmDelete?.kind === "direct"
                ? `This will permanently delete this chat and all its messages for both of you.`
                : confirmDelete?.canDeleteRoom
                  ? `"${confirmDelete?.name}" and all its messages will be permanently deleted for everyone.`
                  : `You will leave "${confirmDelete?.name}".`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirmDelete} disabled={deleting}>
              {deleting
                ? confirmDelete?.kind !== "direct" && !confirmDelete?.canDeleteRoom
                  ? "Leaving…"
                  : "Deleting…"
                : confirmDelete?.kind === "direct"
                  ? "Delete"
                  : confirmDelete?.canDeleteRoom
                    ? "Delete room"
                    : "Leave"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ---------------------------------- People --------------------------------- */

export function MobilePeople() {
  const users = useServerFn(listUsers);
  const openDm = useServerFn(getOrCreateDm);
  const navigate = useNavigate();
  const { startCall } = useCall();
  const [search, setSearch] = useState("");

  // Audit-2 M42: same as M41 — a listUsers failure used to render as
  // "No people found", so the user kept changing their search while
  // the fetch itself had failed. Error state + retry, before empty.
  const {
    data: userList,
    isLoading,
    isError: usersError,
    refetch: refetchUsers,
  } = useQuery({
    queryKey: ["users"],
    queryFn: () =>
      users().catch((err) => {
        console.warn("[people] listUsers failed:", err);
        throw err;
      }),
    // Audit-4 M19: same as desktop People — presence goes stale
    // while open without polling (the profiles subscription can
    // never deliver other users' presence: heartbeat writes only
    // `presence`, `presence` is never in the Realtime publication
    // per §M53, and post-C3 the profiles policy is own-row-only).
    // 30s polling keeps the dots inside the 120s staleness window.
    refetchInterval: 30_000,
  });

  // Live presence: without this, People is a fetch-time snapshot and
  // online / last-seen freezes until the view remounts (desktop already
  // subscribes to profiles changes — mobile did not).
  // Audit-2 M55: track the channel's liveness (room view's rtLive
  // pattern) — a failed subscribe used to fail silently.
  const [peopleLive, setPeopleLive] = useState(false);
  const peopleDisconnectedRef = useRef(false);
  const qc = useQueryClient();
  useEffect(() => {
    // Audit-6 B-D1: this channel watched public.profiles — dead
    // since §C3 (own-row-only RLS). It now watches the presence
    // table (LOW-13), whose read policy delivers visible users'
    // rows, so the People list's online state is actually live.
    // M35: invalidation throttled — presence ticks arrive for
    // every online user every ~25s.
    let alive = true;
    let lastProfilesInvalidate = 0;
    const ch = supabase
      .channel("mobile-people-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "presence" }, () => {
        const now = Date.now();
        if (now - lastProfilesInvalidate < 15_000) return;
        lastProfilesInvalidate = now;
        qc.invalidateQueries({ queryKey: ["users"] });
      })
      // Audit-2 M55: status callback (was a bare .subscribe()). On
      // re-SUBSCRIBED after a disconnect, refresh — presence updates
      // were missed while the socket was down.
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") {
          setPeopleLive(true);
          if (peopleDisconnectedRef.current) {
            peopleDisconnectedRef.current = false;
            qc.invalidateQueries({ queryKey: ["users"] });
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          peopleDisconnectedRef.current = true;
          setPeopleLive(false);
          console.warn("[mobile-people] realtime channel lost:", status);
        }
      });
    return () => {
      alive = false;
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (userList ?? []).filter((u) => !q || u.display_name.toLowerCase().includes(q));
  }, [userList, search]);

  // Audit-2 M46: per-user in-flight guard for getOrCreateDm. The REF
  // is the guard (a state-only check reads stale state on a
  // same-tick double-tap — the exact race being fixed, see M28);
  // the state mirrors it so the button disables while pending.
  const pendingDmRef = useRef(new Set<string>());
  const [pendingDm, setPendingDm] = useState<ReadonlySet<string>>(new Set());
  const startDm = async (otherUserId: string) => {
    if (pendingDmRef.current.has(otherUserId)) return;
    pendingDmRef.current.add(otherUserId);
    setPendingDm(new Set(pendingDmRef.current));
    try {
      const { roomId } = await openDm({ data: { otherUserId } });
      navigate({ to: "/rooms/$roomId", params: { roomId } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      pendingDmRef.current.delete(otherUserId);
      setPendingDm(new Set(pendingDmRef.current));
    }
  };

  return (
    <>
      <div className="section-head">
        <h2>People</h2>
        <p>Find someone and start a conversation.</p>
      </div>
      {/* Audit-2 M55: visible when the people realtime channel is down. */}
      {!peopleLive && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
          style={{ margin: "0 4px 6px" }}
          title="Live updates disconnected — presence may need a refresh"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          Reconnecting…
        </span>
      )}
      <label className="search-wrap">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search people"
          autoComplete="off"
          aria-label="Search people"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="list">
        {isLoading ? (
          <div className="empty-state">
            <h3>Loading people…</h3>
          </div>
        ) : usersError ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="user" />
            </div>
            <h3>Couldn&apos;t load people</h3>
            <p>People didn&apos;t load. Check your connection and try again.</p>
            <button
              type="button"
              className="filter-btn active"
              style={{ marginTop: 12 }}
              onClick={() => void refetchUsers()}
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="user" />
            </div>
            <h3>No people found</h3>
            <p>Try searching for another name.</p>
          </div>
        ) : (
          filtered.map((u) => (
            // Audit-2 L56: rows are keyboard-operable — Enter/Space
            // opens the DM (the row's primary action; the Message /
            // Call / Video buttons stay separately focusable).
            <div
              key={u.id}
              className="person-row"
              tabIndex={0}
              aria-label={`Message ${u.display_name}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  // Audit-4 M24: ignore keys from a nested
                  // interactive element (Message / Call / Video
                  // button) — without this, Enter/Space on a Call
                  // button ALSO opened the DM (double action: the
                  // button's own click + this row handler).
                  if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [role='button']"))
                    return;
                  e.preventDefault();
                  void startDm(u.id);
                }
              }}
            >
              <div className="avatar">
                <SmartAvatar
                  userId={u.id}
                  name={u.display_name}
                  className="h-full w-full rounded-[17px]"
                  fallbackClassName="rounded-[17px] bg-transparent text-inherit"
                />
                {/* Audit-2 L62: the `.avatar .online` dot style already
                    existed in MOBILE_CSS but no row rendered it — the
                    text alone said "Online now". Dot + text now. */}
                {isUserOnline(u.last_seen_at) ? (
                  <span className="online" aria-hidden="true" />
                ) : null}
              </div>
              <div className="row-main">
                <div className="row-name">{u.display_name}</div>
                <div className="presence">
                  {isUserOnline(u.last_seen_at)
                    ? "Online now"
                    : u.last_seen_at
                      ? `Last seen ${formatServerRelativeTime(u.last_seen_at)}`
                      : "Offline"}
                </div>
              </div>
              <div className="row-buttons">
                <button
                  type="button"
                  className="small-pill"
                  disabled={pendingDm.has(u.id)}
                  onClick={() => void startDm(u.id)}
                >
                  <Icon name="chat" />
                  {pendingDm.has(u.id) ? "Opening…" : "Message"}
                </button>
                <button
                  type="button"
                  className="small-pill call"
                  aria-label={`Call ${u.display_name}`}
                  onClick={() => void startCall(u.id, u.display_name, "voice")}
                >
                  <Icon name="phone" />
                </button>
                {/* H43: video-call button (was voice-only; desktop has both). */}
                <button
                  type="button"
                  className="small-pill call"
                  aria-label={`Video call ${u.display_name}`}
                  onClick={() => void startCall(u.id, u.display_name, "video")}
                >
                  <Icon name="video" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

/* ---------------------------------- Calls ---------------------------------- */

function callLabel(r: CallRecord): string {
  // Audit-2 L55: a 30s call rendered "· 0 min" — show "<1 min" under 60s.
  const dur =
    r.duration_seconds > 0
      ? ` · ${r.duration_seconds < 60 ? "<1 min" : `${Math.floor(r.duration_seconds / 60)} min`}`
      : "";
  const kind = r.type === "video" ? "video call" : "voice call";
  if (r.status === "missed") return `Missed ${kind}`;
  if (r.status === "cancelled") return `Cancelled ${kind}`;
  if (r.status === "declined") return `Declined ${kind}`;
  if (r.status === "failed") return `Failed ${kind}`;
  const dir = r.direction === "incoming" ? "Incoming" : "Outgoing";
  return `${dir} ${kind}${dur}`;
}

export function MobileCalls() {
  const { startCall } = useCall();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [missedOnly, setMissedOnly] = useState(false);

  const deleteHistory = useServerFn(deleteCallHistory);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);

  // Audit-2 L49: cursor pages (was a hard 50-row cap). The ["calls"]
  // key is unchanged, so the M43 realtime invalidation still
  // refreshes every page.
  const {
    data: pages,
    isLoading,
    isError,
    refetch: refetchCalls,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["calls"],
    queryFn: ({ pageParam }) => listCalls({ cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const calls = pages?.pages.flatMap((p) => p.calls) ?? [];

  // Audit-2 L49: delete one row / clear all — confirm first, then
  // invalidate ["calls"] so both lists re-read.
  const onDeleteOne = async (id: string, peerName: string) => {
    if (!window.confirm(`Delete this call with ${peerName} from your history?`)) return;
    setDeletingId(id);
    try {
      await deleteHistory({ data: { id } });
      await qc.invalidateQueries({ queryKey: ["calls"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete this call.");
    } finally {
      setDeletingId(null);
    }
  };
  const onClearAll = async () => {
    if (!window.confirm("Delete your entire call history? This can't be undone.")) return;
    setClearingAll(true);
    try {
      await deleteHistory({ data: { all: true } });
      await qc.invalidateQueries({ queryKey: ["calls"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear call history.");
    } finally {
      setClearingAll(false);
    }
  };

  // M43: same as DesktopCalls — a call ending on another device/tab
  // writes a new `calls` row; subscribe so history refreshes live.
  // Audit-3 A6-N6: M55 liveness (was a bare .subscribe()) — track the
  // channel's liveness; on re-SUBSCRIBED after a disconnect, refresh
  // ["calls"] (events were missed while the socket was down).
  const [callsLive, setCallsLive] = useState(false);
  const callsDisconnectedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    const ch = supabase
      .channel("calls-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "calls" }, () => {
        qc.invalidateQueries({ queryKey: ["calls"] });
      })
      // Audit-3 A6-N6: status callback (was a bare .subscribe()). On
      // re-SUBSCRIBED after a disconnect, refresh — call-history
      // events were missed while the socket was down.
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") {
          setCallsLive(true);
          if (callsDisconnectedRef.current) {
            callsDisconnectedRef.current = false;
            qc.invalidateQueries({ queryKey: ["calls"] });
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          callsDisconnectedRef.current = true;
          setCallsLive(false);
          console.warn("[mobile-calls] realtime channel lost:", status);
        }
      });
    return () => {
      alive = false;
      supabase.removeChannel(ch);
    };
  }, [qc]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (calls ?? []).filter((r) => {
      if (missedOnly && r.status !== "missed") return false;
      return !q || r.peer_name.toLowerCase().includes(q);
    });
  }, [calls, search, missedOnly]);

  return (
    <>
      <div className="section-head">
        <h2>Calls</h2>
        <p>Stay close, voice by voice.</p>
      </div>
      {/* Audit-3 A6-N6: visible when the calls realtime channel is down. */}
      {!callsLive && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
          style={{ margin: "0 4px 6px" }}
          title="Live updates disconnected — call history may need a refresh"
        >
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          Reconnecting…
        </span>
      )}
      <label className="search-wrap">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search call history"
          autoComplete="off"
          aria-label="Search call history"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="calls-tabs">
        <div className="filters" role="tablist" aria-label="Filter calls">
          <button
            type="button"
            role="tab"
            aria-selected={!missedOnly}
            className={`filter-btn${!missedOnly ? " active" : ""}`}
            onClick={() => setMissedOnly(false)}
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={missedOnly}
            className={`filter-btn${missedOnly ? " active" : ""}`}
            onClick={() => setMissedOnly(true)}
          >
            Missed
          </button>
        </div>
        <button
          type="button"
          className="text-action"
          onClick={() => navigate({ to: "/people" })}
        >
          New call +
        </button>
      </div>
      <div className="list">
        {isLoading ? (
          <div className="empty-state">
            <h3>Loading calls…</h3>
          </div>
        ) : isError ? (
          // M19: a load failure is NOT "no calls found" — say so.
          // Audit-2 L52: offer a retry instead of a dead end.
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="phone" />
            </div>
            <h3>Couldn&apos;t load call history</h3>
            <p>Check your connection and try again.</p>
            <button
              type="button"
              className="small-pill"
              style={{ marginTop: 12 }}
              onClick={() => void refetchCalls()}
            >
              Tap to retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="phone" />
            </div>
            <h3>No calls found</h3>
            <p>Recent calls will appear here.</p>
          </div>
        ) : (
          filtered.map((r) => (
            // Audit-2 L56: rows are keyboard-operable — Enter/Space
            // redials (the row's primary action; the callback button
            // stays separately focusable).
            <div
              key={r.id}
              className="call-row"
              tabIndex={0}
              aria-label={`Call back ${r.peer_name}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  // Audit-4 M25: same as M24 (person row) — ignore
                  // keys from a nested interactive element (Delete
                  // / Callback buttons) — without this, Enter/Space
                  // on Delete ALSO redialed (delete + redial), and
                  // on Callback redialed twice.
                  if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [role='button']"))
                    return;
                  e.preventDefault();
                  void startCall(r.peer_id, r.peer_name, r.type === "video" ? "video" : "voice");
                }
              }}
            >
              <div className="avatar">
                <SmartAvatar
                  userId={r.peer_id}
                  name={r.peer_name}
                  className="h-full w-full rounded-[17px]"
                  fallbackClassName="rounded-[17px] bg-transparent text-inherit"
                />
              </div>
              <div className="row-main">
                <div className="row-top">
                  <span className="row-name">{r.peer_name}</span>
                  <span className="row-time">{threadTime(r.started_at)}</span>
                </div>
                <div className={`call-type${r.status === "missed" ? " missed" : ""}`}>
                  <Icon
                    name={
                      r.status === "missed"
                        ? "missed"
                        : r.direction === "incoming"
                          ? "call-in"
                          : "call-out"
                    }
                  />
                  {callLabel(r)}
                </div>
              </div>
              <button
                type="button"
                className="call-back"
                aria-label={`Delete call with ${r.peer_name} from history`}
                disabled={deletingId === r.id}
                onClick={() => void onDeleteOne(r.id, r.peer_name)}
              >
                <Icon name="trash" />
              </button>
              <button
                type="button"
                className="call-back"
                // H43: callback with the row's own type — a video-call
                // history row used to callback with "voice". Icon matches.
                aria-label={`${r.type === "video" ? "Video call" : "Call"} ${r.peer_name}`}
                onClick={() => void startCall(r.peer_id, r.peer_name, r.type === "video" ? "video" : "voice")}
              >
                <Icon name={r.type === "video" ? "video" : "phone"} />
              </button>
            </div>
          ))
        )}
      </div>
      {/* Audit-2 L49: clear-all + older pages. */}
      {!isLoading && !isError && (calls ?? []).length > 0 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 12, padding: "12px 0" }}>
          {hasNextPage && (
            <button
              type="button"
              className="small-pill"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading…" : "Load older calls"}
            </button>
          )}
          <button
            type="button"
            className="small-pill"
            disabled={clearingAll}
            onClick={() => void onClearAll()}
          >
            {clearingAll ? "Clearing…" : "Clear call history"}
          </button>
        </div>
      )}
    </>
  );
}

/* ------------------------- Profile information editor ------------------------ */

type PrivacyKey = "isAvatarPublic" | "isNamePublic" | "isBioPublic" | "isStatusPublic" | "showNotificationPreviews";

const PRIVACY_SECTIONS: { key: PrivacyKey; title: string; sub: string }[] = [
  { key: "isAvatarPublic", title: "Profile photo", sub: "Your picture" },
  { key: "isNamePublic", title: "Name", sub: "Your display name" },
  { key: "isBioPublic", title: "Bio", sub: "A line or two about you" },
  { key: "isStatusPublic", title: "Status", sub: "What you're up to" },
  // Audit-2 L70: lock-screen privacy (not profile visibility — the
  // sub copy below special-cases this row to On/Off wording).
  { key: "showNotificationPreviews", title: "Show message previews", sub: "In notifications" },
];

function MobileProfileInfo({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const getProfile = useServerFn(getMe);
  const update = useServerFn(updateProfile);
  const deleteOwnFile = useServerFn(deleteOwnAttachmentFile);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: meData } = useQuery({ queryKey: ["me"], queryFn: () => getProfile() });
  const profile = meData?.profile as
    | {
        display_name?: string | null;
        bio?: string | null;
        custom_status?: string | null;
        is_avatar_public?: boolean;
        is_name_public?: boolean;
        is_bio_public?: boolean;
        is_status_public?: boolean;
        show_notification_previews?: boolean;
      }
    | null
    | undefined;

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [customStatus, setCustomStatus] = useState("");
  const [privacy, setPrivacy] = useState<Record<PrivacyKey, boolean>>({
    isAvatarPublic: true,
    isNamePublic: true,
    isBioPublic: true,
    isStatusPublic: true,
    showNotificationPreviews: true,
  });
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  // M80: object-URL lifecycle (revoke on replace + unmount).
  const avatarPreviewUrl = useObjectUrl();
  const [saving, setSaving] = useState(false);
  // Audit-3 A6-N5: ref guard mirroring MobileChangePassword (A6-N4) —
  // state updates are async, so a fast double-click runs onSave twice
  // before the re-render disables the button (two avatar uploads →
  // the first file orphaned; see M80). Set only after validation
  // passes, cleared in finally.
  const savingRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  // Audit-4 H5: per-field touched set — the old single dirtyRef
  // blocked ALL hydration once ANY field was touched, so a name
  // typed before ["me"] arrived left bio/status/privacy at their
  // defaults and Save wiped them (bio/status -> null, privacy ->
  // all Public). Now each field hydrates independently unless THAT
  // field was edited. (Audit-2 L58's protection is preserved per
  // field: a late ["me"] arrival never overwrites an edited field.)
  const touchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (profile && !hydrated) {
      if (!touchedRef.current.has("displayName")) setDisplayName(profile.display_name ?? "");
      if (!touchedRef.current.has("bio")) setBio(profile.bio ?? "");
      if (!touchedRef.current.has("customStatus")) setCustomStatus(profile.custom_status ?? "");
      setPrivacy((p) => ({
        isAvatarPublic: touchedRef.current.has("privacy.isAvatarPublic")
          ? p.isAvatarPublic
          : (profile.is_avatar_public ?? true),
        isNamePublic: touchedRef.current.has("privacy.isNamePublic")
          ? p.isNamePublic
          : (profile.is_name_public ?? true),
        isBioPublic: touchedRef.current.has("privacy.isBioPublic")
          ? p.isBioPublic
          : (profile.is_bio_public ?? true),
        isStatusPublic: touchedRef.current.has("privacy.isStatusPublic")
          ? p.isStatusPublic
          : (profile.is_status_public ?? true),
        showNotificationPreviews: touchedRef.current.has("privacy.showNotificationPreviews")
          ? p.showNotificationPreviews
          : (profile.show_notification_previews ?? true),
      }));
      setHydrated(true);
    }
  }, [profile, hydrated]);

  // Audit-2 M44: system Back closes the editor instead of exiting
  // the page; an edited-but-unsaved field asks first.
  useSubViewBack(true, onBack, () => {
    if (!hydrated) return false;
    if (avatarFile) return true;
    if (displayName !== (profile?.display_name ?? "")) return true;
    if (bio !== (profile?.bio ?? "")) return true;
    if (customStatus !== (profile?.custom_status ?? "")) return true;
    if (privacy.isAvatarPublic !== (profile?.is_avatar_public ?? true)) return true;
    if (privacy.isNamePublic !== (profile?.is_name_public ?? true)) return true;
    if (privacy.isBioPublic !== (profile?.is_bio_public ?? true)) return true;
    if (privacy.isStatusPublic !== (profile?.is_status_public ?? true)) return true;
    if (privacy.showNotificationPreviews !== (profile?.show_notification_previews ?? true))
      return true;
    return false;
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!f) return;
    // Audit-3 A6-N10: same raster allowlist + 5 MB cap as uploadAvatar
    // (upload.ts) — reject here with an immediate toast instead of
    // showing a preview that fails at Save (SVG / oversized files).
    const AVATAR_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"];
    if (!AVATAR_ALLOWED_TYPES.includes(f.type)) {
      toast.error("Please choose a PNG, JPEG, GIF, WebP, AVIF, or BMP image (SVG is not supported).");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      toast.error("Avatar must be under 5 MB.");
      return;
    }
    setAvatarFile(f);
    setAvatarPreview(avatarPreviewUrl.set(URL.createObjectURL(f)));
  };

  const onSave = async () => {
    if (!user?.id) return;
    if (savingRef.current) return;
    // Audit-4 H5: never save before the server profile has hydrated
    // — the pre-hydration defaults (bio/status "", privacy all true)
    // would wipe the user's bio/status and reset privacy to Public.
    if (!hydrated) {
      toast.error("Profile is still loading — please wait a moment.");
      return;
    }
    if (!displayName.trim()) {
      toast.error("Display name is required.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    // M80: hoisted so the catch can clean up the uploaded avatar.
    let avatarPath: string | undefined;
    try {
      if (avatarFile) avatarPath = await uploadAvatar(avatarFile, user.id);
      const res = await update({
        data: {
          displayName: displayName.trim(),
          // H41: null = clear the field (see profile-dialog).
          bio: bio.trim() || null,
          customStatus: customStatus.trim() || null,
          ...(avatarPath ? { avatarPath } : {}),
          ...privacy,
        },
      });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["avatar", user.id] });
      // Audit-2 L70: the in-app notifier caches the preview pref.
      qc.invalidateQueries({ queryKey: ["my-preview-pref"] });
      toast.success("Profile updated");
      if (res.warning) toast.warning(res.warning);
      onBack();
    } catch (err) {
      // M80: the avatar upload already landed — delete the orphan so
      // a failed save doesn't leave a stray file in storage
      // (same pattern as the room page's failed-send cleanup).
      if (avatarPath) {
        try {
          // Audit-3 A8-N17: storage deletes go through the server
          // fn (client DELETE policy dropped).
          await deleteOwnFile({ data: { path: avatarPath } });
        } catch {
          // Best-effort — the orphan is unreachable (M18 policy) but
          // still consumes storage; log for a later sweep.
          console.warn("[profile] orphan avatar cleanup failed:", avatarPath);
        }
      }
      toast.error(err instanceof Error ? err.message : "Could not save profile");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Audit-7 D2 (extended): shared letters-only initialsOf — this
  // inline copy rendered "HAMZA (Admin)" as "H(".
  const initials = initialsOf(displayName || profile?.display_name || "U");

  return (
    <>
      <div className="back-row">
        <button type="button" onClick={onBack}>
          ← Back
        </button>
      </div>
      <div className="section-head">
        <h2>Profile information</h2>
        <p>Edit how you appear, and choose what others can see.</p>
      </div>
      <div
        className="edit-avatar"
        onClick={() => fileRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Change profile picture"
        onKeyDown={(e) => {
          // Audit-4 L48: this was a mouse-only "button" — role="button"
          // without focusability is a false affordance, so keyboard /
          // screen-reader users could never reach "Change photo".
          // Enter / Space open the file picker like a click (WAI-ARIA
          // button behaviour); Space needs preventDefault or the page
          // scrolls. A real <button> can't hold the hidden file
          // <input> (nested interactive content), so the div stays.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
      >
        {avatarPreview ? (
          <img src={avatarPreview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : user?.id ? (
          <SmartAvatar
            userId={user.id}
            name={displayName || profile?.display_name || "You"}
            className="h-full w-full"
            fallbackClassName="bg-transparent text-inherit"
          />
        ) : (
          initials
        )}
        <span className="change">Change photo</span>
        <input ref={fileRef} type="file" accept="image/*" onChange={onPick} style={{ display: "none" }} />
      </div>
      <div className="field">
        <label htmlFor="m-profile-name">Name</label>
        <input
          id="m-profile-name"
          value={displayName}
          onChange={(e) => {
            touchedRef.current.add("displayName");
            setDisplayName(e.target.value);
          }}
          maxLength={40}
          placeholder="Your display name"
        />
      </div>
      <div className="field">
        <label htmlFor="m-profile-status">Status</label>
        <input
          id="m-profile-status"
          value={customStatus}
          onChange={(e) => {
            touchedRef.current.add("customStatus");
            setCustomStatus(e.target.value);
          }}
          maxLength={60}
          placeholder="e.g. Heads down until 5pm"
        />
      </div>
      <div className="field">
        <label htmlFor="m-profile-bio">Bio</label>
        <textarea
          id="m-profile-bio"
          value={bio}
          onChange={(e) => {
            touchedRef.current.add("bio");
            setBio(e.target.value);
          }}
          maxLength={160}
          rows={3}
          placeholder="A line or two about you"
        />
      </div>
      <p className="privacy-head">Who can see what</p>
      <p className="privacy-note">
        Turn a section off to hide it when someone opens your profile. Private sections are
        hidden from everyone except you.
      </p>
      {PRIVACY_SECTIONS.map((s) => (
        <div className="privacy-row" key={s.key}>
          <div className="p-main">
            <div className="p-title">{s.title}</div>
            <div className="p-sub">
              {s.key === "showNotificationPreviews"
                ? // Audit-2 L70: this row is notification previews,
                  // not profile visibility — On/Off wording.
                  privacy[s.key]
                  ? "On · Notifications show the message text"
                  : "Off · Notifications show “New message” only"
                : `${privacy[s.key] ? "Public" : "Private"} · ${s.sub}`}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={privacy[s.key]}
            aria-label={
              s.key === "showNotificationPreviews"
                ? `Show message previews ${privacy[s.key] ? "on" : "off"}`
                : `${s.title} ${privacy[s.key] ? "public" : "private"}`
            }
            className={`mini-switch${privacy[s.key] ? " on" : ""}`}
            onClick={() => {
              touchedRef.current.add(`privacy.${s.key}`);
              setPrivacy((p) => ({ ...p, [s.key]: !p[s.key] }));
            }}
          />
        </div>
      ))}
      <button type="button" className="save-btn" onClick={() => void onSave()} disabled={saving}>
        {saving ? "Saving…" : "Save profile"}
      </button>
    </>
  );
}

/* ----------------------------------- You ----------------------------------- */

// M94: mobile credential rotation (mirrors the desktop
// ChangeCredentialsDialog; same account-security.ts helpers).
function MobileChangePassword({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const setPassword = useServerFn(changePasswordWithPolicy);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  // Audit-3 A6-N4: ref guard mirrors deletingRef/creatingRef — state
  // updates are async, so a fast double-click in the same tick runs
  // onSave twice before the re-render disables the button (second
  // re-auth lands after the first update → spurious error toast after
  // a success toast). Set only after validation passes, cleared in
  // finally — validation-failure clicks never engage it.
  const savingRef = useRef(false);
  // Audit-2 M44: system Back closes the form instead of exiting
  // the page; typed-but-unsaved passwords ask first.
  useSubViewBack(true, onBack, () => current !== "" || next !== "" || confirm !== "");
  const onSave = async () => {
    if (!user) return;
    if (savingRef.current) return;
    // Audit-2 L20: instant validation — the Save button is
    // type="button" outside a <form>, so HTML required alone would
    // not stop an empty submit.
    if (!current.trim()) {
      toast.error("Enter your current password.");
      return;
    }
    if (!next.trim()) {
      toast.error("Enter a new password.");
      return;
    }
    if (!confirm.trim()) {
      toast.error("Confirm your new password.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      // Audit-4 M1: the set goes through the server fn (policy
      // enforced server-side) — see account-security.ts.
      const { signedOutEverywhere } = await changePassword(user, current, next, confirm, (pw) =>
        setPassword({ data: { newPassword: pw } }),
      );
      // M7: changePassword revoked every session (global sign-out) —
      // the user re-logs in with the new password.
      toast.success(
        signedOutEverywhere
          ? "Password changed. You've been signed out everywhere — please sign in again."
          : "Password changed, but other devices could not be signed out.",
      );
      onBack();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <>
      <div className="back-row">
        <button type="button" onClick={onBack}>
          ← Back
        </button>
      </div>
      <div className="section-head">
        <h2>Change password</h2>
        <p>Enter your current password, then choose a new one.</p>
      </div>
      <div className="field">
        <label htmlFor="m-pw-current">Current password</label>
        <input
          id="m-pw-current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="m-pw-new">New password</label>
        <input
          id="m-pw-new"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="m-pw-confirm">Confirm new password</label>
        <input
          id="m-pw-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          required
        />
      </div>
      <button type="button" className="save-btn" onClick={() => void onSave()} disabled={saving}>
        {saving ? "Saving…" : "Change password"}
      </button>
    </>
  );
}

function MobileChangeEmail({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [saving, setSaving] = useState(false);
  // Audit-3 A6-N5: ref guard mirroring MobileChangePassword (A6-N4) —
  // a same-tick double-click used to send two changeEmail calls
  // (duplicate confirmation links).
  const savingRef = useRef(false);
  const [emailSent, setEmailSent] = useState(false);
  // Audit-2 M44: system Back closes the form instead of exiting the
  // page; a typed-but-unsent change asks first. After the link is
  // sent there is nothing unsaved left to protect.
  useSubViewBack(true, onBack, () => !emailSent && (current !== "" || next !== ""));
  const onSave = async () => {
    if (!user) return;
    if (savingRef.current) return;
    // Audit-2 L20: instant validation (same type="button" note as
    // MobileChangePassword — HTML required alone enforces nothing).
    if (!current.trim()) {
      toast.error("Enter your current password.");
      return;
    }
    if (!next.trim()) {
      toast.error("Enter a valid email address.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await changeEmail(user, current, next);
      setEmailSent(true);
      toast.success("Confirmation link sent to your new email address.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <>
      <div className="back-row">
        <button type="button" onClick={onBack}>
          ← Back
        </button>
      </div>
      <div className="section-head">
        <h2>Change email address</h2>
        <p>A confirmation link will be sent to the new address.</p>
      </div>
      {emailSent ? (
        <p className="privacy-note">
          A confirmation link is on its way to <strong>{next.trim()}</strong>. Click it to
          complete the change — your email stays as-is until then.
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="m-email-current">Current password</label>
            <input
              id="m-email-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="m-email-new">New email address</label>
            <input
              id="m-email-new"
              type="email"
              autoComplete="email"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder={user?.email ?? ""}
              required
            />
          </div>
          <button type="button" className="save-btn" onClick={() => void onSave()} disabled={saving}>
            {saving ? "Saving…" : "Send confirmation link"}
          </button>
        </>
      )}
    </>
  );
}

export function MobileYou() {
  const { user, signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const getProfile = useServerFn(getMe);
  const update = useServerFn(updateProfile);
  const savePush = useServerFn(savePushSubscription);
  const getVapidKey = useServerFn(getVapidPublicKey);
  const removePush = useServerFn(removePushSubscription);
  const checkEndpoint = useServerFn(checkPushEndpoint);
  // M98: push diagnostics (desktop parity) — setup status, test push,
  // per-device registration indicator.
  const pushCheck = useServerFn(checkPushSetup);
  const testPush = useServerFn(sendTestPush);
  const [testing, setTesting] = useState(false);
  const [deviceRegistered, setDeviceRegistered] = useState<boolean | null>(null);
  // Audit-2 M43: desktop parity — the toggle flips notifOn BEFORE
  // subscribeToPush finishes, so this effect's first run sees no
  // endpoint and sets a false red "not registered". deviceCheckId
  // lets the toggle force a re-check AFTER subscribe completes.
  const [deviceCheckId, setDeviceCheckId] = useState(0);
  // M99: self-heal failure, surfaced in the diagnostics below.
  const healFailure = usePushHealFailure();
  const [notifOn, setNotifOn] = useState(isNotificationsEnabled());
  useEffect(() => {
    if (!notifOn) {
      setDeviceRegistered(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const ep = await currentPushEndpoint();
        if (!ep) {
          if (alive) setDeviceRegistered(false);
          return;
        }
        const { registered } = await checkEndpoint({ data: { endpoint: ep } });
        if (alive) setDeviceRegistered(registered);
      } catch {
        if (alive) setDeviceRegistered(false);
      }
    })();
    return () => {
      alive = false;
    };
    // deviceCheckId lets the toggle handler force a re-check after
    // subscribeToPush completes (the effect would otherwise run too early,
    // before the push-service roundtrip finishes, and show a false red).
  }, [notifOn, checkEndpoint, deviceCheckId]);
  const {
    data: pushStatus,
    // Audit-2 L59: a checkPushSetup failure used to render NOTHING
    // (no diagnostics, no test button) — the user never learned the
    // check itself had failed.
    isError: pushStatusError,
    refetch: refetchPushStatus,
  } = useQuery({
    queryKey: ["push-setup"],
    queryFn: () => pushCheck(),
    enabled: notifOn,
  });
  const [visSaving, setVisSaving] = useState(false);
  const visSavingRef = useRef(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // M94: in-app credential rotation.
  const [credMode, setCredMode] = useState<"password" | "email" | null>(null);

  const { data: meData } = useQuery({ queryKey: ["me"], queryFn: () => getProfile() });
  const myProfile = meData?.profile as
    | { display_name?: string | null; bio?: string | null; custom_status?: string | null; is_public?: boolean }
    | null
    | undefined;
  const isPublic = myProfile?.is_public ?? true;
  const toggleVisibility = async () => {
    // Audit-4 L58: same-tick double-submit guard (L41 pattern).
    // setVisSaving(true) is async state, so a same-tick second tap
    // fired a second update({isPublic: next}) + a second toast
    // before `disabled` could take effect. The ref is synchronous.
    if (visSavingRef.current) return;
    visSavingRef.current = true;
    const next = !isPublic;
    setVisSaving(true);
    try {
      // H41: send ONLY the field being toggled (partial update) — the
      // old code re-sent displayName/bio/customStatus, wiping bio/status
      // and overwriting the name if the profile hadn't loaded yet.
      const res = await update({
        data: {
          isPublic: next,
        },
      });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(next ? "Profile is public" : "Profile is private");
      if (res.warning) toast.warning(res.warning);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      visSavingRef.current = false;
      setVisSaving(false);
    }
  };

  // M78: the profile row wins (same as desktop profile.tsx). The old
  // code read auth-metadata, which the server-side updateUserById
  // sync doesn't refresh in the live session object — so a rename
  // stayed invisible until the next session refresh. The ["me"]
  // query IS invalidated on save, so this updates immediately.
  // `||` (not `??`) so a stale empty-string name falls through.
  const displayName =
    (myProfile?.display_name ||
      (user?.user_metadata?.display_name as string | undefined)) ??
    user?.email ??
    "You";

  // H18: mirror the desktop push round-trip. The old toggle only flipped
  // a localStorage flag — "Notifications on" showed but no push
  // subscription was created (no background/closed-app push), and "Off"
  // left the existing subscription alive (the SW doesn't check
  // localStorage, so system pushes kept arriving after Off).
  const toggleNotifications = async () => {
    if (!isNotificationSupported()) {
      toast.error("Notifications are not supported in this browser.");
      return;
    }
    if (notifOn) {
      // M31: don't claim OFF until the server row is verified gone —
      // a failed delete leaves the row, and the server keeps pushing
      // to a browser whose user turned notifications OFF.
      try {
        // Audit-4 L22: only attempt the push removal when push is
        // supported — a browser that never supported push has no
        // row to remove (unsubscribeFromPush throws when
        // unsupported); the OFF claim below is then local-only.
        if (pushSupported()) {
          await unsubscribeFromPush(
            (endpoint) => removePush({ data: { endpoint } }),
            (endpoint) => checkEndpoint({ data: { endpoint } }),
          );
        }
        setNotificationsEnabled(false);
        setNotifOn(false);
        // M99: notifications off makes a stale heal failure moot.
        clearPushHealFailure();
        // Audit-4 L40: the removed row must drop out of the
        // Registered devices list.
        void qc.invalidateQueries({ queryKey: ["my-push-subscriptions"] });
        toast.success("Notifications off");
      } catch {
        // OFF didn't take effect — leave the toggle ON and say so.
        setNotificationsEnabled(true);
        setNotifOn(true);
        toast.error("Couldn't turn notifications off — please try again.");
      }
      return;
    }
    let perm = getNotificationPermission();
    if (perm === "default") perm = await requestNotificationPermission();
    if (perm !== "granted") {
      toast.error(
        perm === "denied"
          ? "Notifications are blocked. Allow them in your browser settings, then try again."
          : "Notification permission was not granted.",
      );
      return;
    }
    setNotificationsEnabled(true);
    setNotifOn(true);
    if (pushSupported()) {
      try {
        const keys = await subscribeToPush((sub: PushKeys) => savePush({ data: sub }), () => getVapidKey());
        // Audit-2 M43: re-check device status now that the
        // subscription roundtrip finished (desktop parity — without
        // this the effect's early run leaves a stuck false red).
        setDeviceCheckId((n) => n + 1);
        if (keys) {
          // M99: manual re-subscribe succeeded — the heal failure is stale.
          clearPushHealFailure();
          // Audit-4 L40: the newly saved row must appear in the
          // Registered devices list.
          void qc.invalidateQueries({ queryKey: ["my-push-subscriptions"] });
          toast.success("Notifications enabled — you'll be pinged even with the app closed.");
        } else {
          toast.warning(
            "Notifications on, but background push could not be set up on this device.",
          );
        }
      } catch (err) {
        // Surface the real reason (e.g. the push_subscriptions table is missing).
        toast.error(
          `Notifications on, but push setup failed: ${err instanceof Error ? err.message : "unknown error"}`,
          { duration: 8000 },
        );
      }
    } else {
      toast.success("Notifications enabled. You'll be pinged for new messages.");
    }
  };

  const doSignOut = async () => {
    // M47: only navigate on success.
    try {
      await signOut();
      navigate({ to: "/", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign out — please try again.");
    }
  };

  // Audit-2 M8: global sign-out — revokes the session on EVERY device
  // (a copied refresh token dies too) and stops pushes everywhere.
  const doSignOutEverywhere = async () => {
    // M47: only navigate on success.
    try {
      await signOut({ everywhere: true });
      navigate({ to: "/", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign out — please try again.");
    }
  };

  if (editingProfile) {
    return <MobileProfileInfo onBack={() => setEditingProfile(false)} />;
  }
  if (credMode === "password") {
    return <MobileChangePassword onBack={() => setCredMode(null)} />;
  }
  if (credMode === "email") {
    return <MobileChangeEmail onBack={() => setCredMode(null)} />;
  }

  return (
    <>
      <div className="section-head">
        <h2>You</h2>
        <p>Your profile and preferences.</p>
      </div>
      <div className="profile-card">
        <div className="profile-avatar">
          {user?.id && (
            <SmartAvatar
              userId={user.id}
              name={displayName}
              className="h-full w-full rounded-full"
              fallbackClassName="bg-transparent text-inherit"
            />
          )}
        </div>
        <h3>{displayName}</h3>
        <p>{user?.email ?? "VibeTalk member"}</p>
        {myProfile?.custom_status ? (
          <p style={{ marginTop: 4, fontSize: 12, color: "#15803D", fontWeight: 600 }}>
            {myProfile.custom_status}
          </p>
        ) : null}
        {myProfile?.bio ? (
          <p style={{ marginTop: 2, fontSize: 12, color: "#6B7280" }}>{myProfile.bio}</p>
        ) : null}
      </div>
      <div className="settings-list">
        <button type="button" className="setting-row" onClick={() => setEditingProfile(true)}>
          <span className="setting-icon">
            <Icon name="user" />
          </span>
          <span>Profile information</span>
          <span className="arr">›</span>
        </button>
        <button type="button" className="setting-row" onClick={() => void toggleNotifications()}>
          <span className="setting-icon">
            <Icon name="bell" />
          </span>
          <span>Notifications</span>
          <span className="arr">{notifOn ? "On" : "Off"}</span>
        </button>
        {notifOn && healFailure && (
          <div style={{ padding: "8px 2px 0", fontSize: 12, lineHeight: 1.5, color: "#DC2626" }}>
            Push repair failed ({healFailure.message}) — toggle notifications off and on to retry.
          </div>
        )}
        {notifOn && pushStatusError && (
          <div style={{ padding: "8px 2px 10px", fontSize: 12, lineHeight: 1.5 }}>
            <span style={{ color: "#DC2626" }}>
              Couldn&apos;t check push setup — tap to retry.
            </span>{" "}
            <button
              type="button"
              onClick={() => void refetchPushStatus()}
              style={{ color: "#15803D", fontWeight: 700 }}
            >
              Retry
            </button>
          </div>
        )}
        {notifOn && pushStatus && (
          <div style={{ padding: "8px 2px 10px", fontSize: 12, lineHeight: 1.5, color: "#6B7280" }}>
            {pushStatus.tableMissing ? (
              <span style={{ color: "#DC2626" }}>
                Push database table missing — the push_subscriptions table has not been created
                in Supabase yet (migration 20261006090435_push_subscriptions), then turn
                notifications off and on again.
              </span>
            ) : pushStatus.probeError ? (
              // Audit-4 L34: the probe failed for a reason OTHER than
              // a missing table (RLS/permission/policy) — don't tell
              // the user to run SQL that cannot help.
              <span style={{ color: "#DC2626" }}>
                Push status check failed — the database couldn&apos;t be reached. Try again later.
              </span>
            ) : !pushStatus.vapidConfigured ? (
              <span style={{ color: "#DC2626" }}>
                Server push keys not configured — contact support.
              </span>
            ) : !pushStatus.serviceRoleConfigured ? (
              <span style={{ color: "#DC2626" }}>
                Server service key missing — messages send, but background push never fires.
                Contact support.
              </span>
            ) : deviceRegistered === false ? (
              <span style={{ color: "#DC2626" }}>
                This device is not registered for background push — turn notifications off and on
                again.
              </span>
            ) : deviceRegistered === null ? (
              <span>Checking this device&apos;s registration…</span>
            ) : (
              <span style={{ color: "#15803D" }}>Background push active on this device ✓</span>
            )}
          </div>
        )}
        {notifOn && pushStatus?.tableOk && pushStatus.vapidConfigured && (
          <button
            type="button"
            className="setting-row"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              try {
                const r = await testPush();
                // Audit-2 L71: surface WHICH device failed, not just
                // the count — the server now returns per-device results.
                // Audit-4 L25: endpointId disambiguates devices that
                // share a push host (two Chrome devices both report
                // fcm.googleapis.com).
                const failed = (r.results ?? []).filter((d) => !d.ok);
                toast.success(
                  r.sent > 0
                    ? `Test sent to ${r.sent}/${r.total} device(s) — check your notifications.` +
                      (failed.length > 0
                        ? ` Failed: ${failed.map((d) => `${d.endpointHost} [${d.endpointId}] (${d.status})`).join(", ")}.`
                        : "")
                    : "Test push failed on all devices.",
                );
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Test failed");
              } finally {
                setTesting(false);
              }
            }}
          >
            <span className="setting-icon">
              <Icon name="bell" />
            </span>
            <span>{testing ? "Sending…" : "Send test notification"}</span>
            <span className="arr">›</span>
          </button>
        )}
        {/* Audit-4 L40: per-device removal — a user at the 20-sub cap
            with stale rows can free a slot here instead of only
            via toggle-OFF (removeAll). */}
        {notifOn && pushStatus?.tableOk && <PushDeviceList variant="mobile" />}
        {(() => {
          // Audit-2 L45: TURN status surfaced in You settings (desktop parity).
          const turn = getTurnStatus();
          return (
            <div className="setting-row">
              <span className="setting-icon">
                <Icon name="user" />
              </span>
              <span>Call relay (TURN)</span>
              <span className="arr" style={turn.partial ? { color: "#DC2626" } : undefined}>
                {turn.configured ? "On" : turn.partial ? "Partial" : "STUN-only"}
              </span>
            </div>
          );
        })()}
        <button
          type="button"
          className="setting-row"
          onClick={toggle}
          // Audit-2 L61: a plain button doesn't announce state — a
          // switch does (privacy rows already use role="switch").
          role="switch"
          aria-checked={theme === "dark"}
        >
          <span className="setting-icon">
            {/* Audit-3 A6-N9: distinct icons — sun/moon follow the theme. */}
            <Icon name={theme === "dark" ? "moon" : "sun"} />
          </span>
          <span>Appearance</span>
          <span className="arr">{theme === "dark" ? "Dark" : "Light"}</span>
        </button>
        <button
          type="button"
          className="setting-row"
          onClick={() => void toggleVisibility()}
          // H41: disabled until the profile loads — the toggle's state
          // (public/private) is unknown before then, and tapping it
          // early could flip it the wrong way.
          disabled={visSaving || !myProfile}
        >
          <span className="setting-icon">
            <Icon name="eye" />
          </span>
          <span>Profile visibility</span>
          <span className="arr">{isPublic ? "Public" : "Private"}</span>
        </button>
        <button type="button" className="setting-row" onClick={() => setCredMode("password")}>
          <span className="setting-icon">
            <Icon name="key" />
          </span>
          <span>Change password</span>
          <span className="arr">›</span>
        </button>
        <button type="button" className="setting-row" onClick={() => setCredMode("email")}>
          <span className="setting-icon">
            <Icon name="mail" />
          </span>
          <span>Change email</span>
          <span className="arr">›</span>
        </button>
        <button type="button" className="setting-row" onClick={() => void doSignOut()}>
          <span className="setting-icon">
            <Icon name="logout" />
          </span>
          <span>Sign out</span>
          <span className="arr">›</span>
        </button>
        <button type="button" className="setting-row" onClick={() => void doSignOutEverywhere()}>
          <span className="setting-icon">
            <Icon name="logout" />
          </span>
          <span>Sign out everywhere</span>
          <span className="arr">›</span>
        </button>
      </div>
      <p style={{ margin: "8px 2px 0", fontSize: 11, lineHeight: 1.5, color: "#6B7280" }}>
        Sign out signs you out on this device only. Sign out everywhere signs you out on all
        devices — use it on a shared or lost device.
      </p>
      {/* M98: Danger zone (desktop parity) — delete used to be an
          unexplained red row inside the settings list. */}
      <p
        style={{
          margin: "18px 2px 6px",
          fontSize: 11,
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "#6B7280",
        }}
      >
        Danger zone
      </p>
      <div className="settings-list">
        <button
          type="button"
          className="setting-row"
          onClick={() => setDeleteOpen(true)}
          style={{ color: "#DC2626" }}
        >
          <span className="setting-icon">
            <Icon name="trash" />
          </span>
          <span>Delete account</span>
          <span className="arr">›</span>
        </button>
      </div>
      <p style={{ margin: "8px 2px 0", fontSize: 11, lineHeight: 1.5, color: "#6B7280" }}>
        Permanently deletes your account after email verification. This cannot be undone.
      </p>
      <DeleteAccountDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={async () => {
          // M58: same as desktop profile — the account is already
          // deleted server-side, so sign out is best-effort; always
          // navigate away (doSignOut would stay put on failure).
          try {
            await signOut();
          } catch {
            // ignore — account is gone
          }
          navigate({ to: "/", replace: true });
        }}
      />
    </>
  );
}
