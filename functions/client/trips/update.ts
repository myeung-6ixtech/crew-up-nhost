import type { Request, Response } from 'express';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';
import { graphqlRaw } from '../../_lib/graphql.js';
import { recomputeTripMatches } from '../../_lib/tripMatching.js';

interface StayUpdateInput {
  id?: string;
  city: string;
  airport_iata?: string | null;
  starts_at: string;
  ends_at: string;
}

export default async function updateTrip(req: Request, res: Response) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    const body = req.body as Record<string, unknown>;
    const tripId = typeof body.trip_id === 'string' ? body.trip_id : '';
    if (!tripId) return badRequest(res, 'trip_id is required');

    const owned = await graphqlRaw<{ user_trips_by_pk: { id: string; user_id: string } | null }>(
      `
        query OwnedTrip($tripId: uuid!) {
          user_trips_by_pk(id: $tripId) {
            id
            user_id
          }
        }
      `,
      { tripId },
    );

    if (!owned.user_trips_by_pk || owned.user_trips_by_pk.user_id !== userId) {
      return res.status(404).json({ message: 'Trip not found' });
    }

    const set: Record<string, unknown> = {};
    if (typeof body.title === 'string') set.title = body.title.trim();
    if (typeof body.visibility === 'string') set.visibility = body.visibility;
    if (typeof body.is_active === 'boolean') set.is_active = body.is_active;

    if (Object.keys(set).length) {
      await graphqlRaw(
        `
          mutation UpdateTrip($tripId: uuid!, $set: user_trips_set_input!) {
            update_user_trips_by_pk(pk_columns: { id: $tripId }, _set: $set) {
              id
            }
          }
        `,
        { tripId, set },
      );
    }

    const stays = Array.isArray(body.stays) ? (body.stays as StayUpdateInput[]) : [];
    for (const stay of stays) {
      if (!stay.city?.trim() || !stay.starts_at || !stay.ends_at) {
        return badRequest(res, 'Each stay requires city, starts_at, and ends_at');
      }

      if (stay.id) {
        await graphqlRaw(
          `
            mutation UpdateStay($id: uuid!, $set: trip_stays_set_input!) {
              update_trip_stays_by_pk(pk_columns: { id: $id }, _set: $set) {
                id
              }
            }
          `,
          {
            id: stay.id,
            set: {
              city: stay.city.trim().toUpperCase(),
              airport_iata: stay.airport_iata?.trim().toUpperCase() ?? null,
              starts_at: stay.starts_at,
              ends_at: stay.ends_at,
            },
          },
        );
      } else {
        await graphqlRaw(
          `
            mutation InsertStay($object: trip_stays_insert_input!) {
              insert_trip_stays_one(object: $object) {
                id
              }
            }
          `,
          {
            object: {
              trip_id: tripId,
              city: stay.city.trim().toUpperCase(),
              airport_iata: stay.airport_iata?.trim().toUpperCase() ?? null,
              starts_at: stay.starts_at,
              ends_at: stay.ends_at,
            },
          },
        );
      }
    }

    void recomputeTripMatches(tripId).catch((error) => {
      console.error('trip match recompute failed after update', tripId, error);
    });

    const refreshed = await graphqlRaw<{ user_trips_by_pk: Record<string, unknown> | null }>(
      `
        query TripById($tripId: uuid!) {
          user_trips_by_pk(id: $tripId) {
            id
            title
            source
            starts_at
            ends_at
            visibility
            is_active
          }
        }
      `,
      { tripId },
    );

    return res.status(200).json({
      trip: refreshed.user_trips_by_pk,
      match_status: 'pending',
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }
    if (error instanceof Error && error.message.includes('User role')) {
      return res.status(403).json({ message: error.message });
    }
    console.error('client/trips/update error', error);
    return res.status(500).json({ message: 'Failed to update trip' });
  }
}
