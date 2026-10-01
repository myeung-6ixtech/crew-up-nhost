-- Split the activity catalog into things you do with crew, and background interests.
-- Events only use kind = activity. Both kinds can sit on a profile.

ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'activity';

ALTER TABLE public.activities DROP CONSTRAINT IF EXISTS activities_kind_check;
ALTER TABLE public.activities
  ADD CONSTRAINT activities_kind_check CHECK (kind IN ('activity', 'interest'));

COMMENT ON COLUMN public.activities.kind IS
  'activity: do-together tags used on events and profiles. interest: profile matching only.';

UPDATE public.activities
SET kind = 'interest'
WHERE slug IN ('sightseeing', 'museum');

INSERT INTO public.activities (slug, name, category, sort_order, kind) VALUES
  ('food', 'Food', 'food_drink', 110, 'interest'),
  ('travel', 'Travel', 'culture', 120, 'interest'),
  ('music', 'Music', 'culture', 130, 'interest'),
  ('photography', 'Photography', 'culture', 140, 'interest'),
  ('movies', 'Movies', 'culture', 150, 'interest'),
  ('reading', 'Reading', 'culture', 160, 'interest')
ON CONFLICT (slug) DO NOTHING;
