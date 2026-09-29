-- Private hometown coordinates. Owner-only via computed fields; the raw columns
-- are not in the user role's select list, so other crew cannot read them.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS hometown_latitude double precision,
  ADD COLUMN IF NOT EXISTS hometown_longitude double precision;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_hometown_coordinates_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_hometown_coordinates_check CHECK (
    (
      hometown_latitude IS NULL
      AND hometown_longitude IS NULL
    ) OR (
      hometown_latitude BETWEEN -90 AND 90
      AND hometown_longitude BETWEEN -180 AND 180
    )
  );

CREATE OR REPLACE FUNCTION public.profile_own_hometown_latitude(profile public.profiles, hasura_session json)
RETURNS double precision
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN profile.user_id = NULLIF(hasura_session ->> 'x-hasura-user-id', '')::uuid THEN profile.hometown_latitude
  END
$$;

CREATE OR REPLACE FUNCTION public.profile_own_hometown_longitude(profile public.profiles, hasura_session json)
RETURNS double precision
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN profile.user_id = NULLIF(hasura_session ->> 'x-hasura-user-id', '')::uuid THEN profile.hometown_longitude
  END
$$;

COMMENT ON COLUMN public.profiles.hometown_latitude IS
  'Private. Set when hometown_city is chosen from place search. Owner-only via profile_own_hometown_latitude.';
COMMENT ON COLUMN public.profiles.hometown_longitude IS
  'Private. Set when hometown_city is chosen from place search. Owner-only via profile_own_hometown_longitude.';
