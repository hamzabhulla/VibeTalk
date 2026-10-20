import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  sendMessage,
  deleteMessage,
  deleteOwnAttachmentFile,
  signAttachment,
  toggleReaction,
  editMessage,
  markRoomRead,
  getReadReceipts,
  getPublicProfiles,
} from "@/lib/chat.functions";
import { MembersDialog } from "@/components/members-dialog";
import { PeerProfileSheet } from "@/components/peer-profile";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useCall } from "@/components/call-overlay";
import {
  callMessageIcon,
  callMessageSummary,
  parseCallMessage,
} from "@/lib/call-message";
import { uploadAttachment, pickMessageType, formatBytes } from "@/lib/upload";
import {
  queueMessage,
  getQueuedForRoom,
  removeQueuedMessage,
  updateQueuedMessage,
  classifyFlushError,
  OUTBOX_MAX_FAILURES,
  OutboxFullError,
  type OutboxEntry,
} from "@/lib/outbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SmartAvatar } from "@/components/smart-avatar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ArrowLeft,
  Send,
  Trash2,
  Pencil,
  Hash,
  Paperclip,
  File as FileIcon,
  Download,
  SmilePlus,
  Image as ImageIcon,
  AlertCircle,
  AlertTriangle,
  Clock,
  Mic,
  Check,
  CheckCheck,
  WifiOff,
  Phone,
  Video,
  RotateCcw,
  X,
} from "lucide-react";
import { VoiceRecorder } from "@/components/voice-recorder";
import { VoicePlayer } from "@/components/voice-player";
import {
  encryptForRoom,
  decryptBody,
  getRoomMemberKeys,
  isEncryptedBody,
  hasWrappedKey,
  isCorruptEnvelope,
  E2EENotReadyError,
  takeKeyReclaimNotice,
} from "@/lib/e2ee";
import { MESSAGE_BODY_MAX_LENGTH, MessageTooLongError } from "@/lib/message-limits";
import { MessageMenu, type MenuState } from "@/components/message-menu";
import { isUserOnline, formatServerRelativeTime, serverAlignedNowMs } from "@/lib/presence";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_app/rooms/$roomId")({
  component: RoomPage,
  // Audit-4 L80: this route consumes no search keys.
  validateSearch: () => ({}),
  head: () => ({
    meta: [
      { title: "Conversation — VibeTalk" },
      {
        name: "description",
        content: "A private, real-time VibeTalk conversation with secure file sharing.",
      },
      { property: "og:title", content: "Conversation — VibeTalk" },
      {
        property: "og:description",
        content: "A private, real-time VibeTalk conversation with secure file sharing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type Profile = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  is_online: boolean;
  last_seen_at?: string;
};
type Message = {
  id: string;
  user_id: string;
  body: string | null;
  created_at: string;
  edited_at: string | null;
  type: string;
  attachment_url: string | null;
  attachment_meta: { name?: string; size?: number; mime?: string } | null;
  // M14: member count snapshot at send time (null for pre-M14 messages).
  recipient_count?: number | null;
};

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86_400_000);
  if (d >= startOfToday) return "Today";
  if (d >= startOfYesterday) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Audit-2 H7: keyset cursor for message pagination, as a PostgREST
 * `.or()` filter. Matches messages OLDER than the cursor in
 * (created_at DESC, id DESC) order, INCLUSIVE of the cursor message
 * itself: `(created_at < C) OR (created_at = C AND id <= idC)`.
 * The boundary message is re-fetched as the next page's newest row and
 * deduped on flatten — that overlap is what makes refetch gap-proof
 * (a new message pushing the old page-0 oldest out of page 0 leaves it
 * in the older page) and delete-proof (a pulled-up head dedupes).
 * The id tiebreak keeps identical-created_at messages ordered and
 * guarantees the cursor strictly advances (no lost ties, no loop).
 */
function keysetCursor(cursor: { created_at: string; id: string }): string {
  return (
    `created_at.lt.${cursor.created_at},` +
    `and(created_at.eq.${cursor.created_at},id.lte.${cursor.id})`
  );
}

function AttachmentView({ msg, mine }: { msg: Message; mine: boolean }) {
  const sign = useServerFn(signAttachment);
  const qc = useQueryClient();
  const path = msg.attachment_url;
  // Audit-2 M26: signed URLs cached in React Query, keyed by path —
  // the old per-component state fired a sign call per mount with no
  // dedupe, no retry, and no recovery when a long-open tab outlived
  // the URL. Server TTL is 1h; staleTime 30m re-signs well before
  // expiry while mounts within 30m share one call.
  const {
    data: url,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["signed-attachment", path],
    enabled: !!path,
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const r = await sign({ data: { path: path! } });
      return r.url;
    },
  });
  // One automatic re-sign when a media element fails to load (the
  // tab outlived the URL). Guarded to once — a genuinely missing
  // file would otherwise re-sign forever; the second failure
  // surfaces the failed UI instead.
  const reSignedRef = useRef(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const handleMediaError = () => {
    if (!reSignedRef.current) {
      reSignedRef.current = true;
      void qc.invalidateQueries({ queryKey: ["signed-attachment", path] });
    } else {
      setMediaFailed(true);
    }
  };
  const retry = () => {
    reSignedRef.current = false;
    setMediaFailed(false);
    void refetch();
  };

  const meta = msg.attachment_meta ?? {};
  const name = meta.name ?? "file";
  const size = typeof meta.size === "number" ? formatBytes(meta.size) : "";

  if (!path) return null;
  if (isError || mediaFailed) {
    return (
      <div className="inline-flex items-center gap-2 rounded-xl bg-destructive/15 px-3 py-2 text-xs text-destructive">
        <AlertCircle className="h-4 w-4" /> Attachment unavailable
        <button type="button" onClick={retry} className="font-semibold underline underline-offset-2">
          Retry
        </button>
      </div>
    );
  }
  if (msg.type === "image") {
    if (!url) return <Skeleton className="h-32 w-56 rounded-xl" />;
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block max-w-[240px]">
        <img src={url} alt={name} onError={handleMediaError} className="max-h-64 rounded-xl object-cover" />
      </a>
    );
  }
  if (msg.type === "video") {
    if (!url) return <Skeleton className="h-32 w-56 rounded-xl" />;
    return (
      <video src={url} controls preload="metadata" onError={handleMediaError} className="max-h-64 max-w-[240px] rounded-xl" />
    );
  }
  if (msg.type === "audio") {
    // Audit-2 L40: the skeleton must match VoicePlayer's box
    // (53px tall × 230px wide, measured) — the old media skeleton (128×224)
    // jumped ~76px in height when the player rendered.
    if (!url) return <Skeleton className="h-[53px] w-[230px] rounded-xl" />;
    return <VoicePlayer url={url} mine={mine} onError={handleMediaError} />;
  }
  // Plain file: name/size live in meta, so the row renders
  // immediately — href-less + pulsing until the URL arrives
  // (the old media-sized skeleton didn't fit here).
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={url ? undefined : (e) => e.preventDefault()}
      aria-busy={!url}
      className={`inline-flex items-center gap-2.5 rounded-xl px-3 py-2 ${url ? "transition-opacity hover:opacity-90" : "animate-pulse pointer-events-none"} ${
        mine ? "bg-white/15" : "bg-secondary"
      }`}
    >
      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
          mine ? "bg-white/20 text-white" : "gradient-primary text-primary-foreground"
        }`}
      >
        <FileIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{name}</span>
        {size && (
          <span className={`block text-[11px] ${mine ? "text-white/70" : "text-muted-foreground"}`}>
            {size}
          </span>
        )}
      </span>
      <Download
        className={`h-4 w-4 shrink-0 ${mine ? "text-white/70" : "text-muted-foreground"}`}
      />
    </a>
  );
}

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🔥", "🙏"];

// Audit-2 L39: key the room view by roomId — navigating Room A →
// Room B in the same mounted route used to keep A's state
// (decrypted/decryptFailed/queued/draft/editing/…) alive in the
// reused component, so E2EE decrypt state could leak across rooms.
// A key forces a full remount per room: no cross-room state leak.
// (The offline outbox is safe: it reloads per-room from IndexedDB
// via getQueuedForRoom on mount.)
function RoomPage() {
  const { roomId } = Route.useParams();
  return <RoomPageInner key={roomId} roomId={roomId} />;
}

function RoomPageInner({ roomId }: { roomId: string }) {
  const { user } = useAuth();
  const { startCall } = useCall();
  const send = useServerFn(sendMessage);
  const del = useServerFn(deleteMessage);
  const deleteOwnFile = useServerFn(deleteOwnAttachmentFile);
  const react = useServerFn(toggleReaction);
  const edit = useServerFn(editMessage);
  const doMarkRead = useServerFn(markRoomRead);
  const fetchReceipts = useServerFn(getReadReceipts);
  const getProfiles = useServerFn(getPublicProfiles);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const {
    data: room,
    isError: roomError,
    refetch: refetchRoom,
  } = useQuery({
    queryKey: ["room", roomId],
    queryFn: async () => {
      // is_e2ee is best-effort until vibetalk-e2ee-visibility.sql runs.
      const attempt = await supabase
        .from("rooms")
        .select("id, name, description, is_dm, is_private, created_by, is_e2ee")
        .eq("id", roomId)
        .single();
      if (attempt.error && String(attempt.error.message ?? "").includes("is_e2ee")) {
        const fallback = await supabase
          .from("rooms")
          .select("id, name, description, is_dm, is_private, created_by")
          .eq("id", roomId)
          .single();
        if (fallback.error) throw fallback.error;
        return { ...fallback.data, is_e2ee: false };
      }
      if (attempt.error) throw attempt.error;
      return attempt.data;
    },
    retry: 1,
  });


  // DM partner profile (H5: via the privacy-filtered server fn — a
  // direct profiles query would leak a private name/avatar to the client).
  const { data: dmPartner } = useQuery({
    queryKey: ["dm-partner", roomId, user?.id],
    enabled: !!room?.is_dm && !!user?.id,
    queryFn: async () => {
      const currentUserId = user?.id;
      if (!currentUserId) return null;
      const { data: members } = await supabase
        .from("room_members")
        .select("user_id")
        .eq("room_id", roomId)
        .neq("user_id", currentUserId);
      const otherId = members?.[0]?.user_id;
      if (!otherId) return null;
      const rows = await getProfiles({ data: { userIds: [otherId] } });
      return (rows[0] ?? null) as Profile | null;
    },
  });

  // M12: cursor pagination — the old newest-200 cap made older history
  // unreachable. Pages are 200 messages, oldest→newest within a page.
  // Audit-2 H7: the cursor is a (created_at, id) KEYSET with an
  // INCLUSIVE boundary (see keysetCursor below), not a bare
  // `created_at < oldest`: a bare created_at cursor is
  // position-unstable (a new message pushes the old page-0 oldest out
  // of page 0 while page 1's cursor still excludes it = gap; a delete
  // pulls page 1's head into page 0 = duplicate; identical created_at
  // ties lose messages). The inclusive boundary re-fetches the boundary
  // message as the next page's newest row, and the flatten dedupes it.
  const {
    data: messagesPages,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["messages", roomId],
    queryFn: async ({
      pageParam,
    }: {
      pageParam: { created_at: string; id: string } | null;
    }) => {
      // Newest 200 first, then reversed so the list renders oldest→newest.
      // (Two inline selects with string literals — a helper taking a
      // `string` param makes Supabase's types fall back to
      // GenericStringError and the cast fails.)
      const runWithSnapshot = () => {
        let q = supabase
          .from("messages")
          .select(
            "id, user_id, body, created_at, edited_at, type, attachment_url, attachment_meta, recipient_count",
          )
          .eq("room_id", roomId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(200);
        if (pageParam) q = q.or(keysetCursor(pageParam));
        return q;
      };
      const runWithoutSnapshot = () => {
        let q = supabase
          .from("messages")
          .select("id, user_id, body, created_at, edited_at, type, attachment_url, attachment_meta")
          .eq("room_id", roomId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(200);
        if (pageParam) q = q.or(keysetCursor(pageParam));
        return q;
      };
      const { data, error } = await runWithSnapshot();
      // Column missing (SQL §M14 not run yet) → retry without the
      // snapshot instead of failing the whole message load.
      if (error && /recipient_count/i.test(error.message ?? "")) {
        const { data: fallbackData, error: fallbackError } = await runWithoutSnapshot();
        if (fallbackError) throw fallbackError;
        return ((fallbackData ?? []) as Message[]).reverse();
      }
      if (error) throw error;
      return ((data ?? []) as Message[]).reverse();
    },
    initialPageParam: null as { created_at: string; id: string } | null,
    getNextPageParam: (lastPage) => {
      // A full page means there may be older messages; the oldest
      // message of this page is the cursor for the next one.
      if (lastPage.length < 200) return undefined;
      const oldest = lastPage[0];
      if (!oldest) return undefined;
      return { created_at: oldest.created_at, id: oldest.id };
    },
  });
  // Flatten pages oldest→newest + dedupe by id (keep first). Pages
  // arrive newest-first (pages[0] = newest 200), each already
  // oldest→newest within itself, so the PAGE order is reversed before
  // flattening (audit-2 H6). Dedupe (audit-2 H7): page fetches use an
  // INCLUSIVE keyset cursor, so the boundary message appears in both
  // adjacent pages by design (overlap = gap-proof refetch); and a
  // refetch can pull a stale page-1 head into page 0 (delete case).
  // Without dedupe the same message would render twice.
  // [...pages] copies so reverse() never mutates React Query's cache.
  const messages = useMemo(() => {
    if (!messagesPages) return undefined;
    const seen = new Set<string>();
    const out: Message[] = [];
    for (const m of [...messagesPages.pages].reverse().flat()) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
    return out;
  }, [messagesPages]);

  // E2EE rooms: decrypt incoming text messages as they arrive.
  // (Audit-2 H11: NO ensureKeypair on view — merely opening the room
  // must not generate/publish a keypair and rotate the profile key.
  // The keypair is created + published on this browser's first send
  // via encryptForRoom, and decryptBody loads locally only.)
  const [decrypted, setDecrypted] = useState<Map<string, string>>(new Map());
  const [decryptFailed, setDecryptFailed] = useState<Set<string>>(new Set());
  const memberKeysFn = useServerFn(getRoomMemberKeys);

  useEffect(() => {
    if (!room?.is_e2ee || !user?.id || !messages) return;
    const pending = messages.filter(
      (m) =>
        m.type === "text" &&
        isEncryptedBody(m.body) &&
        // No wrapped key = sent before this user joined: never decryptable,
        // and must not be marked as a decrypt failure.
        hasWrappedKey(m.body, user.id) &&
        !decrypted.has(m.id) &&
        !decryptFailed.has(m.id),
    );
    if (pending.length === 0) return;
    let alive = true;
    (async () => {
      const next = new Map(decrypted);
      const failed = new Set(decryptFailed);
      for (const m of pending) {
        // Audit-2 H31: pass the binding context — v2 envelopes only
        // decrypt with the message's own room + sender.
        const pt = await decryptBody(m.body, user.id, { roomId, senderId: m.user_id });
        if (!alive) return;
        if (pt === null) failed.add(m.id);
        else next.set(m.id, pt);
      }
      // Audit-6 B-D6: bound the cache — it grew by one entry per
      // decrypted message for the whole mount (decrypted plaintext
      // held in memory indefinitely on long histories). Cap at
      // 1000, evicting oldest-first (Map insertion order); an
      // evicted message simply re-decrypts if it re-enters the
      // pending set.
      while (next.size > 1000) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      setDecrypted(next);
      setDecryptFailed(failed);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, room?.is_e2ee, user?.id]);

  // Audit-2 L33: the transient "still decrypting" placeholder — Copy
  // must never capture it (it would paste a lie). Kept as a const so
  // the disabled check below can't drift from the displayed string.
  const DECRYPTING_PLACEHOLDER = "🔒 Decrypting…";
  const DECRYPT_FAILED_PLACEHOLDER = "Couldn't decrypt this message";
  const PRE_JOIN_PLACEHOLDER = "🔒 Sent before you joined";
  // Audit-3 A4-N19: Copy is disabled for ALL placeholder bodies —
  // decrypting AND the two terminal ones. Copying "Couldn't decrypt
  // this message" would paste a lie into another app.
  const isPlaceholderBody = (body: string | null): boolean =>
    body === DECRYPTING_PLACEHOLDER ||
    body === DECRYPT_FAILED_PLACEHOLDER ||
    body === PRE_JOIN_PLACEHOLDER;
  /** Plaintext to display for a message (decrypted in E2EE rooms). */
  const displayBodyFor = (m: Message): string | null => {
    if (!room?.is_e2ee || m.type !== "text" || !isEncryptedBody(m.body)) return m.body;
    // Audit-3 A4-N20: a corrupt (unparseable) envelope is NOT a
    // pre-join message — label it as undecryptable.
    if (user?.id && isCorruptEnvelope(m.body)) return DECRYPT_FAILED_PLACEHOLDER;
    if (user?.id && !hasWrappedKey(m.body, user.id)) return PRE_JOIN_PLACEHOLDER;
    if (decrypted.has(m.id)) return decrypted.get(m.id) ?? null;
    if (decryptFailed.has(m.id)) return DECRYPT_FAILED_PLACEHOLDER;
    return DECRYPTING_PLACEHOLDER;
  };

  /** Encrypt text for this room when it's an E2EE room, else pass through. */
  const maybeEncrypt = async (text: string): Promise<string> => {
    if (!room?.is_e2ee || !user?.id) {
      if (text.length > MESSAGE_BODY_MAX_LENGTH) throw new MessageTooLongError(false);
      return text;
    }
    const keys = await memberKeysFn({ data: { roomId } });
    const encrypted = await encryptForRoom(roomId, text, user.id, keys);
    // Audit-5 B3-HIGH: this browser's published key had been replaced
    // by a different one (another device, or a key published from a
    // stolen session) and ensureKeypair just restored ours — say so.
    if (takeKeyReclaimNotice()) {
      toast.warning(
        "Your encryption key had been changed — we've restored the key from this device. If you didn't switch devices, please secure your account.",
        { duration: 8000 },
      );
    }
    // M106: the envelope grows with each recipient's wrapped key — a
    // 4000-char message in a big E2EE room can exceed the server's body
    // cap. Check the EXACT envelope before sending so the user gets a
    // friendly error instead of a generic Zod rejection.
    if (encrypted.length > MESSAGE_BODY_MAX_LENGTH) {
      throw new MessageTooLongError(true);
    }
    return encrypted;
  };

  // Audit-2 M29: prepare a text body for the outbox. E2EE rooms must
  // NEVER queue plaintext — encrypt at queue time. If the member
  // keys can't be fetched (offline / the same outage), refuse-and-
  // warn: the draft stays in the composer, nothing is queued.
  // Returns null on refusal. Non-E2EE rooms — and the sliver where
  // the room query hasn't resolved yet — queue plaintext with
  // encrypted: false; flush encrypts it once the room is known.
  // (No client-side key cache: cached keys could go stale on member
  // rotation and produce messages some members can't decrypt.)
  const encryptForQueue = async (
    text: string,
  ): Promise<{ body: string; encrypted: boolean } | null> => {
    if (!room?.is_e2ee) return { body: text, encrypted: false };
    try {
      return { body: await maybeEncrypt(text), encrypted: true };
    } catch (err) {
      if (err instanceof E2EENotReadyError) {
        toast.error(`${err.message} — message not queued.`, { duration: 6000 });
      } else {
        toast.error("Couldn't load encryption keys — message not queued. Your draft is kept below.");
      }
      return null;
    }
  };

  const userIds = useMemo(
    () => Array.from(new Set((messages ?? []).map((m) => m.user_id))),
    [messages],
  );
  // M15: refs so the realtime handlers (whose effect doesn't re-run on
  // every message) can check payloads against the CURRENT room state.
  const userIdsRef = useRef<string[]>([]);
  userIdsRef.current = userIds;
  // Audit-2 M23: the DM partner's id, mirrored for the profiles
  // handler below (same ref pattern — the realtime effect doesn't
  // re-run when the partner query resolves).
  const dmPartnerIdRef = useRef<string | null>(null);
  dmPartnerIdRef.current = dmPartner?.id ?? null;
  // Audit-2 L37: per-user profile queries — the old single query keyed
  // ["profiles", allIds.join(",")] refetched EVERY sender's profile
  // whenever ANY new sender arrived. Now a new sender adds exactly
  // one query (the rest hit cache). 5-min staleTime: remounts don't
  // re-burst; the realtime handler below invalidates the single
  // changed user's key, so freshness for CHANGED profiles is kept.
  const profileResults = useQueries({
    queries: userIds.map((id) => ({
      queryKey: ["profiles", id],
      queryFn: async () => {
        // H5: sender names/avatars go through the privacy-filtered server
        // fn — a direct profiles query would leak private names/avatars.
        const rows = await getProfiles({ data: { userIds: [id] } });
        return ((rows.filter(Boolean) ?? [])[0] ?? null) as Profile | null;
      },
      staleTime: 5 * 60_000,
    })),
  });
  // (profileMap is built below, after the typing profile queries —
  // Audit-3 A4-N13 merges typing users' profiles into it.)

  /** Users (other than me) whose read receipt covers the message timestamp. */
  const seenBy = (createdAt: string): string[] => {
    const t = new Date(createdAt).getTime();
    return (receipts ?? [])
      .filter((r) => r.user_id !== user?.id && new Date(r.last_read_at).getTime() >= t)
      .map((r) => r.user_id);
  };
  /** ✓✓ when everyone else in the chat has read the message. */
  // Seen-by-all: compares against the ACTUAL member list, not just receipt
  // rows (a member who never opened the chat has no row yet and must not
  // count as "seen"). For DMs, one fresh receipt from the partner is enough.
  const isSeenByAll = (m: Message): boolean => {
    if (m.user_id !== user?.id) return false;
    const t = new Date(m.created_at).getTime();
    const fresh = (receipts ?? []).filter(
      (r) =>
        r.user_id !== user?.id &&
        new Date(r.last_read_at).getTime() >= t &&
        // Audit-3 A4-N18: only CURRENT members count toward ✓✓ — an
        // ex-member's stale receipt used to satisfy "seen by all".
        // memberIdsRef null = not loaded yet → fail open (old
        // behavior). seenBy (the Info readers list) intentionally
        // keeps historical readers — that list is history, not ✓✓.
        (memberIdsRef.current === null || memberIdsRef.current.includes(r.user_id)),
    );
    if (room?.is_dm) return fresh.length > 0;
    // M14: prefer the send-time recipient snapshot (a member who left
    // later must not retroactively flip old messages to "seen by all").
    // Pre-M14 messages have no snapshot → live member count fallback.
    const need = (m.recipient_count ?? memberCount ?? 0) - 1;
    return need > 0 && fresh.length >= need;
  };
  const isOnline = (profile?: Profile | null) => isUserOnline(profile?.last_seen_at);

  const { data: memberCount } = useQuery({
    queryKey: ["member-count", roomId],
    enabled: !room?.is_dm,
    queryFn: async () => {
      const { count } = await supabase
        .from("room_members")
        .select("user_id", { count: "exact", head: true })
        .eq("room_id", roomId);
      return count ?? 0;
    },
  });

  // Read receipts: who has seen what (drives the ✓ / ✓✓ ticks).
  const { data: receipts } = useQuery({
    queryKey: ["receipts", roomId],
    queryFn: () => fetchReceipts({ data: { roomId } }),
  });

  // Mark the room as read whenever we're looking at fresh messages.
  // M14: track how many messages were present at the last mark, so a
  // scroll-to-bottom only re-marks when new messages actually arrived
  // (not on every scroll tick).
  const lastMarkedCountRef = useRef(0);
  const markRead = useRef<() => void>(() => {});
  // Audit-6 B-D5: the assignment used to happen DURING render — a
  // render-phase ref write is a React anti-pattern (fragile under
  // StrictMode/concurrent rendering, where a discarded render's
  // closure can be the one that lands). Every caller runs
  // post-paint (800ms timer, scroll, visibilitychange), so an
  // every-render effect keeps the closure exactly as fresh.
  useEffect(() => {
    markRead.current = () => {
      if (document.visibilityState !== "visible") return;
      // Audit-2 M20: the marked count advances ONLY on success. The old
      // code set it BEFORE the call and swallowed the error, so a
      // failed mark-read permanently suppressed the retry (the scroll
      // trigger only fires when messages.length > lastMarkedCount).
      const count = messages?.length ?? 0;
      doMarkRead({ data: { roomId } })
        .then(() => {
          lastMarkedCountRef.current = count;
          qc.invalidateQueries({ queryKey: ["receipts", roomId] });
          qc.invalidateQueries({ queryKey: ["unread-counts"] });
        })
        .catch((err: unknown) => {
          // Retry on the next scroll-to-bottom / visibilitychange (the
          // count was not advanced). Log instead of swallowing — the
          // old "ticks just stay single" hid real failures.
          console.warn("[read] markRoomRead failed:", err);
        });
    };
  });
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    // M14: only mark read when the user is actually looking at the
    // latest messages (near the bottom) — NOT 800ms after load while
    // they're scrolled up reading old history. Scrolling to the
    // bottom marks read (see onMessagesScroll).
    const isNearBottom = () => {
      const el = scrollRef.current;
      if (!el) return true;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    if (!isNearBottom()) return;
    const t = window.setTimeout(() => markRead.current(), 800);
    const onVis = () => {
      // Audit-2 M20: gate on new messages (same as the scroll
      // trigger) — an unconditional re-mark on every tab-switch
      // was a redundant call; the gate still retries after a
      // failed mark (the count was not advanced).
      if (
        document.visibilityState === "visible" &&
        isNearBottom() &&
        (messages?.length ?? 0) > lastMarkedCountRef.current
      )
        markRead.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, messages?.length]);

  // Audit-3 A4-N9: reactions only for the newest 500 messages —
  // the old query put every loaded message id into one IN (...) list.
  const messageIds = useMemo(() => (messages ?? []).map((m) => m.id).slice(-500), [messages]);
  const messageIdsRef = useRef<string[]>([]);
  messageIdsRef.current = messageIds;
  const { data: reactions } = useQuery({
    queryKey: ["reactions", roomId, messageIds.join(",")],
    enabled: messageIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("message_reactions")
        .select("id, message_id, user_id, emoji")
        .in("message_id", messageIds);
      return (data ?? []) as { id: string; message_id: string; user_id: string; emoji: string }[];
    },
  });
  const reactionsByMsg = useMemo(() => {
    const map = new Map<string, { emoji: string; count: number; mine: boolean }[]>();
    for (const r of reactions ?? []) {
      const arr = map.get(r.message_id) ?? [];
      const existing = arr.find((a) => a.emoji === r.emoji);
      if (existing) {
        existing.count++;
        if (r.user_id === user?.id) existing.mine = true;
      } else {
        arr.push({ emoji: r.emoji, count: 1, mine: r.user_id === user?.id });
      }
      map.set(r.message_id, arr);
    }
    return map;
  }, [reactions, user?.id]);

  // Realtime messages + reactions + partner presence + read receipts
  // rtLive tracks the socket so the header can show "Reconnecting" instead
  // of silently missing live updates.
  const [rtLive, setRtLive] = useState(false);
  // Audit-3 A7-N2: catch-up refetch on re-SUBSCRIBED after a disconnect
  // (mirrors the inbox pattern) — events were missed while the socket
  // was down. The refetch goes through scheduleRoomKeys so the M54
  // batching still applies.
  const roomDisconnectedRef = useRef(false);
  useEffect(() => {
    // Audit-2 M54: coalesce room invalidations — same M30 pattern as
    // the inbox. A burst (messages + reads + reactions + membership)
    // used to fire one invalidation per event per key. Leading +
    // trailing 500ms over the union of dirtied query keys. Keys are
    // full query-key arrays (dm-partner is multi-segment), keyed by
    // their JSON form. The removed-while-viewing navigation below
    // stays immediate — it is not an invalidation.
    const roomDirty = new Map<string, unknown[]>();
    let roomTimer: number | null = null;
    const flushRoomDirty = () => {
      for (const key of roomDirty.values()) qc.invalidateQueries({ queryKey: key });
      roomDirty.clear();
    };
    const armRoomWindow = () => {
      roomTimer = window.setTimeout(() => {
        roomTimer = null;
        if (roomDirty.size > 0) {
          flushRoomDirty();
          armRoomWindow();
        }
      }, 500);
    };
    const scheduleRoomKeys = (...keys: unknown[][]) => {
      for (const k of keys) roomDirty.set(JSON.stringify(k), k);
      if (roomTimer !== null) return;
      flushRoomDirty();
      armRoomWindow();
    };
    const ch = supabase
      .channel(`room-${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `room_id=eq.${roomId}` },
        () => scheduleRoomKeys(["messages", roomId]),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, (payload) => {
        // M15: don't invalidate on EVERY reaction in EVERY room — only
        // when the reaction belongs to a message in THIS room. (A new
        // message's reactions refetch anyway via the key change.)
        const mid =
          (payload.new as { message_id?: string } | null)?.message_id ??
          (payload.old as { message_id?: string } | null)?.message_id;
        if (mid && messageIdsRef.current.includes(mid)) {
          scheduleRoomKeys(["reactions", roomId]);
        }
      })
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "presence" },
        (payload) => {
          // Audit-6 B-D1: this binding watched public.profiles —
          // dead since §C3 made profiles own-row-only (postgres_changes
          // honours RLS, so another user's row can NEVER arrive; the
          // one row that could — the viewer's own — was excluded
          // below anyway). Presence lives in the presence table now
          // (LOW-13), whose read policy (presence_read_visible) does
          // deliver visible users' rows. Gate unchanged (M35/M23):
          // only a sender's or the DM partner's tick matters here.
          // Name/avatar changes have no live source post-§C3; they
          // arrive via the queries' own refetches.
          const changedId = (payload.new as { user_id?: string } | null)?.user_id;
          if (!changedId || changedId === user?.id) return;
          const isRelevant =
            userIdsRef.current.includes(changedId) || changedId === dmPartnerIdRef.current;
          if (!isRelevant) return;
          scheduleRoomKeys(["dm-partner", roomId, user?.id]);
          scheduleRoomKeys(["profiles", changedId]);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "read_receipts",
          filter: `room_id=eq.${roomId}`,
        },
        () => scheduleRoomKeys(["receipts", roomId]),
      )
      // M14: member joins/leaves change the ✓✓ denominator
      // (member-count) — without this, the threshold stays stale
      // until remount.
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "room_members",
          filter: `room_id=eq.${roomId}`,
        },
        async (payload) => {
          scheduleRoomKeys(["member-count", roomId]);
          // M15: the members list (MembersDialog) also goes stale on
          // joins/leaves — refresh it with the same event.
          scheduleRoomKeys(["room-members", roomId]);
          // Audit-2 M22: the room itself + the lists go stale on
          // membership changes (a removed room must vanish from
          // the list; an added room must appear — without refresh).
          scheduleRoomKeys(["room", roomId], ["rooms"], ["dms"]);
          // Audit-2 M24: the typing membership gate reads this key —
          // refresh it on membership changes so a removal takes
          // effect without a remount.
          scheduleRoomKeys(["room-member-ids", roomId]);
          // Audit-2 M22: removed-while-viewing — if MY membership
          // row was deleted, leave the view (the composer would
          // otherwise stay enabled until the next send fails).
          if (payload.eventType === "DELETE" && user?.id) {
            const removedUserId = (payload.old as { user_id?: string } | null)?.user_id;
            let removedMe = removedUserId === user.id;
            if (!removedUserId) {
              // REPLICA IDENTITY didn't include the row — verify
              // directly instead of guessing from a missing old.
              const { data, error } = await supabase
                .from("room_members")
                .select("user_id")
                .eq("room_id", roomId)
                .eq("user_id", user.id)
                .maybeSingle();
              removedMe = !error && !data;
            }
            if (removedMe) {
              toast.warning("You were removed from this room.");
              navigate({ to: "/rooms" });
            }
          }
        },
      )
      // M15: room renamed / deleted / is_e2ee flipped / creator
      // changed mid-view — without this, the header + room state stay
      // stale until a manual refresh. A DELETE refetches the room
      // query into its error state ("Couldn't open this chat").
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rooms",
          filter: `id=eq.${roomId}`,
        },
        () => scheduleRoomKeys(["room", roomId]),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRtLive(true);
          if (roomDisconnectedRef.current) {
            roomDisconnectedRef.current = false;
            scheduleRoomKeys(["messages", roomId], ["receipts", roomId], ["member-count", roomId]);
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          roomDisconnectedRef.current = true;
          setRtLive(false);
          console.warn("[room] realtime channel lost:", status);
        } else {
          setRtLive(false);
        }
      });
    return () => {
      setRtLive(false);
      if (roomTimer !== null) window.clearTimeout(roomTimer);
      supabase.removeChannel(ch);
    };
  }, [roomId, qc, user?.id]);

  // Audit-2 M25: in-flight reaction toggles. The toggle is
  // server-side, so two fast clicks fired two toggles (net zero)
  // and felt dead. The ref is the guard (synchronous — a state
  // read would still see the pre-click render on a rapid second
  // click); the state mirrors it for the disabled UI below.
  const reactingRef = useRef<Set<string>>(new Set());
  const [reactingKeys, setReactingKeys] = useState<Set<string>>(new Set());
  const onReact = async (messageId: string, emoji: string) => {
    const key = `${messageId}:${emoji}`;
    if (reactingRef.current.has(key)) return;
    const myId = user?.id;
    if (!myId) return;
    reactingRef.current.add(key);
    setReactingKeys(new Set(reactingRef.current));
    // Optimistic toggle on every matching reactions query (the key
    // has a third segment — the loaded message ids — so prefix-match).
    type ReactionRow = { id: string; message_id: string; user_id: string; emoji: string };
    const prefix = ["reactions", roomId];
    const prev = qc.getQueriesData({ queryKey: prefix });
    qc.setQueriesData({ queryKey: prefix }, (old) => {
      const rows = (old ?? []) as ReactionRow[];
      const mine = rows.find(
        (r) => r.message_id === messageId && r.emoji === emoji && r.user_id === myId,
      );
      if (mine) return rows.filter((r) => r !== mine);
      return [...rows, { id: `optimistic:${key}`, message_id: messageId, user_id: myId, emoji }];
    });
    try {
      await react({ data: { messageId, emoji } });
      qc.invalidateQueries({ queryKey: prefix });
    } catch (err) {
      // Audit-6 B-D3: SCOPED rollback — undo only MY optimistic
      // change on the CURRENT data. The old code restored the whole
      // pre-click snapshot per query, clobbering realtime reaction
      // updates from other users that landed during the mutation.
      for (const [k, snapshot] of prev) {
        const snapRows = (snapshot ?? []) as ReactionRow[];
        const mySnap = snapRows.find(
          (r) => r.message_id === messageId && r.emoji === emoji && r.user_id === myId,
        );
        qc.setQueryData(k, (current: unknown) => {
          const cur = (current ?? []) as ReactionRow[];
          let next = cur.filter((r) => r.id !== `optimistic:${key}`);
          if (
            mySnap &&
            !next.some(
              (r) => r.message_id === messageId && r.emoji === emoji && r.user_id === myId,
            )
          ) {
            next = [...next, mySnap];
          }
          return next;
        });
      }
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      reactingRef.current.delete(key);
      setReactingKeys(new Set(reactingRef.current));
    }
  };

  // Audit-2 M24: member ids for the typing membership gate (send +
  // display). Separate key from MembersDialog's ["room-members"]
  // (different shape — that one returns full profiles).
  const { data: memberIds, isError: memberIdsError } = useQuery({
    queryKey: ["room-member-ids", roomId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("room_members")
        .select("user_id")
        .eq("room_id", roomId);
      // Audit-4 M20: THROW on error — the old code read only
      // {data}, so a failed query returned [] as a SUCCESS: React
      // Query never set isError, never retried, and the closed
      // gate (A4-N13) stuck until a membership-change
      // invalidation. Throwing keeps the closed gate
      // (memberIdsError -> []) but lets React Query retry
      // transient failures (default 3 retries), and surfaces the
      // error state instead of caching a bogus [].
      if (error) throw error;
      return (data ?? []).map((r) => r.user_id as string);
    },
  });
  // null = not loaded yet (gates fail OPEN until then — the room
  // query itself proved membership when the room opened).
  // Audit-3 A4-N13: a FAILED load is [] (closed gate), not null —
  // the old code kept failing open forever on a broken query.
  const memberIdsRef = useRef<string[] | null>(null);
  memberIdsRef.current = memberIdsError ? [] : (memberIds ?? null);

  // Authenticated database-backed typing state prevents identity spoofing.
  // M13: ONE TTL (5s) for both the read filter and the sweep — the old
  // code read `updated_at > now-5s` but swept `<4000ms`, so the indicator
  // flickered near the boundary. Rows are deleted on send / blur /
  // unmount / room change (never just left to accumulate); the TTL is
  // only the backstop for a crashed tab.
  const TYPING_TTL_MS = 5_000;
  // Audit-4 M21: clock-skew tolerance for the typing fetch filter.
  // Freshness is judged by RECEIPT time (below), not the row's
  // stamp — but the server-side filter still needs a window wide
  // enough to admit a behind-clock sender's rows (a sender 10s
  // behind stamps 10s in the past; the old now-5s filter excluded
  // them, so the indicator never showed). 60s covers gross skew;
  // rows older than that are crashed-tab leftovers, never live
  // typing. The §A8-N22 trigger (when run) makes stamps
  // server-accurate, but receipt-time works with or without it.
  const TYPING_CLOCK_TOLERANCE_MS = 60_000;
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});
  const lastTypingSentRef = useRef(0);
  // Audit-2 M24: trailing debounce timer for the event-driven refetch.
  const typingDebounceRef = useRef<number | null>(null);
  // Audit-3 A7-N6: typing channel liveness (was a bare .subscribe()).
  const typingDisconnectedRef = useRef(false);

  const clearTyping = () => {
    if (!user?.id) return;
    void supabase
      .from("typing_status")
      .delete()
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .then(
        ({ error }) => {
          if (error) console.warn("[typing] clear failed:", error.message);
        },
        (err: unknown) => console.warn("[typing] clear failed:", err),
      );
  };

  useEffect(() => {
    const loadTyping = async () => {
      // Audit-4 M21: freshness is judged by RECEIPT time, not the
      // row's updated_at. The stamp is the SENDER's clock until the
      // §A8-N22 trigger runs: a sender 10s behind never showed (the
      // old now-5s filter excluded their rows), and a sender 10min
      // ahead stuck for ~10min (the sweep aged the future stamp).
      // Receipt time fixes both directions — a row fetched now is
      // fresh now, whatever its stamp says — and the sweep below
      // (5s from receipt) expires it. The server filter stays wide
      // (60s tolerance) so behind-clock rows are admitted but
      // crashed-tab leftovers older than 60s are not.
      const since = new Date(Date.now() - TYPING_CLOCK_TOLERANCE_MS).toISOString();
      const fetchedAt = Date.now();
      const { data, error } = await supabase
        .from("typing_status")
        .select("user_id, updated_at")
        .eq("room_id", roomId)
        .gt("updated_at", since);
      // Audit-4 L42: on a transient read failure, KEEP the existing
      // indicators — the old code set {} (data is null on error),
      // wiping live indicators until the next keystroke event.
      // The 5s sweep below still expires them if the typist
      // actually stopped, so a kept indicator is at most 5s stale.
      if (error) {
        console.warn("[typing] load failed — keeping existing indicators:", error.message);
        return;
      }
      setTypingUsers(
        Object.fromEntries(
          (data ?? [])
            .filter(
              (row) =>
                row.user_id !== user?.id &&
                // Audit-2 M24: display only current members' rows —
                // a removed user's tab used to keep its row visible
                // (as "Someone is typing") until the TTL expired.
                // memberIds null = not loaded yet → fail open.
                (memberIdsRef.current === null || memberIdsRef.current.includes(row.user_id)),
            )
            .map((row) => [row.user_id, fetchedAt]),
        ),
      );
    };
    // Audit-2 M24: debounce the event-driven refetch — every
    // keystroke is a postgres_changes event; without this every
    // viewer re-selected per keystroke. Trailing 300ms; the
    // initial load below stays immediate.
    const loadTypingDebounced = () => {
      if (typingDebounceRef.current) window.clearTimeout(typingDebounceRef.current);
      typingDebounceRef.current = window.setTimeout(() => void loadTyping(), 300);
    };
    void loadTyping();
    const ch = supabase
      .channel(`typing-status-${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "typing_status", filter: `room_id=eq.${roomId}` },
        () => loadTypingDebounced(),
      )
      // Audit-3 A7-N6: status callback (was a bare .subscribe() — a
      // dead typing channel failed silently). On re-SUBSCRIBED
      // after a disconnect, refetch once — keystrokes were missed
      // while the socket was down. No badge: typing is ephemeral
      // (5s TTL sweep), so a dead channel degrades to no indicator.
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (typingDisconnectedRef.current) {
            typingDisconnectedRef.current = false;
            void loadTyping();
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          typingDisconnectedRef.current = true;
          console.warn("[typing] realtime channel lost:", status);
        }
      });
    const sweep = setInterval(() => {
      const now = Date.now();
      setTypingUsers((prev) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (now - v < TYPING_TTL_MS) next[k] = v;
          else changed = true;
        }
        // Audit-6 B-D2: return the SAME object when nothing
        // expired — the old sweep rebuilt a fresh {} every 1.5s
        // unconditionally, re-rendering the whole room view even
        // with zero typists.
        return changed ? next : prev;
      });
    }, 1500);
    return () => {
      clearInterval(sweep);
      if (typingDebounceRef.current) window.clearTimeout(typingDebounceRef.current);
      supabase.removeChannel(ch);
      // Leaving the room / unmounting — remove my typing row instead
      // of leaving it to expire. (The closure holds this room's id.)
      clearTyping();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, user?.id]);

  const sendTyping = () => {
    const now = Date.now();
    if (now - lastTypingSentRef.current < 1500) return;
    lastTypingSentRef.current = now;
    if (!user?.id) return;
    // Audit-2 M24: stop writing once membership is gone — a removed
    // user's tab used to keep upserting rows. memberIds null = not
    // loaded yet → fail open. (RLS also blocks non-member writes
    // server-side once the audit SQL has run — this is the client
    // backstop + the pre-SQL behavior.)
    if (memberIdsRef.current !== null && !memberIdsRef.current.includes(user.id)) return;
    // M13: never swallow the write — log failures instead of letting
    // a rejected promise become an invisible unhandled rejection.
    // Audit-3 A7-N7 / A8-N22: the client updated_at below is a
    // PRE-SQL fallback only — the force_typing_updated_at trigger
    // (audit3-fixes §A8-N22) overwrites updated_at := now() on
    // every INSERT and UPDATE, so the server clock, never the
    // client clock, stamps the row. The value is deliberately
    // still sent: omitting it without the trigger would FREEZE
    // the timestamp (PostgREST upsert only updates payload
    // columns on conflict, so the column default never fires on
    // the refresh path) and the indicator would die after 5s of
    // continuous typing.
    void supabase
      .from("typing_status")
      .upsert({ room_id: roomId, user_id: user.id, updated_at: new Date().toISOString() })
      .then(
        ({ error }) => {
          if (error) console.warn("[typing] upsert failed:", error.message);
        },
        (err: unknown) => console.warn("[typing] upsert failed:", err),
      );
  };

  // Audit-3 A4-N13: profile queries for typing users who never sent
  // a message (not in userIds) — without them a group member who
  // never sent anything rendered as "Someone is typing". Same
  // privacy-filtered server fn + 5-min staleTime as the sender
  // queries; the typing row itself expires in 5s, so a name change
  // mid-typing may lag one staleTime (accepted edge).
  const typingOnlyIds = useMemo(
    () => Object.keys(typingUsers).filter((id) => !userIds.includes(id)),
    [typingUsers, userIds],
  );
  const typingProfileResults = useQueries({
    queries: typingOnlyIds.map((id) => ({
      queryKey: ["profiles", id],
      queryFn: async () => {
        const rows = await getProfiles({ data: { userIds: [id] } });
        return ((rows.filter(Boolean) ?? [])[0] ?? null) as Profile | null;
      },
      staleTime: 5 * 60_000,
    })),
  });
  const profileMap = new Map(
    [...profileResults, ...typingProfileResults]
      .map((r) => r.data)
      // Pending queries have data === undefined (not null) — the
      // filter must drop both, or the first render crashes on pr.id.
      .filter((pr): pr is Profile => pr != null)
      .map((pr) => [pr.id, pr]),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  // Audit-2 H8: opening a long room must land on the LATEST message,
  // not the oldest. The old effect only scrolled when ALREADY near the
  // bottom — on first load scrollTop is 0, so a long room opened at
  // the top (and mark-read, which needs near-bottom, never fired
  // either). First successful load for a room jumps unconditionally;
  // afterwards the near-bottom-only rule applies (never yank the user
  // away from history they're reading). The flag is keyed by roomId so
  // switching rooms jumps again. The jump fires a scroll event, so
  // onMessagesScroll marks the room read (see M14).
  const initialScrollRoomRef = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!messages || messages.length === 0) return;
    if (initialScrollRoomRef.current !== roomId) {
      initialScrollRoomRef.current = roomId;
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Only auto-scroll if the user is already near the bottom — never yank
    // them away from history they're reading when a new message arrives.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages?.length, roomId]);

  // M12: scroll-up pagination. Loading an older page grows the list
  // ABOVE the viewport — without restoring scrollTop the user's view
  // would jump down by the added height. Capture scrollHeight before
  // the fetch; after the new page renders, shift scrollTop by the delta.
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const loadOlder = () => {
    const el = scrollRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    pendingScrollRestoreRef.current = el.scrollHeight;
    void fetchNextPage();
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || pendingScrollRestoreRef.current === null) return;
    if (isFetchingNextPage) return; // still loading — wait for it to land
    const delta = el.scrollHeight - pendingScrollRestoreRef.current;
    if (delta > 0) el.scrollTop += delta;
    pendingScrollRestoreRef.current = null;
  }, [messagesPages?.pages.length, isFetchingNextPage]);
  const onMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Near the top → fetch the next (older) page automatically.
    if (el.scrollTop < 100) loadOlder();
    // M14: scrolled to the latest messages with new arrivals → mark
    // read. (The 800ms load effect above skips this when scrolled up.)
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom && (messages?.length ?? 0) > lastMarkedCountRef.current) markRead.current();
  };

  const [body, setBody] = useState("");
  // Audit-3 A4-N14: per-user, per-room draft persistence. The composer
  // used to lose the draft on every room switch (key={roomId} remount).
  // Key includes the user id — a shared device must never show the
  // previous account's draft. Send clears via setBody("") below, which
  // the persist effect turns into a removeItem.
  const draftKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    const key = `${user.id}:${roomId}`;
    // Only on user/room change — never clobber in-progress typing.
    if (draftKeyRef.current === key) return;
    draftKeyRef.current = key;
    try {
      setBody(localStorage.getItem(`draft:${key}`) ?? "");
    } catch {
      // Storage unavailable (private mode) — drafts just don't persist.
      setBody("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, roomId]);
  useEffect(() => {
    if (!user?.id) return;
    try {
      if (body) localStorage.setItem(`draft:${user.id}:${roomId}`, body);
      else localStorage.removeItem(`draft:${user.id}:${roomId}`);
    } catch {
      // ignore
    }
  }, [body, user?.id, roomId]);
  const [sending, setSending] = useState(false);
  // M10: synchronous double-submit guards. React state updates are
  // async, so a fast double-Enter would see stale `sending === false`
  // in both calls and send the message twice (the disabled submit
  // button alone doesn't block Enter resubmission). Refs flip
  // synchronously, so the second call sees the first one's claim.
  const sendingRef = useRef(false);
  const uploadingRef = useRef(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadName, setUploadName] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);

  // ---- Offline outbox (WhatsApp-style) ----
  const [netOnline, setNetOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [queued, setQueued] = useState<OutboxEntry[]>([]);
  const flushingRef = useRef(false);
  // M11: entries already warned about (missing file blob) — warn once
  // per entry per mount so a stuck entry doesn't toast on every flush.
  const warnedOutboxRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const on = () => setNetOnline(true);
    const off = () => setNetOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const refreshQueue = async () => {
    try {
      // Audit-3 A4-N3: only THIS user's queued entries — a shared
      // browser must never render another user's queue as mine.
      if (!user?.id) {
        setQueued([]);
        return;
      }
      setQueued(await getQueuedForRoom(roomId, user.id));
    } catch {
      // IndexedDB unavailable — outbox disabled silently
    }
  };
  useEffect(() => {
    void refreshQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, user?.id]);

  // Flush queued messages when connectivity returns, oldest first.
  // Audit-2 H9: the old loop STOPPED (break) on the first generic
  // failure, so one poisoned entry (removed from the room, room
  // deleted, E2EE plaintext rejected, ...) blocked the whole queue
  // forever, silently, with no delete/retry escape hatch. Now:
  // - transient failures (network / keys not ready) still break WITHOUT
  //   counting — an outage must not quarantine the whole queue;
  // - server rejections count per entry; at OUTBOX_MAX_FAILURES the
  //   entry is QUARANTINED and the flush CONTINUES past it;
  // - quarantined entries are user-gated (Retry / Delete in the UI).
  // A visible toast fires once per entry per mount on quarantine — not
  // on every retry — so interval retries never spam toasts.
  const flushQueue = async () => {
    if (flushingRef.current || !user) return;
    flushingRef.current = true;
    let sentAny = false;
    try {
      // Audit-3 A4-N3: flush only THIS user's entries — unfiltered,
      // a shared browser would send another user's queue as mine.
      const items = await getQueuedForRoom(roomId, user.id);
      if (items.length === 0) return;
      // Audit-5 B2-LOW: `!room` used to defer EVERY entry silently
      // forever when the room query had ERRORED (deleted room, RLS
      // denial) — no count, no quarantine, no toast. A still-LOADING
      // room is different: defer uncounted (M27 — the room-resolved
      // flush retries). An ERRORED room never resolves by waiting,
      // so count the defer like a rejection: at OUTBOX_MAX_FAILURES
      // the entry quarantines (user-gated Retry/Delete) with the
      // usual once-per-entry toast.
      const deferForRoom = async (item: (typeof items)[number]) => {
        if (!roomError) return;
        const failures = (item.failures ?? 0) + 1;
        const quarantined = failures >= OUTBOX_MAX_FAILURES;
        await updateQueuedMessage(item.id, {
          failures,
          lastFailedAt: Date.now(),
          quarantined,
        }).catch(() => null);
        console.warn(
          `Outbox flush: entry ${item.id} deferred — room failed to load (${failures}/${OUTBOX_MAX_FAILURES})`,
        );
        if (quarantined && !warnedOutboxRef.current.has(item.id)) {
          warnedOutboxRef.current.add(item.id);
          toast.error(
            `"${item.fileName ?? "Message"}" couldn't be sent — the chat couldn't be loaded. It will stay queued until you retry or delete it.`,
          );
        }
      };
      for (const item of items) {
        // Quarantined entries are user-gated — automatic flushes skip
        // them (Retry re-arms them).
        if (item.quarantined) continue;
        // Audit-3 A4-N35: path of a file uploaded by THIS flush
        // attempt — cleaned up in the catch if the send then fails.
        let uploadedPath: string | null = null;
        try {
          if (item.type === "text") {
            // Audit-2 M27: room === undefined is NOT "not E2EE" —
            // maybeEncrypt would send plaintext into a possibly-E2EE
            // room and eat a poison count. Defer until the room
            // resolves; the room-resolved flush below retries it.
            // Audit-5 B2-LOW: an ERRORED room counts toward
            // quarantine (see deferForRoom); a loading one doesn't.
            if (!room) {
              await deferForRoom(item);
              continue;
            }
            // Audit-2 M29: entries queued with encrypted: true
            // already hold an E2E1: envelope — send as-is, never
            // re-encrypt. Legacy entries (no flag) are encrypted
            // here, as before.
            const body = item.encrypted ? item.body : await maybeEncrypt(item.body);
            // Audit-3 A4-N4: the entry id IS the idempotency key.
            await send({ data: { roomId, body, type: "text", clientId: item.id } });
          } else if (item.fileBlob) {
            // Audit-2 M27: attachments are never encrypted — never
            // upload one into an E2EE room. An entry can only get
            // here via the pre-room-load window the composer now
            // blocks, so quarantine it (never sendable) with a
            // specific message instead of poison-counting it.
            // Audit-5 B2-LOW: same counted defer for an ERRORED room.
            if (!room) {
              await deferForRoom(item);
              continue;
            }
            if (room.is_e2ee) {
              await updateQueuedMessage(item.id, {
                failures: (item.failures ?? 0) + 1,
                lastFailedAt: Date.now(),
                quarantined: true,
              }).catch(() => null);
              console.warn(
                `Outbox flush: entry ${item.id} is an attachment for an E2EE room — quarantined, never sendable.`,
              );
              if (!warnedOutboxRef.current.has(item.id)) {
                warnedOutboxRef.current.add(item.id);
                toast.error(
                  `"${item.fileName ?? "Attachment"}" couldn't be sent — attachments aren't encrypted yet in encrypted rooms.`,
                );
              }
              continue;
            }
            const file = new File([item.fileBlob], item.fileName ?? "file", {
              type: item.fileMime ?? "application/octet-stream",
            });
            const meta = await uploadAttachment(file, { roomId, userId: user.id });
            uploadedPath = meta.path;
            // Audit-3 A4-N4: the entry id IS the idempotency key.
            const sendRes = await send({
              data: {
                roomId,
                type: item.type,
                attachmentPath: meta.path,
                attachmentMeta: { name: meta.name, size: meta.size, mime: meta.mime },
                clientId: item.id,
              },
            });
            // Audit-4 L13: a deduped send means the ORIGINAL attempt's
            // message (referencing the FIRST upload's path) already
            // exists — the file THIS flush just uploaded is referenced
            // by nothing. Delete it (best-effort, same server fn as
            // the catch cleanup below) or it orphans: one leaked
            // object per lost-response retry. Null the path after so
            // the catch below can never double-delete it.
            if (sendRes?.duplicate && uploadedPath) {
              try {
                await deleteOwnFile({ data: { path: uploadedPath } });
              } catch {
                // best-effort — an orphaned file is storage waste, not data loss
              }
              uploadedPath = null;
            }
          } else {
            // M11: non-text entry with no file blob (IndexedDB eviction /
            // corrupt queue write) — NEVER delete it silently. Keep it
            // in the outbox, warn the user, and continue with the rest
            // of the queue: a broken entry must not vanish unsent, and
            // must not block later entries from flushing.
            console.warn(
              `Outbox: queued ${item.type} message ${item.id} has no file data — keeping it, not sending.`,
            );
            if (!warnedOutboxRef.current.has(item.id)) {
              warnedOutboxRef.current.add(item.id);
              toast.warning(
                `"${item.fileName ?? "Attachment"}" couldn't be sent — its file data is missing.`,
              );
            }
            continue;
          }
          // Audit-3 A4-N22: removal has its OWN try/catch — a remove
          // failure after a successful send must never land in the
          // send-error catch below (poison-count / re-send). The next
          // flush re-sends, the A4-N4 clientId dedupe returns
          // { duplicate: true }, and removal is retried then.
          try {
            await removeQueuedMessage(item.id);
          } catch (removeErr) {
            console.warn(
              `Outbox flush: entry ${item.id} sent but removal failed — will retry removal next tick:`,
              removeErr,
            );
          }
          sentAny = true;
        } catch (err) {
          // Audit-3 A4-N35: best-effort cleanup of a partial upload —
          // a failed send after a successful upload orphans the file
          // (the next flush uploads fresh under a NEW path, so this
          // path is referenced by nothing).
          if (uploadedPath) {
            try {
              // Audit-3 A8-N17: storage deletes go through the
              // server fn (client DELETE policy dropped) — only
              // own unreferenced files are deleted.
              await deleteOwnFile({ data: { path: uploadedPath } });
            } catch {
              // best-effort — an orphaned file is storage waste, not data loss
            }
          }
          // Audit-3 A4-N5: a rate-limited flush is TRANSIENT —
          // pause and retry on the next tick. Counting it as poison
          // would quarantine legitimate queued messages just because
          // the burst hit the send cap.
          const flushMsg = err instanceof Error ? err.message : String(err ?? "");
          if (/too many attempts|rate limit|429/i.test(flushMsg)) {
            console.warn("Outbox flush paused (rate-limited):", err);
            break;
          }
          // M106: a permanently-too-long item must not block the whole
          // queue behind it (and must not be deleted silently, per
          // M11) — warn once and skip it; it stays queued.
          // Audit-4 L14: NO `continue` here — a permanently-too-long
          // entry can NEVER send, so skipping it without counting
          // left it queued forever with a "will send when online"
          // bubble and only a once-per-mount toast. Fall through to
          // the shared poison counting below (classifyFlushError
          // returns "poison" for this error) so it quarantines at
          // the cap. M11 still holds: quarantined entries are never
          // deleted silently — they stay queued, user-gated
          // Retry/Delete. The quarantine toast below is suppressed
          // for this entry because the specific warning above
          // already claimed the once-per-mount warned slot.
          if (err instanceof MessageTooLongError) {
            console.warn("Outbox flush: queued message too long, counting toward quarantine:", err.message);
            if (!warnedOutboxRef.current.has(item.id)) {
              warnedOutboxRef.current.add(item.id);
              toast.warning(err.message);
            }
          }
          if (classifyFlushError(err) === "transient") {
            // Stop on first transient failure — retry on next online /
            // focus / interval tick. NOT counted: the rest of the
            // queue would fail the same way right now.
            console.warn("Outbox flush paused (transient):", err);
            break;
          }
          // Server rejection — likely poisoned. Count it; quarantine at
          // the cap and continue past it so later entries still send.
          const failures = (item.failures ?? 0) + 1;
          const quarantined = failures >= OUTBOX_MAX_FAILURES;
          await updateQueuedMessage(item.id, {
            failures,
            lastFailedAt: Date.now(),
            quarantined,
          }).catch(() => null);
          console.warn(
            `Outbox flush: entry ${item.id} rejected (${failures}/${OUTBOX_MAX_FAILURES})`,
            err,
          );
          if (quarantined && !warnedOutboxRef.current.has(item.id)) {
            warnedOutboxRef.current.add(item.id);
            toast.error(
              `"${item.fileName ?? "Message"}" couldn't be sent — it will stay queued until you retry or delete it.`,
            );
          }
          continue;
        }
      }
      await refreshQueue();
      if (sentAny) qc.invalidateQueries({ queryKey: ["messages", roomId] });
    } finally {
      flushingRef.current = false;
    }
  };

  // Latest flushQueue for the interval / focus retries below (the
  // function is re-created every render; the ref avoids stale closures
  // without restarting the interval on every render).
  const flushQueueRef = useRef(flushQueue);
  flushQueueRef.current = flushQueue;

  // Audit-2 H9: retry on a timer + on window focus / tab-visible, not
  // only on the online event (which can be missed while backgrounded).
  // flushQueue no-ops while a flush is already running, and returns
  // early on an empty queue (no 30s re-render churn).
  useEffect(() => {
    if (!netOnline) return;
    const timer = window.setInterval(() => {
      void flushQueueRef.current();
    }, 30_000);
    const onFocus = () => {
      void flushQueueRef.current();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void flushQueueRef.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [netOnline, roomId]);

  // Audit-2 H9: user escape hatches for queued messages. Delete is
  // explicit (never silent, per M11). Retry re-arms a quarantined
  // entry (counters reset) and flushes immediately.
  const deleteQueued = async (id: string) => {
    await removeQueuedMessage(id).catch(() => null);
    await refreshQueue();
    toast.info("Queued message deleted.");
  };
  const retryQueued = async (id: string) => {
    await updateQueuedMessage(id, { failures: 0, quarantined: false }).catch(() => null);
    warnedOutboxRef.current.delete(id);
    await refreshQueue();
    await flushQueue();
  };

  useEffect(() => {
    if (netOnline) void flushQueue();
    // Audit-2 M27: flush again when the room resolves — items
    // deferred while room was undefined must not wait for the
    // 30s interval. is_e2ee (not the room object) is the dep so
    // room refetches with the same flag don't re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [netOnline, roomId, room?.is_e2ee]);

  const onSend = async (e: React.FormEvent) => {
    e.preventDefault();
    // Audit-2 M31: the composer is hidden when the room failed to
    // load — belt-and-braces guard if onSend is ever reached anyway.
    if (roomError) return;
    // Audit-3 A4-N12: same "room still loading" guard as onFiles /
    // onVoiceSend — a send while `room` is undefined used to post
    // plaintext into an E2EE room (server backstop rejected it, but
    // the user got an error toast and had to re-send).
    if (!room) {
      toast.error("Room is still loading — please wait.");
      return;
    }
    // M10: double-submit guard — a ref (see above), not the `sending` state.
    if (sendingRef.current) return;
    const text = body.trim();
    if (!text || !user) return;
    sendingRef.current = true;
    // Audit-3 A4-N4: ONE idempotency key per logical message,
    // generated before the first attempt. The online send AND the
    // transient-failure queue path use the SAME key — if the send
    // inserted but its response was lost, the flush dedupes instead
    // of duplicating.
    const clientId = crypto.randomUUID();
    try {
      // Offline → queue it; it auto-sends when connectivity returns.
      if (!netOnline) {
        try {
          // Audit-2 M29: encrypt at queue time, never queue plaintext
          // for an E2EE room (refuse-and-warn when keys are unreachable).
          const prepared = await encryptForQueue(text);
          if (!prepared) {
            clearTyping();
            return;
          }
          await queueMessage({
            roomId,
            userId: user.id,
            body: prepared.body,
            type: "text",
            encrypted: prepared.encrypted,
          });
          setBody("");
          await refreshQueue();
          toast.info("Offline — message queued, will send automatically when you're back online.");
        } catch (err) {
          toast.error(err instanceof OutboxFullError ? err.message : "Could not queue message (storage unavailable).");
        }
        // M13: sent (queued) → no longer typing.
        clearTyping();
        return;
      }
      setSending(true);
      try {
        await send({ data: { roomId, body: await maybeEncrypt(text), type: "text", clientId } });
        setBody("");
        // M13: sent → no longer typing.
        clearTyping();
        // Don't rely solely on realtime for our own message — refresh now.
        qc.invalidateQueries({ queryKey: ["messages", roomId] });
      } catch (err) {
        if (err instanceof E2EENotReadyError) {
          // Never silently downgrade an E2EE room to plaintext.
          toast.error(`${err.message} — message not sent.`, { duration: 6000 });
        } else if (classifyFlushError(err) === "transient") {
          // Audit-2 H14: navigator.onLine was true but the server is
          // actually unreachable (captive portal, LAN without
          // internet, Supabase outage, DNS failure). Don't just toast
          // and drop the send — queue it like the offline branch so it
          // auto-sends when connectivity returns. Server rejections
          // (non-transient) are NOT queued: they would fail again.
          try {
            // Audit-2 M29: encrypt at queue time (same as the
            // offline branch) — never queue plaintext for E2EE.
            const prepared = await encryptForQueue(text);
            if (!prepared) {
              clearTyping();
              return;
            }
            await queueMessage({
              roomId,
              userId: user.id,
              body: prepared.body,
              type: "text",
              encrypted: prepared.encrypted,
              // Audit-3 A4-N4: SAME key as the failed send attempt.
              id: clientId,
            });
            setBody("");
            await refreshQueue();
            toast.info(
              "Connection lost — message queued, will send automatically when you're back online.",
            );
          } catch (err) {
            toast.error(err instanceof OutboxFullError ? err.message : "Could not queue message (storage unavailable).");
          }
          // M13: sent (queued) → no longer typing.
          clearTyping();
        } else {
          toast.error(err instanceof Error ? err.message : "Could not send");
        }
      } finally {
        setSending(false);
      }
    } finally {
      sendingRef.current = false;
    }
  };

  const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB per file
  const [uploadSize, setUploadSize] = useState<number>(0);
  const [uploadedBytes, setUploadedBytes] = useState<number>(0);

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (e.target) e.target.value = "";
    if (!files.length || !user) return;
    // Attachments are NOT encrypted yet — never let one slip into a 🔒 room.
    // Audit-2 M27: room === undefined is NOT "not E2EE" — the room query
    // may simply not have resolved yet. Block until it does.
    if (!room) {
      toast.error("Room is still loading — please wait.");
      return;
    }
    if (room.is_e2ee) {
      toast.error("Attachments aren't encrypted yet in encrypted rooms.");
      return;
    }
    // M10: same double-submit guard as onSend — a second file pick
    // while an upload batch is in flight must not start a duplicate
    // batch. A deliberate pick during an upload gets a visible toast
    // (not a silent drop) so the user can re-pick after it finishes.
    if (uploadingRef.current) {
      toast.info("Upload in progress — please wait.");
      return;
    }
    uploadingRef.current = true;
    // Audit-2 H13: the ref reset lives in `finally` — the old code reset
    // it on the fall-through path, so a cleanup failure (below) skipped
    // it and wedged every later pick until remount.
    try {
      // Offline → queue files; they upload + send when connectivity returns.
      if (!netOnline) {
        try {
          for (const file of files) {
            if (file.size > MAX_FILE_BYTES) {
              toast.error(`"${file.name}" exceeds the 1 GB limit.`);
              continue;
            }
            await queueMessage({
              roomId,
              userId: user.id,
              body: file.name,
              type: pickMessageType(file.type),
              fileName: file.name,
              fileMime: file.type,
              fileSize: file.size,
              fileBlob: file,
            });
          }
          await refreshQueue();
          toast.info("Offline — files queued, will send automatically when you're back online.");
        } catch (err) {
          toast.error(err instanceof OutboxFullError ? err.message : "Could not queue files (storage unavailable).");
        }
        return;
      }
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        let uploadedPath: string | null = null;
        if (file.size > MAX_FILE_BYTES) {
          toast.error(
            `"${file.name}" is ${formatBytes(file.size)} — the per-file limit is 1 GB. Please split or compress it.`,
          );
          continue;
        }
        // Audit-3 A4-N4: ONE idempotency key per logical file
        // message — the send AND the transient-failure queue path
        // use the SAME key (see onSend).
        const clientId = crypto.randomUUID();
        setUploadName(file.name);
        setUploadSize(file.size);
        setUploadedBytes(0);
        setUploadPct(0);
        try {
          const meta = await uploadAttachment(file, {
            roomId,
            userId: user.id,
            onProgress: (p) => {
              setUploadPct(p.percent);
              setUploadedBytes(p.uploaded);
            },
          });
          uploadedPath = meta.path;
          await send({
            data: {
              roomId,
              type: pickMessageType(meta.mime),
              attachmentPath: meta.path,
              attachmentMeta: { name: meta.name, size: meta.size, mime: meta.mime },
              clientId,
            },
          });
          qc.invalidateQueries({ queryKey: ["messages", roomId] });
          toast.success(`Uploaded ${meta.name} (${formatBytes(meta.size)})`);
        } catch (err) {
          // Audit-2 H13: cleanup is guarded — if remove() itself
          // rejects (network drop, the common case when the upload
          // just failed), the exception must NOT propagate and wedge
          // uploadingRef. The orphaned file is unreachable via the
          // app (same as M1).
          if (uploadedPath) {
            try {
              // Audit-3 A8-N17: storage deletes go through the
              // server fn (client DELETE policy dropped).
              await deleteOwnFile({ data: { path: uploadedPath } });
            } catch {
              console.warn("[onFiles] orphan attachment cleanup failed:", uploadedPath);
            }
          }
          if (classifyFlushError(err) === "transient") {
            // Audit-2 H14: navigator.onLine was true but the server is
            // actually unreachable — queue the file (blob still in
            // hand) instead of making the user re-pick it. The flush
            // re-uploads from the blob. Server rejections
            // (quota / 401 / 403 / ...) are NOT queued.
            // Audit-5 B2-LOW: queueing ONLY this file and continuing
            // sent the later files directly — the queued file then
            // arrived AFTER them (arrival order != pick order).
            // Queue this file AND every remaining file in pick
            // order, then stop the direct-send loop; the flush
            // delivers them in order.
            try {
              const remaining = files.slice(fi);
              for (const f of remaining) {
                if (f.size > MAX_FILE_BYTES) {
                  toast.error(`"${f.name}" exceeds the 1 GB limit.`);
                  continue;
                }
                await queueMessage({
                  roomId,
                  userId: user.id,
                  body: f.name,
                  type: pickMessageType(f.type),
                  fileName: f.name,
                  fileMime: f.type,
                  fileSize: f.size,
                  fileBlob: f,
                  // Audit-3 A4-N4: the failed send keeps its SAME key.
                  ...(f === file ? { id: clientId } : {}),
                });
              }
              await refreshQueue();
              toast.info(
                `Connection lost — ${remaining.length} file${remaining.length === 1 ? "" : "s"} queued, will send in order when you're back online.`,
              );
            } catch (err) {
              toast.error(err instanceof OutboxFullError ? err.message : "Could not queue files (storage unavailable).");
            }
            break;
          }
          const raw = err instanceof Error ? err.message : String(err);
          const status =
            (
              err as { originalResponse?: { getStatus?: () => number } }
            )?.originalResponse?.getStatus?.() ?? 0;
          let msg = raw || "Upload failed";
          if (status === 413 || /payload too large|exceeded the maximum/i.test(raw)) {
            msg = `"${file.name}" is too large for the storage quota. Free up space or use a smaller file.`;
          } else if (/quota|storage.*exceed|insufficient.*storage|over.*limit/i.test(raw)) {
            msg = `Storage quota reached. Delete older attachments or choose a smaller file, then try again.`;
          } else if (status === 401 || status === 403) {
            msg = `Not allowed to upload here. Try signing in again.`;
          } else if (status === 0 && /network|failed to fetch/i.test(raw)) {
            msg = `Network interrupted during upload of "${file.name}". Check your connection and retry.`;
          }
          toast.error(msg, { duration: 8000 });
        } finally {
          setUploadPct(null);
          setUploadName("");
          setUploadSize(0);
          setUploadedBytes(0);
        }
      }
    } finally {
      uploadingRef.current = false;
    }
  };

  /** Voice message: upload the recorded audio file then send it as an audio message. */
  const [recording, setRecording] = useState(false);
  const onVoiceSend = async (file: File) => {
    setRecording(false);
    if (!user) return;
    // Voice notes are attachments → not encrypted yet.
    // Audit-2 M27: room === undefined is NOT "not E2EE" — block
    // until the room query resolves (same as onFiles).
    if (!room) {
      toast.error("Room is still loading — please wait.");
      return;
    }
    if (room.is_e2ee) {
      toast.error("Voice messages aren't encrypted yet in encrypted rooms.");
      return;
    }
    // Audit-3 A1-L34: same 1 GB cap as the attachment queue (onFiles) —
    // the offline + transient-failure queue paths had no check. One
    // check here covers both queue sites and the online upload.
    if (file.size > MAX_FILE_BYTES) {
      toast.error("Voice message exceeds the 1 GB limit.");
      return;
    }
    // M10: same double-submit guard — a double-tap on voice send
    // must not send the same voice note twice.
    if (uploadingRef.current) {
      toast.info("Upload in progress — please wait.");
      return;
    }
    uploadingRef.current = true;
    // Audit-2 H13: same as onFiles — ref reset in `finally`, cleanup guarded.
    try {
      // Offline → queue the voice note; it uploads + sends on reconnect.
      if (!netOnline) {
        try {
          await queueMessage({
            roomId,
            userId: user.id,
            body: "Voice message",
            type: "audio",
            fileName: `voice-${Date.now()}.webm`,
            fileMime: file.type,
            fileSize: file.size,
            fileBlob: file,
          });
          await refreshQueue();
          toast.info("Offline — voice message queued, will send when you're back online.");
        } catch (err) {
          toast.error(err instanceof OutboxFullError ? err.message : "Could not queue voice message (storage unavailable).");
        }
        return;
      }
      let uploadedPath: string | null = null;
      setUploadName("Voice message");
      setUploadSize(file.size);
      setUploadedBytes(0);
      setUploadPct(0);
      // Audit-3 A4-N4: ONE idempotency key per logical voice
      // message — the send AND the transient-failure queue path
      // use the SAME key (see onSend).
      const clientId = crypto.randomUUID();
      try {
        const meta = await uploadAttachment(file, {
          roomId,
          userId: user.id,
          onProgress: (p) => {
            setUploadPct(p.percent);
            setUploadedBytes(p.uploaded);
          },
        });
        uploadedPath = meta.path;
        await send({
          data: {
            roomId,
            type: "audio",
            attachmentPath: meta.path,
            attachmentMeta: { name: "Voice message", size: meta.size, mime: meta.mime },
            clientId,
          },
        });
        qc.invalidateQueries({ queryKey: ["messages", roomId] });
      } catch (err) {
        // Audit-2 H13: guarded cleanup (see onFiles) — a failing
        // remove() must not wedge uploadingRef.
        if (uploadedPath) {
          try {
            // Audit-3 A8-N17: storage deletes go through the
            // server fn (client DELETE policy dropped).
            await deleteOwnFile({ data: { path: uploadedPath } });
          } catch {
            console.warn("[onVoiceSend] orphan attachment cleanup failed:", uploadedPath);
          }
        }
        if (classifyFlushError(err) === "transient") {
          // Audit-2 H14: same as onFiles — queue the voice note
          // (blob still in hand) instead of losing it.
          try {
            await queueMessage({
              roomId,
              userId: user.id,
              body: "Voice message",
              type: "audio",
              fileName: `voice-${Date.now()}.webm`,
              fileMime: file.type,
              fileSize: file.size,
              fileBlob: file,
              // Audit-3 A4-N4: SAME key as the failed send attempt.
              id: clientId,
            });
            await refreshQueue();
            toast.info(
              "Connection lost — voice message queued, will send automatically when you're back online.",
            );
          } catch (err) {
            toast.error(err instanceof OutboxFullError ? err.message : "Could not queue voice message (storage unavailable).");
          }
        } else {
          toast.error(err instanceof Error ? err.message : "Voice message failed");
        }
      } finally {
        setUploadPct(null);
        setUploadName("");
        setUploadSize(0);
        setUploadedBytes(0);
      }
    } finally {
      uploadingRef.current = false;
    }
  };

  // Audit-2 M21: the server enforces a 5-minute edit/delete window
  // (RLS — expired saves fail). Mirror it on the client so expired
  // Edit/Delete buttons never appear. The server stays the
  // authority (clock skew can still make a shown button fail).
  // Audit-5 B2-LOW: judge the window with the skew-corrected now —
  // created_at is server-stamped; a raw Date.now() on a skewed
  // client clock hid buttons early (or showed them past expiry).
  const MESSAGE_MODIFY_WINDOW_MS = 5 * 60 * 1000;
  const withinModifyWindow = (m: Message) =>
    serverAlignedNowMs() - new Date(m.created_at).getTime() < MESSAGE_MODIFY_WINDOW_MS;

  // Audit-2 M21: Delete asks first — a one-tap delete was
  // unrecoverable. The dialog holds the target id; confirming runs
  // the server call below.
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const onDelete = (id: string) => setDeleteTargetId(id);
  const confirmDeleteMessage = async () => {
    const id = deleteTargetId;
    if (!id) return;
    setDeleteTargetId(null);
    try {
      // M1: the delete succeeded even if the attachment cleanup failed
      // (attachmentCleaned=false = orphaned file, unreachable via the
      // app). Invalidate regardless — the message is gone.
      const res = await del({ data: { messageId: id } });
      qc.invalidateQueries({ queryKey: ["messages", roomId] });
      if (res && !res.attachmentCleaned) {
        console.warn(`[chat] message ${id} deleted but its attachment could not be released.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");

  // WhatsApp-style message menu (right-click / long-press) + info dialog.
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [infoMsg, setInfoMsg] = useState<Message | null>(null);
  // WhatsApp-style: tapping a peer's name/avatar opens their profile sheet.
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const lpTimer = useRef<number | null>(null);
  // Only cancel the long-press on a REAL scroll (12px+), not finger jitter.
  const touchPos = useRef<{ x: number; y: number } | null>(null);
  useEffect(
    () => () => {
      if (lpTimer.current) window.clearTimeout(lpTimer.current);
    },
    [],
  );
  const openMenuFor = (m: Message, x: number, y: number) => {
    const mine = m.user_id === user?.id;
    const inWindow = withinModifyWindow(m);
    const body = displayBodyFor(m);
    setMenu({
      messageId: m.id,
      body,
      // Audit-3 A4-N19: Copy disabled for every placeholder body
      // (decrypting + both terminal ones) — see isPlaceholderBody.
      copyDisabled: isPlaceholderBody(body),
      x,
      y,
      mine,
      canEdit: mine && inWindow && Boolean(m.body) && m.type === "text",
      canDelete: mine && inWindow,
      expired: mine && !inWindow,
    });
  };
  const cancelLongPress = () => {
    if (lpTimer.current) window.clearTimeout(lpTimer.current);
  };

  // Animate only messages that arrive after the initial load (buttery, not janky).
  const animatedIds = useRef<Set<string>>(new Set());
  const [initialSweep, setInitialSweep] = useState(false);
  useEffect(() => {
    if (!messages) return;
    if (!initialSweep) setInitialSweep(true);
    for (const m of messages) animatedIds.current.add(m.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  /** Open the inline editor with the readable text (never ciphertext). */
  const openEditor = (m: Message) => {
    // Audit-2 M21: don't let the user type an edit the server will
    // reject (stale menu / toolbar opened before the window closed).
    if (!withinModifyWindow(m)) {
      toast.error("Edit window expired — messages can only be edited within 5 minutes.");
      return;
    }
    if (room?.is_e2ee && m.type === "text" && isEncryptedBody(m.body)) {
      if (!decrypted.has(m.id)) {
        toast.error("Wait for the message to decrypt first.");
        return;
      }
    }
    setEditingId(m.id);
    setEditBody(displayBodyFor(m) ?? "");
  };

  // Audit-2 L32: double-submit guard, same ref pattern as the send
  // path (`sendingRef`) — a state flag would go stale across a fast
  // double-Save (async setState), firing two editMessage calls.
  const editingRef = useRef(false);
  const onEditSave = async (id: string) => {
    if (editingRef.current) return;
    const text = editBody.trim();
    if (!text) return;
    editingRef.current = true;
    try {
      await edit({ data: { messageId: id, body: await maybeEncrypt(text) } });
      setEditingId(null);
      setEditBody("");
      qc.invalidateQueries({ queryKey: ["messages", roomId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not edit");
    } finally {
      editingRef.current = false;
    }
  };

  const headerTitle = room?.is_dm
    ? (dmPartner?.display_name ?? "Direct message")
    : (room?.name ?? "Loading…");
  const headerSubtitle = room?.is_dm
    ? isOnline(dmPartner)
      ? "Online now"
      : dmPartner?.last_seen_at
        ? `Last seen ${formatServerRelativeTime(dmPartner.last_seen_at)}`
        : "Offline"
    : memberCount != null
      ? `${memberCount} member${memberCount === 1 ? "" : "s"}${room?.is_e2ee ? " · 🔒 End-to-end encrypted" : ""}`
      : (room?.description ?? "");

  const typingNames = Object.keys(typingUsers)
    .map((id) => profileMap.get(id)?.display_name ?? dmPartner?.display_name ?? "Someone")
    .filter(Boolean);

  const grouped = useMemo(() => {
    const groups: { key: string; label: string; items: Message[] }[] = [];
    for (const m of messages ?? []) {
      const key = dayKey(m.created_at);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(m);
      else groups.push({ key, label: dayLabel(m.created_at), items: [m] });
    }
    return groups;
  }, [messages]);

  const renderMessage = (m: Message) => {
    const profile = profileMap.get(m.user_id);
    const mine = m.user_id === user?.id;
    const rs = reactionsByMsg.get(m.id);
    const animateIn = initialSweep && !animatedIds.current.has(m.id);
    // WhatsApp-style call entry: a centered pill, not a bubble. Tap it to
    // call the peer back with the same type. No reactions / context menu.
    if (m.type === "call") {
      const info = parseCallMessage(m.body);
      // Audit-3 A4-N33: fixed label on parse failure, never raw body.
      const summary = info ? callMessageSummary(info) : "Call";
      const icon = info ? callMessageIcon(info.type) : "📞";
      const arrow = mine ? "↗" : "↙";
      const pillClass =
        "inline-flex items-center gap-1.5 rounded-full bg-secondary px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-secondary/80";
      return (
        <div key={m.id} className="my-1 flex justify-center">
          {room?.is_dm && dmPartner && info ? (
            <button
              type="button"
              onClick={() => void startCall(dmPartner.id, dmPartner.display_name, info.type)}
              className={pillClass}
              aria-label={`Call ${dmPartner.display_name} back`}
            >
              <span aria-hidden>{arrow}</span>
              <span aria-hidden>{icon}</span>
              <span>{summary}</span>
            </button>
          ) : (
            <span className={pillClass}>
              <span aria-hidden>{arrow}</span>
              <span aria-hidden>{icon}</span>
              <span>{summary}</span>
            </span>
          )}
        </div>
      );
    }
    return (
      <article
        key={m.id}
        className={`group mb-3.5 flex gap-2 ${mine ? "justify-end" : ""} ${animateIn ? "message-enter" : ""}`}
      >
        {!mine && (
          <button
            type="button"
            onClick={() => setProfileUserId(m.user_id)}
            className="hidden shrink-0 self-end rounded-[10px] sm:block"
            aria-label={`View ${profile?.display_name ?? "sender"}'s profile`}
          >
            <SmartAvatar
              userId={m.user_id}
              name={profile?.display_name ?? "?"}
              className="h-[30px] w-[30px] rounded-[10px] border"
              fallbackClassName="rounded-[10px] bg-secondary text-[10px] text-secondary-foreground"
            />
          </button>
        )}
        <div
          className={`min-w-0 max-w-[88%] sm:max-w-[76%] md:max-w-[56%] ${mine ? "items-end" : "items-start"} flex flex-col`}
        >
          {!mine && (
            <button
              type="button"
              onClick={() => setProfileUserId(m.user_id)}
              className="mb-1 ml-0.5 self-start text-[10px] font-bold text-muted-foreground"
            >
              {profile?.display_name ?? "Unknown"}
            </button>
          )}
          <div
            className={`no-callout px-3.5 py-2.5 text-sm leading-relaxed break-words md:px-[13px] md:pb-[7px] md:pt-[9px] md:text-[14.5px] md:font-semibold md:leading-[1.45] ${
              mine
                ? "rounded-2xl rounded-br-[5px] bg-bubble-out text-bubble-out-foreground md:rounded-[14px] md:rounded-br-[4px]"
                : "rounded-2xl rounded-bl-[5px] bg-bubble-in text-foreground md:rounded-[14px] md:rounded-bl-[4px]"
            }`}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenuFor(m, e.clientX, e.clientY);
            }}
            onTouchStart={(e) => {
              if (e.touches.length !== 1) return;
              const t = e.touches[0];
              touchPos.current = { x: t.clientX, y: t.clientY };
              cancelLongPress();
              lpTimer.current = window.setTimeout(() => {
                openMenuFor(m, t.clientX, t.clientY);
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
          >
            {editingId === m.id ? (
              <div className="min-w-[220px]">
                <Textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  maxLength={4000}
                  rows={3}
                  autoFocus
                  className={`text-sm ${mine ? "bg-white/10 text-white placeholder:text-white/60" : ""}`}
                />
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => onEditSave(m.id)} className="h-8">
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingId(null);
                      setEditBody("");
                    }}
                    className="h-8"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {displayBodyFor(m) && <p className="whitespace-pre-wrap">{displayBodyFor(m)}</p>}
                {m.attachment_url && (
                  <div className={m.body ? "mt-1.5" : ""}>
                    <AttachmentView msg={m} mine={mine} />
                  </div>
                )}
              </>
            )}
          </div>
          {rs && rs.length > 0 && (
            <div className={`mt-1 flex flex-wrap gap-1 ${mine ? "justify-end" : ""}`}>
              {rs.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => onReact(m.id, r.emoji)}
                  disabled={reactingKeys.has(`${m.id}:${r.emoji}`)}
                  className={`reaction-pop inline-flex items-center gap-1 rounded-full border-2 border-background bg-card px-2 py-0.5 text-[11px] shadow-sm transition-transform hover:scale-105 disabled:opacity-50 ${
                    r.mine ? "border-primary/50" : ""
                  }`}
                >
                  <span>{r.emoji}</span>
                  <span className="text-[10px] font-bold tabular-nums">{r.count}</span>
                </button>
              ))}
            </div>
          )}
          <div
            className={`mt-1 flex items-center gap-1.5 ${mine ? "flex-row-reverse" : ""} opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100`}
          >
            <span className="text-[9px] font-semibold text-muted-foreground">
              {clockTime(m.created_at)}
              {m.edited_at ? " · Edited" : ""}
            </span>
            {mine &&
              (isSeenByAll(m) ? (
                <CheckCheck className="h-3.5 w-3.5 text-sky-500" aria-label="Seen by everyone" />
              ) : (
                <Check className="h-3.5 w-3.5 text-muted-foreground" aria-label="Sent" />
              ))}
            <span className="flex items-center">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Add reaction"
                    className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    <SmilePlus className="h-3.5 w-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-1.5" align={mine ? "end" : "start"}>
                  <div className="flex gap-0.5">
                    {QUICK_EMOJIS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        onClick={() => onReact(m.id, e)}
                        disabled={reactingKeys.has(`${m.id}:${e}`)}
                        className="grid h-8 w-8 place-items-center rounded-md text-lg hover:bg-accent disabled:opacity-50"
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {mine && m.body && withinModifyWindow(m) && editingId !== m.id && (
                <button
                  type="button"
                  aria-label="Edit message"
                  onClick={() => openEditor(m)}
                  className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              {mine && withinModifyWindow(m) && (
                <button
                  type="button"
                  aria-label="Delete message"
                  onClick={() => onDelete(m.id)}
                  className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          </div>
        </div>
      </article>
    );
  };

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background md:bg-[#e8efe8] md:bg-[radial-gradient(rgba(128,138,132,0.13)_1px,transparent_1.4px)] md:[background-size:22px_22px] dark:md:bg-[#0b0d0f]"
      onContextMenu={(e) => {
        // Browser menu stays off everywhere in the chat except inside text
        // inputs (so copy/paste still works there). Message bubbles open the
        // custom menu via their own handler below.
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
      }}
    >
      {/* Header */}
      {/* Audit-3 A6-N3: viewport-fit=cover lets content slide under the
          notch/status bar — the list topbar accounts for safe-area-inset-top
          but this header didn't, so back/avatar/name/call buttons sat
          under the notch. max() keeps the py-2 8px on desktop (inset 0)
          and uses the inset on notched phones. */}
      <header
        className="flex min-h-[68px] shrink-0 items-center gap-3 border-b border-border bg-card/95 px-2 py-2 backdrop-blur-md sm:px-4"
        style={{ paddingTop: "max(8px, env(safe-area-inset-top))" }}
      >
        <Button asChild variant="ghost" size="icon" className="shrink-0 rounded-xl md:hidden">
          <Link to="/rooms" aria-label="Back to conversations">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <span
          className={`grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-[15px] bg-accent text-primary ${room?.is_dm && dmPartner ? "cursor-pointer" : ""}`}
          onClick={
            room?.is_dm && dmPartner ? () => setProfileUserId(dmPartner.id) : undefined
          }
          role={room?.is_dm && dmPartner ? "button" : undefined}
          tabIndex={room?.is_dm && dmPartner ? 0 : undefined}
          onKeyDown={
            room?.is_dm && dmPartner
              ? (e) => {
                  // Audit-6 B-D4: role="button" must be keyboard
                  // operable — Enter/Space opens the profile, same
                  // as the click (it was unreachable by keyboard).
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setProfileUserId(dmPartner.id);
                  }
                }
              : undefined
          }
          aria-label={room?.is_dm && dmPartner ? `View ${dmPartner.display_name}'s profile` : undefined}
        >
          {room?.is_dm ? (
            dmPartner ? (
              <SmartAvatar
                userId={dmPartner.id}
                name={dmPartner.display_name}
                className="h-11 w-11"
                fallbackClassName="bg-accent text-sm font-extrabold text-primary"
              />
            ) : (
              <Avatar className="h-11 w-11">
                <AvatarFallback className="bg-accent text-sm font-extrabold text-primary">
                  ??
                </AvatarFallback>
              </Avatar>
            )
          ) : (
            <Hash className="h-5 w-5" />
          )}
        </span>
        <div
          className={`min-w-0 flex-1 ${room?.is_dm && dmPartner ? "cursor-pointer" : ""}`}
          onClick={
            room?.is_dm && dmPartner ? () => setProfileUserId(dmPartner.id) : undefined
          }
        >
          <h1 className="truncate text-base font-extrabold tracking-tight">{headerTitle}</h1>
          {headerSubtitle && (
            <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
              {room?.is_dm && isOnline(dmPartner) && (
                <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-primary" />
              )}
              {headerSubtitle}
              {!rtLive && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
                  title="Live updates disconnected — new messages may need a refresh"
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                  Reconnecting…
                </span>
              )}
            </p>
          )}
        </div>
        {/* 1:1 calls: DM header on mobile AND desktop. */}
        {room?.is_dm && dmPartner && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-xl"
              aria-label="Voice call"
              title="Voice call"
              onClick={() => void startCall(dmPartner.id, dmPartner.display_name, "voice")}
            >
              <Phone className="h-5 w-5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-xl"
              aria-label="Video call"
              title="Video call"
              onClick={() => void startCall(dmPartner.id, dmPartner.display_name, "video")}
            >
              <Video className="h-5 w-5" />
            </Button>
          </div>
        )}
        {!room?.is_dm && (
          <div className="shrink-0">
            <MembersDialog
              roomId={roomId}
              roomName={room?.name ?? ""}
              isPrivate={!!room?.is_private}
              currentUserId={user?.id}
              isCreator={room?.created_by === user?.id}
              isE2EE={room?.is_e2ee}
              onViewProfile={(id) => setProfileUserId(id)}
            />
          </div>
        )}
      </header>

      {!netOnline && (
        <div className="flex items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
          <WifiOff className="h-3.5 w-3.5" />
          You're offline — messages will be queued and sent automatically when you reconnect.
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={onMessagesScroll}
        className="smooth-scroll min-h-0 flex-1 overflow-y-auto px-3.5 py-5 sm:px-6 md:px-[8%] md:pb-2.5 md:pt-6"
        aria-live="polite"
      >
        {/* M12: explicit affordance for older history (auto-fetch on
            scroll-up also runs). Hidden once the oldest page is loaded. */}
        {hasNextPage && !isLoading && (
          <div className="mb-4 flex justify-center">
            <Button variant="outline" size="sm" onClick={loadOlder} disabled={isFetchingNextPage}>
              {isFetchingNextPage ? "Loading older messages…" : "Load older messages"}
            </Button>
          </div>
        )}
        {roomError ? (
          <div className="py-20 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border bg-card">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <h2 className="mt-4 font-bold">Couldn't open this chat</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              It may have been deleted or you no longer have access.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void refetchRoom()}>
                Try again
              </Button>
              <Button size="sm" onClick={() => navigate({ to: "/rooms" })}>
                Back to chats
              </Button>
            </div>
          </div>
        ) : isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={`flex gap-2 ${i % 2 ? "justify-end" : ""}`}>
                <Skeleton className="h-12 w-2/3 rounded-2xl" />
              </div>
            ))}
          </div>
        ) : grouped.length === 0 ? (
          <div className="py-20 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border bg-card">
              <Hash className="h-5 w-5 text-muted-foreground" />
            </div>
            <h2 className="mt-4 font-bold">Start the conversation</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Messages and shared files will appear here.
            </p>
          </div>
        ) : (
          <>
            {grouped.map((g) => (
              <div key={g.key}>
                <div className="mx-auto mb-6 w-max rounded-lg bg-secondary px-2.5 py-1 text-[10px] font-bold text-muted-foreground">
                  {g.label}
                </div>
                {g.items.map(renderMessage)}
              </div>
            ))}
            {queued.length > 0 && (
              <div className="mt-2">
                {queued.map((q) => (
                  <div key={q.id} className="flex justify-end px-1 py-1">
                    <div className="max-w-[75%] rounded-2xl rounded-br-md bg-primary/60 px-3.5 py-2 text-primary-foreground opacity-80">
                      <p className="text-[15px] leading-relaxed break-words">
                        {q.type === "text"
                          ? // Audit-2 M29: an encrypted queued body is an
                            // E2E1: envelope — never render it raw.
                            q.encrypted
                            ? "🔒 Encrypted message"
                            : q.body
                          : `📎 ${q.fileName ?? "Attachment"}`}
                      </p>
                      <div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-80">
                        <Clock className="h-3 w-3" />
                        <span>
                          {q.quarantined
                            ? "Failed to send — won't retry automatically"
                            : "Queued — will send when online"}
                        </span>
                      </div>
                      {/* Audit-2 H9: user escape hatches — Delete on every
                          queued bubble, Retry on quarantined ones. */}
                      <div className="mt-1 flex items-center justify-end gap-3 text-[11px] font-medium">
                        {q.quarantined && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 underline underline-offset-2"
                            onClick={() => void retryQueued(q.id)}
                          >
                            <RotateCcw className="h-3 w-3" />
                            Retry
                          </button>
                        )}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 underline underline-offset-2"
                          onClick={() => void deleteQueued(q.id)}
                        >
                          <X className="h-3 w-3" />
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {typingNames.length > 0 && (
          <div
            className="flex items-center gap-2 px-1 py-2 text-[11px] text-muted-foreground"
            aria-live="polite"
          >
            <span className="inline-flex gap-[3px]" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-[5px] w-[5px] rounded-full bg-primary animate-bounce"
                  style={{ animationDelay: `${i * 140}ms` }}
                />
              ))}
            </span>
            {typingNames.length === 1
              ? `${typingNames[0]} is typing`
              : `${typingNames.length} people are typing`}
          </div>
        )}
      </div>

      {/* Composer */}
      <div
        className="shrink-0 bg-gradient-to-b from-transparent to-background px-2 pb-2 pt-1 sm:px-4 sm:pb-4 md:bg-none md:px-[18px] md:pb-4 md:pt-[13px]"
        style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}
      >
        {uploadPct !== null && (
          <div className="mx-auto mb-2 flex max-w-3xl items-center gap-3 rounded-2xl border bg-card px-3 py-2">
            <Paperclip className="h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex justify-between gap-2 text-xs">
                <span className="truncate font-semibold">{uploadName}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatBytes(uploadedBytes)} / {formatBytes(uploadSize)} · {uploadPct}%
                </span>
              </div>
              <Progress value={uploadPct} className="mt-1 h-1.5" />
            </div>
          </div>
        )}
        {/* Audit-2 M31: hide the composer when the room failed to
            load (deleted / no access) — the error pane already
            offers Try again / Back to chats. The upload progress
            bar above stays visible: it reflects an in-flight
            operation, not a send attempt. */}
        {!roomError && (
        <form
          onSubmit={onSend}
          className="mx-auto flex min-h-[56px] min-w-0 max-w-3xl items-center gap-1 rounded-[17px] border border-border bg-card p-1.5 pl-2 shadow-md focus-within:border-primary/40 md:mx-0 md:max-w-none md:gap-[9px] md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none md:focus-within:border-transparent"
        >
          {recording ? (
            <div className="min-w-0 flex-1">
              <VoiceRecorder onSend={onVoiceSend} onCancel={() => setRecording(false)} />
            </div>
          ) : (
            <>
              <input ref={fileRef} type="file" multiple onChange={onFiles} className="hidden" />
              <input
                ref={mediaRef}
                type="file"
                multiple
                accept="image/*,video/*"
                onChange={onFiles}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploadPct !== null || !room || room.is_e2ee}
                aria-label="Attach a file"
                title={room?.is_e2ee ? "Attachments aren't encrypted yet" : undefined}
                className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30 md:h-11 md:w-11 md:rounded-full md:border md:border-border md:bg-card md:shadow-sm"
              >
                <Paperclip className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => mediaRef.current?.click()}
                disabled={uploadPct !== null || !room || room.is_e2ee}
                aria-label="Share a photo or video"
                title={room?.is_e2ee ? "Attachments aren't encrypted yet" : undefined}
                className="hidden h-[42px] w-[42px] shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30 sm:grid md:h-11 md:w-11 md:rounded-full md:border md:border-border md:bg-card md:shadow-sm"
              >
                <ImageIcon className="h-5 w-5" />
              </button>
              <Input
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  sendTyping();
                }}
                onBlur={(e) => {
                  // Audit-2 L35: don't clear typing when focus just
                  // moves WITHIN the composer — clicking attach /
                  // media / send / voice buttons blurs the input but
                  // the user is still composing. Only clear when
                  // focus leaves the composer form entirely (or goes
                  // nowhere: click on a non-focusable area, tab
                  // switch). Send / room-change / unmount already
                  // clear; the 5s TTL is the backstop for a crashed
                  // tab.
                  const next = e.relatedTarget as Node | null;
                  if (next && e.currentTarget.form?.contains(next)) return;
                  clearTyping();
                }}
                placeholder={
                  room?.is_e2ee
                    ? "🔒 Encrypted message…"
                    : room?.is_dm
                      ? `Message ${dmPartner?.display_name ?? ""}`
                      : `Message #${room?.name ?? ""}`
                }
                aria-label="Write a message"
                maxLength={4000}
                className="h-10 min-w-0 flex-1 border-0 bg-transparent text-[15px] shadow-none focus-visible:ring-0 md:h-12 md:rounded-[12px] md:border md:border-border md:bg-card md:px-4 md:text-[14.5px] md:shadow-none"
              />
              {body.trim() ? (
                <button
                  type="submit"
                  disabled={sending}
                  aria-label="Send message"
                  className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[13px] bg-primary text-primary-foreground shadow-md transition-opacity hover:opacity-90 disabled:opacity-40 md:h-12 md:w-12 md:rounded-[12px] md:shadow-none"
                >
                  <Send className="h-[19px] w-[19px]" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setRecording(true)}
                  disabled={uploadPct !== null || !room || room.is_e2ee}
                  aria-label="Record a voice message"
                  title={room?.is_e2ee ? "Voice messages aren't encrypted yet" : undefined}
                  className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30 md:h-11 md:w-11 md:rounded-full md:border md:border-border md:bg-card md:shadow-sm"
                >
                  <Mic className="h-5 w-5" />
                </button>
              )}
            </>
          )}
        </form>
        )}
      </div>

      {/* WhatsApp-style message menu */}
      <MessageMenu
        menu={
          // Audit-2 L33: the menu's body is a snapshot from open time —
          // re-derive it live so Copy enables with the real text if
          // decryption lands while the menu is still open (instead of
          // staying disabled until the menu is reopened). A deleted
          // message falls back to the snapshot.
          menu
            ? (() => {
                const msg = (messages ?? []).find((x) => x.id === menu.messageId);
                if (!msg) return menu;
                const liveBody = displayBodyFor(msg);
                return { ...menu, body: liveBody, copyDisabled: isPlaceholderBody(liveBody) };
              })()
            : null
        }
        onClose={() => setMenu(null)}
        onReact={(id, emoji) => onReact(id, emoji)}
        onEdit={(id) => {
          const msg = messages?.find((x) => x.id === id);
          if (msg) openEditor(msg);
        }}
        onDelete={(id) => onDelete(id)}
        onInfo={(id) => {
          const msg = messages?.find((x) => x.id === id);
          // M14: Info only for my own messages (defense-in-depth — the
          // menu already hides Info for others' messages).
          if (msg && msg.user_id === user?.id) setInfoMsg(msg);
        }}
      />

      <PeerProfileSheet
        userId={profileUserId}
        open={profileUserId !== null}
        onOpenChange={(o) => !o && setProfileUserId(null)}
      />
      {/* Audit-2 M21: Delete asks first (see onDelete / confirmDeleteMessage). */}
      <Dialog open={deleteTargetId !== null} onOpenChange={(o) => !o && setDeleteTargetId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete message?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This message will be deleted for everyone. This can&apos;t be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteTargetId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDeleteMessage()}>
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Message info: who has seen it */}
      <Dialog open={infoMsg !== null} onOpenChange={(o) => !o && setInfoMsg(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Message info</DialogTitle>
          </DialogHeader>
          {infoMsg && (
            <div className="space-y-4">
              <p className="rounded-xl bg-secondary px-3 py-2 text-sm break-words">
                {/* M16: render the DISPLAY body (decrypted in E2EE rooms),
                    not the raw body — the old code showed the E2E1:
                    ciphertext blob as if it were the message text. */}
                {displayBodyFor(infoMsg) || (
                  <span className="italic text-muted-foreground">[attachment]</span>
                )}
              </p>
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  Read by
                </p>
                {(() => {
                  const readers = seenBy(infoMsg.created_at);
                  if (readers.length === 0)
                    return <p className="text-sm text-muted-foreground">Nobody has read it yet.</p>;
                  return (
                    <ul className="space-y-2">
                      {readers.map((uid) => {
                        const rec = receipts?.find((r) => r.user_id === uid);
                        return (
                          <li key={uid} className="flex items-center justify-between text-sm">
                            <span className="font-semibold">
                              {profileMap.get(uid)?.display_name ?? "Someone"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {rec?.last_read_at
                                ? formatDistanceToNow(new Date(rec.last_read_at), {
                                    addSuffix: true,
                                  })
                                : ""}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()}
              </div>
              <p className="text-xs text-muted-foreground">
                Sent {formatDistanceToNow(new Date(infoMsg.created_at), { addSuffix: true })}
                {infoMsg.edited_at ? " · edited" : ""}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
