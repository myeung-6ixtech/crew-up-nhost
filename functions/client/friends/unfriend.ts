import type { Request, Response } from 'express';
import { requireUser } from '../../_lib/auth.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';
import { isUuid, unfriendPair } from '../../_lib/safetyActions.js';

/**
 * POST /v1/client/friends/unfriend { user_id } — end a friendship. Idempotent (not friends: still succeeds).
 * The other person isn't notified. Direct chat needs an accepted friendship, so the chat closes with it.
 */
export default async function unfriend(req: Request, res: Response) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  try {
    const { userId } = requireUser(req);
    const body = (req.body ?? {}) as { user_id?: unknown };
    if (!isUuid(body.user_id)) throw new HttpError(400, 'BAD_REQUEST', 'user_id is required');
    await unfriendPair(userId, body.user_id);
    return res.status(200).json({ unfriended: true });
  } catch (error) {
    return sendClientError(res, error, 'client/friends/unfriend', 'UNFRIEND_FAILED');
  }
}
