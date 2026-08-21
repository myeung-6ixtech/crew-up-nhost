import type { Request, Response } from 'express';
import {
  badRequest,
  requireUser,
  unauthorized,
  type UserTripRow,
} from '../../_lib/auth.js';
import { verifyFlightSelectionToken } from '../../_lib/flightSelection.js';
import { graphqlRaw } from '../../_lib/graphql.js';
import { recomputeTripMatches } from '../../_lib/tripMatching.js';

interface StayInput {
  city: string;
  airport_iata?: string | null;
  starts_at: string;
  ends_at: string;
}

interface LegInput {
  selection_token: string;
}

async function upsertFlightInstance(input: {
  airlineIata?: string | null;
  flightNumber: string;
  serviceDate: string;
  departureAirport: string;
  arrivalAirport: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  provider?: string | null;
  providerFlightId?: string | null;
}): Promise<string> {
  const existing = await graphqlRaw<{
    flight_instances: Array<{ id: string }>;
  }>(
    `
      query ExistingFlight(
        $flightNumber: String!
        $serviceDate: date!
        $departureAirport: String!
        $scheduledDeparture: timestamptz!
      ) {
        flight_instances(
          where: {
            flight_number: { _eq: $flightNumber }
            service_date: { _eq: $serviceDate }
            departure_airport: { _eq: $departureAirport }
            scheduled_departure: { _eq: $scheduledDeparture }
          }
          limit: 1
        ) {
          id
        }
      }
    `,
    {
      flightNumber: input.flightNumber,
      serviceDate: input.serviceDate,
      departureAirport: input.departureAirport,
      scheduledDeparture: input.scheduledDeparture,
    },
  );

  if (existing.flight_instances[0]?.id) {
    return existing.flight_instances[0].id;
  }

  const inserted = await graphqlRaw<{ insert_flight_instances_one: { id: string } | null }>(
    `
      mutation InsertFlightInstance($object: flight_instances_insert_input!) {
        insert_flight_instances_one(object: $object) {
          id
        }
      }
    `,
    {
      object: {
        airline_iata: input.airlineIata,
        flight_number: input.flightNumber,
        service_date: input.serviceDate,
        departure_airport: input.departureAirport,
        arrival_airport: input.arrivalAirport,
        scheduled_departure: input.scheduledDeparture,
        scheduled_arrival: input.scheduledArrival,
        provider: input.provider,
        provider_flight_id: input.providerFlightId,
      },
    },
  );

  const id = inserted.insert_flight_instances_one?.id;
  if (!id) throw new Error('Failed to upsert flight instance');
  return id;
}

function computeTripBounds(
  legs: Array<{ scheduledDeparture: string; scheduledArrival: string }>,
  stays: StayInput[],
): { startsAt: string | null; endsAt: string | null } {
  const times: number[] = [];
  for (const leg of legs) {
    times.push(new Date(leg.scheduledDeparture).getTime());
    times.push(new Date(leg.scheduledArrival).getTime());
  }
  for (const stay of stays) {
    times.push(new Date(stay.starts_at).getTime());
    times.push(new Date(stay.ends_at).getTime());
  }
  if (!times.length) return { startsAt: null, endsAt: null };
  return {
    startsAt: new Date(Math.min(...times)).toISOString(),
    endsAt: new Date(Math.max(...times)).toISOString(),
  };
}

export default async function createTrip(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    const body = req.body as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : null;
    const source =
      typeof body.source === 'string' &&
      ['manual', 'flight_search', 'roster_upload', 'airline_portal'].includes(body.source)
        ? body.source
        : 'manual';
    const visibility = typeof body.visibility === 'string' ? body.visibility : null;
    const idempotencyKey =
      typeof body.idempotency_key === 'string' ? body.idempotency_key : null;
    const legs = Array.isArray(body.legs) ? (body.legs as LegInput[]) : [];
    const stays = Array.isArray(body.stays) ? (body.stays as StayInput[]) : [];

    if (idempotencyKey) {
      const existing = await graphqlRaw<{ user_trips: UserTripRow[] }>(
        `
          query ExistingTrip($userId: uuid!, $idempotencyKey: uuid!) {
            user_trips(
              where: {
                user_id: { _eq: $userId }
                idempotency_key: { _eq: $idempotencyKey }
              }
              limit: 1
            ) {
              id
              title
              source
              starts_at
              ends_at
            }
          }
        `,
        { userId, idempotencyKey },
      );
      if (existing.user_trips[0]) {
        return res.status(200).json({
          trip: existing.user_trips[0],
          match_status: 'pending',
        });
      }
    }

    const verifiedLegs = legs.map((leg, index) => {
      if (!leg?.selection_token) {
        throw new Error(`legs[${index}].selection_token is required`);
      }
      return verifyFlightSelectionToken(leg.selection_token);
    });

    if (!verifiedLegs.length && !stays.length) {
      return badRequest(res, 'At least one flight leg or stay is required');
    }

    for (const stay of stays) {
      if (!stay.city?.trim() || !stay.starts_at || !stay.ends_at) {
        return badRequest(res, 'Each stay requires city, starts_at, and ends_at');
      }
      if (new Date(stay.ends_at).getTime() < new Date(stay.starts_at).getTime()) {
        return badRequest(res, 'Stay end must be after start');
      }
    }

    const bounds = computeTripBounds(verifiedLegs, stays);

    const tripResult = await graphqlRaw<{ insert_user_trips_one: UserTripRow | null }>(
      `
        mutation InsertTrip($object: user_trips_insert_input!) {
          insert_user_trips_one(object: $object) {
            id
            title
            source
            starts_at
            ends_at
          }
        }
      `,
      {
        object: {
          user_id: userId,
          title,
          source,
          visibility,
          starts_at: bounds.startsAt,
          ends_at: bounds.endsAt,
          idempotency_key: idempotencyKey,
        },
      },
    );

    const trip = tripResult.insert_user_trips_one;
    if (!trip?.id) {
      return res.status(500).json({ message: 'Failed to create trip' });
    }

    for (let index = 0; index < verifiedLegs.length; index += 1) {
      const leg = verifiedLegs[index];
      const flightInstanceId = await upsertFlightInstance({
        airlineIata: leg.airlineIata,
        flightNumber: leg.flightNumber,
        serviceDate: leg.serviceDate,
        departureAirport: leg.departureAirport,
        arrivalAirport: leg.arrivalAirport,
        scheduledDeparture: leg.scheduledDeparture,
        scheduledArrival: leg.scheduledArrival,
        provider: leg.provider,
        providerFlightId: leg.providerFlightId,
      });

      await graphqlRaw(
        `
          mutation InsertLeg($object: trip_flight_legs_insert_input!) {
            insert_trip_flight_legs_one(object: $object) {
              id
            }
          }
        `,
        {
          object: {
            trip_id: trip.id,
            flight_instance_id: flightInstanceId,
            sequence_number: index + 1,
          },
        },
      );
    }

    for (const stay of stays) {
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
            trip_id: trip.id,
            city: stay.city.trim().toUpperCase(),
            airport_iata: stay.airport_iata?.trim().toUpperCase() ?? null,
            starts_at: stay.starts_at,
            ends_at: stay.ends_at,
          },
        },
      );
    }

    void recomputeTripMatches(trip.id).catch((error) => {
      console.error('trip match recompute failed after create', trip.id, error);
    });

    return res.status(201).json({
      trip,
      match_status: 'pending',
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }
    if (error instanceof Error && error.message.includes('User role')) {
      return res.status(403).json({ message: error.message });
    }
    if (
      error instanceof Error &&
      (error.message === 'INVALID_FLIGHT_SELECTION' ||
        error.message === 'FLIGHT_SELECTION_EXPIRED')
    ) {
      return res.status(400).json({
        error: {
          code: error.message,
          message: 'Selected flight expired. Search again.',
          field: 'legs[0].selection_token',
        },
      });
    }
    if (error instanceof Error && error.message.includes('required')) {
      return badRequest(res, error.message);
    }
    console.error('client/trips/create error', error);
    return res.status(500).json({ message: 'Failed to create trip' });
  }
}
