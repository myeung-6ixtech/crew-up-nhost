import type { Request, Response } from 'express';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';
import { graphqlRaw } from '../../_lib/graphql.js';

export default async function unregisterPushToken(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    const body = req.body as Record<string, unknown>;
    const expoPushToken = typeof body.expo_push_token === 'string' ? body.expo_push_token.trim() : '';
    if (!expoPushToken) return badRequest(res, 'expo_push_token is required');

    await graphqlRaw(
      `
        mutation DeactivatePushToken($userId: uuid!, $token: String!) {
          update_push_tokens(
            where: { user_id: { _eq: $userId }, expo_push_token: { _eq: $token } }
            _set: { is_active: false }
          ) {
            affected_rows
          }
        }
      `,
      { userId, token: expoPushToken },
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof Error && (error.message.includes('Authorization') || error.message.includes('Invalid token') || error.message.includes('role required'))) {
      return unauthorized(res);
    }
    console.error('client/push/unregister error', error);
    return res.status(500).json({ message: 'Failed to remove push token' });
  }
}
