-- Onboarding step 1 grows to 25 activities in five sections: Drinks, Outdoors, Water & beach, Sports & fitness,
-- Events. Hiking, Rock climbing, Fishing, Sailing and Scuba diving move to their real parents. Soccer sits right
-- after Football; Football now means American football (a new icon in the app; the slug is unchanged).
-- Saved picks reference activity ids, so moving parents keeps every profile and meetup pick. Safe to re-run.

-- Fishing and Soccer exist on the live catalogue already; create them where they don't.
INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active, parent_id)
SELECT v.slug, v.name, parent.slug, v.sort_order, 'activity', true, parent.id
FROM (VALUES
  ('fishing', 'Fishing', 'outdoors', 565),
  ('soccer', 'Soccer', 'sports_fitness', 885)
) AS v (slug, name, parent_slug, sort_order)
JOIN public.activities AS parent ON parent.slug = v.parent_slug AND parent.parent_id IS NULL
ON CONFLICT (slug) DO NOTHING;

-- Real parents and positions (category follows parent_id via the activities_one_level trigger).
UPDATE public.activities AS a
SET parent_id = parent.id,
    sort_order = v.sort_order,
    is_active = true
FROM (VALUES
  ('hiking', 'outdoors', 440),
  ('rock_climbing', 'outdoors', 520),
  ('fishing', 'outdoors', 565),
  ('scuba', 'water', 610),
  ('sailing', 'water', 660),
  ('soccer', 'sports_fitness', 885)
) AS v (slug, parent_slug, sort_order),
public.activities AS parent
WHERE a.slug = v.slug
  AND parent.slug = v.parent_slug
  AND parent.parent_id IS NULL;

UPDATE public.activities SET name = 'Fishing' WHERE slug = 'fishing';
UPDATE public.activities SET name = 'Soccer' WHERE slug = 'soccer';
UPDATE public.activities SET name = 'Football' WHERE slug = 'football';

-- Exactly these 25 are on the onboarding step, in this order within each section.
UPDATE public.activities
SET show_in_onboarding = false,
    onboarding_sort = NULL
WHERE show_in_onboarding OR onboarding_sort IS NOT NULL;

UPDATE public.activities AS a
SET show_in_onboarding = true,
    onboarding_sort = v.position
FROM (VALUES
  ('cocktail_bar', 10), ('wine_tasting', 20), ('craft_beer', 30), ('coffee', 40), ('detox_juice', 50),
  ('hiking', 10), ('rock_climbing', 20), ('fishing', 30),
  ('sailing', 10), ('scuba', 20),
  ('pickleball', 10), ('tennis', 20), ('yoga', 30), ('padel', 40), ('basketball', 50), ('running', 60),
  ('badminton', 70), ('football', 80), ('soccer', 90), ('gym', 100), ('golf', 110), ('volleyball', 120),
  ('sporting_events', 10), ('music_festival', 20)
) AS v (slug, position)
WHERE a.slug = v.slug
  AND a.parent_id IS NOT NULL;
