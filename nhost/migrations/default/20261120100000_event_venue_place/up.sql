-- The venue picked from place search: Google place id and coordinates, alongside the name and address already stored.
-- Private meets keep these behind the PIN: the events row is only visible to the host, guests and people who unlocked it.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS venue_place_id text,
  ADD COLUMN IF NOT EXISTS venue_lat double precision,
  ADD COLUMN IF NOT EXISTS venue_lng double precision;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_venue_coordinates_valid;
ALTER TABLE public.events
  ADD CONSTRAINT events_venue_coordinates_valid CHECK (
    (venue_lat IS NULL AND venue_lng IS NULL)
    OR (venue_lat BETWEEN -90 AND 90 AND venue_lng BETWEEN -180 AND 180)
  );

COMMENT ON COLUMN public.events.venue_place_id IS 'Google place id of the venue, when picked from search. Null for a custom venue.';
