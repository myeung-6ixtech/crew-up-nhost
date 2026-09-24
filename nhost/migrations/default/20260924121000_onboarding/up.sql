-- CrewUp — onboarding (documentation/features/onboarding.md §5)
-- Additive: new profile columns are nullable (completeness is enforced by /onboarding/complete).
-- Legacy columns (display_name, role_type, base_airport, preferred_language) stay and are kept in sync
-- by the onboarding Functions until a later migration phases them out.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN
  CREATE TYPE public.crew_role AS ENUM ('cabin_crew', 'pilot', 'ground_ops', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- profiles: identity columns (§5.1)
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS full_name_native text,
  ADD COLUMN IF NOT EXISTS preferred_name text,
  ADD COLUMN IF NOT EXISTS username citext,
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS home_country_code text,
  ADD COLUMN IF NOT EXISTS hometown_city text,
  ADD COLUMN IF NOT EXISTS languages text[],
  ADD COLUMN IF NOT EXISTS residence_country_code text,
  ADD COLUMN IF NOT EXISTS residence_city text,
  ADD COLUMN IF NOT EXISTS crew_role public.crew_role,
  ADD COLUMN IF NOT EXISTS base_airport_iata text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_format_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_format_check CHECK (
    username IS NULL OR (
      username::text = lower(username::text)
      AND username::text ~ '^[a-z][a-z0-9._]{2,19}$'
      AND username::text !~ '[._]{2}'
    )
  );

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_country_codes_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_country_codes_check CHECK (
    (home_country_code IS NULL OR home_country_code ~ '^[A-Z]{2}$')
    AND (residence_country_code IS NULL OR residence_country_code ~ '^[A-Z]{2}$')
  );

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_full_name_length_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_full_name_length_check CHECK (
    full_name IS NULL OR char_length(full_name) BETWEEN 2 AND 100
  );

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_base_airport_iata_fkey;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_base_airport_iata_fkey
  FOREIGN KEY (base_airport_iata) REFERENCES public.airports (iata) ON UPDATE CASCADE ON DELETE SET NULL;

-- citext makes this unique index case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_unique
  ON public.profiles (username)
  WHERE username IS NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_username_trgm_idx
  ON public.profiles USING gin ((username::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_full_name_trgm_idx
  ON public.profiles USING gin (lower(full_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_full_name_native_trgm_idx
  ON public.profiles USING gin (full_name_native gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_base_airport_iata_idx ON public.profiles (base_airport_iata);

COMMENT ON COLUMN public.profiles.full_name IS
  'Real full name as the user writes it (no given/family split). Required at onboarding completion.';
COMMENT ON COLUMN public.profiles.username IS
  'Unique handle for search and mentions, stored lowercase. Never a substitute for full_name.';
COMMENT ON COLUMN public.profiles.date_of_birth IS
  'Private: 18+ gate only. Never exposed to other users.';
COMMENT ON COLUMN public.profiles.residence_city IS 'City level only — never street, district or coordinates.';
COMMENT ON COLUMN public.profiles.display_name IS
  'LEGACY: kept in sync as coalesce(preferred_name, full_name) by onboarding Functions. Phase out.';
COMMENT ON COLUMN public.profiles.role_type IS 'LEGACY: kept in sync from crew_role. Phase out.';
COMMENT ON COLUMN public.profiles.base_airport IS 'LEGACY: kept in sync from base_airport_iata. Phase out.';

-- Hasura computed field: date_of_birth is visible to its owner only (column permissions are per role, not per row).
CREATE OR REPLACE FUNCTION public.profile_own_date_of_birth(profile public.profiles, hasura_session json)
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN profile.user_id = NULLIF(hasura_session ->> 'x-hasura-user-id', '')::uuid THEN profile.date_of_birth
  END
$$;

-- Existing base airports that the OurAirports seed does not cover become placeholder rows so the FK holds.
INSERT INTO public.airports (iata, name)
SELECT DISTINCT upper(p.base_airport), upper(p.base_airport)
FROM public.profiles AS p
WHERE p.base_airport ~* '^[a-z]{3}$'
ON CONFLICT (iata) DO NOTHING;

UPDATE public.profiles
SET
  full_name = COALESCE(
    full_name,
    CASE WHEN char_length(btrim(display_name)) BETWEEN 2 AND 100 THEN btrim(display_name) END
  ),
  crew_role = COALESCE(crew_role, role_type::text::public.crew_role),
  base_airport_iata = COALESCE(
    base_airport_iata,
    CASE WHEN base_airport ~* '^[a-z]{3}$' THEN upper(base_airport) END
  )
WHERE full_name IS NULL OR crew_role IS NULL OR base_airport_iata IS NULL;

-- ---------------------------------------------------------------------------
-- user_private (§5.2) — never readable by other users
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.user_private (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  phone_e164 text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS user_private_set_updated_at ON public.user_private;
CREATE TRIGGER user_private_set_updated_at
  BEFORE UPDATE ON public.user_private
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.user_private IS
  'Private per-user data (phone). Own row + staff_admin only. phone_verified_at stays null in v1.';

-- ---------------------------------------------------------------------------
-- onboarding_state (§5.3)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.onboarding_state (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  current_step text CHECK (
    current_step IS NULL OR current_step IN (
      'name_handle', 'about', 'residence', 'crew', 'phone', 'photo', 'review',
      'beta_notify', 'launch_privacy', 'launch_guidelines', 'launch_notifications'
    )
  ),
  flow_version int NOT NULL DEFAULT 1,
  beta_signup_completed_at timestamptz,
  onboarding_completed_at timestamptz,
  guidelines_accepted_version text,
  guidelines_accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS onboarding_state_set_updated_at ON public.onboarding_state;
CREATE TRIGGER onboarding_state_set_updated_at
  BEFORE UPDATE ON public.onboarding_state
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Write-once completion: defence in depth, independent of Hasura permissions.
CREATE OR REPLACE FUNCTION public.prevent_onboarding_reset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.onboarding_completed_at IS NOT NULL
     AND NEW.onboarding_completed_at IS DISTINCT FROM OLD.onboarding_completed_at THEN
    RAISE EXCEPTION 'onboarding_completed_at is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS onboarding_completed_immutable ON public.onboarding_state;
CREATE TRIGGER onboarding_completed_immutable
  BEFORE UPDATE ON public.onboarding_state
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_onboarding_reset();

CREATE INDEX IF NOT EXISTS onboarding_state_completed_idx
  ON public.onboarding_state (user_id)
  WHERE onboarding_completed_at IS NOT NULL;

COMMENT ON TABLE public.onboarding_state IS
  'Onboarding progress. beta_signup_completed_at / onboarding_completed_at / guidelines_* are set only by Functions.';
COMMENT ON COLUMN public.onboarding_state.beta_signup_completed_at IS
  'Beta cohort marker. NOT onboarding completion. Keep after beta phase-out (early crew badge).';

-- Existing accounts that finished the legacy single-form onboarding never see onboarding again (§7.3).
INSERT INTO public.onboarding_state (user_id, flow_version, onboarding_completed_at)
SELECT p.user_id, 1, now()
FROM public.profiles AS p
WHERE btrim(p.display_name) <> ''
ON CONFLICT (user_id) DO NOTHING;
