-- The Drinks rows are in place under the Drinks group but lost their onboarding flag, so the onboarding
-- activity step showed only Sports & fitness and Events. Flag them again, in order. Safe to re-run.

UPDATE public.activities AS a
SET show_in_onboarding = true,
    onboarding_sort = v.position,
    is_active = true
FROM (VALUES
  ('cocktail_bar', 10),
  ('wine_tasting', 20),
  ('craft_beer', 30),
  ('coffee', 40),
  ('detox_juice', 50)
) AS v (slug, position),
public.activities AS parent
WHERE a.slug = v.slug
  AND a.parent_id = parent.id
  AND parent.slug = 'drinks'
  AND parent.parent_id IS NULL;
