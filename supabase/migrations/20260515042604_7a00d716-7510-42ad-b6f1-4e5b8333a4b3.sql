
-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('admin', 'special', 'user');
CREATE TYPE public.message_type AS ENUM ('text', 'image', 'video', 'audio', 'voice', 'file', 'system');

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'User',
  avatar_url TEXT,
  bio TEXT,
  custom_status TEXT,
  is_online BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_count INT NOT NULL DEFAULT 0,
  banned BOOLEAN NOT NULL DEFAULT false,
  muted_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

-- ============ TOKENS ============
CREATE TABLE public.tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ,
  used_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;

-- ============ ROOMS ============
CREATE TABLE public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_private BOOLEAN NOT NULL DEFAULT false,
  is_dm BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.room_members (
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_room_member(_room_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.room_members WHERE room_id = _room_id AND user_id = _user_id) $$;

CREATE OR REPLACE FUNCTION public.can_view_room(_room_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = _room_id
      AND (
        NOT r.is_private
        OR public.is_room_member(_room_id, _user_id)
        OR public.has_role(_user_id, 'admin')
        OR public.has_role(_user_id, 'special')
      )
  )
$$;

-- ============ MESSAGES ============
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  body TEXT,
  type public.message_type NOT NULL DEFAULT 'text',
  attachment_url TEXT,
  attachment_meta JSONB,
  pinned BOOLEAN NOT NULL DEFAULT false,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_messages_room_created ON public.messages(room_id, created_at DESC);

CREATE TABLE public.message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, emoji)
);
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

-- ============ AUTO-PROFILE + ROLE ON SIGNUP ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1), 'User'));
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user') ON CONFLICT DO NOTHING;
  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ MESSAGE INSERT TRIGGERS (rate limit + activity) ============
CREATE OR REPLACE FUNCTION public.before_message_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  last_msg TIMESTAMPTZ;
  is_muted TIMESTAMPTZ;
  is_banned BOOLEAN;
BEGIN
  SELECT muted_until, banned INTO is_muted, is_banned FROM public.profiles WHERE id = NEW.user_id;
  IF is_banned THEN RAISE EXCEPTION 'User is banned'; END IF;
  IF is_muted IS NOT NULL AND is_muted > now() THEN RAISE EXCEPTION 'User is muted'; END IF;

  SELECT MAX(created_at) INTO last_msg FROM public.messages
  WHERE user_id = NEW.user_id AND created_at > now() - INTERVAL '5 seconds';
  IF last_msg IS NOT NULL AND NOT public.has_role(NEW.user_id, 'admin') THEN
    RAISE EXCEPTION 'Rate limit: please wait a moment before sending another message';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_before_message_insert BEFORE INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.before_message_insert();

CREATE OR REPLACE FUNCTION public.after_message_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.rooms SET last_activity_at = now() WHERE id = NEW.room_id;
  UPDATE public.profiles SET message_count = message_count + 1 WHERE id = NEW.user_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_after_message_insert AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.after_message_insert();

-- ============ RLS POLICIES ============
-- profiles: everyone authenticated can read, only owner (or admin) can update
CREATE POLICY "profiles_read_all" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "profiles_insert_self" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

-- user_roles: users see own; only admins manage
CREATE POLICY "roles_read_own_or_admin" ON public.user_roles FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "roles_admin_all" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- tokens: only admins
CREATE POLICY "tokens_admin_all" ON public.tokens FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- rooms: read public rooms or rooms you belong to; create authenticated; admins manage all
CREATE POLICY "rooms_read_visible" ON public.rooms FOR SELECT TO authenticated
  USING (
    NOT is_private
    OR public.is_room_member(id, auth.uid())
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'special')
  );
CREATE POLICY "rooms_insert_auth" ON public.rooms FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = created_by AND NOT is_dm);
CREATE POLICY "rooms_update_admin_or_creator" ON public.rooms FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "rooms_delete_admin_or_creator" ON public.rooms FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- room_members: read for members + admins; users join themselves
CREATE POLICY "members_read" ON public.room_members FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_room_member(room_id, auth.uid())
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'special')
  );
CREATE POLICY "members_join_self" ON public.room_members FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "members_leave_self_or_admin" ON public.room_members FOR DELETE TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

-- messages: read in rooms you can view; insert your own in rooms you can view; edit own within 5min; admins do anything
CREATE POLICY "messages_read" ON public.messages FOR SELECT TO authenticated
  USING (public.can_view_room(room_id, auth.uid()));
CREATE POLICY "messages_insert_own" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND public.can_view_room(room_id, auth.uid()));
CREATE POLICY "messages_update_own_recent" ON public.messages FOR UPDATE TO authenticated
  USING (
    (auth.uid() = user_id AND created_at > now() - INTERVAL '5 minutes')
    OR public.has_role(auth.uid(), 'admin')
  );
CREATE POLICY "messages_delete_own_or_admin" ON public.messages FOR DELETE TO authenticated
  USING (
    (auth.uid() = user_id AND created_at > now() - INTERVAL '5 minutes')
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'special')
  );

-- reactions: any authenticated viewer can react / read in visible rooms
CREATE POLICY "reactions_read" ON public.message_reactions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.messages m WHERE m.id = message_id AND public.can_view_room(m.room_id, auth.uid())));
CREATE POLICY "reactions_insert_own" ON public.message_reactions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "reactions_delete_own" ON public.message_reactions FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ============ REALTIME ============
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE public.message_reactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.room_members;

-- ============ SEED A DEFAULT GENERAL ROOM ============
INSERT INTO public.rooms (name, description, is_private, is_dm)
VALUES ('General', 'Welcome to TokenChat — say hi!', false, false);
