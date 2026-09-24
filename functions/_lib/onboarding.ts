import type { Response } from 'express';
import {
  FLOW_VERSION,
  ProfileCompleteSchema,
  STEP_SCHEMAS,
  isBetaStep,
  isLaunchStep,
  nextStep,
  type AppMode,
  type CrewRole,
  type OnboardingStep,
  type ProfileComplete,
} from '../_shared/index.js';
import { graphqlAsAdmin } from './graphql.js';

export class OnboardingError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fields?: Record<string, string>;

  constructor(statusCode: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'OnboardingError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
  }
}

export function sendOnboardingError(res: Response, error: OnboardingError) {
  return res.status(error.statusCode).json({
    error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) },
  });
}

/** Maps Zod issues to `{ fieldName: firstMessage }` for form display. */
export function zodFields(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || '_';
    fields[key] ??= issue.message;
  }
  return fields;
}

export type ProfileRow = {
  user_id: string;
  full_name: string | null;
  full_name_native: string | null;
  preferred_name: string | null;
  username: string | null;
  date_of_birth: string | null;
  home_country_code: string | null;
  hometown_city: string | null;
  languages: string[] | null;
  residence_country_code: string | null;
  residence_city: string | null;
  crew_role: CrewRole | null;
  airline_id: string | null;
  base_airport_iata: string | null;
  avatar_file_id: string | null;
};

export type OnboardingStateRow = {
  user_id: string;
  current_step: OnboardingStep | null;
  flow_version: number;
  beta_signup_completed_at: string | null;
  onboarding_completed_at: string | null;
  guidelines_accepted_version: string | null;
  guidelines_accepted_at: string | null;
};

const PROFILE_FIELDS = `
  user_id full_name full_name_native preferred_name username date_of_birth home_country_code
  hometown_city languages residence_country_code residence_city crew_role airline_id base_airport_iata
  avatar_file_id
`;
const STATE_FIELDS = `
  user_id current_step flow_version beta_signup_completed_at onboarding_completed_at
  guidelines_accepted_version guidelines_accepted_at
`;

export async function loadOnboarding(userId: string) {
  const data = await graphqlAsAdmin<{
    profiles_by_pk: ProfileRow | null;
    onboarding_state_by_pk: OnboardingStateRow | null;
  }>(
    `query LoadOnboarding($userId: uuid!) {
      profiles_by_pk(user_id: $userId) { ${PROFILE_FIELDS} }
      onboarding_state_by_pk(user_id: $userId) { ${STATE_FIELDS} }
    }`,
    { userId },
  );
  return { profile: data.profiles_by_pk, state: data.onboarding_state_by_pk };
}

export async function ensureOnboardingState(userId: string): Promise<OnboardingStateRow> {
  const data = await graphqlAsAdmin<{ insert_onboarding_state_one: OnboardingStateRow | null }>(
    `mutation EnsureOnboardingState($row: onboarding_state_insert_input!) {
      insert_onboarding_state_one(
        object: $row
        on_conflict: { constraint: onboarding_state_pkey, update_columns: [] }
      ) { ${STATE_FIELDS} }
    }`,
    { row: { user_id: userId, current_step: 'name_handle', flow_version: FLOW_VERSION } },
  );
  if (data.insert_onboarding_state_one) return data.insert_onboarding_state_one;
  const { state } = await loadOnboarding(userId);
  if (!state) throw new Error('onboarding_state row missing after upsert');
  return state;
}

/** Social features require completed onboarding (onboarding.md §5.5); Functions using the admin secret check here. */
export async function assertOnboarded(userId: string): Promise<void> {
  const data = await graphqlAsAdmin<{ onboarding_state_by_pk: { onboarding_completed_at: string | null } | null }>(
    `query AssertOnboarded($userId: uuid!) {
      onboarding_state_by_pk(user_id: $userId) { onboarding_completed_at }
    }`,
    { userId },
  );
  if (!data.onboarding_state_by_pk?.onboarding_completed_at) {
    throw new OnboardingError(403, 'ONBOARDING_REQUIRED', 'Finish onboarding to use this feature');
  }
}

/** Legacy `profiles.role_type` has no `other`; it stays null for those users. */
function legacyRoleType(role: CrewRole): string | null {
  return role === 'other' ? null : role;
}

export type StepWrite = {
  profile: Record<string, unknown> | null;
  userPrivate: Record<string, unknown> | null;
};

/** Maps validated step data to column writes, including the legacy columns kept in sync. */
export function columnsForStep(step: OnboardingStep, data: Record<string, unknown>): StepWrite {
  switch (step) {
    case 'name_handle': {
      const d = data as { fullName: string; fullNameNative: string | null; preferredName: string | null; username: string };
      return {
        profile: {
          full_name: d.fullName,
          full_name_native: d.fullNameNative,
          preferred_name: d.preferredName,
          username: d.username,
          display_name: d.preferredName ?? d.fullName,
        },
        userPrivate: null,
      };
    }
    case 'about': {
      const d = data as { dateOfBirth: string; homeCountryCode: string; hometownCity: string | null; languages: string[] };
      return {
        profile: {
          date_of_birth: d.dateOfBirth,
          home_country_code: d.homeCountryCode,
          hometown_city: d.hometownCity,
          languages: d.languages,
        },
        userPrivate: null,
      };
    }
    case 'residence': {
      const d = data as { residenceCountryCode: string; residenceCity: string };
      return {
        profile: { residence_country_code: d.residenceCountryCode, residence_city: d.residenceCity },
        userPrivate: null,
      };
    }
    case 'crew': {
      const d = data as { crewRole: CrewRole; airlineId: string; baseAirportIata: string };
      return {
        profile: {
          crew_role: d.crewRole,
          role_type: legacyRoleType(d.crewRole),
          airline_id: d.airlineId,
          base_airport_iata: d.baseAirportIata,
          base_airport: d.baseAirportIata,
        },
        userPrivate: null,
      };
    }
    case 'phone': {
      const d = data as { phoneE164?: string | null };
      return d.phoneE164 === undefined
        ? { profile: null, userPrivate: null }
        : { profile: null, userPrivate: { phone_e164: d.phoneE164 } };
    }
    case 'photo': {
      const d = data as { avatarFileId?: string | null };
      return d.avatarFileId === undefined
        ? { profile: null, userPrivate: null }
        : { profile: { avatar_file_id: d.avatarFileId }, userPrivate: null };
    }
    default:
      return { profile: null, userPrivate: null };
  }
}

export function assertStepAllowed(mode: AppMode, step: OnboardingStep) {
  if (mode === 'beta' && isLaunchStep(step)) {
    throw new OnboardingError(409, 'ONBOARDING_WRONG_MODE', 'This step is only available after launch');
  }
  if (mode === 'launched' && isBetaStep(step)) {
    throw new OnboardingError(409, 'ONBOARDING_WRONG_MODE', 'Beta sign-up has ended');
  }
}

export function parseStepData(step: OnboardingStep, data: unknown): Record<string, unknown> {
  const result = STEP_SCHEMAS[step].safeParse(data);
  if (!result.success) {
    throw new OnboardingError(422, 'ONBOARDING_INVALID_STEP', 'Please check the highlighted fields', zodFields(result.error.issues));
  }
  return result.data as Record<string, unknown>;
}

/** `current_step` after saving `step`: the next step in this mode, or the same step at the end of the flow. */
export function advancedStep(mode: AppMode, step: OnboardingStep): OnboardingStep {
  return nextStep(mode, step) ?? step;
}

export function profileRowToInput(profile: ProfileRow | null) {
  return {
    fullName: profile?.full_name ?? '',
    fullNameNative: profile?.full_name_native ?? null,
    preferredName: profile?.preferred_name ?? null,
    username: profile?.username ?? '',
    dateOfBirth: profile?.date_of_birth ?? '',
    homeCountryCode: profile?.home_country_code ?? '',
    hometownCity: profile?.hometown_city ?? null,
    languages: profile?.languages ?? [],
    residenceCountryCode: profile?.residence_country_code ?? '',
    residenceCity: profile?.residence_city ?? '',
    crewRole: profile?.crew_role ?? undefined,
    airlineId: profile?.airline_id ?? '',
    baseAirportIata: profile?.base_airport_iata ?? '',
  };
}

export function assertProfileComplete(profile: ProfileRow | null): ProfileComplete {
  const result = ProfileCompleteSchema.safeParse(profileRowToInput(profile));
  if (!result.success) {
    throw new OnboardingError(
      422,
      'ONBOARDING_PROFILE_INCOMPLETE',
      'Some profile details are missing',
      zodFields(result.error.issues),
    );
  }
  return result.data;
}

export async function isUsernameTaken(username: string, userId: string): Promise<boolean> {
  const data = await graphqlAsAdmin<{ profiles: { user_id: string }[] }>(
    `query UsernameTaken($username: citext!, $userId: uuid!) {
      profiles(where: { username: { _eq: $username }, user_id: { _neq: $userId } }, limit: 1) { user_id }
    }`,
    { username, userId },
  );
  return data.profiles.length > 0;
}

export async function assertCrewReferences(airlineId: string, baseAirportIata: string) {
  const data = await graphqlAsAdmin<{
    airlines_by_pk: { is_active: boolean } | null;
    airports_by_pk: { is_active: boolean } | null;
  }>(
    `query CrewReferences($airlineId: uuid!, $iata: String!) {
      airlines_by_pk(id: $airlineId) { is_active }
      airports_by_pk(iata: $iata) { is_active }
    }`,
    { airlineId, iata: baseAirportIata },
  );
  const fields: Record<string, string> = {};
  if (!data.airlines_by_pk?.is_active) fields.airlineId = 'Choose your airline';
  if (!data.airports_by_pk?.is_active) fields.baseAirportIata = 'Choose your base airport';
  if (Object.keys(fields).length) {
    throw new OnboardingError(422, 'ONBOARDING_INVALID_STEP', 'Please check the highlighted fields', fields);
  }
}

export async function assertOwnAvatar(fileId: string, userId: string) {
  const data = await graphqlAsAdmin<{ file: { uploadedByUserId: string | null; bucketId: string } | null }>(
    `query AvatarOwner($id: uuid!) { file(id: $id) { uploadedByUserId bucketId } }`,
    { id: fileId },
  );
  if (!data.file || data.file.uploadedByUserId !== userId || data.file.bucketId !== 'avatars') {
    throw new OnboardingError(422, 'ONBOARDING_INVALID_STEP', 'Upload your photo again', { avatarFileId: 'Upload your photo again' });
  }
}

export async function writeStep(userId: string, write: StepWrite) {
  if (write.profile) {
    try {
      await graphqlAsAdmin(
        `mutation UpsertProfile($row: profiles_insert_input!, $columns: [profiles_update_column!]!) {
          insert_profiles_one(
            object: $row
            on_conflict: { constraint: profiles_pkey, update_columns: $columns }
          ) { user_id }
        }`,
        { row: { user_id: userId, ...write.profile }, columns: Object.keys(write.profile) },
      );
    } catch (error) {
      if (error instanceof Error && /profiles_username_unique/.test(error.message)) {
        throw new OnboardingError(409, 'ONBOARDING_USERNAME_TAKEN', 'That username is taken', { username: 'That username is taken' });
      }
      throw error;
    }
  }
  if (write.userPrivate) {
    await graphqlAsAdmin(
      `mutation UpsertUserPrivate($row: user_private_insert_input!, $columns: [user_private_update_column!]!) {
        insert_user_private_one(
          object: $row
          on_conflict: { constraint: user_private_pkey, update_columns: $columns }
        ) { user_id }
      }`,
      { row: { user_id: userId, ...write.userPrivate }, columns: Object.keys(write.userPrivate) },
    );
  }
}

export async function setCurrentStep(userId: string, step: OnboardingStep) {
  await graphqlAsAdmin(
    `mutation SetCurrentStep($userId: uuid!, $step: String!, $flowVersion: Int!) {
      update_onboarding_state_by_pk(
        pk_columns: { user_id: $userId }
        _set: { current_step: $step, flow_version: $flowVersion }
      ) { user_id }
    }`,
    { userId, step, flowVersion: FLOW_VERSION },
  );
}

export function stateResponse(state: OnboardingStateRow) {
  return {
    currentStep: state.current_step,
    flowVersion: state.flow_version,
    betaSignupCompletedAt: state.beta_signup_completed_at,
    onboardingCompletedAt: state.onboarding_completed_at,
  };
}

/** Route-level error mapping shared by the onboarding endpoints. */
export function handleOnboardingFailure(res: Response, error: unknown, label: string) {
  if (error instanceof OnboardingError) return sendOnboardingError(res, error);
  if (error instanceof Error && error.message.includes('Authorization')) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
  }
  if (error instanceof Error && (error.message.includes('User role') || error.message === 'Invalid token')) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: error.message } });
  }
  console.error(`${label} error`, error);
  return res.status(500).json({ error: { code: 'ONBOARDING_FAILED', message: 'Something went wrong. Try again.' } });
}
