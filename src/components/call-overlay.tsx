import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { CallEngine, newCallId, type CallState, type CallType, type CallVerification, IDLE_STATE } from "@/lib/calls";
import { initialsOf } from "@/lib/initials";
import {
  createCallInvite,
  getCallInvite,
  getCallStatus,
  getOrCreateDm,
  getPendingInvites,
  notifyIncomingCall,
  postCallMessage,
  reportCallEvent,
} from "@/lib/chat.functions";
import { toast } from "sonner";

type CallCtx = {
  call: CallState;
  startCall: (peerId: string, peerName: string, type: CallType) => Promise<void>;
  acceptCall: () => Promise<void>;
  declineCall: () => Promise<void>;
  endCall: () => Promise<void>;
  toggleMute: () => Promise<void>;
  toggleVideo: () => Promise<void>;
};

const Ctx = createContext<CallCtx | null>(null);

export function useCall(): CallCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCall must be used within CallProvider");
  return ctx;
}

// Audit-7 D2: initials come from the shared letters-only
// initialsOf (@/lib/initials) — the local copy here took the first
// CHARACTER of the last word, so "HAMZA (Admin)" rendered "H(".

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Audit-4 L18: classify an acceptCall failure for the toast.
// Returns null when the toast must be SUPPRESSED — the user's own
// Decline/End pre-empted the accept (engine.acceptWasCancelled),
// so its failure is moot: the call already ended deliberately,
// and a "Could not answer" toast after a deliberate Decline/End
// is spurious. Otherwise returns the truthful message: the
// engine's own delivery/offer errors verbatim ("Offer never
// arrived", "Accept/Answer could not be delivered" — previously
// all mis-rendered as "microphone/camera permission needed"),
// permission errors as permission, device errors as device
// errors, and anything else as a generic retry message (never
// a permission claim for an unknown failure).
function acceptFailureToast(err: unknown, acceptCancelled: boolean): string | null {
  if (acceptCancelled) return null;
  const message = err instanceof Error ? err.message : "";
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError")
      return "Could not answer — microphone/camera permission needed.";
    if (err.name === "NotFoundError") return "Could not answer — no microphone or camera found.";
    if (err.name === "NotReadableError")
      return "Could not answer — microphone or camera is in use by another app.";
  }
  if (/permission|not allowed|denied/i.test(message))
    return "Could not answer — microphone/camera permission needed.";
  // Audit-4 L19: "Offer could not be applied" joins the verbatim
  // set — the offer DID arrive but setRemoteDescription rejected
  // it; the toast must carry the true cause.
  if (
    message.startsWith("Offer never arrived") ||
    message.startsWith("Offer could not be applied") ||
    message.startsWith("Accept could not be delivered") ||
    message.startsWith("Answer could not be delivered")
  )
    return message;
  return "Could not answer — please try again.";
}

const OVERLAY_CSS = `
.vt-call-overlay{position:fixed;inset:0;z-index:200;background:rgba(17,24,39,.55);backdrop-filter:blur(6px);display:grid;place-items:end center;}
.vt-call-sheet{width:100%;max-width:480px;background:#fff;border-radius:28px 28px 0 0;padding:34px 22px calc(22px + env(safe-area-inset-bottom));text-align:center;box-shadow:0 -12px 40px rgba(0,0,0,.25);}
.vt-call-pulse{width:118px;height:118px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;background:#DCFCE7;box-shadow:0 0 0 12px #F0FDF4,0 0 0 24px rgba(220,252,231,.45);}
.vt-call-avatar{width:92px;height:92px;border-radius:50%;background:#15803D;color:#fff;display:grid;place-items:center;font-size:34px;font-weight:800;}
.vt-call-sheet h2{margin:0;font-size:24px;font-weight:800;color:#111827;letter-spacing:-.4px;}
.vt-call-status{margin-top:6px;font-size:13px;color:#6B7280;font-weight:600;}
/* Audit-2 C2: persistent banner while the call runs in the degraded
   (table-missing, unverified) mode. Amber, high-contrast, impossible
   to miss — a silent fail-open is exactly what C2 forbids. */
.vt-call-degraded-banner{margin:10px 16px 0;padding:8px 12px;border-radius:10px;background:#FEF3C7;color:#92400E;font-size:12px;font-weight:600;line-height:1.4;text-align:center;}
.vt-call-tools{display:flex;justify-content:center;gap:26px;margin:26px 0 20px;}
.vt-call-tool{display:flex;flex-direction:column;align-items:center;gap:7px;}
.vt-call-tool button{width:58px;height:58px;border-radius:50%;border:0;background:#F0FDF4;color:#15803D;font-size:22px;cursor:pointer;transition:transform .15s,background .15s;}
.vt-call-tool button:active{transform:scale(.94);}
.vt-call-tool button.on{background:#15803D;color:#fff;}
/* Audit-3 A5-N7: queued video upgrade — amber, gently pulsing. */
.vt-call-tool button.pending{background:#FEF3C7;color:#92400E;animation:vt-pending-pulse 1.2s ease-in-out infinite;}
@keyframes vt-pending-pulse{50%{opacity:.6;}}
.vt-call-tool span{font-size:11px;font-weight:700;color:#374151;}
.vt-call-answer-row{display:flex;gap:12px;margin:26px 0 8px;}
.vt-call-decline,.vt-call-accept{flex:1;border:0;border-radius:999px;padding:15px 0;font-size:15px;font-weight:800;cursor:pointer;}
.vt-call-decline{background:#FEE2E2;color:#991B1B;}
.vt-call-accept{background:#15803D;color:#fff;}
.vt-call-end{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:999px;background:#DC2626;color:#fff;padding:14px 30px;font-size:15px;font-weight:800;cursor:pointer;}
.vt-call-note{font-size:10px;color:#9CA3AF;line-height:1.45;margin:13px 5px 0;}
.vt-call-video-wrap{position:relative;width:100%;aspect-ratio:3/4;max-height:52vh;background:#111827;border-radius:20px;overflow:hidden;margin-bottom:14px;}
.vt-call-remote-video{width:100%;height:100%;object-fit:cover;}
.vt-call-local-video{position:absolute;right:12px;bottom:12px;width:104px;height:140px;object-fit:cover;border-radius:14px;border:2px solid #fff;background:#111827;}
.vt-screen-off{position:fixed;inset:0;z-index:400;background:#000;display:grid;place-items:end center;padding-bottom:calc(48px + env(safe-area-inset-bottom));touch-action:none;}
.vt-screen-off-hint{font-size:13px;color:#fff;font-weight:600;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.45);border-radius:999px;padding:10px 18px;}
/* Audit-3 A6-N1: moved here from MOBILE_CSS (M82) — the sheet is
   hardcoded light, so a plain invert converts it (no new dark design:
   convert the light one). OVERLAY_CSS is mounted by CallProvider in
   the _app layout above every page, while MOBILE_CSS only mounts
   inside <MobileShell> — so on conversation pages (RoomsLayout renders
   the conversation without MobileShell) the sheet used to stay glaring
   white in dark mode. The video wrap counter-inverts so the wrap stays
   dark and the camera feeds come back to normal (sheet-invert + wrap
   counter-invert = net zero for video). The backdrop and the pure-black
   screen-off layer are outside the sheet, so they stay dark/black
   untouched. */
.dark .vt-call-sheet{filter:invert(1) hue-rotate(180deg)}
.dark .vt-call-sheet .vt-call-video-wrap{filter:invert(1) hue-rotate(180deg)}
`;

/**
 * Global call provider: one CallEngine per login, incoming calls ring on
 * every page (not just the mobile shell). Renders the full-screen call
 * overlay in the prototype's design, remapped to the homepage green.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [call, setCall] = useState<CallState>({ ...IDLE_STATE });
  const notifyCall = useServerFn(notifyIncomingCall);
  const fetchInvite = useServerFn(getCallInvite);
  const getDm = useServerFn(getOrCreateDm);
  const postCallMsg = useServerFn(postCallMessage);
  const fetchPendingInvites = useServerFn(getPendingInvites);
  const createInvite = useServerFn(createCallInvite);
  const reportEvent = useServerFn(reportCallEvent);
  const fetchStatus = useServerFn(getCallStatus);
  const engineRef = useRef<CallEngine | null>(null);
  // Audit-3 A5-N2: provider-level in-flight guard for startCall (see below).
  const startCallInFlightRef = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!user) {
      engineRef.current?.stop();
      engineRef.current = null;
      setCall({ ...IDLE_STATE });
      return;
    }
    const name =
      (user.user_metadata?.display_name as string | undefined) ?? user.email ?? "Someone";
    const engine = new CallEngine(user.id, name, {
      // WhatsApp-style call entry in the chat thread: the CALLER posts one
      // message per finished call (missed / attended + duration). The callee
      // side skips, so one call yields exactly one entry. Best-effort.
      onCallFinished: (info) => {
        // M43: the calls row is already inserted (engine finish() awaits
        // recordCallRow before this callback), so invalidate for BOTH
        // directions — an incoming finished/missed call must appear in
        // Calls history without a remount.
        queryClient.invalidateQueries({ queryKey: ["calls"] });
        if (info.direction !== "outgoing") return;
        void (async () => {
          try {
            const { roomId } = await getDm({ data: { otherUserId: info.peerId } });
            await postCallMsg({
              data: {
                roomId,
                callId: info.callId,
                type: info.type,
                status: info.status,
                durationSeconds: info.durationSeconds,
              },
            });
          } catch {
            // Chat entry is a nicety; a failure must never surface as a
            // call error (privacy-blocked DM, rate guard, or DB hiccup).
          }
        })();
      },
      // Audit-2 C2: an invite dropped because verification itself
      // failed (network/server down after one retry) must be
      // user-visible — otherwise the caller hears endless ringing
      // while the callee never rang.
      onUnverifiedInvite: () => {
        toast.error("Couldn't verify caller — blocked an unverified call.");
      },
      // Audit-2 M34: a video toggle whose re-offer failed twice
      // (after one retry) must surface — the UI must not claim
      // video is on when the peer never got it.
      onVideoToggleFailed: (direction) => {
        toast.error(
          direction === "on"
            ? "Couldn't turn on video — your camera wasn't shared. Tap the video button to try again."
            : "Couldn't turn off video for the other person — they may still see your last frame. Tap the video button to retry.",
        );
      },
      // Audit-4 L21: partial TURN used to warn to console only —
      // the user got a silent call failure behind symmetric /
      // restrictive NAT. Surface it as a toast the first time a
      // call needs the relay (engine fires once per session).
      onTurnPartial: (missing) => {
        toast.warning(
          `Calls may fail on some networks — the call relay (TURN) is only partially configured (missing: ${missing.join(", ")}).`,
        );
      },
      // C4: server-side signal verification. The Realtime channel is
      // public, so `signal.from` is spoofable — the engine verifies
      // invite / accept / decline / end signals against the call_invites
      // row (server-side truth) instead of trusting the signal.
      verify: {
        verifyInvite: async (callId, from, type) => {
          const { invite, tableMissing } = await fetchInvite({ data: { callId } });
          // Table doesn't exist yet -> fail open (pre-C4 behaviour).
          // Audit-2 C1: pass the per-call HMAC secret through (null in
          // degraded mode) so the engine can MAC-verify payload signals.
          if (tableMissing)
            return { ok: true, fromName: null, secret: null, tableMissing: true };
          if (!invite)
            return { ok: false, fromName: null, secret: null, tableMissing: false };
          if (invite.from !== from || invite.type !== type) {
            return { ok: false, fromName: null, secret: null, tableMissing: false };
          }
          return {
            ok: true,
            fromName: invite.fromName,
            secret: invite.secret ?? null,
            tableMissing: false,
          };
        },
        verifyCallStatus: async (callId, expectedStatus, expectedFrom, myId) => {
          const { status, callerId, calleeId, tableMissing } = await fetchStatus({
            data: { callId },
          });
          // Audit-2 C2: tableMissing is passed through (not collapsed
          // into a bare boolean) so the engine can tell "no table"
          // (fail open, degraded + banner) apart from "no" (drop).
          if (tableMissing) return { ok: true, tableMissing: true };
          if (status !== expectedStatus) return { ok: false, tableMissing: false };
          // signal.from must be the OTHER participant, and I must be one too.
          const ok =
            (callerId === myId && calleeId === expectedFrom) ||
            (calleeId === myId && callerId === expectedFrom);
          return { ok, tableMissing: false };
        },
        reportCallEvent: async (callId, event) => {
          try {
            // Audit-2 H17: return the server result — acceptCall needs
            // to know whether the accept actually landed (terminal).
            return await reportEvent({ data: { callId, event } });
          } catch {
            // Best-effort: unknown, NOT terminal — the caller of
            // reportEvent decides (accept proceeds: the row write may
            // have landed with a lost response, and the accept signal
            // is verified against the row by the caller).
            return { ok: false, applied: false, terminal: false };
          }
        },
      } satisfies CallVerification,
    });
    engineRef.current = engine;
    const off = engine.subscribe(setCall);
    engine.start();
    // Audit-2 M37: tab close / navigation must hang up — without
    // this the peer hangs until the ring timeout / ICE detection.
    // pagehide covers mobile browsers that never fire beforeunload.
    // persisted (bfcache) skips the hangup: the page is frozen, not
    // gone, and Back should resume the call, not end it. stop()
    // (below + logout branch) also hangs up first, covering
    // unmount/logout.
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      engineRef.current?.hangupOnUnload();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      off();
      window.removeEventListener("pagehide", onPageHide);
      engine.stop();
      engineRef.current = null;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Pick / Reject from the incoming-call push notification. Two paths:
   *  - App tab alive (already ringing): answer / decline directly.
   *  - App was closed: fetch the persisted invite and reconstruct ringing;
   *    Pick auto-accepts once the caller re-sends the offer.
   */
  const handleNotificationAction = useCallback(
    async (action: "accept" | "decline", callId: string) => {
      const engine = engineRef.current;
      if (!engine) return;
      const snap = engine.snapshot;
      if (snap.status === "ringing" && snap.callId === callId) {
        if (action === "accept") {
          try {
            await engine.acceptCall();
          } catch (err) {
            // Audit-4 L18: classify — never a blanket permission
            // toast; suppressed entirely when the user's own
            // Decline/End pre-empted the accept.
            const msg = acceptFailureToast(err, engine.acceptWasCancelled);
            if (msg) toast.error(msg);
          }
        } else {
          await engine.declineCall();
        }
        return;
      }
      // Audit-4 L17: "ended" counts as idle here too (same 600 ms
      // flash rule as recoverPendingCall above and the engine's
      // invite path, A5-N5). Pick/Reject within 600 ms of a
      // previous call ending used to busy-decline the NEW invite +
      // toast "Already in a call.", even though the user was
      // actually free — the fall-through below fetches the invite
      // and rings it via ringFromInvite (which itself accepts
      // "ended").
      if (snap.status !== "idle" && snap.status !== "ended") {
        // Audit-2 M36: busy-decline instead of a bare toast — the new
        // caller must hear "declined" in ~2s, not ring 30s to "missed".
        // A different callId only (the same-call ringing case returned
        // above); Pick-while-busy declines too — two calls can't be
        // answered at once. Best-effort: if the invite is already gone
        // (call ended), there is nothing left to decline.
        if (callId !== snap.callId) {
          try {
            const { invite } = await fetchInvite({ data: { callId } });
            if (invite) await engine.declineBusyCall(callId, invite.from, invite.type, invite.fromName);
          } catch {
            /* best-effort busy-decline */
          }
        }
        toast.error("Already in a call.");
        return;
      }
      try {
        const { invite } = await fetchInvite({ data: { callId } });
        if (!invite) {
          toast.error("This call has already ended.");
          return;
        }
        await engine.ringFromInvite(invite, action);
      } catch {
        toast.error("Could not pick up this call.");
      }
    },
    [fetchInvite],
  );

  // Pick / Reject tapped in the push notification while a tab is alive: the
  // service worker forwards the tap here via postMessage.
  // M21: recoverPendingCall is shared by the mount effect AND the SW
  // plain-tap recover message (a live tab that missed the invite needs
  // the same re-check without a reload). mountedRef guards the
  // post-fetch race on unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Audit-3 A5-N14: set while a notification action (Pick/Reject from
  // a push, or the ?call= URL) is being handled. Mount recovery must
  // not ring a DIFFERENT pending invite in that window — the
  // notification handler would then busy-decline the very call the
  // user tapped Pick for. Set synchronously at the call sites
  // (before any await), cleared when the handler settles.
  const notificationActionRef = useRef<string | null>(null);
  // Audit-3 A5-N15: set when recovery actually rings an invite — the
  // re-run effect below re-checks for a second pending invite after
  // that recovered call ends.
  const recoveredCallRef = useRef(false);
  const recoverPendingCall = useCallback(async () => {
    try {
      // Audit-3 A5-N14: a notification action is in flight — its
      // handler owns the ringing; recovery stays out of the way.
      if (notificationActionRef.current) return;
      const { invites } = await fetchPendingInvites();
      if (!mountedRef.current || invites.length === 0) return;
      const engine = engineRef.current;
      // Audit-3 A5-N14/N15: "ended" counts as idle here too (same
      // 600 ms flash rule as the engine's invite path, A5-N5) — the
      // ?call= handler's finally re-run lands in this window when the
      // tapped call was declined, and a second pending invite must
      // still surface instead of waiting for a re-run that never comes.
      if (!engine || (engine.snapshot.status !== "idle" && engine.snapshot.status !== "ended")) return;
      await engine.ringFromInvite(invites[0], null);
      // Audit-3 A5-N15: this invite rang via recovery — after it
      // ends, re-run recovery for a second pending invite.
      recoveredCallRef.current = true;
    } catch {
      // Recovery is best-effort; a live invite still rings on its own.
    }
  }, [fetchPendingInvites]);
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; action?: string; callId?: string } | null;
      if (!d) return;
      // Audit-2 M57: ack the SW's postMessage — without this, a tap
      // on a still-loading tab is lost (no listener yet, no error).
      // The SW waits ~1.5s for the ack, then navigates the tab to
      // the ?call= URL as a fallback. Ack = "listener mounted", not
      // "action completed" — post it BEFORE handling the action.
      if (d.type === "vibetalk-call-action" || d.type === "vibetalk-call-recover") {
        try {
          e.ports?.[0]?.postMessage({ type: "vibetalk-call-action-ack", callId: d.callId ?? null });
        } catch {
          // Ack is best-effort; the SW's navigate fallback covers a miss.
        }
      }
      if (d.type === "vibetalk-call-action") {
        if ((d.action === "accept" || d.action === "decline") && typeof d.callId === "string" && d.callId) {
          // Audit-3 A5-N14: mark the action in flight so a concurrent
          // recovery run can't ring a different invite first (the
          // handler would then busy-decline this tapped call). The
          // re-run covers the hole the skip opens: if this action
          // ends with the engine idle (call already gone / declined),
          // a second pending invite must still surface.
          notificationActionRef.current = d.callId;
          void handleNotificationAction(d.action, d.callId).finally(() => {
            if (notificationActionRef.current === d.callId) notificationActionRef.current = null;
            void recoverPendingCall();
          });
        }
        return;
      }
      // M21: plain-tap on the notification while a live tab exists —
      // re-check pending invites (the tab may have missed the Realtime
      // invite and never started ringing).
      if (d.type === "vibetalk-call-recover") {
        void recoverPendingCall();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [handleNotificationAction, recoverPendingCall]);

  // Pick / Reject tapped in the push notification while the app was closed:
  // the service worker opens the app with ?call=accept|decline&callId=...
  useEffect(() => {
    if (!user) return;
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(window.location.search);
    } catch {
      return;
    }
    const action = params.get("call");
    const callId = params.get("callId");
    if (action === "accept" || action === "decline") {
      // Audit-2 L6: ALWAYS clean the params — even without a callId —
      // so a stale ?call=accept URL (landed here directly, or forwarded
      // before the landing fix) never dangles on /rooms.
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("call");
        url.searchParams.delete("callId");
        url.searchParams.delete("from");
        url.searchParams.delete("callType");
        window.history.replaceState(null, "", url.toString());
      } catch {
        // URL cleanup is cosmetic; the action still runs.
      }
      if (callId) {
        // Audit-3 A5-N14: same guard as the SW path above — the
        // ?call= effect runs before the mount-recovery effect, so
        // setting this synchronously here makes recovery skip while
        // the tapped call is being handled.
        notificationActionRef.current = callId;
        void handleNotificationAction(action, callId).finally(() => {
          if (notificationActionRef.current === callId) notificationActionRef.current = null;
          void recoverPendingCall();
        });
      }
    }
  }, [user, handleNotificationAction, recoverPendingCall]);

  // Recover a ringing call no matter how the app was opened. If the callee
  // opened the app via a message notification (or manually) mid-call, the
  // Realtime invite was already missed — but the persisted invite is still
  // fresh, so reconstruct ringing and show Pick / Decline. If the engine is
  // already ringing (live invite arrived), ringFromInvite no-ops.
  useEffect(() => {
    if (!user) return;
    void recoverPendingCall();
  }, [user, recoverPendingCall]);

  // Audit-3 A5-N15: after a recovered call ends, re-run recovery — a
  // second simultaneous pending invite must surface too (first rings;
  // second rings after the first ends). The flag is set only by
  // recoverPendingCall, so ordinary calls never trigger a re-run.
  const prevCallStatusRef = useRef(call.status);
  useEffect(() => {
    const prev = prevCallStatusRef.current;
    prevCallStatusRef.current = call.status;
    if (prev !== "idle" && call.status === "idle" && recoveredCallRef.current) {
      recoveredCallRef.current = false;
      void recoverPendingCall();
    }
  }, [call.status, recoverPendingCall]);

  // The PEER may turn video on too — show the video layout when the remote
  // stream carries a live video track, not only when WE toggled video.
  const remoteHasVideo = (call.remoteStream?.getVideoTracks() ?? []).some(
    (t) => t.readyState === "live",
  );
  const showVideo =
    call.status === "in-call" && (call.type === "video" || call.isVideoOn || remoteHasVideo);

  // Bind streams to the media elements whenever they change.
  // showVideo is a dep on purpose: when video is toggled on mid-call, the
  // <video> elements mount fresh — without this, they never get srcObject
  // (stream refs + status don't change on upgrade) and stay black.
  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = call.remoteStream;
      if (call.remoteStream) {
        void remoteAudioRef.current.play().catch(() => undefined);
      }
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = call.remoteStream;
      if (call.remoteStream) {
        void remoteVideoRef.current.play().catch(() => undefined);
      }
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = call.localStream;
      if (call.localStream) {
        void localVideoRef.current.play().catch(() => undefined);
      }
    }
  }, [call.remoteStream, call.localStream, call.status, showVideo]);

  const startCall = useCallback(async (peerId: string, peerName: string, type: CallType) => {
    const engine = engineRef.current;
    if (!engine) {
      toast.error("Sign in to place calls.");
      return;
    }
    // Already on a voice call with this person + Video tapped: upgrade this
    // call instead of erroring with "Already in a call."
    const snap = engine.snapshot;
    if (
      snap.status !== "idle" &&
      snap.peerId === peerId &&
      type === "video" &&
      snap.type === "voice" &&
      !snap.isVideoOn
    ) {
      try {
        await engine.setVideoEnabled(true);
        // M25: if the call isn't connected yet, the upgrade is queued
        // until in-call — say so, or the tap looks dead.
        if (snap.status === "calling" || snap.status === "ringing") {
          toast.info("Video will turn on once the call connects.");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Camera not available.");
      }
      return;
    }
    // Audit-3 A5-N2: provider-level in-flight guard — a rapid double-tap
    // used to fire two startCall invocations: both wrote invite rows,
    // the second threw "Already in a call." and its row leaked as a
    // ringing orphan (audit-2 L48's toast was the visible symptom).
    // The second invocation now returns silently before writing a row.
    if (startCallInFlightRef.current) return;
    startCallInFlightRef.current = true;
    // Hoisted so the catch can clean up the invite row this attempt wrote.
    let callId: string | null = null;
    try {
      // C4: write the invite row BEFORE the Realtime invite signal goes
      // out, so the callee's server-side verification finds it. The callId
      // is minted here (not inside the engine) for exactly this reason.
      callId = newCallId();
      // Audit-2 C1: createCallInvite returns the per-call HMAC secret;
      // the engine needs it before the offer goes out.
      // Audit-4 H1: the old code swallowed EVERY createCallInvite
      // failure (a throw AND an ok:false) and started the engine
      // anyway: the callee's verifyInvite finds no usable row, drops
      // the invite, and the caller hears 30s of ringback for a call
      // that never existed, then records "missed". Now: ANY failure
      // except a positively confirmed missing table aborts BEFORE
      // the engine starts — the throw propagates to the outer catch
      // below, which reports "ended" (cleaning up a row this attempt
      // may have written) and toasts the reason. Only
      // tableMissing === true keeps the degraded path (pre-SQL
      // compat: the callee fails open on a missing table, audit-2 C2).
      const res = await createInvite({ data: { peerId, callId, type } });
      if (!res.ok && !res.tableMissing) {
        throw new Error("Could not start the call — please try again.");
      }
      const secret: string | null = res.secret ?? null;
      const degraded = res.tableMissing ?? false;
      await engine.startCall(peerId, peerName, type, callId, { secret, degraded });
      // Audit-3 A5-N3: the engine may have returned early — End tapped
      // while the permission prompt was open unwinds the start without
      // resurrecting the call. Do NOT notify the callee for a call that
      // already ended (phantom push for a dead callId), or for a
      // different call that started since. calling/ringing/in-call
      // with this callId all mean "still alive".
      {
        const snap = engine.snapshot;
        if (
          snap.callId !== callId ||
          snap.status === "idle" ||
          snap.status === "ended"
        ) {
          return;
        }
      }
      // Best-effort incoming-call push (Pick / Reject + vibration) to the
      // callee's devices. The Realtime invite already went — a push failure
      // must never break the call, so no toast on failure.
      void notifyCall({ data: { peerId, callId, type } }).catch((err) => {
        // Silent to the user (the Realtime invite already went), but
        // logged — a failed call push is the thing that makes a call
        // silently never arrive, so it must leave a trace.
        console.warn("[call] notifyIncomingCall failed", err);
      });
    } catch (err) {
      // Audit-3 A5-N2: the engine's own catch reports "ended" only for
      // a callId the engine actually started; the "Already in a call."
      // guard throw happens before the engine ever learns this callId,
      // so nobody cleaned up the row this attempt wrote. Best-effort
      // "ended" here — a duplicate is a no-op (terminal rows ignore it).
      if (callId) {
        void reportEvent({ data: { callId, event: "ended" } }).catch(() => null);
      }
      toast.error(
        err instanceof Error
          ? err.message.includes("Permission")
            ? "Microphone/camera permission is needed for calls."
            : err.message
          : "Could not start the call.",
      );
    } finally {
      startCallInFlightRef.current = false;
    }
  }, []);

  const acceptCall = useCallback(async () => {
    const engine = engineRef.current;
    try {
      await engine?.acceptCall();
    } catch (err) {
      // Audit-4 L18: classify — see handleNotificationAction.
      const msg = acceptFailureToast(err, engine?.acceptWasCancelled ?? false);
      if (msg) toast.error(msg);
    }
  }, []);

  const declineCall = useCallback(async () => {
    await engineRef.current?.declineCall();
  }, []);

  const endCall = useCallback(async () => {
    await engineRef.current?.endCall();
  }, []);

  const toggleMute = useCallback(async () => {
    const engine = engineRef.current;
    if (engine) await engine.setMuted(!engine.snapshot.isMuted);
  }, []);

  const toggleVideo = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    // Audit-3 A5-N7: a queued video upgrade is cancellable — tapping
    // Video again cancels the queue instead of re-queueing it.
    if (engine.snapshot.videoUpgradeQueued) {
      await engine.setVideoEnabled(false);
      toast.info("Video upgrade cancelled.");
      return;
    }
    const wasOn = engine.snapshot.isVideoOn;
    const status = engine.snapshot.status;
    try {
      await engine.setVideoEnabled(!wasOn);
      // M25: a video-on tap before connect queues the upgrade until
      // in-call — say so, or the tap looks dead.
      if (!wasOn && (status === "calling" || status === "ringing")) {
        toast.info("Video will turn on once the call connects.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Camera not available.");
    }
  }, []);

  const value = useMemo(
    () => ({ call, startCall, acceptCall, declineCall, endCall, toggleMute, toggleVideo }),
    [call, startCall, acceptCall, declineCall, endCall, toggleMute, toggleVideo],
  );

  const visible =
    call.status === "calling" || call.status === "ringing" || call.status === "in-call";

  const statusText =
    call.status === "calling"
      ? `Calling…`
      : call.status === "ringing"
        ? `Incoming ${call.type === "video" ? "video" : "voice"} call…`
        : call.status === "in-call"
          ? call.type === "video" || call.isVideoOn || remoteHasVideo
            ? `Video call · ${fmtElapsed(call.elapsedSeconds)}`
            : `Voice call · ${fmtElapsed(call.elapsedSeconds)}`
          : "";

  // Screen-off (proximity workaround): browsers give websites NO access to
  // the proximity sensor, so the screen can't turn off automatically on the
  // web. This black overlay is the closest the web can do — tap the
  // Screen-off button during a call and the screen goes black + touch is
  // blocked (no cheek-taps); double-tap to wake. Where the browser DOES
  // expose a ProximitySensor (Chromium with the sensor flag), it toggles
  // the overlay automatically on near/far.
  const [screenOff, setScreenOff] = useState(false);
  // Audit-2 H19: wake must not depend on dblclick alone (unreliable /
  // never fires for double-tap on iOS Safari / many Android WebViews)
  // — the old overlay trapped the user on a black screen with an
  // invisible hint and no other way out (End-call included). Wake on:
  // two touchend within 400ms (touch double-tap), a long-press
  // (touchend ≥800ms after touchstart), dblclick (mouse), or the
  // proximity sensor going far (existing effect below).
  const lastTapRef = useRef(0);
  const touchStartRef = useRef(0);
  const wakeScreen = () => setScreenOff(false);
  const onScreenOffTouchStart = () => {
    touchStartRef.current = Date.now();
  };
  const onScreenOffTouchEnd = () => {
    const now = Date.now();
    if (now - touchStartRef.current >= 800) {
      // Long-press — wake without arming a stale single tap.
      touchStartRef.current = 0;
      lastTapRef.current = 0;
      wakeScreen();
      return;
    }
    if (now - lastTapRef.current < 400) {
      lastTapRef.current = 0;
      wakeScreen();
    } else {
      lastTapRef.current = now;
    }
  };
  useEffect(() => {
    if (call.status === "idle") setScreenOff(false);
  }, [call.status]);
  useEffect(() => {
    if (call.status !== "in-call") return;
    let sensor: { stop?: () => void } | null = null;
    try {
      const SensorCtor = (
        window as unknown as {
          ProximitySensor?: new () => {
            addEventListener: (type: string, cb: () => void) => void;
            start: () => void;
            stop: () => void;
            near?: boolean;
          };
        }
      ).ProximitySensor;
      if (!SensorCtor) return;
      const s = new SensorCtor();
      sensor = s;
      s.addEventListener("reading", () => {
        setScreenOff(s.near ?? false);
      });
      s.addEventListener("error", () => {
        try {
          s.stop();
        } catch {
          /* sensor unavailable */
        }
      });
      s.start();
    } catch {
      // Proximity sensor not available in this browser — manual button only.
    }
    return () => {
      try {
        sensor?.stop?.();
      } catch {
        /* ignore */
      }
    };
  }, [call.status]);

  return (
    <Ctx.Provider value={value}>
      <style>{OVERLAY_CSS}</style>
      {children}
      {/* Hidden remote audio — always mounted while a call is live so the
          peer's voice plays even when video is off. */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />
      {screenOff && (call.status === "calling" || call.status === "in-call") && (
        <div
          className="vt-screen-off"
          onDoubleClick={wakeScreen}
          onTouchStart={onScreenOffTouchStart}
          onTouchEnd={onScreenOffTouchEnd}
          role="button"
          aria-label="Double-tap or hold to turn the screen back on"
        >
          {/* Audit-2 H19: the old hint was #222 on #000 (~1.3:1,
              effectively invisible). White on the translucent pill is
              ~15:1 — readable, and the pill is the visible wake target. */}
          <span className="vt-screen-off-hint">Double-tap or hold to wake</span>
        </div>
      )}
      {visible && (
        <div
          className="vt-call-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="vt-call-person"
        >
          <div className="vt-call-sheet">
            {showVideo ? (
              <div className="vt-call-video-wrap">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="vt-call-remote-video"
                />
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="vt-call-local-video"
                />
              </div>
            ) : (
              <div className="vt-call-pulse">
                <div className="vt-call-avatar">{initialsOf(call.peerName)}</div>
              </div>
            )}
            <h2 id="vt-call-person">{call.peerName}</h2>
            <div className="vt-call-status">{statusText}</div>
            {call.verificationDegraded && (
              <div className="vt-call-degraded-banner" role="alert">
                ⚠ Call verification is off — this call is unverified. Run the
                pending database setup to turn verification on.
              </div>
            )}
            {call.status === "ringing" ? (
              <div className="vt-call-answer-row">
                <button
                  type="button"
                  className="vt-call-decline"
                  onClick={() => void declineCall()}
                  aria-label="Decline call"
                  // Audit-2 M35: Decline stays enabled while an accept
                  // is in flight — it PRE-EMPTS the accept (the accept
                  // unwinds instead of landing after the user declined).
                  // Disabled only while a decline itself is running.
                  disabled={call.actionPending === "decline"}
                >
                  {call.actionPending === "decline" ? "Declining…" : "Decline"}
                </button>
                <button
                  type="button"
                  className="vt-call-accept"
                  onClick={() => void acceptCall()}
                  aria-label="Accept call"
                  disabled={call.actionPending === "accept" || call.actionPending === "decline"}
                >
                  {call.actionPending === "accept" ? "Accepting…" : "Accept"}
                </button>
              </div>
            ) : (
              <div className="vt-call-tools">
                <div className="vt-call-tool">
                  <button
                    type="button"
                    className={call.isMuted ? "on" : ""}
                    onClick={() => void toggleMute()}
                    aria-label={call.isMuted ? "Unmute microphone" : "Mute microphone"}
                    aria-pressed={call.isMuted}
                  >
                    {call.isMuted ? "🔇" : "🎤"}
                  </button>
                  <span>{call.isMuted ? "Unmute" : "Mute"}</span>
                </div>
                {/* M27: no Speaker button on purpose — the web has no
                    earpiece↔speaker API, and setSinkId("default") vs
                    setSinkId("") is a no-op, so the old toggle changed
                    state but routed no audio. Real speaker switching
                    needs the native app (AudioManager). */}
                <div className="vt-call-tool">
                  <button
                    type="button"
                    // Audit-3 A5-N7: a queued upgrade shows a pending
                    // state (tappable to cancel), not a plain OFF.
                    className={call.isVideoOn ? "on" : call.videoUpgradeQueued ? "pending" : ""}
                    onClick={() => void toggleVideo()}
                    aria-label={call.videoUpgradeQueued ? "Cancel queued video upgrade" : "Toggle video"}
                    aria-pressed={call.isVideoOn}
                    title={call.videoUpgradeQueued ? "Video upgrade queued — tap to cancel" : "Toggle video"}
                  >
                    📹
                  </button>
                  <span>Video</span>
                </div>
                <div className="vt-call-tool">
                  <button
                    type="button"
                    onClick={() => setScreenOff(true)}
                    aria-label="Turn screen off"
                  >
                    📴
                  </button>
                  <span>Screen off</span>
                </div>
              </div>
            )}
            {call.status !== "ringing" && (
              <button
                type="button"
                className="vt-call-end"
                onClick={() => void endCall()}
                aria-label="End call"
                // Audit-2 M35: busy state instead of a silently
                // dropped second tap.
                disabled={call.actionPending === "end"}
              >
                {call.actionPending === "end" ? "Ending…" : "End call"}
              </button>
            )}
            <p className="vt-call-note">
              1:1 call — audio/video goes directly to the other person.
            </p>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
