-- Staff MCP keys for Cursor and Claude. The secret is stored only as a SHA-256 hash.
-- refresh_token lets the admin app open that staff member's Nhost session. Hasura
-- permissions never return it to the browser.

CREATE TABLE public.admin_mcp_settings (
  id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_mcp_settings_id_check CHECK (id = 'default')
);

INSERT INTO public.admin_mcp_settings (id, enabled) VALUES ('default', true);

DROP TRIGGER IF EXISTS admin_mcp_settings_set_updated_at ON public.admin_mcp_settings;
CREATE TRIGGER admin_mcp_settings_set_updated_at
  BEFORE UPDATE ON public.admin_mcp_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.admin_mcp_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL,
  key_sha256 text NOT NULL,
  refresh_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  CONSTRAINT admin_mcp_keys_sha256_unique UNIQUE (key_sha256),
  CONSTRAINT admin_mcp_keys_name_length CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE INDEX admin_mcp_keys_user_active_idx
  ON public.admin_mcp_keys (user_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.admin_mcp_keys IS
  'Bearer keys for the crew-up-admin MCP endpoint. One staff user, at most five unrevoked keys.';
COMMENT ON COLUMN public.admin_mcp_keys.refresh_token IS
  'Nhost refresh token captured when the key was created. Not selectable by staff.';
