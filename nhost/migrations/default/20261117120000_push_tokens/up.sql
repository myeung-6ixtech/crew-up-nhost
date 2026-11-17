-- Device push tokens. Android uses FCM through Expo now. The same row shape accepts an iOS token later.

CREATE TABLE IF NOT EXISTS public.push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  expo_push_token text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  is_active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_tokens_expo_push_token_key UNIQUE (expo_push_token)
);

CREATE INDEX IF NOT EXISTS push_tokens_user_active_idx
  ON public.push_tokens (user_id)
  WHERE is_active;

COMMENT ON TABLE public.push_tokens IS
  'Expo push tokens for the signed-in device. The server sends through the Expo push API.';
