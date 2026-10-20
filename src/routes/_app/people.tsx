import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listUsers, getOrCreateDm } from "@/lib/chat.functions";
import { paletteFor } from "@/lib/avatar-palette";
import { isUserOnline, formatServerRelativeTime } from "@/lib/presence";
import { supabase } from "@/integrations/supabase/client";
import { SmartAvatar } from "@/components/smart-avatar";
import { MobileShell, MobilePeople } from "@/components/mobile-shell";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useCall } from "@/components/call-overlay";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageCircle, Phone, Search, Video } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/people")({
  component: PeoplePage,
  // Audit-4 L80: this route consumes no search keys.
  validateSearch: () => ({}),
  head: () => ({
    meta: [
      { title: "People — VibeTalk" },
      { name: "description", content: "Find people and start a direct conversation." },
      { property: "og:title", content: "People — VibeTalk" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function PeoplePage() {
  // H44: the wrapper runs NO queries/subscriptions. The desktop-only
  // ["users"] query + "people-list" channel live in DesktopPeople, so
  // mobile doesn't open a second Supabase channel for the same table
  // (MobilePeople has its own "mobile-people-list" channel).
  const isDesktop = useIsDesktop();
  // Audit-2 M17: breakpoint unknown (SSR / pre-hydration) — render a
  // query-free placeholder, not a branch (the server renders the
  // same tree, so there is no hydration mismatch).
  if (isDesktop === null) {
    return <div className="h-full min-h-0" />;
  }
  if (!isDesktop) {
    return (
      <MobileShell view="people">
        <MobilePeople />
      </MobileShell>
    );
  }
  return <DesktopPeople />;
}

function DesktopPeople() {
  const users = useServerFn(listUsers);
  const openDm = useServerFn(getOrCreateDm);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { startCall } = useCall();

  // Desktop redesign (2026-10-20): search box from the approved
  // mockup, wired to listUsers' EXISTING server-side search param
  // (audit-3 A4-N24) — no new backend. Debounced 250ms; the query
  // key carries the term, and the presence channel's ["users"]
  // prefix invalidation still matches (TanStack prefix semantics).
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Audit-2 M42: same as MobilePeople — a listUsers failure used to
  // render as "No other users yet." Error state + retry, before empty.
  const {
    data: userList,
    isLoading,
    isError: usersError,
    refetch: refetchUsers,
  } = useQuery({
    queryKey: ["users", search],
    queryFn: () =>
      users({ data: { search } }).catch((err) => {
        console.warn("[people] listUsers failed:", err);
        throw err;
      }),
    // Audit-4 M19: presence goes stale while open without this.
    // The profiles subscription below can never deliver OTHER
    // users' presence: the heartbeat writes ONLY the `presence`
    // table (never `profiles`, §M53), `presence` is deliberately
    // NEVER in the Realtime publication (broadcast storm), and
    // post-C3 the profiles policy is own-row-only so the channel
    // fires only for the viewer's own row. Poll every 30s while
    // the view is open — inside the 120s staleness window, so the
    // dots stay fresh.
    refetchInterval: 30_000,
  });

  // Audit-2 M55: track the people-list channel's liveness (room
  // view's rtLive pattern) — a failed subscribe used to fail silently.
  const [peopleLive, setPeopleLive] = useState(false);
  const peopleDisconnectedRef = useRef(false);
  useEffect(() => {
    // Audit-6 B-D1: this channel watched public.profiles — dead
    // since §C3 made profiles own-row-only (postgres_changes
    // honours RLS, so another user's row can never arrive). It now
    // watches the presence table (LOW-13), whose read policy
    // delivers visible users' rows, so online state here is
    // actually live. M35 throttle kept: presence ticks ~25s per
    // online user; the 120s staleness window makes a 15s throttle
    // lossless for display.
    let alive = true;
    let lastProfilesInvalidate = 0;
    const ch = supabase
      .channel("people-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "presence" }, () => {
        const now = Date.now();
        if (now - lastProfilesInvalidate < 15_000) return;
        lastProfilesInvalidate = now;
        qc.invalidateQueries({ queryKey: ["users"] });
      })
      // Audit-2 M55: status callback (was a bare .subscribe()). On
      // re-SUBSCRIBED after a disconnect, refresh — presence updates
      // were missed while the socket was down.
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") {
          setPeopleLive(true);
          if (peopleDisconnectedRef.current) {
            peopleDisconnectedRef.current = false;
            qc.invalidateQueries({ queryKey: ["users"] });
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          peopleDisconnectedRef.current = true;
          setPeopleLive(false);
          console.warn("[people] realtime channel lost:", status);
        }
      });
    return () => {
      alive = false;
      supabase.removeChannel(ch);
    };
  }, [qc]);

  // Audit-2 M46: per-user in-flight guard for getOrCreateDm (same as
  // MobilePeople — ref guards, state mirrors for the disabled UI).
  const pendingDmRef = useRef(new Set<string>());
  const [pendingDm, setPendingDm] = useState<ReadonlySet<string>>(new Set());
  const startDm = async (otherUserId: string) => {
    if (pendingDmRef.current.has(otherUserId)) return;
    pendingDmRef.current.add(otherUserId);
    setPendingDm(new Set(pendingDmRef.current));
    try {
      const { roomId } = await openDm({ data: { otherUserId } });
      navigate({ to: "/rooms/$roomId", params: { roomId } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      pendingDmRef.current.delete(otherUserId);
      setPendingDm(new Set(pendingDmRef.current));
    }
  };

  return (
    <div className="h-full w-full overflow-y-auto px-[38px] pb-[38px] pt-[30px]">
      <div className="flex items-center gap-2">
        <h1 className="text-[28px] font-extrabold tracking-[-0.03em]">People</h1>
        {/* Audit-2 M55: visible when the people realtime channel is down. */}
        {!peopleLive && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
            title="Live updates disconnected — presence may need a refresh"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            Reconnecting…
          </span>
        )}
      </div>
      <p className="mt-1 text-[14.5px] font-semibold text-muted-foreground">
        Start a direct conversation.
      </p>

      {/* Search — mockup spec: 460px max, radius 10, wired to
          listUsers' existing server-side search param. */}
      <div className="mt-5 flex max-w-[460px] items-center gap-[9px] rounded-[10px] border border-border bg-card px-[13px] py-[10px]">
        <Search className="h-[19px] w-[19px] shrink-0 text-[#93a498]" />
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          maxLength={100}
          placeholder="Search people"
          aria-label="Search people"
          className="w-full bg-transparent text-[14.5px] font-semibold outline-none placeholder:text-[#93a498]"
        />
      </div>

      {/* Audit-3 A3-10: list semantics for the rows. Mockup grid:
          auto-fill minmax(296px, 1fr), gap 16. */}
      <div
        className="mt-[22px] grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(296px,1fr))]"
        role="list"
      >
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[132px] rounded-[14px]" />
          ))
        ) : usersError ? (
          <div className="col-span-full py-16 text-center">
            <p className="text-sm font-semibold text-foreground">Couldn&apos;t load people</p>
            <p className="mt-1 text-sm text-muted-foreground">
              People didn&apos;t load. Check your connection and try again.
            </p>
            <button
              type="button"
              className="mt-3 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              onClick={() => void refetchUsers()}
            >
              Retry
            </button>
          </div>
        ) : (userList ?? []).length === 0 ? (
          <p className="col-span-full py-16 text-center text-sm text-muted-foreground">
            {search ? `No one matches “${search}”.` : "No other users yet."}
          </p>
        ) : (
          (userList ?? []).map((u) => (
            <div
              key={u.id}
              role="listitem"
              className="rounded-[14px] border border-border bg-card p-[18px] shadow-sm"
            >
              <div className="flex items-center gap-[14px]">
                <div className="relative shrink-0">
                  <SmartAvatar
                    userId={u.id}
                    name={u.display_name}
                    className="h-14 w-14 rounded-full text-lg"
                    fallbackClassName={`rounded-full text-lg ${paletteFor(u.display_name)}`}
                  />
                  {isUserOnline(u.last_seen_at) && (
                    <span className="absolute bottom-0 right-0 h-[13px] w-[13px] rounded-full border-[2.5px] border-card bg-[#22c55e]" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[16.5px] font-extrabold">{u.display_name}</div>
                  <div className="mt-[1px] flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        isUserOnline(u.last_seen_at) ? "bg-[#22c55e]" : "bg-[#a7b5aa]"
                      }`}
                    />
                    {isUserOnline(u.last_seen_at)
                      ? "Online"
                      : u.last_seen_at
                        ? `Last seen ${formatServerRelativeTime(u.last_seen_at)}`
                        : "Offline"}
                  </div>
                </div>
              </div>
              <div className="mt-[18px] flex items-center gap-[9px]">
                <button
                  type="button"
                  onClick={() => void startCall(u.id, u.display_name, "voice")}
                  aria-label={`Voice call ${u.display_name}`}
                  title="Voice call"
                  className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[10px] border border-border bg-card text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
                >
                  <Phone className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => void startCall(u.id, u.display_name, "video")}
                  aria-label={`Video call ${u.display_name}`}
                  title="Video call"
                  className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[10px] border border-border bg-card text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-accent-foreground"
                >
                  <Video className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => startDm(u.id)}
                  disabled={pendingDm.has(u.id)}
                  className="inline-flex h-[42px] flex-1 items-center justify-center gap-2 rounded-[10px] bg-primary text-sm font-bold text-primary-foreground transition-colors hover:bg-[#16a34a] disabled:opacity-50"
                >
                  <MessageCircle className="h-[18px] w-[18px]" />
                  {pendingDm.has(u.id) ? "Opening…" : "Message"}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
