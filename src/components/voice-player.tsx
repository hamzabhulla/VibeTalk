import { useEffect, useRef, useState } from "react";
import { Play, Pause } from "lucide-react";

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * WhatsApp-style voice message player: play/pause, waveform progress,
 * current time / total duration. Stops other instances when one plays.
 */
export function VoicePlayer({ url, mine, onError }: { url: string; mine: boolean; onError?: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  // Deterministic fake waveform — same bars every render.
  const bars = useRef<number[]>([]);
  if (bars.current.length === 0) {
    bars.current = Array.from({ length: 28 }, (_, i) => 6 + Math.abs(Math.sin(i * 2.3)) * 18);
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setCurrent(audio.currentTime);
      setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
    };
    const onMeta = () => setDuration(audio.duration || 0);
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
      setCurrent(0);
    };
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnd);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("play", onPlay);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnd);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("play", onPlay);
    };
  }, [url]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      // Pause any other voice player on the page (WhatsApp behavior).
      document.querySelectorAll("audio[data-voice-player]").forEach((el) => {
        if (el !== audio) (el as HTMLAudioElement).pause();
      });
      // State is driven by play/pause events; a rejected play() fires neither,
      // so reset explicitly instead of leaving the button stuck.
      try {
        const p = audio.play() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === "function") p.catch(() => setPlaying(false));
      } catch {
        setPlaying(false);
      }
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
  };

  const playedBars = Math.round(progress * bars.current.length);

  return (
    <div className="flex w-[230px] items-center gap-2 py-1">
      <audio ref={audioRef} src={url} preload="metadata" data-voice-player onError={onError} className="hidden" />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition-transform active:scale-95 ${
          mine ? "bg-white/25 text-white" : "bg-primary text-primary-foreground"
        }`}
      >
        {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className="flex h-7 cursor-pointer items-center gap-[2px]"
          onClick={seek}
          role="slider"
          aria-label="Seek voice message"
          aria-valuenow={Math.round(progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          {bars.current.map((h, i) => (
            <span
              key={i}
              className="w-[3px] shrink-0 rounded-full transition-colors"
              style={{
                height: `${h}px`,
                backgroundColor:
                  i < playedBars
                    ? mine
                      ? "rgba(255,255,255,0.95)"
                      : "hsl(var(--primary))"
                    : mine
                      ? "rgba(255,255,255,0.35)"
                      : "hsl(var(--muted-foreground) / 0.35)",
              }}
            />
          ))}
        </div>
        <div
          className={`text-[11px] tabular-nums ${mine ? "text-white/80" : "text-muted-foreground"}`}
        >
          {formatTime(playing || current > 0 ? current : duration)}
        </div>
      </div>
    </div>
  );
}
