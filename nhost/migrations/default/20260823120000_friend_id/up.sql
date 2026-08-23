-- CrewUp — shareable Crew ID (friend_id) on profiles

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS friend_id text;

CREATE OR REPLACE FUNCTION public.generate_friend_id()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  suffix text := '';
  candidate text;
  i int;
  attempt int;
BEGIN
  FOR attempt IN 1..20 LOOP
    suffix := '';
    FOR i IN 1..8 LOOP
      suffix := suffix || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    candidate := 'CREW' || suffix;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE friend_id = candidate) THEN
      RETURN candidate;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'Failed to generate unique friend_id after 20 attempts';
END;
$$;

CREATE OR REPLACE FUNCTION public.profiles_assign_friend_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.friend_id IS NULL THEN
    NEW.friend_id := public.generate_friend_id();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_assign_friend_id ON public.profiles;
CREATE TRIGGER profiles_assign_friend_id
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.profiles_assign_friend_id();

UPDATE public.profiles
SET friend_id = public.generate_friend_id()
WHERE friend_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_friend_id_unique
  ON public.profiles (friend_id)
  WHERE friend_id IS NOT NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_friend_id_format_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_friend_id_format_check
  CHECK (friend_id IS NULL OR friend_id ~ '^CREW[0-9A-HJKMNP-TV-Z]{8}$');

COMMENT ON COLUMN public.profiles.friend_id IS
  'Shareable Crew ID for friend lookup. Immutable in v1. Format: CREW + 8 Crockford Base32 chars.';
