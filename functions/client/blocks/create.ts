import type { Request, Response } from 'express';
import { requireUser } from '../../_lib/auth.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';
import { blockPair, isUuid } from '../../_lib/safetyActions.js';

/**
 * POST /v1/client/blocks/create { user_id, reason? } — block someone. Idempotent.
 * Also ends any friendship and cancels pending requests both ways. The blocked person isn't told; permission filters
 * then hide each from the other everywhere (search, matches, presence, events, chat).
 */
export default async function createBlock(req: Request, res: Response) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
  try {
    const { userId } = requireUser(req);
    const body = (req.body ?? {}) as { user_id?: unknown; reason?: unknown };
    if (!isUuid(body.user_id)) throw new HttpError(400, 'BAD_REQUEST', 'user_id is required');
    if (body.user_id === userId) throw new HttpError(400, 'SELF_BLOCK', "You can't block yourself");
    await blockPair(userId, body.user_id, typeof body.reason === 'string' ? body.reason : null);
    return res.status(200).json({ blocked: true });
  } catch (error) {
    return sendClientError(res, error, 'client/blocks/create', 'BLOCK_FAILED');
  }
}
