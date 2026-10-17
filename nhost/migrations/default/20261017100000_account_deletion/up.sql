-- In-app account deletion (Apple 5.1.1(v)) with a 30-day grace period.
-- POST /client/account/delete hides the person and schedules the purge; signing in and choosing
-- "Keep my account" (POST /client/account/restore) cancels it. internal/account-deletion-purge
-- deletes their files and their auth.users row once purge_after passes.

-- No FK to auth.users on purpose: the row outlives the user as a record that the purge ran.
CREATE TABLE IF NOT EXISTS public.account_deletions (
  user_id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL,
  cancelled_at timestamptz,
  purged_at timestamptz,
  previous_visibility text
);

CREATE INDEX IF NOT EXISTS account_deletions_due_idx
  ON public.account_deletions (purge_after)
  WHERE cancelled_at IS NULL AND purged_at IS NULL;

COMMENT ON TABLE public.account_deletions IS
  'Pending and completed account deletions. previous_visibility restores profiles.default_visibility on cancel.';

-- Deleting someone must not delete what other people need: their messages stay in others'' chats
-- (shown as removed) and reports they filed stay in the moderation queue.
ALTER TABLE public.messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users (id) ON DELETE SET NULL;

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_has_content;
ALTER TABLE public.messages ADD CONSTRAINT messages_has_content CHECK (
  removed_at IS NOT NULL
  OR (body IS NOT NULL AND length(trim(body)) > 0)
  OR media_file_id IS NOT NULL
);

COMMENT ON COLUMN public.messages.removed_at IS
  'Set when the sender''s account is purged or staff remove the message; the body is cleared and the app shows "Message removed".';

ALTER TABLE public.reports ALTER COLUMN reporter_id DROP NOT NULL;
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_reporter_id_fkey;
ALTER TABLE public.reports
  ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES auth.users (id) ON DELETE SET NULL;
