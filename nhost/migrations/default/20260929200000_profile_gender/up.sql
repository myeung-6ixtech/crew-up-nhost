-- Gender is stored for every member. Other crew see it only when show_gender is true.
-- The owner always reads their own value through computed fields.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS show_gender boolean NOT NULL DEFAULT true;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_gender_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_gender_check CHECK (
    gender IS NULL OR gender IN ('male', 'female', 'unspecified')
  );

CREATE OR REPLACE FUNCTION public.profile_visible_gender(profile public.profiles, hasura_session json)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN profile.user_id = NULLIF(hasura_session ->> 'x-hasura-user-id', '')::uuid THEN profile.gender
    WHEN profile.show_gender THEN profile.gender
  END
$$;

CREATE OR REPLACE FUNCTION public.profile_own_show_gender(profile public.profiles, hasura_session json)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN profile.user_id = NULLIF(hasura_session ->> 'x-hasura-user-id', '')::uuid THEN profile.show_gender
  END
$$;

COMMENT ON COLUMN public.profiles.gender IS
  'male, female, or unspecified. Other crew see it only when show_gender is true, via profile_visible_gender.';
COMMENT ON COLUMN public.profiles.show_gender IS
  'When false, gender is hidden from other crew. Owner-only via profile_own_show_gender.';
