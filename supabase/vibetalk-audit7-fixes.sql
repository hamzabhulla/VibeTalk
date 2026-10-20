-- =====================================================================
-- VibeTalk — Audit-7 supplementary SQL (2026-10-20)
-- Four small database-side companions to the Audit-7 code fixes:
--   §1 (B1) partial unique index closing the attachment-gate race
--   §2 (G6) validate_e2e_public_key: revoke anon/PUBLIC execute
--   §3 (G7) profiles_public: avatar column gated by can_view_avatar
--   §4 (G5) profiles_public: revoke the implicit anon SELECT so the
--           grants match the file's stated authenticated-only intent
-- Every statement is idempotent — safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- §1 (Audit-7 B1) — one attachment file, one message: DB backstop.
-- The sendMessage gate (chat.functions.ts) now error-checks its
-- lookup, but two SIMULTANEOUS sends of the same path can both pass
-- a SELECT-then-INSERT check. This partial unique index makes the
-- second insert fail at the database, which is the only place a
-- race can actually be closed.
--
-- BEFORE RUNNING: check for existing duplicates — if the SELECT
-- below returns any rows, the CREATE UNIQUE INDEX will (correctly)
-- fail until those duplicate messages are cleaned up. In that case
-- STOP and report the rows; do not delete messages on sight.
--   select attachment_url, count(*)
--   from public.messages
--   where attachment_url is not null
--   group by attachment_url
--   having count(*) > 1;
-- ---------------------------------------------------------------------
create unique index if not exists messages_attachment_url_uniq
  on public.messages (attachment_url)
  where attachment_url is not null;


-- ---------------------------------------------------------------------
-- §2 (Audit-7 G6) — validate_e2e_public_key was anonymously
-- executable (Supabase's default PUBLIC execute grant; the function
-- is a pure P-256 validator, so the exposure is information-only —
-- but nothing outside the database ever calls it directly).
-- Its ONLY callers are the two BEFORE triggers on profiles
-- (prevent_bad_e2e_key / prevent_bad_e2e_key_insert), which run as
-- the user performing the update — authenticated — so the trigger
-- path keeps working via the explicit grant. Client code never
-- RPC-calls this function (verified in src/).
-- ---------------------------------------------------------------------
revoke execute on function public.validate_e2e_public_key(text) from public, anon;
grant execute on function public.validate_e2e_public_key(text) to authenticated;


-- ---------------------------------------------------------------------
-- §3 (Audit-7 G7) — profiles_public exposed the avatar_url PATH of
-- a PRIVATE profile to anyone (including anon): the view's avatar
-- case checked only the per-section flag (is_avatar_public), while
-- the storage-side gate can_view_avatar ALSO requires the profile
-- to be public or the viewer to be an existing DM contact. The
-- file BYTES were never exposed (storage refuses anon reads), but
-- the path string itself should follow the same rule. The avatar
-- case now defers to can_view_avatar itself, so the two gates can
-- never drift apart again. Every other column is byte-identical
-- to the current definition.
-- ---------------------------------------------------------------------
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
    when public.can_view_avatar(p.id)
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


-- ---------------------------------------------------------------------
-- §4 (Audit-7 G5) — profiles_public was readable by anon even
-- though every grant line in the canonical SQL names only
-- authenticated + service_role: Supabase's schema default
-- privileges silently add an anon SELECT on new public-schema
-- views. The view's internal gates are the real protection (and
-- §3 tightens the one weak gate), and the app only ever reads this
-- view with a signed-in session — so align reality with the stated
-- intent and revoke the implicit grant. (If a logged-out surface
-- ever needs public profiles, grant this back deliberately.)
-- ---------------------------------------------------------------------
revoke select on public.profiles_public from anon;

comment on view public.profiles_public is
  'Sanctioned profile surface. SELECT: authenticated + service_role only (anon revoked, Audit-7 G5 — Supabase default privileges had silently granted it). Columns are privacy-gated per row; avatar_url defers to can_view_avatar (Audit-7 G7).';
