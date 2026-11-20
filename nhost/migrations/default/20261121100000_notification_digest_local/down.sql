ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_time_zone_shape;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS last_digest_at, DROP COLUMN IF EXISTS time_zone;
