-- Unread message counts per room for the calling user.
-- Run once in the Supabase SQL Editor.

CREATE OR REPLACE FUNCTION public.get_unread_counts()
RETURNS TABLE (room_id UUID, unread_count BIGINT)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.room_id, COUNT(*)::BIGINT
  FROM public.messages m
  JOIN public.room_members rm
    ON rm.room_id = m.room_id AND rm.user_id = auth.uid()
  LEFT JOIN public.read_receipts r
    ON r.room_id = m.room_id AND r.user_id = auth.uid()
  WHERE m.user_id <> auth.uid()
    AND m.deleted_at IS NULL
    AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
  GROUP BY m.room_id
$$;

REVOKE ALL ON FUNCTION public.get_unread_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unread_counts() TO authenticated;
