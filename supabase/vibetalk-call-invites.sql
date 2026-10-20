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

-- SUPERSEDED (audit-2 H34): DDL lives in vibetalk-all-pending.sql §5;
-- the read policy lives ONLY in vibetalk-audit2-fixes.sql §H34, and the
-- INSERT policy is DROPPED everywhere (audit-2 §H33 — direct INSERT let
-- anyone fake a ringing call). This file is DDL-only now — safe to
-- re-run, but not needed. Do NOT re-add policies here (esp. NOT the
-- INSERT policy).
