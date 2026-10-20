
DO $$ BEGIN
  EXECUTE 'CREATE POLICY "Authenticated can read chat attachments" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = ''chat-attachments'')';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  EXECUTE 'CREATE POLICY "Authenticated can upload chat attachments to own folder" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = ''chat-attachments'' AND (storage.foldername(name))[1] = auth.uid()::text)';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  EXECUTE 'CREATE POLICY "Owners can delete own chat attachments" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = ''chat-attachments'' AND (storage.foldername(name))[1] = auth.uid()::text)';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.get_or_create_dm(_other uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me uuid := auth.uid();
  room uuid;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF _other = me THEN RAISE EXCEPTION 'Cannot DM yourself'; END IF;

  SELECT r.id INTO room
  FROM public.rooms r
  JOIN public.room_members m1 ON m1.room_id = r.id AND m1.user_id = me
  JOIN public.room_members m2 ON m2.room_id = r.id AND m2.user_id = _other
  WHERE r.is_dm = true
  LIMIT 1;

  IF room IS NOT NULL THEN RETURN room; END IF;

  INSERT INTO public.rooms (name, is_dm, is_private, created_by)
  VALUES ('dm', true, true, me)
  RETURNING id INTO room;

  INSERT INTO public.room_members (room_id, user_id) VALUES (room, me), (room, _other);
  RETURN room;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_dm(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.touch_presence()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.profiles
     SET last_seen_at = now(), is_online = true
   WHERE id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.touch_presence() TO authenticated;
