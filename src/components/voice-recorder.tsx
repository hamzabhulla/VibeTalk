import { useEffect, useRef, useState } from "react";
import { Trash2, Send } from "lucide-react";
import { toast } from "sonner";

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Audit-3 A4-N23: 10-minute cap — an uncapped recorder could run for
// hours and produce a multi-hundred-MB clip.
const MAX_SECONDS = 10 * 60;

/**
 * Recording UI: red dot, timer, animated waveform, discard + send.
 * Starts recording on mount; calls onSend with the audio file when the user
 * hits send, onCancel when discarded.
 */
export function VoiceRecorder({
  onSend,
  onCancel,
}: {
  onSend: (file: File) => void;
  onCancel: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [capped, setCapped] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : "";
        const rec = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
        chunksRef.current = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.start();
        recRef.current = rec;
        if (alive) setReady(true);
        timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
      } catch {
        if (alive) {
          setFailed(true);
          toast.error("Microphone access was denied.");
        }
      }
    })();
    return () => {
      alive = false;
      if (timerRef.current) window.clearInterval(timerRef.current);
      const rec = recRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Stop the recorder + timer without sending or discarding —
  // used by the 10-minute cap (the captured clip stays sendable).
  const stopOnly = () => {
    const rec = recRef.current;
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
  };

  const sendClip = () => {
    const rec = recRef.current;
    if (chunksRef.current.length > 0) {
      const blob = new Blob(chunksRef.current, { type: rec?.mimeType || "audio/webm" });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
      onSend(file);
    } else {
      onCancel();
    }
  };

  // Audit-3 A4-N23: when the cap hits, stop recording but keep the
  // clip — the user can still send or discard it.
  useEffect(() => {
    if (seconds < MAX_SECONDS || capped) return;
    stopOnly();
    setCapped(true);
    toast.info("Voice message capped at 10 minutes — send or discard it.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, capped]);

  const finish = (send: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const rec = recRef.current;
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (!rec || rec.state === "inactive") {
      // Already stopped (cap hit) — send the captured clip or discard.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (send) sendClip();
      else onCancel();
      return;
    }
    rec.onstop = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (send && chunksRef.current.length > 0) {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: blob.type });
        onSend(file);
      } else {
        onCancel();
      }
    };
    rec.stop();
  };

  if (failed) {
    return (
      <div className="flex min-h-[56px] items-center justify-center px-4 text-sm text-muted-foreground">
        Microphone unavailable.
        <button
          type="button"
          onClick={onCancel}
          className="ml-3 rounded-lg px-3 py-1.5 text-xs font-bold text-primary hover:bg-secondary"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[56px] items-center gap-2 px-2">
      <span className="relative flex h-3 w-3 shrink-0">
        {!capped && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60" />
        )}
        <span className="relative inline-flex h-3 w-3 rounded-full bg-destructive" />
      </span>
      {/* Audit-3 A4-N23: visible countdown against the 10-minute cap. */}
      <span
        className={`w-24 shrink-0 text-sm font-bold tabular-nums ${seconds >= MAX_SECONDS - 60 ? "text-destructive" : ""}`}
      >
        {formatTime(seconds)} / 10:00
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-[3px]" aria-hidden="true">
        {Array.from({ length: 32 }).map((_, i) => (
          <span
            key={i}
            className="w-[3px] shrink-0 rounded-full bg-primary/70 animate-pulse"
            style={{
              height: `${8 + Math.abs(Math.sin(i * 1.7)) * 18}px`,
              animationDelay: `${(i % 7) * 120}ms`,
              animationDuration: "900ms",
            }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => finish(false)}
        aria-label="Discard recording"
        className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="h-5 w-5" />
      </button>
      <button
        type="button"
        onClick={() => finish(true)}
        disabled={!ready}
        aria-label="Send voice message"
        title={ready ? "Send voice message" : "Waiting for microphone…"}
        className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[13px] bg-primary text-primary-foreground shadow-md transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        <Send className="h-[19px] w-[19px]" />
      </button>
    </div>
  );
}
