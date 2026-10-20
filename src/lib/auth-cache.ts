import type { QueryClient } from "@tanstack/react-query";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { resetChatListFilter } from "@/lib/chat-list-filter";

/**
 * Audit-2 H5: keep the React Query cache scoped to one USER, not to the
 * SPA lifetime. One QueryClient lives for the whole app, but its data
 * (["me"], ["rooms"], ["users"], ["calls"], ...) belongs to whoever is
 * signed in. Without this, the next login's first paint renders the
 * PREVIOUS user's rooms/profile/people from stale cache while the
 * refetch is in flight — cross-account exposure on a shared device —
 * and the old data sits in memory until tab close / reload.
 *
 * - SIGNED_OUT -> clear() (removes all queries + their data; plain
 *   invalidateQueries() would only refetch and leave stale data
 *   paintable). Returns null (no remembered user).
 * - SIGNED_IN / USER_UPDATED / PASSWORD_RECOVERY with a DIFFERENT user
 *   id than the last event (session swap with no SIGNED_OUT in
 *   between, e.g. opening another user's verify or recovery link) ->
 *   clear() too, then invalidate. (Audit-3 A2-N10: PASSWORD_RECOVERY
 *   was previously dropped by the __root event filter, so a recovery
 *   swap never cleared the cache.)
 * - Same user -> invalidate only (fresh data, no flash of someone
 *   else's). Other events -> no-op.
 *
 * Returns the user id to remember for the next event.
 */
export function handleAuthEventForCache(
  event: AuthChangeEvent,
  session: Session | null,
  queryClient: QueryClient,
  lastUserId: string | null,
): string | null {
  if (event === "SIGNED_OUT") {
    queryClient.clear();
    // Audit-3 A4-N14: the chat-list filter is module-level state
    // (not query cache) — clear it too on sign-out.
    resetChatListFilter();
    return null;
  }
  if (event === "SIGNED_IN" || event === "USER_UPDATED" || event === "PASSWORD_RECOVERY") {
    const userId = session?.user.id ?? null;
    if (userId && userId !== lastUserId) {
      queryClient.clear();
      resetChatListFilter();
    }
    queryClient.invalidateQueries();
    return userId ?? lastUserId;
  }
  return lastUserId;
}
