import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getOrCreateDm, getPublicProfile } from "@/lib/chat.functions";
import { useCall } from "@/components/call-overlay";
import { useAuth } from "@/lib/auth-context";
import { formatServerRelativeTime } from "@/lib/presence";
import { SmartAvatar } from "@/components/smart-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageCircle, Phone, Video } from "lucide-react";
import { toast } from "sonner";

/**
 * WhatsApp-style profile sheet: tapping someone's name/avatar inside a chat
 * shows their info. Sections the person set to Private never reach the
 * client (getPublicProfile filters server-side), so they simply don't render.
 */
export function PeerProfileSheet({
  userId,
  open,
  onOpenChange,
}: {
  userId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const getProfile = useServerFn(getPublicProfile);
  const dm = useServerFn(getOrCreateDm);
  const { startCall } = useCall();

  const { data: profile, isLoading } = useQuery({
    queryKey: ["public-profile", userId],
    queryFn: () => getProfile({ data: { userId: userId! } }),
    enabled: open && !!userId,
  });

  // Audit-3 A4-N29: in-flight guard for getOrCreateDm (same M46
  // pattern as People) — the Message button stays enabled during
  // flight without it, and double-taps fired duplicate DM calls.
  // Ref guards; state mirrors for the disabled UI.
  const dmInFlightRef = useRef(false);
  const [dmInFlight, setDmInFlight] = useState(false);
  const openDm = async () => {
    if (!userId || dmInFlightRef.current) return;
    dmInFlightRef.current = true;
    setDmInFlight(true);
    try {
      const { roomId } = await dm({ data: { otherUserId: userId } });
      onOpenChange(false);
      navigate({ to: "/rooms/$roomId", params: { roomId } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open chat");
    } finally {
      dmInFlightRef.current = false;
      setDmInFlight(false);
    }
  };

  const name = profile?.displayName ?? "VibeTalk user";
  const isSelf = profile?.isSelf ?? userId === user?.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-4 rounded-3xl p-5 max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:top-auto max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:rounded-t-[22px] max-md:border-b-0 max-md:pb-8">
        <div className="mx-auto h-1 w-[38px] rounded-full bg-border md:hidden" aria-hidden="true" />
        <DialogHeader className="sr-only">
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>Profile information</DialogDescription>
        </DialogHeader>
        {isLoading || !profile ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading profile…</p>
        ) : (
          <div className="flex flex-col items-center text-center">
            <SmartAvatar
              userId={userId!}
              name={name}
              className="h-20 w-20 rounded-[26px] border"
              fallbackClassName="rounded-[26px] bg-accent text-2xl font-extrabold text-primary"
            />
            <h2 className="mt-3 truncate text-lg font-extrabold tracking-tight">{name}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isSelf
                ? "This is you"
                : profile.isOnline
                  ? "Online now"
                  : profile.lastSeenAt
                    ? `Last seen ${formatServerRelativeTime(profile.lastSeenAt)}`
                    : "Offline"}
            </p>
            {profile.status && (
              <p className="mt-3 w-full rounded-xl bg-secondary/70 px-3 py-2 text-left text-sm">
                <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  Status
                </span>
                {profile.status}
              </p>
            )}
            {profile.bio && (
              <p className="mt-2 w-full rounded-xl bg-secondary/70 px-3 py-2 text-left text-sm">
                <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  Bio
                </span>
                {profile.bio}
              </p>
            )}
            {!profile.status && !profile.bio && (
              <p className="mt-3 text-xs text-muted-foreground">No public info shared.</p>
            )}
            {!isSelf && (
              <div className="mt-4 flex w-full gap-2">
                <Button
                  type="button"
                  className="flex-1"
                  disabled={dmInFlight}
                  onClick={() => void openDm()}
                >
                  <MessageCircle className="h-4 w-4" /> Message
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Voice call"
                  onClick={() => {
                    onOpenChange(false);
                    void startCall(userId!, name, "voice");
                  }}
                >
                  <Phone className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Video call"
                  onClick={() => {
                    onOpenChange(false);
                    void startCall(userId!, name, "video");
                  }}
                >
                  <Video className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
