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
  zodFields,
} from '../../_lib/onboarding.js';
import { CompleteRequestSchema, GUIDELINES_VERSION } from '../../_shared/index.js';

/**
 * POST /v1/client/onboarding/complete  { guidelinesVersion } — launched mode only.
 * Idempotent: once onboarding_completed_at is set it is returned unchanged (write-once in Postgres too).
 */
export default async function onboardingComplete(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);

    const state = await ensureOnboardingState(userId);
    if (state.onboarding_completed_at) {
      return res.status(200).json({ state: stateResponse(state) });
    }

    if (getAppMode() !== 'launched') {
      throw new OnboardingError(409, 'ONBOARDING_WRONG_MODE', 'CrewUp has not launched yet');
    }

    const body = CompleteRequestSchema.safeParse(req.body ?? {});
    if (!body.success) {
      throw new OnboardingError(400, 'ONBOARDING_BAD_REQUEST', 'Accept the community guidelines', zodFields(body.error.issues));
    }
    if (body.data.guidelinesVersion !== GUIDELINES_VERSION) {
      throw new OnboardingError(409, 'ONBOARDING_GUIDELINES_OUTDATED', 'The guidelines were updated. Review them again.');
    }
    // current_step only reaches the last launch step after the guidelines step was explicitly accepted.
    if (state.current_step !== 'launch_notifications') {
      throw new OnboardingError(409, 'ONBOARDING_GUIDELINES_REQUIRED', 'Accept the community guidelines first');
    }

    const { profile } = await loadOnboarding(userId);
    assertProfileComplete(profile);

    const data = await graphqlAsAdmin<{
      update_onboarding_state: { affected_rows: number };
    }>(
      `mutation CompleteOnboarding($userId: uuid!, $version: String!) {
        update_onboarding_state(
          where: { user_id: { _eq: $userId }, onboarding_completed_at: { _is_null: true } }
          _set: {
            onboarding_completed_at: "now()"
            guidelines_accepted_version: $version
            guidelines_accepted_at: "now()"
            current_step: null
          }
        ) { affected_rows }
      }`,
      { userId, version: body.data.guidelinesVersion },
    );

    const refreshed = (await loadOnboarding(userId)).state ?? state;
    return res.status(data.update_onboarding_state.affected_rows ? 201 : 200).json({
      state: stateResponse(refreshed),
    });
  } catch (error) {
    return handleOnboardingFailure(res, error, 'client/onboarding/complete');
  }
}
