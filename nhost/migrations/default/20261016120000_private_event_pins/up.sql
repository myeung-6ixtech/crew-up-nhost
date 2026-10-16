-- Private meetings: visibility_scope = 'friends' now means "PIN required".
-- The host reads the PIN; guests unlock with it once, which lets them see the full meet,
-- RSVP and join its chat. The list shows every private meet as a locked card (event_listings).

-- No 0, O, 1, I or L, so a PIN read aloud or retyped can't be mistaken.
CREATE OR REPLACE FUNCTION public.generate_event_pin()
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  -- The first 6 bytes of a v4 uuid are random (gen_random_uuid uses a CSPRNG).
  bytes constant bytea := uuid_send(gen_random_uuid());
  pin text := '';
BEGIN
  FOR i IN 0..5 LOOP
    pin := pin || substr(alphabet, (get_byte(bytes, i) % 31) + 1, 1);
  END LOOP;
  RETURN pin;
END;
$$;

CREATE TABLE IF NOT EXISTS public.event_access_codes (
  event_id uuid PRIMARY KEY REFERENCES public.events (id) ON DELETE CASCADE,
  pin text NOT NULL CHECK (pin ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

COMMENT ON TABLE public.event_access_codes IS
  'PIN for a private meet. Readable by its host only; checked by POST /client/events/unlock.';

CREATE TABLE IF NOT EXISTS public.event_unlocks (
  event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS event_unlocks_user_id_idx ON public.event_unlocks (user_id);

COMMENT ON TABLE public.event_unlocks IS
  'Who entered a private meet''s PIN. Kept when the host changes the PIN.';

CREATE TABLE IF NOT EXISTS public.event_pin_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_pin_attempts_lookup_idx
  ON public.event_pin_attempts (event_id, user_id, attempted_at);

COMMENT ON TABLE public.event_pin_attempts IS
  'Wrong PINs, for rate limiting unlocks. Cleared for a user once they unlock.';

-- Every private meet has a PIN. Switching back to public keeps it, so switching to private again
-- does not invalidate a PIN that was already shared.
CREATE OR REPLACE FUNCTION public.events_ensure_access_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.visibility_scope = 'friends' THEN
    INSERT INTO public.event_access_codes (event_id, pin)
    VALUES (NEW.id, public.generate_event_pin())
    ON CONFLICT (event_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_ensure_access_code ON public.events;
CREATE TRIGGER events_ensure_access_code
  AFTER INSERT OR UPDATE OF visibility_scope ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_ensure_access_code();

INSERT INTO public.event_access_codes (event_id, pin)
SELECT id, public.generate_event_pin() FROM public.events WHERE visibility_scope = 'friends'
ON CONFLICT (event_id) DO NOTHING;

-- Joining a private meet needs an unlock (or being its host). Same rules as before otherwise.
CREATE OR REPLACE FUNCTION public.event_attendees_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  closed_at timestamptz;
  cancelled timestamptz;
  scope public.event_visibility;
  host uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status::text = 'removed' AND NEW.status::text <> 'removed' THEN
    RAISE EXCEPTION 'ATTENDEE_REMOVED' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status::text IN ('going', 'waitlisted')
     AND (TG_OP = 'INSERT' OR OLD.status::text NOT IN ('going', 'waitlisted')) THEN
    SELECT e.rsvp_closed_at, e.cancelled_at, e.visibility_scope, e.creator_id
      INTO closed_at, cancelled, scope, host
    FROM public.events e
    WHERE e.id = NEW.event_id;

    IF cancelled IS NOT NULL THEN
      RAISE EXCEPTION 'EVENT_CANCELLED' USING ERRCODE = 'P0001';
    END IF;
    IF closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'EVENT_RSVPS_CLOSED' USING ERRCODE = 'P0001';
    END IF;
    IF scope = 'friends'
       AND NEW.user_id IS DISTINCT FROM host
       AND NOT EXISTS (
         SELECT 1 FROM public.event_unlocks u
         WHERE u.event_id = NEW.event_id AND u.user_id = NEW.user_id
       ) THEN
      RAISE EXCEPTION 'EVENT_PIN_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- The Events list. Private meets appear to everyone as a teaser: no notes, venue or address.
CREATE OR REPLACE VIEW public.event_listings AS
SELECT
  e.id,
  e.creator_id,
  e.title,
  e.city,
  e.starts_at,
  e.ends_at,
  e.capacity,
  e.visibility_scope,
  e.tags,
  e.languages,
  e.host_type,
  e.is_published,
  e.featured_until,
  e.rsvp_closed_at,
  e.cancelled_at,
  e.created_at
FROM public.events e;

COMMENT ON VIEW public.event_listings IS
  'List-safe event fields. Locked private meets are shown from here; full details stay on events.';
