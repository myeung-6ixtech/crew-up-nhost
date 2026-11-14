import type { Request, Response } from 'express';
import { OnboardingError, assertOnboarded, sendOnboardingError } from '../../_lib/onboarding.js';
import { requireUser, unauthorized } from '../../_lib/auth.js';
import { recomputeMatchesForUsers } from '../../_lib/tripMatching.js';

/** Rebuild layover matches for the signed-in member after a friendship changes. */
export default async function rematchTrips(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    await assertOnboarded(userId);
    const body = req.body as Record<string, unknown>;
    const otherId = typeof body.user_id === 'string' ? body.user_id : '';
    const inserted = await recomputeMatchesForUsers(otherId ? [userId, otherId] : [userId]);
    return res.status(200).json({ inserted });
  } catch (error) {
    if (error instanceof OnboardingError) return sendOnboardingError(res, error);
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }
    console.error('client/trips/rematch error', error);
    return res.status(500).json({ message: 'Failed to refresh layover matches' });
  }
}
