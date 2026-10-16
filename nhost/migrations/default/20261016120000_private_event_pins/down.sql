DROP VIEW IF EXISTS public.event_listings;

CREATE OR REPLACE FUNCTION public.event_attendees_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  closed_at timestamptz;
  cancelled timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status::text = 'removed' AND NEW.status::text <> 'removed' THEN
    RAISE EXCEPTION 'ATTENDEE_REMOVED' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status::text IN ('going', 'waitlisted')
     AND (TG_OP = 'INSERT' OR OLD.status::text NOT IN ('going', 'waitlisted')) THEN
    SELECT e.rsvp_closed_at, e.cancelled_at INTO closed_at, cancelled
    FROM public.events e
    WHERE e.id = NEW.event_id;

    IF cancelled IS NOT NULL THEN
      RAISE EXCEPTION 'EVENT_CANCELLED' USING ERRCODE = 'P0001';
    END IF;
    IF closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'EVENT_RSVPS_CLOSED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_ensure_access_code ON public.events;
DROP FUNCTION IF EXISTS public.events_ensure_access_code();
DROP TABLE IF EXISTS public.event_pin_attempts;
DROP TABLE IF EXISTS public.event_unlocks;
DROP TABLE IF EXISTS public.event_access_codes;
DROP FUNCTION IF EXISTS public.generate_event_pin();
