-- Platform-hosted events for CrewUp admin promotional meetups

CREATE TYPE public.event_host_type AS ENUM ('user', 'platform');

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS host_type public.event_host_type NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS is_published boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS featured_until timestamptz;

COMMENT ON COLUMN public.events.host_type IS
  'user = P2P meetup; platform = CrewUp admin-hosted promotional event.';
COMMENT ON COLUMN public.events.is_published IS
  'Draft platform events remain hidden from mobile users until published.';

CREATE INDEX IF NOT EXISTS events_platform_upcoming_idx
  ON public.events (starts_at)
  WHERE host_type = 'platform' AND is_published = true;

CREATE OR REPLACE FUNCTION public.bootstrap_platform_event_thread()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_thread_id uuid;
BEGIN
  IF NEW.host_type = 'platform' THEN
    INSERT INTO public.threads (type, event_id)
    VALUES ('event_group', NEW.id)
    RETURNING id INTO new_thread_id;

    INSERT INTO public.thread_participants (thread_id, user_id)
    VALUES (new_thread_id, NEW.creator_id)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_bootstrap_platform_thread ON public.events;
CREATE TRIGGER events_bootstrap_platform_thread
  AFTER INSERT ON public.events
  FOR EACH ROW
  EXECUTE FUNCTION public.bootstrap_platform_event_thread();
