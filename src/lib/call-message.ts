/**
 * WhatsApp-style call entries inside the chat thread. The caller posts one
 * `type: "call"` message per finished call; the body is a small JSON payload
 * (never free text), so every renderer shows the same summary.
 */

export type CallMessageInfo = {
  type: "voice" | "video";
  // Audit-2 M40: "cancelled" — the caller aborted while ringing.
  status: "completed" | "missed" | "declined" | "failed" | "cancelled";
  duration: number; // seconds; 0 for missed/declined/failed/cancelled
};

export function parseCallMessage(body: string | null | undefined): CallMessageInfo | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Partial<CallMessageInfo> & { call?: unknown };
    // The server fn posts the call type under the field name "call"
    // ({call, status, duration}); accept "type" too so both wire shapes parse.
    const type = parsed.type ?? parsed.call;
    if (type !== "voice" && type !== "video") return null;
    if (
      parsed.status !== "completed" &&
      parsed.status !== "missed" &&
      parsed.status !== "declined" &&
      parsed.status !== "failed" &&
      parsed.status !== "cancelled"
    ) {
      return null;
    }
    const duration = Math.max(0, Math.floor(Number(parsed.duration) || 0));
    return { type, status: parsed.status, duration };
  } catch {
    return null;
  }
}

export function formatCallDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function callMessageIcon(type: "voice" | "video"): string {
  return type === "video" ? "📹" : "📞";
}

/** One-line preview for chat lists / notifications, e.g. "📞 Missed voice call". */
export function callPreviewText(body: string | null | undefined): string {
  const info = parseCallMessage(body);
  // Audit-3 A4-N33: an unparseable call payload renders a fixed label,
  // never the raw body (which could be attacker-controlled text).
  if (!info) return "Call";
  return `${callMessageIcon(info.type)} ${callMessageSummary(info)}`;
}

/** Text summary without icon, e.g. "Missed voice call", "Video call · 5:32". */
export function callMessageSummary(info: CallMessageInfo): string {
  const label = info.type === "video" ? "Video call" : "Voice call";
  if (info.status === "missed") return `Missed ${info.type} call`;
  if (info.status === "cancelled") return `Cancelled ${info.type} call`;
  if (info.status === "declined") return `${label} · Declined`;
  if (info.status === "failed") return `${label} · Failed`;
  return `${label} · ${formatCallDuration(info.duration)}`;
}
