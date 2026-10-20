import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2, Info, Copy, Check } from "lucide-react";

export const QUICK_REACT = ["❤️", "😂", "😮", "😢", "👍", "🔥"];

export interface MenuState {
  messageId: string;
  body: string | null;
  /** Audit-2 L33 / A4-N19: Copy disabled while the body is a
      placeholder (decrypting OR a terminal one) — it must never
      reach the clipboard. */
  copyDisabled: boolean;
  x: number;
  y: number;
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Audit-2 M21: own message past the 5-minute edit/delete window — shows the hint row instead of Edit/Delete. */
  expired: boolean;
}

/**
 * WhatsApp-style message menu: quick reactions + Edit / Info / Delete.
 * Opened by right-click (desktop) or long-press (mobile).
 */
export function MessageMenu({
  menu,
  onClose,
  onReact,
  onEdit,
  onDelete,
  onInfo,
}: {
  menu: MenuState | null;
  onClose: () => void;
  onReact: (messageId: string, emoji: string) => void;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onInfo: (messageId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const lastMenuId = useRef<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    // Reset the "Copied!" feedback only when a DIFFERENT message's menu opens,
    // not on every parent re-render (onClose is a new closure each render).
    if (lastMenuId.current !== menu.messageId) {
      lastMenuId.current = menu.messageId;
      setCopied(false);
    }
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  // Clamp inside the viewport (menu ~ 240px wide, ~200px tall).
  // Audit-4 L49: floor the UPPER bound at 8 too — on a viewport
  // narrower than the menu, innerWidth - 248 goes negative and
  // an un-floored min() pushed the menu off-screen left (width
  // 200 -> x = -48). At 8 the box starts at the left edge and
  // overflows right instead of vanishing. Same for y.
  const x = Math.min(Math.max(8, menu.x), Math.max(8, window.innerWidth - 248));
  const y = Math.min(Math.max(8, menu.y), Math.max(8, window.innerHeight - 220));

  const item =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors hover:bg-secondary";

  return (
    <div
      ref={ref}
      className="fixed z-[100] w-60 animate-in fade-in zoom-in-95 rounded-2xl border bg-card p-1.5 shadow-2xl duration-150"
      style={{ left: x, top: y }}
      role="menu"
    >
      <div className="flex items-center justify-between gap-1 px-1.5 pb-1.5 pt-1">
        {QUICK_REACT.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => {
              onReact(menu.messageId, e);
              onClose();
            }}
            aria-label={`React ${e}`}
            className="grid h-9 w-9 place-items-center rounded-full text-xl transition-transform hover:scale-125 hover:bg-secondary"
          >
            {e}
          </button>
        ))}
      </div>
      <div className="my-1 h-px bg-border" />
      {menu.canEdit && (
        <button
          type="button"
          className={item}
          onClick={() => {
            onEdit(menu.messageId);
            onClose();
          }}
        >
          <Pencil className="h-4 w-4 text-muted-foreground" /> Edit
        </button>
      )}
      {!!menu.body && (
        <button
          type="button"
          className={`${item} disabled:cursor-not-allowed disabled:opacity-50`}
          disabled={menu.copyDisabled}
          title={menu.copyDisabled ? "This message can't be copied" : undefined}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(menu.body ?? "");
              setCopied(true);
              window.setTimeout(onClose, 450);
            } catch {
              onClose();
            }
          }}
        >
          {copied ? (
            <Check className="h-4 w-4 text-primary" />
          ) : (
            <Copy className="h-4 w-4 text-muted-foreground" />
          )}
          {copied ? "Copied!" : "Copy"}
        </button>
      )}
      {/* M14: Message Info (who read it, when) is only for MY OWN
          messages — WhatsApp shows Info only for your own messages.
          Any member seeing everyone else's exact read times is a
          privacy leak. The onInfo handler below enforces the same gate. */}
      {menu.mine && (
        <button
          type="button"
          className={item}
          onClick={() => {
            onInfo(menu.messageId);
            onClose();
          }}
        >
          <Info className="h-4 w-4 text-muted-foreground" /> Info
        </button>
      )}
      {menu.canDelete && (
        <button
          type="button"
          className={`${item} text-destructive hover:bg-destructive/10`}
          onClick={() => {
            onDelete(menu.messageId);
            onClose();
          }}
        >
          <Trash2 className="h-4 w-4" /> Delete
        </button>
      )}
      {/* Audit-2 M21: the window closed — say so instead of silently
          hiding Edit/Delete. */}
      {menu.mine && menu.expired && (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          Messages can only be edited or deleted within 5 minutes.
        </p>
      )}
    </div>
  );
}
