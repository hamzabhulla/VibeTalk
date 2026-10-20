import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { listRooms } from "@/lib/chat.functions";
import {
  canNotify,
  previewForMessage,
  NOTIFICATION_PREVIEW_HIDDEN,
  showMessageNotification,
} from "@/lib/notifications";

type NewMessage = {
  room_id: string;
  user_id: string;
  body: string | null;
  type: string | null;
  // Audit-3 A7-N3: catch-up watermark — the INSERT payload carries the
  // full row, so created_at is available here.
  created_at: string | null;
};

/**
 * Listens for new messages across every room the user can see and raises a
 * browser notification when one arrives from someone else — unless the user
 * is actively looking at that room. Mounted once inside the authed layout.
 */
export function MessageNotifier() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const roomsFn = useServerFn(listRooms);

  const roomsRef = useRef(new Map<string, { name: string; is_dm: boolean }>());
  const namesRef = useRef(new Map<string, string>());
  // Audit-2 M60: namesRef is an LRU cache, capped — it used to grow
  // forever (one entry per sender ever seen). Touch on hit (delete +
  // re-set moves to the end); evict oldest on insert past the cap.
  const NAMES_CACHE_MAX = 100;
  const cacheSenderName = (id: string, name: string) => {
    const m = namesRef.current;
    if (m.has(id)) m.delete(id);
    m.set(id, name);
    while (m.size > NAMES_CACHE_MAX) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  };
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  // Audit-2 L70: the viewer's own preview preference (lock-screen
  // privacy) — off means in-app notifications show only "New
  // message". Cached forever; the two toggle sites invalidate
  // ["my-preview-pref"] after a successful save. Pre-SQL the column
  // doesn't exist -> the query errors -> previews ON (current
  // behaviour), same fail-open as the push fan-out.
  const { data: previewsOn = true } = useQuery({
    queryKey: ["my-preview-pref", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("show_notification_previews")
        .eq("id", user!.id)
        .maybeSingle();
      // Audit-4 M22: THROW on error — the old code returned true
      // on ANY error, and staleTime: Infinity then pinned
      // previews-ON for the whole session, so a transient lookup
      // failure permanently exposed message previews the viewer
      // had turned off. Throwing keeps the fail-open default
      // (data stays undefined → the `= true` destructure above)
      // while React Query retries in the background and the real
      // pref lands when a retry succeeds. Pre-SQL (missing
      // column) still fails open via the same default.
      if (error) throw error;
      return data?.show_notification_previews ?? true;
    },
    enabled: !!user?.id,
    staleTime: Infinity,
  });
  const mutedRef = useRef(new Set<string>());
  // M33: fail-closed flag — when the mute load errors (e.g. the
  // is_muted column is missing), the mute state is unknown, so the
  // handler must not notify at all (the old code reset mutedRef to
  // empty = fail open, silently un-muting every chat).
  // Audit-4 M16: starts TRUE — the mute state is unknown until the
  // first load resolves. The old `false` init let a realtime INSERT
  // arriving before load() resolved pass the check with mutedRef
  // still empty, so a muted room could ping once per mount/reload.
  // A ping dropped during the first load is the safe direction.
  const muteUnknownRef = useRef(true);
  // Audit-3 A7-N3: catch-up watermark — created_at of the newest
  // notifiable message this notifier has processed (live INSERTs +
  // catch-up). On re-SUBSCRIBED after a disconnect, messages newer
  // than this are fetched and notified (the SW suppresses the system
  // push while a visible tab exists, so a dead notifier otherwise
  // loses the ping entirely). Initialized to "now" at effect start —
  // pre-mount history is the inbox's job, not a ping storm.
  const lastSeenAtRef = useRef<string | null>(null);
  // Audit-3 A7-N3: set on CHANNEL_ERROR/TIMED_OUT/CLOSED; catch-up
  // runs only when re-SUBSCRIBED with this set (not on first subscribe).
  const notifierDisconnectedRef = useRef(false);

  // Muted chats never ping (defensive: the column may not exist yet).
  // Audit-2 L73: refreshed by a postgres_changes channel on the
  // caller's own room_members rows (mute/unmute lands at once),
  // with a 5-min backstop + visibility reload (was a 30s poll —
  // every tab re-fetched every 30s whether anything changed).
  useEffect(() => {
    if (!user?.id) return;
    let alive = true;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from("room_members")
          .select("room_id")
          .eq("user_id", user.id)
          .eq("is_muted", true);
        if (error) throw error;
        if (alive) {
          mutedRef.current = new Set((data ?? []).map((r) => r.room_id));
          muteUnknownRef.current = false;
        }
      } catch {
        // M33: fail CLOSED — mute state unknown, don't notify. Keep
        // the last known mutes (don't clear to empty = fail open).
        if (alive) muteUnknownRef.current = true;
      }
    };
    void load();
    const ch = supabase
      .channel("hcroom-notifier-mutes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_members", filter: `user_id=eq.${user.id}` },
        () => void load(),
      )
      .subscribe((status) => {
        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          console.warn("[notifier] mutes channel lost:", status, "— 5-min backstop still refreshes.");
        }
      });
    const timer = window.setInterval(() => void load(), 300_000);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      supabase.removeChannel(ch);
    };
  }, [user?.id]);

  // Keep a fresh id -> room directory for notification titles.
  // M84: this used to load ONCE on mount — a room joined/created
  // later never appeared, so its notifications fell back to the bare
  // sender name. Audit-2 L73: refreshed by postgres_changes on
  // rooms + the caller's room_members rows (join/leave/rename lands
  // at once), with a 5-min backstop + visibility reload (was a 30s
  // poll — every tab re-fetched every 30s whether anything changed).
  useEffect(() => {
    if (!user?.id) return;
    let alive = true;
    const load = async () => {
      try {
        // Audit-4 L59: page through ALL rooms — the old bare call
        // only read the first 200, so notifications for rooms 201+
        // fell back to the bare sender name (no room title). The
        // loop stops at the first page with no nextCursor, and a
        // repeated cursor (server bug) breaks instead of hammering
        // the server.
        const m = new Map<string, { name: string; is_dm: boolean }>();
        let cursor: string | undefined;
        for (;;) {
          if (!alive) return;
          const res = cursor ? await roomsFn({ data: { cursor } }) : await roomsFn();
          for (const r of res.rooms ?? []) m.set(r.id, { name: r.name, is_dm: r.is_dm });
          const next = res.nextCursor ?? undefined;
          if (!next || next === cursor) break;
          cursor = next;
        }
        if (!alive) return;
        roomsRef.current = m;
      } catch {
        /* titles fall back to the sender name */
      }
    };
    void load();
    const ch = supabase
      .channel("hcroom-notifier-rooms")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms" },
        () => void load(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_members", filter: `user_id=eq.${user.id}` },
        () => void load(),
      )
      .subscribe((status) => {
        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          console.warn("[notifier] rooms channel lost:", status, "— 5-min backstop still refreshes.");
        }
      });
    const timer = window.setInterval(() => void load(), 300_000);
    const onVis = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      supabase.removeChannel(ch);
    };
  }, [roomsFn, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const me = user.id;

    let alive = true;
    // Audit-4 L38: initialize the catch-up watermark ONCE — the
    // old code reset it to "now" on EVERY effect re-run (e.g.
    // when previewsOn resolved), so a re-run after a disconnect
    // but before re-SUBSCRIBED moved the watermark past the
    // disconnect-window messages, and catchUpMissed fetched
    // nothing. On re-runs the watermark stays at the last
    // notified message (notifyForMessage advances it), so
    // catch-up still covers the gap.
    if (!lastSeenAtRef.current) {
      lastSeenAtRef.current = new Date().toISOString();
    }
    const notifyForMessage = async (msg: NewMessage) => {
      // Audit-3 A7-N3: advance the catch-up watermark — every notifiable
      // message flows through here (live INSERTs + catch-up), so a later
      // reconnect never re-notifies the same message.
      if (msg.created_at && (!lastSeenAtRef.current || msg.created_at > lastSeenAtRef.current)) {
        lastSeenAtRef.current = msg.created_at;
      }
      if (!canNotify()) return;
      // M33: mute state unknown — fail closed, don't notify.
      if (muteUnknownRef.current) return;
      // Audit-2 M60: ALWAYS verify membership live before showing
      // a preview. The old code trusted the 30s rooms cache, so a
      // user removed from a room kept getting previews for up to
      // 30s (the cache still contained the room). A removed
      // member's row is gone -> maybeSingle returns null -> no
      // notification. A query error also yields null -> fail
      // CLOSED (one lost ping beats a leaked preview). The
      // rooms cache now serves only the notification title.
      // (Evict-on-DELETE was rejected: a message INSERT can
      // overtake the DELETE event across tables, leaving a
      // race the live check does not have.)
      const { data: membership } = await supabase
        .from("room_members")
        .select("room_id")
        .eq("room_id", msg.room_id)
        .eq("user_id", me)
        .maybeSingle();
      if (!membership) return;
      if (mutedRef.current.has(msg.room_id)) return;

      // Don't ping when the user is actively reading this room.
      const viewing = pathRef.current.match(/\/rooms\/([^/?#]+)/)?.[1];
      if (viewing === msg.room_id && !document.hidden) return;

      // Audit-2 M50: when the tab is hidden, the service worker's
      // push notification owns the ping — an in-app Notification
      // here would be a SECOND ping for the same message. Skip;
      // the SW shows it (its H40 rule only suppresses when a tab
      // is visible + in-app). Residual: if push is off/broken AND
      // the tab is hidden, no ping arrives — the same as the
      // SW-only world, and the Profile push diagnostics surface a
      // broken registration.
      if (document.hidden) return;

      let sender = namesRef.current.get(msg.user_id);
      if (sender) {
        // Audit-2 M60: LRU touch — a hit marks the sender
        // most-recent so the cap evicts idle senders first.
        namesRef.current.delete(msg.user_id);
        namesRef.current.set(msg.user_id, sender);
      }
      if (!sender) {
        // Audit-2 C3: sender names come from the privacy-filtered
        // view (the table is own-row-only now). Pre-§C3 the view
        // doesn't exist -> fall back to the table read.
        const viewRes = await supabase
          .from("profiles_public")
          .select("display_name")
          .eq("id", msg.user_id)
          .maybeSingle();
        let name: string | null | undefined = viewRes.data?.display_name;
        if (
          viewRes.error &&
          (viewRes.error.code === "PGRST205" ||
            /does not exist/i.test(viewRes.error.message ?? ""))
        ) {
          const tableRes = await supabase
            .from("profiles")
            .select("display_name")
            .eq("id", msg.user_id)
            .maybeSingle();
          name = tableRes.data?.display_name;
        }
        sender = name?.trim() || "Someone";
        // Audit-2 M60: capped LRU insert (was an unbounded set).
        cacheSenderName(msg.user_id, sender);
      }

      const room = roomsRef.current.get(msg.room_id);
      // Audit-4 M12: previews off -> the TITLE must be nameless and
      // roomless too, not just the body. The old code hid only the
      // body while the title still leaked who + which room
      // ("Sender in Room") onto the lock screen.
      const title = !previewsOn
        ? "VibeTalk"
        : room && !room.is_dm
          ? `${sender} in ${room.name}`
          : sender;

      showMessageNotification({
        title,
        // Audit-2 L70: previews off -> "New message" only (the
        // viewer's own preference, from ["my-preview-pref"]).
        body: previewsOn ? previewForMessage(msg.type, msg.body) : NOTIFICATION_PREVIEW_HIDDEN,
        tag: `hcroom-msg-${msg.room_id}`,
        onClick: () => navigate({ to: "/rooms/$roomId", params: { roomId: msg.room_id } }),
      });
    };

    // Audit-3 A7-N3: catch-up on re-SUBSCRIBED after a disconnect — the
    // SW suppresses the system push whenever a visible tab exists,
    // assuming THIS notifier will show the message, so a dead notifier
    // meant the message was lost entirely. Fetch messages newer than
    // the watermark and run them through the same notify path (RLS +
    // the M60 live membership check still gate every message). Capped
    // at 20 (a long outage must not spam 50 pings); the inbox unread
    // badge covers anything past the cap.
    const catchUpMissed = async () => {
      const since = lastSeenAtRef.current;
      if (!since) return;
      try {
        const { data } = await supabase
          .from("messages")
          .select("room_id, user_id, body, type, created_at")
          .gt("created_at", since)
          .neq("user_id", me)
          .order("created_at", { ascending: true })
          .limit(20);
        for (const m of data ?? []) {
          if (!alive) return;
          await notifyForMessage(m);
        }
      } catch {
        // Best-effort — the inbox unread badge still surfaces the message.
      }
    };


    const ch = supabase
      .channel("hcroom-message-notify")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        async (payload) => {
          const msg = payload.new as NewMessage | undefined;
          if (!msg || msg.user_id === me) return;
          await notifyForMessage(msg);
        },
      )
      // Audit-2 H23: the old code called .subscribe() with NO status
      // callback — if this channel failed (CHANNEL_ERROR / TIMED_OUT /
      // CLOSED), nothing logged, nothing retried visibly, no UI. And
      // the SW suppresses the system push whenever a visible in-app
      // tab exists, assuming THIS notifier will show the message —
      // so a dead notifier meant the message was lost entirely
      // (no in-app, no system notification). Correction to the audit:
      // the retry itself is NOT missing — the Phoenix layer already
      // re-joins errored/timed-out channels with backoff (see
      // @supabase/phoenix channel.js rejoinTimer), so recreating the
      // channel here would double-subscribe (duplicate INSERT
      // handlers). What was missing is VISIBILITY: log + a deduped
      // toast while the channel is down, dismissed on SUBSCRIBED.
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          toast.dismiss("notifier-realtime");
          // Audit-3 A7-N3: catch-up only after a real disconnect
          // (not the first subscribe) — see catchUpMissed.
          if (notifierDisconnectedRef.current) {
            notifierDisconnectedRef.current = false;
            void catchUpMissed();
          }
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          notifierDisconnectedRef.current = true;
          console.warn(
            `[notifier] realtime channel ${status} — in-app notifications paused until it resubscribes (Phoenix retries automatically).`,
          );
          toast.error("Message notifications disconnected — reconnecting…", {
            id: "notifier-realtime",
            duration: Infinity,
          });
        }
      });

    return () => {
      alive = false;
      toast.dismiss("notifier-realtime");
      supabase.removeChannel(ch);
    };
  }, [user?.id, navigate, previewsOn]);

  return null;
}
