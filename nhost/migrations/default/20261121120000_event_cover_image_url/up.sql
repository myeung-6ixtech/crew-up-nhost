-- Cover image from an approved outside event source (https URL). Host uploads keep using featured_image_file_id.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS cover_image_url text;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_cover_image_url_https;
ALTER TABLE public.events
  ADD CONSTRAINT events_cover_image_url_https CHECK (cover_image_url IS NULL OR cover_image_url ~ '^https://');
COMMENT ON COLUMN public.events.cover_image_url IS 'Cover from an approved event source. Set by staff/import, not by hosts (they upload featured_image_file_id).';

-- Related events on a layover: city + time window lookups.
CREATE INDEX IF NOT EXISTS events_city_starts_at_idx ON public.events (lower(city), starts_at);
