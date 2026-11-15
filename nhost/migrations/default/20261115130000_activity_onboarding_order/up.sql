-- Display order for the onboarding activity step (Drinks, then Sports & fitness, then Events).
-- The full catalogue keeps its own sort_order; this only orders the short show_in_onboarding set.
-- Parents are section headers: one can never be flagged for onboarding.

ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS onboarding_sort smallint;

COMMENT ON COLUMN public.activities.onboarding_sort IS
  'Order within the onboarding activity step. Only meaningful when show_in_onboarding is true.';

UPDATE public.activities AS a
SET onboarding_sort = v.position
FROM (VALUES
  ('cocktail_bar', 10),
  ('wine_tasting', 20),
  ('craft_beer', 30),
  ('coffee', 40),
  ('detox_juice', 50),
  ('pickleball', 10),
  ('tennis', 20),
  ('yoga', 30),
  ('sporting_events', 10),
  ('music_festival', 20)
) AS v (slug, position)
WHERE a.slug = v.slug
  AND a.parent_id IS NOT NULL;

UPDATE public.activities
SET show_in_onboarding = false
WHERE parent_id IS NULL
  AND show_in_onboarding;

ALTER TABLE public.activities DROP CONSTRAINT IF EXISTS activities_parent_not_onboarding;
ALTER TABLE public.activities
  ADD CONSTRAINT activities_parent_not_onboarding CHECK (parent_id IS NOT NULL OR NOT show_in_onboarding);
