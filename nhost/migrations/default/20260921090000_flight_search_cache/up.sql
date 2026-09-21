-- Shared route/date flight schedule cache so provider calls scale with distinct
-- routes rather than user search volume. Selection tokens are never cached; they
-- are minted per response from the normalized schedules stored here.
-- Idempotent for cloud databases that may already have these objects.

CREATE TABLE IF NOT EXISTS public.flight_search_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  departure_airport text NOT NULL,
  arrival_airport text NOT NULL,
  flight_date date NOT NULL,
  provider text NOT NULL,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_count integer NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  refresh_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flight_search_cache_route_date_unique
    UNIQUE (departure_airport, arrival_airport, flight_date),
  CONSTRAINT flight_search_cache_airports_check CHECK (
    departure_airport <> arrival_airport
    AND departure_airport ~ '^[A-Z]{3}$'
    AND arrival_airport ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT flight_search_cache_result_count_check CHECK (result_count >= 0)
);

-- A cloud database may already have the table from an earlier partial deploy.
DO $$ BEGIN
  ALTER TABLE public.flight_search_cache
    ADD CONSTRAINT flight_search_cache_route_date_unique
    UNIQUE (departure_airport, arrival_airport, flight_date);
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

-- The refresh job scans rows nearing expiry for upcoming service dates.
CREATE INDEX IF NOT EXISTS flight_search_cache_expiry_idx
  ON public.flight_search_cache (expires_at, flight_date);

DROP TRIGGER IF EXISTS flight_search_cache_set_updated_at ON public.flight_search_cache;
CREATE TRIGGER flight_search_cache_set_updated_at
  BEFORE UPDATE ON public.flight_search_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.flight_search_cache IS
  'Route+date schedule cache written only by the service role via flight search functions.';
COMMENT ON COLUMN public.flight_search_cache.results IS
  'Normalized flight schedules without selection tokens.';
COMMENT ON COLUMN public.flight_search_cache.expires_at IS
  'Computed at write time from days-to-departure TTL tiers.';

-- Atomic canonical flight upsert exposed to Hasura. The pre-existing
-- upsert_flight_instance() returns a bare uuid, which Hasura cannot track, so this
-- wrapper returns the row set instead. Both share the same conflict target.
CREATE OR REPLACE FUNCTION public.upsert_flight_instance_row(
  p_flight_number text,
  p_service_date date,
  p_departure_airport text,
  p_arrival_airport text,
  p_scheduled_departure timestamptz,
  p_scheduled_arrival timestamptz,
  p_airline_iata text DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_provider_flight_id text DEFAULT NULL,
  p_provider_snapshot jsonb DEFAULT '{}'::jsonb
)
RETURNS SETOF public.flight_instances
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
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
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_flight_instance_row FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_flight_instance_row TO postgres;

COMMENT ON FUNCTION public.upsert_flight_instance_row IS
  'Race-safe canonical flight upsert used by trip creation and schedule refresh.';
