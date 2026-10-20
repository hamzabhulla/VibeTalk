-- VibeTalk per-section profile privacy (idempotent — safe to re-run).
-- Each profile section (photo / name / bio / status) can be Public or Private.
-- Private sections are hidden when OTHER users view the profile. The global
-- is_public flag (vibetalk-e2ee-visibility.sql) still controls People-list discovery.
alter table public.profiles
  add column if not exists is_avatar_public boolean not null default true,
  add column if not exists is_name_public boolean not null default true,
  add column if not exists is_bio_public boolean not null default true,
  add column if not exists is_status_public boolean not null default true;
