import type { Request, Response } from 'express';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';
import { graphqlRaw } from '../../_lib/graphql.js';

const TOKEN_PATTERN = /^(Exponent|Expo)PushToken\[[^\]]+\]$/;

export default async function registerPushToken(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    const body = req.body as Record<string, unknown>;
    const expoPushToken = typeof body.expo_push_token === 'string' ? body.expo_push_token.trim() : '';
    const platform = body.platform === 'ios' ? 'ios' : body.platform === 'android' ? 'android' : '';

    if (!TOKEN_PATTERN.test(expoPushToken)) {
      return badRequest(res, 'expo_push_token is invalid');
    }
    if (!platform) {
      return badRequest(res, 'platform must be android or ios');
    }

    await graphqlRaw(
      `
        mutation UpsertPushToken($object: push_tokens_insert_input!) {
          insert_push_tokens_one(
            object: $object
            on_conflict: {
              constraint: push_tokens_expo_push_token_key
              update_columns: [user_id, platform, is_active, last_seen_at]
            }
          ) {
            id
          }
        }
      `,
      {
        object: {
          user_id: userId,
          expo_push_token: expoPushToken,
          platform,
          is_active: true,
          last_seen_at: new Date().toISOString(),
        },
      },
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }
    if (error instanceof Error && (error.message.includes('Invalid token') || error.message.includes('role required'))) {
      return unauthorized(res);
    }
    console.error('client/push/register error', error);
    return res.status(500).json({ message: 'Failed to save push token' });
  }
}
