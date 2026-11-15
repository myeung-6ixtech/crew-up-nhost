UPDATE public.activities
SET show_in_onboarding = false
WHERE slug IN ('cocktail_bar', 'wine_tasting', 'craft_beer', 'coffee', 'detox_juice');
