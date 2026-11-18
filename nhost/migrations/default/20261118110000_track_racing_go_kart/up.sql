-- Track racing and Go-karting sit under Sports & fitness.
-- They are part of the full activity list, not the short onboarding step.

INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active, parent_id, show_in_onboarding)
SELECT v.slug, v.name, 'sports_fitness', v.sort_order, 'activity', true, parent.id, false
FROM (VALUES
  ('track_racing', 'Track racing', 950),
  ('go_kart', 'Go-karting', 960)
) AS v(slug, name, sort_order)
JOIN public.activities AS parent
  ON parent.slug = 'sports_fitness' AND parent.parent_id IS NULL
ON CONFLICT (slug) DO UPDATE
SET parent_id = EXCLUDED.parent_id,
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    sort_order = EXCLUDED.sort_order,
    kind = 'activity',
    is_active = true,
    show_in_onboarding = false;
