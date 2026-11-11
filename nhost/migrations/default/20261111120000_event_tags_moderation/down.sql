ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_tags_shape;
DROP FUNCTION IF EXISTS public.event_tags_valid(text[]);

CREATE OR REPLACE FUNCTION public.events_content_filter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.contains_blocked_term(NEW.title)
    OR public.contains_blocked_term(NEW.description)
    OR public.contains_blocked_term(NEW.venue_name) THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_content_filter ON public.events;
CREATE TRIGGER events_content_filter
  BEFORE INSERT OR UPDATE OF title, description, venue_name ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_content_filter();
