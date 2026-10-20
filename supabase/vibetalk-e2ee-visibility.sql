-- VibeTalk: profile visibility + E2EE columns.
--
-- HOW TO APPLY: paste this whole file into the Supabase SQL Editor
-- (project fkxgyhnivsaijzwpwpjf) and run it once.
--
-- The app tolerates these columns being missing (visibility defaults to
-- public, E2EE rooms can't be created), but the features only activate
-- once this runs:
--   * profiles.is_public       — Profile visibility (Public/Private) toggle
--   * profiles.e2e_public_key  — this browser's E2EE public key (ECDH P-256)
--   * rooms.is_e2ee            — marks a room as end-to-end encrypted
--
-- Nothing here deletes data. Old user_roles / moderation tables are left
-- untouched (the app no longer reads them).

alter table public.profiles
  add column if not exists is_public boolean not null default true;

alter table public.profiles
  add column if not exists e2e_public_key text;

alter table public.rooms
  add column if not exists is_e2ee boolean not null default false;
