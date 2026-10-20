-- Typing indicators: the typing_status table was referenced by the app but
-- never created, so "X is typing…" could never appear.
-- Run once in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.typing_status (
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

ALTER TABLE public.typing_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "typing_read_members" ON public.typing_status;
CREATE POLICY "typing_read_members" ON public.typing_status
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.room_members m
      WHERE m.room_id = typing_status.room_id AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "typing_write_own" ON public.typing_status;
CREATE POLICY "typing_write_own" ON public.typing_status
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
