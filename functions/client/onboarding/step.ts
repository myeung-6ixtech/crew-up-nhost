import type { Request, Response } from 'express';
import { requireUser } from '../../_lib/auth.js';
import { getAppMode } from '../../_lib/appMode.js';
import {
  OnboardingError,
  advancedStep,
  assertCrewReferences,
  assertOwnAvatar,
  assertStepAllowed,
  columnsForStep,
  ensureOnboardingState,
  handleOnboardingFailure,
  isUsernameTaken,
  parseStepData,
  setCurrentStep,
  stateResponse,
  writeStep,
  zodFields,
} from '../../_lib/onboarding.js';
import { StepRequestSchema } from '../../_shared/index.js';

/**
 * PUT /v1/client/onboarding/step  { step, data, advance? }
 * Validates one step with its shared Zod schema, writes profiles / user_private (plus legacy columns),
 * and advances current_step. `advance: false` (Edit profile, edits from Review) never moves the step;
 * completed users never have onboarding_state touched.
 */
export default async function onboardingStep(req: Request, res: Response) {
  if (req.method !== 'PUT') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    const request = StepRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      throw new OnboardingError(400, 'ONBOARDING_BAD_REQUEST', 'Invalid step request', zodFields(request.error.issues));
    }
    const { step, advance } = request.data;

    const mode = getAppMode();
    let state = await ensureOnboardingState(userId);
    const completed = Boolean(state.onboarding_completed_at);
    if (!completed) assertStepAllowed(mode, step);

    const data = parseStepData(step, request.data.data);

    if (step === 'name_handle' && (await isUsernameTaken(String(data.username), userId))) {
      throw new OnboardingError(409, 'ONBOARDING_USERNAME_TAKEN', 'That username is taken', {
        username: 'That username is taken',
      });
    }
    if (step === 'crew') {
      await assertCrewReferences(String(data.airlineId), String(data.baseAirportIata));
    }
    if (step === 'photo' && typeof data.avatarFileId === 'string') {
      await assertOwnAvatar(data.avatarFileId, userId);
    }

    await writeStep(userId, columnsForStep(step, data));

    if (advance && !completed) {
      const next = advancedStep(mode, step);
      await setCurrentStep(userId, next);
      state = { ...state, current_step: next };
    }

    return res.status(200).json({ step, state: stateResponse(state) });
  } catch (error) {
    return handleOnboardingFailure(res, error, 'client/onboarding/step');
  }
}
