/**
 * Audit-5 B1-LOW: raw PostgREST/GoTrue errors thrown from server
 * functions serialize to the client with schema/constraint
 * internals in them (column/table names, constraint text). Log the
 * real error server-side, hand the client a generic friendly one.
 * (The Audit-4 L10 pattern, applied class-wide.) App-layer errors
 * (rate-limit "Too many attempts", assertCanCall's "Too many
 * calls", validation messages) are NOT DB errors and never pass
 * through here — they keep their own deliberate text.
 */
export function dbErr(err: unknown, message: string): Error {
  const e = err as { message?: string } | null | undefined;
  console.warn(`[db] ${message} Server detail:`, e?.message ?? err);
  return new Error(message);
}
