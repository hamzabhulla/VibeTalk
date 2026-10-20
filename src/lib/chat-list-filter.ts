import { useSyncExternalStore } from "react";

/**
 * Audit-2 M16: the chat-list search + filter survive the 768px
 * breakpoint flip. The desktop list (InboxPane) and the mobile list
 * (MobileChats) are DIFFERENT components — the layout unmounts one
 * and mounts the other on resize — so their local useState(search /
 * filter) used to reset. One module-level store (same pattern as
 * useTheme) keeps a single value both lists share; a resize swaps
 * the component, not the state.
 *
 * The filter values use the mobile spelling ("rooms"); InboxPane
 * maps it to its thread kind ("room") at the comparison site.
 */
export type ChatListFilter = "all" | "rooms" | "direct";

type ChatListFilterState = { search: string; filter: ChatListFilter };

let current: ChatListFilterState = { search: "", filter: "all" };
const listeners = new Set<() => void>();

function setState(patch: Partial<ChatListFilterState>) {
  current = { ...current, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ChatListFilterState {
  return current;
}

export function useChatListFilter(): ChatListFilterState {
  // Audit-4 L60: subscribe/getSnapshot hoisted to module scope —
  // the old inline arrows changed identity every render, so React
  // resubscribed on every render of every consumer (churn, not
  // incorrectness). Same shape as usePushHealFailure.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setChatListSearch(search: string) {
  setState({ search });
}

export function setChatListFilter(filter: ChatListFilter) {
  setState({ filter });
}

// Audit-3 A4-N14: clear on sign-out / session swap (called from
// handleAuthEventForCache) — the filter otherwise survived logout on
// a shared device and greeted the next account with the previous
// user's search text.
export function resetChatListFilter() {
  setState({ search: "", filter: "all" });
}
