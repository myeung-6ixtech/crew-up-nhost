import type { Request, Response } from 'express';
import { requireUser } from '../../_lib/auth.js';
import {
  ATTEMPT_WINDOW_MS,
  EventPinError,
  MAX_FAILED_ATTEMPTS,
  UUID_PATTERN,
  lockoutSeconds,
  normalizePin,
  pinsMatch,
  sendEventPinError,
} from '../../_lib/eventPin.js';
import { graphqlAsUser, graphqlRaw } from '../../_lib/graphql.js';

type ListingRow = { id: string; visibility_scope: string; creator_id: string };

/**
 * Reads the meet as the caller, which also makes Hasura verify the token
 * (requireUser only decodes it). Onboarding is part of event_listings' filter.
 */
async function loadListing(authorization: string, eventId: string): Promise<ListingRow> {
  let rows: ListingRow[];
  try {
    const data = await graphqlAsUser<{ event_listings: ListingRow[] }>(
      `query UnlockTarget($id: uuid!) {
        event_listings(where: { id: { _eq: $id } }, limit: 1) { id visibility_scope creator_id }
      }`,
      authorization,
      { id: eventId },
    );
    rows = data.event_listings;
  } catch {
    throw new EventPinError(401, 'UNAUTHORIZED', 'Sign in again to open this meet');
  }
  if (!rows[0]) throw new EventPinError(404, 'EVENT_NOT_FOUND', 'This meet is no longer available');
  return rows[0];
}

/**
 * POST /v1/client/events/unlock  { eventId, pin }
 * One correct PIN lets the caller see the full private meet, RSVP and join its chat.
 * 5 wrong PINs per meet in 15 minutes locks that person out until the oldest one ages out.
 */
export default async function unlockEvent(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization, userId } = requireUser(req);
    const eventId = typeof req.body?.eventId === 'string' ? req.body.eventId : '';
    if (!UUID_PATTERN.test(eventId)) {
      throw new EventPinError(400, 'EVENT_PIN_BAD_REQUEST', 'Missing meet');
    }
    const entered = normalizePin(req.body?.pin);

    const listing = await loadListing(authorization, eventId);
    if (listing.visibility_scope !== 'friends' || listing.creator_id === userId) {
      return res.status(200).json({ unlocked: true });
    }

    const since = new Date(Date.now() - ATTEMPT_WINDOW_MS).toISOString();
    const lookup = await graphqlRaw<{
      event_access_codes_by_pk: { pin: string } | null;
      event_unlocks_by_pk: { user_id: string } | null;
      event_pin_attempts: { attempted_at: string }[];
    }>(
      `query UnlockState($eventId: uuid!, $userId: uuid!, $since: timestamptz!) {
        event_access_codes_by_pk(event_id: $eventId) { pin }
        event_unlocks_by_pk(event_id: $eventId, user_id: $userId) { user_id }
        event_pin_attempts(
          where: { event_id: { _eq: $eventId }, user_id: { _eq: $userId }, attempted_at: { _gte: $since } }
        ) { attempted_at }
      }`,
      { eventId, userId, since },
    );
    if (lookup.event_unlocks_by_pk) return res.status(200).json({ unlocked: true });

    const failedAt = lookup.event_pin_attempts.map((row) => row.attempted_at);
    const wait = lockoutSeconds(failedAt);
    if (wait > 0) {
      throw new EventPinError(429, 'EVENT_PIN_LOCKED', 'Too many wrong PINs. Try again later.', { retryAfterSeconds: wait });
    }

    const stored = lookup.event_access_codes_by_pk?.pin;
    if (!stored) throw new EventPinError(404, 'EVENT_NOT_FOUND', 'This meet is no longer available');

    if (!entered || !pinsMatch(entered, stored)) {
      await graphqlRaw(
        `mutation RecordPinAttempt($row: event_pin_attempts_insert_input!) {
          insert_event_pin_attempts_one(object: $row) { id }
        }`,
        { row: { event_id: eventId, user_id: userId } },
      );
      const attemptsLeft = Math.max(0, MAX_FAILED_ATTEMPTS - failedAt.length - 1);
      throw new EventPinError(403, 'EVENT_PIN_INVALID', "That PIN doesn't match. Check it with the host.", { attemptsLeft });
    }

    await graphqlRaw(
      `mutation UnlockEvent($row: event_unlocks_insert_input!, $eventId: uuid!, $userId: uuid!) {
        insert_event_unlocks_one(
          object: $row
          on_conflict: { constraint: event_unlocks_pkey, update_columns: [] }
        ) { event_id }
        delete_event_pin_attempts(where: { event_id: { _eq: $eventId }, user_id: { _eq: $userId } }) { affected_rows }
      }`,
      { row: { event_id: eventId, user_id: userId }, eventId, userId },
    );
    return res.status(201).json({ unlocked: true });
  } catch (error) {
    if (error instanceof EventPinError) return sendEventPinError(res, error);
    if (error instanceof Error && (error.message.includes('Authorization') || error.message === 'Invalid token')) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    }
    if (error instanceof Error && error.message.includes('User role')) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: error.message } });
    }
    console.error('client/events/unlock error', error);
    return res.status(500).json({ error: { code: 'EVENT_UNLOCK_FAILED', message: 'Something went wrong. Try again.' } });
  }
}
