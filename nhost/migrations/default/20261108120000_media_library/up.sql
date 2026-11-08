-- Admin media library: catalog of reusable images in the media bucket.
-- Event featured images point at a storage file id from this catalog.

INSERT INTO storage.buckets (id, download_expiration, min_upload_file_size, max_upload_file_size, cache_control)
VALUES ('media', 3600, 0, 10485760, 'public, max-age=3600')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL,
  sha256 text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  original_filename text,
  uploaded_by_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_file_id_uidx
  ON public.media_assets (file_id);

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_sha256_live_uidx
  ON public.media_assets (sha256)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS media_assets_created_at_idx
  ON public.media_assets (created_at DESC);

CREATE INDEX IF NOT EXISTS media_assets_original_filename_idx
  ON public.media_assets (original_filename);

DROP TRIGGER IF EXISTS media_assets_set_updated_at ON public.media_assets;
CREATE TRIGGER media_assets_set_updated_at
  BEFORE UPDATE ON public.media_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.media_assets IS
  'Catalog of admin-uploaded images in the media storage bucket. Soft-delete with deleted_at.';

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS featured_image_file_id uuid;

COMMENT ON COLUMN public.events.featured_image_file_id IS
  'Optional Nhost storage file id for the event featured image (usually from media_assets).';

-- Drop first: CREATE OR REPLACE cannot insert a column into the middle of an existing view.
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
  e.featured_image_file_id,
  e.rsvp_closed_at,
  e.cancelled_at,
  e.created_at
FROM public.events e;

COMMENT ON VIEW public.event_listings IS
  'List-safe event fields. Locked private meets are shown from here; full details stay on events.';
