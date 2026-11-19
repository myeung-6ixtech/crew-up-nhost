-- Report context: where the report was made (profile, chat, event, crossing paths), the relationship at the time,
-- and a snapshot of the reported profile taken by the server, so moderators see what the reporter saw even if the
-- profile changes later. Never shown to the reported person.
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS context jsonb;
COMMENT ON COLUMN public.reports.context IS 'Reporter-side context (source screen, relationship) plus a server snapshot of the reported profile.';
