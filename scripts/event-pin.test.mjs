import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NHOST_ADMIN_SECRET = 'test-admin-secret';
process.env.NHOST_GRAPHQL_URL = 'http://graphql.test/v1';

const lib = await import('../functions/_lib/eventPin.ts');
const { default: unlockHandler } = await import('../functions/client/events/unlock.ts');
const { default: rotateHandler } = await import('../functions/client/events/rotate-pin.ts');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const HOST_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';

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
  const res = { statusCode: 0, body: undefined };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  return res;
}

/** Routes GraphQL operations by name; records each call and whether it ran with the admin secret. */
function mockGraphql(handlers) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    calls.push({ name, variables, admin: Boolean(init.headers['x-hasura-admin-secret']) });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected GraphQL operation ${name}`);
    const result = handler(variables);
    if (result instanceof Error) {
      return new Response(JSON.stringify({ errors: [{ message: result.message }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: result }), { status: 200 });
  };
  return calls;
}

const privateListing = { id: EVENT_ID, visibility_scope: 'friends', creator_id: HOST_ID };

function unlockRequest(pin, userId = USER_ID) {
  return { method: 'POST', headers: { authorization: tokenFor(userId) }, body: { eventId: EVENT_ID, pin } };
}

function unlockState({ attempts = [], unlocked = false, pin = 'K7PQ4X' } = {}) {
  return () => ({
    event_access_codes_by_pk: pin ? { pin } : null,
    event_unlocks_by_pk: unlocked ? { user_id: USER_ID } : null,
    event_pin_attempts: attempts.map((attempted_at) => ({ attempted_at })),
  });
}

test('normalizePin accepts any case, dashes and spaces; rejects confusable or short input', () => {
  assert.equal(lib.normalizePin('k7p-q4x'), 'K7PQ4X');
  assert.equal(lib.normalizePin(' K7P Q4X '), 'K7PQ4X');
  assert.equal(lib.normalizePin('K7PQ4'), null);
  assert.equal(lib.normalizePin('K7PQ40'), null, '0 is not in the alphabet');
  assert.equal(lib.normalizePin('K7PQ4I'), null, 'I is not in the alphabet');
  assert.equal(lib.normalizePin(123456), null);
});

test('generatePin only uses the PIN alphabet', () => {
  for (let i = 0; i < 200; i += 1) {
    const pin = lib.generatePin();
    assert.equal(lib.normalizePin(pin), pin);
  }
});

test('lockoutSeconds waits for the oldest of the last 5 failures to age out', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const minutesAgo = (m) => new Date(now - m * 60_000).toISOString();
  assert.equal(lib.lockoutSeconds([1, 2, 3, 4].map(minutesAgo), now), 0);
  assert.equal(lib.lockoutSeconds([10, 4, 3, 2, 1].map(minutesAgo), now), 5 * 60);
  assert.equal(lib.lockoutSeconds([20, 4, 3, 2, 1].map(minutesAgo), now), 0, 'failures older than 15 min do not count');
});

test('unlock: correct PIN in any format records the unlock and clears attempts', async () => {
  const calls = mockGraphql({
    UnlockTarget: () => ({ event_listings: [privateListing] }),
    UnlockState: unlockState({ attempts: [new Date().toISOString()] }),
    UnlockEvent: () => ({ insert_event_unlocks_one: { event_id: EVENT_ID }, delete_event_pin_attempts: { affected_rows: 1 } }),
  });
  const res = mockRes();
  await unlockHandler(unlockRequest('k7p-q4x'), res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { unlocked: true });
  assert.deepEqual(calls.map((c) => c.name), ['UnlockTarget', 'UnlockState', 'UnlockEvent']);
  assert.equal(calls[0].admin, false, 'the caller is read as themselves so Hasura verifies the token');
  assert.deepEqual(calls[2].variables.row, { event_id: EVENT_ID, user_id: USER_ID });
});

test('unlock: wrong PIN records an attempt and reports attempts left', async () => {
  const calls = mockGraphql({
    UnlockTarget: () => ({ event_listings: [privateListing] }),
    UnlockState: unlockState({ attempts: [new Date().toISOString()] }),
    RecordPinAttempt: () => ({ insert_event_pin_attempts_one: { id: 'a' } }),
  });
  const res = mockRes();
  await unlockHandler(unlockRequest('AAAAAA'), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'EVENT_PIN_INVALID');
  assert.equal(res.body.error.attemptsLeft, 3);
  assert.ok(calls.some((c) => c.name === 'RecordPinAttempt'));
  assert.ok(!calls.some((c) => c.name === 'UnlockEvent'));
});

test('unlock: malformed PIN still counts as a wrong attempt', async () => {
  const calls = mockGraphql({
    UnlockTarget: () => ({ event_listings: [privateListing] }),
    UnlockState: unlockState(),
    RecordPinAttempt: () => ({ insert_event_pin_attempts_one: { id: 'a' } }),
  });
  const res = mockRes();
  await unlockHandler(unlockRequest('nope'), res);
  assert.equal(res.statusCode, 403);
  assert.ok(calls.some((c) => c.name === 'RecordPinAttempt'));
});

test('unlock: 5 recent failures locks out even the correct PIN', async () => {
  const recent = Array.from({ length: 5 }, () => new Date().toISOString());
  const calls = mockGraphql({
    UnlockTarget: () => ({ event_listings: [privateListing] }),
    UnlockState: unlockState({ attempts: recent }),
  });
  const res = mockRes();
  await unlockHandler(unlockRequest('K7PQ4X'), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error.code, 'EVENT_PIN_LOCKED');
  assert.ok(res.body.error.retryAfterSeconds > 0);
  assert.ok(!calls.some((c) => c.name === 'UnlockEvent'));
});

test('unlock: public meets, the host and already-unlocked guests pass without a PIN check', async () => {
  mockGraphql({ UnlockTarget: () => ({ event_listings: [{ ...privateListing, visibility_scope: 'all_verified' }] }) });
  let res = mockRes();
  await unlockHandler(unlockRequest(''), res);
  assert.equal(res.statusCode, 200);

  mockGraphql({ UnlockTarget: () => ({ event_listings: [privateListing] }) });
  res = mockRes();
  await unlockHandler(unlockRequest('', HOST_ID), res);
  assert.equal(res.statusCode, 200);

  mockGraphql({
    UnlockTarget: () => ({ event_listings: [privateListing] }),
    UnlockState: unlockState({ unlocked: true }),
  });
  res = mockRes();
  await unlockHandler(unlockRequest(''), res);
  assert.equal(res.statusCode, 200);
});

test('unlock: hidden meet is 404, rejected token is 401, missing event id is 400', async () => {
  mockGraphql({ UnlockTarget: () => ({ event_listings: [] }) });
  let res = mockRes();
  await unlockHandler(unlockRequest('K7PQ4X'), res);
  assert.equal(res.statusCode, 404);

  mockGraphql({ UnlockTarget: () => new Error('Could not verify JWT: JWSError') });
  res = mockRes();
  await unlockHandler(unlockRequest('K7PQ4X'), res);
  assert.equal(res.statusCode, 401);

  res = mockRes();
  await unlockHandler({ method: 'POST', headers: { authorization: tokenFor(USER_ID) }, body: { pin: 'K7PQ4X' } }, res);
  assert.equal(res.statusCode, 400);

  res = mockRes();
  await unlockHandler({ method: 'POST', headers: {}, body: { eventId: EVENT_ID, pin: 'K7PQ4X' } }, res);
  assert.equal(res.statusCode, 401);
});

test('rotate-pin: host gets a new PIN; non-host is refused before any write', async () => {
  const calls = mockGraphql({
    OwnEventPin: () => ({ event_access_codes_by_pk: { event_id: EVENT_ID } }),
    RotateEventPin: (vars) => ({ update_event_access_codes_by_pk: { pin: vars.pin, rotated_at: vars.now } }),
  });
  let res = mockRes();
  await rotateHandler({ method: 'POST', headers: { authorization: tokenFor(HOST_ID) }, body: { eventId: EVENT_ID } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(lib.normalizePin(res.body.pin), res.body.pin);
  assert.equal(calls[0].admin, false);

  const denied = mockGraphql({ OwnEventPin: () => ({ event_access_codes_by_pk: null }) });
  res = mockRes();
  await rotateHandler({ method: 'POST', headers: { authorization: tokenFor(USER_ID) }, body: { eventId: EVENT_ID } }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(denied.map((c) => c.name), ['OwnEventPin']);
});
