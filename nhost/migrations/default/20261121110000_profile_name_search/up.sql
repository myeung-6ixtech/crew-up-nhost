-- Friend search by @username or name: partial, case-insensitive matches. The username already has a trigram index
-- (20260924121000_onboarding); these cover the names crew see.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS profiles_display_name_trgm_idx ON public.profiles USING gin (lower(display_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_preferred_name_trgm_idx ON public.profiles USING gin (lower(preferred_name) gin_trgm_ops);
