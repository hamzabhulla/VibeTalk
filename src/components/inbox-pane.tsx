import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listRooms,
  createRoom,
  listDms,
  getThreadPreviews,
  getMyMemberships,
  pinChat,
  muteChat,
  leaveChat,
  deleteRoom,
  markRoomRead,
  getUnreadCounts,
} from "@/lib/chat.functions";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { ChatMenu, type ChatMenuState } from "@/components/chat-menu";
import { isUserOnline } from "@/lib/presence";
import { fetchAllThreadPreviews } from "@/lib/thread-previews";
import { callPreviewText } from "@/lib/call-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { SmartAvatar } from "@/components/smart-avatar";
import { paletteFor } from "@/lib/avatar-palette";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Hash, Lock, Search, Pin, BellOff } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

import { useChatListFilter, setChatListFilter, setChatListSearch, type ChatListFilter } from "@/lib/chat-list-filter";

function threadTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  const startOfWeek = new Date(startOfToday.getTime() - 6 * 86_400_000);
  if (d >= startOfToday) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d >= startOfYesterday) return "Yesterday";
  if (d >= startOfWeek) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function previewText(
  preview: { body: string | null; type: string; display_name: string; user_id: string } | undefined,
  mine: boolean,
  isE2EE: boolean,
): string {
  if (!preview) return "";
  if (preview.type === "image") return `${mine ? "You" : preview.display_name}: 📷 Photo`;
  if (preview.type === "video") return `${mine ? "You" : preview.display_name}: 🎬 Video`;
  if (preview.type === "audio") return `${mine ? "You" : preview.display_name}: 🎤 Voice message`;
  if (preview.type === "file") return `${mine ? "You" : preview.display_name}: 📎 File`;
  if (preview.type === "call")
    return `${mine ? "You" : preview.display_name}: ${callPreviewText(preview.body)}`;
  const body = (preview.body ?? "").trim();
  if (!body) return "";
  // Never show ciphertext in a preview. Audit-3 A4-N32: only treat
  // E2E1: as encrypted in E2EE rooms — a fake E2E1: body in a
  // non-E2EE room (legacy rows; new ones are rejected by sendMessage)
  // renders as plain text, never with a lock icon.
  if (body.startsWith("E2E1:")) {
    return isE2EE
      ? `${mine ? "You" : preview.display_name}: 🔒 Encrypted message`
      : `${mine ? "You" : preview.display_name}: ${body}`;
  }
  return `${mine ? "You" : preview.display_name}: ${body}`;
}

export function InboxPane() {
  const { user } = useAuth();
  const list = useServerFn(listRooms);
  const create = useServerFn(createRoom);
  const dms = useServerFn(listDms);
  const previews = useServerFn(getThreadPreviews);
  const membershipsFn = useServerFn(getMyMemberships);
  const doPin = useServerFn(pinChat);
  const doMute = useServerFn(muteChat);
  const doLeave = useServerFn(leaveChat);
  const doDeleteRoom = useServerFn(deleteRoom);
  const doMarkRead = useServerFn(markRoomRead);
  const unreadFn = useServerFn(getUnreadCounts);

  // Unread badges (WhatsApp-style counts on each chat).
  // M79: no more fail-silent [] — see MobileChats for the same fix.
  const {
    data: unreadRows,
    isError: unreadError,
    refetch: refetchUnread,
  } = useQuery({
    queryKey: ["unread-counts"],
    queryFn: () =>
      unreadFn().catch((err) => {
        console.warn("[chats] unread counts failed:", err);
        throw err;
      }),
  });
  const unreadMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of unreadRows ?? []) m.set(r.room_id, Number(r.unread_count) || 0);
    return m;
  }, [unreadRows]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const selectedId = pathname.startsWith("/rooms/") ? pathname.split("/")[2] : null;

  // Audit-2 M41: same as MobileChats — rooms/dms errors used to
  // render as "No conversations yet." (a failed fetch looked like
  // zero chats). ANY failure wins over a partial list.
  const {
    data: roomPages,
    isLoading,
    isError: roomsError,
    refetch: refetchRooms,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["rooms"],
    queryFn: ({ pageParam }) =>
      // Audit-4 M5: paginate — the old bare list() showed only the
      // first 200 rooms; rooms beyond were unreachable. Same
      // useInfiniteQuery + Load-more pattern as MobileCalls.
      (pageParam ? list({ data: { cursor: pageParam } }) : list())
        .catch((err) => {
          console.warn("[chats] rooms failed:", err);
          throw err;
        }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  // Flatten pages — the threads memo below merges + sorts rooms with
  // DMs, so later pages slot into the same (pinned, last-activity)
  // order instead of appending out of order.
  const rooms = useMemo(
    () => roomPages?.pages.flatMap((p) => p.rooms) ?? [],
    [roomPages],
  );
  const {
    data: dmList,
    isError: dmError,
    refetch: refetchDms,
  } = useQuery({
    queryKey: ["dms"],
    queryFn: () =>
      dms().catch((err) => {
        console.warn("[chats] dms failed:", err);
        throw err;
      }),
  });

  // Per-chat pin/mute state for the chat menu + pinned sorting.
  // Audit-2 M47: memberships errors used to render as "nothing pinned
  // or muted" — see MobileChats for the same fix.
  const {
    data: memberships,
    isError: membershipsError,
    refetch: refetchMemberships,
  } = useQuery({
    queryKey: ["my-memberships"],
    queryFn: () =>
      membershipsFn().catch((err) => {
        console.warn("[chats] memberships failed:", err);
        throw err;
      }),
  });
  const memberMap = useMemo(() => {
    const m = new Map<string, { pinned: boolean; muted: boolean }>();
    for (const r of memberships ?? [])
      m.set(r.room_id, { pinned: !!r.pinned_at, muted: !!r.is_muted });
    return m;
  }, [memberships]);

  // WhatsApp-style chat menu (right-click / long-press on a row).
  const [chatMenu, setChatMenu] = useState<ChatMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    chatId: string;
    kind: "room" | "direct";
    name: string;
    canDeleteRoom: boolean;
  } | null>(null);
  const lpTimer = useRef<number | null>(null);
  // After a long-press opens the menu, the browser still fires a click on the
  // row when the finger lifts — suppress it so we don't navigate away and
  // unmount the menu. Scoped to the long-pressed row id so taps on OTHER rows
  // still navigate.
  const suppressClickFor = useRef<string | null>(null);
  // Only cancel the long-press on a REAL scroll (12px+), not finger jitter.
  const touchPos = useRef<{ x: number; y: number } | null>(null);
  useEffect(
    () => () => {
      if (lpTimer.current) window.clearTimeout(lpTimer.current);
    },
    [],
  );
  const openChatMenu = (
    t: { id: string; kind: "room" | "direct"; name: string; createdBy: string | null },
    x: number,
    y: number,
  ) => {
    const mm = memberMap.get(t.id);
    setChatMenu({
      chatId: t.id,
      kind: t.kind,
      name: t.name,
      x,
      y,
      pinned: !!mm?.pinned,
      muted: !!mm?.muted,
      // Audit-2 M47: on a memberships failure the pin/mute state is
      // UNKNOWN, not false — the menu disables those items + retries.
      pinMuteUnknown: membershipsError,
      // Only the room creator can delete a room — there are no admins.
      canDeleteRoom: t.kind === "room" && t.createdBy === user?.id,
    });
  };
  const cancelLongPress = () => {
    if (lpTimer.current) window.clearTimeout(lpTimer.current);
  };
  const refreshChats = () => {
    qc.invalidateQueries({ queryKey: ["rooms"] });
    qc.invalidateQueries({ queryKey: ["dms"] });
    qc.invalidateQueries({ queryKey: ["my-memberships"] });
  };
  // Audit-3 A4-N27: per-chat in-flight guard for pin / mute /
  // mark-read. Rapid double-clicks used to fire duplicate calls
  // (server-side idempotent, but double toasts + wasted round-trips).
  const chatActionInFlightRef = useRef(new Set<string>());
  const onPinChat = async (chatId: string, pinned: boolean) => {
    const key = `pin:${chatId}`;
    if (chatActionInFlightRef.current.has(key)) return;
    chatActionInFlightRef.current.add(key);
    try {
      await doPin({ data: { roomId: chatId, pinned } });
      toast.success(pinned ? "Chat pinned" : "Chat unpinned");
      refreshChats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      chatActionInFlightRef.current.delete(key);
    }
  };
  const onMuteChat = async (chatId: string, muted: boolean) => {
    const key = `mute:${chatId}`;
    if (chatActionInFlightRef.current.has(key)) return;
    chatActionInFlightRef.current.add(key);
    try {
      await doMute({ data: { roomId: chatId, muted } });
      toast.success(muted ? "Notifications muted" : "Notifications unmuted");
      refreshChats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      chatActionInFlightRef.current.delete(key);
    }
  };
  const onMarkChatRead = async (chatId: string) => {
    const key = `read:${chatId}`;
    if (chatActionInFlightRef.current.has(key)) return;
    chatActionInFlightRef.current.add(key);
    try {
      await doMarkRead({ data: { roomId: chatId } });
      qc.invalidateQueries({ queryKey: ["unread-counts"] });
      toast.success("Marked as read");
    } catch (err) {
      // M79: was silently swallowed — the user saw neither an error
      // nor the success toast, so "Mark as read" looked like a no-op.
      console.warn("[chats] mark as read failed:", err);
      toast.error("Couldn't mark as read");
    } finally {
      chatActionInFlightRef.current.delete(key);
    }
  };
  // Audit-2 L31: double-submit guard. `deleting` disables the
  // buttons (visual); `deletingRef` is the airtight guard — state
  // updates are async, so a second click in the same tick could
  // otherwise slip through before the re-render lands.
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const onConfirmDelete = async () => {
    if (!confirmDelete || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    const { chatId, kind, canDeleteRoom } = confirmDelete;
    try {
      if (kind === "direct" || !canDeleteRoom) {
        await doLeave({ data: { roomId: chatId } });
        toast.success(kind === "direct" ? "Chat deleted" : "Left the group");
      } else {
        await doDeleteRoom({ data: { roomId: chatId } });
        toast.success("Room deleted");
      }
      refreshChats();
      qc.invalidateQueries({ queryKey: ["thread-previews"] });
      qc.invalidateQueries({ queryKey: ["unread-counts"] });
      // M45: if the deleted/left room is the one open in the right
      // pane, navigate away — otherwise the conversation view stays
      // mounted on a now-dead room.
      if (chatId === selectedId) navigate({ to: "/rooms", replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  const allIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of rooms ?? []) ids.add(r.id);
    for (const d of dmList ?? []) ids.add(d.id);
    return Array.from(ids);
  }, [rooms, dmList]);

  const {
    data: previewList,
    isError: previewError,
    refetch: refetchPreviews,
  } = useQuery({
    // Audit-3 A1-L42: never sort the memoized array in place.
    queryKey: ["thread-previews", [...allIds].sort().join(",")],
    enabled: allIds.length > 0,
    queryFn: () =>
      fetchAllThreadPreviews((ids) => previews({ data: { roomIds: ids } }), allIds).catch((err) => {
        console.warn("[chats] thread previews failed:", err);
        throw err;
      }),
  });
  const previewMap = useMemo(
    () => new Map((previewList ?? []).map((p) => [p.room_id, p])),
    [previewList],
  );

  // Audit-2 M55: track the rooms-list channel's liveness (room view's
  // rtLive pattern). A failed subscribe used to fail silently — the
  // list went stale with no hint that live updates were dead.
  const [listLive, setListLive] = useState(false);
  const listDisconnectedRef = useRef(false);
  useEffect(() => {
    // M35: see the profiles handler below — presence heartbeats
    // arrive for every user every 25s, so the profiles invalidation
    // is throttled to at most once per 15s.
    let alive = true;
    let lastProfilesInvalidate = 0;
    // Audit-2 M30: coalesce list invalidations — a burst of N
    // messages used to fire 4 invalidations per message (4×N
    // refetches). Leading + trailing throttle at 500ms: the first
    // event refreshes at once; later events in the window collapse
    // into one trailing refresh of the union of dirtied keys.
    // (The profiles handler keeps its own 15s throttle — heartbeats
    // stream continuously, so a 500ms window would refetch MORE.)
    const listDirty = new Set<string>();
    let listTimer: number | null = null;
    const flushListDirty = () => {
      for (const key of listDirty) qc.invalidateQueries({ queryKey: [key] });
      listDirty.clear();
    };
    const armListWindow = () => {
      listTimer = window.setTimeout(() => {
        listTimer = null;
        if (listDirty.size > 0) {
          flushListDirty();
          armListWindow();
        }
      }, 500);
    };
    const scheduleListKeys = (...keys: string[]) => {
      for (const k of keys) listDirty.add(k);
      if (listTimer !== null) return;
      flushListDirty();
      armListWindow();
    };
    const ch = supabase
      .channel("rooms-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms" }, () => {
        scheduleListKeys("rooms", "dms");
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {
        scheduleListKeys("thread-previews", "rooms", "dms", "unread-counts");
      })
      // M44: pin/mute live in room_members (another browser's change
      // never invalidated ["my-memberships"]); mark-as-read lives in
      // read_receipts (another device's read never refreshed
      // ["unread-counts"] except as a new-message side effect).
      // Audit-2 M22: a removed room must vanish / a newly-added room
      // must appear in the list without a refresh.
      .on("postgres_changes", { event: "*", schema: "public", table: "room_members" }, () => {
        scheduleListKeys("my-memberships", "rooms", "dms");
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "read_receipts" }, () => {
        scheduleListKeys("unread-counts");
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "presence" }, () => {
        // Audit-6 B-D1: this binding watched public.profiles — dead
        // since §C3 made profiles own-row-only (postgres_changes
        // honours RLS, so another user's row can never arrive).
        // Presence lives in the presence table now (LOW-13), whose
        // read policy delivers visible users' rows. M35 throttle
        // kept: presence ticks ~25s per online user; the 120s
        // staleness window makes a 15s throttle lossless for
        // display (≤4 refetches/minute).
        const now = Date.now();
        if (now - lastProfilesInvalidate < 15_000) return;
        lastProfilesInvalidate = now;
        qc.invalidateQueries({ queryKey: ["dms"] });
      })
      // Audit-2 M55: status callback (was a bare .subscribe() — a
      // failed subscribe failed silently). On re-SUBSCRIBED after a
      // disconnect, refresh the whole list — events were missed
      // while the socket was down. The coalescer makes it one batch.
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") {
          setListLive(true);
          if (listDisconnectedRef.current) {
            listDisconnectedRef.current = false;
            scheduleListKeys("rooms", "dms", "my-memberships", "thread-previews", "unread-counts");
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          listDisconnectedRef.current = true;
          setListLive(false);
          console.warn("[inbox] realtime channel lost:", status);
        }
      });
    return () => {
      alive = false;
      if (listTimer !== null) window.clearTimeout(listTimer);
      supabase.removeChannel(ch);
    };
  }, [qc]);

  // Audit-2 M16: search + filter live in the shared chat-list store,
  // not local state — the mobile list (MobileChats) is a different
  // component, and a 768px resize swaps one for the other. Local
  // state would reset; the store survives the swap.
  const { search, filter } = useChatListFilter();

  const threads = useMemo(() => {
    const list: {
      id: string;
      kind: "room" | "direct";
      name: string;
      isPrivate: boolean;
      isE2EE: boolean;
      createdBy: string | null;
      lastActivity: string | null;
      partner?: {
        id: string;
        display_name: string;
        is_online: boolean;
        last_seen_at?: string | null;
      } | null;
      fallback: string;
      pinned: boolean;
      muted: boolean;
    }[] = [];
    for (const r of rooms ?? []) {
      if (r.is_dm) continue;
      const mm = memberMap.get(r.id);
      list.push({
        id: r.id,
        kind: "room",
        name: r.name,
        isPrivate: !!r.is_private,
        isE2EE: !!(r as { is_e2ee?: boolean }).is_e2ee,
        createdBy: (r as { created_by?: string | null }).created_by ?? null,
        lastActivity: r.last_activity_at,
        fallback: r.description || "No messages yet",
        pinned: !!mm?.pinned,
        muted: !!mm?.muted,
      });
    }
    for (const d of dmList ?? []) {
      const p = d.partner;
      const mm = memberMap.get(d.id);
      list.push({
        id: d.id,
        kind: "direct",
        name: p?.display_name ?? "Direct message",
        isPrivate: false,
        // Audit-2 L36: read the flag from the DM row — hardcoding
        // false meant an E2EE DM could never show its 🔒.
        isE2EE: !!(d as { is_e2ee?: boolean }).is_e2ee,
        createdBy: null,
        lastActivity: d.last_activity_at,
        partner: p
          ? {
              id: p.id,
              display_name: p.display_name,
              is_online: isUserOnline(p.last_seen_at),
              last_seen_at: p.last_seen_at,
            }
          : null,
        fallback: p
          ? isUserOnline(p.last_seen_at)
            ? "Online now"
            : p.last_seen_at
              ? `Last seen ${formatDistanceToNow(new Date(p.last_seen_at), { addSuffix: true })}`
              : "Offline"
          : "Direct message",
        pinned: !!mm?.pinned,
        muted: !!mm?.muted,
      });
    }
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return tb - ta;
    });
    const q = search.trim().toLowerCase();
    return list.filter((t) => {
      // The store spells it "rooms"; thread kinds spell it "room".
      const kindFilter = filter === "rooms" ? "room" : filter;
      if (kindFilter !== "all" && t.kind !== kindFilter) return false;
      if (q && !t.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rooms, dmList, filter, search, memberMap]);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  // Rooms are private by default: only people the creator adds can see them.
  const [isPrivate, setIsPrivate] = useState(true);
  const [isE2EE, setIsE2EE] = useState(false);
  const [creating, setCreating] = useState(false);
  // Audit-2 M28: ref guard — `creating` state flips async, so a fast
  // double-Enter ran submit twice → two rooms. Same pattern as the
  // room page's sendingRef.
  const creatingRef = useRef(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      await create({ data: { name, description: desc, isPrivate, isE2EE } });
      toast.success(
        isPrivate ? "Private room created — add members from the room menu" : "Room created",
      );
      setOpen(false);
      setName("");
      setDesc("");
      setIsPrivate(true);
      setIsE2EE(false);
      qc.invalidateQueries({ queryKey: ["rooms"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const tabs: { key: ChatListFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "rooms", label: "Rooms" },
    { key: "direct", label: "Direct" },
  ];

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-card"
      onContextMenu={(e) => {
        // No browser menu in the chat list either (search box stays usable).
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
      {/* Header */}
      <header className="shrink-0 px-5 pb-3 pt-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-extrabold tracking-[-0.025em]">Chats</h1>
            {/* Audit-2 M55: visible when the list's realtime channel is down. */}
            {!listLive && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
                title="Live updates disconnected — new messages may need a refresh"
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                Reconnecting…
              </span>
            )}
          </div>
          <Dialog
            open={open}
            onOpenChange={(o) => {
              setOpen(o);
              // M81: same as mobile — X/Escape/outside-click close
              // used to leave the flags stale for the next room.
              if (!o) {
                setDesc("");
                setIsPrivate(true);
                setIsE2EE(false);
              }
            }}
          >
            <DialogTrigger asChild>
              <button
                type="button"
                aria-label="Create a new room"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary text-primary-foreground transition-opacity hover:opacity-90"
              >
                <Plus className="h-[19px] w-[19px]" strokeWidth={2.2} />
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a room</DialogTitle>
                <DialogDescription>
                  Public rooms anyone signed in can join. Private rooms stay hidden until you add
                  members.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={60}
                    placeholder="design-team"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="desc">Description</Label>
                  <Textarea
                    id="desc"
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    maxLength={280}
                    placeholder="What's this room about?"
                  />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
                  <div>
                    <Label htmlFor="private">Private room</Label>
                    <p className="text-xs text-muted-foreground">
                      Only members you add can see it.
                    </p>
                  </div>
                  <Switch id="private" checked={isPrivate} onCheckedChange={setIsPrivate} />
                </div>
                <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
                  <div>
                    <Label htmlFor="e2ee">End-to-end encrypted</Label>
                    <p className="text-xs text-muted-foreground">
                      Text messages are encrypted — only members can read them. Members
                      without encryption set up can&apos;t be sent messages.
                    </p>
                  </div>
                  <Switch id="e2ee" checked={isE2EE} onCheckedChange={setIsE2EE} />
                </div>
                <DialogFooter>
                  <Button
                    type="submit"
                    disabled={creating}
                    className="gradient-primary text-primary-foreground"
                  >
                    {creating ? "Creating…" : "Create"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
        <label
          className="mt-4 flex items-center gap-[9px] rounded-[10px] border border-border bg-secondary px-[13px] py-[10px] text-muted-foreground focus-within:border-primary/40"
          aria-label="Search conversations"
        >
          <Search className="h-[19px] w-[19px] shrink-0" />
          <input
            type="search"
            value={search}
            onChange={(e) => setChatListSearch(e.target.value)}
            // M85: was "Search chats and people" — the filter only
            // matches existing chats, there are no people results.
            // People search lives on the People page.
            placeholder="Search chats"
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </header>

      {/* M79: retry surface — unread/preview failures used to render
          as an empty-looking list with no hint anything failed. */}
      {(unreadError || previewError || membershipsError) && (
        <button
          type="button"
          onClick={() => {
            if (unreadError) void refetchUnread();
            if (previewError) void refetchPreviews();
            if (membershipsError) void refetchMemberships();
          }}
          className="mx-5 mb-2 shrink-0 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-center text-[13px] font-semibold text-amber-800 md:mx-8"
        >
          Couldn&apos;t load chat data — click to retry
        </button>
      )}

      {/* Filter tabs */}
      <div
        className="grid shrink-0 grid-cols-3 gap-1 px-5 pb-2 md:px-8"
        role="tablist"
        aria-label="Conversation filters"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={filter === t.key}
            onClick={() => setChatListFilter(t.key)}
            className={`min-h-[38px] border-b-2 text-[13px] font-bold transition-colors ${
              filter === t.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Thread list */}
      <div className="smooth-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-3.5 pt-0.5">
        {isLoading ? (
          <div className="space-y-1 px-2 pt-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-3">
                <Skeleton className="h-[50px] w-[50px] rounded-[17px]" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
            ))}
          </div>
        ) : roomsError || dmError ? (
          <div className="px-4 py-16 text-center">
            <p className="text-sm font-semibold text-foreground">Couldn&apos;t load chats</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your conversations didn&apos;t load. Check your connection and try again.
            </p>
            <button
              type="button"
              className="mt-3 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              onClick={() => {
                if (roomsError) void refetchRooms();
                if (dmError) void refetchDms();
              }}
            >
              Retry
            </button>
          </div>
        ) : threads.length === 0 ? (
          <p className="px-4 py-16 text-center text-sm text-muted-foreground">
            {search ? "No conversations match your search." : "No conversations yet."}
          </p>
        ) : (
          <>
            {threads.map((t) => {
            const pv = previewMap.get(t.id);
            const mine = pv?.user_id === user?.id;
            const preview = pv ? previewText(pv, mine, t.isE2EE) : t.fallback;
            return (
              <Link
                key={t.id}
                to="/rooms/$roomId"
                params={{ roomId: t.id }}
                className={`no-callout grid w-full grid-cols-[50px_minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] px-2.5 py-[11px] text-left transition-colors hover:bg-secondary active:bg-secondary ${
                  selectedId === t.id ? "bg-accent" : ""
                }`}
                onKeyDown={(e) => {
                  // Audit-4 M26: keyboard opener for the chat menu —
                  // same gap as mobile (row had only onContextMenu +
                  // onTouchStart). Shift+F10 is the standard
                  // context-menu key; preventDefault stops the
                  // browser's own contextmenu event (which would
                  // re-open the menu at 0,0). The Menu key fires
                  // contextmenu natively — the handler below falls
                  // back to the row rect when its coordinates are
                  // (0,0).
                  if (e.key === "F10" && e.shiftKey) {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    openChatMenu(t, rect.right, rect.top + rect.height / 2);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Audit-4 M26: a keyboard-triggered contextmenu
                  // (Menu key) has clientX/Y = 0 — anchor to the row
                  // instead of the top-left corner.
                  if (e.clientX === 0 && e.clientY === 0) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    openChatMenu(t, rect.right, rect.top + rect.height / 2);
                  } else {
                    openChatMenu(t, e.clientX, e.clientY);
                  }
                }}
                onTouchStart={(e) => {
                  if (e.touches.length !== 1) return;
                  const touch = e.touches[0];
                  touchPos.current = { x: touch.clientX, y: touch.clientY };
                  cancelLongPress();
                  lpTimer.current = window.setTimeout(() => {
                    suppressClickFor.current = t.id;
                    openChatMenu(t, touch.clientX, touch.clientY);
                    window.setTimeout(() => {
                      suppressClickFor.current = null;
                    }, 600);
                  }, 550);
                }}
                onTouchMove={(e) => {
                  const p = touchPos.current;
                  const touch = e.touches[0];
                  if (p && touch && Math.hypot(touch.clientX - p.x, touch.clientY - p.y) > 12) {
                    cancelLongPress();
                  }
                }}
                onTouchEnd={cancelLongPress}
                onTouchCancel={cancelLongPress}
                onClick={(e) => {
                  if (suppressClickFor.current === t.id) {
                    e.preventDefault();
                    suppressClickFor.current = null;
                  }
                }}
              >
                {t.kind === "room" ? (
                  <span className="grid h-[50px] w-[50px] place-items-center rounded-full bg-accent text-accent-foreground">
                    {t.isPrivate ? <Lock className="h-5 w-5" /> : <Hash className="h-5 w-5" />}
                  </span>
                ) : (
                  <span className="relative">
                    <SmartAvatar
                      userId={t.partner?.id ?? ""}
                      name={t.name}
                      className="h-[50px] w-[50px] rounded-full text-[16px]"
                      fallbackClassName={`rounded-full text-[16px] font-extrabold ${paletteFor(t.name)}`}
                    />
                    {t.partner?.is_online && (
                      <span className="absolute bottom-0 right-0 h-[13px] w-[13px] rounded-full border-[2.5px] border-card bg-[#22c55e]" />
                    )}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[15px] font-extrabold leading-snug">
                    <span className="block truncate">{t.name}</span>
                    {t.isE2EE && (
                      <span aria-label="End-to-end encrypted" title="End-to-end encrypted">
                        🔒
                      </span>
                    )}
                    {t.pinned && (
                      <Pin
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-label="Pinned"
                      />
                    )}
                    {t.muted && (
                      <BellOff
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-label="Muted"
                      />
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] font-semibold text-muted-foreground">
                    {preview}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 self-start pt-1">
                  <span className="text-[11.5px] font-bold text-[#93a498]">
                    {threadTime(t.lastActivity)}
                  </span>
                  {(unreadMap.get(t.id) ?? 0) > 0 && (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[10px] font-extrabold tabular-nums text-primary-foreground">
                      {(unreadMap.get(t.id) ?? 0) > 99 ? "99+" : unreadMap.get(t.id)}
                    </span>
                  )}
                </span>
              </Link>
            );
            })}
            {/* Audit-4 M5: rooms beyond the first 200 are one tap away. */}
            {hasNextPage && (
              <div className="flex justify-center py-3">
                <button
                  type="button"
                  className="rounded-full bg-secondary px-4 py-2 text-sm font-semibold text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? "Loading…" : "Load more chats"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* WhatsApp-style chat menu */}
      <ChatMenu
        menu={chatMenu}
        onClose={() => setChatMenu(null)}
        onPin={onPinChat}
        onMute={onMuteChat}
        onMarkRead={onMarkChatRead}
        onRetryPinMute={() => void refetchMemberships()}
        onDelete={(chatId) => {
          const t = threads.find((x) => x.id === chatId);
          if (t)
            setConfirmDelete({
              chatId,
              kind: t.kind,
              name: t.name,
              canDeleteRoom: t.kind === "room" && t.createdBy === user?.id,
            });
        }}
      />

      {/* Confirm delete / leave */}
      <Dialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirmDelete?.kind === "direct"
                ? "Delete this chat?"
                : confirmDelete?.canDeleteRoom
                  ? "Delete this room?"
                  : "Leave this group?"}
            </DialogTitle>
            <DialogDescription>
              {confirmDelete?.kind === "direct"
                ? `This will permanently delete this chat and all its messages for both of you.`
                : confirmDelete?.canDeleteRoom
                  ? `"${confirmDelete?.name}" and all its messages will be permanently deleted for everyone.`
                  : `You will leave "${confirmDelete?.name}".`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onConfirmDelete} disabled={deleting}>
              {deleting
                ? confirmDelete?.kind !== "direct" && !confirmDelete?.canDeleteRoom
                  ? "Leaving…"
                  : "Deleting…"
                : confirmDelete?.kind === "direct"
                  ? "Delete"
                  : confirmDelete?.canDeleteRoom
                    ? "Delete room"
                    : "Leave"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
