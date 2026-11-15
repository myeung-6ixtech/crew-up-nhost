ALTER TABLE public.activities DROP CONSTRAINT IF EXISTS activities_parent_not_onboarding;
ALTER TABLE public.activities DROP COLUMN IF EXISTS onboarding_sort;
