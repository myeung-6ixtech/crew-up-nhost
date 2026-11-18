import type { Request, Response } from 'express';
import { OnboardingError, assertOnboarded, sendOnboardingError } from '../../_lib/onboarding.js';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';
import {
  ConnectionRequestError,
  formatFriendIdForDisplay,
  getPairConnection,
  isBlockedBetween,
  lookupProfileByFriendId,
  normalizeFriendId,
  relationshipFrom,
} from '../../_lib/connectionRequests.js';

export default async function friendsLookup(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    await assertOnboarded(userId);
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

    // A block either way: the code can't be used, and nothing about the person is returned.
    if (profile.user_id !== userId && (await isBlockedBetween(userId, profile.user_id))) {
      return res.status(403).json({ error: { code: 'BLOCKED', message: 'This code can\'t be used' } });
    }
    const relationship = relationshipFrom(userId, profile.user_id, profile.user_id === userId ? null : await getPairConnection(userId, profile.user_id));

    return res.status(200).json({
      relationship,
      profile: {
        user_id: profile.user_id,
        display_name: profile.display_name,
        preferred_name: profile.preferred_name ?? null,
        crew_role: profile.crew_role ?? null,
        airline_id: profile.airline_id ?? null,
        role_type: profile.role_type ?? null,
        base_airport: profile.base_airport ?? null,
        base_airport_iata: profile.base_airport_iata ?? null,
        avatar_file_id: profile.avatar_file_id ?? null,
        // The caller already has this code (they typed or scanned it); it's echoed for the Crew ID search.
        friend_id: profile.friend_id,
        friend_id_display: formatFriendIdForDisplay(profile.friend_id),
      },
    });
  } catch (error) {
    if (error instanceof OnboardingError) return sendOnboardingError(res, error);
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
