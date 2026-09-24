-- CrewUp — airports reference table (onboarding.md §5.4) + airline identifiers
-- Seeded by the next migration; admins maintain rows from the portal.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.airports (
  iata text PRIMARY KEY CHECK (iata ~ '^[A-Z]{3}$'),
  icao text CHECK (icao IS NULL OR icao ~ '^[A-Z0-9]{3,4}$'),
  name text NOT NULL,
  city text,
  country_code text CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
  tz text,
  is_major boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS airports_set_updated_at ON public.airports;
CREATE TRIGGER airports_set_updated_at
  BEFORE UPDATE ON public.airports
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS airports_search_name_trgm_idx
  ON public.airports USING gin (lower(name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS airports_search_city_trgm_idx
  ON public.airports USING gin (lower(city) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS airports_country_code_idx ON public.airports (country_code);

COMMENT ON TABLE public.airports IS
  'Airport reference for base airport (profiles.base_airport_iata). Source: OurAirports, public domain.';
COMMENT ON COLUMN public.airports.tz IS
  'IANA time zone. OurAirports has none; filled from the curated app list or by admins.';

ALTER TABLE public.airlines
  ADD COLUMN IF NOT EXISTS icao text,
  ADD COLUMN IF NOT EXISTS country_code text;

ALTER TABLE public.airlines DROP CONSTRAINT IF EXISTS airlines_icao_format_check;
ALTER TABLE public.airlines
  ADD CONSTRAINT airlines_icao_format_check CHECK (icao IS NULL OR icao ~ '^[A-Z]{3}$');
ALTER TABLE public.airlines DROP CONSTRAINT IF EXISTS airlines_country_code_format_check;
ALTER TABLE public.airlines
  ADD CONSTRAINT airlines_country_code_format_check CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

COMMENT ON COLUMN public.airlines.code IS 'IATA airline designator (e.g. CX).';

UPDATE public.airlines AS a
SET icao = v.icao, country_code = v.country_code
FROM (VALUES
  ('SQ', 'SIA', 'SG'), ('CX', 'CPA', 'HK'), ('NH', 'ANA', 'JP'), ('JL', 'JAL', 'JP'),
  ('KE', 'KAL', 'KR'), ('TG', 'THA', 'TH'), ('VN', 'HVN', 'VN'), ('GA', 'GIA', 'ID'),
  ('AK', 'AXM', 'MY'), ('TR', 'TGW', 'SG'), ('VJ', 'VJC', 'VN'), ('5J', 'CEB', 'PH'),
  ('6E', 'IGO', 'IN'), ('MU', 'CES', 'CN'), ('CZ', 'CSN', 'CN'), ('CA', 'CCA', 'CN')
) AS v (code, icao, country_code)
WHERE a.code = v.code AND a.icao IS NULL;
