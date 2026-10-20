-- Read receipts: track when each member last read each room.
-- Run once in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.read_receipts (
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

ALTER TABLE public.read_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "receipts_read_members" ON public.read_receipts;
CREATE POLICY "receipts_read_members" ON public.read_receipts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.room_members m
      WHERE m.room_id = read_receipts.room_id AND m.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "receipts_write_own" ON public.read_receipts;
CREATE POLICY "receipts_write_own" ON public.read_receipts
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
