-- Event tags are free-form now (typed in Create meetup), so they go through the same blocked-term check as
-- the title, description and venue. Also caps them at 8 tags of up to 24 characters, matching the app.

CREATE OR REPLACE FUNCTION public.events_content_filter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.contains_blocked_term(NEW.title)
    OR public.contains_blocked_term(NEW.description)
    OR public.contains_blocked_term(NEW.venue_name)
    OR public.contains_blocked_term(replace(array_to_string(NEW.tags, ' '), '_', ' ')) THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_content_filter ON public.events;
CREATE TRIGGER events_content_filter
  BEFORE INSERT OR UPDATE OF title, description, venue_name, tags ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_content_filter();

-- At most 8 tags, each 1–24 of a–z, 0–9 and _ (the app stores "sunday brunch" as sunday_brunch).
CREATE OR REPLACE FUNCTION public.event_tags_valid(tags text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT cardinality(tags) <= 8
    AND coalesce(bool_and(tag ~ '^[a-z0-9_]{1,24}$'), true)
  FROM unnest(tags) AS tag;
$$;

-- NOT VALID: existing rows are left alone; new and edited events must comply.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_tags_shape;
ALTER TABLE public.events ADD CONSTRAINT events_tags_shape CHECK (public.event_tags_valid(tags)) NOT VALID;
