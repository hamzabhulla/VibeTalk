
ALTER TABLE public.tokens
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS grants_role app_role NOT NULL DEFAULT 'user';
