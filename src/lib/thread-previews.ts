/**
 * Audit-4 H2: thread-preview batching. The getThreadPreviews server fn
 * caps one call at 100 roomIds (zod `.max(100)` — kept deliberately as
 * a per-call guard). Both chat-list callers used to pass the FULL
 * unchunked id list, so any user with 101+ conversations got a Zod
 * throw on every attempt and every row fell back to "No messages
 * yet". This helper splits any id list into <=100 batches and
 * concatenates the results in input order. Fail-fast: a failed batch
 * rejects the whole fetch (same as the old single-call behaviour —
 * the query errors and the retry banner can succeed on retry).
 */
export const THREAD_PREVIEW_BATCH_SIZE = 100;

export async function fetchAllThreadPreviews<T extends { room_id: string }>(
  fetchOne: (roomIds: string[]) => Promise<T[]>,
  roomIds: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < roomIds.length; i += THREAD_PREVIEW_BATCH_SIZE) {
    const batch = await fetchOne(roomIds.slice(i, i + THREAD_PREVIEW_BATCH_SIZE));
    out.push(...batch);
  }
  return out;
}
