import type { Request, Response } from 'express';
import { requireUser } from '../../_lib/auth.js';
import { EventPinError, UUID_PATTERN, generatePin, sendEventPinError } from '../../_lib/eventPin.js';
import { graphqlAsUser, graphqlRaw } from '../../_lib/graphql.js';

/**
 * POST /v1/client/events/rotate-pin  { eventId } — host only.
 * New guests need the new PIN; anyone who already unlocked keeps access.
 */
export default async function rotateEventPin(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization } = requireUser(req);
    const eventId = typeof req.body?.eventId === 'string' ? req.body.eventId : '';
    if (!UUID_PATTERN.test(eventId)) {
      throw new EventPinError(400, 'EVENT_PIN_BAD_REQUEST', 'Missing meet');
    }

    // Only the host can read a PIN, so reading it as the caller is the host check (and verifies the token).
    let owned: { event_id: string } | null;
    try {
      const data = await graphqlAsUser<{ event_access_codes_by_pk: { event_id: string } | null }>(
        `query OwnEventPin($eventId: uuid!) { event_access_codes_by_pk(event_id: $eventId) { event_id } }`,
        authorization,
        { eventId },
      );
      owned = data.event_access_codes_by_pk;
    } catch {
      throw new EventPinError(401, 'UNAUTHORIZED', 'Sign in again to change the PIN');
    }
    if (!owned) throw new EventPinError(404, 'EVENT_NOT_FOUND', 'Only the host of a private meet can change its PIN');

    const data = await graphqlRaw<{
      update_event_access_codes_by_pk: { pin: string; rotated_at: string } | null;
    }>(
      `mutation RotateEventPin($eventId: uuid!, $pin: String!, $now: timestamptz!) {
        update_event_access_codes_by_pk(pk_columns: { event_id: $eventId }, _set: { pin: $pin, rotated_at: $now }) {
          pin
          rotated_at
        }
      }`,
      { eventId, pin: generatePin(), now: new Date().toISOString() },
    );
    const row = data.update_event_access_codes_by_pk;
    if (!row) throw new EventPinError(404, 'EVENT_NOT_FOUND', 'Only the host of a private meet can change its PIN');
    return res.status(200).json({ pin: row.pin, rotatedAt: row.rotated_at });
  } catch (error) {
    if (error instanceof EventPinError) return sendEventPinError(res, error);
    if (error instanceof Error && (error.message.includes('Authorization') || error.message === 'Invalid token')) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    }
    if (error instanceof Error && error.message.includes('User role')) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: error.message } });
    }
    console.error('client/events/rotate-pin error', error);
    return res.status(500).json({ error: { code: 'EVENT_PIN_ROTATE_FAILED', message: 'Something went wrong. Try again.' } });
  }
}
