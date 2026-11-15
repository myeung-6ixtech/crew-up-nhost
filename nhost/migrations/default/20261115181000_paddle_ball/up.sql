-- Paddle ball sits under Sports & fitness. It is not on the onboarding step.
-- Hiking, rock climbing, and fishing stay outdoors. Sailing and scuba stay in water.
-- Those parents are set by activity_onboarding_set and are not moved here.

INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active, parent_id)
SELECT 'paddle_ball', 'Paddle ball', 'sports_fitness', 940, 'activity', true, parent.id
FROM public.activities AS parent
WHERE parent.slug = 'sports_fitness'
  AND parent.parent_id IS NULL
ON CONFLICT (slug) DO UPDATE
SET parent_id = EXCLUDED.parent_id,
    name = EXCLUDED.name,
    sort_order = EXCLUDED.sort_order,
    kind = 'activity',
    is_active = true;
