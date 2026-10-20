import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { InboxPane } from "@/components/inbox-pane";
import { MobileShell, MobileChats } from "@/components/mobile-shell";
import { useIsDesktop } from "@/hooks/use-is-desktop";

export const Route = createFileRoute("/_app/rooms")({
  component: RoomsLayout,
  // Audit-4 L80: this route consumes no search keys.
  validateSearch: () => ({}),
  head: () => ({
    meta: [
      { title: "Messages — VibeTalk" },
      { name: "description", content: "Your VibeTalk conversations." },
      { property: "og:title", content: "Messages — VibeTalk" },
      { property: "og:description", content: "Your VibeTalk conversations." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

/**
 * Desktop: two-pane layout (inbox left, conversation right) like the mockup.
 * Mobile: single pane — inbox at /rooms, conversation at /rooms/$roomId.
 *
 * Audit-2 M16: the conversation (<Outlet />) lives at ONE stable
 * position with a load-bearing key. The old code rendered two
 * DIFFERENT trees (desktop branch vs mobile branch), so crossing
 * 768px unmounted the conversation — draft, scroll, pagination and
 * the realtime channel all died. Now a resize at a conversation
 * only mounts/unmounts the inbox aside; the keyed conversation div
 * is matched by React across the aside's mount/unmount (without the
 * keys, the div would shift index and React would unmount it).
 * Only one list ever mounts, so realtime channels are never
 * double-subscribed. The list search/filter survive the list swap
 * via the shared chat-list store (see chat-list-filter.ts).
 * Create-room drafts are still local to each list (resize mid-
 * create resets that draft — documented residual).
 */
function RoomsLayout() {
  const isDesktop = useIsDesktop();
  // Audit-3 A3-01: EVERY hook must run before the `isDesktop === null`
  // early return below. This `useRouterState` used to sit AFTER it,
  // so the cold-load render (isDesktop null → placeholder, 1 hook)
  // ran FEWER hooks than the settled render (2 hooks) → React threw
  // "Rendered more hooks than during the previous render" and the
  // error boundary showed "Something went wrong" until a manual
  // retry. Client-side navigation never crashed (the store was
  // already settled), which hid it.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Audit-2 M17: breakpoint unknown (SSR / pre-hydration) — render a
  // query-free placeholder, not a branch (the server renders the
  // same tree, so there is no hydration mismatch).
  if (isDesktop === null) {
    return <div className="h-full min-h-0" />;
  }
  // M83: "/rooms/" (trailing slash) is the index, NOT a conversation —
  // the old prefix test sent mobile to <Outlet /> (RoomsIndex
  // placeholder) instead of the Chats list.
  // Audit-3 A6-N2: same trailing-slash normalization as AppShell —
  // "/rooms/" normalizes to "/rooms" (index), "/rooms/<id>/" stays a
  // conversation.
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const inConversation = clean !== "/rooms" && clean.startsWith("/rooms/");
  const showMobileList = !isDesktop && !inConversation;

  // Mobile list: full-screen shell. This branch has no <Outlet /> —
  // navigating /rooms <-> /rooms/$roomId swaps list <-> conversation
  // (expected: that is navigation, not a breakpoint flip).
  // Audit-2 L65 (documented-PARTIAL, deliberate divergence): mobile
  // list views render inside <MobileShell> (inverted-light dark),
  // but the mobile conversation renders a bare <Outlet /> with NO
  // MobileShell, so it uses the native Tailwind `.dark` palette.
  // The two darks differ — and plain-inverting the conversation
  // would be WRONG (it would invert native-dark back to light).
  // Unifying them needs the mobile conversation to drop its `dark:`
  // variants (Tailwind's dark variant keys off the `.dark` ancestor
  // on <html>; there is no per-subtree opt-out) — a refactor with
  // visual risk across every conversation component. Left as a
  // documented divergence for the operator's call; do NOT "fix" it
  // with a wrap/invert hack.
  if (showMobileList) {
    return (
      <div className="h-full min-h-0">
        <MobileShell view="chats">
          <MobileChats />
        </MobileShell>
      </div>
    );
  }

  return (
    // Full-bleed two-pane (Hamza 2026-10-20: the mockup's floating
    // frame left a visible gap on all four sides in the real app —
    // removed; the panel now fills the whole content area edge to
    // edge). List stays 374px per the mockup.
    <div className="flex h-full min-h-0">
      {isDesktop ? (
        <aside key="inbox" className="h-full w-[374px] shrink-0 border-r border-border">
          <InboxPane />
        </aside>
      ) : null}
      <div key="conversation" className="h-full min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
