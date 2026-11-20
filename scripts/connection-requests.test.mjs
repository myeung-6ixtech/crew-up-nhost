import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeFriendId, formatFriendIdForDisplay } = await import(
  '../functions/_lib/friendId.ts'
);

test('normalizeFriendId accepts dashed display format', () => {
  assert.equal(normalizeFriendId('CREW-8F2K-9M4X'), 'CREW8F2K9M4X');
});

test('normalizeFriendId rejects invalid codes', () => {
  assert.equal(normalizeFriendId('CREW-INVALID'), null);
  assert.equal(normalizeFriendId('ABC123'), null);
});

test('formatFriendIdForDisplay renders grouped code', () => {
  assert.equal(formatFriendIdForDisplay('CREW8F2K9M4X'), 'CREW-8F2K-9M4X');
});

test('normalizeFriendId strips spaces', () => {
  assert.equal(normalizeFriendId('crew 8f2k 9m4x'), 'CREW8F2K9M4X');
});

test('normalizeFriendId finds the code inside a pasted share message', () => {
  assert.equal(
    normalizeFriendId('Add me on CrewUp! My Crew ID is CREW-8F2K-9M4X.'),
    'CREW8F2K9M4X',
  );
});

const { pokeBody, pokeSenderName, POKE_TITLE } = await import('../functions/_lib/pokeNotice.ts');

test('poke notifications name who poked and where', () => {
  assert.equal(POKE_TITLE, 'Poke');
  assert.equal(pokeBody(pokeSenderName({ preferred_name: 'Sam', display_name: 'Samuel Lee' }), { city: 'Tokyo' }), 'Sam poked you · Tokyo layover');
  assert.equal(pokeBody(pokeSenderName({ display_name: 'Gerry Kuo' }), null), 'Gerry poked you');
  assert.equal(pokeBody(pokeSenderName(null), { city: '  ' }), 'A crew member poked you');
});

const { relationshipFrom } = await import('../functions/_lib/relationship.ts');

test('QR Add friend: relationship from the viewer’s side', () => {
  assert.equal(relationshipFrom('me', 'me', null), 'self');
  assert.equal(relationshipFrom('me', 'them', null), 'none');
  assert.equal(relationshipFrom('me', 'them', { status: 'accepted', requester_id: 'them' }), 'friends');
  assert.equal(relationshipFrom('me', 'them', { status: 'pending', requester_id: 'me' }), 'pending_sent');
  assert.equal(relationshipFrom('me', 'them', { status: 'pending', requester_id: 'them' }), 'pending_received');
  assert.equal(relationshipFrom('me', 'them', { status: 'declined', requester_id: 'them' }), 'none');
});

const { cleanUsernameQuery, containsPattern, createRateLimiter } = await import('../functions/_lib/crewSearch.ts');

test('crew search: a leading @ and case are dropped; LIKE wildcards match literally', () => {
  assert.equal(cleanUsernameQuery('  @Sam_K '), 'sam_k');
  assert.equal(cleanUsernameQuery('@@muser yeung'), 'muser yeung');
  assert.equal(cleanUsernameQuery('50%'), '50');
  assert.equal(containsPattern('sam_k'), '%sam\\_k%');
  assert.equal(cleanUsernameQuery(42), '');
});

test('crew search is rate limited per user', () => {
  const allow = createRateLimiter(2, 1000);
  assert.equal(allow('a', 0), true);
  assert.equal(allow('a', 10), true);
  assert.equal(allow('a', 20), false);
  assert.equal(allow('b', 20), true);
  assert.equal(allow('a', 1500), true);
});
