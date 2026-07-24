-- CrewUp MVP — extensions and ENUM types
-- Requires Postgres 14+. Run after Nhost has provisioned auth + storage schemas.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Role on a crew member's profile (PRD §7.1)
CREATE TYPE public.role_type AS ENUM (
  'cabin_crew',
  'pilot',
  'ground_ops'
);

-- Presence / profile default visibility (PRD §7.3)
CREATE TYPE public.visibility_level AS ENUM (
  'off',
  'friends',
  'friends_of_friends',
  'same_airline',
  'all_verified'
);

-- How crew status was proven
CREATE TYPE public.verification_method AS ENUM (
  'airline_email',
  'id_upload',
  'manual'
);

CREATE TYPE public.verification_status AS ENUM (
  'pending',
  'approved',
  'rejected'
);

-- Where a roster entry came from (airline_portal reserved for Phase 2)
CREATE TYPE public.roster_source AS ENUM (
  'upload',
  'manual',
  'airline_portal'
);

CREATE TYPE public.connection_status AS ENUM (
  'pending',
  'accepted'
);

-- Event publish circle (subset of visibility; no "off")
CREATE TYPE public.event_visibility AS ENUM (
  'friends',
  'same_airline',
  'all_verified'
);

CREATE TYPE public.attendee_status AS ENUM (
  'going',
  'waitlisted',
  'cancelled'
);

CREATE TYPE public.thread_type AS ENUM (
  'direct',
  'event_group'
);

CREATE TYPE public.notification_type AS ENUM (
  'beacon',
  'event_reminder',
  'connection_request',
  'moderation',
  'message'
);

CREATE TYPE public.report_status AS ENUM (
  'open',
  'reviewing',
  'resolved',
  'dismissed'
);

-- Shared updated_at helper used by later migrations
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
-- CrewUp MVP — airlines reference + illustrative Asia launch seed
-- email_domains powers instant verification for recognized airline emails (PRD §8.1).

CREATE TABLE public.airlines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  email_domains text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT airlines_code_unique UNIQUE (code)
);

CREATE TRIGGER airlines_set_updated_at
  BEFORE UPDATE ON public.airlines
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.airlines IS
  'Carrier reference for verification domain matching and same-airline visibility.';
COMMENT ON COLUMN public.airlines.email_domains IS
  'Lowercase domains without @, e.g. {singaporeair.com.sg}. Match against auth.users.email.';

-- Illustrative seed — edit before production. Domains are placeholders.
INSERT INTO public.airlines (code, name, email_domains) VALUES
  ('SQ', 'Singapore Airlines', ARRAY['singaporeair.com.sg']),
  ('CX', 'Cathay Pacific', ARRAY['cathaypacific.com']),
  ('NH', 'All Nippon Airways', ARRAY['ana.co.jp']),
  ('JL', 'Japan Airlines', ARRAY['jal.com']),
  ('KE', 'Korean Air', ARRAY['koreanair.com']),
  ('TG', 'Thai Airways', ARRAY['thaiairways.com']),
  ('VN', 'Vietnam Airlines', ARRAY['vietnamairlines.com']),
  ('GA', 'Garuda Indonesia', ARRAY['garuda-indonesia.com']),
  ('AK', 'AirAsia', ARRAY['airasia.com']),
  ('TR', 'Scoot', ARRAY['flyscoot.com']),
  ('VJ', 'VietJet Air', ARRAY['vietjetair.com']),
  ('5J', 'Cebu Pacific', ARRAY['cebupacificair.com']),
  ('6E', 'IndiGo', ARRAY['goindigo.in']),
  ('MU', 'China Eastern', ARRAY['ceair.com']),
  ('CZ', 'China Southern', ARRAY['csair.com']),
  ('CA', 'Air China', ARRAY['airchina.com']);
-- CrewUp MVP — profiles (1:1 auth.users extension) + verifications
-- Do not alter auth.users; extend via public.profiles (Nhost recommended pattern).

CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '',
  airline_id uuid REFERENCES public.airlines (id) ON DELETE SET NULL,
  base_airport text,
  role_type public.role_type,
  rank text,
  show_rank boolean NOT NULL DEFAULT false,
  preferred_language text NOT NULL DEFAULT 'en',
  default_visibility public.visibility_level NOT NULL DEFAULT 'friends',
  notification_mode text NOT NULL DEFAULT 'realtime'
    CHECK (notification_mode IN ('realtime', 'digest')),
  is_verified boolean NOT NULL DEFAULT false,
  avatar_file_id uuid, -- soft ref to storage.files(id); no FK (Nhost-managed schema)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profiles_airline_id_idx ON public.profiles (airline_id);
CREATE INDEX profiles_is_verified_idx ON public.profiles (is_verified)
  WHERE is_verified = true;

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.profiles IS
  'App profile for each auth.users row. is_verified and airline_id feed JWT custom claims.';
COMMENT ON COLUMN public.profiles.avatar_file_id IS
  'Soft reference to storage.files.id — no FK to avoid migration order issues.';
COMMENT ON COLUMN public.profiles.is_verified IS
  'Denormalized from verifications; keep in sync via trigger for Hasura JWT claims.';

CREATE TABLE public.verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  method public.verification_method NOT NULL,
  status public.verification_status NOT NULL DEFAULT 'pending',
  document_file_id uuid, -- soft ref to storage.files(id)
  reviewed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  rejection_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX verifications_user_id_idx ON public.verifications (user_id);
CREATE INDEX verifications_status_idx ON public.verifications (status)
  WHERE status = 'pending';

CREATE TRIGGER verifications_set_updated_at
  BEFORE UPDATE ON public.verifications
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.verifications IS
  'Crew verification history / staff review queue (PRD §7.1, §7.11).';

-- When a verification is approved, mark the profile verified.
-- audit_log writes are added in 009 after that table exists.
CREATE OR REPLACE FUNCTION public.sync_profile_verified()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
  THEN
    UPDATE public.profiles
    SET
      is_verified = true,
      updated_at = now()
    WHERE user_id = NEW.user_id;
  END IF;

  IF NEW.status = 'rejected'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
  THEN
    -- Only clear badge if there is no other approved verification for this user
    IF NOT EXISTS (
      SELECT 1
      FROM public.verifications v
      WHERE v.user_id = NEW.user_id
        AND v.status = 'approved'
        AND v.id IS DISTINCT FROM NEW.id
    ) THEN
      UPDATE public.profiles
      SET
        is_verified = false,
        updated_at = now()
      WHERE user_id = NEW.user_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER verifications_sync_profile_verified
  AFTER INSERT OR UPDATE OF status ON public.verifications
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_profile_verified();
-- CrewUp MVP — private rosters + derived presence (PRD §7.2, §7.3)
-- Raw roster rows are never exposed to other users via Hasura permissions.
-- presence rows are written by the presence-compute Function (service role).

CREATE TABLE public.rosters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  flight_number text,
  departure_airport text,
  arrival_airport text,
  layover_city text,
  layover_start timestamptz,
  layover_end timestamptz,
  source public.roster_source NOT NULL DEFAULT 'manual',
  source_file_id uuid, -- soft ref to storage.files(id) for uploaded roster artifacts
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rosters_layover_window_check CHECK (
    layover_start IS NULL
    OR layover_end IS NULL
    OR layover_end >= layover_start
  )
);

CREATE INDEX rosters_user_id_idx ON public.rosters (user_id);
CREATE INDEX rosters_user_layover_idx ON public.rosters (user_id, layover_start, layover_end);

CREATE TRIGGER rosters_set_updated_at
  BEFORE UPDATE ON public.rosters
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.rosters IS
  'Private schedule entries. Used only to power presence/matching — never shared raw.';
COMMENT ON COLUMN public.rosters.source_file_id IS
  'Soft reference to storage.files.id for the uploaded screenshot/PDF.';

CREATE TABLE public.presence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  city text NOT NULL,
  date_start date NOT NULL,
  date_end date NOT NULL,
  visibility public.visibility_level NOT NULL,
  roster_id uuid REFERENCES public.rosters (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT presence_date_window_check CHECK (date_end >= date_start)
);

CREATE INDEX presence_city_dates_idx ON public.presence (city, date_start, date_end);
CREATE INDEX presence_user_id_idx ON public.presence (user_id);
CREATE INDEX presence_user_dates_idx ON public.presence (user_id, date_start, date_end);

CREATE TRIGGER presence_set_updated_at
  BEFORE UPDATE ON public.presence
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.presence IS
  'Coarse "in this city, these dates" rows. App users select only; service role writes.';
COMMENT ON COLUMN public.presence.visibility IS
  'Snapshot of owner visibility at compute time for permission filters.';
-- CrewUp MVP — connections + user_blocks (PRD §7.4, §7.9)
-- Blocks are separate from connections so a user can block without a prior friendship.

CREATE TABLE public.connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  addressee_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  status public.connection_status NOT NULL DEFAULT 'pending',
  message text, -- optional intro note on request
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connections_no_self CHECK (requester_id <> addressee_id),
  CONSTRAINT connections_pair_unique UNIQUE (requester_id, addressee_id)
);

CREATE INDEX connections_requester_id_idx ON public.connections (requester_id);
CREATE INDEX connections_addressee_id_idx ON public.connections (addressee_id);
CREATE INDEX connections_status_idx ON public.connections (status);

CREATE TRIGGER connections_set_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.connections IS
  'Friend / connection graph. requester_id should be Hasura column-preset to X-Hasura-User-Id.';

CREATE TABLE public.user_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_blocks_no_self CHECK (blocker_id <> blocked_id),
  CONSTRAINT user_blocks_pair_unique UNIQUE (blocker_id, blocked_id)
);

CREATE INDEX user_blocks_blocker_id_idx ON public.user_blocks (blocker_id);
CREATE INDEX user_blocks_blocked_id_idx ON public.user_blocks (blocked_id);

COMMENT ON TABLE public.user_blocks IS
  'Safety blocks. Filter presence/events/messages so blocked pairs never see each other.';
COMMENT ON COLUMN public.user_blocks.blocker_id IS
  'Hasura column preset: X-Hasura-User-Id.';
-- CrewUp MVP — layover events + RSVPs (PRD §7.5)

CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  city text NOT NULL,
  venue_name text,
  venue_address text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  visibility_scope public.event_visibility NOT NULL DEFAULT 'all_verified',
  tags text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT ARRAY['en'],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_time_window_check CHECK (
    ends_at IS NULL OR ends_at >= starts_at
  )
);

CREATE INDEX events_city_starts_at_idx ON public.events (city, starts_at);
CREATE INDEX events_creator_id_idx ON public.events (creator_id);
CREATE INDEX events_starts_at_idx ON public.events (starts_at);
CREATE INDEX events_tags_gin_idx ON public.events USING gin (tags);

CREATE TRIGGER events_set_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.events IS
  'Layover meetups. creator_id preset to X-Hasura-User-Id.';
COMMENT ON COLUMN public.events.tags IS
  'Free-form tags e.g. alcohol_free, halal_friendly, women_only, karaoke.';

CREATE TABLE public.event_attendees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  status public.attendee_status NOT NULL DEFAULT 'going',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_attendees_unique UNIQUE (event_id, user_id)
);

CREATE INDEX event_attendees_event_id_idx ON public.event_attendees (event_id);
CREATE INDEX event_attendees_user_id_idx ON public.event_attendees (user_id);
CREATE INDEX event_attendees_status_idx ON public.event_attendees (event_id, status);

CREATE TRIGGER event_attendees_set_updated_at
  BEFORE UPDATE ON public.event_attendees
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.event_attendees IS
  'RSVP / waitlist rows. user_id preset to X-Hasura-User-Id on insert.';
-- CrewUp MVP — messaging: threads, participants, messages (PRD §7.6)

CREATE TABLE public.threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type public.thread_type NOT NULL,
  event_id uuid REFERENCES public.events (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT threads_event_group_requires_event CHECK (
    (type = 'event_group' AND event_id IS NOT NULL)
    OR (type = 'direct' AND event_id IS NULL)
  )
);

-- At most one group thread per event
CREATE UNIQUE INDEX threads_event_id_unique
  ON public.threads (event_id)
  WHERE event_id IS NOT NULL;

CREATE TRIGGER threads_set_updated_at
  BEFORE UPDATE ON public.threads
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.threads IS
  'Chat containers: 1:1 (direct) or event-linked group threads.';

CREATE TABLE public.thread_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.threads (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  last_read_at timestamptz,
  muted_until timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thread_participants_unique UNIQUE (thread_id, user_id)
);

CREATE INDEX thread_participants_thread_id_idx ON public.thread_participants (thread_id);
CREATE INDEX thread_participants_user_id_idx ON public.thread_participants (user_id);

COMMENT ON TABLE public.thread_participants IS
  'Membership, read receipts (last_read_at), and mute (muted_until).';
COMMENT ON COLUMN public.thread_participants.last_read_at IS
  'Supports read receipts; cultural default may hide them client-side (PRD §7.6).';

CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.threads (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  body text,
  media_file_id uuid, -- soft ref to storage.files(id)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_has_content CHECK (
    (body IS NOT NULL AND length(trim(body)) > 0)
    OR media_file_id IS NOT NULL
  )
);

CREATE INDEX messages_thread_created_at_idx ON public.messages (thread_id, created_at);
CREATE INDEX messages_sender_id_idx ON public.messages (sender_id);

CREATE TRIGGER messages_set_updated_at
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Bump parent thread.updated_at when a message is inserted (list ordering)
CREATE OR REPLACE FUNCTION public.touch_thread_on_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.threads
  SET updated_at = now()
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_touch_thread
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_thread_on_message();

COMMENT ON TABLE public.messages IS
  'Chat messages. sender_id preset to X-Hasura-User-Id. Subscriptions order by created_at.';
COMMENT ON COLUMN public.messages.media_file_id IS
  'Soft reference to storage.files.id (photos or meetup venue pins as media).';
-- CrewUp MVP — notifications (beacon) + safety reports (PRD §7.7, §7.9)

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  type public.notification_type NOT NULL,
  title text,
  body text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_created_at_idx
  ON public.notifications (user_id, created_at DESC);
CREATE INDEX notifications_user_unread_idx
  ON public.notifications (user_id)
  WHERE read_at IS NULL;

COMMENT ON TABLE public.notifications IS
  'In-app + push log. Inserts from notification-dispatch Function; users mark read_at.';
COMMENT ON COLUMN public.notifications.payload IS
  'Structured context e.g. {\"city\":\"BKK\",\"connection_id\":\"...\",\"event_id\":\"...\"}.';

CREATE TABLE public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  reported_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  reported_message_id uuid REFERENCES public.messages (id) ON DELETE SET NULL,
  reported_event_id uuid REFERENCES public.events (id) ON DELETE SET NULL,
  reason text NOT NULL,
  details text,
  status public.report_status NOT NULL DEFAULT 'open',
  resolution_notes text,
  resolved_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_has_target CHECK (
    reported_user_id IS NOT NULL
    OR reported_message_id IS NOT NULL
    OR reported_event_id IS NOT NULL
  )
);

CREATE INDEX reports_status_idx ON public.reports (status);
CREATE INDEX reports_reporter_id_idx ON public.reports (reporter_id);
CREATE INDEX reports_reported_user_id_idx ON public.reports (reported_user_id);
CREATE INDEX reports_open_created_at_idx ON public.reports (created_at)
  WHERE status IN ('open', 'reviewing');

CREATE TRIGGER reports_set_updated_at
  BEFORE UPDATE ON public.reports
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.reports IS
  'Trust & safety queue. reporter_id preset to X-Hasura-User-Id; staff update status.';
-- CrewUp MVP — additional composite / partial indexes for Hasura query patterns
-- Core per-table indexes are created alongside each table; this file adds cross-cutting ones.

-- Discover accepted friends for presence / beacon matching
CREATE INDEX IF NOT EXISTS connections_accepted_requester_idx
  ON public.connections (requester_id, addressee_id)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS connections_accepted_addressee_idx
  ON public.connections (addressee_id, requester_id)
  WHERE status = 'accepted';

-- Pending inbox for connection requests
CREATE INDEX IF NOT EXISTS connections_pending_addressee_idx
  ON public.connections (addressee_id, created_at DESC)
  WHERE status = 'pending';

-- Presence discovery: non-off visibility only
CREATE INDEX IF NOT EXISTS presence_visible_city_dates_idx
  ON public.presence (city, date_start, date_end)
  WHERE visibility <> 'off';

-- Same-airline presence lookups join profiles.airline_id
CREATE INDEX IF NOT EXISTS presence_user_city_idx
  ON public.presence (user_id, city);

-- Event attendees currently going (capacity / waitlist logic)
CREATE INDEX IF NOT EXISTS event_attendees_going_idx
  ON public.event_attendees (event_id)
  WHERE status = 'going';

-- Thread list for a user ordered by activity (join threads.updated_at in Hasura)
CREATE INDEX IF NOT EXISTS thread_participants_user_joined_idx
  ON public.thread_participants (user_id, joined_at DESC);

-- Bidirectional block checks in permission rules
CREATE INDEX IF NOT EXISTS user_blocks_pair_lookup_idx
  ON public.user_blocks (blocker_id, blocked_id);

-- Airline email-domain lookups during verification
CREATE INDEX IF NOT EXISTS airlines_email_domains_gin_idx
  ON public.airlines USING gin (email_domains);

-- Profiles discover/browse filters (airline, base, role)
CREATE INDEX IF NOT EXISTS profiles_discover_idx
  ON public.profiles (airline_id, role_type, base_airport)
  WHERE is_verified = true;

-- Application roles for Hasura permission rules (nhost-prd §4.1)
INSERT INTO auth.roles (role) VALUES
  ('moderator'),
  ('staff_admin'),
  ('service')
ON CONFLICT DO NOTHING;

-- Storage buckets (PRD §7.1–7.2 file uploads)
INSERT INTO storage.buckets (id, download_expiration, min_upload_file_size, max_upload_file_size, cache_control)
VALUES
  ('avatars', 3600, 0, 10485760, 'public, max-age=3600'),
  ('rosters', 3600, 0, 20971520, 'private, max-age=3600'),
  ('verification-docs', 3600, 0, 10485760, 'private, max-age=3600')
ON CONFLICT (id) DO NOTHING;
