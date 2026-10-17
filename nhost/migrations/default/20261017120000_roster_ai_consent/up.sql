-- Roster AI consent (Apple 5.1.2(i)). Written by the client/roster/consent function; the version changes with the AI provider.
ALTER TABLE public.user_private
  ADD COLUMN IF NOT EXISTS roster_ai_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS roster_ai_consent_version text;

COMMENT ON COLUMN public.user_private.roster_ai_consent_at IS
  'When the user agreed to send roster files to the AI service. Server-written.';
COMMENT ON COLUMN public.user_private.roster_ai_consent_version IS
  'Consent revision and provider the user agreed to; roster-parse refuses when it differs from the current one.';
