DROP INDEX IF EXISTS threads_direct_key_unique;
ALTER TABLE public.threads DROP COLUMN IF EXISTS direct_key;

DROP TRIGGER IF EXISTS messages_guard_send ON public.messages;
DROP FUNCTION IF EXISTS public.messages_guard_send();
DROP INDEX IF EXISTS messages_sender_created_at_idx;
