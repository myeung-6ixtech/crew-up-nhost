DROP TRIGGER IF EXISTS reports_content_flag ON public.reports;
DROP FUNCTION IF EXISTS public.reports_content_flag();
ALTER TABLE public.reports DROP COLUMN IF EXISTS content_flagged;

DROP TRIGGER IF EXISTS profiles_content_filter ON public.profiles;
DROP FUNCTION IF EXISTS public.profiles_content_filter();
DROP TRIGGER IF EXISTS events_content_filter ON public.events;
DROP FUNCTION IF EXISTS public.events_content_filter();
DROP TRIGGER IF EXISTS messages_content_filter ON public.messages;
DROP FUNCTION IF EXISTS public.messages_content_filter();

DROP FUNCTION IF EXISTS public.contains_blocked_term(text);
DROP FUNCTION IF EXISTS public.matched_moderation_severity(text);
DROP TRIGGER IF EXISTS moderation_terms_normalize ON public.moderation_terms;
DROP FUNCTION IF EXISTS public.moderation_terms_normalize();
DROP FUNCTION IF EXISTS public.normalize_moderation_text(text);
DROP TABLE IF EXISTS public.moderation_terms;
