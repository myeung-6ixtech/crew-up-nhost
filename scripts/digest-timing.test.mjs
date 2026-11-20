import test from 'node:test';
import assert from 'node:assert/strict';

const { digestDue, digestZone, digestSince, digestBody, localHour } = await import('../functions/_lib/digestTiming.ts');

test('the digest goes out at 8 AM in each person’s own zone', () => {
  const now = new Date('2026-11-21T00:30:00Z'); // 08:30 in Hong Kong, 19:30 the day before in New York
  assert.equal(localHour(now, 'Asia/Hong_Kong'), 8);
  assert.equal(digestDue(now, 'Asia/Hong_Kong', null), true);
  assert.equal(digestDue(now, 'America/New_York', null), false);
  assert.equal(digestDue(new Date('2026-11-21T13:10:00Z'), 'America/New_York', null), true);
});

test('at most one digest a day, even if the hourly job runs twice', () => {
  const now = new Date('2026-11-21T00:30:00Z');
  assert.equal(digestDue(now, 'Asia/Hong_Kong', '2026-11-21T00:05:00Z'), false);
  assert.equal(digestDue(now, 'Asia/Hong_Kong', '2026-11-20T00:05:00Z'), true);
});

test('zone: the device first, then the base airport, then UTC', () => {
  assert.equal(digestZone('Europe/London', 'Asia/Hong_Kong'), 'Europe/London');
  assert.equal(digestZone(null, 'Asia/Hong_Kong'), 'Asia/Hong_Kong');
  assert.equal(digestZone('Not/AZone', null), 'UTC');
});

test('only what is new since the last digest counts', () => {
  const now = new Date('2026-11-21T00:30:00Z');
  assert.equal(digestSince(now, '2026-11-20T00:05:00Z'), '2026-11-20T00:05:00.000Z');
  assert.equal(digestSince(now, null), '2026-11-20T00:30:00.000Z');
  assert.equal(digestBody(1), 'You have 1 new notification');
  assert.equal(digestBody(35), 'You have 35 new notifications');
});
