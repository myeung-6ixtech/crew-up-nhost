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
