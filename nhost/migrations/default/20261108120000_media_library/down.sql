DROP VIEW IF EXISTS public.event_listings;
CREATE VIEW public.event_listings AS
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

ALTER TABLE public.events
  DROP COLUMN IF EXISTS featured_image_file_id;

DROP TRIGGER IF EXISTS media_assets_set_updated_at ON public.media_assets;
DROP TABLE IF EXISTS public.media_assets;

DELETE FROM storage.buckets WHERE id = 'media';
