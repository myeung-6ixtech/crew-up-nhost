-- Repair schema drift between source-controlled migrations and cloud databases.
--
-- 20260822160000_trips declares `updated_at` on both flight_instances and
-- trip_stays, but it creates them with CREATE TABLE IF NOT EXISTS and both tables
-- already existed in cloud, so the column was never added. The statements that
-- write to it ran regardless:
--
--   * the flight_instances_set_updated_at / trip_stays_set_updated_at triggers,
--     created with DROP/CREATE TRIGGER, which always executes
--   * upsert_flight_instance() and upsert_flight_instance_row(), both of which
--     set updated_at = now() in their ON CONFLICT DO UPDATE branch
--
-- The result was that every UPDATE on these two tables failed with 42703
-- (undefined_column), which surfaced through Hasura as "database query error"
-- and broke trip creation at the canonical flight upsert.
--
-- The column definition below matches 20260822160000_trips exactly, and the
-- ADD COLUMN IF NOT EXISTS guard makes this a no-op on databases that were built
-- from the migrations cleanly.

ALTER TABLE public.flight_instances
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.trip_stays
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
