DROP INDEX IF EXISTS public.events_city_starts_at_idx;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_cover_image_url_https;
ALTER TABLE public.events DROP COLUMN IF EXISTS cover_image_url;
