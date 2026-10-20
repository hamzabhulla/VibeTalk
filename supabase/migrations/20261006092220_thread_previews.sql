-- Latest-message preview per conversation (for the inbox thread list).
-- Run once in the Supabase SQL Editor.
-- SECURITY INVOKER: the caller's own RLS policies apply, so users only ever
-- see previews for rooms they are allowed to view.

CREATE OR REPLACE FUNCTION public.get_thread_previews(p_room_ids uuid[])
RETURNS TABLE (
  room_id uuid,
  user_id uuid,
  body text,
  type text,
  created_at timestamptz,
  display_name text
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT ON (m.room_id)
    m.room_id,
    m.user_id,
    m.body,
    m.type,
    m.created_at,
    p.display_name
  FROM public.messages m
  JOIN public.profiles p ON p.id = m.user_id
  WHERE m.room_id = ANY (p_room_ids)
    AND m.deleted_at IS NULL
  ORDER BY m.room_id, m.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_thread_previews(uuid[]) TO authenticated;
