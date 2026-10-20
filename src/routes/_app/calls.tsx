import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { MobileShell, MobileCalls } from "@/components/mobile-shell";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useCall } from "@/components/call-overlay";
import { listCalls, type CallRecord } from "@/lib/calls";
import { deleteCallHistory } from "@/lib/chat.functions";
import { supabase } from "@/integrations/supabase/client";
import { SmartAvatar } from "@/components/smart-avatar";
import { paletteFor } from "@/lib/avatar-palette";
import { ArrowDownLeft, ArrowUpRight, Phone, Trash2, Video } from "lucide-react";

export const Route = createFileRoute("/_app/calls")({
  component: CallsPage,
  // Audit-4 L80: this route consumes no search keys.
  validateSearch: () => ({}),
  head: () => ({
    meta: [
      { title: "Calls — VibeTalk" },
      { name: "description", content: "Your VibeTalk call history." },
      { property: "og:title", content: "Calls — VibeTalk" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function callLabel(r: CallRecord): string {
  // Audit-2 L55: a 30s call rendered "· 0 min" — show "<1 min" under 60s.
  const dur =
    r.duration_seconds > 0
      ? ` · ${r.duration_seconds < 60 ? "<1 min" : `${Math.floor(r.duration_seconds / 60)} min`}`
      : "";
  const kind = r.type === "video" ? "video call" : "voice call";
  if (r.status === "missed") return `Missed ${kind}`;
  if (r.status === "cancelled") return `Cancelled ${kind}`;
  if (r.status === "declined") return `Declined ${kind}`;
  if (r.status === "failed") return `Failed ${kind}`;
  const dir = r.direction === "incoming" ? "Incoming" : "Outgoing";
  return `${dir} ${kind}${dur}`;
}

function CallsPage() {
  const isDesktop = useIsDesktop();
  // Audit-2 M17: breakpoint unknown (SSR / pre-hydration) — render a
  // query-free placeholder, not a branch (the server renders the
  // same tree, so there is no hydration mismatch).
  if (isDesktop === null) {
    return <div className="h-full min-h-0" />;
  }

  // Mobile: the new shell (Calls view).
  if (!isDesktop) {
    return (
      <MobileShell view="calls">
        <MobileCalls />
      </MobileShell>
    );
  }

  // Desktop: the redesigned Calls history (desktop mockup pass,
  // 2026-10-20 — Audit-7 D-I5: the old comment here claimed this
  // route was "not a redesign"; it is one).
  return <DesktopCalls />;
}

function DesktopCalls() {
  const { startCall } = useCall();
  const qc = useQueryClient();
  const deleteHistory = useServerFn(deleteCallHistory);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  // Audit-2 L49: cursor pages (was a hard 50-row cap with no way to
  // see older history). The ["calls"] key is unchanged, so the M43
  // realtime invalidation below still refreshes every page.
  const {
    data: pages,
    isLoading,
    isError,
    refetch: refetchCalls,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["calls"],
    queryFn: ({ pageParam }) => listCalls({ cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const calls = pages?.pages.flatMap((p) => p.calls) ?? [];

  // Audit-2 L49: delete one row / clear all — confirm first, then
  // invalidate ["calls"] so both lists re-read.
  const onDeleteOne = async (id: string, peerName: string) => {
    if (!window.confirm(`Delete this call with ${peerName} from your history?`)) return;
    setDeletingId(id);
    try {
      await deleteHistory({ data: { id } });
      await qc.invalidateQueries({ queryKey: ["calls"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not delete this call.");
    } finally {
      setDeletingId(null);
    }
  };
  const onClearAll = async () => {
    if (!window.confirm("Delete your entire call history? This can't be undone.")) return;
    setClearingAll(true);
    try {
      await deleteHistory({ data: { all: true } });
      await qc.invalidateQueries({ queryKey: ["calls"] });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not clear call history.");
    } finally {
      setClearingAll(false);
    }
  };

  // M43: a finished/missed call must appear without a remount — a
  // call that ends on another device/tab writes a new `calls` row;
  // subscribe to it (mirrors InboxPane's "rooms-list" channel). The
  // same-tab case is covered by the CallProvider's onCallFinished
  // invalidation.
  // Audit-3 A6-N6: M55 liveness (was a bare .subscribe()) — same
  // treatment as MobileCalls: status callback, disconnected ref,
  // refresh ["calls"] on re-SUBSCRIBED, amber badge while down.
  const [callsLive, setCallsLive] = useState(false);
  const callsDisconnectedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    const ch = supabase
      .channel("calls-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "calls" }, () => {
        qc.invalidateQueries({ queryKey: ["calls"] });
      })
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") {
          setCallsLive(true);
          if (callsDisconnectedRef.current) {
            callsDisconnectedRef.current = false;
            qc.invalidateQueries({ queryKey: ["calls"] });
          }
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          callsDisconnectedRef.current = true;
          setCallsLive(false);
          console.warn("[desktop-calls] realtime channel lost:", status);
        }
      });
    return () => {
      alive = false;
      supabase.removeChannel(ch);
    };
  }, [qc]);

  return (
    <div className="h-full w-full overflow-y-auto px-[38px] pb-[38px] pt-[30px]">
      <div className="flex items-start justify-between gap-5">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-[-0.03em]">Calls</h1>
          <p className="mt-1 text-[14.5px] font-semibold text-muted-foreground">
            Your call history. Start a call from People or from a direct conversation.
          </p>
          {/* Audit-3 A6-N6: visible when the calls realtime channel is down. */}
          {!callsLive && (
            <span
              className="mt-3 inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-400"
              title="Live updates disconnected — call history may need a refresh"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              Reconnecting…
            </span>
          )}
        </div>
        {/* Audit-2 L49: clear-all (only when there is history to
            clear). Mockup: quiet text button, header right, turns
            red on hover. */}
        {!isLoading && !isError && calls.length > 0 && (
          <button
            type="button"
            className="shrink-0 px-1 py-2 text-sm font-extrabold text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
            disabled={clearingAll}
            onClick={() => void onClearAll()}
          >
            {clearingAll ? "Clearing…" : "Clear call history"}
          </button>
        )}
      </div>
      {/* Audit-3 A3-10: list semantics for the rows. Mockup grid:
          two columns, gap 14. */}
      <div className="mt-6 grid items-start gap-[14px] md:grid-cols-2" role="list">
        {isLoading ? (
          <p className="col-span-full py-16 text-center text-sm text-muted-foreground">
            Loading calls…
          </p>
        ) : isError ? (
          // M19: a load failure is NOT "no calls yet" — say so.
          // Audit-2 L52: offer a retry instead of a dead end.
          <div className="col-span-full py-16 text-center">
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load call history. Check your connection and try again.
            </p>
            <button
              type="button"
              className="mt-3 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              onClick={() => void refetchCalls()}
            >
              Tap to retry
            </button>
          </div>
        ) : calls.length === 0 ? (
          <p className="col-span-full rounded-[12px] border border-dashed border-border bg-card p-[46px] text-center font-bold text-muted-foreground">
            No calls yet. When you make or receive a call, it will show up here.
          </p>
        ) : (
          calls.map((r) => (
            <div
              key={r.id}
              role="listitem"
              className="flex items-center gap-[14px] rounded-[12px] border border-border bg-card p-[14px_16px] shadow-sm"
            >
              <SmartAvatar
                userId={r.peer_id}
                name={r.peer_name}
                className="h-12 w-12 shrink-0 rounded-full text-[15px]"
                fallbackClassName={`rounded-full text-[15px] ${paletteFor(r.peer_name)}`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15.5px] font-extrabold">{r.peer_name}</div>
                <div className="mt-0.5 flex items-center gap-1.5 truncate text-[13px] font-semibold text-muted-foreground">
                  <span
                    className={`grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[7px] ${
                      r.status === "missed"
                        ? "bg-[#f7e9eb] text-[#9d2235] dark:bg-[#2a171b] dark:text-[#c4707d]"
                        : "bg-accent text-accent-foreground"
                    }`}
                  >
                    {r.direction === "incoming" ? (
                      <ArrowDownLeft className="h-[13px] w-[13px]" strokeWidth={2.4} />
                    ) : (
                      <ArrowUpRight className="h-[13px] w-[13px]" strokeWidth={2.4} />
                    )}
                  </span>
                  <span className="truncate">
                    <span
                      className={
                        callLabel(r).startsWith("Missed")
                          ? "font-bold text-destructive"
                          : undefined
                      }
                    >
                      {callLabel(r)}
                    </span>{" "}
                    · {new Date(r.started_at).toLocaleString()}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] text-[#93a498] transition-colors hover:bg-[#f7e9eb] hover:text-[#9d2235] disabled:opacity-50 dark:hover:bg-[#2a171b] dark:hover:text-[#c4707d]"
                aria-label={`Delete call with ${r.peer_name} from history`}
                title="Delete"
                disabled={deletingId === r.id}
                onClick={() => void onDeleteOne(r.id, r.peer_name)}
              >
                <Trash2 className="h-[18px] w-[18px]" />
              </button>
              <button
                type="button"
                className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[10px] bg-primary text-primary-foreground transition-colors hover:bg-[#16a34a] disabled:opacity-50"
                aria-label={`${r.type === "video" ? "Video call" : "Call"} ${r.peer_name}`}
                title="Call back"
                // Audit-3 A5-N16: redial with the row's own type.
                onClick={() =>
                  void startCall(r.peer_id, r.peer_name, r.type === "video" ? "video" : "voice")
                }
              >
                {r.type === "video" ? (
                  <Video className="h-[19px] w-[19px]" />
                ) : (
                  <Phone className="h-[19px] w-[19px]" />
                )}
              </button>
            </div>
          ))
        )}
      </div>
      {/* Audit-2 L49: older pages load on demand. */}
      {hasNextPage && (
        <div className="mt-4 text-center">
          <button
            type="button"
            className="rounded-full bg-secondary px-4 py-2 text-sm font-semibold"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? "Loading…" : "Load older calls"}
          </button>
        </div>
      )}
    </div>
  );
}
