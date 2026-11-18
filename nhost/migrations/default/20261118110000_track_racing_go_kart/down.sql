DELETE FROM public.profile_activity_preferences
WHERE activity_id IN (
  SELECT id FROM public.activities WHERE slug IN ('track_racing', 'go_kart')
);

DELETE FROM public.event_activities
WHERE activity_id IN (
  SELECT id FROM public.activities WHERE slug IN ('track_racing', 'go_kart')
);

DELETE FROM public.activities
WHERE slug IN ('track_racing', 'go_kart');
