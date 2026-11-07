DROP TRIGGER IF EXISTS event_activities_not_group ON public.event_activities;
DROP TRIGGER IF EXISTS profile_activity_preferences_not_group ON public.profile_activity_preferences;
DROP FUNCTION IF EXISTS public.activity_link_not_group();
DROP TRIGGER IF EXISTS activities_one_level ON public.activities;
DROP FUNCTION IF EXISTS public.activities_one_level();

UPDATE public.activities SET parent_id = NULL;
DELETE FROM public.activities
WHERE parent_id IS NULL
  AND slug = category
  AND NOT EXISTS (SELECT 1 FROM public.event_activities ea WHERE ea.activity_id = activities.id)
  AND NOT EXISTS (SELECT 1 FROM public.profile_activity_preferences pp WHERE pp.activity_id = activities.id);

DROP INDEX IF EXISTS activities_parent_id_idx;
ALTER TABLE public.activities DROP COLUMN IF EXISTS parent_id;

COMMENT ON COLUMN public.activities.category IS
  'UI grouping bucket e.g. food_drink, outdoors, nightlife, wellness, culture.';
