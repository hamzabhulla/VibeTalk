-- Per-user chat actions: pin + mute (stored on the membership row).
-- Run once in the Supabase SQL Editor.

ALTER TABLE public.room_members
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_muted BOOLEAN NOT NULL DEFAULT false;

-- Let users update their own membership row (pin / mute only make sense per user).
DROP POLICY IF EXISTS "members_update_own" ON public.room_members;
CREATE POLICY "members_update_own" ON public.room_members
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
