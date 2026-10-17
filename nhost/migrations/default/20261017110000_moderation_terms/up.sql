-- Text content filter (Apple 1.2, Play UGC): a staff-maintained word list checked by triggers.
-- Blocked text raises CONTENT_BLOCKED; report details are only flagged so people can still describe abuse.

CREATE TABLE IF NOT EXISTS public.moderation_terms (
  term text PRIMARY KEY,
  lang text NOT NULL DEFAULT 'en',
  severity text NOT NULL DEFAULT 'block',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_terms_severity_check CHECK (severity IN ('block', 'flag')),
  CONSTRAINT moderation_terms_term_not_blank CHECK (length(btrim(term)) > 0)
);

COMMENT ON TABLE public.moderation_terms IS
  'Words and phrases rejected in user text. Stored normalized (see normalize_moderation_text). Edited in crew-up-admin.';
COMMENT ON COLUMN public.moderation_terms.lang IS
  'ISO 639-1. ja/zh/ko/th match as substrings because those scripts have no spaces between words.';

-- Lowercase, strip common accents, undo leetspeak, and turn punctuation into single spaces.
CREATE OR REPLACE FUNCTION public.normalize_moderation_text(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(
    translate(
      lower(coalesce(input, '')),
      'àáâãäåāăąçćčďèéêëēėęěìíîïīįłñńňòóôõöøōőřśšşťùúûüūůűųýÿžźż013457@$',
      'aaaaaaaaacccdeeeeeeeeiiiiiilnnnoooooooorssstuuuuuuuuyyzzzoieastas'
    ),
    '[^[:alnum:]]+', ' ', 'g'
  ));
$$;

CREATE OR REPLACE FUNCTION public.moderation_terms_normalize()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.term := public.normalize_moderation_text(NEW.term);
  NEW.lang := lower(btrim(NEW.lang));
  IF NEW.term = '' THEN
    RAISE EXCEPTION 'MODERATION_TERM_EMPTY' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS moderation_terms_normalize ON public.moderation_terms;
CREATE TRIGGER moderation_terms_normalize
  BEFORE INSERT OR UPDATE ON public.moderation_terms
  FOR EACH ROW EXECUTE FUNCTION public.moderation_terms_normalize();

-- Whole-word (or whole-phrase) match for spaced scripts, substring match for ja/zh/ko/th.
CREATE OR REPLACE FUNCTION public.matched_moderation_severity(input text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  WITH n AS (SELECT ' ' || public.normalize_moderation_text(input) || ' ' AS t)
  SELECT CASE
    WHEN bool_or(m.severity = 'block') THEN 'block'
    WHEN count(*) > 0 THEN 'flag'
  END
  FROM public.moderation_terms m, n
  WHERE input IS NOT NULL
    AND btrim(input) <> ''
    AND (
      (m.lang IN ('ja', 'zh', 'ko', 'th') AND position(m.term IN n.t) > 0)
      OR (m.lang NOT IN ('ja', 'zh', 'ko', 'th') AND position(' ' || m.term || ' ' IN n.t) > 0)
    );
$$;

CREATE OR REPLACE FUNCTION public.contains_blocked_term(input text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.matched_moderation_severity(input) = 'block';
$$;

CREATE OR REPLACE FUNCTION public.messages_content_filter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.contains_blocked_term(NEW.body) THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_content_filter ON public.messages;
CREATE TRIGGER messages_content_filter
  BEFORE INSERT OR UPDATE OF body ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_content_filter();

CREATE OR REPLACE FUNCTION public.events_content_filter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.contains_blocked_term(NEW.title)
    OR public.contains_blocked_term(NEW.description)
    OR public.contains_blocked_term(NEW.venue_name) THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_content_filter ON public.events;
CREATE TRIGGER events_content_filter
  BEFORE INSERT OR UPDATE OF title, description, venue_name ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_content_filter();

CREATE OR REPLACE FUNCTION public.profiles_content_filter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF public.contains_blocked_term(NEW.full_name)
    OR public.contains_blocked_term(NEW.full_name_native)
    OR public.contains_blocked_term(NEW.preferred_name)
    OR public.contains_blocked_term(NEW.display_name)
    OR public.contains_blocked_term(replace(NEW.username, '_', ' '))
    OR public.contains_blocked_term(NEW.username) THEN
    RAISE EXCEPTION 'CONTENT_BLOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_content_filter ON public.profiles;
CREATE TRIGGER profiles_content_filter
  BEFORE INSERT OR UPDATE OF full_name, full_name_native, preferred_name, display_name, username ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_content_filter();

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS content_flagged boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.reports.content_flagged IS
  'Details matched a moderation term. Reports are never rejected; staff see the flag in the queue.';

CREATE OR REPLACE FUNCTION public.reports_content_flag()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.content_flagged := public.matched_moderation_severity(NEW.details) IS NOT NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reports_content_flag ON public.reports;
CREATE TRIGGER reports_content_flag
  BEFORE INSERT OR UPDATE OF details ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.reports_content_flag();
