-- VibeTalk call history (1:1 voice + video calls).
--
-- HOW TO APPLY: paste this whole file into the Supabase SQL Editor
-- (project fkxgyhnivsaijzwpwpjf) and run it once.
--
-- Calls themselves do NOT need this table: signaling runs over Supabase
-- Realtime broadcast and media is peer-to-peer WebRTC. This table only
-- stores per-user call history for the Calls tab. Until this runs, the
-- Calls tab shows an empty state and calls still work.

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  peer_id uuid not null,
  peer_name text not null default 'Unknown',
  type text not null check (type in ('voice', 'video')),
  direction text not null check (direction in ('incoming', 'outgoing')),
  status text not null check (status in ('completed', 'missed', 'declined', 'failed', 'cancelled')), -- Audit-6 G-B5: aligned with the canonical set in vibetalk-all-pending.sql §2 (§M40 'cancelled' was missing here)
  duration_seconds integer not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists calls_user_started_idx
  on public.calls (user_id, started_at desc);

alter table public.calls enable row level security;

-- SUPERSEDED (audit-2 H34): DDL lives in vibetalk-all-pending.sql §2;
-- policies (calls_select_own, calls_insert_own) live ONLY in
-- vibetalk-audit2-fixes.sql §H34. This file is DDL-only now — safe to
-- re-run, but not needed. Do NOT re-add policies here.
