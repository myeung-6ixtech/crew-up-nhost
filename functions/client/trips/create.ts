import type { Request, Response } from 'express';
import {
  badRequest,
  requireUser,
  unauthorized,
  type UserTripRow,
} from '../../_lib/auth.js';
import {
  normalizeFlightNumber,
  normalizeIata,
  verifyFlightSelectionToken,
} from '../../_lib/flightSelection.js';
import { graphqlRaw } from '../../_lib/graphql.js';
import { recomputeTripMatches } from '../../_lib/tripMatching.js';

interface StayInput {
  city: string;
  airport_iata?: string | null;
  starts_at: string;
  ends_at: string;
}

interface ManualLegInput {
  flight_number: string;
  airline_iata?: string | null;
  departure_airport: string;
  arrival_airport: string;
  /** Local departure date of the airline service day (YYYY-MM-DD). */
  service_date: string;
  /** UTC instants; the client converts from airport-local input. */
  scheduled_departure: string;
  scheduled_arrival: string;
}

interface LegInput {
  selection_token?: string;
  manual?: ManualLegInput;
}

interface ResolvedLeg {
  flightNumber: string;
  airlineIata?: string | null;
  serviceDate: string;
  departureAirport: string;
  arrivalAirport: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  provider?: string | null;
  providerFlightId?: string | null;
}

function parseUtcInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Manual entry keeps Add Trip usable when a provider has no coverage, so it is
 * validated to the same shape a signed selection token would produce rather than
 * trusting arbitrary client data.
 */
function resolveManualLeg(manual: ManualLegInput, index: number): ResolvedLeg {
  const flightNumber = normalizeFlightNumber(String(manual.flight_number ?? ''));
  const departureAirport = normalizeIata(String(manual.departure_airport ?? ''));
  const arrivalAirport = normalizeIata(String(manual.arrival_airport ?? ''));
  const serviceDate = typeof manual.service_date === 'string' ? manual.service_date.trim() : '';
  const scheduledDeparture = parseUtcInstant(manual.scheduled_departure);
  const scheduledArrival = parseUtcInstant(manual.scheduled_arrival);
  const airlineIata = normalizeIata(String(manual.airline_iata ?? ''));

  if (!/^[A-Z0-9]{2,8}$/.test(flightNumber)) {
    throw new Error(`legs[${index}].manual.flight_number is required`);
  }
  if (!/^[A-Z]{3}$/.test(departureAirport) || !/^[A-Z]{3}$/.test(arrivalAirport)) {
    throw new Error(`legs[${index}].manual airport codes are required`);
  }
  if (departureAirport === arrivalAirport) {
    throw new Error(`legs[${index}].manual departure and arrival must differ`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    throw new Error(`legs[${index}].manual.service_date is required`);
  }
  if (!scheduledDeparture || !scheduledArrival) {
    throw new Error(`legs[${index}].manual scheduled times are required`);
  }
  if (Date.parse(scheduledArrival) < Date.parse(scheduledDeparture)) {
    throw new Error(`legs[${index}].manual arrival must be after departure`);
  }
  if (airlineIata && !/^[A-Z0-9]{2,3}$/.test(airlineIata)) {
    throw new Error(`legs[${index}].manual.airline_iata is invalid`);
  }

  return {
    flightNumber,
    airlineIata: airlineIata || null,
    serviceDate,
    departureAirport,
    arrivalAirport,
    scheduledDeparture,
    scheduledArrival,
    provider: 'manual',
    providerFlightId: null,
  };
}

function resolveLeg(leg: LegInput, index: number): ResolvedLeg {
  if (leg?.selection_token) {
    return verifyFlightSelectionToken(leg.selection_token);
  }
  if (leg?.manual) {
    return resolveManualLeg(leg.manual, index);
  }
  throw new Error(`legs[${index}] requires selection_token or manual flight details`);
}

async function upsertFlightInstance(leg: ResolvedLeg): Promise<string> {
  // Race-safe: the tracked SQL function performs INSERT ... ON CONFLICT on the
  // canonical identity key, so concurrent saves of the same flight converge.
  const result = await graphqlRaw<{
    upsert_flight_instance_row: Array<{ id: string }>;
  }>(
    `
      mutation UpsertFlightInstance(
        $flightNumber: String!
        $serviceDate: date!
        $departureAirport: String!
        $arrivalAirport: String!
        $scheduledDeparture: timestamptz!
        $scheduledArrival: timestamptz!
        $airlineIata: String
        $provider: String
        $providerFlightId: String
      ) {
        upsert_flight_instance_row(
          args: {
            p_flight_number: $flightNumber
            p_service_date: $serviceDate
            p_departure_airport: $departureAirport
            p_arrival_airport: $arrivalAirport
            p_scheduled_departure: $scheduledDeparture
            p_scheduled_arrival: $scheduledArrival
            p_airline_iata: $airlineIata
            p_provider: $provider
            p_provider_flight_id: $providerFlightId
          }
        ) {
          id
        }
      }
    `,
    {
      flightNumber: leg.flightNumber,
      serviceDate: leg.serviceDate,
      departureAirport: leg.departureAirport,
      arrivalAirport: leg.arrivalAirport,
      scheduledDeparture: leg.scheduledDeparture,
      scheduledArrival: leg.scheduledArrival,
      airlineIata: leg.airlineIata ?? null,
      provider: leg.provider ?? null,
      providerFlightId: leg.providerFlightId ?? null,
    },
  );

  const id = result.upsert_flight_instance_row[0]?.id;
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

    const resolvedLegs = legs.map(resolveLeg);

    if (!resolvedLegs.length && !stays.length) {
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

    const bounds = computeTripBounds(resolvedLegs, stays);

    // Canonical flights are shared and deduplicated, so upserting them before the
    // trip is safe to repeat and keeps the trip write itself a single transaction.
    const flightInstanceIds: string[] = [];
    for (const leg of resolvedLegs) {
      flightInstanceIds.push(await upsertFlightInstance(leg));
    }

    // One mutation so Hasura commits the trip with all of its legs and stays
    // atomically; a partial failure can no longer leave an empty trip in My Trips.
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
          flightLegs: {
            data: flightInstanceIds.map((flightInstanceId, index) => ({
              flight_instance_id: flightInstanceId,
              sequence_number: index + 1,
            })),
          },
          stays: {
            data: stays.map((stay) => ({
              city: stay.city.trim().toUpperCase(),
              airport_iata: stay.airport_iata?.trim().toUpperCase() ?? null,
              starts_at: stay.starts_at,
              ends_at: stay.ends_at,
            })),
          },
        },
      },
    );

    const trip = tripResult.insert_user_trips_one;
    if (!trip?.id) {
      return res.status(500).json({ message: 'Failed to create trip' });
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
    if (error instanceof Error && error.message.startsWith('legs[')) {
      return badRequest(res, error.message);
    }
    console.error('client/trips/create error', error);
    return res.status(500).json({ message: 'Failed to create trip' });
  }
}
