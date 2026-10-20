import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pin, PinOff, BellOff, Bell, CheckCheck, Trash2, LogOut } from "lucide-react";

export interface ChatMenuState {
  chatId: string;
  kind: "room" | "direct";
  name: string;
  x: number;
  y: number;
  pinned: boolean;
  muted: boolean;
  canDeleteRoom: boolean;
  // Audit-2 M47: the memberships query failed, so pinned/muted are
  // UNKNOWN (not false). The menu disables the Pin/Mute items and
  // offers a retry instead of showing "Pin chat" for an already
  // pinned chat. Mark-as-read / Delete stay enabled — they don't
  // depend on memberships.
  pinMuteUnknown?: boolean;
}

/**
 * WhatsApp-style chat menu for the inbox: Pin, Mute, Mark as read,
 * Delete chat / Leave / Delete room. Opened by right-click or long-press
 * on a conversation row.
 */
export function ChatMenu({
  menu,
  onClose,
  onPin,
  onMute,
  onMarkRead,
  onDelete,
  // Audit-2 M45: set by the mobile shell only. The menu then portals
  // to document.body: inside .vt-mobile, the dark-mode filter makes
  // `fixed` viewport-relative positioning wrong (the filter turns the
  // ancestor into the containing block) and overflow:hidden clips it
  // — at 481–767px the menu rendered shifted by (viewport−480)/2 and
  // could clip. Portaled, `fixed` is viewport-relative again and the
  // coordinates (clamped to window size) land where tapped. The
  // portaled root gets `vt-chat-menu` so the M82-style dark rule in
  // MOBILE_CSS converts it like the rest of the app. Desktop keeps
  // rendering inline (no filter ancestor there; its native dark
  // palette must not be inverted).
  inMobileShell,
  // Audit-2 M47: retry for the pin/mute status (memberships query).
  onRetryPinMute,
}: {
  menu: ChatMenuState | null;
  onClose: () => void;
  onPin: (chatId: string, pinned: boolean) => void;
  onMute: (chatId: string, muted: boolean) => void;
  onMarkRead: (chatId: string) => void;
  onDelete: (chatId: string) => void;
  inMobileShell?: boolean;
  onRetryPinMute?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Audit-3 A6-N16: set when the menu closes via a pointerdown
  // outside it — focus already moved to where the user clicked, so
  // the close cleanup must NOT yank it back to the opener.
  const closedByOutsidePointerRef = useRef(false);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        closedByOutsidePointerRef.current = true;
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // Audit-3 A6-N16: ArrowUp/Down move focus between items (only
      // while focus is inside the menu — otherwise arrows keep their
      // normal page behaviour). Enter activates natively (button).
      if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        ref.current?.contains(document.activeElement)
      ) {
        e.preventDefault();
        const items = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            '[role="menuitem"]:not([disabled])',
          ) ?? []),
        ];
        if (!items.length) return;
        const idx = items.indexOf(document.activeElement as HTMLElement);
        const next =
          e.key === "ArrowDown"
            ? (idx + 1) % items.length
            : (idx - 1 + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);

  // Audit-3 A6-N16: focus the first item on open; return focus to
  // the opener on close (standard menu behaviour — item clicks,
  // Enter, and Escape all return). The outside-pointer case is the
  // exception: focus already moved to where the user clicked, so
  // the flag above skips the return there. (A ref.current check
  // here would never fire — refs are cleared by the time this
  // cleanup runs.)
  useEffect(() => {
    if (!menu) return;
    closedByOutsidePointerRef.current = false;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    );
    first?.focus();
    return () => {
      if (!closedByOutsidePointerRef.current && prev && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [menu]);

  // Audit-3 A6-N11: clamp against the menu's REAL height, not the
  // ~260px estimate — with the retry row the menu is ~300px and the
  // estimate clipped Delete/Leave below the fold on short
  // viewports. The first paint uses the estimate; this effect
  // corrects it once measured. offsetHeight (layout height) is
  // used deliberately — getBoundingClientRect() is wrong here
  // because the zoom-in-95 entrance animation scales the rect
  // during the first ~150ms, measuring ~5% short and leaving the
  // menu a few px below the fold. max-height + overflow (below)
  // is the backstop for viewports shorter than the menu itself.
  const [menuHeight, setMenuHeight] = useState(260);
  useEffect(() => {
    if (!menu) return;
    const h = ref.current?.offsetHeight;
    if (h) setMenuHeight(h);
  }, [menu]);

  if (!menu) return null;

  // Audit-4 L49: same floor-the-upper-bound fix as y below — on a
  // viewport narrower than the menu, innerWidth - 248 goes
  // negative and an un-floored min() pushed the menu off-screen
  // left (width 200 -> x = -48). At 8 the box starts at the left
  // edge and overflows right instead of vanishing.
  const x = Math.min(Math.max(8, menu.x), Math.max(8, window.innerWidth - 248));
  // Floor the upper bound at 8 too: when the menu is taller than
  // the viewport, innerHeight - menuHeight - 8 goes negative, and
  // an un-floored min() would push the menu top off-screen (the
  // max-height + scroll backstop then shows a menu whose first
  // items are unreachable). At y=8 the box stays on-screen and
  // the items scroll inside it.
  const y = Math.min(Math.max(8, menu.y), Math.max(8, window.innerHeight - menuHeight - 8));

  const item =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary disabled:opacity-50";
  const icon = "h-4 w-4 text-muted-foreground";

  const deleteLabel =
    menu.kind === "direct" ? "Delete chat" : menu.canDeleteRoom ? "Delete room" : "Leave group";

  const menuNode = (
    <div
      ref={ref}
      className={`fixed z-[100] w-60 animate-in fade-in zoom-in-95 rounded-2xl border bg-card p-1.5 shadow-2xl duration-150 max-h-[calc(100dvh-16px)] overflow-y-auto${inMobileShell ? " vt-chat-menu" : ""}`}
      style={{ left: x, top: y }}
      role="menu"
    >
      {menu.pinMuteUnknown && (
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-amber-700 hover:bg-amber-50"
          onClick={() => {
            onRetryPinMute?.();
            onClose();
          }}
        >
          Couldn&apos;t load pin/mute status — tap to retry
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className={item}
        disabled={menu.pinMuteUnknown}
        onClick={() => {
          onPin(menu.chatId, !menu.pinned);
          onClose();
        }}
      >
        {menu.pinned ? <PinOff className={icon} /> : <Pin className={icon} />}
        {menu.pinned ? "Unpin chat" : "Pin chat"}
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        disabled={menu.pinMuteUnknown}
        onClick={() => {
          onMute(menu.chatId, !menu.muted);
          onClose();
        }}
      >
        {menu.muted ? <Bell className={icon} /> : <BellOff className={icon} />}
        {menu.muted ? "Unmute notifications" : "Mute notifications"}
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={() => {
          onMarkRead(menu.chatId);
          onClose();
        }}
      >
        <CheckCheck className={icon} /> Mark as read
      </button>
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        role="menuitem"
        className={`${item} text-destructive hover:bg-destructive/10`}
        onClick={() => {
          onDelete(menu.chatId);
          onClose();
        }}
      >
        {menu.kind === "direct" || menu.canDeleteRoom ? (
          <Trash2 className="h-4 w-4" />
        ) : (
          <LogOut className="h-4 w-4" />
        )}
        {deleteLabel}
      </button>
    </div>
  );
  // Audit-2 M45: portal only for the mobile shell (see the prop).
  // document is safe here: menu is non-null only after a pointer
  // event, i.e. client-side — same guarantee as the window access
  // above. Desktop renders inline, unchanged.
  if (inMobileShell) return createPortal(menuNode, document.body);
  return menuNode;
}
