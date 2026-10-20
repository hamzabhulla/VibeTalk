-- =====================================================================
-- Remove the invite-token system (owner order, 2026-10-20)
-- + Audit-7 G3/G4: close the anonymous EXECUTE gaps on
--   check_rate_limit and touch_presence.
--
-- RUN ORDER: run this AFTER the app deploy that removed token usage
-- from the code (Cloudflare version 51c527f1, live 2026-10-20 17:33
-- PKT — already deployed). Running it before that deploy would have
-- broken the OLD code's signup + account-delete (both touched
-- public.tokens). The new code never touches the table, so this is
-- pure cleanup + the two revoke fixes.
-- =====================================================================

-- 1. The mint function goes with the system (Audit-7 G1/G2 die here:
--    no function left to execute anonymously or to repair).
drop function if exists public.create_invite_token(int);

-- 2. The tokens table itself. Its policies/indexes/FKs drop with it.
--    password_setup_pending is NOT part of this system and stays.
drop table if exists public.tokens;

-- 3. Audit-7 G3: check_rate_limit must be service_role-only. The app
--    calls it exclusively through the service role (rate-limit.ts);
--    the earlier REVOKE FROM PUBLIC never stripped the direct anon
--    grant (same pattern as G1). Caller-chosen keys would otherwise
--    allow targeted rate-limit poisoning (fail-closed lockouts of
--    other users).
revoke execute on function public.check_rate_limit(text, int, int) from public, anon, authenticated;

-- 4. Audit-7 G4: touch_presence is for signed-in users only (the
--    client heartbeat calls it with the user's session — that
--    authenticated grant stays). Anonymous execution goes.
revoke execute on function public.touch_presence() from public, anon;
