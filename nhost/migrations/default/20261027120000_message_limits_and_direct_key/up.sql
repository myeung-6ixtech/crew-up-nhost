-- Cap chat size and stop two taps from creating two direct threads.

CREATE INDEX IF NOT EXISTS messages_sender_created_at_idx
  ON public.messages (sender_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.messages_guard_send()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  recent_count integer;
BEGIN
  IF NEW.body IS NOT NULL AND char_length(btrim(NEW.body)) > 2000 THEN
    RAISE EXCEPTION 'MESSAGE_TOO_LONG' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.sender_id IS NOT NULL THEN
    SELECT count(*) INTO recent_count
    FROM public.messages
    WHERE sender_id = NEW.sender_id
      AND created_at > now() - interval '60 seconds';
    IF recent_count >= 20 THEN
      RAISE EXCEPTION 'MESSAGE_RATE_LIMITED' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_guard_send ON public.messages;
CREATE TRIGGER messages_guard_send
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.messages_guard_send();

ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS direct_key text;

-- Drop empty extra direct threads for a pair. A duplicate that already has messages stays, without a key.
WITH pairs AS (
  SELECT
    t.id,
    t.created_at,
    least(a.user_id::text, b.user_id::text) || ':' || greatest(a.user_id::text, b.user_id::text) AS pair_key,
    (SELECT count(*) FROM public.messages m WHERE m.thread_id = t.id) AS message_count
  FROM public.threads t
  JOIN public.thread_participants a ON a.thread_id = t.id
  JOIN public.thread_participants b ON b.thread_id = t.id AND a.user_id < b.user_id
  WHERE t.type = 'direct'
    AND (SELECT count(*) FROM public.thread_participants p WHERE p.thread_id = t.id) = 2
),
ranked AS (
  SELECT
    id,
    pair_key,
    message_count,
    row_number() OVER (PARTITION BY pair_key ORDER BY created_at ASC, id ASC) AS rn
  FROM pairs
)
DELETE FROM public.threads
WHERE id IN (SELECT id FROM ranked WHERE rn > 1 AND message_count = 0);

WITH pairs AS (
  SELECT
    t.id,
    t.created_at,
    least(a.user_id::text, b.user_id::text) || ':' || greatest(a.user_id::text, b.user_id::text) AS pair_key
  FROM public.threads t
  JOIN public.thread_participants a ON a.thread_id = t.id
  JOIN public.thread_participants b ON b.thread_id = t.id AND a.user_id < b.user_id
  WHERE t.type = 'direct'
    AND (SELECT count(*) FROM public.thread_participants p WHERE p.thread_id = t.id) = 2
),
canonical AS (
  SELECT DISTINCT ON (pair_key) id, pair_key
  FROM pairs
  ORDER BY pair_key, created_at ASC, id ASC
)
UPDATE public.threads AS t
SET direct_key = c.pair_key
FROM canonical AS c
WHERE t.id = c.id
  AND t.direct_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS threads_direct_key_unique
  ON public.threads (direct_key)
  WHERE direct_key IS NOT NULL;

COMMENT ON COLUMN public.threads.direct_key IS
  'Sorted user-id pair for a direct thread. One key per pair; null on event chats and leftover duplicates that already had messages.';
