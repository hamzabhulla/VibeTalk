import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { notifyNewMessage } from "@/lib/webpush-send.server";
import { isUserOnline } from "@/lib/presence";
import { MESSAGE_BODY_MAX_LENGTH } from "@/lib/message-limits";
import { randomBase64Url } from "@/lib/random";
import { checkRateLimitKey } from "@/lib/rate-limit";
import { dbErr } from "@/lib/db-error";
import { validateE2EEnvelope, getE2EEnvelopeRecipients, getE2EEnvelopeRoom, getE2EEnvelopeVersion } from "@/lib/e2ee";
import { supabaseProjectRef } from "@/lib/supabase-config";
import { ALLOWED_ATTACHMENT_MIMES } from "@/lib/attachment-mimes";

export const listRooms = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().max(500).optional(),
      })
      .optional()
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Audit-3 A8-N30: bounded cursor pages (the old query returned
    // EVERY non-DM room). Default 200 by last_activity_at desc —
    // the chat list shows the most recent rooms first. `cursor` is
    // opaque `<last_activity_at>|<id>` from the previous page's
    // nextCursor; the keyset condition (t, id) keeps ties
    // deterministic. The whole input object is optional — bare
    // listRooms() returns the first page, as before.
    const limit = data?.limit ?? 200;
    let cursorKey: { t: string; id: string } | null = null;
    if (data?.cursor) {
      const [t, id] = data.cursor.split("|");
      // Audit-5 B1-INFO: the cursor timestamp is server-issued (a DB
      // ISO timestamptz), so validate it as one — Date.parse also
      // accepted comma dates ("March 1, 2024") whose comma injected
      // extra fragments into the PostgREST .or() string.
      if (
        !t ||
        !id ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/.test(t) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ) {
        throw new Error("Invalid cursor.");
      }
      cursorKey = { t, id };
    }
    // is_e2ee is best-effort until vibetalk-e2ee-visibility.sql runs.
    // The two queries keep LITERAL select strings (a variable `cols`
    // breaks supabase-js's type-level select parser — ParserError).
    // The page chain (filter + order + limit + cursor) is identical
    // in both; keep them in sync.
    const cursorOr = cursorKey
      ? `last_activity_at.lt.${cursorKey.t},and(last_activity_at.eq.${cursorKey.t},id.lt.${cursorKey.id})`
      : null;
    const attempt = await (async () => {
      let q = supabase
        .from("rooms")
        .select(
          "id, name, description, is_private, is_dm, last_activity_at, created_at, created_by, is_e2ee",
        )
        .eq("is_dm", false)
        .order("last_activity_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit + 1);
      if (cursorOr) q = q.or(cursorOr);
      return q;
    })();
    let rooms = attempt.data;
    let error = attempt.error;
    if (attempt.error && String(attempt.error.message ?? "").includes("is_e2ee")) {
      const fallback = await (async () => {
        let q = supabase
          .from("rooms")
          .select("id, name, description, is_private, is_dm, last_activity_at, created_at, created_by")
          .eq("is_dm", false)
          .order("last_activity_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(limit + 1);
        if (cursorOr) q = q.or(cursorOr);
        return q;
      })();
      rooms = (fallback.data ?? []).map((r) => ({ ...r, is_e2ee: false })) as typeof rooms;
      error = fallback.error as typeof error;
    }
    const { data: memberships, error: membershipsError } = await supabase
      .from("room_members")
      .select("room_id")
      .eq("user_id", userId);
    // Audit-6 B-L4: a failed memberships query used to degrade
    // silently — memberSet came back empty and every private room
    // vanished from the list with no signal. Fail loudly instead.
    if (membershipsError) throw dbErr(membershipsError, "Could not load your chats — please try again.");
    if (error) throw dbErr(error, "Could not load your chats — please try again.");
    const memberSet = new Set((memberships ?? []).map((m) => m.room_id));
    const fetched = rooms ?? [];
    const hasMore = fetched.length > limit;
    const page = fetched.slice(0, limit);
    // The cursor advances over the FETCHED stream (not the
    // privacy-filtered one) so a filtered-out row never skips the
    // rows after it. nextCursor is null on the last page.
    const nextCursor = hasMore
      ? `${page[page.length - 1].last_activity_at}|${page[page.length - 1].id}`
      : null;
    // Private rooms are only visible to their members.
    return {
      rooms: page
        .filter((r) => !r.is_private || memberSet.has(r.id))
        .map((r) => ({ ...r, is_member: memberSet.has(r.id) })),
      nextCursor,
    };
  });

export const listDms = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: memberships, error: membershipsError } = await supabase
      .from("room_members")
      .select("room_id")
      .eq("user_id", userId);
    // Audit-6 B-L4: same silent-degradation as listRooms — a failed
    // memberships query returned an empty DM list. Fail loudly.
    if (membershipsError) throw dbErr(membershipsError, "Could not load your messages — please try again.");
    const ids = (memberships ?? []).map((m) => m.room_id);
    if (ids.length === 0) return [];
    // Audit-2 L36: select is_e2ee — the client DM rows used to
    // hardcode isE2EE: false, so an E2EE DM could never show its 🔒.
    // Best-effort like listRooms: if the column doesn't exist yet
    // (pre-SQL), fall back to selecting without it.
    const attempt = await supabase
      .from("rooms")
      .select("id, last_activity_at, is_dm, is_e2ee")
      .in("id", ids)
      .eq("is_dm", true)
      .order("last_activity_at", { ascending: false });
    let rooms = attempt.data;
    if (attempt.error) {
      if (String(attempt.error.message ?? "").includes("is_e2ee")) {
        const fallback = await supabase
          .from("rooms")
          .select("id, last_activity_at, is_dm")
          .in("id", ids)
          .eq("is_dm", true)
          .order("last_activity_at", { ascending: false });
        // Audit-7 B3: the fallback's own error was unchecked — a
        // failed fallback silently emptied the DM list too.
        if (fallback.error) throw dbErr(fallback.error, "Could not load your messages — please try again.");
        rooms = (fallback.data ?? []).map((r) => ({ ...r, is_e2ee: false })) as typeof rooms;
      } else {
        // Audit-7 B3: a NON-is_e2ee rooms error used to fall through
        // (rooms stayed null) and return an empty DM list — the B-L4
        // silent-degradation pattern, one query later than that fix
        // reached. Fail loudly like the memberships query above.
        throw dbErr(attempt.error, "Could not load your messages — please try again.");
      }
    }
    if (!rooms || rooms.length === 0) return [];
    const { data: others, error: othersError } = await supabase
      .from("room_members")
      .select("room_id, user_id")
      .in(
        "room_id",
        rooms.map((r) => r.id),
      )
      .neq("user_id", userId);
    // Audit-7 B3: an error here used to null EVERY partner (the DM
    // list rendered rows with no partner). Fail loudly.
    if (othersError) throw dbErr(othersError, "Could not load your messages — please try again.");
    const otherIds = Array.from(new Set((others ?? []).map((o) => o.user_id)));
    // H5: partner profiles go through the privacy filter (a partner who
    // marked their name/avatar private shows as "Someone" / no avatar).
    const pmap = await fetchPublicProfiles(supabase, otherIds, userId, "view");
    return rooms.map((r) => {
      const partner = (others ?? []).find((o) => o.room_id === r.id);
      return { ...r, partner: partner ? (pmap.get(partner.user_id) ?? null) : null };
    });
  });

/** Latest message preview per room (one RPC call; RLS enforced by the caller).
 * Audit-4 H2: the .max(100) cap is a PER-CALL guard — callers must
 * chunk via fetchAllThreadPreviews (src/lib/thread-previews.ts). Do
 * NOT raise the cap to "fix" a caller: an unbounded RPC argument
 * list is what the cap exists to prevent. */
export const getThreadPreviews = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomIds: z.array(z.string().uuid()).max(100) }).parse(d))
  .handler(async ({ data, context }) => {
    if (data.roomIds.length === 0) return [];
    const { data: rows, error } = await context.supabase.rpc("get_thread_previews", {
      p_room_ids: data.roomIds,
    });
    if (error) throw dbErr(error, "Could not load chat previews — please try again.");
    return (rows ?? []) as {
      room_id: string;
      user_id: string;
      body: string | null;
      type: string;
      created_at: string;
      display_name: string;
    }[];
  });

export const listUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        search: z.string().trim().max(100).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(10000).optional(),
      })
      .optional()
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Audit-3 A4-N24: server-side search + range pagination. The old
    // hard .limit(100) hid everyone past the first 100 from People
    // and the Add-member picker (which then filtered client-side).
    // The whole input object is optional — bare listUsers() still
    // returns the first 100, as before.
    // Audit-3 A8-N30 (documented, per the audit's own alternative):
    // listUsers keeps OFFSET pagination with a 100-row default cap
    // (max 100/page) instead of a cursor — the People list shows
    // the first 100 by name and server-side `search` narrows
    // discovery (the Add-member picker searches server-side), so
    // no caller silently truncates an unbounded set.
    const { search = "", limit = 100, offset = 0 } = data ?? {};
    // Escape LIKE wildcards so a search for "%" doesn't match everyone.
    const safeSearch = search.replace(/[%_\\]/g, "\\$&");
    // Discovery respects profile visibility: private profiles are hidden.
    // Best-effort until vibetalk-e2ee-visibility.sql adds is_public — if
    // the column doesn't exist yet, fall back to listing everyone.
    // H5: the returned rows then go through the privacy filter (a public
    // profile with a private name/avatar shows as "Someone" / no avatar).
    let ids: string[] = [];
    // Audit-2 C3: discovery reads the privacy-filtered view — the
    // profiles table itself is own-row-only now, so a table read here
    // would return nobody. Pre-§C3 (view missing) fall back to the
    // table reads below.
    let viewQuery = supabase
      .from("profiles_public")
      .select("id")
      .neq("id", userId)
      .eq("is_public", true);
    if (safeSearch) viewQuery = viewQuery.ilike("display_name", `%${safeSearch}%`);
    const viewRes = await viewQuery
      .order("display_name", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (!viewRes.error) {
      ids = (viewRes.data ?? []).map((r) => r.id);
    } else if (
      viewRes.error.code === "PGRST205" ||
      /does not exist/i.test(viewRes.error.message ?? "")
    ) {
      let tableQuery = supabase
        .from("profiles")
        .select("id")
        .neq("id", userId)
        .eq("is_public", true);
      if (safeSearch) tableQuery = tableQuery.ilike("display_name", `%${safeSearch}%`);
      const { data, error } = await tableQuery
        .order("display_name", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
      if (!error) {
        ids = (data ?? []).map((r) => r.id);
      } else {
        // Audit-2 H35: the unfiltered fallback runs ONLY on 42703
        // (is_public column missing — pre-SQL world, no privacy
        // setting exists to honor). ANY other error (transient RLS /
        // timeout / …) must NOT drop the visibility filter and list
        // private profiles — it throws instead.
        if ((error as { code?: string }).code !== "42703") throw dbErr(error, "Could not load people — please try again.");
        let fallbackQuery = supabase.from("profiles").select("id").neq("id", userId);
        if (safeSearch) fallbackQuery = fallbackQuery.ilike("display_name", `%${safeSearch}%`);
        const { data: fallback, error: fallbackError } = await fallbackQuery
          .order("display_name", { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        if (fallbackError) throw dbErr(fallbackError, "Could not load people — please try again.");
        ids = (fallback ?? []).map((r) => r.id);
      }
    } else {
      throw dbErr(viewRes.error, "Could not load people — please try again.");
    }
    const pmap = await fetchPublicProfiles(supabase, ids, userId, "view");
    return ids
      .map((id) => pmap.get(id))
      .filter((p): p is PublicProfileRow => !!p);
  });

export const getOrCreateDm = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ otherUserId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Audit-6 B-I1: function-level self-check — a DM with yourself
    // was rejected only implicitly by the get_or_create_dm RPC body
    // (unverifiable from code); the call path rejects self-calls in
    // code (assertCanCall), and now the DM path does too. No client
    // flow offers a self-DM (peer profiles, people, call overlay all
    // pass a partner id).
    if (data.otherUserId === userId) {
      throw new Error("You can't start a conversation with yourself.");
    }
    // Audit-3 A4-N5: per-user DM-creation throttle (unbounded
    // getOrCreateDm let one account mint DM rooms across many
    // targets). Generous for humans; fail CLOSED (audit-4 H7) —
    // if the §H4 check_rate_limit RPC is missing the fn throws
    // instead of letting creation through.
    await checkRateLimitKey(`create-dm:${context.userId}`, 20, 60);
    // Private-profile + existing-DM logic lives in the RPC itself (H9):
    // the RPC enforces "private profiles accept no new DMs" under its
    // advisory lock, so a direct supabase.rpc() call cannot bypass it.
    // Existing DMs keep working (the RPC returns them before the check).
    const { data: roomId, error } = await supabase.rpc("get_or_create_dm", {
      _other: data.otherUserId,
    });
    if (error) throw dbErr(error, "Could not open the conversation — please try again.");
    return { roomId: roomId as unknown as string };
  });

export const createRoom = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        name: z.string().trim().min(1).max(60),
        description: z.string().trim().max(280).optional(),
        isPrivate: z.boolean().default(false),
        // End-to-end encrypted room (text messages only, Milestone 1).
        isE2EE: z.boolean().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Audit-3 A4-N5: per-user room-creation throttle (unbounded
    // createRoom let one account mint unlimited rooms).
    await checkRateLimitKey(`create-room:${userId}`, 10, 60);
    // M105: room + creator membership in ONE RPC transaction — the old
    // two-insert path left an orphan room when the member insert failed.
    const { data: roomId, error: rpcError } = await supabase.rpc(
      "create_room_with_creator",
      {
        _name: data.name,
        _description: data.description ?? null,
        _is_private: data.isPrivate,
        _is_e2ee: data.isE2EE,
      },
    );
    if (!rpcError) {
      // The RPC always returns a uuid or raises — a null with no error
      // would mean a broken contract; never fall through to the
      // fallback (it would create a SECOND room).
      if (!roomId) throw new Error("Room creation failed — no room id returned.");
      return { id: roomId as string };
    }
    if (rpcError) {
      // Never silently create a plaintext room when encryption was asked for.
      if (data.isE2EE && String(rpcError.message ?? "").includes("is_e2ee")) {
        throw new Error(
          "Encrypted rooms need vibetalk-e2ee-visibility.sql run in Supabase first.",
        );
      }
      // RPC missing (this SQL section not run yet) → fall back to the
      // two-insert path with a compensating room delete, so room
      // creation keeps working pre-SQL. Any OTHER RPC error is real.
      const rpcMissing =
        (rpcError as { code?: string }).code === "PGRST202" ||
        String(rpcError.message ?? "").includes("create_room_with_creator");
      if (!rpcMissing) throw dbErr(rpcError, "Could not create the room — please try again.");
    }
    const { data: room, error } = await supabase
      .from("rooms")
      .insert({
        name: data.name,
        description: data.description ?? null,
        is_private: data.isPrivate,
        is_dm: false,
        created_by: userId,
        ...(data.isE2EE ? { is_e2ee: true } : {}),
      })
      .select("id")
      .single();
    if (error) {
      // Never silently create a plaintext room when encryption was asked for.
      if (data.isE2EE && String(error.message ?? "").includes("is_e2ee")) {
        throw new Error(
          "Encrypted rooms need vibetalk-e2ee-visibility.sql run in Supabase first.",
        );
      }
      throw dbErr(error, "Could not create the room — please try again.");
    }
    const { error: memberError } = await supabase
      .from("room_members")
      .insert({ room_id: room.id, user_id: userId });
    if (memberError) {
      // Compensating delete: don't leave an orphan room behind.
      // Audit-2 M69: the old code warned and moved on when the
      // rollback delete failed, leaving a memberless orphan room
      // (a private one is invisible to everyone and never cleaned).
      // Now: delete via supabaseAdmin (the room is empty — no
      // members, no messages — and was created by THIS call, so the
      // admin delete can only remove this call's own room; an RLS
      // delete can report "success" while deleting 0 rows if the
      // DELETE policy denies it), retry up to 3 times, then VERIFY
      // the row is gone. If it is still there, the failure is
      // SURFACED to the caller instead of swallowed — a silent
      // orphan is worse than a loud error.
      let rollbackOk = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error: rollbackError } = await supabaseAdmin
          .from("rooms")
          .delete()
          .eq("id", room.id);
        if (!rollbackError) {
          rollbackOk = true;
          break;
        }
        if (attempt === 2) {
          console.warn("[createRoom] rollback delete failed:", rollbackError.message);
        }
      }
      if (rollbackOk) {
        const { data: stillThere, error: verifyError } = await supabaseAdmin
          .from("rooms")
          .select("id")
          .eq("id", room.id)
          .maybeSingle();
        if (verifyError || stillThere) rollbackOk = false;
      }
      if (!rollbackOk) {
        throw new Error(
          "Room creation failed and the incomplete room could not be removed. Please try again.",
          { cause: memberError },
        );
      }
      throw dbErr(memberError, "Could not create the room — please try again.");
    }
    return room;
  });

export const joinRoom = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Audit-3 A4-N5: per-user join throttle (unbounded joinRoom let
    // one account hammer joins across rooms).
    await checkRateLimitKey(`join-room:${userId}`, 30, 60);
    // Audit-3 A4-N25: atomic join — the privacy check and the insert
    // happen in ONE statement inside the RPC, so a room flipped to
    // private between a read and an insert is no longer joinable.
    // A missing function (pre-SQL) falls back to the old
    // check-then-insert path (H16 pattern) — the race stays open
    // until the audit3 SQL has run.
    const { error: rpcError } = await supabase.rpc("join_public_room", {
      _room_id: data.roomId,
    });
    if (!rpcError) return { ok: true };
    if (rpcError.code === "P0001") throw new Error(rpcError.message);
    if (rpcError.code !== "PGRST202" && !/does not exist/i.test(rpcError.message ?? "")) {
      throw dbErr(rpcError, "Could not join the room — please try again.");
    }
    console.warn(
      "[joinRoom] join_public_room RPC missing — falling back to check-then-insert (race open until audit3 SQL runs).",
    );
    // Private rooms and DMs cannot be joined freely — membership is granted
    // by the creator via addRoomMember. Without this check, any
    // authenticated user could join any private room/DM by UUID.
    const { data: room, error: roomError } = await supabase
      .from("rooms")
      .select("is_private, is_dm")
      .eq("id", data.roomId)
      .maybeSingle();
    if (roomError) throw dbErr(roomError, "Could not join the room — please try again.");
    if (!room) throw new Error("Room not found.");
    if (room.is_private || room.is_dm) {
      throw new Error("This is a private conversation. Ask a member to add you.");
    }
    const { error } = await supabase
      .from("room_members")
      .insert({ room_id: data.roomId, user_id: userId })
      .select();
    if (error && error.code !== "23505") throw dbErr(error, "Could not join the room — please try again.");
    return { ok: true };
  });

const messageType = z.enum(["text", "image", "video", "audio", "file"]);

/**
 * Audit-3 A4-N6: bind an E2E1: envelope's wrapped-key set to the
 * room's CURRENT membership. The client wraps for the memberKeys
 * snapshot it fetched moments earlier; a member removed in between
 * still holds a wrapped key and could decrypt a message sent after
 * their removal (if they obtain the body via Realtime / a copy).
 * Rejects envelopes that wrap for ANY non-member. Missing members
 * (joined after the key fetch) are NOT rejected — the message just
 * won't decrypt for them ("Sent before you joined"), same as today;
 * failing the send on that would turn a cosmetic gap into a broken
 * send. Residual: a removal landing between this check and the
 * insert/update (milliseconds) still slips through — the audit's
 * live test (remove, then send) is closed; fully closing the window
 * needs a DB trigger / serializable txn. A full 1000-row page means
 * the member set may be truncated — skip rather than falsely reject
 * a legitimate recipient.
 */
function assertEnvelopeRecipientsAreMembers(memberUserIds: string[], body: string): void {
  const recipients = getE2EEnvelopeRecipients(body);
  if (recipients.length === 0) return;
  if (memberUserIds.length >= 1000) {
    console.warn("[A4-N6] member page truncated — skipping envelope-recipient check");
    return;
  }
  const memberIds = new Set(memberUserIds);
  if (recipients.some((r) => !memberIds.has(r))) {
    throw new Error(
      "This message was encrypted for someone who is no longer in this conversation. Please try again.",
    );
  }
}

// Audit-4 L12: allowlist lives in @/lib/attachment-mimes.ts —
// shared with the client upload gate (upload.ts). Edit only there.

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        roomId: z.string().uuid(),
        // M106: shared cap with the client's pre-send envelope check
        // (message-limits.ts) — the two must never drift apart.
        // Encrypted bodies carry ciphertext + per-recipient wrapped
        // keys on top of the 4000-char plaintext limit.
        body: z
          .string()
          .trim()
          .max(MESSAGE_BODY_MAX_LENGTH, "This message is too long — shorten it and try again.")
          .optional(),
        type: messageType.default("text"),
        // Audit-3 A4-N4: client-side idempotency key — one per LOGICAL
        // message (outbox entry id, or a fresh UUID per composer
        // send). The same key is reused by the retry path, so a lost
        // response after a successful insert dedupes instead of
        // duplicating. Optional: sends without it behave as before.
        clientId: z.string().uuid().optional(),
        attachmentPath: z.string().max(500).optional(),
        attachmentMeta: z
          .object({
            name: z.string().max(255).optional(),
            size: z
              .number()
              .int()
              .nonnegative()
              .max(1024 * 1024 * 1024)
              .optional(),
            mime: z.string().max(120).optional(),
          })
          .optional(),
      })
      .refine((v) => (v.body && v.body.length > 0) || !!v.attachmentPath, {
        message: "Message must have body or attachment",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // NO send rate limit — owner decision 2026-10-20 (audit-6
    // B-M1 disposition): "Msg per rate limit nahi lagani." A
    // messaging app must not throttle its core action; the former
    // per-room 60/min cap (audit-3 A4-N5) is removed entirely.
    // Abuse control rests on membership + RLS + GoTrue throttles.
    // Membership check (H6): only room members may post. Without it,
    // any authenticated user could post to any public room without
    // joining — the RLS insert policy's WITH CHECK (can_view_room) is
    // true for every public room. Siblings (toggleReaction, postCallMessage,
    // markRoomRead, getReadReceipts) all check membership explicitly.
    // Fail fast, before any other work: a non-member must Join first
    // (MembersDialog) — the composer error toast tells them so.
    const { data: membership, error: memError } = await supabase
      .from("room_members")
      .select("room_id")
      .eq("room_id", data.roomId)
      .eq("user_id", userId)
      .maybeSingle();
    if (memError) throw dbErr(memError, "Could not send your message — please try again.");
    if (!membership) throw new Error("You are not a member of this conversation.");
    // E2EE enforcement (server-side, not just client-side): a room marked
    // is_e2ee must never store plaintext. Text must arrive as an E2E1:
    // envelope; attachments/voice are not encrypted yet, so they are
    // rejected outright instead of silently stored in plaintext.
    const { data: roomRow, error: roomError } = await supabase
      .from("rooms")
      .select("is_e2ee")
      .eq("id", data.roomId)
      .maybeSingle();
    // Audit-2 M68: a room-read error used to be treated as "room not
    // found" -> roomIsE2EE = false -> plaintext stored in an E2EE
    // room (fail open). Fail CLOSED on every error EXCEPT 42703: a
    // missing is_e2ee column (pre-SQL) cannot mark any room E2EE,
    // so it is the one safe case (the H16 missing-column tolerance).
    // A missing ROW with no error (room deleted mid-flight / RLS
    // inconsistency) also fails closed — the E2EE status cannot be
    // established, so the send must not proceed.
    if (roomError && (roomError as { code?: string }).code !== "42703") throw dbErr(roomError, "Could not send your message — please try again.");
    if (!roomError && !roomRow) throw new Error("Could not verify this conversation.");
    const roomIsE2EE = (roomRow as { is_e2ee?: boolean } | null)?.is_e2ee === true;
    if (roomIsE2EE) {
      if (data.attachmentPath) {
        throw new Error("Attachments aren't encrypted yet in encrypted rooms.");
      }
      // H10: require the E2E1: envelope for ALL message types, not just
      // "text". A non-text type (image/video/audio/file) with a plaintext
      // body and no attachment slipped past the old gate (which only
      // checked type === "text") and stored plaintext in an E2EE room.
      // The C1 RLS policy also requires E2E1: for every type; this gate
      // rejects with a clear error before the cryptic RLS error.
      if (!(data.body ?? "").startsWith("E2E1:")) {
        throw new Error("This room is end-to-end encrypted — send encrypted text only.");
      }
      // Audit-2 H31: prefix alone is not proof — validate the envelope
      // SHAPE (parseable JSON, valid P-256 sender key, well-formed
      // wrapped keys, sender's own entry present). Garbage E2E1: blobs
      // used to poison rooms (every client failed decrypting them).
      if (!validateE2EEnvelope(data.body, userId)) {
        throw new Error("This room is end-to-end encrypted — the message is not a valid encrypted envelope.");
      }
      // Audit-5 B3-HIGH: the WRITE path accepts v2 envelopes ONLY.
      // A v1 envelope (no `v`, or v: 1) has NO AAD, so its `r` stamp
      // is plain JSON anyone can forge — the M4 room check below
      // would pass a hand-stamped v1 while decryptBody's legacy path
      // opens it in ANY room (cross-room replay + re-posted pre-H31
      // history, attributed to the re-poster). encryptForRoom has
      // stamped v: 2 since H31, so no legitimate client mints v1;
      // v1 stays READABLE via decryptBody's legacy path so pre-H31
      // history still opens.
      if (getE2EEnvelopeVersion(data.body) !== 2) {
        throw new Error("This encrypted message uses an outdated format that can't be posted — please reload the app and try again.");
      }
      // Audit-4 M4: the envelope carries the room it was encrypted
      // for (WireEnvelope.r). A verbatim replay from another room
      // passes the shape + recipient checks but can never decrypt
      // there (the AAD binds the ciphertext to the original room) —
      // reject it instead of storing an undecryptable message. A v2
      // envelope always carries `r` (encryptForRoom stamps it), so a
      // missing stamp is malformed here, not legacy tolerance.
      const envRoom = getE2EEnvelopeRoom(data.body);
      if (envRoom !== data.roomId) {
        throw new Error("This encrypted message was created for a different conversation — it can't be posted here.");
      }
      // Audit-3 A4-N6: the envelope must not wrap for non-members
      // (member removed after the sender's key fetch).
      const { data: e2eeMembers, error: e2eeMemberError } = await supabase
        .from("room_members")
        .select("user_id")
        .eq("room_id", data.roomId);
      if (e2eeMemberError) throw dbErr(e2eeMemberError, "Could not send your message — please try again.");
      assertEnvelopeRecipientsAreMembers(
        (e2eeMembers ?? []).map((r) => r.user_id),
        data.body ?? "",
      );
    } else if ((data.body ?? "").startsWith("E2E1:")) {
      // Audit-3 A4-N32: a fake E2E1: body in a non-E2EE room would
      // render as "🔒 Encrypted message" in previews without ever
      // being encrypted. The prefix is reserved for real envelopes.
      throw new Error("Messages can't start with \"E2E1:\" — that prefix is reserved for encrypted messages.");
    }
    if (data.attachmentPath) {
      const expectedPrefix = `${userId}/${data.roomId}/`;
      if (!data.attachmentPath.startsWith(expectedPrefix)) {
        throw new Error("This attachment does not belong to you or this conversation.");
      }
      // Audit-7 B2: the prefix check pins segments 0/1, but a path
      // like "<uid>/<room>/../../x" was stored verbatim. The ".."
      // segments are inert inside a storage key today, yet the
      // stored string is later used for signed URLs and deletes,
      // where normalization could reinterpret it. The client only
      // ever mints "<uid>/<room>/<uuid>-<name>" — reject traversal
      // segments outright (same error as the ownership failure, so
      // no new oracle).
      if (data.attachmentPath.split("/").includes("..")) {
        throw new Error("This attachment does not belong to you or this conversation.");
      }
      // Audit-3 A4-N11: one attachment file must not be attached to
      // many messages — deleting one message would delete the shared
      // file and break the others. The client always uploads a fresh
      // path per send, so a re-used path is a direct-call anomaly.
      const { data: existingRef, error: existingRefError } = await supabaseAdmin
        .from("messages")
        .select("id")
        .eq("attachment_url", data.attachmentPath)
        .maybeSingle();
      // Audit-7 B1: the error half used to be discarded — with 2+
      // existing references, maybeSingle resolves PGRST116 with
      // data: null, so the gate read "unused" and every duplicate
      // made it bind even less. PGRST116 ("more than one row") IS
      // "already used". Any other lookup error fails closed — an
      // unverifiable gate must not wave the send through. (The
      // simultaneous-send race window is closed by the partial
      // unique index on messages.attachment_url — SQL side,
      // vibetalk-audit7-fixes.sql.)
      if (existingRefError) {
        if ((existingRefError as { code?: string }).code === "PGRST116") {
          throw new Error("This attachment is already used by another message.");
        }
        throw dbErr(existingRefError, "Could not verify the attachment — please try again.");
      }
      if (existingRef) {
        throw new Error("This attachment is already used by another message.");
      }
      // M6: authoritative size from the storage Info endpoint — NEVER
      // fall back to the caller-supplied attachmentMeta.size for a
      // security check. The old code used list() and fell back to the
      // caller's claimed size when list() returned no metadata.size,
      // so the equality check compared the claim to itself (always
      // passed) and the 1 GB cap was bypassable. If the authoritative
      // size is unavailable, fail closed — the upload can't be verified.
      const { data: fileInfo, error: infoError } = await supabase.storage
        .from("chat-attachments")
        .info(data.attachmentPath);
      if (infoError || !fileInfo) {
        throw new Error("The upload could not be verified. Please upload it again.");
      }
      const actualSize = Number(fileInfo.size);
      if (!Number.isFinite(actualSize) || actualSize < 0) {
        throw new Error("The upload could not be verified. Please upload it again.");
      }
      if (actualSize > 1024 * 1024 * 1024) {
        // Audit-3 A8-N17: storage deletes go through the admin
        // client (the client-side DELETE policy is dropped) — the
        // file is verified oversize and unreferenced here.
        // Audit-4 L65: CHECK the remove result — the old code
        // discarded it, so a failed remove left the >1GB file
        // orphaned (quota leak, invisible, no retry). The send is
        // rejected either way; the warn names the path so a later
        // sweep can release it (same pattern as deleteMessage's
        // orphan warning).
        const { error: removeError } = await supabaseAdmin.storage
          .from("chat-attachments")
          .remove([data.attachmentPath]);
        if (removeError) {
          console.warn(
            `[sendMessage] oversize file ${data.attachmentPath} could not be released (orphaned):`,
            removeError,
          );
        }
        throw new Error("This file exceeds the 1 GB attachment limit.");
      }
      if (data.attachmentMeta?.size !== undefined && actualSize !== data.attachmentMeta.size) {
        throw new Error("The uploaded file size did not match. Please upload it again.");
      }
      // H11: validate the MIME + that type matches its family.
      // Audit-3 A4-N10: an empty/absent claimed MIME used to skip the
      // allowlist entirely. Now the STORED content-type (Info
      // endpoint; uploadAttachment always sets it, falling back to
      // application/octet-stream for unknown files) is enforced too,
      // and a claimed-vs-stored mismatch is a lie — reject it.
      // application/octet-stream is the generic fallback the client
      // legitimately produces for unknown file types; it is served
      // as a download-only attachment (signAttachment), so it is
      // allowed even though it is not in the allowlist.
      const claimedMime = data.attachmentMeta?.mime;
      const storedMime =
        typeof fileInfo.contentType === "string" ? fileInfo.contentType : undefined;
      if (claimedMime && storedMime && claimedMime !== storedMime) {
        throw new Error("Attachment type does not match the uploaded file.");
      }
      const effectiveMime = claimedMime || storedMime;
      if (!effectiveMime) {
        throw new Error("This file type could not be verified.");
      }
      if (effectiveMime !== "application/octet-stream" && !ALLOWED_ATTACHMENT_MIMES.has(effectiveMime)) {
        throw new Error("This file type is not allowed.");
      }
      const expectedType = effectiveMime.startsWith("image/")
        ? "image"
        : effectiveMime.startsWith("video/")
          ? "video"
          : effectiveMime.startsWith("audio/")
            ? "audio"
            : "file";
      if (data.type !== expectedType) {
        throw new Error("Attachment type does not match its content type.");
      }
    }
    // Audit-6 B-L2: a non-text message MUST carry its attachment.
    // Every attachment gate above runs only when attachmentPath is
    // present, so a direct call with type "image" and no path
    // stored a phantom row whose preview lies ("📷 sent a photo").
    // Same class: a text message with neither body nor attachment
    // renders as an empty bubble. (The zod schema trims body, so a
    // whitespace-only body arrives as "".) Legit clients always
    // upload first (attachment sends) and block empty text in the
    // composer — only direct calls hit this.
    if (data.type !== "text" && !data.attachmentPath) {
      throw new Error("This message is missing its attachment — please try again.");
    }
    if (data.type === "text" && !data.attachmentPath && !(data.body ?? "")) {
      throw new Error("Message can't be empty.");
    }
    // M14: snapshot the recipient count at send time so ✓✓ doesn't
    // retroactively flip when a member later leaves (the live
    // member-count denominator would drop and old messages would
    // wrongly become "seen by all"). Old messages without a snapshot
    // fall back to the live member count in isSeenByAll.
    const { count: recipientCount } = await supabase
      .from("room_members")
      .select("user_id", { count: "exact", head: true })
      .eq("room_id", data.roomId);
    const insertPayload = {
      room_id: data.roomId,
      user_id: userId,
      body: data.body ?? null,
      type: data.type,
      attachment_url: data.attachmentPath ?? null,
      attachment_meta: data.attachmentMeta ?? null,
      recipient_count: recipientCount ?? null,
      // Audit-3 A4-N4: idempotency key (unique index, §A4-N4 SQL).
      client_id: data.clientId ?? null,
    };
    let { error } = await supabase.from("messages").insert(insertPayload);
    // Column missing (SQL not run yet) → retry without the missing
    // column instead of failing the send (H16 pattern for tolerating
    // unrun SQL). The missing-column check requires "does not exist":
    // a 23505 duplicate-key message ALSO names client_id (via the
    // constraint name) and must NEVER trigger a key-less retry —
    // that would insert the duplicate this fix exists to prevent.
    const missingColumn = (col: string) =>
      !!error &&
      new RegExp(`${col}.*does not exist|does not exist.*${col}`, "i").test(
        error.message ?? "",
      );
    if (error && missingColumn("recipient_count")) {
      const { recipient_count: _ignored, ...payloadWithoutSnapshot } = insertPayload;
      ({ error } = await supabase.from("messages").insert(payloadWithoutSnapshot));
      if (error && missingColumn("client_id")) {
        const { client_id: _ignored2, ...payloadWithoutBoth } = payloadWithoutSnapshot;
        ({ error } = await supabase.from("messages").insert(payloadWithoutBoth));
      }
    } else if (error && missingColumn("client_id")) {
      const { client_id: _ignored, ...payloadWithoutClientId } = insertPayload;
      ({ error } = await supabase.from("messages").insert(payloadWithoutClientId));
      if (error && missingColumn("recipient_count")) {
        const { recipient_count: _ignored2, ...payloadWithoutBoth } = payloadWithoutClientId;
        ({ error } = await supabase.from("messages").insert(payloadWithoutBoth));
      }
    }
    if (error) {
      // Audit-3 A4-N4: dedupe — a 23505 on client_id means THIS
      // logical message already inserted (the first attempt's
      // response was lost). Return success WITHOUT re-running side
      // effects: the first attempt already sent the push. Scoped to
      // the caller's own rows; any other outcome throws. (The M2
      // call_id index can never fire here — sendMessage never sets
      // call_id — so a null select below just rethrows.)
      const pgCode = (error as { code?: string }).code;
      const isDuplicateKey =
        pgCode === "23505" || /duplicate key/i.test(error.message ?? "");
      if (isDuplicateKey && data.clientId) {
        const { data: existing } = await supabase
          .from("messages")
          .select("id")
          .eq("client_id", data.clientId)
          .eq("user_id", userId)
          .maybeSingle();
        if (existing) return { ok: true, duplicate: true };
      }
      throw dbErr(error, "Could not send your message — please try again.");
    }
    // Best-effort Web Push to members whose app is backgrounded/closed.
    // Awaited so the Worker doesn't drop it; failures never break sending.
    // The server must never leak encrypted content into a notification.
    // M7: derive the preview from TYPE, never from body (except text).
    // A video/audio message with a body used to leak that body into the
    // push payload. Mirrors previewForMessage's type mapping.
    const preview =
      (data.body ?? "").startsWith("E2E1:")
        ? "🔒 Encrypted message"
        : data.type === "image"
          ? "📷 sent a photo"
          : data.type === "video"
            ? "🎥 sent a video"
            : data.type === "audio"
              ? "🎤 sent a voice message"
              : data.type === "file"
                ? "📎 sent a file"
                : (data.body ?? "").slice(0, 120);
    await notifyNewMessage(data.roomId, userId, preview);
    // Audit-5 MEDIUM-4: opportunistic orphan sweep (throttled,
    // best-effort — see sweepOrphanAttachments).
    await sweepOrphanAttachments();
    return { ok: true };
  });

export const signAttachment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ path: z.string().min(1).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    // Only someone who can view the owning conversation may mint a signed URL.
    // Attachment paths are <uploaderUserId>/<roomId>/<fileName>.
    const segments = data.path.split("/");
    const roomId = segments.length >= 3 ? segments[1] : null;
    if (!roomId) throw new Error("Invalid attachment path.");
    const { data: canView, error: viewError } = await context.supabase.rpc("can_view_room", {
      _room_id: roomId,
      _user_id: context.userId,
    });
    if (viewError) throw dbErr(viewError, "Could not open the attachment — please try again.");
    if (!canView) throw new Error("You do not have access to this attachment.");
    // M102: the room check alone let any room member mint a signed URL
    // for ANY object whose second segment was that room (the uploader
    // segment was never verified). Require the object to actually
    // belong to a message in this room — this subsumes the uploader
    // check, since sendMessage only stores paths of the form
    // <senderId>/<roomId>/… as attachment_url. A deleted message's
    // file is denied too (its row is gone) — correct, nothing renders
    // it anymore.
    const { data: owners, error: ownerError } = await context.supabase
      .from("messages")
      .select("id")
      .eq("room_id", roomId)
      .eq("attachment_url", data.path)
      .limit(1);
    if (ownerError) throw dbErr(ownerError, "Could not open the attachment — please try again.");
    if (!owners || owners.length === 0) {
      throw new Error("This attachment is not part of this conversation.");
    }
    // H11: force Content-Disposition: attachment. A signed URL opened in
    // a new tab downloads instead of rendering — an HTML/SVG file that
    // slipped through can never execute in the browser. Subresource
    // loads (<img>/<video>/<audio>) ignore the disposition and still
    // render inline.
    const { data: signed, error } = await context.supabase.storage
      .from("chat-attachments")
      .createSignedUrl(data.path, 60 * 60, { download: true });
    if (error) throw dbErr(error, "Could not open the attachment — please try again.");
    return { url: signed.signedUrl };
  });

export const deleteMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ messageId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Audit-6 B-L1: deleteMessage was the one destructive message
    // op with NO limiter (30 rapid deletes executed with 0 limiter
    // ops — the same Realtime churn that justified editMessage's
    // cap). 60/10min mirrors editMessage; a human deleting their
    // own messages never approaches it. (This is a DELETE limit,
    // not a send limit — sends stay unthrottled per the owner's
    // 2026-10-20 decision.)
    await checkRateLimitKey(`delete-message:${userId}`, 60, 600);
    // Ownership check in the function itself (defense-in-depth — the RLS
    // policy also enforces own + <5 min, but the fn must not rely on RLS
    // alone to know WHOSE message this is).
    const { data: message, error: readError } = await supabase
      .from("messages")
      .select("user_id, room_id, attachment_url")
      .eq("id", data.messageId)
      .single();
    if (readError) throw dbErr(readError, "Could not delete the message — please try again.");
    if (message.user_id !== userId) {
      throw new Error("You can only delete your own messages.");
    }
    // Audit-3 A4-N28: ex-members must not edit/delete their messages
    // after removal (the 5-minute RLS window alone does not check
    // current membership).
    await assertOwnMembership(message.room_id, userId);
    // RLS permits deletes only within 5 minutes and returns 0 rows (no
    // error) when the window expired — check the returned row so we don't
    // claim success when nothing was deleted (the message would silently
    // reappear after the client invalidates its list).
    const { data: deleted, error } = await supabase
      .from("messages")
      .delete()
      .eq("id", data.messageId)
      .select("id");
    if (error) throw dbErr(error, "Could not delete the message — please try again.");
    if (!deleted || deleted.length === 0) {
      throw new Error("Delete window expired — messages can only be deleted within 5 minutes.");
    }
    // M1: post-commit, NEVER throw. The message row is already gone — a
    // storage-cleanup failure must not surface as a delete error (the
    // client would toast an error for a delete that succeeded, and the
    // attachment is orphaned either way). Best-effort cleanup; the
    // caller learns via attachmentCleaned whether the file was released.
    let attachmentCleaned = true;
    if (message?.attachment_url) {
      // Audit-3 A4-N11: only release the file when no OTHER message
      // still references it (a shared path — only reachable via a
      // direct call since sendMessage now rejects re-use — must not
      // break the surviving message).
      const { data: stillReferenced } = await supabaseAdmin
        .from("messages")
        .select("id")
        .eq("attachment_url", message.attachment_url)
        .maybeSingle();
      if (stillReferenced) {
        // Intentionally kept — not an orphan, not a failure.
        attachmentCleaned = true;
      } else {
        try {
          // Audit-3 A8-N17: storage deletes go through the admin
          // client (the client-side DELETE policy is dropped) —
          // the A4-N11 check above already proved no other message
          // references this file.
          const { error: storageError } = await supabaseAdmin.storage
            .from("chat-attachments")
            .remove([message.attachment_url]);
          if (storageError) attachmentCleaned = false;
        } catch {
          attachmentCleaned = false;
        }
      }
      if (!attachmentCleaned) {
        console.warn(
          `[deleteMessage] message ${data.messageId} deleted but attachment ${message.attachment_url} could not be released (orphaned).`,
        );
      }
    }
    return { ok: true, attachmentCleaned };
  });

/**
 * Audit-3 A8-N17: the ONLY client-reachable storage delete. The
 * storage DELETE policy ("Owners can delete own chat attachments")
 * is dropped — an owner could otherwise delete their own file under
 * a LIVE message, breaking the attachment for every member. This
 * fn deletes only the caller's OWN files (`<userId>/…` prefix) that
 * NO message references (A4-N11 check) — a live-message file is
 * refused — and that are NOT the caller's live avatar
 * (audit-4 L61 check): a live-avatar file is refused too, so
 * `profiles.avatar_url` can never be orphaned by this fn.
 * Client cleanups (failed-send, failed avatar save) call
 * this; all other deletes already use supabaseAdmin directly.
 */
export const deleteOwnAttachmentFile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ path: z.string().min(1).max(1000) }).parse(d))
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    if (!data.path.startsWith(`${userId}/`)) {
      throw new Error("This file does not belong to you.");
    }
    const { data: referenced } = await supabaseAdmin
      .from("messages")
      .select("id")
      .eq("attachment_url", data.path)
      .maybeSingle();
    if (referenced) {
      throw new Error("This file is still referenced by a message.");
    }
    // Audit-4 L61: also refuse the caller's LIVE avatar — the
    // messages check alone let a caller pass their own
    // `<userId>/profile/<file>` avatar path (not in messages) and
    // delete it while profiles.avatar_url still pointed at it,
    // leaving a broken picture. Self-harm only (the userId/
    // prefix is enforced above), but the orphaned avatar_url
    // rendered a broken avatar. The cleanup callers pass a
    // freshly uploaded path on save failure, never the live one,
    // so this check cannot block them.
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("avatar_url")
      .eq("id", userId)
      .maybeSingle();
    if (profile?.avatar_url === data.path) {
      throw new Error("This file is your current profile picture.");
    }
    const { error } = await supabaseAdmin.storage
      .from("chat-attachments")
      .remove([data.path]);
    if (error) throw dbErr(error, "Could not delete the file — please try again.");
    return { ok: true };
  });

export const toggleReaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        messageId: z.string().uuid(),
        emoji: z.enum(["👍", "❤️", "😂", "🎉", "😮", "😢", "🔥", "🙏"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Audit-3 A4-N5: per-user reaction throttle (unbounded
    // toggleReaction let one account hammer reactions). Per-user
    // (not per-room): the room is only known after the message read
    // below, and 60/min across rooms is generous for a human.
    await checkRateLimitKey(`react:${userId}`, 60, 60);
    // Authorization: only members of the message's room may react.
    // (The RLS policy alone only checks auth.uid() = user_id.)
    const { data: msg, error: msgError } = await supabase
      .from("messages")
      .select("room_id")
      .eq("id", data.messageId)
      .maybeSingle();
    if (msgError) throw dbErr(msgError, "Could not update the reaction — please try again.");
    if (!msg) throw new Error("Message not found.");
    const { data: membership, error: memError } = await supabase
      .from("room_members")
      .select("room_id")
      .eq("room_id", msg.room_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (memError) throw dbErr(memError, "Could not update the reaction — please try again.");
    if (!membership) throw new Error("You are not a member of this conversation.");
    // M9: no read-then-write. Delete by the unique key first, then
    // upsert with ON CONFLICT — return on affected rows. Two concurrent
    // toggles used to both read "no row" → both inserted → one hit the
    // UNIQUE(message_id, user_id, emoji) constraint and surfaced an
    // error. The delete count (exact) tells us whether a row was
    // removed; the upsert's ON CONFLICT DO NOTHING absorbs the
    // concurrent-insert case with no error and no duplicate row.
    const { count, error: deleteError } = await supabase
      .from("message_reactions")
      .delete({ count: "exact" })
      .eq("message_id", data.messageId)
      .eq("user_id", userId)
      .eq("emoji", data.emoji);
    if (deleteError) throw dbErr(deleteError, "Could not update the reaction — please try again.");
    if ((count ?? 0) > 0) {
      return { toggled: "off" as const };
    }
    const { error: insertError } = await supabase.from("message_reactions").upsert(
      {
        message_id: data.messageId,
        user_id: userId,
        emoji: data.emoji,
      },
      { onConflict: "message_id,user_id,emoji", ignoreDuplicates: true },
    );
    if (insertError) throw dbErr(insertError, "Could not update the reaction — please try again.");
    return { toggled: "on" as const };
  });

export type RoomMemberRow = {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  is_online: boolean;
  last_seen_at: string | null;
  is_creator: boolean;
  joined_at: string;
};

/** Only the room creator can manage members — there are no admins. */
async function assertCanManageMembers(roomId: string, callerId: string) {
  const { data: room } = await supabaseAdmin
    .from("rooms")
    .select("created_by")
    .eq("id", roomId)
    .single();
  if (!room) throw new Error("Room not found.");
  // H8: creator power requires CURRENT membership. A departed creator
  // (left the room) keeps no power from outside.
  const { data: callerMembership } = await supabaseAdmin
    .from("room_members")
    .select("room_id")
    .eq("room_id", roomId)
    .eq("user_id", callerId)
    .maybeSingle();
  if (!callerMembership) {
    throw new Error("You are not a member of this conversation.");
  }
  if (room.created_by === callerId) return;
  // Creator-less room: the creator left without a transfer, or the
  // creator's account was deleted (created_by went NULL). The oldest
  // remaining member acts as creator so the room stays manageable.
  // If a live creator exists and it is not the caller, deny.
  if (room.created_by) {
    const { data: creatorMembership } = await supabaseAdmin
      .from("room_members")
      .select("room_id")
      .eq("room_id", roomId)
      .eq("user_id", room.created_by)
      .maybeSingle();
    if (creatorMembership) {
      throw new Error("Only the room creator can manage members.");
    }
  }
  const { data: oldest } = await supabaseAdmin
    .from("room_members")
    .select("user_id")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (oldest?.user_id !== callerId) {
    throw new Error("Only the room creator can manage members.");
  }
}

/**
 * Creator handoff on leave (H8): when the room's creator leaves, hand
 * created_by to the oldest remaining member so the room stays
 * manageable (and the creator badge stays truthful). Called BEFORE the
 * leaver's membership row is deleted. If nobody remains, created_by
 * goes NULL (the room is then deleted by the caller's empty-room
 * cleanup, or stays creator-less-but-manageable via the
 * oldest-member fallback in assertCanManageMembers).
 */
async function transferCreatorOnLeave(roomId: string, leaverId: string) {
  const { data: room } = await supabaseAdmin
    .from("rooms")
    .select("created_by")
    .eq("id", roomId)
    .maybeSingle();
  if (room?.created_by !== leaverId) return;
  const { data: next } = await supabaseAdmin
    .from("room_members")
    .select("user_id")
    .eq("room_id", roomId)
    .neq("user_id", leaverId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  // Audit-4 L15: capture the update result — the old code discarded
  // it INCLUDING errors, so a transient DB failure silently left
  // created_by pointing at the leaver (oldest-member fallback kept
  // the room manageable, but the transfer itself had failed).
  const { error } = await supabaseAdmin
    .from("rooms")
    .update({ created_by: next?.user_id ?? null })
    .eq("id", roomId);
  if (error) throw dbErr(error, "Could not update the room — please try again.");
}

/**
 * DM membership is immutable via add/remove (H7). A DM is a 1:1 room:
 * adding a third person (or removing the partner) would leave is_dm=true
 * with the wrong member count, breaking the DM header, call buttons,
 * and isSeenByAll invariants. Self-leave goes through leaveChat, not here.
 */
async function assertNotDm(roomId: string) {
  const { data: room } = await supabaseAdmin
    .from("rooms")
    .select("is_dm")
    .eq("id", roomId)
    .single();
  if ((room as { is_dm?: boolean } | null)?.is_dm === true) {
    throw new Error("Direct messages cannot have members added or removed.");
  }
}

export const listRoomMembers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: canView } = await context.supabase.rpc("can_view_room", {
      _room_id: data.roomId,
      _user_id: context.userId,
    });
    if (!canView) throw new Error("You do not have access to this room.");
    const { data: members, error } = await supabaseAdmin
      .from("room_members")
      .select("user_id, joined_at")
      .eq("room_id", data.roomId);
    if (error) throw dbErr(error, "Could not load members — please try again.");
    const ids = (members ?? []).map((m) => m.user_id);
    if (ids.length === 0) return [] as RoomMemberRow[];
    // H5: member profiles go through the privacy filter (a member who
    // marked their name/avatar private shows as "Someone" / no avatar).
    const [profileMap, { data: room }] = await Promise.all([
      fetchPublicProfiles(supabaseAdmin, ids, context.userId, "table"),
      supabaseAdmin.from("rooms").select("created_by").eq("id", data.roomId).single(),
    ]);
    const joinedMap = new Map((members ?? []).map((m) => [m.user_id, m.joined_at]));
    return ids.map((id): RoomMemberRow => ({
      user_id: id,
      display_name: profileMap.get(id)?.display_name ?? "Unknown",
      avatar_url: profileMap.get(id)?.avatar_url ?? null,
      is_online: isUserOnline(profileMap.get(id)?.last_seen_at ?? null),
      last_seen_at: profileMap.get(id)?.last_seen_at ?? null,
      is_creator: room?.created_by === id,
      joined_at: joinedMap.get(id) ?? "",
    }));
  });

export const addRoomMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ roomId: z.string().uuid(), userId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertNotDm(data.roomId);
    await assertCanManageMembers(data.roomId, context.userId);
    const { error } = await supabaseAdmin
      .from("room_members")
      .insert({ room_id: data.roomId, user_id: data.userId });
    if (error && (error as { code?: string }).code !== "23505") throw dbErr(error, "Could not add the member — please try again.");
    return { ok: true };
  });

export const removeRoomMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ roomId: z.string().uuid(), userId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertNotDm(data.roomId);
    // Members may leave on their own; otherwise creator only.
    if (data.userId !== context.userId) {
      await assertCanManageMembers(data.roomId, context.userId);
    } else {
      // Audit-3 A4-N2: the self path had NO membership check —
      // transferCreatorOnLeave is a no-op for non-creators and the
      // delete below removes 0 rows silently, so a non-member got a
      // false {ok:true} AND the M65 cleanup below deleted ANY
      // 0-member room (audit-2 L80). Same assertOwnMembership gate
      // as leaveChat, BEFORE any mutation (transferCreatorOnLeave
      // would hand off creatorship for a non-member creator).
      await assertOwnMembership(data.roomId, context.userId);
      // H8: a creator leaving hands created_by to the oldest remaining
      // member (before the leaver's row is deleted).
      await transferCreatorOnLeave(data.roomId, context.userId);
    }
    const { data: deleted, error } = await supabaseAdmin
      .from("room_members")
      .delete()
      .eq("room_id", data.roomId)
      .eq("user_id", data.userId)
      .select("user_id");
    if (error) throw dbErr(error, "Could not remove the member — please try again.");
    // Audit-4 L15: verify a row was actually deleted — the target
    // membership vanishing between the assert and the delete yields
    // 0 rows with no error.
    if (!deleted || deleted.length === 0) throw new Error("Not a member of this chat.");
    // Audit-2 M65: a removal that empties the room must clean it up
    // (same as leaveChat's last-member path) — otherwise a 0-member
    // room row + its messages/attachments orphan forever. A public
    // empty room would re-appear in listRooms and accept re-joins; a
    // private empty room is invisible to everyone (member filter) and
    // never cleaned. The creator-removes-last-member-then-self
    // sequence ends here: transferCreatorOnLeave found no successor
    // (created_by = null), this delete drops the count to 0, and the
    // room is deleted below.
    // Audit-3 A4-N1: NEVER delete on an unknown count — a failed
    // count query returns count: null, and (count ?? 0) === 0 would
    // have deleted a room that still has members (plus history +
    // attachments). Throw instead: the member removal above stands,
    // but the room survives and the next leave/remove retries cleanup.
    const { count, error: countError } = await supabaseAdmin
      .from("room_members")
      .select("user_id", { count: "exact", head: true })
      .eq("room_id", data.roomId);
    if (countError) throw dbErr(countError, "Could not remove the member — please try again.");
    if ((count ?? 0) === 0) {
      const paths = await listRoomAttachmentPaths(data.roomId).catch(() => [] as string[]);
      // Audit-3 A8-N13: capture the room-delete error and throw —
      // a bare await used to swallow a transient DB failure and
      // return {ok:true} with a 0-member orphan room. The member
      // removal above stands; the room survives and the next
      // leave/remove retries cleanup (same as A4-N1's count-error).
      const { error: deleteError } = await supabaseAdmin.from("rooms").delete().eq("id", data.roomId);
      if (deleteError) throw dbErr(deleteError, "Could not remove the member — please try again.");
      const { failed } = await removeStoragePaths(paths);
      if (failed > 0) {
        console.warn(
          `[removeRoomMember] room ${data.roomId} deleted but ${failed} attachment(s) could not be released (orphaned).`,
        );
      }
    }
    return { ok: true };
  });

export const editMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        messageId: z.string().uuid(),
        body: z
          .string()
          .trim()
          .min(1)
          .max(MESSAGE_BODY_MAX_LENGTH, "This message is too long — shorten it and try again."),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Audit-5 B1-LOW: editMessage had no cap at all — an account
    // could loop edits on its own messages inside the 5-min window,
    // churning Realtime fan-out to every room member. Rate limit
    // FIRST, per user: 60 edits / 10 min is generous for humans.
    await checkRateLimitKey(`edit-message:${userId}`, 60, 600);
    const { data: message, error: readError } = await supabase
      .from("messages")
      .select("user_id, room_id, type")
      .eq("id", data.messageId)
      .single();
    if (readError) throw dbErr(readError, "Could not edit the message — please try again.");
    if (message.user_id !== userId) throw new Error("You can only edit your own messages.");
    // Audit-3 A4-N28: ex-members must not edit their messages after
    // removal (same as deleteMessage).
    await assertOwnMembership(message.room_id, userId);
    // M4: only text messages are editable. A call message's body is a
    // structured JSON payload (editing it breaks the call pill — the
    // parser returns null and the raw body renders); an attachment
    // message's body is null (editing it injects text into it).
    if (message.type !== "text") {
      throw new Error("Only text messages can be edited.");
    }
    // E2EE enforcement: an edit must not downgrade an encrypted message
    // (or an encrypted room) to plaintext.
    const { data: roomRow, error: roomError } = await supabase
      .from("rooms")
      .select("is_e2ee")
      .eq("id", message.room_id)
      .maybeSingle();
    // Audit-2 M68: same fail-closed rule as sendMessage — a room-read
    // error (except 42703 = missing is_e2ee column, which cannot mark
    // any room E2EE) or a missing row must not downgrade an edit to
    // plaintext in what might be an encrypted room.
    if (roomError && (roomError as { code?: string }).code !== "42703") throw dbErr(roomError, "Could not edit the message — please try again.");
    if (!roomError && !roomRow) throw new Error("Could not verify this conversation.");
    if (
      (roomRow as { is_e2ee?: boolean } | null)?.is_e2ee === true &&
      !data.body.startsWith("E2E1:")
    ) {
      throw new Error("This room is end-to-end encrypted — send encrypted text only.");
    }
    // Audit-2 H31: an edit's envelope must be shape-valid too (see
    // sendMessage) — a garbage E2E1: edit would poison the message.
    if (
      (roomRow as { is_e2ee?: boolean } | null)?.is_e2ee === true &&
      !validateE2EEnvelope(data.body, userId)
    ) {
      throw new Error("This room is end-to-end encrypted — the edit is not a valid encrypted envelope.");
    }
    // Audit-4 M4: same cross-room replay rejection as sendMessage —
    // an edit must not plant another room's envelope here.
    // Audit-5 B3-HIGH: same v2-only write rule as sendMessage.
    if ((roomRow as { is_e2ee?: boolean } | null)?.is_e2ee === true) {
      if (getE2EEnvelopeVersion(data.body) !== 2) {
        throw new Error("This encrypted message uses an outdated format that can't be posted — please reload the app and try again.");
      }
      const editEnvRoom = getE2EEnvelopeRoom(data.body);
      if (editEnvRoom !== message.room_id) {
        throw new Error("This encrypted message was created for a different conversation — it can't be posted here.");
      }
    }
    // Audit-3 A4-N6: same recipient-binding as sendMessage (see above).
    if ((roomRow as { is_e2ee?: boolean } | null)?.is_e2ee === true) {
      const { data: e2eeMembers, error: e2eeMemberError } = await supabase
        .from("room_members")
        .select("user_id")
        .eq("room_id", message.room_id);
      if (e2eeMemberError) throw dbErr(e2eeMemberError, "Could not edit the message — please try again.");
      assertEnvelopeRecipientsAreMembers(
        (e2eeMembers ?? []).map((r) => r.user_id),
        data.body,
      );
    } else if (data.body.startsWith("E2E1:")) {
      // Audit-4 M3: same prefix ban as sendMessage (Audit-3 A4-N32)
      // — editMessage lacked it, so an edit could plant a fake
      // E2E1: body in a non-E2EE room that renders as "🔒 Encrypted
      // message" in previews without ever being encrypted. The
      // prefix is reserved for real envelopes.
      throw new Error("Messages can't start with \"E2E1:\" — that prefix is reserved for encrypted messages.");
    }
    // RLS only permits edits within 5 minutes and returns 0 rows (no error)
    // when the window expired — check the returned row so we don't claim
    // success when nothing was updated.
    const { data: updated, error } = await supabase
      .from("messages")
      .update({ body: data.body, edited_at: new Date().toISOString() })
      .eq("id", data.messageId)
      .select("id");
    if (error) throw dbErr(error, "Could not edit the message — please try again.");
    if (!updated || updated.length === 0) {
      throw new Error("Edit window expired — messages can only be edited within 5 minutes.");
    }
    return { ok: true };
  });

// Avatars live under <userId>/profile/ in the attachments bucket; profile
// pictures are intentionally viewable by any signed-in user.
export const signAvatar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Avatar privacy is enforced here (server-side): a private avatar never
    // leaves the server for anyone but its owner.
    let profile: {
      avatar_url: string | null;
      is_avatar_public?: boolean;
      is_public?: boolean;
    } | null = null;
    const full = await supabaseAdmin
      .from("profiles")
      .select("avatar_url, is_avatar_public, is_public")
      .eq("id", data.userId)
      .single();
    if (!full.error) {
      profile = full.data;
    } else if (full.error.code === "42703") {
      // M103: ONLY a missing column (42703 = undefined_column, i.e.
      // the privacy SQL hasn't run yet) tolerates the fallback — no
      // privacy setting exists to honor. Any OTHER error (RLS,
      // transient, …) fails CLOSED to {url: null}: a private avatar
      // must never downgrade to public because of an error we don't
      // understand.
      const base = await supabaseAdmin
        .from("profiles")
        .select("avatar_url")
        .eq("id", data.userId)
        .single();
      if (base.error) return { url: null as string | null };
      profile = base.data;
    } else {
      return { url: null as string | null };
    }
    if (
      profile?.is_avatar_public === false &&
      context.userId !== data.userId
    ) {
      return { url: null as string | null };
    }
    // Audit-2 H30: is_public = false ("hidden") hides the avatar from
    // everyone except the owner and existing DM contacts — even when
    // the avatar section itself is public.
    if (
      profile?.is_public === false &&
      context.userId !== data.userId &&
      !(await dmContactIds(context.userId, [data.userId])).has(data.userId)
    ) {
      return { url: null as string | null };
    }
    const path = profile?.avatar_url;
    if (!path || !path.startsWith(`${data.userId}/profile/`)) return { url: null as string | null };
    // Audit-4 L46: signed URLs are BEARER tokens — Supabase cannot
    // revoke an issued one, so a Toggle-to-Private only stops NEW
    // signs while already-issued URLs keep working. The only lever
    // is the TTL: 10 min (was 60) bounds the post-toggle window,
    // and the avatar observers cache for 5 min (SmartAvatar +
    // ProfileDialog), so a cached URL always has >= 5 min of
    // validity left at cache expiry — it can never expire
    // mid-cache and render a broken image.
    const { data: signed, error } = await context.supabase.storage
      .from("chat-attachments")
      // Audit-2 M66: force Content-Disposition: attachment (same as
      // signAttachment). An HTML/SVG file that slipped through as an
      // avatar downloads on direct navigation instead of rendering
      // on the trusted storage origin. Subresource <img> loads ignore
      // the disposition and still render inline.
      .createSignedUrl(path, 10 * 60, { download: true });
    if (error) throw dbErr(error, "Could not load the avatar — please try again.");
    return { url: signed.signedUrl as string | null };
  });

/**
 * Per-section privacy, applied at the read layer (H5). Returns the
 * privacy-filtered copy of a set of profiles for the viewer: sections
 * the owner marked private come back hidden (name -> "Someone",
 * avatar -> null). The viewer's own profile is always full.
 *
 * Why a fallback name instead of null: list consumers (People search,
 * member lists, DM lists) do not all null-check display_name — a null
 * would crash the mobile People search (`u.display_name.toLowerCase()`)
 * and render "null" elsewhere. "Someone" is the codebase's established
 * fallback for an unknown/private name.
 *
 * Tolerates the privacy columns missing (SQL not run yet) by treating
 * everything as public — same tolerant pattern as getPublicProfile.
 */
type PublicProfileRow = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  is_online: boolean | null;
  last_seen_at: string | null;
};

/**
 * Audit-2 H30: which of the given subjects share an EXISTING DM room
 * with the viewer? `is_public = false` ("hidden") hides a profile from
 * everyone EXCEPT the viewer themself and their existing DM contacts
 * (a DM is the only 1:1, mutual-ish context — sharing a group room,
 * public or private, does NOT make someone a contact: the audit's
 * verify denies a public-room sharer, and group membership is not a
 * visibility choice by the profile owner). Fail CLOSED: any error
 * returns an empty set (nobody counts as a contact) — a transient DB
 * error hides profiles instead of leaking them.
 */
/**
 * Audit-2 M62: the name a callee may see for a caller. Call flows
 * used to store/return the caller's RAW display_name (admin client,
 * no privacy filter) — a private-name caller de-anonymized themself
 * to every callee via the invite row + the push payload. The same
 * "Someone" rule as the profile view (C3) + the H30 gate, composed:
 *   - is_name_public === false -> "Someone" (for everyone but self;
 *     the callee is never the caller here).
 *   - is_public === false (hidden) + callee is NOT an existing DM
 *     contact -> "Someone" (the H30 hidden rule; a DM contact still
 *     sees the real name, exactly like the profile gate).
 * Otherwise the real display_name. Applied at STORE time in both
 * invite creators, so the getters + push payload inherit it.
 *
 * Failures fail CLOSED (name hidden, call proceeds): a profile-read
 * error returns "Someone". Pre-§4 (privacy columns missing, 42703)
 * falls back to the bare display_name read — the columns default to
 * public, matching the view's coalesce(..., true) semantics.
 */
async function callerNameForCallee(callerId: string, calleeId: string): Promise<string> {
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("display_name, is_name_public, is_public")
    .eq("id", callerId)
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "42703") {
      const { data: base } = await supabaseAdmin
        .from("profiles")
        .select("display_name")
        .eq("id", callerId)
        .maybeSingle();
      return base?.display_name || "Someone";
    }
    return "Someone";
  }
  if (!profile) return "Someone";
  if (profile.is_name_public === false) return "Someone";
  if (
    profile.is_public === false &&
    !(await dmContactIds(calleeId, [callerId])).has(callerId)
  ) {
    return "Someone";
  }
  return profile.display_name || "Someone";
}

async function dmContactIds(
  viewerId: string,
  subjectIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (subjectIds.length === 0) return out;
  try {
    const { data: myRooms, error: myErr } = await supabaseAdmin
      .from("room_members")
      .select("room_id, rooms(is_dm)")
      .eq("user_id", viewerId);
    if (myErr) return out;
    const dmIds = (myRooms ?? [])
      .filter((r) => (r.rooms as { is_dm?: boolean } | null)?.is_dm === true)
      .map((r) => r.room_id);
    if (dmIds.length === 0) return out;
    const { data: peers, error: peerErr } = await supabaseAdmin
      .from("room_members")
      .select("user_id")
      .in("room_id", dmIds)
      .in("user_id", subjectIds);
    if (peerErr) return out;
    for (const p of peers ?? []) out.add(p.user_id);
  } catch {
    return out;
  }
  return out;
}

/**
 * Privacy-filtered profiles for a set of user IDs.
 *
 * Audit-2 C3: the profiles table is now own-row-only (the wide-open
 * profiles_read_all policy is gone), so RLS-subject callers MUST read
 * others' profiles from the profiles_public SECURITY DEFINER view,
 * which applies the per-section privacy filter itself (private name ->
 * "Someone", private avatar -> null, presence only for public profiles
 * or people you share a room with). `source` declares which one:
 *   - "view"  — RLS callers (listDms, listUsers, getPublicProfiles).
 *   - "table" — supabaseAdmin callers (listRoomMembers): the server
 *     already applies the JS privacy filter below, and the admin path
 *     must keep member presence for private-profile members (the
 *     view would hide it — the viewer's JWT is absent server-side).
 *
 * Pre-§C3 tolerance: if the view does not exist yet (SQL not run),
 * the view query fails with a missing-relation error and we fall back
 * to the table read (old behaviour, wide-open policy still in place
 * because §C3 aborts before changing the policy when the view fails).
 * Under the NEW policy the fallback can only return the viewer's own
 * row, so it can never leak — it just degrades to "Someone".
 *
 * Audit-2 H30: on top of the per-section filter, `is_public = false`
 * ("hidden") hides name + avatar from everyone except the viewer
 * themself and their existing DM contacts (see dmContactIds). The DM
 * check runs only when at least one non-self subject is private, so
 * the common all-public case costs zero extra queries.
 */

/**
 * Audit-2 M53: overlay live presence from the `presence` table onto
 * profile rows. The heartbeat writes ONLY `presence` now (never
 * `profiles`, so it no longer broadcasts on Realtime) — a row's
 * `profiles.last_seen_at` is frozen legacy data. This helper
 * batch-fetches presence for the rows' ids and overwrites
 * `last_seen_at` + recomputes `is_online` (120s staleness rule) where
 * a presence row exists.
 *
 * Tolerance: ANY presence-query error (missing table pre-§M53, RLS,
 * transient) leaves the rows untouched — pre-§M53 the profiles
 * timestamps are still fresh (the old touch_presence wrote them), so
 * the fallback is correct, and post-§M53 a transient failure just
 * shows stale presence until the next refetch. Presence is
 * low-stakes display data, so fail-to-stale (with a warn) is right
 * here — unlike H35's privacy fallback, where fail-open would leak.
 */
async function attachPresence(
  client: typeof supabaseAdmin,
  rows: { id: string; last_seen_at: string | null; is_online?: boolean | null }[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const { data, error } = await client
      .from("presence")
      .select("user_id, last_seen_at")
      .in(
        "user_id",
        rows.map((r) => r.id),
      );
    if (error) throw dbErr(error, "Something went wrong — please try again.");
    const byId = new Map((data ?? []).map((p) => [p.user_id, p.last_seen_at]));
    for (const r of rows) {
      const live = byId.get(r.id);
      if (live !== undefined) {
        r.last_seen_at = live;
        r.is_online = isUserOnline(live);
      }
    }
  } catch (err) {
    console.warn("[presence] attachPresence failed — keeping profiles timestamps:", err);
  }
}

async function fetchPublicProfiles(
  client: typeof supabaseAdmin,
  ids: string[],
  viewerId: string,
  source: "view" | "table",
): Promise<Map<string, PublicProfileRow>> {
  const out = new Map<string, PublicProfileRow>();
  if (ids.length === 0) return out;
  type Row = PublicProfileRow & {
    is_name_public?: boolean;
    is_avatar_public?: boolean;
    is_public?: boolean;
  };
  let rows: Row[] = [];
  let fromView = false;
  if (source === "view") {
    const { data, error } = await client
      .from("profiles_public")
      .select("id, display_name, avatar_url, is_online, last_seen_at, is_public")
      .in("id", ids);
    if (!error) {
      rows = (data ?? []) as Row[];
      fromView = true;
    } else {
      const missingView =
        (error as { code?: string }).code === "PGRST205" ||
        /does not exist/i.test((error as { message?: string }).message ?? "");
      if (!missingView) throw dbErr(error, "Could not load the profile — please try again.");
      // View missing (pre-§C3) -> fall through to the table read below.
    }
  }
  if (!fromView) {
    const full = await client
      .from("profiles")
      .select(
        "id, display_name, avatar_url, is_online, last_seen_at, is_name_public, is_avatar_public, is_public",
      )
      .in("id", ids);
    if (!full.error) {
      rows = (full.data ?? []) as Row[];
    } else if ((full.error as { code?: string }).code === "42703") {
      // Audit-2 H35 (signAvatar pattern): the privacy-column-free
      // fallback runs ONLY on 42703 (undefined_column — the privacy
      // SQL hasn't run yet, so no privacy setting exists to honor).
      // ANY other error throws — a transient RLS/timeout error must
      // never downgrade to unfiltered profiles.
      const base = await client
        .from("profiles")
        .select("id, display_name, avatar_url, is_online, last_seen_at")
        .in("id", ids);
      if (base.error) throw dbErr(base.error, "Could not load the profile — please try again.");
      rows = (base.data ?? []) as Row[];
    } else {
      throw dbErr(full.error, "Could not load the profile — please try again.");
    }
  }
  const needContacts = rows.some((r) => r.id !== viewerId && r.is_public === false);
  const contacts = needContacts
    ? await dmContactIds(
        viewerId,
        rows.map((r) => r.id),
      )
    : new Set<string>();
  // Audit-2 M53: overlay live presence from the `presence` table
  // (heartbeat writes there now, never profiles). Runs BEFORE the
  // H30 gate so hidden users' presence is nulled by the gate below.
  await attachPresence(client, rows);
  for (const r of rows) {
    const isSelf = r.id === viewerId;
    // H30: hidden profile (private + not a DM contact + not self) —
    // name -> "Someone", avatar -> null. Per-section flags still apply
    // underneath (view rows already carry the view's filter;
    // is_name_public/is_avatar_public are undefined on view rows, so
    // those checks no-op there and only bite on table rows).
    // M53: a hidden profile shows no presence at all (the view's
    // gate is shared-room; H30's DM-only rule is stricter and wins).
    const hidden = !isSelf && r.is_public === false && !contacts.has(r.id);
    out.set(r.id, {
      id: r.id,
      display_name: hidden
        ? "Someone"
        : !isSelf && r.is_name_public === false
          ? "Someone"
          : (r.display_name ?? "Someone"),
      avatar_url: hidden
        ? null
        : !isSelf && r.is_avatar_public === false
          ? null
          : r.avatar_url,
      is_online: hidden ? false : r.is_online,
      last_seen_at: hidden ? null : r.last_seen_at,
    });
  }
  return out;
}

/**
 * Privacy-filtered profiles for an arbitrary set of user IDs (H5).
 * Used by the room page (DM peer header + message sender names), which
 * previously queried profiles directly and leaked private names/avatars
 * to the client. Returns one entry per requested ID (null when the
 * profile does not exist), in the same order.
 */
export const getPublicProfiles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ userIds: z.array(z.string().uuid()).max(200) }).parse(d))
  .handler(async ({ data, context }) => {
    const map = await fetchPublicProfiles(context.supabase, data.userIds, context.userId, "view");
    return data.userIds.map((id) => map.get(id) ?? null);
  });

/**
 * Another user's profile, filtered by THEIR per-section privacy settings
 * (server-side — private sections never leave the server). Used by the
 * WhatsApp-style profile sheet when tapping someone inside a chat.
 * The requester always sees their own full profile.
 */
export const getPublicProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const isSelf = context.userId === data.userId;
    const privacyCols = "is_avatar_public, is_name_public, is_bio_public, is_status_public";
    let profile: {
      display_name: string | null;
      avatar_url: string | null;
      bio: string | null;
      custom_status: string | null;
      is_online: boolean | null;
      last_seen_at: string | null;
      is_public?: boolean;
      is_avatar_public?: boolean;
      is_name_public?: boolean;
      is_bio_public?: boolean;
      is_status_public?: boolean;
    } | null = null;
    const full = await supabaseAdmin
      .from("profiles")
      .select(`display_name, avatar_url, bio, custom_status, is_online, last_seen_at, is_public, ${privacyCols}`)
      .eq("id", data.userId)
      .maybeSingle();
    if (!full.error) {
      profile = full.data;
    } else if ((full.error as { code?: string }).code === "42703") {
      // Audit-2 H35 (signAvatar pattern): base fallback ONLY on
      // 42703 (privacy columns missing). Any other error throws —
      // never downgrade to unfiltered profile data.
      const base = await supabaseAdmin
        .from("profiles")
        .select("display_name, avatar_url, bio, custom_status, is_online, last_seen_at")
        .eq("id", data.userId)
        .maybeSingle();
      if (base.error) throw dbErr(base.error, "Could not load the profile — please try again.");
      profile = base.data;
    } else {
      throw dbErr(full.error, "Could not load the profile — please try again.");
    }
    if (!profile) return null;
    // Audit-2 M53: overlay live presence from the `presence` table
    // (heartbeat writes there now, never profiles). Runs before the
    // H30 gate so a hidden profile's presence is nulled below.
    {
      const presenceRow = {
        id: data.userId,
        last_seen_at: profile.last_seen_at,
        is_online: profile.is_online,
      };
      await attachPresence(supabaseAdmin, [presenceRow]);
      profile.last_seen_at = presenceRow.last_seen_at;
      profile.is_online = presenceRow.is_online;
    }
    // Audit-2 H30: is_public = false ("hidden") hides the WHOLE
    // profile — name, avatar, bio, status, AND presence — from
    // everyone except the viewer themself and existing DM contacts.
    // (Per-section flags still apply underneath for public profiles.)
    const hidden =
      !isSelf &&
      profile.is_public === false &&
      !(await dmContactIds(context.userId, [data.userId])).has(data.userId);
    return {
      userId: data.userId,
      isSelf,
      displayName: hidden ? null : isSelf || profile.is_name_public !== false ? profile.display_name : null,
      avatarUrl: hidden ? null : isSelf || profile.is_avatar_public !== false ? profile.avatar_url : null,
      bio: hidden ? null : isSelf || profile.is_bio_public !== false ? profile.bio : null,
      status: hidden ? null : isSelf || profile.is_status_public !== false ? profile.custom_status : null,
      // H25: NEVER return the raw is_online column — touch_presence only
      // ever sets it true (never false), so anyone who was ever online
      // showed "Online now" forever. Every other reader converts via
      // isUserOnline(last_seen_at) (120s staleness rule); this path does
      // the same. H30: a hidden profile shows no presence at all.
      isOnline: hidden ? false : isUserOnline(profile.last_seen_at),
      lastSeenAt: hidden ? null : profile.last_seen_at,
    };
  });

/** Mark a room as read by the current user (updates their read receipt). */
export const markRoomRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Only members may mark a room read (mirrors getReadReceipts).
    const { data: membership } = await context.supabase
      .from("room_members")
      .select("room_id")
      .eq("room_id", data.roomId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!membership) throw new Error("You are not a member of this conversation.");
    const { error } = await context.supabase.from("read_receipts").upsert(
      {
        room_id: data.roomId,
        user_id: context.userId,
        last_read_at: new Date().toISOString(),
      },
      { onConflict: "room_id,user_id" },
    );
    if (error) throw dbErr(error, "Could not update read state — please try again.");
    return { ok: true };
  });

/** Read receipts for a room: who last read it and when. */
export const getReadReceipts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Must be a member to see receipts.
    const { data: membership } = await context.supabase
      .from("room_members")
      .select("room_id")
      .eq("room_id", data.roomId)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!membership) throw new Error("Not a member of this room.");
    const { data: receipts, error } = await context.supabase
      .from("read_receipts")
      .select("user_id, last_read_at")
      .eq("room_id", data.roomId);
    if (error) throw dbErr(error, "Could not load read receipts — please try again.");
    return receipts ?? [];
  });

/** My memberships with per-chat pin/mute state. */
export const getMyMemberships = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await supabaseAdmin
      .from("room_members")
      .select("room_id, pinned_at, is_muted")
      .eq("user_id", context.userId);
    if (error) throw dbErr(error, "Could not load your chats — please try again.");
    return (data ?? []) as { room_id: string; pinned_at: string | null; is_muted: boolean }[];
  });

async function assertOwnMembership(roomId: string, userId: string) {
  const { data } = await supabaseAdmin
    .from("room_members")
    .select("room_id")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("Not a member of this chat.");
}

/** Pin or unpin a chat for me (pinned chats sort to the top). */
export const pinChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomId: z.string().uuid(), pinned: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnMembership(data.roomId, context.userId);
    const { data: updated, error } = await supabaseAdmin
      .from("room_members")
      .update({ pinned_at: data.pinned ? new Date().toISOString() : null })
      .eq("room_id", data.roomId)
      .eq("user_id", context.userId)
      .select("user_id");
    if (error) throw dbErr(error, "Could not update the chat — please try again.");
    // Audit-4 L15: verify a row was actually updated — membership
    // deleted between the assert and the update yields 0 rows with
    // NO error, and the old code reported {ok:true} (client toasted
    // success, refresh showed the old state).
    if (!updated || updated.length === 0) throw new Error("Not a member of this chat.");
    return { ok: true };
  });

/** Mute or unmute notifications for a chat. */
export const muteChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomId: z.string().uuid(), muted: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnMembership(data.roomId, context.userId);
    const { data: updated, error } = await supabaseAdmin
      .from("room_members")
      .update({ is_muted: data.muted })
      .eq("room_id", data.roomId)
      .eq("user_id", context.userId)
      .select("user_id");
    if (error) throw dbErr(error, "Could not update the chat — please try again.");
    // Audit-4 L15: verify a row was actually updated (same race as
    // pinChat — membership deleted between assert and update).
    if (!updated || updated.length === 0) throw new Error("Not a member of this chat.");
    return { ok: true };
  });

/** Leave a chat. If nobody remains, the room is cleaned up. */
export const leaveChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Audit-3 A4-N30: atomic leave — membership check + creator
    // transfer + membership delete + maybe room delete in ONE
    // transaction inside the RPC, so a join can no longer land
    // between the count and the delete and get cascade-deleted.
    // Attachment paths are listed BEFORE the RPC (it may delete the
    // room), and storage is released only if it reports deletion.
    // A missing function (pre-SQL) falls back to the old three-step
    // path (H16 pattern) — the race stays open until the audit3
    // SQL has run.
    const prePaths = await listRoomAttachmentPaths(data.roomId).catch(
      () => [] as string[],
    );
    const { data: roomDeleted, error: rpcError } = await context.supabase.rpc(
      "leave_room_atomic",
      { _room_id: data.roomId },
    );
    if (!rpcError) {
      if (roomDeleted) {
        const { failed } = await removeStoragePaths(prePaths);
        if (failed > 0) {
          console.warn(
            `[leaveChat] room ${data.roomId} deleted but ${failed} attachment(s) could not be released (orphaned).`,
          );
        }
      }
      return { ok: true };
    }
    if (rpcError.code === "P0001") throw new Error(rpcError.message);
    if (rpcError.code !== "PGRST202" && !/does not exist/i.test(rpcError.message ?? "")) {
      throw dbErr(rpcError, "Could not leave the chat — please try again.");
    }
    console.warn(
      "[leaveChat] leave_room_atomic RPC missing — falling back to three-step leave (race open until audit3 SQL runs).",
    );
    await assertOwnMembership(data.roomId, context.userId);
    // M3: a DM is a shared 1:1 room — "leaving" it deletes the whole
    // room. Removing only the leaver's membership left a 1-member
    // zombie room for the peer, and the next get_or_create_dm found no
    // room containing BOTH members and forked a SECOND DM room (the
    // peer ended up with two DM threads for the same person).
    const { data: room } = await supabaseAdmin
      .from("rooms")
      .select("is_dm")
      .eq("id", data.roomId)
      .maybeSingle();
    if (room?.is_dm) {
      const paths = await listRoomAttachmentPaths(data.roomId).catch(() => [] as string[]);
      // Audit-3 A8-N13: capture the room-delete error and throw
      // (bare await swallowed a transient failure → false {ok:true}).
      // Audit-4 L15: verify a row was actually deleted — the room
      // vanishing between the assert and the delete yields 0 rows
      // with no error.
      const { data: deletedRoom, error: deleteError } = await supabaseAdmin
        .from("rooms")
        .delete()
        .eq("id", data.roomId)
        .select("id");
      if (deleteError) throw dbErr(deleteError, "Could not leave the chat — please try again.");
      if (!deletedRoom || deletedRoom.length === 0)
        throw new Error("Room not found — it may already be deleted.");
      const { failed } = await removeStoragePaths(paths);
      if (failed > 0) {
        console.warn(`[leaveChat] DM room ${data.roomId} deleted but ${failed} attachment(s) could not be released (orphaned).`);
      }
      return { ok: true };
    }
    // H8: a creator leaving hands created_by to the oldest remaining
    // member (before the leaver's row is deleted).
    await transferCreatorOnLeave(data.roomId, context.userId);
    const { data: deleted, error } = await supabaseAdmin
      .from("room_members")
      .delete()
      .eq("room_id", data.roomId)
      .eq("user_id", context.userId)
      .select("user_id");
    if (error) throw dbErr(error, "Could not leave the chat — please try again.");
    // Audit-4 L15: verify a row was actually deleted (same race as
    // removeRoomMember — membership gone between assert and delete).
    if (!deleted || deleted.length === 0) throw new Error("Not a member of this chat.");
    // Audit-3 A4-N1: NEVER delete on an unknown count — a failed
    // count query returns count: null, and (count ?? 0) === 0 would
    // have deleted a room that still has members (plus history +
    // attachments). Throw instead: the leaver's removal above stands,
    // but the room survives and the next leave/remove retries cleanup.
    const { count, error: countError } = await supabaseAdmin
      .from("room_members")
      .select("user_id", { count: "exact", head: true })
      .eq("room_id", data.roomId);
    if (countError) throw dbErr(countError, "Could not leave the chat — please try again.");
    if ((count ?? 0) === 0) {
      // M2: last member left — the room is deleted, so release its
      // attachments too (capture paths before the cascade wipes them).
      const paths = await listRoomAttachmentPaths(data.roomId).catch(() => [] as string[]);
      // Audit-3 A8-N13: capture the room-delete error and throw
      // (bare await swallowed a transient failure → false {ok:true}
      // with a 0-member orphan room; the leaver's removal stands
      // and the next leave/remove retries cleanup).
      // Audit-4 L15: NO row-count throw here, deliberately — this
      // delete is cleanup, not the leave itself (the membership
      // delete above already succeeded), and count==0 was JUST
      // verified, so 0 rows only means a concurrent cleanup
      // already removed the room.
      const { error: deleteError } = await supabaseAdmin.from("rooms").delete().eq("id", data.roomId);
      if (deleteError) throw dbErr(deleteError, "Could not leave the chat — please try again.");
      const { failed } = await removeStoragePaths(paths);
      if (failed > 0) {
        console.warn(`[leaveChat] room ${data.roomId} deleted but ${failed} attachment(s) could not be released (orphaned).`);
      }
    }
    return { ok: true };
  });

/**
 * M2: list a room's attachment storage paths BEFORE the room (and its
 * messages, via FK cascade) is deleted — afterwards the paths are
 * unrecoverable and the files orphan forever. Attachment paths are
 * `<userId>/<roomId>/…` (one prefix per sender), so the messages table
 * is the only complete index of a room's files.
 */
async function listRoomAttachmentPaths(roomId: string): Promise<string[]> {
  const paths: string[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("messages")
      .select("attachment_url")
      .eq("room_id", roomId)
      .not("attachment_url", "is", null)
      .range(offset, offset + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) {
      if (row.attachment_url) paths.push(row.attachment_url);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return paths;
}

/**
 * Remove storage paths in chunks of 1000 (storage.remove's limit).
 * Best-effort (M1's principle: post-commit, never throw) — returns the
 * counts so the caller can warn about orphans.
 */
async function removeStoragePaths(paths: string[]): Promise<{ cleaned: number; failed: number }> {
  let cleaned = 0;
  let failed = 0;
  for (let i = 0; i < paths.length; i += 1000) {
    const chunk = paths.slice(i, i + 1000);
    try {
      const { error } = await supabaseAdmin.storage.from("chat-attachments").remove(chunk);
      if (error) failed += chunk.length;
      else cleaned += chunk.length;
    } catch {
      failed += chunk.length;
    }
  }
  return { cleaned, failed };
}

/**
 * Audit-5 MEDIUM-4: opportunistic orphan-attachment sweep (H27's GC
 * pattern). find_orphan_attachments (§A5-M4, audit4 SQL) lists
 * chat-attachments objects older than 7 days that no message
 * references and that are not a live avatar — files uploaded but
 * never attached (failed sends, scripted tus abuse). They are
 * removed through the Storage API (removeStoragePaths) so rows AND
 * bytes go. Throttled to once per 10 minutes per instance; pre-SQL
 * the RPC errors and this is a no-op. Best-effort: never breaks
 * sending.
 */
let lastOrphanSweepAt = 0;
async function sweepOrphanAttachments(): Promise<void> {
  const now = Date.now();
  if (now - lastOrphanSweepAt < 10 * 60_000) return;
  lastOrphanSweepAt = now;
  try {
    const { data, error } = await supabaseAdmin.rpc("find_orphan_attachments", {
      _limit: 200,
    });
    if (error || !data || data.length === 0) return;
    const paths: string[] = data;
    const { failed } = await removeStoragePaths(paths);
    if (failed > 0) {
      console.warn(
        `[attachments] orphan sweep: ${failed} of ${paths.length} file(s) could not be removed.`,
      );
    }
  } catch {
    // Best-effort cleanup — never break the send flow.
  }
}

/** Delete a room entirely (room creator only). */
export const deleteRoom = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ roomId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertCanDeleteRoom(data.roomId, context.userId);
    // M2: capture attachment paths BEFORE the delete (cascade wipes messages).
    const paths = await listRoomAttachmentPaths(data.roomId).catch(() => [] as string[]);
    const { data: deletedRoom, error } = await supabaseAdmin
      .from("rooms")
      .delete()
      .eq("id", data.roomId)
      .select("id");
    if (error) throw dbErr(error, "Could not delete the room — please try again.");
    // Audit-4 L15: verify a row was actually deleted — the room
    // vanishing between the creator assert and the delete yields 0
    // rows with no error (false {ok:true}, storage cleanup below
    // would run against an already-gone room).
    if (!deletedRoom || deletedRoom.length === 0)
      throw new Error("Room not found — it may already be deleted.");
    // Best-effort storage cleanup — the room is gone; a storage failure
    // must not turn a successful delete into an error.
    const { failed } = await removeStoragePaths(paths);
    if (failed > 0) {
      console.warn(`[deleteRoom] room ${data.roomId} deleted but ${failed} attachment(s) could not be released (orphaned).`);
    }
    return { ok: true };
  });

/**
 * Audit-6 B-L3: deletion is NOT member management. deleteRoom used
 * to ride on assertCanManageMembers, whose oldest-member fallback
 * (for creator-less rooms) silently authorized TOTAL deletion —
 * room, messages and files — for a non-creator. Deletion requires
 * the ACTUAL creator (created_by === caller, still a member). The
 * one exception: a truly ownerless room (created_by NULL — the
 * creator's account was deleted) may be cleaned up by its oldest
 * remaining member; a room whose creator merely left is NOT
 * ownerless (H8's leave-transfer makes the successor the creator,
 * so they pass the first check as created_by themselves).
 */
async function assertCanDeleteRoom(roomId: string, callerId: string) {
  const { data: room } = await supabaseAdmin
    .from("rooms")
    .select("created_by")
    .eq("id", roomId)
    .single();
  if (!room) throw new Error("Room not found.");
  const { data: callerMembership } = await supabaseAdmin
    .from("room_members")
    .select("room_id")
    .eq("room_id", roomId)
    .eq("user_id", callerId)
    .maybeSingle();
  if (!callerMembership) {
    throw new Error("You are not a member of this conversation.");
  }
  if (room.created_by === callerId) return;
  if (room.created_by) {
    throw new Error("Only the room creator can delete this room.");
  }
  const { data: oldest } = await supabaseAdmin
    .from("room_members")
    .select("user_id")
    .eq("room_id", roomId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (oldest?.user_id !== callerId) {
    throw new Error("Only the room creator can delete this room.");
  }
}

/** Unread message counts per room for the current user. */
export const getUnreadCounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("get_unread_counts");
    if (error) throw dbErr(error, "Could not load unread counts — please try again.");
    return (data ?? []) as { room_id: string; unread_count: number }[];
  });

/**
 * Incoming-call push: the caller records a pending invite AND fans a Web
 * Push out to the callee's devices with Pick / Reject actions. The push is
 * best-effort (the Realtime invite already went) — a push failure must
 * never break the call.
 *
 * The invite row lets a callee whose app was fully closed still pick the
 * call up: the app fetches it via getCallInvite and reconstructs ringing.
 */
/**
 * Fast invite-row-only write. The caller awaits this BEFORE sending the
 * Realtime invite signal, so the callee's server-side verification (C4)
 * finds the row when the signal lands. Tolerant: if the call_invites
 * table doesn't exist yet, the call still proceeds — the callee fails
 * open on a table-missing error and the call works as before.
 */
/**
 * H26: call gate shared by createCallInvite + notifyIncomingCall.
 * Without it any authenticated caller could call ANY user — including
 * users who set their profile private to stop new contact (the
 * getOrCreateDm private-profile gate was fully bypassed), with no rate
 * limit and no self-call rejection. Gating only notifyIncomingCall
 * would NOT be enough: the caller proceeds with the Realtime signal
 * even if notify fails — but the callee's C4 verification drops signals
 * with no invite row, so gating invite creation gates the whole call.
 */
async function assertCanCall(callerId: string, peerId: string): Promise<void> {
  // Self-call is rejected server-side (the client also blocks it).
  if (callerId === peerId) throw new Error("You cannot call yourself.");

  // Callee must exist. is_public may be missing if the visibility SQL
  // hasn't run yet — fall back to a select without it (treat as public).
  let callee: { id?: string; is_public?: boolean } | null = null;
  const withPrivacy = await supabaseAdmin
    .from("profiles")
    .select("is_public")
    .eq("id", peerId)
    .maybeSingle();
  if (!withPrivacy.error) {
    callee = withPrivacy.data;
  } else if ((withPrivacy.error as { code?: string }).code === "42703") {
    // Audit-2 H35 (signAvatar pattern): the no-is_public fallback runs
    // ONLY on 42703 (column missing — pre-SQL world). ANY other error
    // blocks the call — a transient error must never silently drop the
    // private-profile gate and treat the callee as public.
    const base = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("id", peerId)
      .maybeSingle();
    if (base.error) throw new Error("Could not verify the person you are calling.");
    callee = base.data;
  } else {
    throw new Error("Could not verify the person you are calling.");
  }
  if (!callee) throw new Error("User not found.");

  // Private profile: only existing DM contacts may call (mirrors the
  // get_or_create_dm gate in H9). A shared group room does NOT count.
  if (callee.is_public === false) {
    const { data: myRooms } = await supabaseAdmin
      .from("room_members")
      .select("room_id")
      .eq("user_id", callerId);
    const roomIds = (myRooms ?? []).map((r) => r.room_id);
    let hasDm = false;
    if (roomIds.length > 0) {
      const { data: peerRooms } = await supabaseAdmin
        .from("room_members")
        .select("room_id, rooms(is_dm)")
        .eq("user_id", peerId)
        .in("room_id", roomIds);
      hasDm = (peerRooms ?? []).some((r) => {
        const room = r.rooms as { is_dm?: boolean } | null;
        return room?.is_dm === true;
      });
    }
    if (!hasDm) throw new Error("This user is not accepting new calls.");
  }

  // Per-caller rate limit: 10 call attempts per minute. Counts invite
  // rows (both entry points write them). Fail OPEN if the table is
  // missing — a missing table must not block legitimate calls.
  try {
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const { data, error } = await supabaseAdmin
      .from("call_invites")
      .select("id")
      .eq("caller_id", callerId)
      .gt("created_at", oneMinuteAgo);
    if (!error && (data?.length ?? 0) >= 10) {
      throw new Error("Too many calls — please slow down.");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Too many calls")) throw err;
    // DB error (e.g. table missing) → fail open.
  }
}

/**
 * H27: garbage-collect dead call_invites rows (unbounded-table fix).
 * reportCallEvent must NOT delete the row on a terminal transition —
 * the receiver verifies the matching decline/end signal against the
 * row AFTER it is reported (report-before-signal), so deleting it
 * would make the receiver drop a real decline/end signal and hang the
 * caller's UI. Instead, rows that are certainly dead are swept here:
 * ringing > 5 min (the 30s pickup window is long past), declined/ended
 * > 5 min (their signals were delivered within seconds), accepted >
 * 24h (orphan from a crashed call — no call lasts a day). Best-effort:
 * any error (e.g. table missing) is swallowed.
 */
async function cleanupStaleCallInvites(): Promise<void> {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    await supabaseAdmin
      .from("call_invites")
      .delete()
      .eq("status", "ringing")
      .lt("created_at", fiveMinAgo);
    await supabaseAdmin
      .from("call_invites")
      .delete()
      .in("status", ["declined", "ended"])
      .lt("created_at", fiveMinAgo);
    await supabaseAdmin
      .from("call_invites")
      .delete()
      .eq("status", "accepted")
      .lt("created_at", dayAgo);
  } catch {
    // Best-effort cleanup — never break the call flow.
  }
}

/**
 * Audit-2 C1: one random 256-bit secret per call, generated SERVER-side
 * (never client-side — a client could pick a weak/guessable secret) and
 * stored on the invite row. Every offer/answer/ice signal carries
 * HMAC-SHA256(secret, callId || kind || payload); the receiver verifies
 * it before touching the PeerConnection. The row's SELECT policy is
 * participant-only, so only the two participants ever learn the secret —
 * an eavesdropper on the public Realtime channel cannot forge a MAC.
 */
function generateCallSecret(): string {
  return randomBase64Url(32);
}

export const createCallInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        peerId: z.string().uuid(),
        callId: z.string().min(1).max(100),
        type: z.enum(["voice", "video"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const callerId = context.userId;
    // Audit-3 A8-N9: attempt-based rate limit FIRST (A4-N5 pattern).
    // assertCanCall's row-count limiter never trips on a fixed-callId
    // loop (ignoreDuplicates creates no new row), so a retry loop
    // could spin invite creation + Realtime signals unboundedly.
    // 10 attempts / 60s per caller; fail CLOSED if the RPC/table is
    // missing (Audit-4 H7).
    await checkRateLimitKey(`call-create:${callerId}`, 10, 60);
    // H26: privacy + self-call + rate-limit gate (see assertCanCall).
    await assertCanCall(callerId, data.peerId);
    // H27: sweep dead invite rows (best-effort).
    await cleanupStaleCallInvites();
    // Audit-2 M62: privacy-filtered caller name (see callerNameForCallee).
    const callerName = await callerNameForCallee(callerId, data.peerId);
    // Audit-2 C1: fresh per-call HMAC secret. Returned to the caller so
    // it can MAC its offer/answer/ice; the callee fetches it via
    // getCallInvite / getPendingInvites (both participant-only).
    const secret = generateCallSecret();
    try {
      // Audit-2 H28: NEVER overwrite an existing invite row. The old
      // upsert({ onConflict: "id" }) let ANY caller overwrite ANY
      // invite by callId — caller/callee/status/secret all replaced,
      // the real call's row regressed to "ringing", the callee's
      // verification saw a different caller. Now: upsert with
      // ignoreDuplicates (a conflicting row survives untouched), then
      // READ BACK the row and verify it is OURS before proceeding.
      const { error } = await supabaseAdmin.from("call_invites").upsert(
        {
          id: data.callId,
          caller_id: callerId,
          callee_id: data.peerId,
          caller_name: callerName,
          type: data.type,
          status: "ringing",
          secret,
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      if (error) {
        const tableMissing =
          error.code === "PGRST205" || /does not exist/i.test(error.message ?? "");
        return { ok: false, secret: null, tableMissing };
      }
      const { data: row, error: readError } = await supabaseAdmin
        .from("call_invites")
        .select("caller_id, callee_id, secret")
        .eq("id", data.callId)
        .maybeSingle();
      if (readError || !row) {
        return { ok: false, secret: null, tableMissing: false };
      }
      // Ownership mismatch = someone else owns this callId (hijack
      // attempt): reject, leave their row untouched.
      if (row.caller_id !== callerId || row.callee_id !== data.peerId) {
        console.warn(
          `[call] createCallInvite: callId ${data.callId} owned by another caller — rejecting overwrite attempt.`,
        );
        return { ok: false, secret: null, tableMissing: false };
      }
      // Same caller + callee: if the row pre-existed (a retry after a
      // lost response), its secret is the one the callee may already
      // hold — return THAT, not the fresh one (rotating would break
      // the callee's MAC verification of the in-flight offer).
      // Audit-3 A8-N7: if the row pre-exists with a NULL secret
      // (notifyIncomingCall ran first and created a secret-less
      // row), backfill it with the fresh secret — otherwise the
      // callee fetches secret: null and the call fails closed
      // forever for this callId. The re-read returns the STORED
      // secret: a concurrent backfill may have won, and the
      // caller must use the secret the callee will fetch, never
      // a fresh one the callee doesn't hold.
      if (row.secret == null) {
        await supabaseAdmin
          .from("call_invites")
          .update({ secret })
          .eq("id", data.callId)
          .is("secret", null);
        const { data: refilled } = await supabaseAdmin
          .from("call_invites")
          .select("secret")
          .eq("id", data.callId)
          .maybeSingle();
        // Audit-4 M11: a null secret is NEVER a valid success — the
        // backfill update may have failed (DB error) and the callee
        // can never verify the offer MAC of a secret-less row (offer
        // dropped, accept fails, misleading "declined"). Fail the
        // create instead: the provider aborts (H1) rather than
        // starting 30s of dead ringing.
        if (refilled?.secret == null) {
          return { ok: false, secret: null, tableMissing: false };
        }
        return { ok: true, secret: refilled.secret, tableMissing: false };
      }
      return { ok: true, secret: row.secret, tableMissing: false };
    } catch {
      return { ok: false, secret: null, tableMissing: false };
    }
  });

/**
 * Report a call lifecycle event (accepted / declined / ended) to the
 * server-side invite row. The sender MUST call this BEFORE sending the
 * matching Realtime signal — the receiver verifies the signal against
 * this row (C4), so the row must be written first.
 *
 * Authz: only a participant of the invite may report. Only the callee
 * may accept/decline. A terminal status (declined/ended) is never
 * regressed by a late event.
 */
export const reportCallEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        callId: z.string().min(1).max(100),
        event: z.enum(["accepted", "declined", "ended"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const { data: invite, error } = await supabaseAdmin
      .from("call_invites")
      .select("caller_id, callee_id, status")
      .eq("id", data.callId)
      .maybeSingle();
    if (error || !invite) return { ok: false, applied: false, terminal: false };
    if (invite.caller_id !== userId && invite.callee_id !== userId) {
      return { ok: false, applied: false, terminal: false };
    }
    if (
      (data.event === "accepted" || data.event === "declined") &&
      invite.callee_id !== userId
    ) {
      return { ok: false, applied: false, terminal: false };
    }
    // Audit-2 H17: an already-terminal row must NOT report success as
    // if the transition applied. The old code returned { ok: true }
    // here, so a late accept (caller already timed out / failed) looked
    // recorded — the callee went in-call alone (ghost). `terminal: true`
    // tells the caller the accept did NOT land; `applied` tells it
    // whether the row now reflects the event.
    if (invite.status !== "ringing" && invite.status !== "accepted") {
      return { ok: true, applied: false, terminal: true };
    }
    // Audit-2 M38: the row is the cross-tab arbiter. `accepted` on an
    // already-`accepted` row means another tab took the call in the
    // same instant (BroadcastChannel can't close a sub-task window) —
    // the second accept must NOT land: the caller would get a second
    // answer and the media could flip to the losing tab's stream.
    // `alreadyAccepted` tells the loser to unwind quietly (no signals,
    // no in-call). A single tab can never hit this: acceptCall runs
    // once per call (its guard + the ringing status).
    if (data.event === "accepted" && invite.status === "accepted") {
      return { ok: true, applied: false, terminal: false, alreadyAccepted: true };
    }
    // Audit-2 M39: `declined` on an already-`accepted` row must NOT
    // flip a live call's row to "declined" — the busy-decline path
    // (another tab in-call, this tab gets the same invite) would
    // corrupt the row of a call the sibling tab already accepted.
    // Same alreadyAccepted signal: the decliner unwinds quietly.
    if (data.event === "declined" && invite.status === "accepted") {
      return { ok: true, applied: false, terminal: false, alreadyAccepted: true };
    }
    // Audit-3 A8-N8: the UPDATE is conditional on the status the
    // read enforced — two concurrent reports (two tabs: accept +
    // decline) used to both read `ringing`, both pass the checks,
    // and both claim applied:true while last-writer-won. Now the
    // loser’s UPDATE affects 0 rows and re-reads to learn which
    // outcome actually landed (accepted → alreadyAccepted,
    // terminal → terminal:true).
    const fromStatuses =
      data.event === "ended" ? ["ringing", "accepted"] : ["ringing"];
    const { data: updatedRows, error: updateError } = await supabaseAdmin
      .from("call_invites")
      .update({ status: data.event })
      .eq("id", data.callId)
      .in("status", fromStatuses)
      .select("id");
    if (updateError) return { ok: false, applied: false, terminal: false };
    if (updatedRows && updatedRows.length > 0) {
      return { ok: true, applied: true, terminal: false };
    }
    // 0 rows: a concurrent report committed first — re-read to
    // report the outcome that actually landed.
    const { data: current } = await supabaseAdmin
      .from("call_invites")
      .select("status")
      .eq("id", data.callId)
      .maybeSingle();
    if (!current) return { ok: false, applied: false, terminal: false };
    if (current.status === "accepted" && data.event !== "ended") {
      return { ok: true, applied: false, terminal: false, alreadyAccepted: true };
    }
    if (current.status === "declined" || current.status === "ended") {
      return { ok: true, applied: false, terminal: true };
    }
    return { ok: true, applied: false, terminal: false };
  });

/**
 * Audit-2 L49: delete the caller's OWN call-history rows — one row
 * ({id}) or all of them ({all: true}). The calls table had no delete
 * path at all (no policy, no fn), so history was append-only.
 * Ownership is enforced by the explicit user_id match on the admin
 * client (bypasses RLS — the §L49 `calls_delete_own` policy covers
 * direct PostgREST deletes) + the affected-row check: a single
 * delete that matches 0 rows is someone else's row (or a stale id),
 * and throws instead of silently "succeeding".
 */
export const deleteCallHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid().optional(),
        all: z.literal(true).optional(),
      })
      .refine((v) => (v.id ? !v.all : !!v.all), {
        message: "Pass exactly one of id or all.",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = supabaseAdmin.from("calls").delete().eq("user_id", context.userId);
    if (data.id) q = q.eq("id", data.id);
    const { data: deleted, error } = await q.select("id");
    if (error) throw dbErr(error, "Could not delete call history — please try again.");
    if (data.id && (deleted ?? []).length === 0) {
      throw new Error("Call not found.");
    }
    return { deleted: (deleted ?? []).length };
  });

/**
 * Participant-only read of a call invite's status — used by the receiver
 * to verify an accept / decline / end signal (C4). `tableMissing` is
 * true when the call_invites table doesn't exist yet; the receiver then
 * fails open (pre-C4 behaviour) instead of dropping a real call.
 */
export const getCallStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ callId: z.string().min(1).max(100) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: invite, error } = await supabaseAdmin
      .from("call_invites")
      .select("caller_id, callee_id, status")
      .eq("id", data.callId)
      .maybeSingle();
    if (error) {
      const tableMissing =
        error.code === "PGRST205" || /does not exist/i.test(error.message ?? "");
      return { status: null, callerId: null, calleeId: null, tableMissing };
    }
    if (!invite) {
      return { status: null, callerId: null, calleeId: null, tableMissing: false };
    }
    if (invite.caller_id !== context.userId && invite.callee_id !== context.userId) {
      return { status: null, callerId: null, calleeId: null, tableMissing: false };
    }
    return {
      status: invite.status as "ringing" | "accepted" | "declined" | "ended",
      callerId: invite.caller_id,
      calleeId: invite.callee_id,
      tableMissing: false,
    };
  });

/**
 * Audit-4 M10 (replaces the old H34 rule): invite freshness must
 * cover the caller's FULL legitimate ring window, not just 30s
 * from row creation. The row is created BEFORE startCall; the
 * caller's ring timeout is re-armed at the OFFER, and the offer
 * can go out up to ~30s later (the mic/camera prompt is capped
 * by the first ring timeout — A5-N3). So the caller can
 * legitimately ring until ~60s after row creation; the old 30s
 * freshness made a callee recovering at row-age 32s (slow prompt:
 * offer at 25s, caller rings to 55s) get "call already ended"
 * from getCallInvite / getPendingInvites for a LIVE call.
 * 75s = 30s prompt cap + 30s ring + 15s setup/signal margin.
 * The row's status check still gates recovery (a caller that
 * timed out reported "ended"), so the extra window only matters
 * when the caller couldn't report (crash) — and the accept path
 * still fails safe there (offer wait → failed, H17 guards the
 * row). (The 60s in assertCanCall's rate-limit window is a
 * separate per-minute limit — not freshness — and stays.)
 */
const CALL_INVITE_FRESHNESS_MS = 75_000;

export const notifyIncomingCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        peerId: z.string().uuid(),
        callId: z.string().min(1).max(100),
        type: z.enum(["voice", "video"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const callerId = context.userId;
    // Audit-4 L64: attempt limiter FIRST (A8-N9 pattern, like
    // createCallInvite) — the old order ran assertCanCall (up to ~4
    // admin queries) before throttling, so a flood burned the
    // expensive gate on every attempt before being stopped.
    // Audit-2 H29: rate-limit notify ATTEMPTS per (caller, callee)
    // pair — 10 per 60s. assertCanCall's row-count limit never tripped
    // on a reused callId (the ignoreDuplicates upsert below creates no
    // new row), so a fixed callId in a loop sent unlimited pushes and
    // buzzed the victim's phone forever. Attempts are counted, not
    // rows. Same atomic RPC as H4's limiter (fail CLOSED on RPC
    // error — Audit-4 H7). The legit flow calls notify once per call, so 10
    // per minute per callee is generous.
    await checkRateLimitKey(`call-notify:${callerId}:${data.peerId}`, 10, 60);
    // Audit-5 B1-MEDIUM: GLOBAL per-caller attempt cap. The per-pair
    // limiter above mints a fresh bucket whenever the caller rotates
    // peerIds, and assertCanCall's per-caller cap counts invite ROWS
    // — it fails open when call_invites is missing (pre-SQL world)
    // and only ever bounds row creation, not pushes. Counting
    // ATTEMPTS per caller via the same atomic RPC caps a
    // fresh-callId + rotating-peer loop at 10 pushes/min TOTAL in
    // every table state. The legit flow notifies once per call, so
    // 10/min is generous.
    await checkRateLimitKey(`call-notify-global:${callerId}`, 10, 60);
    // H26: privacy + self-call + rate-limit gate (see assertCanCall).
    // Defense in depth: createCallInvite already gates, but notify is
    // independently callable, so it gates too.
    await assertCanCall(callerId, data.peerId);
    // Audit-2 M62: privacy-filtered caller name (see callerNameForCallee).
    const callerName = await callerNameForCallee(callerId, data.peerId);

    // Record the pending invite (insert-if-absent: a retried notify must not
    // clash). MUST NOT overwrite an existing row: createCallInvite already
    // wrote it as "ringing", and the callee may since have reported
    // "accepted" — a plain upsert here would regress the status back to
    // "ringing" and the caller's accept verification (C4) would drop a
    // real accept. Tolerant: if vibetalk-call-invites.sql hasn't run yet,
    // the row is skipped but the push below still goes out (closed-app
    // pickup is the only part that needs the table).
    // Audit-4 M11: the upsert carries a fresh secret, and a pre-existing
    // secret-less row (written by a notify before this fix, or by a
    // concurrent writer) is backfilled with the A8-N7 pattern. A
    // secret-less row could never be healed by createCallInvite — the
    // provider never retries create for the same callId after H1 — so
    // the callee rang for a call whose offer MAC could never verify
    // (offer dropped, accept failed, misleading "declined"). The
    // secret is returned so a caller that notifies before starting
    // can MAC with the stored secret. An existing secret is never
    // overwritten (ignoreDuplicates + conditional backfill).
    let rowSecret: string | null = null;
    // Audit-4 M15: the row's status (null = no row / table missing).
    let rowStatus: string | null = null;
    try {
      const secret = generateCallSecret();
      await supabaseAdmin.from("call_invites").upsert(
        {
          id: data.callId,
          caller_id: callerId,
          callee_id: data.peerId,
          caller_name: callerName,
          type: data.type,
          status: "ringing",
          secret,
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      const { data: row, error: rowError } = await supabaseAdmin
        .from("call_invites")
        .select("caller_id, callee_id, secret, status")
        .eq("id", data.callId)
        .maybeSingle();
      // Audit-6 B-I2: an ERRORED read used to be indistinguishable
      // from "no row" — row stayed null, rowStatus stayed null, and
      // the M15 no-re-ring guard below treated it as the missing-
      // table case and fanned the push out: a transient DB error
      // re-rang a call that had already ended. Now: a missing TABLE
      // (pre-SQL) still fails open per C2; any OTHER read error
      // means the status is UNKNOWN — do not ring.
      if (rowError) {
        const tableMissing =
          (rowError as { code?: string }).code === "PGRST205" ||
          /does not exist/i.test(rowError.message ?? "");
        if (!tableMissing) {
          console.warn(
            "[call] notifyIncomingCall: invite read-back failed — not ringing (status unknown).",
          );
          return { ok: true, pushed: false, secret: null };
        }
      }
      // Audit-5 B1-HIGH: ownership check (createCallInvite's pattern).
      // ignoreDuplicates leaves a FOREIGN row untouched, so without
      // this check the read-back below would hand the victim pair's
      // per-call HMAC secret to whoever supplies their callId —
      // callIds are broadcast in plaintext on the public
      // call:<userId> Realtime channel. A mismatch = hijack attempt
      // (or a client bug reusing a foreign callId): leak nothing,
      // push nothing, backfill nothing.
      if (row && (row.caller_id !== callerId || row.callee_id !== data.peerId)) {
        console.warn(
          `[call] notifyIncomingCall: callId ${data.callId} is owned by another pair — rejecting (no secret, no push).`,
        );
        return { ok: false, pushed: false, secret: null };
      }
      if (row) rowStatus = row.status ?? null;
      if (row && row.secret == null) {
        await supabaseAdmin
          .from("call_invites")
          .update({ secret })
          .eq("id", data.callId)
          .is("secret", null);
        const { data: refilled } = await supabaseAdmin
          .from("call_invites")
          .select("secret, status")
          .eq("id", data.callId)
          .maybeSingle();
        rowSecret = refilled?.secret ?? null;
        if (refilled) rowStatus = refilled.status ?? null;
      } else {
        rowSecret = row?.secret ?? null;
      }
    } catch {
      // Invite persistence failed — push still goes out below.
    }

    // Audit-4 M15: a replayed notify for a call the callee already
    // took (accepted / declined / ended) must not re-ring the phone.
    // The ignoreDuplicates upsert leaves a terminal row untouched,
    // but the old code never read the row back and fanned the push
    // out unconditionally. A missing row (rowStatus null — table
    // missing, pre-SQL world) still pushes (fail-open, as before).
    if (rowStatus !== null && rowStatus !== "ringing") {
      return { ok: true, pushed: false, secret: rowSecret };
    }

    // Fan the push out to the callee's devices.
    try {
      const vapidPublic = process.env.VAPID_PUBLIC_KEY;
      const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
      if (!vapidPublic || !vapidPrivate) return { ok: true, pushed: false, secret: rowSecret };
      // Audit-2 M59: the subs-query error was swallowed (error not
      // even destructured, and the outer catch returned pushed:false
      // with no log) — a failed query silently sent no call push.
      // Log with the call id and return pushed:false (the caller
      // gets the signal via the return value; the Realtime invite
      // already went, so the call itself is unaffected).
      const { data: subs, error: subsError } = await supabaseAdmin
        .from("push_subscriptions")
        .select("endpoint, p256dh, auth, user_id")
        .eq("user_id", data.peerId);
      if (subsError) {
        console.warn(
          "[notifyIncomingCall] push_subscriptions query failed — no call push sent:",
          subsError.message,
        );
        return { ok: true, pushed: false, secret: rowSecret };
      }
      if (!subs || subs.length === 0) return { ok: true, pushed: false, secret: rowSecret };
      const { sendWebPush, vapidSubject } = await import("@/lib/webpush-send.server");
      // Audit-4 L31: honor the callee's preview preference (L70) —
      // the old code always sent the caller's name in the body,
      // ignoring show_notification_previews. Previews OFF gets a
      // nameless payload (title "VibeTalk", body "Incoming call"
      // — a call, not a message, so NOTIFICATION_PREVIEW_HIDDEN
      // would be wrong) with Pick/Reject still actionable; the app
      // reveals the caller once the user acts. fromName is omitted
      // (it is identifying and unused downstream — the tap handler
      // + client read identity from the invite row). `from` stays
      // (a UUID alone identifies nobody, and the tap handler needs
      // it). Lookup mirrors M22: retry a transient failure once,
      // 42703 (column missing, pre-SQL) fails open immediately, a
      // persistent failure fails open with a warning (a missed
      // hidden-preview beats a missed/delayed ring).
      let previewsOff = false;
      {
        let prefRow: { show_notification_previews?: boolean | null } | null = null;
        let prefsError: { message?: string; code?: string } | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          prefsError = null;
          const { data: row, error } = await supabaseAdmin
            .from("profiles")
            .select("show_notification_previews")
            .eq("id", data.peerId)
            .maybeSingle();
          prefRow = row;
          prefsError = error;
          if (!prefsError || prefsError.code === "42703") break;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 100));
        }
        if (prefsError) {
          console.warn(
            "[notifyIncomingCall] preview-preference lookup failed — sending full preview:",
            prefsError.message,
          );
        } else if (prefRow?.show_notification_previews === false) {
          previewsOff = true;
        }
      }
      const payload = JSON.stringify({
        title: previewsOff ? "VibeTalk" : data.type === "video" ? "Incoming video call" : "Incoming voice call",
        body: previewsOff ? "Incoming call" : `${callerName} is calling…`,
        tag: `hcroom-call-${data.callId}`,
        kind: "incoming-call",
        callId: data.callId,
        from: callerId,
        fromName: previewsOff ? null : callerName,
        callType: data.type,
        // Pick / Reject actions, vibration, NOT silent. requireInteraction
        // keeps the notification up while the phone rings.
        actions: [
          { action: "accept", title: "Pick" },
          { action: "decline", title: "Reject" },
        ],
        vibrate: [200, 100, 200, 100, 200, 100, 400],
        silent: false,
        requireInteraction: true,
      });
      await Promise.allSettled(
        subs.map(async (s) => {
          const result = await sendWebPush(
            { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
            payload,
            {
              publicKey: vapidPublic,
              privateKey: vapidPrivate,
              subject: vapidSubject(), // M72: was a hardcoded literal
            },
            30, // H34: 30s TTL = the ring timeout. A call invite push
              // delivered after 30s would wake the user for a dead call.
          );
          // Audit-2 H21: delete ONLY on 404/410. 401/403 also fires
          // for server-side problems (bad VAPID key / subject / clock
          // skew) — deleting on it wiped every subscription in one
          // sweep on a single bad deploy. Row kept + logged instead.
          if (!result.ok && (result.status === 404 || result.status === 410)) {
            // Audit-2 M49: scope the delete to THIS user's row (same
            // shared-browser / same-endpoint reason as notifyNewMessage).
            await supabaseAdmin
              .from("push_subscriptions")
              .delete()
              .eq("endpoint", s.endpoint)
              .eq("user_id", s.user_id);
          } else if (!result.ok && (result.status === 401 || result.status === 403)) {
            console.warn(
              `[push] VAPID auth failed (HTTP ${result.status}) on call push — subscription kept, not deleted. Check VAPID keys / subject / server clock.`,
            );
          }
        }),
      );
      return { ok: true, pushed: true, secret: rowSecret };
    } catch (err) {
      // Push failure never breaks the call — the Realtime invite went.
      // Audit-4 L32: the old catch swallowed everything with NO log,
      // so a failed fan-out (dynamic-import failure, a throwing
      // vapidSubject, a throwing prefs lookup) was invisible. Log it
      // with the call id; the return value is unchanged (best-effort).
      console.warn(
        "[notifyIncomingCall] call push fan-out failed — the Realtime invite still went (callId, callee):",
        data.callId,
        data.peerId,
        err instanceof Error ? err.message : err,
      );
      return { ok: true, pushed: false, secret: rowSecret };
    }
  });

/**
 * Fetch a still-ringing invite for the callee. Only invites < 30s old and
 * still "ringing" count — anything older is a dead call the caller already
 * timed out of. Returns null when there is nothing live to pick up.
 */
export const getCallInvite = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ callId: z.string().min(1).max(100) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: invite, error } = await supabaseAdmin
      .from("call_invites")
      .select("id, caller_id, callee_id, caller_name, type, status, created_at, secret")
      .eq("id", data.callId)
      .eq("callee_id", context.userId)
      .maybeSingle();
    if (error) {
      // Distinguish "table doesn't exist yet" (fail open — pre-C4 behaviour)
      // from "no such invite" (fail closed — drop a spoofed invite).
      const tableMissing =
        error.code === "PGRST205" || /does not exist/i.test(error.message ?? "");
      return { invite: null, tableMissing };
    }
    if (!invite) return { invite: null, tableMissing: false };
    if (invite.status !== "ringing") return { invite: null, tableMissing: false };
    const ageMs = Date.now() - new Date(invite.created_at).getTime();
    if (ageMs > CALL_INVITE_FRESHNESS_MS) return { invite: null, tableMissing: false };
    return {
      invite: {
        callId: invite.id,
        from: invite.caller_id,
        fromName: invite.caller_name,
        type: invite.type as "voice" | "video",
        // Audit-2 C1: the per-call HMAC secret. Participant-only (this
        // fn already filters callee_id = caller), so the callee can
        // verify the caller's offer/answer/ice MACs. NULL for rows
        // created before the §C1 SQL ran -> the engine fails closed.
        secret: (invite.secret as string | null) ?? null,
      },
      tableMissing: false,
    };
  });

/**
 * WhatsApp-style call entry inside the chat thread. The CALLER posts exactly
 * one `type: "call"` message per finished call (missed / attended + duration).
 * The client (CallProvider) only calls this for outgoing calls, so one call
 * yields one entry. DM-only: calls are 1:1.
 *
 * A push goes out only for "missed" — the callee needs to know they missed
 * one; a completed call needs no post-call ping. A 5s per-room guard mirrors
 * sendMessage's rate limiter so a client can't spam fake call entries.
 */
export const postCallMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        roomId: z.string().uuid(),
        // M23: the callId of the finished call — must match a real
        // invite row. (Not z.string().uuid(): newCallId falls back to
        // `call-<ts>-<rand>` when crypto.randomUUID is unavailable.)
        callId: z.string().min(1).max(100),
        type: z.enum(["voice", "video"]),
        // Audit-2 M40: "cancelled" — the caller aborted while ringing
        // (not a miss). No missed-call push for it; the chat entry
        // reads "Cancelled voice call".
        status: z.enum(["completed", "missed", "declined", "failed", "cancelled"]),
        durationSeconds: z.number().int().min(0).max(24 * 3600),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const { data: room, error: roomError } = await supabaseAdmin
      .from("rooms")
      .select("id, is_dm")
      .eq("id", data.roomId)
      .maybeSingle();
    if (roomError || !room) throw new Error("Room not found.");
    if (!room.is_dm) throw new Error("Call entries are only posted to direct chats.");
    const { data: membership } = await supabaseAdmin
      .from("room_members")
      .select("user_id")
      .eq("room_id", data.roomId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) throw new Error("You are not a member of this chat.");

    // Audit-4 L64: the cheap 5s duplicate guard runs FIRST — the old
    // order ran the full invite-proof reads (invite + members +
    // checks) before it, so a rapid re-post burned the proof
    // queries. A re-post within 5s is rejected here without them.
    // Truly concurrent posts can still both pass this guard; the
    // 23505 call_id unique index below is the real dedupe (pre-SQL
    // both may insert — the finding's stated residual).
    // 5s per-room guard against fake-entry spam (best-effort).
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    const { data: recent } = await supabaseAdmin
      .from("messages")
      .select("id")
      .eq("room_id", data.roomId)
      .eq("user_id", userId)
      .eq("type", "call")
      .gte("created_at", fiveSecondsAgo)
      .limit(1);
    if (recent && recent.length > 0) {
      throw new Error("Please wait before posting another call update.");
    }

    // M23: proof a call actually happened — the callId must match a
    // real invite row created by this user (createCallInvite). Without
    // this, any DM member could fabricate Missed/Completed/Failed
    // entries with arbitrary durations. Terminal status is NOT
    // required: the timeout path reports "ended" fire-and-forget, so
    // the row may still read "ringing" when this post lands — the
    // invite's EXISTENCE + caller match is the proof a call was made.
    // Fail open ONLY when the table itself is missing (pre-SQL state),
    // matching C4's tableMissing pattern — the call still happened.
    //
    // Audit-2 M2: the proof was caller-only. It now also binds the
    // invite to THIS DM (callee = the room's other member), to the
    // claimed call type, and to a sane freshness window — a week-old
    // invite, or an invite for a call with user W, no longer "proves"
    // an entry in user V's DM. The claimed status/duration are then
    // checked against the invite's SERVER-TRUSTED state (the calls
    // history row is NOT used: the caller writes it via RLS with
    // self-reported values, so deriving from it adds no trust — the
    // invite row, created by createCallInvite, is the only trusted
    // source). The server never sees media, so it cannot verify a
    // duration directly — but it CAN reject provably-false claims:
    // a completed call cannot outlast the invite, and a missed /
    // declined call never connected (duration 0).
    const { data: invite, error: inviteError } = await supabaseAdmin
      .from("call_invites")
      .select("id, caller_id, callee_id, type, status, created_at")
      .eq("id", data.callId)
      .maybeSingle();
    const tableMissing =
      inviteError?.code === "PGRST205" || /does not exist/i.test(inviteError?.message ?? "");
    if (inviteError && !tableMissing) throw dbErr(inviteError, "Could not save the call entry — please try again.");
    if (!tableMissing) {
      if (!invite) throw new Error("No matching call found for this entry.");
      if (invite.caller_id !== userId) {
        throw new Error("This call entry does not belong to you.");
      }
      // M2: the invite's callee must be THIS DM's other member.
      const { data: members } = await supabaseAdmin
        .from("room_members")
        .select("user_id")
        .eq("room_id", data.roomId);
      const other = (members ?? []).find((m) => m.user_id !== userId);
      if (!other || invite.callee_id !== other.user_id) {
        throw new Error("This call was not with this chat.");
      }
      // M2: the invite's type must match the claimed entry type.
      if (invite.type !== data.type) {
        throw new Error("Call type does not match the call.");
      }
      // M2: freshness — the invite must be from the last 24h. A
      // week-old invite must not "prove" an entry today.
      const inviteAgeMs = Date.now() - new Date(invite.created_at).getTime();
      if (inviteAgeMs > 24 * 3600 * 1000) {
        throw new Error("This call is too old to post an entry for.");
      }
      // M2: status/duration consistency against the invite's state.
      // Audit-2 M40: "cancelled" is allowed from "ringing" (the
      // caller's end-report may have failed to land) and from
      // "ended" (the normal path: endCall reports "ended" first).
      // A cancelled call never connected, so its duration is 0.
      const allowedByInviteStatus: Record<string, string[]> = {
        ringing: ["missed", "failed", "cancelled"],
        accepted: ["completed", "failed"],
        declined: ["declined"],
        ended: ["completed", "missed", "failed", "cancelled"],
      };
      const allowed = allowedByInviteStatus[invite.status] ?? [];
      if (!allowed.includes(data.status)) {
        throw new Error(
          `A call in state "${invite.status}" cannot end as "${data.status}".`,
        );
      }
      if (
        (data.status === "missed" || data.status === "declined" || data.status === "cancelled") &&
        data.durationSeconds !== 0
      ) {
        throw new Error("A missed, declined or cancelled call has no duration.");
      }
      if (data.status === "completed" || data.status === "failed") {
        const elapsedSeconds = Math.floor(inviteAgeMs / 1000);
        if (data.durationSeconds > elapsedSeconds) {
          throw new Error("Call duration cannot exceed the time since the call started.");
        }
      }
    } else {
      console.warn("[postCallMessage] call_invites table missing — skipping invite proof (pre-SQL).");
    }

    const body = JSON.stringify({
      call: data.type,
      status: data.status,
      duration: data.durationSeconds,
    });
    // Audit-2 M2: one call entry per callId — enforced by the partial
    // unique index on messages.call_id (§M2 SQL). A duplicate post for
    // the same callId hits 23505 and is rejected (the old 5s throttle
    // above stays as a spam guard). Pre-SQL (column missing -> 42703)
    // the insert is retried without call_id — dedupe unenforced, same
    // as today's behaviour.
    const insertRow = {
      room_id: data.roomId,
      user_id: userId,
      body,
      type: "call" as const,
      call_id: data.callId,
    };
    let insertError = (await supabaseAdmin.from("messages").insert(insertRow)).error;
    if (insertError?.code === "23505") {
      throw new Error("A call entry for this call already exists.");
    }
    if (insertError?.code === "42703") {
      const { call_id: _dropped, ...legacyRow } = insertRow;
      insertError = (await supabaseAdmin.from("messages").insert(legacyRow)).error;
    }
    if (insertError) throw dbErr(insertError, "Could not save the call entry — please try again.");

    // Only a missed call pings the callee — they need to know they missed
    // one. Completed/declined/failed need no post-call notification.
    // Audit-2 M40: a CANCELLED call pings nobody — the caller
    // deliberately aborted it, so a "missed call" push would be a lie.
    if (data.status === "missed") {
      await notifyNewMessage(
        data.roomId,
        userId,
        `📞 Missed ${data.type} call`,
        300, // H34: 5-min TTL — a missed-call ping delivered hours later is stale.
      ).catch(() => undefined);
    }
    return { ok: true };
  });

/**
 * Live incoming calls for the current user. The app checks this on open so
 * a ringing call is recovered NO MATTER how the app was opened — via the
 * call notification, a message notification, or manually. Without this, a
 * callee who opened the app any other way mid-call saw no Pick/Decline.
 * Only fresh (within CALL_INVITE_FRESHNESS_MS) still-ringing invites count; anything older is a call
 * the caller already timed out of.
 */
export const getPendingInvites = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // H27: sweep dead invite rows (best-effort) — the table would
    // otherwise grow by one row per call forever.
    await cleanupStaleCallInvites();
    const { data, error } = await supabaseAdmin
      .from("call_invites")
      .select("id, caller_id, caller_name, type, status, created_at, secret")
      .eq("callee_id", context.userId)
      .eq("status", "ringing")
      .order("created_at", { ascending: false })
      .limit(3);
    if (error || !data) return { invites: [] };
    // Audit-4 M10: same boundary as getCallInvite (fresh iff
    // age <= freshness) — the two fns used opposite strictness
    // at exactly the freshness boundary.
    const fresh = data.filter(
      (i) => Date.now() - new Date(i.created_at).getTime() <= CALL_INVITE_FRESHNESS_MS,
    );
    return {
      invites: fresh.map((i) => ({
        callId: i.id,
        from: i.caller_id,
        fromName: i.caller_name,
        type: i.type as "voice" | "video",
        // Audit-2 C1: per-call HMAC secret (see getCallInvite).
        secret: (i.secret as string | null) ?? null,
      })),
    };
  });

/**
 * Audit-2 M74: the server's runtime Supabase identity — PUBLIC values
 * only (URL host + project ref), deliberately UNAUTHENTICATED. An
 * authenticated health fn cannot report cross-project drift: the
 * auth middleware validates the token against the SERVER's project,
 * so with drift the call itself fails before the handler runs. The
 * client compares this against its baked VITE_* values (see
 * detectSupabaseDrift) and toasts on mismatch. No keys, no secrets —
 * the project ref is already baked into the client bundle.
 */
/**
 * Audit-4 L44: the DB clock that writes `last_seen_at` — NOT the
 * app server's clock. The old code returned the TanStack/Worker
 * `Date.now()`, and if the app-server clock differed from
 * Supabase's, the skew correction was off by the difference.
 * The PostgREST `Date` header is stamped by the Supabase stack
 * (same host/NTP as Postgres), so it tracks the DB clock.
 * `res.ok` is deliberately NOT checked: even an error response
 * carries a Date header, and the header is all we want (the
 * body is never read). Falls back to the app-server clock when
 * the service key is missing, the URL is missing, the header is
 * absent/unparseable, or the fetch fails. Never throws: the
 * drift check must work even when the service key is missing.
 */
// Audit-6 B-I3: 10s cache for the DB-clock fetch (see dbNowMs).
let dbNowCache: { value: number; fetchedAt: number } | null = null;
const DB_NOW_CACHE_MS = 10_000;

async function dbNowMs(supabaseUrl: string | null): Promise<number> {
  // Audit-6 B-I3: getServerSupabaseConfig is unauthenticated and
  // runs on every app load; an uncached live fetch made it a 1:1
  // request-amplification proxy to the project's REST API. A cache
  // hit advances the stamped server time by the elapsed client
  // time, so the value stays a faithful "now" (both clocks tick at
  // the same rate — the SKEW is what callers consume). Only a
  // successfully parsed stamp is cached; failures fall back
  // uncached and retry on the next call.
  if (dbNowCache && Date.now() - dbNowCache.fetchedAt < DB_NOW_CACHE_MS) {
    return dbNowCache.value + (Date.now() - dbNowCache.fetchedAt);
  }
  const fallback = Date.now();
  try {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return fallback;
    const res = await fetch(`${supabaseUrl}/rest/v1/`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    const parsed = Date.parse(res.headers.get("date") ?? "");
    if (!Number.isFinite(parsed)) return fallback;
    dbNowCache = { value: parsed, fetchedAt: Date.now() };
    return parsed;
  } catch {
    return fallback;
  }
}

export const getServerSupabaseConfig = createServerFn({ method: "GET" }).handler(async () => {
  const url = process.env.SUPABASE_URL ?? null;
  let urlHost: string | null = null;
  try {
    urlHost = url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    urlHost = null;
  }
  // Audit-2 L69: the server's wall clock — the client compares it
  // against its own clock to correct presence staleness (see
  // setClockSkew in presence.ts).
  // Audit-4 L44: the DB clock (dbNowMs), not the app-server clock.
  return {
    supabaseUrlHost: urlHost,
    projectRef: supabaseProjectRef(url),
    serverNowMs: await dbNowMs(url),
  };
});

/**
 * M29: one-time setup-health check. The pending SQL (calls,
 * call_invites, typing_status tables; message_type 'call') is required
 * for call history, closed-app pickup, typing indicators, and call
 * chat entries — but every consumer fails open (pre-SQL state), so
 * without this check the degradation is silent. The client calls this
 * once per app load and surfaces a warning toast listing what's
 * missing, instead of silently skipping. Probes are read-only; a
 * missing-table / invalid-enum error means the SQL hasn't run; any
 * other error is treated as unknown (no false alarm).
 */
export const getSetupHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    // Audit-2 L91: the old version returned the missing table/enum
    // NAMES to any authenticated user (info disclosure — the _app
    // toast printed them). The names now stay server-side (the
    // console.warn below); the client only learns a COUNT + whether
    // setup is incomplete, which is all the toast needs.
    const missingCount = await (async () => {
      let count = 0;
      const isMissingTable = (err: { code?: string; message?: string } | null) =>
        !!err && (err.code === "PGRST205" || /relation .* does not exist/i.test(err.message ?? ""));
      const [callsRes, invitesRes, typingRes, enumRes, rateLimitRes] = await Promise.all([
        supabaseAdmin.from("calls").select("*").limit(1),
        supabaseAdmin.from("call_invites").select("*").limit(1),
        supabaseAdmin.from("typing_status").select("*").limit(1),
        // Enum probe: filtering messages by type 'call' errors with
        // "invalid input value for enum" if the 'call' value is missing.
        supabaseAdmin.from("messages").select("*").eq("type", "call").limit(1),
        // Audit-2 H4: rate_limits table (join rate limiting).
        supabaseAdmin.from("rate_limits").select("*").limit(1),
      ]);
      const names: string[] = [];
      if (isMissingTable(callsRes.error)) names.push("calls table (call history)");
      if (isMissingTable(invitesRes.error)) names.push("call_invites table (closed-app call pickup)");
      if (isMissingTable(typingRes.error)) names.push("typing_status table (typing indicators)");
      if (enumRes.error && /invalid input value for enum/i.test(enumRes.error.message ?? "")) {
        names.push("message_type 'call' (call entries in chat)");
      }
      if (isMissingTable(rateLimitRes.error)) names.push("rate_limits table (join rate limiting)");
      count = names.length;
      if (count > 0) {
        console.warn("[setup-health] pending database setup — missing:", names.join(", "));
      }
      return count;
    })();
    return { missing: [] as string[], incomplete: missingCount > 0, missingCount };
  });

/**
 * Permanently delete the requester's own account. The client must first
 * complete a Supabase email-code reauthentication (reauthenticate() +
 * verifyOtp type "reauthentication") — the server requires a fresh OTP
 * entry in the JWT `amr` claim (within 10 min), so a stolen/old session
 * alone cannot delete the account, and nobody can ever delete anyone
 * else's account (only the requester's own userId is used).
 *
 * Data: profile + memberships (user leaves all rooms; rooms they created
 * keep existing, like WhatsApp groups) + push subs + call invites/history
 * + avatar files. Messages and chat attachments stay — they belong to
 * shared conversations. Finally the auth user itself is deleted.
 */
export const deleteMyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.userId;
    const claims = context.claims as unknown as {
      amr?: Array<{ method?: unknown; timestamp?: unknown }>;
    };
    const amr = Array.isArray(claims?.amr) ? claims.amr : [];
    // Audit-3 A8-N28: the age check needs a LOWER bound too — a
    // future timestamp (issuer/server clock skew) yields a negative
    // age that used to pass. Require 0 <= age < 600.
    const freshOtp = amr.some((a) => {
      if (a?.method !== "otp" || typeof a?.timestamp !== "number") return false;
      const ageSeconds = Date.now() / 1000 - a.timestamp;
      return ageSeconds >= 0 && ageSeconds < 600;
    });
    if (!freshOtp) {
      throw new Error(
        "Please verify the email code first — it proves this is really you.",
      );
    }

    // Audit-2 M3: DELETE FIRST, cleanup after. The old code deleted
    // profile / memberships / push rows BEFORE deleteUser — if
    // deleteUser then failed, the account survived with its data
    // gone (irreversible). Now:
    //   1. Record owned room ids (READ-ONLY — no writes yet).
    //   2. deleteUser. On failure NOTHING has changed (profile,
    //      memberships, creatorship all intact).
    //   3. Only on success: transfer owned rooms + delete avatar
    //      files. Failures are RETURNED (not just console.warn) so
    //      the client can tell the user what survived.
    // DB rows need NO manual cleanup: every user-scoped table
    // cascades from auth.users — profiles, room_members, messages
    // (and reactions via messages), read_receipts, typing_status,
    // push_subscriptions, calls, call_invites, user_roles;
    // rooms.created_by is SET NULL. tokens.used_by is ALSO SET NULL —
    // which is why the consumed-token revoke below runs BEFORE
    // deleteUser (Audit-3 A2-N4): after the delete the tokens are
    // unidentifiable and a consumed one-time token would resurrect
    // (used_by NULL → redeemable again). The old manual
    // deletes are deleted: they added risk (wrong order) without
    // safety, and MISSED message_reactions + read_receipts (both
    // cascade-covered anyway).
    //
    // CORRECTION (audit missed this; the old dialog copy was wrong):
    // messages.user_id is ON DELETE CASCADE, so the user's messages
    // — AND replies to them (parent_id CASCADE) — ARE deleted with
    // the account. The old "past messages stay" promise was false.
    // The dialog now says so. Preserving messages (user_id SET NULL
    // + "Deleted user" rendering) is a separate product decision, not
    // part of M3 — it needs a schema change + NULL-sender handling in
    // every message render path.
    const { data: ownedRooms, error: ownedError } = await supabaseAdmin
      .from("rooms")
      .select("id")
      .eq("created_by", userId);
    // Audit-4 L63: FAIL CLOSED — the old `?? []` silently skipped
    // the ownership transfer below on a transient read failure
    // (rooms left created_by=NULL; the oldest-member fallback
    // mitigates, but the transfer is the contract). A failed
    // pre-delete read aborts BEFORE deleteUser (M3 ordering:
    // nothing has changed, retry is safe), never silently
    // degrades the cleanup.
    if (ownedError) throw dbErr(ownedError, "Could not delete your account — please try again.");
    const ownedRoomIds = (ownedRooms ?? []).map((r) => r.id);
    // Audit-3 A4-N2 (part b): record EVERY room the user is a member
    // of (read-only, M3-compatible) — after deleteUser the membership
    // rows cascade away, and rooms the user just emptied would
    // otherwise stay as inaccessible 0-member orphans. The cleanup
    // below deletes exactly those (M65 rule), so no memberless room
    // survives an account deletion.
    const { data: memberRooms, error: memberError } = await supabaseAdmin
      .from("room_members")
      .select("room_id")
      .eq("user_id", userId);
    // Audit-4 L63: FAIL CLOSED, same as ownedRooms above — the old
    // `?? []` silently skipped the orphan-room cleanup below on a
    // transient read failure, leaving 0-member rooms nobody can
    // ever open. Abort before deleteUser; retry is safe.
    if (memberError) throw dbErr(memberError, "Could not delete your account — please try again.");
    const memberRoomIds = (memberRooms ?? []).map((r) => r.room_id);
    // Audit-3 A8-N24: capture attachment paths BEFORE deleteUser.
    // The orphan-room cleanup below runs after the delete, by which
    // time the deleter's messages have cascade-deleted — re-listing
    // then returns [] and the orphan room's files would leak in
    // storage forever. Captured paths are used ONLY for rooms that
    // end up 0-member (deleted); surviving rooms' files stay, per
    // the dialog promise "Files or images you sent stay in shared
    // conversations."
    const prePathsByRoom = new Map<string, string[]>();
    for (const roomId of memberRoomIds) {
      prePathsByRoom.set(
        roomId,
        await listRoomAttachmentPaths(roomId).catch(() => [] as string[]),
      );
    }

    // (Invite tokens removed 2026-10-20: the Audit-3 A2-N4 pre-delete
    // token revoke that used to live here is gone with the system it
    // protected — the tokens table is dropped by
    // vibetalk-remove-invite-tokens.sql.)

    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) throw dbErr(error, "Could not delete your account — please try again.");

    // Post-delete cleanup (best-effort WITH reporting).
    const cleanupFailures: string[] = [];
    const attempt = async (label: string, fn: () => PromiseLike<unknown>) => {
      try {
        const res = await fn();
        const err = (res as { error?: unknown } | null)?.error;
        if (err) {
          console.warn(`[deleteMyAccount] cleanup failed (${label}):`, err);
          if (!cleanupFailures.includes(label)) cleanupFailures.push(label);
        }
      } catch (err) {
        console.warn(`[deleteMyAccount] cleanup failed (${label}):`, err);
        if (!cleanupFailures.includes(label)) cleanupFailures.push(label);
      }
    };
    // Ownership transfer: each owned room passes to its oldest
    // remaining member (same rule as leave-time transfer). A room
    // with no remaining members keeps created_by NULL (SET NULL by
    // the delete) and is removed by the orphan-room cleanup below
    // (M65 rule) — it is never left as a memberless orphan.
    for (const roomId of ownedRoomIds) {
      await attempt("room ownership transfer", async () => {
        const { data: next } = await supabaseAdmin
          .from("room_members")
          .select("user_id")
          .eq("room_id", roomId)
          .order("joined_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        // No remaining members -> nothing to transfer to; created_by
        // is already NULL from the delete.
        if (!next) return null;
        return supabaseAdmin.from("rooms").update({ created_by: next.user_id }).eq("id", roomId);
      });
    }
    // Audit-3 A4-N2 (part b): delete rooms this account just emptied.
    // leaveChat/removeRoomMember already apply the M65 rule (count 0
    // -> delete), but deleteMyAccount never did — a last-member
    // account deletion left a 0-member room nobody can ever open
    // (member-filtered queries) and, before part (a), any user could
    // delete it via the self-remove path. A4-N1 discipline: a failed
    // count query NEVER deletes (throw, don't treat null as 0).
    // Per-room failures are collected so one bad room doesn't skip
    // the rest; the label lands in cleanupFailures for the client.
    await attempt("orphan room cleanup", async () => {
      const failed: string[] = [];
      for (const roomId of memberRoomIds) {
        try {
          const { count, error: countError } = await supabaseAdmin
            .from("room_members")
            .select("user_id", { count: "exact", head: true })
            .eq("room_id", roomId);
          if (countError) throw dbErr(countError, "Could not delete your account — please try again.");
          if ((count ?? 0) !== 0) continue;
          // Audit-3 A8-N24: use the PRE-delete capture — the
          // messages table no longer holds these paths (cascade).
          const paths = prePathsByRoom.get(roomId) ?? [];
          await supabaseAdmin.from("rooms").delete().eq("id", roomId);
          const { failed: failedPaths } = await removeStoragePaths(paths);
          if (failedPaths > 0) {
            console.warn(
              `[deleteMyAccount] orphan room ${roomId} deleted but ${failedPaths} attachment(s) could not be released (orphaned).`,
            );
          }
        } catch {
          failed.push(roomId);
        }
      }
      if (failed.length > 0) throw new Error(`orphan cleanup failed for ${failed.length} room(s)`);
    });
    // Avatar files live in chat-attachments under <userId>/profile/.
    // Chat attachments (<userId>/<roomId>/…) are deliberately NOT
    // deleted — they belong to shared conversations (the dialog
    // promises sent files stay), and deleting them would break other
    // members' messages that reference those files.
    // M3: PAGINATE — the old single page (limit 100) left 100+
    // avatar files orphaned. Loop the FIRST page until empty (no
    // offset: each iteration removes a page, so the list shrinks).
    await attempt("avatar files", async () => {
      for (;;) {
        const { data: files, error: listError } = await supabaseAdmin.storage
          .from("chat-attachments")
          .list(`${userId}/profile`, { limit: 100 });
        if (listError) throw dbErr(listError, "Could not delete your account — please try again.");
        if (!files || files.length === 0) return null;
        const { error: removeError } = await supabaseAdmin.storage
          .from("chat-attachments")
          .remove(files.map((f) => `${userId}/profile/${f.name}`));
        if (removeError) throw dbErr(removeError, "Could not delete your account — please try again.");
        if (files.length < 100) return null;
      }
    });

    return { ok: true, cleanupFailures };
  });
