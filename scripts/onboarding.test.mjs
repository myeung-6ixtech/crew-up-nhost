import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NHOST_ADMIN_SECRET = 'test-admin-secret';
process.env.NHOST_GRAPHQL_URL = 'http://graphql.test/v1';

const shared = await import('../functions/_shared/index.ts');
const lib = await import('../functions/_lib/onboarding.ts');
const { getAppMode } = await import('../functions/_lib/appMode.ts');
const { default: completeHandler } = await import('../functions/client/onboarding/complete.ts');
const { default: stepHandler } = await import('../functions/client/onboarding/step.ts');
const { default: betaCompleteHandler } = await import('../functions/client/onboarding/beta-complete.ts');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const AIRLINE_ID = '22222222-2222-4222-8222-222222222222';

function tokenFor(userId) {
  const payload = {
    'https://hasura.io/jwt/claims': {
      'x-hasura-user-id': userId,
      'x-hasura-default-role': 'user',
      'x-hasura-allowed-roles': ['user', 'me'],
    },
  };
  return `Bearer h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
}

function mockRes() {
  const res = { statusCode: 0, body: undefined, headers: {} };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  res.set = (key, value) => ((res.headers[key] = value), res);
  return res;
}

/** Routes GraphQL operations by name to handlers; records every call. */
function mockGraphql(handlers) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    calls.push({ name, variables });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected GraphQL operation ${name}`);
    return new Response(JSON.stringify({ data: handler(variables) }), { status: 200 });
  };
  return calls;
}

const completeProfile = {
  user_id: USER_ID,
  full_name: 'Budi',
  full_name_native: null,
  preferred_name: null,
  username: 'budi.crew',
  date_of_birth: '1995-04-02',
  home_country_code: 'ID',
  hometown_city: null,
  languages: ['id', 'en'],
  residence_country_code: 'HK',
  residence_city: 'Hong Kong',
  crew_role: 'cabin_crew',
  airline_id: AIRLINE_ID,
  base_airport_iata: 'HKG',
  avatar_file_id: null,
};

const baseState = {
  user_id: USER_ID,
  current_step: 'launch_notifications',
  flow_version: 1,
  beta_signup_completed_at: null,
  onboarding_completed_at: null,
  guidelines_accepted_version: null,
  guidelines_accepted_at: null,
};

test('full name accepts mononyms and non-Latin scripts, collapses whitespace', () => {
  const ok = (fullName) => shared.NameHandleSchema.parse({ fullName, username: 'crew.one' }).fullName;
  assert.equal(ok('Budi'), 'Budi');
  assert.equal(ok('陳大文'), '陳大文');
  assert.equal(ok("  Siobhán   O'Neil-Smith "), "Siobhán O'Neil-Smith");
  assert.equal(shared.NameHandleSchema.safeParse({ fullName: 'A', username: 'crew.one' }).success, false);
  assert.equal(shared.NameHandleSchema.safeParse({ fullName: 'R2D2', username: 'crew.one' }).success, false);
});

test('username is normalised lowercase and enforces format + reserved list', () => {
  assert.equal(shared.UsernameSchema.parse(' Alice_W '), 'alice_w');
  for (const bad of ['ab', '1abc', 'a__b', 'a._b', 'admin', 'crewup_team', 'cathay.pacific', 'x'.repeat(21)]) {
    assert.equal(shared.UsernameSchema.safeParse(bad).success, false, bad);
  }
});

test('date of birth must be a real date and 18+', () => {
  const today = new Date();
  const iso = (years, days = 0) => {
    const d = new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate() + days));
    return d.toISOString().slice(0, 10);
  };
  assert.equal(shared.DateOfBirthSchema.safeParse(iso(18)).success, true);
  assert.equal(shared.DateOfBirthSchema.safeParse(iso(18, 1)).success, false);
  assert.equal(shared.DateOfBirthSchema.safeParse('1990-02-30').success, false);
});

test('residence is city level and phone is E.164', () => {
  assert.equal(shared.ResidenceSchema.safeParse({ residenceCountryCode: 'hk', residenceCity: 'Hong Kong' }).data.residenceCountryCode, 'HK');
  assert.equal(shared.ResidenceSchema.safeParse({ residenceCountryCode: 'HK', residenceCity: '12 Nathan Road' }).success, false);
  assert.equal(shared.PhoneSchema.safeParse({ phoneE164: '+85291234567' }).success, true);
  assert.equal(shared.PhoneSchema.safeParse({ phoneE164: '91234567' }).success, false);
  assert.equal(shared.PhoneSchema.safeParse({}).success, true);
});

test('step writes keep legacy columns in sync', () => {
  assert.deepEqual(
    lib.columnsForStep('name_handle', { fullName: 'Chan Tai Man', fullNameNative: '陳大文', preferredName: null, username: 'taiman' }).profile,
    { full_name: 'Chan Tai Man', full_name_native: '陳大文', preferred_name: null, username: 'taiman', display_name: 'Chan Tai Man' },
  );
  assert.equal(
    lib.columnsForStep('name_handle', { fullName: 'Chan Tai Man', fullNameNative: null, preferredName: 'Man', username: 'taiman' }).profile.display_name,
    'Man',
  );
  const crew = lib.columnsForStep('crew', { crewRole: 'other', airlineId: AIRLINE_ID, baseAirportIata: 'HKG' }).profile;
  assert.equal(crew.role_type, null);
  assert.equal(crew.base_airport, 'HKG');
  const phone = lib.columnsForStep('phone', { phoneE164: '+85291234567' });
  assert.equal(phone.profile, null);
  assert.deepEqual(phone.userPrivate, { phone_e164: '+85291234567' });
  assert.deepEqual(lib.columnsForStep('phone', {}), { profile: null, userPrivate: null });
  assert.deepEqual(lib.columnsForStep('phone', { phoneE164: null }).userPrivate, { phone_e164: null });
});

test('mode rules: steps, advancing, and the single mode reader', () => {
  assert.throws(() => lib.assertStepAllowed('beta', 'launch_guidelines'), { code: 'ONBOARDING_WRONG_MODE' });
  assert.throws(() => lib.assertStepAllowed('launched', 'beta_notify'), { code: 'ONBOARDING_WRONG_MODE' });
  assert.equal(lib.advancedStep('launched', 'review'), 'launch_privacy');
  assert.equal(lib.advancedStep('beta', 'beta_notify'), 'beta_notify');

  const previous = process.env.CREWUP_APP_MODE;
  delete process.env.CREWUP_APP_MODE;
  assert.equal(getAppMode(), 'beta');
  process.env.CREWUP_APP_MODE = 'launched';
  assert.equal(getAppMode(), 'launched');
  process.env.CREWUP_APP_MODE = 'LAUNCHED!';
  assert.throws(() => getAppMode());
  process.env.CREWUP_APP_MODE = previous ?? '';
});

test('profile completeness reports missing fields', () => {
  assert.throws(() => lib.assertProfileComplete({ ...completeProfile, residence_city: null }), (error) => {
    assert.equal(error.code, 'ONBOARDING_PROFILE_INCOMPLETE');
    assert.ok(error.fields.residenceCity);
    return true;
  });
  assert.equal(lib.assertProfileComplete(completeProfile).username, 'budi.crew');
});

test('complete is idempotent: an already-completed user gets the same timestamp and no writes', async () => {
  process.env.CREWUP_APP_MODE = 'beta';
  const done = { ...baseState, onboarding_completed_at: '2026-09-01T00:00:00+00:00' };
  const calls = mockGraphql({ EnsureOnboardingState: () => ({ insert_onboarding_state_one: null }), LoadOnboarding: () => ({ profiles_by_pk: completeProfile, onboarding_state_by_pk: done }) });
  const res = mockRes();
  await completeHandler({ method: 'POST', headers: { authorization: tokenFor(USER_ID) }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.state.onboardingCompletedAt, '2026-09-01T00:00:00+00:00');
  assert.ok(!calls.some((call) => call.name === 'CompleteOnboarding'));
});

test('complete rejects beta mode and outdated guidelines, then completes once in launched mode', async () => {
  let state = { ...baseState };
  const handlers = {
    EnsureOnboardingState: () => ({ insert_onboarding_state_one: null }),
    LoadOnboarding: () => ({ profiles_by_pk: completeProfile, onboarding_state_by_pk: state }),
    CompleteOnboarding: (variables) => {
      const affected = state.onboarding_completed_at ? 0 : 1;
      state = { ...state, onboarding_completed_at: '2026-09-24T00:00:00+00:00', guidelines_accepted_version: variables.version, current_step: null };
      return { update_onboarding_state: { affected_rows: affected } };
    },
  };
  mockGraphql(handlers);
  const req = (body) => ({ method: 'POST', headers: { authorization: tokenFor(USER_ID) }, body });

  process.env.CREWUP_APP_MODE = 'beta';
  let res = mockRes();
  await completeHandler(req({ guidelinesVersion: shared.GUIDELINES_VERSION }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'ONBOARDING_WRONG_MODE');

  process.env.CREWUP_APP_MODE = 'launched';
  res = mockRes();
  await completeHandler(req({ guidelinesVersion: 'old' }), res);
  assert.equal(res.body.error.code, 'ONBOARDING_GUIDELINES_OUTDATED');

  state = { ...state, current_step: 'launch_privacy' };
  res = mockRes();
  await completeHandler(req({ guidelinesVersion: shared.GUIDELINES_VERSION }), res);
  assert.equal(res.body.error.code, 'ONBOARDING_GUIDELINES_REQUIRED');
  state = { ...state, current_step: 'launch_notifications' };

  res = mockRes();
  await completeHandler(req({ guidelinesVersion: shared.GUIDELINES_VERSION }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.state.onboardingCompletedAt, '2026-09-24T00:00:00+00:00');

  res = mockRes();
  await completeHandler(req({ guidelinesVersion: shared.GUIDELINES_VERSION }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.state.onboardingCompletedAt, '2026-09-24T00:00:00+00:00');
});

test('beta-complete never sets onboarding_completed_at and is rejected after launch', async () => {
  let state = { ...baseState, current_step: 'review' };
  const calls = mockGraphql({
    EnsureOnboardingState: () => ({ insert_onboarding_state_one: state }),
    LoadOnboarding: () => ({ profiles_by_pk: completeProfile, onboarding_state_by_pk: state }),
    BetaComplete: () => {
      state = { ...state, beta_signup_completed_at: '2026-09-24T00:00:00+00:00', current_step: 'beta_notify' };
      return { update_onboarding_state: { returning: [{ beta_signup_completed_at: state.beta_signup_completed_at }] } };
    },
  });
  const req = { method: 'POST', headers: { authorization: tokenFor(USER_ID) }, body: {} };

  process.env.CREWUP_APP_MODE = 'beta';
  let res = mockRes();
  await betaCompleteHandler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.state.betaSignupCompletedAt, '2026-09-24T00:00:00+00:00');
  assert.equal(res.body.state.onboardingCompletedAt, null);
  assert.ok(!calls.some((call) => call.name === 'CompleteOnboarding'));

  process.env.CREWUP_APP_MODE = 'launched';
  res = mockRes();
  await betaCompleteHandler(req, res);
  assert.equal(res.body.error.code, 'ONBOARDING_WRONG_MODE');
});

test('step saves validate, sync legacy columns, and advance current_step', async () => {
  process.env.CREWUP_APP_MODE = 'launched';
  const calls = mockGraphql({
    EnsureOnboardingState: () => ({ insert_onboarding_state_one: { ...baseState, current_step: 'crew' } }),
    CrewReferences: () => ({ airlines_by_pk: { is_active: true }, airports_by_pk: { is_active: true } }),
    UpsertProfile: () => ({ insert_profiles_one: { user_id: USER_ID } }),
    SetCurrentStep: () => ({ update_onboarding_state_by_pk: { user_id: USER_ID } }),
  });
  const res = mockRes();
  await stepHandler(
    {
      method: 'PUT',
      headers: { authorization: tokenFor(USER_ID) },
      body: { step: 'crew', data: { crewRole: 'pilot', airlineId: AIRLINE_ID, baseAirportIata: 'hkg' } },
    },
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.state.currentStep, 'phone');
  const upsert = calls.find((call) => call.name === 'UpsertProfile');
  assert.equal(upsert.variables.row.base_airport_iata, 'HKG');
  assert.equal(upsert.variables.row.role_type, 'pilot');
  assert.ok(calls.some((call) => call.name === 'SetCurrentStep' && call.variables.step === 'phone'));
});

test('step save for a completed user (Edit profile) never touches onboarding_state', async () => {
  process.env.CREWUP_APP_MODE = 'launched';
  const calls = mockGraphql({
    EnsureOnboardingState: () => ({ insert_onboarding_state_one: { ...baseState, current_step: null, onboarding_completed_at: '2026-09-01T00:00:00+00:00' } }),
    UpsertProfile: () => ({ insert_profiles_one: { user_id: USER_ID } }),
  });
  const res = mockRes();
  await stepHandler(
    { method: 'PUT', headers: { authorization: tokenFor(USER_ID) }, body: { step: 'residence', data: { residenceCountryCode: 'SG', residenceCity: 'Singapore' } } },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(!calls.some((call) => call.name === 'SetCurrentStep'));
});

test('invalid step data returns field errors', async () => {
  process.env.CREWUP_APP_MODE = 'launched';
  mockGraphql({ EnsureOnboardingState: () => ({ insert_onboarding_state_one: baseState }) });
  const res = mockRes();
  await stepHandler(
    { method: 'PUT', headers: { authorization: tokenFor(USER_ID) }, body: { step: 'about', data: { dateOfBirth: '2020-01-01', homeCountryCode: 'ZZ', languages: [] } } },
    res,
  );
  assert.equal(res.statusCode, 422);
  assert.ok(res.body.error.fields.dateOfBirth);
  assert.ok(res.body.error.fields.homeCountryCode);
  assert.ok(res.body.error.fields.languages);
});
