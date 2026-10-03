DROP TRIGGER IF EXISTS event_attendees_guard ON public.event_attendees;
DROP FUNCTION IF EXISTS public.event_attendees_guard();

ALTER TABLE public.events
  DROP COLUMN IF EXISTS rsvp_closed_at,
  DROP COLUMN IF EXISTS cancelled_at;

-- Postgres cannot drop an enum value; 'removed' stays on public.attendee_status.
UPDATE public.event_attendees SET status = 'cancelled' WHERE status::text = 'removed';
