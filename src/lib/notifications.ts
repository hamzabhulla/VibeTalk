/**
 * Browser notifications for new chat messages.
 *
 * Works whenever the app tab is open (even in a background tab). The user
 * must grant permission (requested from a settings toggle) and keep the
 * notifications switch on. Stored in localStorage so it survives reloads.
 */

import { callPreviewText } from "@/lib/call-message";

const STORAGE_KEY = "hcroom.notifications.enabled";

// Audit-2 L70: the body shown when the recipient has notification
// previews off (lock-screen privacy). Shared by the push fan-out
// (webpush-send.server.ts) and the in-app notifier — keep the single
// literal here so both surfaces say the same thing.
export const NOTIFICATION_PREVIEW_HIDDEN = "New message";

export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export type NotifPermission = NotificationPermission | "unsupported";

export function getNotificationPermission(): NotifPermission {
  if (!isNotificationSupported()) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotifPermission> {
  if (!isNotificationSupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function isNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** True when a notification can actually be shown right now. */
export function canNotify(): boolean {
  return (
    isNotificationSupported() && isNotificationsEnabled() && Notification.permission === "granted"
  );
}

export function previewForMessage(
  type: string | null | undefined,
  body: string | null | undefined,
): string {
  // Call entries carry a JSON payload — never show the raw JSON.
  if (type === "call") return callPreviewText(body);
  // Never leak ciphertext into a notification.
  if (body && body.trim().startsWith("E2E1:")) return "🔒 Encrypted message";
  if (body && body.trim()) return body.trim().slice(0, 140);
  switch (type) {
    case "image":
      return "📷 sent a photo";
    case "video":
      return "🎥 sent a video";
    case "audio":
      return "🎤 sent a voice message";
    case "file":
      return "📎 sent a file";
    default:
      return "sent you a message";
  }
}

export function showMessageNotification(opts: {
  title: string;
  body: string;
  tag: string;
  onClick: () => void;
}): void {
  if (!canNotify()) return;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: "/favicon.ico",
    });
    n.onclick = (e) => {
      e.preventDefault();
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      opts.onClick();
      n.close();
    };
  } catch {
    /* notifications blocked at OS level */
  }
}
