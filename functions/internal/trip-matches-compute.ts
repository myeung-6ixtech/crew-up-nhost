import type { Request, Response } from 'express';
import {
  isHasuraEventPayload,
  unauthorized,
  verifyWebhookSecret,
  type HasuraEventPayload,
  type TripFlightLegRow,
  type TripStayRow,
  type UserTripRow,
} from '../_lib/auth.js';
import { graphqlRaw } from '../_lib/graphql.js';
import { recomputeTripMatches } from '../_lib/tripMatching.js';

async function resolveTripId(payload: HasuraEventPayload<Record<string, unknown>>): Promise<string | null> {
  const table = payload.table.name;
  const op = payload.event.op;
  const row = op === 'DELETE' ? payload.event.data.old : payload.event.data.new;

  if (table === 'user_trips') {
    return (row as UserTripRow | null)?.id ?? null;
  }

  if (table === 'trip_flight_legs') {
    const tripId = (row as TripFlightLegRow | null)?.trip_id;
    if (tripId) return tripId;
  }

  if (table === 'trip_stays') {
    const tripId = (row as TripStayRow | null)?.trip_id;
    if (tripId) return tripId;
  }

  const tripId = typeof row?.trip_id === 'string' ? row.trip_id : null;
  if (tripId) return tripId;

  if (table === 'trip_flight_legs' && typeof row?.id === 'string') {
    const data = await graphqlRaw<{ trip_flight_legs_by_pk: { trip_id: string } | null }>(
      `
        query LegTrip($id: uuid!) {
          trip_flight_legs_by_pk(id: $id) {
            trip_id
          }
        }
      `,
      { id: row.id },
    );
    return data.trip_flight_legs_by_pk?.trip_id ?? null;
  }

  return null;
}

export default async function tripMatchesCompute(req: Request, res: Response) {
  if (!verifyWebhookSecret(req)) {
    return unauthorized(res);
  }

  if (!isHasuraEventPayload<Record<string, unknown>>(req.body)) {
    return res.status(400).json({ message: 'Invalid Hasura event payload' });
  }

  try {
    const tripId = await resolveTripId(req.body);
    if (!tripId) {
      return res.status(400).json({ message: 'Could not resolve trip id' });
    }

    const result = await recomputeTripMatches(tripId);
    return res.status(200).json({
      message: 'Trip matches recomputed',
      trip_id: tripId,
      deleted_matches: result.deletedMatches,
      inserted_matches: result.insertedMatches,
    });
  } catch (error) {
    console.error('internal/trip-matches-compute error', error);
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to recompute trip matches',
    });
  }
}
