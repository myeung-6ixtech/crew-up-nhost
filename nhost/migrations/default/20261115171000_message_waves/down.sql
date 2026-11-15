DROP TRIGGER IF EXISTS connections_seed_wave_on_accept ON public.connections;
DROP FUNCTION IF EXISTS public.seed_wave_on_accept();

DROP TRIGGER IF EXISTS messages_before_wave ON public.messages;
DROP FUNCTION IF EXISTS public.messages_before_wave();

DROP INDEX IF EXISTS messages_wave_overlap_unique;

ALTER TABLE public.connections DROP COLUMN IF EXISTS wave_meta;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE public.messages DROP COLUMN IF EXISTS meta;
ALTER TABLE public.messages DROP COLUMN IF EXISTS kind;
