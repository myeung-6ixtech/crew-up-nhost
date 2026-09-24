import type { Request, Response } from 'express';
import { OnboardingError, assertOnboarded, sendOnboardingError } from '../../_lib/onboarding.js';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';
import {
  ConnectionRequestError,
  lookupProfileByFriendId,
  normalizeFriendId,
  sendConnectionRequest,
} from '../../_lib/connectionRequests.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function friendsRequest(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    await assertOnboarded(userId);
    const body = req.body as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : undefined;
    const addresseeIdInput = typeof body.addressee_id === 'string' ? body.addressee_id : '';
    const friendIdInput = typeof body.friend_id === 'string' ? body.friend_id : '';

    let addresseeId = addresseeIdInput.trim();

    if (!addresseeId && friendIdInput.trim()) {
      const normalized = normalizeFriendId(friendIdInput);
      if (!normalized) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Crew member not found' },
        });
      }
      const profile = await lookupProfileByFriendId(normalized);
      if (!profile) {
        return res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Crew member not found' },
        });
      }
      addresseeId = profile.user_id;
    }

    if (!addresseeId || !UUID_PATTERN.test(addresseeId)) {
      return badRequest(res, 'addressee_id or friend_id is required');
    }

    const result = await sendConnectionRequest({
      requesterId: userId,
      addresseeId,
      message,
    });

    const statusCode =
      result.outcome === 'created'
        ? 201
        : result.outcome === 'accepted'
          ? 200
          : 200;

    return res.status(statusCode).json({
      connection: {
        id: result.connection.id,
        status: result.connection.status,
      },
      outcome: result.outcome,
    });
  } catch (error) {
    if (error instanceof OnboardingError) return sendOnboardingError(res, error);
    if (error instanceof ConnectionRequestError) {
      return res.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }
    if (error instanceof Error && error.message.includes('User role')) {
      return res.status(403).json({ message: error.message });
    }
    console.error('client/friends/request error', error);
    return res.status(500).json({
      error: { code: 'REQUEST_FAILED', message: 'Failed to send connection request' },
    });
  }
}
