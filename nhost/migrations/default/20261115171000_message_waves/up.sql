-- A layover wave is a chat event, separate from a typed message.
-- Friends post one wave per overlap into the direct thread.
-- A wave sent before you are friends is stored on the request and copied
-- into the thread when that request is accepted.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS meta jsonb;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_kind_check;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'wave'));

COMMENT ON COLUMN public.messages.kind IS
  'text is a normal chat line. wave is a layover nudge and is rendered from meta.';
COMMENT ON COLUMN public.messages.meta IS
  'Layover snapshot for kind=wave: overlap_key, city, match_type, overlap_start, overlap_end, flight_number.';

CREATE UNIQUE INDEX IF NOT EXISTS messages_wave_overlap_unique
  ON public.messages (thread_id, sender_id, (meta->>'overlap_key'))
  WHERE kind = 'wave' AND meta->>'overlap_key' IS NOT NULL;

ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS wave_meta jsonb;

COMMENT ON COLUMN public.connections.wave_meta IS
  'Layover snapshot copied into a wave message when this request is accepted.';

-- Rewrite a wave before the content filter sees it, so the stored line is always "Waved".
CREATE OR REPLACE FUNCTION public.messages_before_wave()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  overlap_key text;
BEGIN
  IF NEW.kind IS NULL OR NEW.kind = 'text' THEN
    NEW.kind := 'text';
    RETURN NEW;
  END IF;

  IF NEW.kind <> 'wave' THEN
    RAISE EXCEPTION 'WAVE_KIND' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.threads WHERE id = NEW.thread_id AND type = 'direct'
  ) THEN
    RAISE EXCEPTION 'WAVE_DIRECT_ONLY' USING ERRCODE = '23514';
  END IF;

  IF NEW.meta IS NULL OR jsonb_typeof(NEW.meta) <> 'object' THEN
    RAISE EXCEPTION 'WAVE_META' USING ERRCODE = '23514';
  END IF;

  overlap_key := NULLIF(left(btrim(COALESCE(NEW.meta->>'overlap_key', '')), 200), '');
  IF overlap_key IS NULL THEN
    RAISE EXCEPTION 'WAVE_KEY' USING ERRCODE = '23514';
  END IF;

  NEW.body := 'Waved';
  NEW.meta := jsonb_strip_nulls(jsonb_build_object(
    'overlap_key', overlap_key,
    'city', NULLIF(left(btrim(COALESCE(NEW.meta->>'city', '')), 80), ''),
    'match_type', NULLIF(left(btrim(COALESCE(NEW.meta->>'match_type', '')), 40), ''),
    'overlap_start', NULLIF(left(btrim(COALESCE(NEW.meta->>'overlap_start', '')), 40), ''),
    'overlap_end', NULLIF(left(btrim(COALESCE(NEW.meta->>'overlap_end', '')), 40), ''),
    'flight_number', NULLIF(left(btrim(COALESCE(NEW.meta->>'flight_number', '')), 20), ''),
    'connection_id', NULLIF(left(btrim(COALESCE(NEW.meta->>'connection_id', '')), 36), '')
  ));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_before_wave ON public.messages;
CREATE TRIGGER messages_before_wave
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.messages_before_wave();

CREATE OR REPLACE FUNCTION public.seed_wave_on_accept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pair_key text;
  thread uuid;
  overlap_key text;
  wave jsonb;
BEGIN
  IF NEW.status <> 'accepted' OR OLD.status = 'accepted' THEN
    RETURN NEW;
  END IF;
  -- wave_meta is a layover snapshot. The fixed sentence covers a wave sent before that column existed.
  IF (NEW.wave_meta IS NULL OR jsonb_typeof(NEW.wave_meta) <> 'object')
     AND COALESCE(NEW.message, '') <> 'Hi — looks like we''re crossing paths!' THEN
    RETURN NEW;
  END IF;

  BEGIN
    pair_key := CASE
      WHEN NEW.requester_id::text < NEW.addressee_id::text
        THEN NEW.requester_id::text || ':' || NEW.addressee_id::text
      ELSE NEW.addressee_id::text || ':' || NEW.requester_id::text
    END;

    SELECT t.id INTO thread
    FROM public.threads t
    WHERE t.type = 'direct' AND t.direct_key = pair_key
    LIMIT 1;

    IF thread IS NULL THEN
      SELECT t.id INTO thread
      FROM public.threads t
      WHERE t.type = 'direct'
        AND EXISTS (
          SELECT 1 FROM public.thread_participants p
          WHERE p.thread_id = t.id AND p.user_id = NEW.requester_id
        )
        AND EXISTS (
          SELECT 1 FROM public.thread_participants p
          WHERE p.thread_id = t.id AND p.user_id = NEW.addressee_id
        )
      ORDER BY t.created_at
      LIMIT 1;
    END IF;

    IF thread IS NULL THEN
      INSERT INTO public.threads (type, direct_key)
      VALUES ('direct', pair_key)
      RETURNING id INTO thread;

      INSERT INTO public.thread_participants (thread_id, user_id)
      VALUES (thread, NEW.requester_id), (thread, NEW.addressee_id);
    END IF;

    overlap_key := NULLIF(left(btrim(COALESCE(NEW.wave_meta->>'overlap_key', '')), 200), '');
    IF overlap_key IS NULL THEN
      overlap_key := 'connection:' || NEW.id::text;
    END IF;

    wave := jsonb_build_object(
      'overlap_key', overlap_key,
      'city', NEW.wave_meta->>'city',
      'match_type', NEW.wave_meta->>'match_type',
      'overlap_start', NEW.wave_meta->>'overlap_start',
      'overlap_end', NEW.wave_meta->>'overlap_end',
      'flight_number', NEW.wave_meta->>'flight_number',
      'connection_id', NEW.id::text
    );

    IF NOT EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.thread_id = thread
        AND m.sender_id = NEW.requester_id
        AND m.kind = 'wave'
        AND m.meta->>'overlap_key' = overlap_key
    ) THEN
      INSERT INTO public.messages (thread_id, sender_id, body, kind, meta)
      VALUES (thread, NEW.requester_id, 'Waved', 'wave', wave);
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'seed_wave_on_accept: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS connections_seed_wave_on_accept ON public.connections;
CREATE TRIGGER connections_seed_wave_on_accept
  AFTER UPDATE OF status ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_wave_on_accept();
