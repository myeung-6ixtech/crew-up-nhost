import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NHOST_ADMIN_SECRET = 'test-admin-secret';
process.env.NHOST_GRAPHQL_URL = 'http://graphql.test/v1';
process.env.NHOST_AUTH_URL = 'http://auth.test/v1';
process.env.NHOST_STORAGE_URL = 'http://storage.test/v1';
process.env.NHOST_WEBHOOK_SECRET = 'hook-secret';

const lib = await import('../functions/_lib/accountDeletion.ts');
const { default: deleteHandler } = await import('../functions/client/account/delete.ts');
const { default: restoreHandler } = await import('../functions/client/account/restore.ts');
const { default: purgeHandler } = await import('../functions/internal/account-deletion-purge.ts');

const USER_ID = '11111111-1111-4111-8111-111111111111';

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

/**
 * GraphQL operations route by name; other URLs (auth sign-in, storage delete) go to `http`.
 * Records each call with whether it ran as Hasura admin.
 */
function mockBackend(handlers, http = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!href.startsWith('http://graphql.test')) {
      calls.push({ name: `${init.method ?? 'GET'} ${href}` });
      const handler = Object.entries(http).find(([prefix]) => href.startsWith(prefix))?.[1];
      if (!handler) throw new Error(`unexpected request ${href}`);
      return handler(init);
    }
    const { query, variables } = JSON.parse(init.body);
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    calls.push({ name, variables, role: init.headers['x-hasura-role'], admin: Boolean(init.headers['x-hasura-admin-secret']) });
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected GraphQL operation ${name}`);
    return new Response(JSON.stringify({ data: handler(variables) }), { status: 200 });
  };
  return calls;
}

const verifyCaller = () => ({ user: { id: USER_ID } });

function target({ passwordHash = 'hash', pending = null } = {}) {
  return () => ({
    user: { email: 'budi@example.com', passwordHash },
    profiles_by_pk: { default_visibility: 'all_verified' },
    account_deletions_by_pk: pending,
  });
}

function deleteRequest(body, method = 'POST') {
  return { method, headers: { authorization: tokenFor(USER_ID) }, body };
}

test('purgeAfter is 30 days out', () => {
  const from = new Date('2026-10-17T00:00:00Z');
  assert.equal(lib.purgeAfter(from), '2026-11-16T00:00:00.000Z');
});

test('GET reports whether a password is needed and any pending deletion', async () => {
  mockBackend({ VerifyCaller: verifyCaller, DeletionTarget: target({ passwordHash: null }) });
  const res = mockRes();
  await deleteHandler(deleteRequest(undefined, 'GET'), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { requiresPassword: false, graceDays: 30, pending: null });
});

test('POST with the right password schedules deletion, hides the person and signs them out', async () => {
  const calls = mockBackend(
    {
      VerifyCaller: verifyCaller,
      DeletionTarget: target(),
      ScheduleAccountDeletion: () => ({ insert_account_deletions_one: { user_id: USER_ID } }),
    },
    { 'http://auth.test/v1/signin/email-password': () => new Response('{}', { status: 200 }) },
  );
  const res = mockRes();
  await deleteHandler(deleteRequest({ confirm: 'DELETE', password: 'correct horse' }), res);
  assert.equal(res.statusCode, 200);
  const schedule = calls.find((c) => c.name === 'ScheduleAccountDeletion');
  assert.equal(schedule.role, 'admin');
  assert.equal(schedule.variables.row.previous_visibility, 'all_verified');
  assert.equal(res.body.purgeAfter, schedule.variables.row.purge_after);
  assert.equal(calls[0].admin, false, 'the token is checked by reading as the caller');
});

test('POST rejects a wrong password, a missing password and a missing confirm word', async () => {
  mockBackend(
    { VerifyCaller: verifyCaller, DeletionTarget: target() },
    { 'http://auth.test/v1/signin/email-password': () => new Response('{}', { status: 401 }) },
  );
  let res = mockRes();
  await deleteHandler(deleteRequest({ confirm: 'DELETE', password: 'nope' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'ACCOUNT_DELETE_BAD_PASSWORD');

  res = mockRes();
  await deleteHandler(deleteRequest({ confirm: 'DELETE' }), res);
  assert.equal(res.body.error.code, 'ACCOUNT_DELETE_PASSWORD_REQUIRED');

  res = mockRes();
  await deleteHandler(deleteRequest({ confirm: 'delete', password: 'x' }), res);
  assert.equal(res.body.error.code, 'ACCOUNT_DELETE_CONFIRM_REQUIRED');
});

test('OAuth-only accounts confirm with the word alone; a repeat request keeps the original date and visibility', async () => {
  const pending = {
    user_id: USER_ID,
    purge_after: '2026-11-01T00:00:00.000Z',
    cancelled_at: null,
    purged_at: null,
    previous_visibility: 'friends',
  };
  const calls = mockBackend({
    VerifyCaller: verifyCaller,
    DeletionTarget: target({ passwordHash: null, pending }),
    ScheduleAccountDeletion: () => ({}),
  });
  const res = mockRes();
  await deleteHandler(deleteRequest({ confirm: 'DELETE' }), res);
  assert.equal(res.statusCode, 200);
  const row = calls.find((c) => c.name === 'ScheduleAccountDeletion').variables.row;
  assert.equal(row.purge_after, pending.purge_after);
  assert.equal(row.previous_visibility, 'friends');
});

test('restore inside the grace period puts visibility back', async () => {
  const calls = mockBackend({
    OwnDeletion: () => ({
      account_deletions_by_pk: { purge_after: new Date(Date.now() + 86_400_000).toISOString(), cancelled_at: null, purged_at: null },
    }),
    DeletionVisibility: () => ({ account_deletions_by_pk: { previous_visibility: 'same_airline' } }),
    RestoreAccount: () => ({}),
  });
  const res = mockRes();
  await restoreHandler({ method: 'POST', headers: { authorization: tokenFor(USER_ID) } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.find((c) => c.name === 'RestoreAccount').variables.visibility, 'same_airline');
});

test('restore after the grace period is 410; with nothing pending it is 404', async () => {
  mockBackend({
    OwnDeletion: () => ({
      account_deletions_by_pk: { purge_after: new Date(Date.now() - 1000).toISOString(), cancelled_at: null, purged_at: null },
    }),
  });
  let res = mockRes();
  await restoreHandler({ method: 'POST', headers: { authorization: tokenFor(USER_ID) } }, res);
  assert.equal(res.statusCode, 410);

  mockBackend({ OwnDeletion: () => ({ account_deletions_by_pk: null }) });
  res = mockRes();
  await restoreHandler({ method: 'POST', headers: { authorization: tokenFor(USER_ID) } }, res);
  assert.equal(res.statusCode, 404);
});

test('purge deletes uploads, removes messages, deletes the auth user and records it', async () => {
  const calls = mockBackend(
    {
      DueDeletions: () => ({ account_deletions: [{ user_id: USER_ID }] }),
      PurgeFiles: () => ({ files: [{ id: 'f1' }, { id: 'f2' }] }),
      PurgeAccount: () => ({}),
      StaleRosterFiles: () => ({ files: [{ id: 'r1' }] }),
    },
    { 'http://storage.test/v1/files/': () => new Response(null, { status: 204 }) },
  );
  const res = mockRes();
  await purgeHandler({ method: 'POST', headers: { 'nhost-webhook-secret': 'hook-secret' }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { due: 1, purged: 1, failed: 0, rosterFilesDeleted: 1 });
  assert.equal(calls.filter((c) => c.name.startsWith('DELETE http://storage.test')).length, 3);
  assert.ok(calls.find((c) => c.name === 'StaleRosterFiles').variables.cutoff);
  assert.equal(calls.find((c) => c.name === 'PurgeAccount').variables.id, USER_ID);
});

test('purge without the webhook secret is refused', async () => {
  mockBackend({});
  const res = mockRes();
  await purgeHandler({ method: 'POST', headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 401);
});
