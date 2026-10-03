-- Host controls on a meet: stop new RSVPs, cancel, and remove an attendee.
-- The meet row stays readable after either close; nothing is deleted.

ALTER TYPE public.attendee_status ADD VALUE IF NOT EXISTS 'removed';

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS rsvp_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN public.events.rsvp_closed_at IS
  'Set by the host to stop new RSVPs. Everyone going keeps their spot. Null again when reopened.';
COMMENT ON COLUMN public.events.cancelled_at IS
  'Set by the host to cancel the meet. Final: the meet stays visible, read-only.';

-- Joining (a new row, or moving back to going/waitlisted) is refused when the meet is
-- closed or cancelled, and a removed attendee cannot put themselves back.
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

DROP TRIGGER IF EXISTS event_attendees_guard ON public.event_attendees;
CREATE TRIGGER event_attendees_guard
  BEFORE INSERT OR UPDATE OF status ON public.event_attendees
  FOR EACH ROW EXECUTE FUNCTION public.event_attendees_guard();
