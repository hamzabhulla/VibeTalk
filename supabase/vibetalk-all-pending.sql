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
