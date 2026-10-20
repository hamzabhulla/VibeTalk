-- =====================================================================
-- VibeTalk — AUDIT FIXES (2026-10-18 full audit, one section per finding)
-- =====================================================================
-- Run this WHOLE file in the Supabase SQL Editor
-- (project fkxgyhnivsaijzwpwpjf) AFTER supabase/vibetalk-all-pending.sql.
-- Then run vibetalk-audit2-fixes.sql — it is MANDATORY (several
-- policies/triggers live ONLY there, e.g. §H27 messages/reactions).
-- Safe to re-run: every statement is idempotent
-- (IF NOT EXISTS / DROP POLICY IF EXISTS / DO-block guards).
--
-- Each section is ONE audit finding (C1, C2, H1, ...). The app code
-- already enforces these rules in its server functions; this file puts
-- the SAME rules at the database boundary (RLS / triggers / constraints),
-- because RLS is the real boundary — direct PostgREST/RPC calls bypass
-- server-function checks entirely.
--
-- Nothing here deletes user data. Role-system cleanup (H1/H2) deletes
-- only privilege rows, never profiles/messages/rooms.
-- =====================================================================


-- =====================================================================
-- C1. E2EE enforcement at the RLS boundary
-- =====================================================================
-- Finding: sendMessage (server fn) rejects non-E2E1: bodies in E2EE
-- rooms, but RLS messages_insert_own had no E2EE condition — any valid
-- JWT could insert plaintext directly into an E2EE room via PostgREST.
-- Same class: reactions_insert_own had no room check at all;
-- receipts_write_own had no room check.
--
-- Fix (audit-3 A8-N5 hygiene): the messages + reactions policies that
-- used to live here now live ONLY in vibetalk-audit2-fixes.sql §H27
-- (membership-gated is_room_member version). Defining them here too
-- meant re-running this file after audit2 REVERTED H27. The receipts
-- policy below STAYS here — §H27 does not define it, and deleting it
-- would silently drop the receipts membership check.
-- The server fns use the RLS client (context.supabase), so the
-- legitimate paths were traced against the new policies:
--   - legit E2EE send: body IS E2E1: + attachment NULL -> passes (H27).
--   - legit non-E2EE send: is_e2ee false -> passes (H27).
--   - legit react: member of the room -> passes (H27).
--   - legit mark-read: member -> passes (receipts, below).
-- supabaseAdmin (server fns that use it) bypasses RLS and is unaffected.

-- Prerequisite: rooms.is_e2ee (pending file §1 also adds it).
alter table public.rooms
  add column if not exists is_e2ee boolean not null default false;

-- 1) messages INSERT + 2) reactions INSERT: DELETED — now defined ONLY
-- in vibetalk-audit2-fixes.sql §H27. Do not re-add them here.

-- 3) receipts WRITE: must be a member of the room (matches the read policy).
-- (Sole definition — audit2 §H27 does not define this policy, so it stays here.)
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'read_receipts'
  ) then
    drop policy if exists "receipts_write_own" on public.read_receipts;
    create policy "receipts_write_own"
      on public.read_receipts for all to authenticated
      using (
        auth.uid() = user_id
        and exists (
          select 1 from public.room_members m
          where m.room_id = read_receipts.room_id and m.user_id = auth.uid()
        )
      )
      with check (
        auth.uid() = user_id
        and exists (
          select 1 from public.room_members m
          where m.room_id = read_receipts.room_id and m.user_id = auth.uid()
        )
      );
  end if;
end $$;


-- =====================================================================
-- C2. Duplicate-DM race — advisory lock inside get_or_create_dm
-- =====================================================================
-- Finding: the RPC did SELECT (no room?) -> INSERT room + members with
-- no mutual exclusion. Two concurrent calls both saw "no room" and both
-- inserted -> two DM rooms for the same pair (double-tap / retry).
--
-- Fix: pg_advisory_xact_lock() with a deterministic key for the UNORDERED
-- pair, taken BEFORE the SELECT. The lock is transaction-scoped, so the
-- second concurrent call waits for the first to commit, then its SELECT
-- finds the room the first call created and returns it — no duplicate.
-- The key is order-independent (least/greatest), so (A,B) and (B,A) lock
-- the same key. The server-fn wrapper's own check-then-call stays racy,
-- but the DB boundary (this RPC) is now atomic, which is what matters.
-- Grants persist across CREATE OR REPLACE; re-grant kept for safety.

create or replace function public.get_or_create_dm(_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  room uuid;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if _other = me then raise exception 'Cannot DM yourself'; end if;

  -- Serialize concurrent get-or-create for the same unordered pair.
  perform pg_advisory_xact_lock(
    hashtext(least(me::text, _other::text) || ':' || greatest(me::text, _other::text))::bigint
  );

  select r.id into room
  from public.rooms r
  join public.room_members m1 on m1.room_id = r.id and m1.user_id = me
  join public.room_members m2 on m2.room_id = r.id and m2.user_id = _other
  where r.is_dm = true
  limit 1;

  if room is not null then return room; end if;

  insert into public.rooms (name, is_dm, is_private, created_by)
  values ('dm', true, true, me)
  returning id into room;

  insert into public.room_members (room_id, user_id) values (room, me), (room, _other);
  return room;
end;
$$;

grant execute on function public.get_or_create_dm(uuid) to authenticated;


-- =====================================================================
-- H1. Role / admin system removed from the database
-- =====================================================================
-- Finding: app code never reads roles (admin was removed from the UI),
-- but the DB still had the full role system: app_role enum, user_roles
-- table, has_role(), handle_new_user() inserting a 'user' role per
-- signup, and RLS policies granting admin/special privilege (read any
-- private room, update any profile, delete any message, manage rooms /
-- members, skip the rate limit, manage roles/tokens).
-- A legacy user_roles row with role 'admin'/'special' still bypassed
-- all of that at the DB layer, and the app could not see or revoke it.
--
-- Fix: remove the role branches from every policy/function, then drop
-- the role objects. No user data is touched (profiles / messages /
-- rooms / members are untouched; only role rows are deleted with the
-- user_roles table, and 'user' role rows grant nothing).
-- Order matters: policies/functions are rewritten FIRST (so nothing
-- references has_role), then the objects are dropped. claim_first_admin
-- (H2) is left in place here — it errors on call once user_roles is
-- gone (grants nothing) and is dropped by the H2 section below.
--
-- Behaviour change (intended): nobody has admin/special privilege any
-- more. Private rooms are member-only, profiles are owner-only, room
-- update/delete is creator-only, message delete is own + <5 min,
-- the rate limit applies to everyone.

-- 1) can_view_room: drop the admin/special branches.
create or replace function public.can_view_room(_room_id uuid, _user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = _room_id
      and (not r.is_private or public.is_room_member(_room_id, _user_id))
  )
$$;

-- 2) before_message_insert: the 5s rate limit applies to everyone now
-- (the admin exemption is gone). Ban/mute checks stay — M17 removes
-- those separately; H1 is scoped to role branches only.
create or replace function public.before_message_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  last_msg timestamptz;
  is_muted timestamptz;
  is_banned boolean;
begin
  select muted_until, banned into is_muted, is_banned from public.profiles where id = new.user_id;
  if is_banned then raise exception 'User is banned'; end if;
  if is_muted is not null and is_muted > now() then raise exception 'User is muted'; end if;

  select max(created_at) into last_msg from public.messages
  where user_id = new.user_id and created_at > now() - interval '5 seconds';
  if last_msg is not null then
    raise exception 'Rate limit: please wait a moment before sending another message';
  end if;
  return new;
end; $$;

-- 3) handle_new_user: stop inserting a 'user' role row per signup.
-- The profiles insert stays (signups still create a profile).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1), 'User'));
  return new;
end; $$;

-- 4) Policies: drop the role branches (rename the two *_admin_* policies
-- so the name no longer promises an admin that does not exist).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update to authenticated
  using (auth.uid() = id);

drop policy if exists "rooms_read_visible" on public.rooms;
create policy "rooms_read_visible" on public.rooms for select to authenticated
  using (
    not is_private
    or public.is_room_member(id, auth.uid())
  );

drop policy if exists "rooms_update_admin_or_creator" on public.rooms;
drop policy if exists "rooms_update_creator" on public.rooms;
create policy "rooms_update_creator" on public.rooms for update to authenticated
  using (created_by = auth.uid());

drop policy if exists "rooms_delete_admin_or_creator" on public.rooms;
drop policy if exists "rooms_delete_creator" on public.rooms;
create policy "rooms_delete_creator" on public.rooms for delete to authenticated
  using (created_by = auth.uid());

drop policy if exists "members_read" on public.room_members;
create policy "members_read" on public.room_members for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_room_member(room_id, auth.uid())
  );

drop policy if exists "members_leave_self_or_admin" on public.room_members;
drop policy if exists "members_leave_self" on public.room_members;
create policy "members_leave_self" on public.room_members for delete to authenticated
  using (auth.uid() = user_id);

-- members_join_self: SINGLE definition lives in §M104 below
-- (stricter: + is_dm check). The looser version that used to be here
-- is deleted (audit-2 H34 — one definition per policy, or a re-run
-- silently reverts the M104 tightening). Do NOT re-define it here.

drop policy if exists "messages_delete_own_or_admin" on public.messages;
drop policy if exists "messages_delete_own_recent" on public.messages;
create policy "messages_delete_own_recent" on public.messages for delete to authenticated
  using (
    auth.uid() = user_id and created_at > now() - interval '5 minutes'
  );

drop policy if exists "messages_update_own_recent" on public.messages;
create policy "messages_update_own_recent" on public.messages for update to authenticated
  using (
    auth.uid() = user_id and created_at > now() - interval '5 minutes'
  );

-- Tokens become server-function-only (checkToken / redeem use the admin
-- client and bypass RLS). No RLS caller needs token access.
drop policy if exists "tokens_admin_all" on public.tokens;

-- 5) Drop the role objects. user_roles CASCADE drops its two policies.
-- Audit-5 HIGH-5: the LIVE members_join_self (migration
-- 20260625171256 §3 — the has_role admin/special branches) still
-- depends on has_role, and its single definition lives in §M104
-- BELOW (H1 deliberately does not redefine it). Drop it BEFORE the
-- DROP FUNCTION or Postgres refuses with 2BP01 (dependent object)
-- and the SQL editor stops here — everything after this line (H2,
-- H9, M13, M14, M17, M18, M52, M104, M105) would never apply,
-- including §M18's drop of the wide-open "Authenticated can read
-- chat attachments" storage policy. §M104 recreates the policy
-- (its DROP POLICY IF EXISTS keeps this idempotent), and the
-- H34 one-definition-per-policy rule is untouched.
drop policy if exists "members_join_self" on public.room_members;
drop table if exists public.user_roles cascade;
drop function if exists public.has_role(uuid, public.app_role);

-- 6) Drop the grants_role column (app_role-typed) before dropping the enum.
alter table public.tokens drop column if exists grants_role;

-- 7) Drop the enum (no dependents remain: user_roles, grants_role,
-- has_role are all gone).
drop type if exists public.app_role;


-- =====================================================================
-- H2. claim_first_admin() privilege-escalation RPC dropped
-- =====================================================================
-- Finding: the old /setup flow's RPC let ANY authenticated user call
-- supabase.rpc("claim_first_admin") and become admin (if no admin row
-- existed) — then all H1 role branches applied to them. The app never
-- calls it (/setup was removed).
-- Fix: drop it. After H1, user_roles is already gone, so even before
-- this section runs the function errors on call (grants nothing);
-- this section removes the dangling function itself. No code calls it
-- (grep-verified: only the migration definition + a stale types.ts
-- declaration, which H23's types regeneration will clean).
drop function if exists public.claim_first_admin();


-- =====================================================================
-- H9. get_or_create_dm: private-profile block bypassed via direct RPC
-- =====================================================================
-- Finding: "Private profiles accept no new DMs" (is_public = false ->
-- throw) lived ONLY in the server-fn wrapper. The RPC itself had no
-- is_public check, so anyone with a Supabase JWT could call
-- supabase.rpc("get_or_create_dm", {_other: <private-user>}) directly
-- and create the DM. Same TOCTOU shape as the C2 race.
--
-- Fix: the check moves INTO the RPC, under the advisory lock, right
-- before the INSERT (so it is atomic — the target cannot flip to
-- private between a wrapper check and the insert). Existing DMs keep
-- working (the early return above the check). Tolerant: if the
-- is_public column does not exist yet (pending SQL not run), the
-- target is treated as public. Grants persist across CREATE OR
-- REPLACE; re-grant kept for safety. This is a full rewrite of the
-- C2 version (lock + early return + insert unchanged).
create or replace function public.get_or_create_dm(_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  room uuid;
  target_public boolean;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if _other = me then raise exception 'Cannot DM yourself'; end if;

  -- Serialize concurrent get-or-create for the same unordered pair.
  perform pg_advisory_xact_lock(
    hashtext(least(me::text, _other::text) || ':' || greatest(me::text, _other::text))::bigint
  );

  select r.id into room
  from public.rooms r
  join public.room_members m1 on m1.room_id = r.id and m1.user_id = me
  join public.room_members m2 on m2.room_id = r.id and m2.user_id = _other
  where r.is_dm = true
  limit 1;

  if room is not null then return room; end if;

  -- H9: private profiles accept no NEW DMs — enforced here, inside
  -- the RPC, not only in the (bypassable) server-fn wrapper.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_public'
  ) then
    select is_public into target_public from public.profiles where id = _other;
    if target_public = false then
      raise exception 'This user is not accepting new messages.';
    end if;
  end if;

  insert into public.rooms (name, is_dm, is_private, created_by)
  values ('dm', true, true, me)
  returning id into room;

  insert into public.room_members (room_id, user_id) values (room, me), (room, _other);
  return room;
end;
$$;

grant execute on function public.get_or_create_dm(uuid) to authenticated;


-- =====================================================================
-- §M13 — typing_status write policy: require room membership.
-- The old typing_write_own policy only checked auth.uid() = user_id, so
-- a NON-member could upsert a typing row for any room and appear as
-- "typing" to that room's readers. The read policy already required
-- membership; the write policy now matches it.
-- Idempotent: DROP POLICY IF EXISTS + CREATE.
-- =====================================================================
DROP POLICY IF EXISTS "typing_write_own" ON public.typing_status;
CREATE POLICY "typing_write_own" ON public.typing_status
FOR ALL TO authenticated
USING (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.room_members m
    WHERE m.room_id = typing_status.room_id AND m.user_id = auth.uid()
  )
)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.room_members m
    WHERE m.room_id = typing_status.room_id AND m.user_id = auth.uid()
  )
);


-- =====================================================================
-- §M14 — messages.recipient_count: member-count snapshot at send time.
-- Without it, a member leaving drops the live member-count denominator
-- and old messages retroactively become "seen by all" (✓✓) even though
-- the leaver never read them. sendMessage sets this on insert;
-- isSeenByAll prefers it, falling back to the live count for pre-M14
-- messages (NULL). Idempotent.
-- =====================================================================
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS recipient_count integer;


-- =====================================================================
-- §M17 — before_message_insert: drop the ban/mute branches.
-- Moderation (admin / ban / mute) was removed from the app — there is
-- no admin and no UI that explains a block. A stale banned=true or
-- muted_until value in profiles used to silently block that user's
-- sends via this trigger. Only the 5s rate limit (everyone) remains.
-- Overrides the H1 version of this function (this section runs after
-- H1 in this file). Idempotent: CREATE OR REPLACE.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.before_message_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  last_msg timestamptz;
BEGIN
  -- Audit-3 A8-N23: call-type inserts are server-generated
  -- (postCallMessage via supabaseAdmin, proof-bound by the call
  -- flow) — the 5s user-spam limit must not drop a call entry
  -- when the caller sent a chat message <5s earlier.
  IF NEW.type = 'call' THEN
    RETURN NEW;
  END IF;
  SELECT max(created_at) INTO last_msg FROM public.messages
  WHERE user_id = NEW.user_id AND created_at > now() - interval '5 seconds';
  IF last_msg IS NOT NULL THEN
    RAISE EXCEPTION 'Rate limit: please wait a moment before sending another message';
  END IF;
  RETURN NEW;
END; $$;


-- =====================================================================
-- §M18 — canonical storage SELECT policy for chat-attachments.
-- Two conflicting SELECT policies existed in migration history:
--  (a) permissive "Authenticated can read chat attachments" — ANY
--      authenticated user could read ANY object (all attachments
--      effectively public; signAvatar's privacy check was app-layer
--      only and direct storage access bypassed it);
--  (b) restrictive "Uploader or room members..." — uploader OR
--      can_view_room on foldername[2]. For avatar paths
--      <userId>/profile/<file>, foldername[2] = 'profile' (not a
--      UUID), so ONLY the uploader passed and signAvatar failed for
--      other users' avatars.
-- Because policies are OR-ed, (a) made (b) useless while it existed.
-- Fix: drop (a) entirely; recreate (b) with an explicit avatar
-- carve-out (foldername[2] = 'profile'). The avatar path is only
-- revealed via signAvatar, which enforces is_avatar_public at the app
-- layer — the storage carve-out doesn't leak private avatars, it just
-- stops the storage layer from breaking signAvatar for public ones.
-- Idempotent: DROP POLICY IF EXISTS + CREATE.
-- =====================================================================
-- Audit-6 G-B1: this policy is ALSO defined — stronger — by
-- vibetalk-audit4-fixes.sql §M29 (avatar branch gated on
-- can_view_avatar). The dual definition meant re-running THIS file
-- alone after audit4 silently reverted the private-avatar fix.
-- Guard (MEDIUM-6 convention): when can_view_avatar exists, audit4
-- owns the policy — skip the legacy definition entirely. In the
-- documented order (this file runs BEFORE audit4) the guard is
-- inert and the statements below run exactly as before.
DO $$
BEGIN
  IF to_regprocedure('public.can_view_avatar(uuid)') IS NOT NULL THEN
    RAISE NOTICE 'M18: can_view_avatar exists — audit4 §M29 owns the storage SELECT policy; skipping legacy definition.';
  ELSE
    DROP POLICY IF EXISTS "Authenticated can read chat attachments" ON storage.objects;
    DROP POLICY IF EXISTS "Uploader or room members can read chat attachments" ON storage.objects;
    CREATE POLICY "Uploader or room members can read chat attachments" ON storage.objects
    FOR SELECT TO authenticated
    USING (
      bucket_id = 'chat-attachments'
      AND (
        (storage.foldername(name))[1] = auth.uid()::text
        OR (
          -- Audit-3 A8-N11: STRICT UUID regex — the old
          -- '^[0-9a-fA-F-]{36}$' accepted any 36 hex/hyphen chars
          -- (e.g. wrong group lengths), and the ::uuid cast below
          -- then errored during policy evaluation for such objects.
          -- A strict shape can never fail the cast.
          (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND public.can_view_room(((storage.foldername(name))[2])::uuid, auth.uid())
        )
        OR (storage.foldername(name))[2] = 'profile'
      )
    );
  END IF;
END;
$$;

-- =====================================================================
-- §M52 — handle_new_user: whitespace/empty display_name -> fall back
-- to the email prefix (M52, defense-in-depth for the client-side
-- trim().length check in register.tsx).
--
-- The trigger used COALESCE(meta->>'display_name', email-prefix,
-- 'User'). COALESCE only substitutes on NULL — a "" (or "   ")
-- display_name passed straight through, so profiles.display_name
-- became "" (blank name in chat lists / initials fallbacks). The
-- join path was already safe (server zod .trim().min(1)).
--
-- NULLIF(TRIM(...), '') turns "" and "   " into NULL, so COALESCE
-- falls through to the email prefix. TRIM(NULL) = NULL, so a missing
-- key still falls through. Idempotent; no user data is touched
-- (only FUTURE signups get the fallback).
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1), 'User'));
  return new;
end; $$;

-- ============================================================
-- §M104 — joinRoom TOCTOU: members_join_self was missing is_dm
-- The H1 policy already enforces is_private = false AT INSERT TIME
-- (statement-atomic, so a public→private flip racing the join is
-- correctly denied). But it did NOT check is_dm: a direct PostgREST
-- insert (bypassing the joinRoom server fn, which blocks DMs) could
-- join a DM room. Tighten the WITH CHECK to require a non-DM room.
-- The server fn keeps its own read-then-insert check for the clear
-- error message; this policy is the atomic backstop.
-- Idempotent: DROP POLICY IF EXISTS + CREATE.
-- ============================================================
drop policy if exists "members_join_self" on public.room_members;
create policy "members_join_self" on public.room_members for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.rooms r
      where r.id = room_id
        and r.is_private = false
        and coalesce(r.is_dm, false) = false
    )
  );

-- ============================================================
-- §M105 — createRoom atomicity: room + creator membership in one RPC
-- Finding: createRoom did two separate inserts (rooms, then
-- room_members) with no transaction/rollback. If the member insert
-- failed (RLS, transient), the room survived with no members.
--
-- Fix: create_room_with_creator() inserts both rows in ONE
-- transaction (SECURITY DEFINER, creator = auth.uid() — a caller
-- can only ever create a room with THEMSELVES as creator+member).
-- The non-E2EE branch omits the is_e2ee column so plain rooms keep
-- working before the E2EE SQL has run; the E2EE branch fails with
-- the usual undefined_column error, which the server fn maps to the
-- friendly "run vibetalk-e2ee-visibility.sql" message.
-- The server fn falls back to the two-insert path (with a
-- compensating room delete) when this function doesn't exist yet,
-- so room creation keeps working before this section is run.
-- Idempotent: CREATE OR REPLACE + GRANT.
-- ============================================================
create or replace function public.create_room_with_creator(
  _name text,
  _description text,
  _is_private boolean,
  _is_e2ee boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  room uuid;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if _name is null or length(trim(_name)) = 0 or length(_name) > 60 then
    raise exception 'Invalid room name';
  end if;
  if length(coalesce(_description, '')) > 280 then
    raise exception 'Description too long';
  end if;
  if coalesce(_is_e2ee, false) then
    insert into public.rooms (name, description, is_private, is_dm, created_by, is_e2ee)
    values (trim(_name), nullif(trim(coalesce(_description, '')), ''), coalesce(_is_private, false), false, me, true)
    returning id into room;
  else
    insert into public.rooms (name, description, is_private, is_dm, created_by)
    values (trim(_name), nullif(trim(coalesce(_description, '')), ''), coalesce(_is_private, false), false, me)
    returning id into room;
  end if;
  insert into public.room_members (room_id, user_id) values (room, me);
  return room;
end;
$$;

grant execute on function public.create_room_with_creator(text, text, boolean, boolean) to authenticated;
