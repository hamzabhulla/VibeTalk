
-- 1. Revoke EXECUTE on SECURITY DEFINER helpers from API roles.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_room_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.can_view_room(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.before_message_insert() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.after_message_insert() FROM PUBLIC, anon, authenticated;
-- has_role / is_room_member / can_view_room are called inside RLS policies,
-- so authenticated users need EXECUTE for those policies to evaluate.
-- They are SECURITY DEFINER with a locked search_path and only return
-- booleans, so granting EXECUTE exposes nothing beyond what RLS already allows.
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_room_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_room(uuid, uuid) TO authenticated;
-- get_or_create_dm and touch_presence ARE intentionally callable by signed-in users via RPC.
REVOKE EXECUTE ON FUNCTION public.get_or_create_dm(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.touch_presence() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_dm(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.touch_presence() TO authenticated;

-- 2. Tokens: explicit anon block (defence-in-depth in addition to RLS).
REVOKE ALL ON TABLE public.tokens FROM anon;
DROP POLICY IF EXISTS tokens_block_anon ON public.tokens;
CREATE POLICY tokens_block_anon ON public.tokens
  AS RESTRICTIVE
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

-- 3. Prevent joining private rooms via room_members insert.
DROP POLICY IF EXISTS members_join_self ON public.room_members;
CREATE POLICY members_join_self ON public.room_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND (
      EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = room_id AND r.is_private = false)
      OR public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'special')
    )
  );

-- 4. Realtime channel authorization for private (typing/presence) channels.
-- Topic conventions: 'typing-<roomId>' and 'room-<roomId>'.
DROP POLICY IF EXISTS "Room members can read realtime channel" ON realtime.messages;
DROP POLICY IF EXISTS "Room members can write realtime channel" ON realtime.messages;

CREATE POLICY "Room members can read realtime channel"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    CASE
      WHEN realtime.topic() LIKE 'typing-%' THEN
        public.can_view_room(
          (substring(realtime.topic() from 'typing-(.*)'))::uuid,
          (SELECT auth.uid())
        )
      WHEN realtime.topic() LIKE 'room-%' THEN
        public.can_view_room(
          (substring(realtime.topic() from 'room-(.*)'))::uuid,
          (SELECT auth.uid())
        )
      ELSE false
    END
  );

CREATE POLICY "Room members can write realtime channel"
  ON realtime.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    CASE
      WHEN realtime.topic() LIKE 'typing-%' THEN
        public.can_view_room(
          (substring(realtime.topic() from 'typing-(.*)'))::uuid,
          (SELECT auth.uid())
        )
      WHEN realtime.topic() LIKE 'room-%' THEN
        public.can_view_room(
          (substring(realtime.topic() from 'room-(.*)'))::uuid,
          (SELECT auth.uid())
        )
      ELSE false
    END
  );

-- can_view_room is called from realtime RLS, so re-grant only to the realtime role(s) that need it.
GRANT EXECUTE ON FUNCTION public.can_view_room(uuid, uuid) TO authenticator;

-- 5. First-admin claim RPC used by /setup (was referenced by the app but never created).
CREATE OR REPLACE FUNCTION public.claim_first_admin()
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'admin') THEN
    RETURN false;
  END IF;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (auth.uid(), 'admin')
  ON CONFLICT DO NOTHING;
  RETURN true;
END; $$;
REVOKE EXECUTE ON FUNCTION public.claim_first_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_first_admin() TO authenticated;
