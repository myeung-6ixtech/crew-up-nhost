-- Other crew can be listed only after they finish onboarding. The user role cannot
-- read another person's onboarding_state row, so the profiles permission uses this
-- boolean instead of that relationship.
CREATE OR REPLACE FUNCTION public.profile_onboarding_completed(profile public.profiles)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.onboarding_state AS state
    WHERE state.user_id = profile.user_id
      AND state.onboarding_completed_at IS NOT NULL
  );
$$;

COMMENT ON FUNCTION public.profile_onboarding_completed(public.profiles) IS
  'True when this member finished onboarding. Returns no other onboarding fields.';
