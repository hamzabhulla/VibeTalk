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
