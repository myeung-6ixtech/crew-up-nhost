ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_venue_coordinates_valid;
ALTER TABLE public.events DROP COLUMN IF EXISTS venue_lng, DROP COLUMN IF EXISTS venue_lat, DROP COLUMN IF EXISTS venue_place_id;
