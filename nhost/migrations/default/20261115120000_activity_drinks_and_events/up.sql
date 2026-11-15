-- Split drinks out of Food, add an Events group, and flag the short onboarding set.
-- Existing slugs are kept. Display names change. New rows are detox_juice and sporting_events.
-- show_in_onboarding marks what the onboarding activity step offers. Profile edit and events
-- still use every active child. Parents stay unselectable.

ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS show_in_onboarding boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.activities.show_in_onboarding IS
  'True for the short activity set offered during onboarding. Profile edit and event setup ignore this.';

-- Food keeps the food_drink slug. Drinks and Events are new groups.
UPDATE public.activities
SET name = 'Food'
WHERE slug = 'food_drink'
  AND parent_id IS NULL;

INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active)
SELECT groups.slug, groups.name, groups.slug, groups.sort_order, 'activity', true
FROM (VALUES
  ('drinks', 'Drinks', 25),
  ('events', 'Events', 65)
) AS groups (slug, name, sort_order)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    sort_order = EXCLUDED.sort_order,
    is_active = true
WHERE public.activities.parent_id IS NULL;

-- Sports and fitness must exist before the popular rows are attached on a database
-- that has not imported the full catalogue yet.
INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active)
SELECT 'sports_fitness', 'Sports & fitness', 'sports_fitness', 60, 'activity', true
WHERE NOT EXISTS (SELECT 1 FROM public.activities WHERE slug = 'sports_fitness');

-- Cocktail, Wine, Beer, Coffee, Detox juice. Slugs cocktail_bar, wine_tasting, craft_beer, coffee stay.
INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active, parent_id, show_in_onboarding)
SELECT v.slug, v.name, 'drinks', v.sort_order, 'activity', true, parent.id, true
FROM (VALUES
  ('cocktail_bar', 'Cocktail', 10),
  ('wine_tasting', 'Wine', 20),
  ('craft_beer', 'Beer', 30),
  ('coffee', 'Coffee', 40),
  ('detox_juice', 'Detox juice', 50)
) AS v (slug, name, sort_order)
JOIN public.activities AS parent ON parent.slug = 'drinks' AND parent.parent_id IS NULL
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    parent_id = EXCLUDED.parent_id,
    sort_order = EXCLUDED.sort_order,
    kind = 'activity',
    is_active = true,
    show_in_onboarding = true;

-- Sporting events is new. Music event / festival keeps music_festival and leaves Music & dance.
INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active, parent_id, show_in_onboarding)
SELECT v.slug, v.name, 'events', v.sort_order, 'activity', true, parent.id, true
FROM (VALUES
  ('sporting_events', 'Sporting events', 10),
  ('music_festival', 'Music event / festival', 20)
) AS v (slug, name, sort_order)
JOIN public.activities AS parent ON parent.slug = 'events' AND parent.parent_id IS NULL
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    parent_id = EXCLUDED.parent_id,
    sort_order = EXCLUDED.sort_order,
    kind = 'activity',
    is_active = true,
    show_in_onboarding = true;

-- Popular sports only. Wellness is unchanged and is not on the onboarding short list.
INSERT INTO public.activities (slug, name, category, sort_order, kind, is_active, parent_id, show_in_onboarding)
SELECT v.slug, v.name, 'sports_fitness', v.sort_order, 'activity', true, parent.id, true
FROM (VALUES
  ('pickleball', 'Pickleball', 820),
  ('tennis', 'Tennis', 800),
  ('yoga', 'Yoga', 730)
) AS v (slug, name, sort_order)
JOIN public.activities AS parent ON parent.slug = 'sports_fitness' AND parent.parent_id IS NULL
ON CONFLICT (slug) DO UPDATE
SET show_in_onboarding = true;
