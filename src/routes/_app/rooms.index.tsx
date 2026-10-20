import { createFileRoute } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";

export const Route = createFileRoute("/_app/rooms/")({
  component: RoomsIndex,
  // Audit-4 L80: this route consumes no search keys.
  validateSearch: () => ({}),
});

/**
 * Shown in the right pane on desktop until a conversation is picked.
 * (On mobile the layout renders the inbox directly, so this never shows there.)
 */
function RoomsIndex() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-background p-8 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl border bg-card shadow-sm">
        <MessageCircle className="h-6 w-6 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-lg font-extrabold tracking-tight">Select a conversation</h2>
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">
          Pick a room or direct message from the list to start chatting.
        </p>
      </div>
    </div>
  );
}
