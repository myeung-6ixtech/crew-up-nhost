-- Daily digest at 8 AM in each person's own time zone, counting only what's new since the last one.
--  time_zone: IANA zone from the device (set by the app). Null falls back to the base airport's zone, then UTC.
--  last_digest_at: when the last digest went out (server-written only).
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS time_zone text,
  ADD COLUMN IF NOT EXISTS last_digest_at timestamptz;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_time_zone_shape;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_time_zone_shape CHECK (time_zone IS NULL OR time_zone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$');

COMMENT ON COLUMN public.profiles.time_zone IS 'IANA time zone from the device, for the 8 AM daily digest.';
COMMENT ON COLUMN public.profiles.last_digest_at IS 'When the last daily digest was sent. Server-written.';
