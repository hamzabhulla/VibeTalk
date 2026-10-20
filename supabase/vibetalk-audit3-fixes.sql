-- =====================================================================
-- VibeTalk — Audit-3 SQL fixes (run AFTER vibetalk-audit2-fixes.sql)
-- =====================================================================
-- Run order (all idempotent, safe to re-run):
--   1. supabase/vibetalk-all-pending.sql
--   2. supabase/vibetalk-audit-fixes.sql
--   3. supabase/vibetalk-audit2-fixes.sql
--   4. supabase/vibetalk-audit3-fixes.sql   <-- THIS FILE
--
-- MANDATORY: audit-3 code fixes that depend on this file's columns /
-- indexes degrade gracefully when it has NOT run (H16 pattern), but
-- the protections below do NOT apply until it has run.
-- =====================================================================

-- =====================================================================
-- §A4-N4 — sendMessage idempotency: unique index on messages.client_id
-- =====================================================================
-- Audit-3 A4-N4: a lost response after a successful insert duplicated
-- the message (client queued + re-sent with a new key). The client now
-- sends one idempotency key per logical message (outbox entry id, or
-- a fresh UUID per composer send); the server inserts with
-- client_id and treats a 23505 on it as "already sent" (returns the
-- existing row, no second push). NULLs are distinct in a Postgres
-- unique index, so legacy / key-less rows never conflict.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS client_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id_unique
  ON public.messages (client_id);

-- =====================================================================
-- §A8-N2 — messages INSERT column restrictions (BEFORE INSERT trigger)
-- =====================================================================
-- Audit-3 A8-N2: a direct PostgREST INSERT bypassed ALL of
-- sendMessage's validation (the INSERT analog of audit-2 H25's UPDATE
-- trigger). The RLS WITH CHECK constrains only user_id, membership,
-- and the E2EE body clause. This trigger forces the server-set
-- columns and rejects the cross-room / wrong-prefix shapes:
--   * pinned=false (no self-pin), created_at=now() (no ordering
--     manipulation; a future created_at also self-DoSed the user via
--     the before_message_insert 5s rate-limit trigger, whose
--     max(created_at) > now()-5s check then never clears),
--     edited_at=NULL
--   * recipient_count = live member count (no ✓✓ gaming)
-- HARD ORDERING (Audit-5 B5-MEDIUM): recipient_count is added by
-- audit-fixes §M14, which must run BEFORE this file — and the
-- function body guards (information_schema check) so an
-- out-of-order re-run skips the assignment instead of breaking
-- every message send.
--   * parent_id must be NULL or point at a message in the SAME room
--     (the app never writes parent_id today — every app insert has
--     parent_id NULL — so this cannot break a legitimate flow)
--   * E2EE rooms: no attachments at all (sendMessage rejects them —
--     attachments are not encrypted yet)
--   * non-E2EE rooms: attachment_url must start with
--     <user_id>/<room_id>/ (sendMessage's expectedPrefix check)
-- attachment_meta is deliberately NOT normalized here: MIME/size
-- verification needs the storage Info endpoint (sendMessage does
-- it); the prefix check already binds the file to this user + room.
create or replace function public.enforce_message_insert_defaults()
returns trigger
language plpgsql
as $$
declare
  room_is_e2ee boolean;
begin
  -- Server-set columns (forced, never caller-chosen).
  new.pinned := false;
  new.created_at := now();
  new.edited_at := null;
  -- Audit-5 B5-MEDIUM: recipient_count is added by audit-fixes
  -- §M14. If this file ran BEFORE audit-fixes (wrong order), the
  -- column does not exist and assigning NEW.recipient_count would
  -- fail EVERY messages INSERT (the app's H16 missing-column
  -- fallback cannot catch a trigger-side error). Assign only when
  -- the column is present — plpgsql resolves NEW fields at
  -- execution, so the guarded assignment never evaluates while
  -- §M14 is missing; until then the app's own snapshot (sendMessage
  -- sends recipient_count explicitly) stands, and the trigger
  -- takes over the moment the column lands. Run order stays the
  -- documented one (all-pending -> audit-fixes -> audit2 ->
  -- audit3 -> audit4); this guard only removes the hard breakage
  -- if files are ever re-run out of order.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'messages'
      and column_name = 'recipient_count'
  ) then
    new.recipient_count := (
      select count(*) from public.room_members where room_id = new.room_id
    );
  end if;
  -- parent_id must be NULL or a message in the SAME room.
  if new.parent_id is not null
     and not exists (
       select 1 from public.messages
       where id = new.parent_id and room_id = new.room_id
     )
  then
    raise exception 'messages: parent_id must reference a message in the same room';
  end if;
  -- E2EE: attachments are rejected outright (not encrypted yet).
  -- Non-E2EE: the attachment must live under <user_id>/<room_id>/.
  select r.is_e2ee into room_is_e2ee
    from public.rooms r where r.id = new.room_id;
  if coalesce(room_is_e2ee, false) then
    if new.attachment_url is not null then
      raise exception 'messages: attachments are not allowed in end-to-end encrypted rooms';
    end if;
  elsif new.attachment_url is not null
     and new.attachment_url not like new.user_id || '/' || new.room_id || '/%'
  then
    raise exception 'messages: attachment_url must start with <user_id>/<room_id>/';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_insert_defaults on public.messages;
create trigger messages_insert_defaults
  before insert on public.messages
  for each row execute function public.enforce_message_insert_defaults();

-- =====================================================================
-- §A4-N25 — atomic public-room join (join_public_room RPC)
-- =====================================================================
-- Audit-3 A4-N25: joinRoom read is_private/is_dm, then inserted — a
-- room flipped to private between the read and the insert was still
-- joinable. This RPC does the privacy check and the insert in ONE
-- statement, so the flip can no longer slip through. The app calls
-- it via the user's JWT (auth.uid()); a missing function (pre-SQL)
-- falls back to the old check-then-insert path (H16 pattern) — the
-- race stays open until this file has run.
create or replace function public.join_public_room(_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.';
  end if;
  if not exists (select 1 from public.rooms where id = _room_id) then
    raise exception 'Room not found.';
  end if;
  -- Atomic: the WHERE re-checks privacy inside this statement.
  insert into public.room_members (room_id, user_id)
  select _room_id, auth.uid()
  from public.rooms
  where id = _room_id
    and not coalesce(is_private, false)
    and not coalesce(is_dm, false)
  on conflict (room_id, user_id) do nothing;
  if not found then
    -- Already a member (conflict path) = success, not an error.
    if exists (
      select 1 from public.room_members
      where room_id = _room_id and user_id = auth.uid()
    ) then
      return;
    end if;
    raise exception 'This is a private conversation. Ask a member to add you.';
  end if;
end;
$$;

-- Grants persist across CREATE OR REPLACE; re-grant kept for safety.
grant execute on function public.join_public_room(uuid) to authenticated;

-- =====================================================================
-- §A4-N30 — atomic leave (leave_room_atomic RPC)
-- =====================================================================
-- Audit-3 A4-N30: leaveChat deleted the membership, counted, then
-- deleted the room — a join landing between the count and the delete
-- got {ok:true} and then had its row FK-cascade-deleted with the
-- room. This RPC does membership-check + creator transfer +
-- membership delete + maybe room delete in ONE transaction, and
-- returns whether the room was deleted (so the app releases its
-- attachments only in that case).
create or replace function public.leave_room_atomic(_room_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  room_is_dm boolean;
  room_deleted boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated.';
  end if;
  if not exists (
    select 1 from public.room_members
    where room_id = _room_id and user_id = auth.uid()
  ) then
    raise exception 'Not a member of this chat.';
  end if;
  select is_dm into room_is_dm from public.rooms where id = _room_id;
  if coalesce(room_is_dm, false) then
    -- A DM is a shared 1:1 room — leaving deletes the whole room.
    delete from public.rooms where id = _room_id;
    return true;
  end if;
  -- Creator handoff (H8): hand created_by to the oldest remaining
  -- member before the leaver's row is deleted. Nobody remains ->
  -- the subquery is NULL and created_by goes NULL.
  update public.rooms
  set created_by = (
    select user_id from public.room_members
    where room_id = _room_id and user_id <> auth.uid()
    order by joined_at asc
    limit 1
  )
  where id = _room_id and created_by = auth.uid();
  delete from public.room_members
  where room_id = _room_id and user_id = auth.uid();
  if not exists (select 1 from public.room_members where room_id = _room_id) then
    delete from public.rooms where id = _room_id;
    room_deleted := true;
  end if;
  return room_deleted;
end;
$$;

-- Grants persist across CREATE OR REPLACE; re-grant kept for safety.
grant execute on function public.leave_room_atomic(uuid) to authenticated;

-- =====================================================================
-- §A8-N22 — typing_status.updated_at is stamped server-side
-- (pairs with audit-3 LOW A7-N7: typing updated_at came from the
-- client clock — a sender >5s behind never showed a typing
-- indicator). BEFORE INSERT OR UPDATE trigger forces
-- NEW.updated_at := now() on every write, so no writer — client,
-- upsert conflict-update, or direct SQL — can backdate or
-- future-date a typing row. The column default (now()) alone
-- does NOT cover the upsert conflict path: PostgREST only
-- updates payload columns on conflict, so a client-side
-- omission without this trigger would freeze the timestamp
-- at the first keystroke.
-- =====================================================================
create or replace function public.force_typing_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists typing_force_updated_at on public.typing_status;
create trigger typing_force_updated_at
before insert or update on public.typing_status
for each row execute function public.force_typing_updated_at();

-- =====================================================================
-- §A8-N10 — M64 e2e-key validation: BEFORE INSERT trigger on profiles.
-- audit2-fixes §M64 validates e2e_public_key on UPDATE only, so a
-- direct INSERT (own id, no profile row yet — signup-trigger failure
-- / race window) could store a garbage key and brick every shared
-- room's sends. The validator (validate_e2e_public_key, §M64) is
-- shared; this is a dedicated INSERT wrapper (INSERT has no OLD
-- row, so the UPDATE function's old/new comparison does not apply).
-- HARD ORDERING (Audit-5 B5-MEDIUM): the validator is defined in
-- audit2-fixes, which must run BEFORE this file — and the function
-- body guards (to_regprocedure check) so an out-of-order re-run
-- skips validation instead of breaking every signup.
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- =====================================================================
create or replace function public.prevent_bad_e2e_key_insert()
returns trigger
language plpgsql
as $$
begin
  -- Audit-5 B5-MEDIUM: validate_e2e_public_key is defined in
  -- audit2-fixes §M64. If this file ran BEFORE audit2 (wrong
  -- order), the validator does not exist yet — calling it would
  -- fail EVERY profiles INSERT with 42883, and handle_new_user
  -- inserts a profile on every signup (= no new account could be
  -- created). Skip validation until the validator lands: the
  -- guard is evaluated per row, so the trigger self-activates the
  -- moment audit2 runs. Run order stays the documented one
  -- (all-pending -> audit-fixes -> audit2 -> audit3 -> audit4);
  -- this guard only removes the hard breakage if files are ever
  -- re-run out of order.
  if to_regprocedure('public.validate_e2e_public_key(text)') is null then
    return new;
  end if;
  if not public.validate_e2e_public_key(new.e2e_public_key) then
    raise exception 'Invalid e2e_public_key — not a valid P-256 public key.';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_validate_e2e_key_insert on public.profiles;
create trigger profiles_validate_e2e_key_insert
  before insert on public.profiles
  for each row execute function public.prevent_bad_e2e_key_insert();

-- =====================================================================
-- §A8-N17 — Drop the storage DELETE policy for chat-attachments.
-- "Owners can delete own chat attachments" let the uploader delete
-- their own file under a LIVE message via storage.remove(), breaking
-- the attachment for every member viewing the message. All deletes
-- now go through server functions: deleteOwnAttachmentFile (client
-- cleanups — failed sends, failed avatar saves — own files only,
-- refused when a message references the path) or supabaseAdmin
-- directly (sendMessage oversize cleanup, deleteMessage cleanup,
-- deleteRoom/leaveChat/removeRoomMember/deleteMyAccount cleanups).
-- Idempotent: DROP POLICY IF EXISTS.
-- =====================================================================
drop policy if exists "Owners can delete own chat attachments" on storage.objects;

-- =====================================================================
-- §A8-N20 — rooms INSERT column restrictions (BEFORE INSERT trigger).
-- Direct PostgREST INSERT could set created_at / last_activity_at
-- arbitrarily (a far-future last_activity_at pins the room at the
-- top of everyone's listRooms, which sorts by it) and unbounded
-- name / description (server-fn zod caps bypassed). The H26 UPDATE
-- trigger already constrains updates; INSERT was the gap.
-- Forcing rules:
--   created_by := auth.uid() when an authenticated user inserts
--     (a direct insert can no longer claim another creator); when
--     auth.uid() is NULL (service_role / admin inserts — createRoom
--     via supabaseAdmin, get_or_create_dm RPC), the payload value
--     is kept, so legitimate server-side creation still works.
--   created_at / last_activity_at := now() (always — no flow needs
--     a custom value; the DM RPC and createRoom do not set them).
--   name <= 60 chars, description <= 280 chars (mirror the
--     createRoom zod caps) — overlong direct inserts raise.
-- Deliberately NOT forced: is_dm / is_private / is_e2ee — the RLS
-- policy already blocks direct is_dm=true, and forcing the flags
-- would break E2EE room creation via the server fn (admin insert).
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- =====================================================================
create or replace function public.enforce_rooms_insert_defaults()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  new.created_at := now();
  new.last_activity_at := now();
  if char_length(coalesce(new.name, '')) > 60 then
    raise exception 'rooms: name must be at most 60 characters.';
  end if;
  if char_length(coalesce(new.description, '')) > 280 then
    raise exception 'rooms: description must be at most 280 characters.';
  end if;
  return new;
end;
$$;
drop trigger if exists rooms_insert_defaults on public.rooms;
create trigger rooms_insert_defaults
before insert on public.rooms
for each row execute function public.enforce_rooms_insert_defaults();

-- =====================================================================
-- §A8-N21 — message_reactions.emoji restricted to the app's 8 emojis.
-- Direct PostgREST INSERT could store any string as emoji (multi-KB
-- text), which renders in the message's reaction row for all room
-- members. The server fn (toggleReaction zod enum) already restricts
-- to these 8; the constraint enforces it at the DB layer.
-- NOTE: if rows with other emojis already exist, the ADD CONSTRAINT
-- fails — delete those rows first, then re-run this section.
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.
-- =====================================================================
alter table public.message_reactions
  drop constraint if exists message_reactions_emoji_allowed;
alter table public.message_reactions
  add constraint message_reactions_emoji_allowed
  check (emoji in ('👍', '❤️', '😂', '🎉', '😮', '😢', '🔥', '🙏'));

-- =====================================================================
-- §L49 — calls: users can delete their OWN call history rows.
-- The calls table had select_own + insert_own policies (§H34) but NO
-- delete policy, so history was append-only forever (and listCalls
-- hard-capped at 50 rows). The app deletes via the deleteCallHistory
-- server fn (supabaseAdmin + explicit user_id match + affected-row
-- check); this policy is defense-in-depth for direct PostgREST
-- deletes and keeps the three policies symmetric.
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY.
-- =====================================================================
drop policy if exists "calls_delete_own" on public.calls;
create policy "calls_delete_own"
  on public.calls for delete
  to authenticated
  using (user_id = auth.uid()); -- Audit-6 G-B9: `to authenticated` added (repo convention; semantics unchanged — auth.uid() is NULL for anon)

-- =====================================================================
-- §L84 — tokens.code: unique index on lower(code).
-- Token lookup is case-insensitive (M93), but the table had no
-- lower(code) index, so the fast path was a case-sensitive exact
-- match + a capped 500-row scan. With this index the lowercased
-- exact match is indexed, and the scan is only a legacy fallback.
-- NOTE (same caveat as §A8-N21): if two live rows already exist
-- differing only by case ("abc" + "ABC"), CREATE UNIQUE INDEX fails
-- — revoke/delete one of the twins first, then re-run this section.
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS.
-- =====================================================================
create unique index if not exists tokens_code_lower_unique
  on public.tokens (lower(code));

-- =====================================================================
-- §L70 — profiles.show_notification_previews: lock-screen privacy.
-- When false, push + in-app notifications show only "New message"
-- (no sender text / message body on the lock screen). Default true
-- (current behaviour). The app tolerates the missing column
-- (42703 fallback -> previews on) until this section runs.
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- =====================================================================
alter table public.profiles
  add column if not exists show_notification_previews boolean not null default true;
