-- CrewUp — activity taxonomy + event/user associations

CREATE TABLE IF NOT EXISTS public.activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'general',
  icon text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activities_slug_unique UNIQUE (slug),
  CONSTRAINT activities_slug_format_check CHECK (slug ~ '^[a-z0-9_]+$')
);

DROP TRIGGER IF EXISTS activities_set_updated_at ON public.activities;
CREATE TRIGGER activities_set_updated_at
  BEFORE UPDATE ON public.activities
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.activities IS
  'Admin-managed activity taxonomy for events and user preferences (dinner, coffee, hiking, …).';
COMMENT ON COLUMN public.activities.slug IS
  'Stable machine key used in APIs and migrations; lowercase snake_case.';
COMMENT ON COLUMN public.activities.category IS
  'UI grouping bucket e.g. food_drink, outdoors, nightlife, wellness, culture.';

CREATE INDEX IF NOT EXISTS activities_is_active_sort_idx
  ON public.activities (is_active, sort_order, name)
  WHERE is_active = true;

INSERT INTO public.activities (slug, name, category, sort_order) VALUES
  ('dinner', 'Dinner', 'food_drink', 10),
  ('coffee', 'Coffee', 'food_drink', 20),
  ('hiking', 'Hiking', 'outdoors', 30),
  ('karaoke', 'Karaoke', 'nightlife', 40),
  ('sightseeing', 'Sightseeing', 'culture', 50),
  ('gym', 'Gym / workout', 'wellness', 60),
  ('shopping', 'Shopping', 'general', 70),
  ('beach', 'Beach / pool', 'outdoors', 80),
  ('spa', 'Spa / massage', 'wellness', 90),
  ('museum', 'Museum / gallery', 'culture', 100)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.event_activities (
  event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES public.activities (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, activity_id)
);

CREATE INDEX IF NOT EXISTS event_activities_activity_id_idx
  ON public.event_activities (activity_id);

COMMENT ON TABLE public.event_activities IS
  'Activities associated with a layover event. Activity-like values in events.tags are backfilled here.';

INSERT INTO public.event_activities (event_id, activity_id)
SELECT DISTINCT e.id, a.id
FROM public.events e
CROSS JOIN LATERAL unnest(e.tags) AS tag(slug)
JOIN public.activities a ON a.slug = tag.slug
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.profile_activity_preferences (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES public.activities (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, activity_id)
);

CREATE INDEX IF NOT EXISTS profile_activity_preferences_activity_id_idx
  ON public.profile_activity_preferences (activity_id);

COMMENT ON TABLE public.profile_activity_preferences IS
  'Multi-select activity interests on a user profile; used for discovery and event suggestions.';
