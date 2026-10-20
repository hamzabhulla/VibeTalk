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
