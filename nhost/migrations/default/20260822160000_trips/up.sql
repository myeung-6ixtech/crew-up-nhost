-- Trips domain: user itineraries, canonical flights, stays, and privacy-safe matches.
-- Idempotent for cloud databases that may already have these objects.

DO $$ BEGIN
  CREATE TYPE public.trip_source AS ENUM (
    'manual',
    'flight_search',
    'roster_upload',
    'airline_portal'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.trip_match_type AS ENUM (
    'same_flight',
    'same_route',
    'layover_overlap'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.user_trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  title text,
  source public.trip_source NOT NULL DEFAULT 'manual',
  starts_at timestamptz,
  ends_at timestamptz,
  visibility public.visibility_level,
  is_active boolean NOT NULL DEFAULT true,
  idempotency_key uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_trips_time_check CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at
  )
);

-- Cloud may already have user_trips without newer columns; IF NOT EXISTS skips table creation.
ALTER TABLE public.user_trips
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE INDEX IF NOT EXISTS user_trips_user_time_idx
  ON public.user_trips (user_id, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS user_trips_active_time_idx
  ON public.user_trips (starts_at, ends_at)
  WHERE is_active = true;

CREATE UNIQUE INDEX IF NOT EXISTS user_trips_user_idempotency_idx
  ON public.user_trips (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP TRIGGER IF EXISTS user_trips_set_updated_at ON public.user_trips;
CREATE TRIGGER user_trips_set_updated_at
  BEFORE UPDATE ON public.user_trips
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.flight_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  airline_iata text,
  flight_number text NOT NULL,
  service_date date NOT NULL,
  departure_airport text NOT NULL,
  arrival_airport text NOT NULL,
  scheduled_departure timestamptz NOT NULL,
  scheduled_arrival timestamptz NOT NULL,
  provider text,
  provider_flight_id text,
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flight_instances_time_check CHECK (scheduled_arrival >= scheduled_departure)
);

CREATE UNIQUE INDEX IF NOT EXISTS flight_instances_identity_unique
  ON public.flight_instances (flight_number, service_date, departure_airport, scheduled_departure);

CREATE INDEX IF NOT EXISTS flight_instances_exact_match_idx
  ON public.flight_instances (flight_number, service_date, departure_airport, arrival_airport);

CREATE INDEX IF NOT EXISTS flight_instances_route_time_idx
  ON public.flight_instances (departure_airport, arrival_airport, scheduled_departure);

CREATE UNIQUE INDEX IF NOT EXISTS flight_instances_provider_id_idx
  ON public.flight_instances (provider, provider_flight_id)
  WHERE provider_flight_id IS NOT NULL;

DROP TRIGGER IF EXISTS flight_instances_set_updated_at ON public.flight_instances;
CREATE TRIGGER flight_instances_set_updated_at
  BEFORE UPDATE ON public.flight_instances
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.trip_flight_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.user_trips (id) ON DELETE CASCADE,
  flight_instance_id uuid NOT NULL REFERENCES public.flight_instances (id) ON DELETE RESTRICT,
  sequence_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_flight_legs_sequence_check CHECK (sequence_number > 0),
  CONSTRAINT trip_flight_legs_trip_sequence_unique UNIQUE (trip_id, sequence_number),
  CONSTRAINT trip_flight_legs_trip_flight_unique UNIQUE (trip_id, flight_instance_id)
);

CREATE INDEX IF NOT EXISTS trip_flight_legs_flight_idx
  ON public.trip_flight_legs (flight_instance_id);

CREATE TABLE IF NOT EXISTS public.trip_stays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.user_trips (id) ON DELETE CASCADE,
  city text NOT NULL,
  airport_iata text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_stays_time_check CHECK (ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS trip_stays_trip_idx ON public.trip_stays (trip_id);
CREATE INDEX IF NOT EXISTS trip_stays_city_time_idx
  ON public.trip_stays (lower(city), starts_at, ends_at);
CREATE INDEX IF NOT EXISTS trip_stays_airport_time_idx
  ON public.trip_stays (airport_iata, starts_at, ends_at);

DROP TRIGGER IF EXISTS trip_stays_set_updated_at ON public.trip_stays;
CREATE TRIGGER trip_stays_set_updated_at
  BEFORE UPDATE ON public.trip_stays
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.trip_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  matched_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  match_type public.trip_match_type NOT NULL,
  score integer NOT NULL DEFAULT 0,
  source_trip_id uuid NOT NULL REFERENCES public.user_trips (id) ON DELETE CASCADE,
  matched_trip_id uuid NOT NULL REFERENCES public.user_trips (id) ON DELETE CASCADE,
  city text,
  flight_number text,
  departure_airport text,
  arrival_airport text,
  overlap_start timestamptz,
  overlap_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_matches_different_users_check CHECK (user_id <> matched_user_id),
  CONSTRAINT trip_matches_score_check CHECK (score >= 0 AND score <= 100),
  CONSTRAINT trip_matches_unique UNIQUE (
    user_id, matched_user_id, match_type, source_trip_id, matched_trip_id
  )
);

CREATE INDEX IF NOT EXISTS trip_matches_user_score_idx
  ON public.trip_matches (user_id, score DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS trip_matches_source_trip_idx
  ON public.trip_matches (source_trip_id);

CREATE INDEX IF NOT EXISTS trip_matches_matched_trip_idx
  ON public.trip_matches (matched_trip_id);

DROP TRIGGER IF EXISTS trip_matches_set_updated_at ON public.trip_matches;
CREATE TRIGGER trip_matches_set_updated_at
  BEFORE UPDATE ON public.trip_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.user_trips IS 'User-owned itineraries for Add Trip and matching.';
COMMENT ON TABLE public.flight_instances IS 'Canonical scheduled flights; shared across users selecting the same flight.';
COMMENT ON TABLE public.trip_flight_legs IS 'Links a user trip to canonical flight instances.';
COMMENT ON TABLE public.trip_stays IS 'Layover/availability windows separate from flight duration.';
COMMENT ON TABLE public.trip_matches IS 'Privacy-safe directional match summaries for discovery.';

-- Upsert a canonical flight instance (service role / SECURITY DEFINER).
CREATE OR REPLACE FUNCTION public.upsert_flight_instance(
  p_airline_iata text,
  p_flight_number text,
  p_service_date date,
  p_departure_airport text,
  p_arrival_airport text,
  p_scheduled_departure timestamptz,
  p_scheduled_arrival timestamptz,
  p_provider text DEFAULT NULL,
  p_provider_flight_id text DEFAULT NULL,
  p_provider_snapshot jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.flight_instances (
    airline_iata,
    flight_number,
    service_date,
    departure_airport,
    arrival_airport,
    scheduled_departure,
    scheduled_arrival,
    provider,
    provider_flight_id,
    provider_snapshot
  )
  VALUES (
    upper(nullif(trim(p_airline_iata), '')),
    upper(regexp_replace(trim(p_flight_number), '\s+', '', 'g')),
    p_service_date,
    upper(trim(p_departure_airport)),
    upper(trim(p_arrival_airport)),
    p_scheduled_departure,
    p_scheduled_arrival,
    p_provider,
    p_provider_flight_id,
    coalesce(p_provider_snapshot, '{}'::jsonb)
  )
  ON CONFLICT (flight_number, service_date, departure_airport, scheduled_departure)
  DO UPDATE SET
    scheduled_arrival = EXCLUDED.scheduled_arrival,
    arrival_airport = EXCLUDED.arrival_airport,
    airline_iata = COALESCE(EXCLUDED.airline_iata, flight_instances.airline_iata),
    provider = COALESCE(EXCLUDED.provider, flight_instances.provider),
    provider_flight_id = COALESCE(EXCLUDED.provider_flight_id, flight_instances.provider_flight_id),
    provider_snapshot = CASE
      WHEN EXCLUDED.provider_snapshot = '{}'::jsonb THEN flight_instances.provider_snapshot
      ELSE EXCLUDED.provider_snapshot
    END,
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_flight_instance FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_flight_instance TO postgres;
