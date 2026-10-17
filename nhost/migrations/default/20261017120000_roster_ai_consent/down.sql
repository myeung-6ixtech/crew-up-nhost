ALTER TABLE public.user_private
  DROP COLUMN IF EXISTS roster_ai_consent_version,
  DROP COLUMN IF EXISTS roster_ai_consent_at;
