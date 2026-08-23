import type { Request, Response } from 'express';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';
import {
  ConnectionRequestError,
  formatFriendIdForDisplay,
  lookupProfileByFriendId,
  normalizeFriendId,
} from '../../_lib/connectionRequests.js';

export default async function friendsLookup(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    requireUser(req);
    const body = req.body as Record<string, unknown>;
    const friendIdInput = typeof body.friend_id === 'string' ? body.friend_id : '';

    if (!friendIdInput.trim()) {
      return badRequest(res, 'friend_id is required');
    }

    const normalized = normalizeFriendId(friendIdInput);
    if (!normalized) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'No crew member found with that Crew ID' },
      });
    }

    const profile = await lookupProfileByFriendId(normalized);
    if (!profile) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'No crew member found with that Crew ID' },
      });
    }

    return res.status(200).json({
      profile: {
        user_id: profile.user_id,
        display_name: profile.display_name,
        role_type: profile.role_type ?? null,
        base_airport: profile.base_airport ?? null,
        avatar_file_id: profile.avatar_file_id ?? null,
        friend_id: profile.friend_id,
        friend_id_display: formatFriendIdForDisplay(profile.friend_id),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }
    if (error instanceof Error && error.message.includes('User role')) {
      return res.status(403).json({ message: error.message });
    }
    console.error('client/friends/lookup error', error);
    return res.status(500).json({
      error: { code: 'LOOKUP_FAILED', message: 'Friend lookup failed' },
    });
  }
}
