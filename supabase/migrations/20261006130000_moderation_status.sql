-- Ban/mute enforcement: the get_moderation_status RPC was referenced by the
-- auth middleware but never created, so banned users were never locked out
-- and mutes never reached server functions.
-- Run once in the Supabase SQL Editor.

CREATE OR REPLACE FUNCTION public.get_moderation_status(_user_id UUID)
RETURNS TABLE (banned BOOLEAN, muted_until TIMESTAMPTZ)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT banned, muted_until FROM public.profiles WHERE id = _user_id
$$;

REVOKE ALL ON FUNCTION public.get_moderation_status(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_moderation_status(UUID) TO authenticated;
