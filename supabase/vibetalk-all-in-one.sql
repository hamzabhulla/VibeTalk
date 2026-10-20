-- #############################################################################
-- #                                                                           #
-- #   VibeTalk — COMPLETE DATABASE SETUP (ALL-IN-ONE, SAFE)                   #
-- #                                                                           #
-- #   Project: fkxgyhnivsaijzwpwpjf                                           #
-- #                                                                           #
-- #   HOW TO RUN:                                                             #
-- #   1. Supabase Dashboard -> SQL Editor -> New query                        #
-- #   2. Paste this ENTIRE file and press RUN — once, top to bottom.          #
-- #   3. "Success. No rows returned" = done. NOTICEs are normal.              #
-- #   4. If any ERROR appears, copy it and send it to the developer —         #
-- #      do NOT press run again until told (every part is idempotent,         #
-- #      so a re-run after a fix is safe, but diagnose first).                #
-- #                                                                           #
-- #   WHAT THIS IS: the 5 setup files merged in their mandatory run           #
-- #   order, contents BYTE-IDENTICAL to the originals (verified):             #
-- #     Part 1  vibetalk-all-pending.sql                                      #
-- #     Part 2  vibetalk-audit-fixes.sql                                      #
-- #     Part 3  vibetalk-audit2-fixes.sql                                     #
-- #     Part 4  vibetalk-audit3-fixes.sql                                     #
-- #     Part 5  vibetalk-audit4-fixes.sql                                     #
-- #                                                                           #
-- #   SAFETY: every statement is idempotent (IF NOT EXISTS / DROP ...         #
-- #   IF EXISTS / guarded DO-blocks) — running this file twice changes        #
-- #   nothing the second time. Nothing here deletes user data. There is       #
-- #   deliberately NO outer BEGIN/COMMIT: Part 1 adds the 'call' enum         #
-- #   value that later parts reference, and Postgres forbids using a          #
-- #   fresh enum value inside the same transaction. Statement-by-             #
-- #   statement in this order is exactly how the 5 files were designed        #
-- #   and audited to run.                                                     #
-- #                                                                           #
-- #   ORDER MATTERS — do not rearrange the parts.                             #
-- #                                                                           #
-- #############################################################################




-- =============================================================================
-- PART 1 of 5 — vibetalk-all-pending.sql (E2EE/visibility, calls, typing, privacy, call_invites, 'call' enum, realtime)
-- =============================================================================

-- =====================================================================
-- VibeTalk — ALL PENDING SQL IN ONE FILE
-- =====================================================================
-- Run this WHOLE file once in the Supabase SQL Editor
-- (project fkxgyhnivsaijzwpwpjf). Safe to re-run: every statement is
-- idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS).
--
-- POLICY RULE (audit-2 H34 — single source of truth): THIS FILE DEFINES
-- NO POLICIES. It creates tables/columns/indexes, enables RLS, and
-- adds the enum value — nothing else.
-- Every RLS policy lives ONLY in vibetalk-audit-fixes.sql /
-- vibetalk-audit2-fixes.sql. Run order: all-pending -> audit-fixes ->
-- audit2-fixes (audit2-fixes is MANDATORY — several policies/triggers
-- live ONLY there). Re-running THIS file can therefore never revert a
-- policy (the old loose typing/call-invites policies used to do exactly
-- that). If you need a policy changed, change it in the audit file that
-- owns it — never re-add it here.
--
-- Contains 7 sections:
--   1. E2EE + profile visibility columns (profiles.is_public,
--      profiles.e2e_public_key, rooms.is_e2ee)
--   2. Call history table (public.calls + RLS)
--   3. Typing indicators table (public.typing_status + RLS)
--   4. Per-section profile privacy (profiles.is_avatar_public,
--      is_name_public, is_bio_public, is_status_public)
--   5. Call invites table (public.call_invites + RLS) — closed-app
--      call pickup: tap the call notification -> call screen.
--   6. Call message type ('call' in message_type enum) — WhatsApp-style
--      Missed / Completed call entries inside the chat thread.
--   (Former §7, touch_presence re-apply, DELETED — audit-3 A8-N3;
--    owned by audit2-fixes §M53. See the footer note.)
--   8. Calls list realtime (public.calls added to the
--      supabase_realtime publication — Audit-5 MEDIUM-5; appended
--      at the END of this file.)
--
-- Nothing here deletes data. The old user_roles / moderation tables are
-- left untouched — the app no longer reads them (admin was removed).
-- =====================================================================


-- =====================================================================
-- 1. E2EE + PROFILE VISIBILITY
-- =====================================================================
-- Activates: Profile Public/Private toggle + E2EE encrypted rooms.

alter table public.profiles
  add column if not exists is_public boolean not null default true;

alter table public.profiles
  add column if not exists e2e_public_key text;

alter table public.rooms
  add column if not exists is_e2ee boolean not null default false;


-- =====================================================================
-- 2. CALL HISTORY (1:1 voice + video calls)
-- =====================================================================
-- Calls themselves do NOT need this table: signaling runs over Supabase
-- Realtime broadcast and media is peer-to-peer WebRTC. This table only
-- stores per-user call history for the Calls tab.

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  peer_id uuid not null,
  peer_name text not null default 'Unknown',
  type text not null check (type in ('voice', 'video')),
  direction text not null check (direction in ('incoming', 'outgoing')),
  status text not null check (status in ('completed', 'missed', 'declined', 'failed', 'cancelled')), -- §M40: 'cancelled'
  duration_seconds integer not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists calls_user_started_idx
  on public.calls (user_id, started_at desc);

alter table public.calls enable row level security;

-- Policies (H34): calls_select_own + calls_insert_own live ONLY in
-- vibetalk-audit2-fixes.sql §H34 (moved verbatim — own-row-only).
-- Do NOT define policies in this file.


-- =====================================================================
-- 3. TYPING INDICATORS ("X is typing…")
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.typing_status (
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

ALTER TABLE public.typing_status ENABLE ROW LEVEL SECURITY;

-- Policies (H34): typing_read_members lives ONLY in
-- vibetalk-audit2-fixes.sql §H34 (moved verbatim — membership-based
-- read). typing_write_own lives ONLY in vibetalk-audit-fixes.sql §M13
-- (STRICT, membership-based — the loose auth.uid()=user_id version that
-- used to live here is GONE; re-running this file must never resurrect
-- it). Do NOT define policies in this file.
-- VibeTalk per-section profile privacy (idempotent — safe to re-run).
-- Each profile section (photo / name / bio / status) can be Public or Private.
-- Private sections are hidden when OTHER users view the profile. The global
-- is_public flag (vibetalk-e2ee-visibility.sql) still controls People-list discovery.
alter table public.profiles
  add column if not exists is_avatar_public boolean not null default true,
  add column if not exists is_name_public boolean not null default true,
  add column if not exists is_bio_public boolean not null default true,
  add column if not exists is_status_public boolean not null default true;

-- ============================================================
-- 5. vibetalk-call-invites.sql — incoming-call push pickup
-- ============================================================
-- VibeTalk call invites (idempotent — safe to re-run).
-- Lets a callee whose app was fully closed still pick up a call from the
-- push notification: the app fetches this row and reconstructs the ringing
-- state. Rows are only trusted while fresh (server checks < 30s + ringing).
create table if not exists public.call_invites (
  id text primary key,
  caller_id uuid not null references auth.users (id) on delete cascade,
  callee_id uuid not null references auth.users (id) on delete cascade,
  caller_name text not null default 'Someone',
  type text not null check (type in ('voice', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'accepted', 'declined', 'ended')),
  created_at timestamptz not null default now()
);

create index if not exists call_invites_callee_idx
  on public.call_invites (callee_id, created_at desc);

alter table public.call_invites enable row level security;

-- Policies (H34): call_invites_read_participants lives ONLY in
-- vibetalk-audit2-fixes.sql §H34 (moved verbatim — participants-only
-- read). call_invites_insert_caller is DROPPED everywhere (audit-2
-- §H33: direct INSERT let anyone fake a ringing call) — do NOT
-- re-create it. Do NOT define policies in this file.


-- =====================================================================
-- 6. CALL MESSAGE TYPE (WhatsApp-style call entries in chat)
-- =====================================================================
-- postCallMessage inserts type:"call" messages (Missed / Completed +
-- duration) into the chat thread. The message_type enum was created
-- WITHOUT 'call', so every call-entry insert was rejected by Postgres
-- ("invalid input value for enum") and no call entry ever appeared.
-- This adds the value (safe to re-run).
alter type public.message_type add value if not exists 'call';

-- NOTE (audit-3 A8-N3 hygiene): former §7 (touch_presence re-apply) was
-- DELETED. touch_presence is owned by vibetalk-audit2-fixes.sql §M53
-- (presence-table migration); re-running the old §7 REVERTED M53.
-- Do not re-add it here — §M53 is the single definition.

-- =====================================================================
-- 8. REALTIME PUBLICATION: ADD public.calls (Audit-5 B5-MEDIUM/B5-M1)
-- =====================================================================
-- The calls table (§2) was never added to supabase_realtime, while the
-- Calls list (desktop /calls route + mobile Calls tab) subscribes
-- postgres_changes on public.calls and invalidates the "calls"
-- query on change. Postgres logical replication only delivers for
-- publication members — the subscription connected fine (liveness
-- badge green) but no calls event could ever arrive, so a call that
-- ends on another device/tab never refreshed the Calls list.
-- call_invites needs NO publication (code uses broadcast signaling
-- + mount-time fetch); presence is deliberately excluded (audit-2
-- §M53). Idempotent — safe to re-run even if already a member.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'calls')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'calls'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.calls';
    RAISE NOTICE 'Added calls to supabase_realtime';
  END IF;
END $$;


-- =============================================================================
-- PART 2 of 5 — vibetalk-audit-fixes.sql (audit-1 fixes: C1, C2, H1, H2, H9, M-series)
-- =============================================================================

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


-- =============================================================================
-- PART 3 of 5 — vibetalk-audit2-fixes.sql (audit-2 fixes: rate_limits + check_rate_limit, presence, H/M-series)
-- =============================================================================

-- =====================================================================
-- VibeTalk — AUDIT #2 FIXES (2026-10-18, second independent audit)
-- ---------------------------------------------------------------------
-- Run AFTER supabase/vibetalk-all-pending.sql.
-- MANDATORY, not optional: sections here are the SINGLE definition of
-- several policies/triggers (H27 messages/reactions, C4 INSERT+UPDATE
-- triggers, H32 preview gate, M37 unload policy). Running only
-- all-pending + audit-fixes leaves those holes open.
-- One section per SQL finding, in fix order. All sections idempotent.
-- Sections are named §C1 / §C2 / ... matching audit #2's numbering
-- (which is INDEPENDENT of audit #1's C1.. — do not confuse them).
-- =====================================================================

-- =====================================================================
-- §C1 (audit 2) — per-call HMAC secret on call_invites
-- ---------------------------------------------------------------------
-- Audit #2 C1: offer/answer/ice signals were never server-verified —
-- a spoofed offer reached setRemoteDescription(attacker SDP) = media
-- hijack. Fix: the server generates one random 256-bit secret per call
-- and stores it on the invite row; every offer/answer/ice signal carries
-- HMAC-SHA256(secret, callId || kind || payload) and the receiver
-- verifies it before touching the PeerConnection.
--
-- Why the row is the right place: call_invites SELECT is already
-- participant-only (call_invites_read_participants: caller or callee),
-- so only the two participants can read the secret — an eavesdropper
-- on the public Realtime channel sees callId + from, never the secret.
--
-- Old rows (created before this ran) get secret = NULL -> the engine
-- FAILS CLOSED for them: payload signals without a verifiable MAC are
-- dropped. Pre-fix clients (which never send a MAC) also fail closed
-- once both sides are on the new build.
-- =====================================================================
alter table public.call_invites
  add column if not exists secret text;

-- =====================================================================
-- §C3 (audit 2) — profiles_read_all USING (true) -> privacy-filtered view
-- ---------------------------------------------------------------------
-- Audit #2 C3: profiles SELECT was wide open — any logged-in user could
-- GET /rest/v1/profiles?select=* and read EVERYONE's bio, status, name,
-- avatar, is_*_public flags, e2e_public_key, banned, muted_until,
-- message_count. The server-fn privacy filters only applied when the
-- caller used server fns; direct PostgREST skipped them entirely.
--
-- Fix, in two parts (VIEW FIRST, policy second — if the view creation
-- fails, e.g. the privacy columns from vibetalk-all-pending.sql §1/§4
-- were never run, the script aborts before the policy changes, so the
-- app can never be left with a locked table and no view):
--
-- 1. profiles_public — a SECURITY DEFINER view (security_invoker =
--    false), the SINGLE enforcement point for other users' profile
--    data. RLS cannot do column-level filtering (a policy either
--    allows the row or not), so the view does it with CASE:
--      * own row -> full columns (you always see your own profile);
--      * others -> name/avatar/bio/status gated by THEIR per-section
--        flags (private name -> the codebase's established fallback
--        "Someone", never NULL — inbox previews interpolate the name
--        directly); is_public exposed raw (discovery filters on it);
--      * presence (is_online/last_seen_at) -> only for public profiles
--        or people you share a room with (DM partner or group
--        co-member). Strangers learn nothing about a private user.
--    NEVER exposed, to anyone: e2e_public_key (served only via the
--    membership-checked getRoomMemberKeys fn), banned, muted_until,
--    message_count, created_at. auth.uid() inside the view is still
--    the CALLER's id (it reads the JWT, not the view owner).
-- 2. The table policy becomes own-row-only. Every RLS-subject read of
--    others' profiles is migrated to the view (fetchPublicProfiles,
--    listUsers discovery, message-notifier, get_thread_previews JOIN).
--    Server fns using supabaseAdmin are unaffected (they bypass RLS
--    and keep their own JS privacy filter).
--
-- Known, bounded trade-off: Realtime postgres_changes on `profiles`
-- now only delivers the viewer's OWN row changes (RLS), so another
-- user's avatar/name edit no longer live-pushes the People list — it
-- appears on the next refetch / navigation. Profile edits are rare
-- and low-stakes; the alternative (leaking every profile) is not.
-- =====================================================================
create or replace view public.profiles_public
with (security_invoker = false) as
select
  p.id,
  case
    when p.id = auth.uid() or coalesce(p.is_name_public, true)
      then p.display_name
    else 'Someone'
  end as display_name,
  case
    when p.id = auth.uid() or coalesce(p.is_avatar_public, true)
      then p.avatar_url
    else null
  end as avatar_url,
  case
    when p.id = auth.uid() or coalesce(p.is_bio_public, true)
      then p.bio
    else null
  end as bio,
  case
    when p.id = auth.uid() or coalesce(p.is_status_public, true)
      then p.custom_status
    else null
  end as custom_status,
  p.is_public,
  case
    when p.id = auth.uid()
      or coalesce(p.is_public, true)
      or exists (
        select 1
        from public.rooms r
        join public.room_members m1 on m1.room_id = r.id and m1.user_id = auth.uid()
        join public.room_members m2 on m2.room_id = r.id and m2.user_id = p.id
      )
      then p.is_online
    else null
  end as is_online,
  case
    when p.id = auth.uid()
      or coalesce(p.is_public, true)
      or exists (
        select 1
        from public.rooms r
        join public.room_members m1 on m1.room_id = r.id and m1.user_id = auth.uid()
        join public.room_members m2 on m2.room_id = r.id and m2.user_id = p.id
      )
      then p.last_seen_at
    else null
  end as last_seen_at
from public.profiles p;

grant select on public.profiles_public to authenticated;
grant select on public.profiles_public to service_role;

-- The wide-open policy goes away; the table itself is own-row-only.
drop policy if exists "profiles_read_all" on public.profiles;
drop policy if exists "profiles_read_own" on public.profiles;
create policy "profiles_read_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

-- get_thread_previews was SECURITY INVOKER joining the raw table, so
-- it leaked private sender names into inbox previews AND would lose
-- every sender name under the new policy (rows invisible to the
-- invoker). It stays INVOKER (messages RLS still the caller's) but
-- joins the privacy-filtered view instead — private names arrive as
-- "Someone", no client change needed.
create or replace function public.get_thread_previews(p_room_ids uuid[])
returns table (
  room_id uuid,
  user_id uuid,
  body text,
  type text,
  created_at timestamptz,
  display_name text
)
language sql
security invoker
set search_path = public
as $$
  select distinct on (m.room_id)
    m.room_id,
    m.user_id,
    m.body,
    m.type,
    m.created_at,
    p.display_name
  from public.messages m
  join public.profiles_public p on p.id = m.user_id
  where m.room_id = any (p_room_ids)
    and m.deleted_at is null
  order by m.room_id, m.created_at desc;
$$;

grant execute on function public.get_thread_previews(uuid[]) to authenticated;

-- =====================================================================
-- §C4 (audit 2) — members_update_own: membership-row move + joined_at backdate
-- ---------------------------------------------------------------------
-- Audit #2 C4: the members_update_own UPDATE policy (USING auth.uid()
-- = user_id, WITH CHECK auth.uid() = user_id) constrained NEITHER the
-- old row's room NOR the new row's columns — so a direct PostgREST
-- PATCH could MOVE your membership row into any private room/DM
-- (UPDATE room_members SET room_id = '<private>' WHERE user_id = self:
-- old row passes USING, new row passes WITH CHECK) and BACKDATE
-- joined_at to '1970-01-01', winning the oldest-member election in
-- assertCanManageMembers / transferCreatorOnLeave (creator power +
-- creator handoff both go to the oldest remaining member).
--
-- Fix is three layers (defense in depth):
-- 1. DROP the UPDATE policy entirely. Audit of every code path shows
--    NO legitimate direct UPDATE exists: pin/mute go through the
--    pinChat/muteChat server fns (supabaseAdmin, bypasses RLS), join
--    is an INSERT, leave is a DELETE. The policy was pure attack
--    surface. With no UPDATE policy, direct PostgREST PATCH on
--    room_members matches nothing.
-- 2. A BEFORE UPDATE trigger that raises unless ONLY pinned_at /
--    is_muted changed. This survives even if someone re-runs the old
--    chat_actions migration (which re-creates the policy) — the
--    trigger blocks the attack regardless of policy. IS DISTINCT FROM
--    is NULL-safe (plain <> would let NULL sneak past).
-- 3. (Audit-3 A8-N1) A BEFORE INSERT trigger that FORCES
--    NEW.joined_at := now(), NEW.pinned_at := NULL,
--    NEW.is_muted := false. The UPDATE-only trigger left the INSERT
--    path open: direct PostgREST POST /room_members with
--    joined_at='1970-01-01' passed (members_join_self's WITH CHECK
--    constrains only user_id/is_private/is_dm), winning the
--    oldest-member election on creator leave. Forcing (not raising)
--    keeps every legitimate insert working — no legit flow sets
--    these columns — while normalizing any attacker-supplied values.
--    The trigger fires for EVERY writer including service_role.
-- =====================================================================
drop policy if exists "members_update_own" on public.room_members;

create or replace function public.prevent_room_member_identity_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.room_id is distinct from new.room_id
    or old.user_id is distinct from new.user_id
    or old.joined_at is distinct from new.joined_at then
    raise exception 'room_members identity columns (room_id, user_id, joined_at) are immutable — only pinned_at / is_muted may change via UPDATE';
  end if;
  return new;
end;
$$;

drop trigger if exists room_members_immutable_identity on public.room_members;
create trigger room_members_immutable_identity
  before update on public.room_members
  for each row execute function public.prevent_room_member_identity_change();

-- Audit-3 A8-N1: BEFORE INSERT — force join-time columns (see layer 3
-- in the §C4 header above). No legitimate insert sets these.
create or replace function public.force_room_member_insert_defaults()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.joined_at := now();
  new.pinned_at := null;
  new.is_muted := false;
  return new;
end;
$$;

drop trigger if exists room_members_insert_defaults on public.room_members;
create trigger room_members_insert_defaults
  before insert on public.room_members
  for each row execute function public.force_room_member_insert_defaults();

-- =====================================================================
-- §H4 (audit 2) — join endpoints: per-IP rate limit + >=128-bit tokens
-- ---------------------------------------------------------------------
-- Audit #2 H4: checkToken / redeemTokenAndSignup were unauthenticated
-- with NO rate limit — unlimited code guessing (token brute-force) and
-- account-creation spam. Tokens were created by hand with unknown
-- entropy (no generation code in the repo). And a distinct
-- "already registered" error gave any token holder an oracle for ANY
-- email (registered or not).
--
-- Fix, three parts (the oracle part is CODE-only — redeem now returns
-- the same { ok: true } for an already-registered email as for a
-- success, token unconsumed; the join page shows one neutral screen):
--
-- 1. rate_limits table + check_rate_limit(): one atomic upsert decides
--    AND increments, so concurrent floods can't overshoot and the
--    limit holds across worker instances (in-memory Maps would not).
--    RLS is ON with NO policies: only the service_role (server fns)
--    touches it — never grant it to authenticated, or anyone could
--    burn other IPs' quotas / probe the limiter. Stale rows are tiny
--    (one per IP per bucket) and pruned opportunistically below, so
--    the table stays bounded.
-- 2. create_invite_token(): 128-bit crypto-random codes
--    (gen_random_bytes(16) -> 32 hex chars). Tokens were previously
--    hand-made with unknown entropy. Use it from the SQL editor:
--      select public.create_invite_token();            -- 72h expiry
--      select public.create_invite_token(24);          -- 24h expiry
--      select public.create_invite_token(null);        -- never expires
--    Do NOT grant it to authenticated — anyone could mint invites.
--    Audit-6 G-B7 (correcting the stale note that stood here):
--    until this runs, the code-side limiter FAILS CLOSED (Audit-4
--    H7) — rate-limited flows ERROR with a console warning, they do
--    NOT run un-limited. Run this file BEFORE/WITH the deploy.
-- CAPTCHA (Turnstile) is the remaining H4 residual — it needs your
-- Turnstile site + secret keys, same queued item as audit-1 H13/M62.
-- =====================================================================
create extension if not exists pgcrypto;

create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count int not null default 1
);
alter table public.rate_limits enable row level security;

create or replace function public.check_rate_limit(p_key text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.rate_limits (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update
    set window_start = case
        when public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
          then now()
        else public.rate_limits.window_start
      end,
      count = case
        when public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
          then 1
        else public.rate_limits.count + 1
      end
  returning count into v_count;
  -- Opportunistic prune: rows whose window ended over a day ago.
  delete from public.rate_limits
  where window_start < now() - interval '1 day';
  return v_count <= p_limit;
end;
$$;

revoke all on function public.check_rate_limit(text, int, int) from public;
grant execute on function public.check_rate_limit(text, int, int) to service_role;

create or replace function public.create_invite_token(p_expires_in_hours int default 72)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  v_code := encode(gen_random_bytes(16), 'hex');
  insert into public.tokens (code, expires_at)
  values (
    v_code,
    case
      when p_expires_in_hours is null then null
      else now() + make_interval(hours => p_expires_in_hours)
    end
  );
  return v_code;
end;
$$;

revoke all on function public.create_invite_token(int) from public;



-- =====================================================================
-- H25. Direct PostgREST UPDATE on messages bypasses ALL server-fn validation
-- =====================================================================
-- Finding: policy messages_update_own_recent is USING-only (own + 5 min),
-- no WITH CHECK, no column constraints. Direct PATCH /messages with
-- {"room_id": "<victim-private-room>", "body": "plaintext", "type": "call"}
-- on an own recent message SUCCEEDS. Defeats editMessage's E2EE gate,
-- postCallMessage's DM-only + invite-proof gate, sendMessage's
-- membership/attachment gates. editMessage itself only sets
-- body + edited_at, so the policy's breadth serves no legit path.
--
-- Fix (same shape as C4): BEFORE UPDATE trigger that raises unless ONLY
-- body/edited_at changed, and in E2EE rooms the new body stays E2E1:
-- (mirrors editMessage's server-fn gate + the C1 INSERT gate). A WITH
-- CHECK cannot express OLD-vs-NEW comparisons, so a trigger is the
-- only RLS-level mechanism. Verified: the ONLY .update() on messages
-- in the whole codebase is editMessage (body + edited_at);
-- deleteMessage is a hard .delete(); deleted_at/pinned are never
-- written by any code path — so the trigger breaks no legit path.
-- Triggers fire for service_role too, but no admin path updates
-- messages either.
create or replace function public.prevent_message_tampering()
returns trigger
language plpgsql
as $$
begin
  -- Only body + edited_at may change via a direct UPDATE. Every other
  -- column is immutable (IS DISTINCT FROM is NULL-safe).
  if new.attachment_meta is distinct from old.attachment_meta
     or new.attachment_url is distinct from old.attachment_url
     or new.created_at is distinct from old.created_at
     or new.deleted_at is distinct from old.deleted_at
     or new.id is distinct from old.id
     or new.parent_id is distinct from old.parent_id
     or new.pinned is distinct from old.pinned
     or new.recipient_count is distinct from old.recipient_count
     or new.room_id is distinct from old.room_id
     or new.type is distinct from old.type
     or new.user_id is distinct from old.user_id
     -- Audit-2 M2: call_id is immutable too — otherwise a direct
     -- UPDATE could re-point a call entry at another callId and
     -- defeat §M2's one-entry-per-callId unique index.
     or new.call_id is distinct from old.call_id
  then
    raise exception 'messages: only body/edited_at may change via UPDATE';
  end if;
  -- E2EE: an edit must not downgrade an encrypted message to plaintext
  -- (or NULL body). coalesce makes a NULL body fail the check too —
  -- a legit E2EE edit always carries an E2E1: body.
  if coalesce((select r.is_e2ee from public.rooms r where r.id = old.room_id), false)
     and (coalesce(new.body, '') not like 'E2E1:%' or new.attachment_url is not null)
  then
    raise exception 'messages: E2EE room edits must stay E2E1: with no attachment';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_prevent_tampering on public.messages;
create trigger messages_prevent_tampering
  before update on public.messages
  for each row execute function public.prevent_message_tampering();


-- =====================================================================
-- H26. Direct PostgREST UPDATE on rooms flips is_e2ee / is_dm / is_private
-- =====================================================================
-- Finding: policy rooms_update_creator is USING-only (created_by =
-- auth.uid()), no WITH CHECK. The creator could PATCH is_e2ee=false
-- (E2EE room downgrade — new plaintext accepted, clients treat the
-- room as plaintext), is_e2ee=true (old plaintext history suddenly
-- "encrypted" — clients fail decrypting it), is_dm=true (multi-member
-- group becomes a "DM" — listDms / getOrCreateDm / leaveChat DM-delete
-- / postCallMessage DM-only all misbehave), is_private either way.
-- No server fn ever updates these flags.
--
-- Fix (same trigger shape as C4/H25): BEFORE UPDATE trigger. Flags +
-- identity are immutable via UPDATE; only name/description/
-- last_activity_at may change (the audit's allow-list: benign
-- metadata — no code path currently writes them via RLS, but a
-- creator rename is harmless). created_by may change ONLY via the
-- service_role transfer path (transferCreatorOnLeave, supabaseAdmin)
-- — an RLS caller flipping created_by would orphan the room or hand
-- over ownership. Verified: the ONLY .update() on rooms in the whole
-- codebase is transferCreatorOnLeave (admin, created_by only), and no
-- DB trigger bumps last_activity_at — so the trigger breaks no legit
-- path. A WITH CHECK cannot express OLD-vs-NEW comparisons.
create or replace function public.prevent_room_flag_tampering()
returns trigger
language plpgsql
as $$
begin
  if new.is_e2ee is distinct from old.is_e2ee
     or new.is_dm is distinct from old.is_dm
     or new.is_private is distinct from old.is_private
     or new.created_at is distinct from old.created_at
     or new.id is distinct from old.id
  then
    raise exception 'rooms: is_e2ee/is_dm/is_private/created_at/id are immutable via UPDATE';
  end if;
  if new.created_by is distinct from old.created_by
     and coalesce(auth.role(), '') <> 'service_role'
  then
    raise exception 'rooms: created_by may only change via the server transfer path';
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_prevent_flag_tampering on public.rooms;
create trigger rooms_prevent_flag_tampering
  before update on public.rooms
  for each row execute function public.prevent_room_flag_tampering();


-- =====================================================================
-- H27. RLS never enforces membership in public rooms (post/react w/o join)
-- =====================================================================
-- Finding: messages_insert_own + reactions_insert_own (audit-1 C1) were
-- keyed on can_view_room = NOT is_private OR is_member — true for EVERY
-- public room. A non-member could POST /messages + /message_reactions
-- to any public room directly: spam without joining, senders missing
-- from room_members (read-receipt denominator, recipient_count,
-- member lists all inconsistent), toggleReaction's membership check
-- bypassed.
--
-- Fix: replace can_view_room with is_room_member in BOTH policies'
-- WITH CHECK. Membership strictly implies can_view (member => can_view
-- in both public and private rooms), so dropping can_view loses no
-- legit case — it only closes the non-member-public-room hole.
-- Verified no legit path breaks: the ONLY RLS-client inserts are
-- sendMessage (membership checked in-fn) and toggleReaction's upsert
-- (membership checked in-fn, ignoreDuplicates so only the INSERT
-- policy governs); postCallMessage uses supabaseAdmin (bypasses RLS).
-- This section RE-CREATES the audit-1 C1 policies (audit-2 file runs
-- after audit-1's, so this version wins). The E2EE clause is unchanged.
drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own"
  on public.messages for insert to authenticated
  with check (
    auth.uid() = user_id
    and public.is_room_member(room_id, auth.uid())
    and (
      not coalesce((select r.is_e2ee from public.rooms r where r.id = room_id), false)
      or (body like 'E2E1:%' and attachment_url is null)
    )
  );

drop policy if exists "reactions_insert_own" on public.message_reactions;
create policy "reactions_insert_own"
  on public.message_reactions for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.messages m
      where m.id = message_id
        and public.is_room_member(m.room_id, auth.uid())
    )
  );

-- =====================================================================
-- §H32 (audit 2) — get_thread_previews leaked private-profile sender names
-- ---------------------------------------------------------------------
-- Audit #2 H32: the RPC joined the raw profiles table and returned
-- p.display_name verbatim — a private-name sender's REAL name leaked
-- into inbox previews of any room the caller could view.
--
-- CORRECTION (audit's claim is STALE on this point): §C3 already fixed
-- the per-section part — the RPC now joins profiles_public, so a
-- private NAME arrives as "Someone". What §C3 did NOT fix is the H30
-- gap: the view does NOT gate names on is_public, so a user with
-- is_public = false (sections left public) who posts in a viewable
-- room still leaks their REAL name through this RPC.
--
-- Fix: re-create the RPC with the H30 gate ON TOP of the view's
-- per-section filter — is_public = false + not self + no EXISTING DM
-- with the caller -> 'Someone'. (A shared GROUP room does NOT count
-- as a contact — same contract as H30.) The gate MUST live here: the
-- RPC is GRANTed to authenticated, so anyone can call it directly via
-- PostgREST; server-fn post-filtering would not close that hole.
-- SECURITY INVOKER preserved (messages RLS still the caller's), so
-- previews stay limited to rooms the caller can view.
-- =====================================================================
create or replace function public.get_thread_previews(p_room_ids uuid[])
returns table (
  room_id uuid,
  user_id uuid,
  body text,
  type text,
  created_at timestamptz,
  display_name text
)
language sql
security invoker
set search_path = public
as $$
  select distinct on (m.room_id)
    m.room_id,
    m.user_id,
    m.body,
    m.type,
    m.created_at,
    case
      when p.id = auth.uid() then p.display_name
      when coalesce(p.is_public, true) then p.display_name
      when exists (
        select 1
        from public.room_members dm1
        join public.room_members dm2 on dm2.room_id = dm1.room_id
        join public.rooms r on r.id = dm1.room_id
        where dm1.user_id = auth.uid()
          and dm2.user_id = p.id
          and r.is_dm = true
      ) then p.display_name
      else 'Someone'
    end as display_name
  from public.messages m
  join public.profiles_public p on p.id = m.user_id
  where m.room_id = any (p_room_ids)
    and m.deleted_at is null
  order by m.room_id, m.created_at desc;
$$;

grant execute on function public.get_thread_previews(uuid[]) to authenticated;

-- =====================================================================
-- §H33 (audit 2) — call_invites direct RLS INSERT bypasses the call gate
-- ---------------------------------------------------------------------
-- Audit #2 H33: the §5 policy call_invites_insert_caller (WITH CHECK
-- auth.uid() = caller_id) let ANY authenticated user insert an
-- arbitrary row — caller_id = self, ANY callee_id, ANY callId,
-- status = 'ringing'. getPendingInvites / getCallInvite then showed it
-- to the victim as a live ringing call, bypassing assertCanCall's
-- private-profile DM requirement, the self-call rejection, and the
-- rate limit. (A fake Realtime signal alongside is UNVERIFIED-U47 —
-- the in-app fake ringing alone is proven.)
--
-- Fix: DROP the INSERT policy entirely. It serves NO legit path:
-- every call_invites read/write in the codebase goes through
-- supabaseAdmin (createCallInvite, notifyIncomingCall, reportCallEvent,
-- getCallInvite, getPendingInvites, deleteMyAccount cleanup) — verified
-- by grep: ZERO RLS-client (context.supabase) touches on this table,
-- and the native Android app never touches call_invites at all. With
-- RLS enabled and NO INSERT policy, direct INSERT is denied by
-- default. The SELECT policy (participants-only) is KEPT — it is the
-- correct posture for any future RLS read.
--
-- WARNING (H34 territory): the policy is ALSO defined in
-- vibetalk-all-pending.sql §5 and vibetalk-call-invites.sql — re-running
-- either file resurrects it until H34 removes it at the source.
-- =====================================================================
drop policy if exists "call_invites_insert_caller" on public.call_invites;

-- =====================================================================
-- §H34 (audit 2) — ONE definition per policy (single source of truth)
-- ---------------------------------------------------------------------
-- Audit #2 H34: the SAME policy lived in several hand-pasted files with
-- DIFFERENT strictness, and every file claimed "safe to re-run":
--   * typing_write_own — all-pending §3 (LOOSE: auth.uid() = user_id)
--     vs audit-fixes §M13 (STRICT: membership required). Re-running
--     all-pending silently reverted M13: non-members could write
--     fake "typing…" rows again.
--   * members_join_self — audit-fixes TWICE (§H1: is_private only vs
--     §M104: + is_dm). The loose one is deleted from §H1 (below) —
--     §M104 is now the single definition.
--   * call_invites_insert_caller — all-pending §5 + the standalone
--     vibetalk-call-invites.sql, both re-creating the policy §H33
--     dropped (direct INSERT = fake ringing).
--   * calls_* / call_invites_read_participants — all-pending §2/§5 +
--     the standalone files (identical bodies, but two sources).
-- Migrations (versioned, `db push` never re-runs them) are out of scope.
--
-- Fix: policies live in EXACTLY ONE place.
--   * vibetalk-all-pending.sql defines NO policies (DDL only).
--   * The standalone vibetalk-calls.sql / vibetalk-call-invites.sql are
--     DDL-only + marked SUPERSEDED (their policy blocks are deleted).
--   * This section (§H34) is the single home of the four policies that
--     used to live in all-pending / the standalone files, moved VERBATIM
--     (bodies unchanged — typing_read_members was already membership-
--     based; calls_* own-row-only; call_invites read participants-only).
--   * typing_write_own stays ONLY in audit-fixes §M13 (strict) — NOT
--     duplicated here. members_join_self stays ONLY in audit-fixes §M104.
--   * call_invites_insert_caller is defined NOWHERE (H33 dropped it).
--   * messages_insert_own / reactions_insert_own: SINGLE definition in
--     audit2 §H27 (audit-3 A8-N5 hygiene — audit-fixes §C1 no longer
--     defines them; H27 is the only definition, so re-running the
--     files in any order cannot revert H27. receipts_write_own stays
--     ONLY in audit-fixes §C1 — H27 does not define it.)
-- Run order: all-pending -> audit-fixes -> audit2-fixes. Re-running
-- all-pending afterwards changes NO policy (it defines none).
--
-- VERIFY (run in the SQL Editor after applying all three files):
--   select policyname, tablename, cmd from pg_policies
--   where schemaname = 'public' order by tablename, policyname;
-- Expected: typing_status shows typing_read_members + typing_write_own
-- (the M13 membership version — check pg_policies.qual contains
-- "room_members"); room_members shows members_join_self ONCE (qual
-- contains "is_dm"); call_invites shows ONLY
-- call_invites_read_participants (NO insert policy); calls shows
-- calls_select_own + calls_insert_own.
-- =====================================================================

-- typing_read_members — moved VERBATIM from all-pending §3.
drop policy if exists "typing_read_members" on public.typing_status;
create policy "typing_read_members" on public.typing_status
  for select to authenticated
  using (
    exists (
      select 1 from public.room_members m
      where m.room_id = typing_status.room_id and m.user_id = auth.uid()
    )
  );

-- calls_select_own + calls_insert_own — moved from all-pending §2
-- (Audit-6 G-B9: `to authenticated` added — they were the repo's
-- only policies without it; semantics unchanged, since auth.uid()
-- is NULL for anon and no row could ever match).
drop policy if exists "calls_select_own" on public.calls;
create policy "calls_select_own"
  on public.calls for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "calls_insert_own" on public.calls;
create policy "calls_insert_own"
  on public.calls for insert
  to authenticated
  with check (auth.uid() = user_id);

-- call_invites_read_participants — moved VERBATIM from all-pending §5.
drop policy if exists "call_invites_read_participants" on public.call_invites;
create policy "call_invites_read_participants"
  on public.call_invites for select
  using (auth.uid() = caller_id or auth.uid() = callee_id);

-- =====================================================================
-- §M2 (audit 2) — one call entry per callId (unique constraint)
-- ---------------------------------------------------------------------
-- Audit #2 M2: postCallMessage accepted self-reported status/duration
-- and had no per-callId uniqueness — the caller could post
-- "completed, 86400s" for a 5s missed call, then post again. The code
-- fix (same change) binds the proof to this DM + type + 24h freshness
-- and checks status/duration against the invite row; THIS section is
-- the atomic backstop: a call_id column + partial unique index, so
-- even two SIMULTANEOUS duplicate posts cannot both land (an
-- existence check would TOCTOU). Old call entries keep call_id NULL
-- (the partial index ignores them). The §H25 trigger is amended to
-- make call_id immutable (no re-pointing via UPDATE).
-- Run order: AFTER vibetalk-all-pending.sql §6 (the 'call' enum value
-- must exist — the index predicate references it).
-- =====================================================================
alter table public.messages add column if not exists call_id text;

create unique index if not exists messages_call_id_unique
  on public.messages (call_id)
  where type = 'call' and call_id is not null;

-- =====================================================================
-- §M37 (audit 2) — unload hangup: participants may mark their own
-- invite "ended" directly (keepalive PATCH during pagehide)
-- ---------------------------------------------------------------------
-- Audit #2 M37: tab close sent no hangup — the peer hung until the
-- ring timeout / ICE detection. The code fix (same change) fires a
-- keepalive PATCH to this row + a sync Realtime `end` signal on
-- pagehide/stop. The server fn CANNOT take a beacon: its body must
-- be seroval-serialized (plain JSON throws in fromJSON), its URL is
-- a build-time fn id, and it needs an auth header. So this narrow
-- policy is the reliable unload path — same keepalive pattern as
-- presence markOffline.
--
-- Policy: UPDATE only, participants only, live rows only
-- (ringing/accepted), new status MUST be 'ended'. A participant can
-- never accept/decline/resurrect via this path (those go through
-- the server fn) and can never touch a terminal row.
--
-- Trigger: call_invites has NO other UPDATE policy, but the trigger
-- guards EVERY writer incl. service_role — only `status` may change
-- (caller_id/callee_id/id/created_at/type/secret are immutable), and
-- the new status must be accepted/declined/ended. The server fn's
-- transitions (ringing->accepted/declined/ended, accepted->ended)
-- all pass; the 5-min stale-row cleanup (status-only) passes.
-- createCallInvite's upsert is an INSERT — untouched (BEFORE UPDATE).
-- (Audit-3 hygiene) DROP POLICY first: without it, re-running this
-- file fails on the duplicate policy (CREATE POLICY has no
-- IF NOT EXISTS).
-- =====================================================================
drop policy if exists "call_invites_update_ended" on public.call_invites;
create policy "call_invites_update_ended"
  on public.call_invites for update
  using (
    (auth.uid() = caller_id or auth.uid() = callee_id)
    and status in ('ringing', 'accepted')
  )
  with check (status = 'ended');

create or replace function public.prevent_call_invite_tampering()
returns trigger
language plpgsql
as $$
begin
  -- Only `status` may change; everything else is immutable.
  if new.id is distinct from old.id
     or new.caller_id is distinct from old.caller_id
     or new.callee_id is distinct from old.callee_id
     or new.caller_name is distinct from old.caller_name
     or new.type is distinct from old.type
     or new.created_at is distinct from old.created_at
     or new.secret is distinct from old.secret then
    raise exception 'call_invites: only status may change';
  end if;
  if new.status not in ('accepted', 'declined', 'ended') then
    raise exception 'call_invites: invalid status';
  end if;
  return new;
end;
$$;

drop trigger if exists call_invites_immutable on public.call_invites;
create trigger call_invites_immutable
  before update on public.call_invites
  for each row execute function public.prevent_call_invite_tampering();

-- =====================================================================
-- §M40 — 'cancelled' call outcome (audit-2 M40)
-- Caller-cancelled calls were recorded + messaged as "missed" and the
-- callee got a missed-call push for a call the caller deliberately
-- aborted. The engine now records "cancelled" (see calls.ts), but the
-- calls.status CHECK would reject it. Widen the CHECK. Idempotent:
-- dropping + re-adding the same-named constraint is safe on re-run.
-- (Fresh installs: vibetalk-all-pending.sql §2 already includes
-- 'cancelled' in the CHECK.)
-- =====================================================================
alter table public.calls drop constraint if exists calls_status_check;
alter table public.calls add constraint calls_status_check
  check (status in ('completed', 'missed', 'declined', 'failed', 'cancelled'));

-- =====================================================================
-- §M53 — Presence moves out of `profiles` into its own table
-- (audit-2 M53: heartbeat broadcast storm)
--
-- Root cause: touch_presence UPDATEed `profiles` every 25s per online
-- user, and `profiles` is in the supabase_realtime publication — so
-- every heartbeat broadcast to every subscribed tab (N events / 25s /
-- tab), and each tab ran 3-4 profiles channels on top of that.
--
-- Fix: the heartbeat now writes ONLY the `presence` table, which is
-- NEVER added to the publication (new tables are not auto-added; the
-- verify query below must return 0 rows). Presence reaches readers
-- via (a) the re-created profiles_public view (LEFT JOIN + COALESCE)
-- and (b) attachPresence() in chat.functions.ts for the table path.
-- `profiles.last_seen_at` / `profiles.is_online` stay in place as
-- frozen legacy columns (backfill source + pre-§M53 clients); no
-- reader uses them after this migration.
--
-- Run AFTER vibetalk-all-pending.sql (any position in this file is
-- fine; the file runs in order). Idempotent: CREATE TABLE IF NOT
-- EXISTS, DROP POLICY IF EXISTS, ON CONFLICT DO NOTHING, DROP +
-- CREATE the function, CREATE OR REPLACE the view.
-- =====================================================================
create table if not exists public.presence (
  user_id uuid primary key references auth.users (id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
alter table public.presence enable row level security;

-- RLS: presence is visible under the same rule as the view's presence
-- gate (self / public / shared room). touch_presence is SECURITY
-- DEFINER so it bypasses RLS; direct client writes are own-only.
drop policy if exists "presence_read_visible" on public.presence;
create policy "presence_read_visible"
  on public.presence for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = presence.user_id and coalesce(p.is_public, true)
    )
    or exists (
      select 1
      from public.rooms r
      join public.room_members m1 on m1.room_id = r.id and m1.user_id = auth.uid()
      join public.room_members m2 on m2.room_id = r.id and m2.user_id = presence.user_id
    )
  );
drop policy if exists "presence_write_own" on public.presence;
create policy "presence_write_own"
  on public.presence for all to authenticated
  using (user_id = auth.uid())
  -- Audit-3 A8-N12: bound last_seen_at — a direct PostgREST
  -- upsert with a future timestamp used to report the user
  -- "online" forever (isUserOnline is 70s-staleness). The window
  -- admits the legitimate writers: touch_presence (SECURITY
  -- DEFINER, bypasses RLS) and markOffline (writes now()).
  with check (
    user_id = auth.uid()
    and last_seen_at >= now() - interval '5 minutes'
    and last_seen_at <= now() + interval '1 minute'
  );

-- Backfill from the frozen profiles timestamps (rows the heartbeat
-- has not touched yet keep their last-known value).
insert into public.presence (user_id, last_seen_at)
select id, last_seen_at from public.profiles
on conflict (user_id) do nothing;

-- touch_presence now writes presence ONLY — never profiles, so the
-- heartbeat no longer broadcasts. DROP + CREATE (not CREATE OR
-- REPLACE) so a signature drift cannot block the replace.
drop function if exists public.touch_presence();
create function public.touch_presence()
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.presence (user_id, last_seen_at)
  values (auth.uid(), now())
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at;
$$;
grant execute on function public.touch_presence() to authenticated;

-- profiles_public re-created: presence columns now come from the
-- presence table (LEFT JOIN + COALESCE to the frozen profiles column
-- for rows the backfill missed). The privacy gate is UNCHANGED.
-- is_online is now DERIVED from the 120s staleness rule instead of the
-- raw profiles.is_online column (which touch_presence only ever set
-- true — anyone ever online showed "Online now" forever; see H25).
-- Audit-5 B5-MEDIUM: 120s matches PRESENCE_STALENESS_MS (audit-4 L47,
-- src/lib/presence.ts) — the view used 70s while the client moved
-- to 120s, so other users saw you "offline" when your last
-- heartbeat was 70-120s old even though the client judged you online.
create or replace view public.profiles_public
with (security_invoker = false) as
select
  p.id,
  case
    when p.id = auth.uid() or coalesce(p.is_name_public, true)
      then p.display_name
    else 'Someone'
  end as display_name,
  case
    when p.id = auth.uid() or coalesce(p.is_avatar_public, true)
      then p.avatar_url
    else null
  end as avatar_url,
  case
    when p.id = auth.uid() or coalesce(p.is_bio_public, true)
      then p.bio
    else null
  end as bio,
  case
    when p.id = auth.uid() or coalesce(p.is_status_public, true)
      then p.custom_status
    else null
  end as custom_status,
  p.is_public,
  case
    when p.id = auth.uid()
      or coalesce(p.is_public, true)
      or exists (
        select 1
        from public.rooms r
        join public.room_members m1 on m1.room_id = r.id and m1.user_id = auth.uid()
        join public.room_members m2 on m2.room_id = r.id and m2.user_id = p.id
      )
      then (coalesce(pr.last_seen_at, p.last_seen_at) > now() - interval '120 seconds')
    else null
  end as is_online,
  case
    when p.id = auth.uid()
      or coalesce(p.is_public, true)
      or exists (
        select 1
        from public.rooms r
        join public.room_members m1 on m1.room_id = r.id and m1.user_id = auth.uid()
        join public.room_members m2 on m2.room_id = r.id and m2.user_id = p.id
      )
      then coalesce(pr.last_seen_at, p.last_seen_at)
    else null
  end as last_seen_at
from public.profiles p
left join public.presence pr on pr.user_id = p.id;

grant select on public.profiles_public to authenticated;
grant select on public.profiles_public to service_role;

-- VERIFY (expect 0 rows — presence must never join the publication):
--   select tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' and tablename = 'presence';
-- VERIFY (heartbeat writes presence, not profiles):
--   select last_seen_at from public.presence where user_id = auth.uid();
--   -- then wait 25s+ and re-select: it must advance, while
--   -- profiles.last_seen_at for the same user stays frozen.

-- =====================================================================
-- AUDIT-2 §M64 — profiles.e2e_public_key: garbage P-256 key brick karta hai
--   publishE2EEKey server fn isValidP256Point enforce karta hai, lekin
--   RLS UPDATE policy (profiles_update_own) user ko direct PostgREST se
--   e2e_public_key kisi bhi string par set karne deti hai. Phir
--   encryptForRoom har sender ke liye har shared room mein
--   E2EENotReadyError throw karta hai. Fix: BEFORE UPDATE trigger jo
--   e2e_public_key ko kisi bhi UPDATE par validate kare (NULL = clear
--   karna, allowed). Server fn ke publishes bhi isi trigger se guzarte
--   hain (defense in depth — fn ka JS check bilkul wahi on-curve check
--   hai, is liye agree karte hain).
--   Column-whitelist (sirf display_name/bio/custom_status/avatar_url/is_*
--   update karne dena) JAAN BOOJH KAR NAHI lagaya: profiles.message_count
--   ko ek DB trigger maintain karta hai (migration 20260515042604 line
--   157 — message insert par UPDATE profiles SET message_count+1), aur
--   ek whitelist trigger usay bhi rok dega. Wo alag careful pass hai.
--   Verify (live DB): PATCH /profiles?id=eq.<self>
--   {"e2e_public_key":"garbage"} -> FAIL; valid P-256 point -> OK.
-- =====================================================================
create or replace function public.validate_e2e_public_key(key text)
returns boolean
language plpgsql
stable
as $$
declare
  raw bytea;
  x numeric;
  y numeric;
  i int;
  -- P-256 prime p = 2^256 - 2^224 + 2^192 + 2^96 - 1 (SEC 2), curve
  -- constant b = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B.
  p constant numeric := 115792089210356248762697446949407573530086143415290314195533631308867097853951;
  b constant numeric := 41058363725152142129326129780047268409114441015993725554835256314039467401291;
begin
  if key is null then
    return true; -- clearing the key is always allowed
  end if;
  begin
    -- base64url -> standard base64 (+ padding) -> bytes.
    raw := decode(
      replace(replace(key, '-', '+'), '_', '/')
        || repeat('=', (4 - length(replace(replace(key, '-', '+'), '_', '/')) % 4) % 4),
      'base64'
    );
  exception when others then
    return false; -- not valid base64 at all
  end;
  -- Uncompressed point: exactly 65 bytes, first byte 0x04.
  if length(raw) <> 65 or get_byte(raw, 0) <> 4 then
    return false;
  end if;
  -- Big-endian bytes -> numeric (arbitrary precision, no overflow).
  x := 0;
  for i in 1..32 loop
    x := x * 256 + get_byte(raw, i);
  end loop;
  y := 0;
  for i in 33..64 loop
    y := y * 256 + get_byte(raw, i);
  end loop;
  if x >= p or y >= p then
    return false;
  end if;
  -- On-curve check: y^2 == x^3 - 3x + b (mod p).
  return mod(y * y, p) = mod(x * x * x - 3 * x + b, p);
exception when others then
  return false;
end;
$$;

create or replace function public.prevent_bad_e2e_key()
returns trigger
language plpgsql
as $$
begin
  if new.e2e_public_key is distinct from old.e2e_public_key
     and not public.validate_e2e_public_key(new.e2e_public_key) then
    raise exception 'Invalid e2e_public_key — not a valid P-256 public key.';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_validate_e2e_key on public.profiles;
create trigger profiles_validate_e2e_key
  before update on public.profiles
  for each row execute function public.prevent_bad_e2e_key();


-- =============================================================================
-- PART 4 of 5 — vibetalk-audit3-fixes.sql (audit-3 fixes: A4/A8-series, L49/L70/L84)
-- =============================================================================

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


-- =============================================================================
-- PART 5 of 5 — vibetalk-audit4-fixes.sql (audit-4/5/6 fixes: C1 password_setup_pending, M27, M29, L40, A5-M4, A6-G-B3, A6-G-B6)
-- =============================================================================

-- VibeTalk audit-4 fixes (Audit 4, 2026-10-19). Run AFTER vibetalk-audit3-fixes.sql.
-- All sections idempotent. Run order for a fresh project:
--   1. supabase/vibetalk-all-pending.sql
--   2. supabase/vibetalk-audit-fixes.sql
--   3. supabase/vibetalk-audit2-fixes.sql
--   4. supabase/vibetalk-audit3-fixes.sql
--   5. supabase/vibetalk-audit4-fixes.sql (this file)

-- §C1 (Audit-4 CRITICAL): server-side password-setup-pending state.
-- The old flag lived in auth.users.user_metadata (password_setup_pending),
-- which ANY authenticated user can overwrite via
-- supabase.auth.updateUser({ data: { password_setup_pending: true } }) —
-- so it was never proof of anything, yet the app used it as the
-- authorization for the /set-password flow. The truth is this table:
-- only service_role (the server functions) ever touches it. RLS is
-- enabled with NO policies, so anon/authenticated roles are denied
-- outright (service_role bypasses RLS). The user_metadata flag remains
-- only as a UX hint for the _app bounce / callback routing.
-- Pre-SQL behaviour: the app falls back to the metadata flag
-- (completePasswordSetup / getPasswordSetupPending read it via the
-- admin API), so setup keeps working until this runs — the table only
-- hardens it.
create table if not exists public.password_setup_pending (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.password_setup_pending enable row level security;

-- =====================================================================
-- §M27 (Audit-4 MEDIUM): can_view_room / is_room_member were a
-- private-room membership oracle.
--
-- Both are SECURITY DEFINER with GRANT EXECUTE TO authenticated —
-- the grant is REQUIRED (RLS policies call them, and policy
-- evaluation needs the caller to hold EXECUTE on the function).
-- But the functions answered about the _user_id PARAMETER, so any
-- authenticated user could call them directly via PostgREST RPC
-- with ANY _user_id and learn whether an arbitrary user is a
-- member of an arbitrary (private) room — plus room existence /
-- privacy.
--
-- Fix: both functions now answer about auth.uid() ONLY. The
-- _user_id parameter is still accepted (signature unchanged, so
-- every RLS policy / realtime policy / app RPC call site keeps
-- working — including named-argument RPC `{_room_id, _user_id}`),
-- but its value is IGNORED. A direct RPC with someone else's id
-- answers about the caller, never the victim. Verified: every
-- in-repo call site already passes the caller's own id (policies:
-- auth.uid(); app RPC: context.userId), so no legitimate caller
-- changes behaviour. The GRANT stays (policies need it); the
-- oracle is closed by the auth.uid() binding, not by revoking
-- EXECUTE (which would break every policy that calls them).
-- Preserves audit-fixes §C1: no admin/special branches.
-- Idempotent: CREATE OR REPLACE (same signature); grants untouched.
-- =====================================================================
create or replace function public.is_room_member(_room_id uuid, _user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.room_members
    where room_id = _room_id and user_id = auth.uid()
  )
$$;

create or replace function public.can_view_room(_room_id uuid, _user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = _room_id
      and (not r.is_private or public.is_room_member(_room_id, auth.uid()))
  )
$$;

-- =====================================================================
-- §M29 (Audit-4 MEDIUM): storage SELECT avatar carve-out let a
-- private avatar stay directly downloadable via a known path.
--
-- The §M18 policy (vibetalk-audit-fixes.sql) granted ANY
-- authenticated user SELECT on ANY `<userId>/profile/<file>`
-- object — no privacy predicate. signAvatar enforces privacy at
-- the app layer, but anyone who saw the avatar while public (or
-- learned the path) could GET
-- /storage/v1/object/chat-attachments/<userId>/profile/<file>
-- directly AFTER the owner set the avatar Private — the path
-- never rotates, so the leak was permanent.
--
-- Fix: the avatar branch now calls public.can_view_avatar(), a
-- SECURITY DEFINER function mirroring signAvatar's rule exactly
-- (is_avatar_public, is_public + DM-contact exception). A DEFINER
-- function is REQUIRED here — an inline profiles lookup inside
-- the policy would run under the requester's RLS, and post-C3
-- profiles is own-row-only, so the requester could never see
-- another user's row and every avatar would deny (including via
-- signAvatar). The owner-self case stays covered by the policy's
-- first (uploader) branch; the function also returns true for
-- self. Pre-privacy-SQL tolerance (columns missing) fails OPEN to
-- public, same as signAvatar (M103) — no regression before the
-- privacy SQL runs. Uploader + room branches unchanged.
-- Idempotent: CREATE OR REPLACE the function, DROP + CREATE the
-- policy (same name). Create the function FIRST (policy refs it).
-- =====================================================================
create or replace function public.can_view_avatar(_owner_id uuid)
returns boolean language plpgsql stable security definer set search_path = public
as $$
begin
  -- Owner always sees their own avatar.
  if auth.uid() = _owner_id then
    return true;
  end if;
  -- Mirror signAvatar (chat.functions.ts): deny when the avatar
  -- section is private, or when the profile is hidden and the
  -- viewer is not an existing DM contact (a DM is the only 1:1,
  -- mutual-ish context — sharing a group room does not count).
  -- NULL privacy columns (never set) count as public, matching
  -- signAvatar's `=== false` checks. A missing profile row denies.
  return exists (
    select 1 from public.profiles p
    where p.id = _owner_id
      and coalesce(p.is_avatar_public, true)
      and (
        coalesce(p.is_public, true)
        or exists (
          select 1
          from public.room_members m1
          join public.room_members m2 on m2.room_id = m1.room_id
          join public.rooms r on r.id = m1.room_id and r.is_dm
          where m1.user_id = auth.uid()
            and m2.user_id = _owner_id
        )
      )
  );
exception
  when undefined_column then
    -- Pre-privacy-SQL: the privacy columns do not exist yet, so
    -- there is no privacy setting to honor — same tolerance as
    -- signAvatar (M103): treat as public.
    return true;
end;
$$;

drop policy if exists "Uploader or room members can read chat attachments" on storage.objects;
create policy "Uploader or room members can read chat attachments" on storage.objects
for select to authenticated
using (
  bucket_id = 'chat-attachments'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or (
      -- Audit-3 A8-N11: STRICT UUID regex (see §M18) — a strict
      -- shape can never fail the ::uuid cast below.
      (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and public.can_view_room(((storage.foldername(name))[2])::uuid, auth.uid())
    )
    or (
      -- Audit-4 M29: avatar branch — the old bare
      -- `(foldername)[2] = 'profile'` carve-out granted ANY
      -- authenticated user SELECT on ANY avatar, bypassing the
      -- privacy setting. Now gated on can_view_avatar (same rule
      -- as signAvatar), with the strict-UUID guard on the owner
      -- segment so a malformed path can never fail the cast.
      (storage.foldername(name))[2] = 'profile'
      and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and public.can_view_avatar(((storage.foldername(name))[1])::uuid)
    )
  )
);

-- ============================================================
-- §L40 (Audit-4): atomic push-subscription cap.
-- The code-side check in savePushSubscription is check-then-
-- upsert: two concurrent saves can both pass it (READ COMMITTED
-- hides the other's uncommitted row) and both insert -> 21 rows.
-- This BEFORE INSERT trigger is the atomic enforcement: it takes
-- a per-user transaction-scoped advisory lock FIRST (serializing
-- concurrent inserts for that user), then re-checks for an
-- existing row with the same endpoint (a refresh is always
-- allowed, even at the cap — the upsert's ON CONFLICT path), and
-- only then counts. The code check stays as the fast-path
-- friendly error; the trigger is the race backstop. The trigger
-- runs as the inserting role, so its queries see exactly the
-- caller's own rows under RLS — the same rows the cap counts.
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- ============================================================
create or replace function public.enforce_push_subscription_cap()
returns trigger
language plpgsql
-- Audit-5 B5-INFO: pin search_path like every other function in
-- these files (this one was the lone exception — safe in practice,
-- but a trigger function must not resolve tables through a
-- caller-controlled search_path).
set search_path = public
as $$
begin
  -- Serialize concurrent inserts for THIS user only (the lock is
  -- transaction-scoped: released when the upsert commits/rolls
  -- back). Without it, two racing upserts both see count < 20.
  perform pg_advisory_xact_lock(hashtext(new.user_id::text)::bigint);
  -- Refresh of an already-saved endpoint: always allowed.
  -- Re-checked AFTER the lock: a concurrent upsert for the same
  -- endpoint may have committed between our snapshot and the lock.
  if exists (
    select 1 from public.push_subscriptions
    where user_id = new.user_id and endpoint = new.endpoint
  ) then
    return new;
  end if;
  if (select count(*) from public.push_subscriptions where user_id = new.user_id) >= 20 then
    raise exception 'Too many push subscriptions for this account (max 20). Remove one from the Registered devices list below.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Audit-6 G-B4: the trigger pair is guarded — push_subscriptions
-- is created by migrations/20261006090435_push_subscriptions.sql,
-- NOT by any of the 5 run-files; on a project where that migration
-- hasn't applied, the unguarded pair errored mid-file and
-- endangered every section after §L40 (§A5-M4/L12/L14). The
-- function above is safe unguarded (it names the table only at
-- fire time). If skipped, re-run this file after the migration.
do $$
begin
  if to_regclass('public.push_subscriptions') is null then
    raise notice 'L40: public.push_subscriptions does not exist yet — skipping the cap trigger; re-run this file after migration 20261006090435 has applied.';
  else
    drop trigger if exists push_subscription_cap on public.push_subscriptions;
    create trigger push_subscription_cap
    before insert on public.push_subscriptions
    for each row execute function public.enforce_push_subscription_cap();
  end if;
end;
$$;


-- =====================================================================
-- §A5-M4 (Audit-5 MEDIUM): tus uploads had no quota, no rate limit,
-- no orphan sweep. Uploads go straight from the client to Storage
-- with the user's JWT — the only INSERT gate was the own-folder
-- policy, and caps (1 GB) were client-side only. One account could
-- fill the bucket with never-attached objects (nothing accounts
-- between "bytes stored" and "file attached"; the sendMessage size
-- check runs only on attach).
--
-- (1) QUOTA + RATE LIMIT at the only hard enforcement point — the
-- storage INSERT policy. public.attachment_within_quota(uuid)
-- counts the folder owner's chat-attachments objects:
--   * < 30 created in the last hour (creation rate limit)
--   * < 300 created in the last 24 hours
--   * < 2 GiB total bytes (per-user quota, from storage metadata)
-- A tus completion inserts the object row under the uploader's own
-- JWT, so scripted clients are gated exactly like the shipped one.
-- The policy passes only auth.uid() — the function answers about
-- the caller's own folder (M27's binding pattern).
--
-- (2) ORPHAN SWEEP: public.find_orphan_attachments(limit) lists
-- chat-attachments objects older than 7 days that no messages row
-- references (attachment_url) and that are not a live avatar
-- (profiles.avatar_url). It deletes NOTHING: the app sweeps
-- opportunistically from sendMessage (H27's GC pattern) and removes
-- the files through the Storage API (removeStoragePaths), which is
-- the path that deletes rows + bytes for certain. The 7-day age
-- gate protects outbox-queued uploads (an offline user's queued
-- message can legitimately attach days later). Execute is
-- service-role only.
--
-- Idempotent: CREATE OR REPLACE + DROP POLICY IF EXISTS + CREATE.
-- If this section has not run, the bucket keeps the old own-folder
-- policy (no quota) and the opportunistic sweep is a no-op (its RPC
-- error is swallowed) — nothing breaks.
-- =====================================================================

create or replace function public.attachment_within_quota(_user_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select
    (select count(*) from storage.objects
      where bucket_id = 'chat-attachments'
        and (storage.foldername(name))[1] = _user_id::text
        and created_at > now() - interval '1 hour') < 30
    and (select count(*) from storage.objects
      where bucket_id = 'chat-attachments'
        and (storage.foldername(name))[1] = _user_id::text
        and created_at > now() - interval '24 hours') < 300
    and (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects
      where bucket_id = 'chat-attachments'
        and (storage.foldername(name))[1] = _user_id::text) < 2147483648;
$$;

revoke execute on function public.attachment_within_quota(uuid) from public, anon;
grant execute on function public.attachment_within_quota(uuid) to authenticated;

drop policy if exists "Authenticated can upload chat attachments to own folder" on storage.objects;
create policy "Authenticated can upload chat attachments to own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.attachment_within_quota(auth.uid())
  );

create or replace function public.find_orphan_attachments(_limit integer default 200)
returns setof text language sql stable security definer set search_path = public
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'chat-attachments'
    and o.created_at < now() - interval '7 days'
    and not exists (
      select 1 from public.messages m where m.attachment_url = o.name
    )
    and not exists (
      select 1 from public.profiles p where p.avatar_url = o.name
    )
  limit greatest(1, least(_limit, 1000));
$$;

revoke execute on function public.find_orphan_attachments(integer) from public, anon, authenticated;
-- Audit-6 G-B2: the revoke above left the function executable by
-- NOBODY — the MEDIUM-4 sweep (chat.functions.ts, via the admin
-- client) calls it as service_role, and its live executability
-- silently rested on Supabase default privileges. Grant it
-- explicitly, matching the repo convention (check_rate_limit).
grant execute on function public.find_orphan_attachments(integer) to service_role;

-- =====================================================================
-- §A5-L12 (audit-5 LOW-12): drop vestigial get_moderation_status()
-- =====================================================================
-- The admin moderation layer was REMOVED (audit-2 M2 — the
-- middleware has "No moderation layer" explicitly), so this
-- SECURITY DEFINER function is vestigial: nothing in the app calls
-- it (no src/ or SQL caller anywhere), yet any authenticated user
-- could rpc() it with ANY user id and read that user's banned /
-- muted_until flags (PostgREST RPC bypasses table RLS on definer
-- fns). Ban/mute ENFORCEMENT lives in the check_banned trigger
-- (vibetalk-audit-fixes.sql §C2/H9-era), not in this function, so
-- dropping it removes an oracle with zero behavior change.
-- Idempotent: drop-if-exists on the exact signature
-- get_moderation_status(UUID).
drop function if exists public.get_moderation_status(uuid);

-- =====================================================================
-- §A5-L14 (audit-5 LOW-14): lock EXECUTE on 4 SECURITY DEFINER fns
-- =====================================================================
-- join_public_room, leave_room_atomic, create_room_with_creator and
-- can_view_avatar were granted EXECUTE to authenticated but never
-- REVOKED from public/anon — PostgreSQL defaults EXECUTE to PUBLIC
-- (anon included), so an unauthenticated caller could invoke all
-- four (e.g. can_view_avatar as a privacy-probe oracle; the room
-- fns as writes gated only by their internal checks). Revoke from
-- public + anon, keep the authenticated grant: all four are called
-- by authenticated clients (can_view_avatar additionally from the
-- chat-attachments storage policy, whose reads always carry an
-- authenticated session — the authenticated grant covers it,
-- mirroring §M29).
-- Idempotence / ordering: each statement is wrapped in a
-- to_regprocedure DO-block (MEDIUM-6 convention) so a mis-ordered
-- run (this file before the file defining a function) does not
-- abort; the revoke simply doesn't fire until both have run.
do $$
begin
  if to_regprocedure('public.join_public_room(uuid)') is not null then
    revoke execute on function public.join_public_room(uuid) from public, anon;
    grant execute on function public.join_public_room(uuid) to authenticated;
  end if;
end $$;

do $$
begin
  if to_regprocedure('public.leave_room_atomic(uuid)') is not null then
    revoke execute on function public.leave_room_atomic(uuid) from public, anon;
    grant execute on function public.leave_room_atomic(uuid) to authenticated;
  end if;
end $$;

do $$
begin
  if to_regprocedure('public.create_room_with_creator(text, text, boolean, boolean)') is not null then
    revoke execute on function public.create_room_with_creator(text, text, boolean, boolean) from public, anon;
    grant execute on function public.create_room_with_creator(text, text, boolean, boolean) to authenticated;
  end if;
end $$;

do $$
begin
  if to_regprocedure('public.can_view_avatar(uuid)') is not null then
    revoke execute on function public.can_view_avatar(uuid) from public, anon;
    grant execute on function public.can_view_avatar(uuid) to authenticated;
  end if;
end $$;


-- =====================================================================
-- §A6-G-B3 (Audit-6): get_thread_previews was never revoked from
-- PUBLIC — its migration granted EXECUTE to authenticated but left
-- the default PUBLIC grant in place, so ANON could invoke it (the
-- one read RPC LOW-14's sweep missed). It is INVOKER + RLS-bound
-- today, but the grant surface should match every other function
-- in these files. Guarded like §A5-L14.
-- =====================================================================
do $$
begin
  if to_regprocedure('public.get_thread_previews(uuid[])') is not null then
    revoke execute on function public.get_thread_previews(uuid[]) from public, anon;
    grant execute on function public.get_thread_previews(uuid[]) to authenticated;
  end if;
end $$;


-- =====================================================================
-- §A6-G-B6 (Audit-6): search_path pinning sweep — the 9 remaining
-- trigger/validator functions (audit2: prevent_message_tampering,
-- prevent_room_flag_tampering, prevent_call_invite_tampering,
-- prevent_bad_e2e_key, validate_e2e_public_key; audit3:
-- enforce_message_insert_defaults, force_typing_updated_at,
-- prevent_bad_e2e_key_insert, enforce_rooms_insert_defaults) never
-- pinned search_path. All are SECURITY INVOKER with fully-qualified
-- references (no live hijack path — a consistency gap, not a
-- vulnerability). ALTER FUNCTION pins them WITHOUT reproducing
-- their bodies; each guarded (MEDIUM-6 convention) so a
-- mis-ordered run skips instead of aborting.
-- =====================================================================
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.prevent_message_tampering()',
    'public.prevent_room_flag_tampering()',
    'public.prevent_call_invite_tampering()',
    'public.prevent_bad_e2e_key()',
    'public.validate_e2e_public_key(text)',
    'public.enforce_message_insert_defaults()',
    'public.force_typing_updated_at()',
    'public.prevent_bad_e2e_key_insert()',
    'public.enforce_rooms_insert_defaults()'
  ] loop
    if to_regprocedure(fn) is not null then
      execute format('alter function %s set search_path = public', fn);
    else
      raise notice 'G-B6: % does not exist yet — skipping (run the audit2/audit3 files first).', fn;
    end if;
  end loop;
end $$;
