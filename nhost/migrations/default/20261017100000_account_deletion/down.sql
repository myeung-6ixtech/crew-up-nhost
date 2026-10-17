DELETE FROM public.reports WHERE reporter_id IS NULL;
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_reporter_id_fkey;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES auth.users (id) ON DELETE CASCADE;
ALTER TABLE public.reports ALTER COLUMN reporter_id SET NOT NULL;

DELETE FROM public.messages WHERE removed_at IS NOT NULL;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_has_content;
ALTER TABLE public.messages ADD CONSTRAINT messages_has_content CHECK (
  (body IS NOT NULL AND length(trim(body)) > 0) OR media_file_id IS NOT NULL
);
ALTER TABLE public.messages DROP COLUMN IF EXISTS removed_at;
DELETE FROM public.messages WHERE sender_id IS NULL;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users (id) ON DELETE CASCADE;
ALTER TABLE public.messages ALTER COLUMN sender_id SET NOT NULL;

DROP TABLE IF EXISTS public.account_deletions;
