-- Backfill trustworthy roster rows into user_trips while keeping legacy rosters operational.
-- Flight-duty rows become trips with canonical legs only (no automatic stay from flight duration).
-- Valid layover rows become trip_stays.

-- Reconcile columns if trips migration ran against a pre-existing cloud schema.
ALTER TABLE public.user_trips
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

ALTER TABLE public.flight_instances
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_flight_id text,
  ADD COLUMN IF NOT EXISTS provider_snapshot jsonb DEFAULT '{}'::jsonb;

UPDATE public.flight_instances
SET provider_snapshot = '{}'::jsonb
WHERE provider_snapshot IS NULL;

ALTER TABLE public.flight_instances
  ALTER COLUMN provider_snapshot SET DEFAULT '{}'::jsonb;

INSERT INTO public.user_trips (user_id, title, source, starts_at, ends_at, visibility, is_active)
SELECT
  r.user_id,
  COALESCE(NULLIF(r.flight_number, ''), r.layover_city, 'Trip'),
  CASE
    WHEN r.source = 'upload' THEN 'roster_upload'::public.trip_source
    ELSE 'manual'::public.trip_source
  END,
  COALESCE(r.layover_start, r.created_at),
  COALESCE(r.layover_end, r.layover_start, r.created_at),
  p.default_visibility,
  true
FROM public.rosters r
JOIN public.profiles p ON p.user_id = r.user_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.user_trips ut
  WHERE ut.user_id = r.user_id
    AND ut.source IN ('manual', 'roster_upload')
    AND ut.starts_at IS NOT DISTINCT FROM COALESCE(r.layover_start, r.created_at)
    AND ut.ends_at IS NOT DISTINCT FROM COALESCE(r.layover_end, r.layover_start, r.created_at)
);

INSERT INTO public.trip_stays (trip_id, city, starts_at, ends_at)
SELECT
  ut.id,
  upper(trim(r.layover_city)),
  r.layover_start,
  COALESCE(r.layover_end, r.layover_start)
FROM public.rosters r
JOIN public.user_trips ut
  ON ut.user_id = r.user_id
 AND ut.source IN ('manual', 'roster_upload')
 AND ut.starts_at IS NOT DISTINCT FROM COALESCE(r.layover_start, r.created_at)
 AND ut.ends_at IS NOT DISTINCT FROM COALESCE(r.layover_end, r.layover_start, r.created_at)
WHERE r.layover_city IS NOT NULL
  AND r.layover_start IS NOT NULL
  AND COALESCE(r.notes, '') NOT LIKE '%duty:flight%'
  AND NOT EXISTS (
    SELECT 1
    FROM public.trip_stays ts
    WHERE ts.trip_id = ut.id
      AND lower(ts.city) = lower(trim(r.layover_city))
      AND ts.starts_at = r.layover_start
  );

INSERT INTO public.flight_instances (
  flight_number,
  service_date,
  departure_airport,
  arrival_airport,
  scheduled_departure,
  scheduled_arrival,
  provider,
  provider_snapshot
)
SELECT DISTINCT
  upper(regexp_replace(trim(r.flight_number), '\s+', '', 'g')),
  (COALESCE(r.layover_start, r.created_at))::date,
  upper(trim(r.departure_airport)),
  upper(trim(r.arrival_airport)),
  COALESCE(r.layover_start, r.created_at),
  COALESCE(r.layover_end, r.layover_start, r.created_at),
  'legacy_roster',
  jsonb_build_object('roster_id', r.id)
FROM public.rosters r
WHERE COALESCE(r.notes, '') LIKE '%duty:flight%'
  AND r.flight_number IS NOT NULL
  AND r.departure_airport IS NOT NULL
  AND r.arrival_airport IS NOT NULL
  AND r.layover_start IS NOT NULL
ON CONFLICT (flight_number, service_date, departure_airport, scheduled_departure) DO NOTHING;

INSERT INTO public.trip_flight_legs (trip_id, flight_instance_id, sequence_number)
SELECT
  ut.id,
  fi.id,
  1
FROM public.rosters r
JOIN public.user_trips ut
  ON ut.user_id = r.user_id
 AND ut.source IN ('manual', 'roster_upload')
 AND ut.starts_at IS NOT DISTINCT FROM COALESCE(r.layover_start, r.created_at)
 AND ut.ends_at IS NOT DISTINCT FROM COALESCE(r.layover_end, r.layover_start, r.created_at)
JOIN public.flight_instances fi
  ON fi.flight_number = upper(regexp_replace(trim(r.flight_number), '\s+', '', 'g'))
 AND fi.service_date = (COALESCE(r.layover_start, r.created_at))::date
 AND fi.departure_airport = upper(trim(r.departure_airport))
 AND fi.scheduled_departure = COALESCE(r.layover_start, r.created_at)
WHERE COALESCE(r.notes, '') LIKE '%duty:flight%'
  AND NOT EXISTS (
    SELECT 1 FROM public.trip_flight_legs tfl WHERE tfl.trip_id = ut.id
  );
