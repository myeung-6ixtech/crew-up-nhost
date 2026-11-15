-- Reverse the drinks / events split. New rows are removed only when nothing references them.

UPDATE public.activities AS child
SET name = 'Cocktail / speakeasy',
    parent_id = parent.id,
    show_in_onboarding = false
FROM public.activities AS parent
WHERE child.slug = 'cocktail_bar'
  AND parent.slug = 'nightlife'
  AND parent.parent_id IS NULL;

UPDATE public.activities AS child
SET name = restored.name,
    parent_id = parent.id,
    show_in_onboarding = false
FROM (VALUES
  ('wine_tasting', 'Wine tasting'),
  ('craft_beer', 'Craft beer'),
  ('coffee', 'Coffee')
) AS restored (slug, name)
JOIN public.activities AS parent ON parent.slug = 'food_drink' AND parent.parent_id IS NULL
WHERE child.slug = restored.slug;

UPDATE public.activities AS child
SET name = 'Music festival',
    parent_id = parent.id,
    show_in_onboarding = false
FROM public.activities AS parent
WHERE child.slug = 'music_festival'
  AND parent.slug = 'music_dance'
  AND parent.parent_id IS NULL;

-- If the old group is missing, park the row on Food so the new group can be removed.
UPDATE public.activities AS child
SET parent_id = parent.id
FROM public.activities AS parent
WHERE child.slug IN ('wine_tasting', 'craft_beer', 'coffee', 'cocktail_bar', 'music_festival')
  AND parent.slug = 'food_drink'
  AND parent.parent_id IS NULL
  AND child.parent_id IN (SELECT id FROM public.activities WHERE slug IN ('drinks', 'events') AND parent_id IS NULL);

UPDATE public.activities
SET name = 'Food & drink'
WHERE slug = 'food_drink'
  AND parent_id IS NULL;

UPDATE public.activities
SET show_in_onboarding = false
WHERE slug IN ('pickleball', 'tennis', 'yoga');

DELETE FROM public.activities AS activity
WHERE activity.slug IN ('detox_juice', 'sporting_events')
  AND NOT EXISTS (SELECT 1 FROM public.event_activities ea WHERE ea.activity_id = activity.id)
  AND NOT EXISTS (SELECT 1 FROM public.profile_activity_preferences pp WHERE pp.activity_id = activity.id);

DELETE FROM public.activities AS activity
WHERE activity.slug IN ('drinks', 'events')
  AND activity.parent_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.activities child WHERE child.parent_id = activity.id);

ALTER TABLE public.activities DROP COLUMN IF EXISTS show_in_onboarding;
