import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listRoomMembers,
  addRoomMember,
  removeRoomMember,
  joinRoom,
  listUsers,
  type RoomMemberRow,
} from "@/lib/chat.functions";
import { Button } from "@/components/ui/button";
import { SmartAvatar } from "@/components/smart-avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Users, UserPlus, UserMinus, LogOut, Lock } from "lucide-react";
import { toast } from "sonner";
import { isUserOnline } from "@/lib/presence";

export function MembersDialog({
  roomId,
  roomName,
  isPrivate,
  isE2EE,
  currentUserId,
  isCreator,
  onViewProfile,
}: {
  roomId: string;
  roomName: string;
  isPrivate: boolean;
  isE2EE?: boolean;
  currentUserId: string | undefined;
  isCreator: boolean;
  onViewProfile?: (userId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [addId, setAddId] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<RoomMemberRow | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const list = useServerFn(listRoomMembers);
  const add = useServerFn(addRoomMember);
  const remove = useServerFn(removeRoomMember);
  const join = useServerFn(joinRoom);
  const users = useServerFn(listUsers);

  // Audit-2 L34: read the query's loading/error state — the old code
  // only read `data`, so while members were still loading (or the
  // load had FAILED) `members` was undefined, `isMember` defaulted
  // to false, and an EXISTING member was offered a Join button for
  // their own room. Unknown membership must never read as "not a
  // member".
  const {
    data: members,
    isLoading: membersLoading,
    isError: membersError,
  } = useQuery({
    queryKey: ["room-members", roomId],
    queryFn: () => list({ data: { roomId } }),
    enabled: open,
  });
  const membershipKnown = !membersLoading && !membersError;
  // Audit-3 A4-N24: the Add-member picker searches SERVER-side
  // (debounced) instead of filtering a capped client-side list —
  // past the first 100 users, nobody was addable at all.
  const [addSearch, setAddSearch] = useState("");
  const [debouncedAddSearch, setDebouncedAddSearch] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedAddSearch(addSearch), 300);
    return () => window.clearTimeout(t);
  }, [addSearch]);
  const { data: searchUsers } = useQuery({
    queryKey: ["user-search", roomId, debouncedAddSearch],
    queryFn: () => users({ data: { search: debouncedAddSearch, limit: 50 } }),
    enabled: open,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["room-members", roomId] });
    qc.invalidateQueries({ queryKey: ["rooms"] });
  };

  const memberIds = new Set((members ?? []).map((m) => m.user_id));
  const isMember = currentUserId ? memberIds.has(currentUserId) : false;
  // Audit-3 A4-N31: the server also authorises the fallback manager —
  // the oldest remaining member when no live creator remains
  // (creator left without transfer, or creator's account deleted).
  // The UI must surface Add/Remove to them too, not just to isCreator.
  // Unknown membership never grants (fail closed on load failure).
  const creatorInMembers = (members ?? []).some((m) => m.is_creator);
  const oldestMember = (members ?? []).reduce<RoomMemberRow | null>(
    (oldest, m) => (oldest === null || m.joined_at <= oldest.joined_at ? m : oldest),
    null,
  );
  const canManage =
    isCreator ||
    (membershipKnown &&
      !creatorInMembers &&
      currentUserId !== undefined &&
      oldestMember?.user_id === currentUserId);
  const candidates = (searchUsers ?? []).filter((u) => !memberIds.has(u.id));

  const onJoin = async () => {
    try {
      await join({ data: { roomId } });
      toast.success("Joined the room");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not join");
    }
  };

  const onAdd = async () => {
    if (!addId) return;
    try {
      await add({ data: { roomId, userId: addId } });
      toast.success("Member added");
      setAddId("");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add member");
    }
  };

  const onRemove = async (m: RoomMemberRow) => {
    const leaving = m.user_id === currentUserId;
    try {
      await remove({ data: { roomId, userId: m.user_id } });
      toast.success(leaving ? "You left the room" : "Member removed");
      setConfirmRemove(null);
      refresh();
      if (leaving) {
        // Audit-2 H12: never leave the room page mounted after a
        // self-leave — its composer would keep sending into a room
        // the user is no longer in (all sends fail server-side).
        setOpen(false);
        navigate({ to: "/rooms" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove member");
    }
  };

  // Audit-2 H12: creator self-leave hands created_by to the oldest
  // remaining member (server-side transferCreatorOnLeave) — name that
  // successor in the confirm dialog so the transfer is visible, not
  // silent. No remaining members = the room is left empty.
  const successor =
    confirmRemove !== null &&
    confirmRemove.user_id === currentUserId &&
    confirmRemove.is_creator
      ? (members ?? [])
          .filter((m) => m.user_id !== currentUserId)
          .reduce<RoomMemberRow | null>(
            (oldest, m) => (oldest === null || m.joined_at <= oldest.joined_at ? m : oldest),
            null,
          )
      : null;

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Room members">
          <Users className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md gap-5 rounded-3xl p-5 max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:top-auto max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:rounded-t-[22px] max-md:border-b-0 max-md:pb-8">
        <div className="mx-auto h-1 w-[38px] rounded-full bg-border md:hidden" aria-hidden="true" />
        <DialogHeader className="text-left">
          <DialogTitle className="text-lg font-extrabold">Members</DialogTitle>
          <DialogDescription>
            {isPrivate ? (
              <span className="inline-flex items-center gap-1">
                <Lock className="h-3 w-3" /> Private room — hidden from non-members.
              </span>
            ) : (
              <>Anyone signed in can join this room.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {!membershipKnown && (
          <p className="rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {membersLoading ? "Checking membership…" : "Couldn't load members — membership unknown."}
          </p>
        )}
        {membershipKnown && !isMember && !isPrivate && (
          <Button onClick={onJoin} className="w-full gradient-primary text-primary-foreground">
            Join {roomName ? `#${roomName}` : "room"}
          </Button>
        )}
        {isE2EE && (
          <p className="rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            🔒 Encrypted room — new members must open the app once to set up encryption, and they
            can&apos;t read messages sent before they joined.
          </p>
        )}
        {!isMember && isPrivate && (
          <p className="rounded-lg border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            This is a private room. Ask the room creator to add you.
          </p>
        )}

        <div className="max-h-64 space-y-2.5 overflow-y-auto">
          {(members ?? []).map((m) => (
            <div
              key={m.user_id}
              className="flex items-center gap-2.5 rounded-2xl bg-secondary/70 px-3 py-2"
              onClick={() => onViewProfile?.(m.user_id)}
              role={onViewProfile ? "button" : undefined}
            >
              <div className="relative shrink-0">
                <SmartAvatar
                  userId={m.user_id}
                  name={m.display_name}
                  className="h-10 w-10 rounded-[13px] border"
                  fallbackClassName="rounded-[13px] bg-card text-xs text-card-foreground"
                />
                {isUserOnline(m.last_seen_at) && (
                  <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-primary" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-bold">{m.display_name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {m.is_creator ? "Creator" : "Member"}
                </div>
              </div>
              {m.is_creator && (
                <span className="rounded-lg bg-accent px-2 py-1 text-[9px] font-extrabold uppercase tracking-wide text-primary">
                  Creator
                </span>
              )}
              {(canManage && m.user_id !== currentUserId && !m.is_creator) ||
              m.user_id === currentUserId ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Audit-2 H12: every remove / leave asks first —
                    // destructive actions never fire on a bare tap.
                    setConfirmRemove(m);
                  }}
                  aria-label={
                    m.user_id === currentUserId ? "Leave room" : `Remove ${m.display_name}`
                  }
                >
                  {m.user_id === currentUserId ? (
                    <LogOut className="h-3.5 w-3.5" />
                  ) : (
                    <UserMinus className="h-3.5 w-3.5" />
                  )}
                </Button>
              ) : null}
            </div>
          ))}
          {membersLoading && (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading members…</p>
          )}
          {membersError && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Couldn&apos;t load members.
            </p>
          )}
          {!membersLoading && !membersError && (members ?? []).length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No members yet.</p>
          )}
        </div>

        {canManage && (
          <div className="border-t pt-4">
            <input
              value={addSearch}
              onChange={(e) => setAddSearch(e.target.value)}
              placeholder="Search people to add…"
              className="mb-2 w-full rounded-lg border px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <Select value={addId} onValueChange={setAddId}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select a person to add" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={onAdd} disabled={!addId}>
                <UserPlus className="h-4 w-4" /> Add
              </Button>
            </div>
            {/* Audit-3 A4-N34: private-profile users are hidden from
                the candidate list by design (listUsers) — say so
                instead of leaving the creator guessing. */}
            <p className="mt-2 text-xs text-muted-foreground">
              Users with private profiles don&apos;t appear here.
            </p>
          </div>
        )}
      </DialogContent>
      </Dialog>

      {/* Audit-2 H12: confirm every remove / leave. Creator self-leave
          names the successor (server auto-transfer to the oldest
          remaining member); sole-member creator leave empties the room. */}
      <Dialog
        open={confirmRemove !== null}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
      >
        <DialogContent className="max-w-sm gap-5 rounded-3xl p-5">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold">
              {confirmRemove !== null && confirmRemove.user_id === currentUserId
                ? "Leave room?"
                : `Remove ${confirmRemove?.display_name}?`}
            </DialogTitle>
            <DialogDescription>
              {confirmRemove !== null && confirmRemove.user_id === currentUserId ? (
                confirmRemove.is_creator ? (
                  successor ? (
                    <>
                      You are the creator. If you leave, {successor.display_name} will become the
                      creator and can manage members and delete the room.
                    </>
                  ) : !membershipKnown ? (
                    // Audit-3 A4-N17: the member list failed to load —
                    // never claim the room will be empty; the server
                    // transfers to the live oldest member.
                    <>
                      Couldn&apos;t load the member list. If you leave, the oldest remaining member will
                      become the creator.
                    </>
                  ) : (
                    <>You are the creator and the only member. If you leave, the room will have no members left.</>
                  )
                ) : (
                  <>You will leave &quot;{roomName}&quot;.</>
                )
              ) : (
                <>
                  {confirmRemove?.display_name} will be removed from &quot;{roomName}&quot;. They can
                  be added back later.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmRemove && void onRemove(confirmRemove)}
            >
              {confirmRemove?.user_id === currentUserId ? "Leave room" : "Remove"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
