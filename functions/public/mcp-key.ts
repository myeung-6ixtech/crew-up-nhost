import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { graphqlAsAdmin } from '../_lib/graphql.js';

/**
 * POST /v1/public/mcp-key
 * Exchanges a cu_mcp_ key for the owning staff member's Nhost refresh token.
 * The admin app calls this before opening a session. The key itself is the secret.
 * Body: { key: string, refreshToken?: string }
 * When refreshToken is set, the stored token is rotated and nothing else is returned.
 */

type KeyRow = { id: string; user_id: string; refresh_token: string };

function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

export default async function mcpKey(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const body = (req.body ?? {}) as { key?: unknown; refreshToken?: unknown };
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key.startsWith('cu_mcp_') || key.length < 16) {
    return res.status(401).json({ error: 'invalid' });
  }

  try {
    const settings = await graphqlAsAdmin<{ admin_mcp_settings_by_pk: { enabled: boolean } | null }>(
      `query McpEnabled { admin_mcp_settings_by_pk(id: "default") { enabled } }`,
      undefined,
      'admin',
    );
    if (!settings.admin_mcp_settings_by_pk?.enabled) {
      return res.status(503).json({ error: 'disabled' });
    }

    const hash = hashKey(key);
    const found = await graphqlAsAdmin<{ admin_mcp_keys: KeyRow[] }>(
      `
        query McpKey($hash: String!) {
          admin_mcp_keys(where: { key_sha256: { _eq: $hash }, revoked_at: { _is_null: true } }, limit: 1) {
            id
            user_id
            refresh_token
          }
        }
      `,
      { hash },
      'admin',
    );
    const row = found.admin_mcp_keys[0];
    if (!row) {
      return res.status(401).json({ error: 'invalid' });
    }

    const nextRefresh = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
    await graphqlAsAdmin(
      `
        mutation TouchMcpKey($id: uuid!, $set: admin_mcp_keys_set_input!) {
          update_admin_mcp_keys_by_pk(pk_columns: { id: $id }, _set: $set) { id }
        }
      `,
      {
        id: row.id,
        set: {
          last_used_at: new Date().toISOString(),
          ...(nextRefresh ? { refresh_token: nextRefresh } : {}),
        },
      },
      'admin',
    );

    if (nextRefresh) {
      return res.status(204).end();
    }

    return res.status(200).json({ refreshToken: row.refresh_token, userId: row.user_id });
  } catch (error) {
    console.error('public/mcp-key failed', error);
    return res.status(500).json({ error: 'unavailable' });
  }
}
