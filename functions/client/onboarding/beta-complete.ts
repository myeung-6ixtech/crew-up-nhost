import type { Request, Response } from 'express';
import { requireUser } from '../../_lib/auth.js';
import { getAppMode } from '../../_lib/appMode.js';
import { graphqlAsAdmin } from '../../_lib/graphql.js';
import {
  OnboardingError,
  assertProfileComplete,
  ensureOnboardingState,
  handleOnboardingFailure,
  loadOnboarding,
  stateResponse,
} from '../../_lib/onboarding.js';

/**
 * POST /v1/client/onboarding/beta-complete — beta mode only. Sets beta_signup_completed_at once.
 * Never sets onboarding_completed_at (beta sign-up is not onboarding completion).
 */
export default async function betaComplete(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    if (getAppMode() !== 'beta') {
      throw new OnboardingError(409, 'ONBOARDING_WRONG_MODE', 'Beta sign-up has ended');
    }

    const state = await ensureOnboardingState(userId);
    if (state.beta_signup_completed_at) {
      return res.status(200).json({ state: stateResponse(state) });
    }

    const { profile } = await loadOnboarding(userId);
    assertProfileComplete(profile);

    const data = await graphqlAsAdmin<{
      update_onboarding_state: { returning: { beta_signup_completed_at: string | null }[] };
    }>(
      `mutation BetaComplete($userId: uuid!) {
        update_onboarding_state(
          where: { user_id: { _eq: $userId }, beta_signup_completed_at: { _is_null: true } }
          _set: { beta_signup_completed_at: "now()", current_step: "beta_notify" }
        ) { returning { beta_signup_completed_at } }
      }`,
      { userId },
    );

    const refreshed = (await loadOnboarding(userId)).state ?? state;
    return res.status(data.update_onboarding_state.returning.length ? 201 : 200).json({
      state: stateResponse(refreshed),
    });
  } catch (error) {
    return handleOnboardingFailure(res, error, 'client/onboarding/beta-complete');
  }
}
