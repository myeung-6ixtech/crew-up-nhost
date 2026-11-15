-- Back to the 10-activity onboarding set. Parents and positions are left as they are.
UPDATE public.activities
SET show_in_onboarding = false,
    onboarding_sort = NULL
WHERE slug NOT IN ('cocktail_bar', 'wine_tasting', 'craft_beer', 'coffee', 'detox_juice',
                   'pickleball', 'tennis', 'yoga', 'sporting_events', 'music_festival');
