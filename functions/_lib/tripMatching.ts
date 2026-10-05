import { graphqlRaw } from './graphql.js';
import { normalizeVisibilityForAffiliation } from './airlineClaim.js';

const ROUTE_TOLERANCE_MS = 3 * 60 * 60 * 1000;

type MatchType = 'same_flight' | 'same_route' | 'layover_overlap';

interface TripContext {
  id: string;
  userId: string;
  visibility: string;
  isActive: boolean;
  airlineId: string | null;
  isVerified: boolean;
  legFlightIds: string[];
  legs: Array<{
    flightInstanceId: string;
    flightNumber: string;
    departureAirport: string;
    arrivalAirport: string;
    scheduledDeparture: string;
  }>;
  stays: Array<{
    id: string;
    city: string;
    airportIata: string | null;
    startsAt: string;
    endsAt: string;
  }>;
}

interface CandidateTrip {
  id: string;
  userId: string;
  visibility: string;
  airlineId: string | null;
  isVerified: boolean;
}

type TripRow = {
  id: string;
  user_id: string;
  visibility: string | null;
  is_active: boolean;
  user: {
    profile: { airline_id: string | null; is_verified: boolean; default_visibility: string } | null;
  } | null;
  flightLegs: Array<{
    flight_instance_id: string;
    flight: {
      id: string;
      flight_number: string;
      departure_airport: string;
      arrival_airport: string;
      scheduled_departure: string;
    };
  }>;
  stays: Array<{
    id: string;
    city: string;
    airport_iata: string | null;
    starts_at: string;
    ends_at: string;
  }>;
};

function toTripContext(trip: TripRow): TripContext {
  const profile = trip.user?.profile;
  const effectiveVisibility = normalizeVisibilityForAffiliation(
    trip.visibility ?? profile?.default_visibility ?? 'friends',
    profile?.airline_id,
  );

  return {
    id: trip.id,
    userId: trip.user_id,
    visibility: effectiveVisibility,
    isActive: trip.is_active,
    airlineId: profile?.airline_id ?? null,
    isVerified: profile?.is_verified ?? false,
    legFlightIds: trip.flightLegs.map((leg) => leg.flight_instance_id),
    legs: trip.flightLegs.map((leg) => ({
      flightInstanceId: leg.flight_instance_id,
      flightNumber: leg.flight.flight_number,
      departureAirport: leg.flight.departure_airport,
      arrivalAirport: leg.flight.arrival_airport,
      scheduledDeparture: leg.flight.scheduled_departure,
    })),
    stays: trip.stays.map((stay) => ({
      id: stay.id,
      city: stay.city,
      airportIata: stay.airport_iata,
      startsAt: stay.starts_at,
      endsAt: stay.ends_at,
    })),
  };
}

const TRIP_CONTEXT_FIELDS = `
  id
  user_id
  visibility
  is_active
  user {
    profile {
      airline_id
      is_verified
      default_visibility
    }
  }
  flightLegs {
    flight_instance_id
    flight {
      id
      flight_number
      departure_airport
      arrival_airport
      scheduled_departure
    }
  }
  stays {
    id
    city
    airport_iata
    starts_at
    ends_at
  }
`;

async function loadTripContexts(tripIds: string[]): Promise<Map<string, TripContext>> {
  const trips = new Map<string, TripContext>();
  if (!tripIds.length) return trips;

  const data = await graphqlRaw<{ user_trips: TripRow[] }>(
    `
      query TripContexts($ids: [uuid!]!) {
        user_trips(where: { id: { _in: $ids } }) {
          ${TRIP_CONTEXT_FIELDS}
        }
      }
    `,
    { ids: tripIds },
  );

  for (const trip of data.user_trips) {
    trips.set(trip.id, toTripContext(trip));
  }
  return trips;
}

async function loadTripContext(tripId: string): Promise<TripContext | null> {
  const trips = await loadTripContexts([tripId]);
  return trips.get(tripId) ?? null;
}

async function loadFriendMap(userIds: string[]): Promise<Map<string, Set<string>>> {
  const friends = new Map<string, Set<string>>();
  for (const userId of userIds) friends.set(userId, new Set());
  if (!userIds.length) return friends;

  const data = await graphqlRaw<{
    connections: Array<{ requester_id: string; addressee_id: string }>;
  }>(
    `
      query FriendIds($userIds: [uuid!]!) {
        connections(
          where: {
            status: { _eq: accepted }
            _or: [
              { requester_id: { _in: $userIds } }
              { addressee_id: { _in: $userIds } }
            ]
          }
        ) {
          requester_id
          addressee_id
        }
      }
    `,
    { userIds },
  );

  for (const row of data.connections) {
    friends.get(row.requester_id)?.add(row.addressee_id);
    friends.get(row.addressee_id)?.add(row.requester_id);
  }
  return friends;
}

async function loadBlockedUserIds(userId: string): Promise<Set<string>> {
  const data = await graphqlRaw<{
    blocks: Array<{ blocker_id: string; blocked_id: string }>;
  }>(
    `
      query Blocks($userId: uuid!) {
        blocks: user_blocks(
          where: {
            _or: [
              { blocker_id: { _eq: $userId } }
              { blocked_id: { _eq: $userId } }
            ]
          }
        ) {
          blocker_id
          blocked_id
        }
      }
    `,
    { userId },
  );

  const ids = new Set<string>();
  for (const row of data.blocks) {
    ids.add(row.blocker_id === userId ? row.blocked_id : row.blocker_id);
  }
  return ids;
}

function canDiscover(
  viewer: TripContext,
  target: CandidateTrip,
  viewerFriends: Set<string>,
  targetFriends: Set<string>,
): boolean {
  if (viewer.visibility === 'off' || target.visibility === 'off') return false;

  if (viewer.visibility === 'all_verified' || target.visibility === 'all_verified') {
    return viewer.isVerified && target.isVerified;
  }

  if (viewer.visibility === 'same_airline' || target.visibility === 'same_airline') {
    if (!viewer.airlineId || !target.airlineId || viewer.airlineId !== target.airlineId) {
      return false;
    }
    return viewer.isVerified && target.isVerified;
  }

  if (viewer.visibility === 'friends' || target.visibility === 'friends') {
    return viewerFriends.has(target.userId) || targetFriends.has(viewer.userId);
  }

  return viewer.isVerified && target.isVerified;
}

function overlapMs(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const start = Math.max(new Date(aStart).getTime(), new Date(bStart).getTime());
  const end = Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime());
  return Math.max(0, end - start);
}

async function clearMatchesForTrip(tripId: string): Promise<number> {
  const result = await graphqlRaw<{ delete_trip_matches: { affected_rows: number } }>(
    `
      mutation ClearTripMatches($tripId: uuid!) {
        delete_trip_matches(
          where: {
            _or: [
              { source_trip_id: { _eq: $tripId } }
              { matched_trip_id: { _eq: $tripId } }
            ]
          }
        ) {
          affected_rows
        }
      }
    `,
    { tripId },
  );
  return result.delete_trip_matches.affected_rows;
}

type MatchInsert = {
  user_id: string;
  matched_user_id: string;
  match_type: MatchType;
  score: number;
  source_trip_id: string;
  matched_trip_id: string;
  city: string | null;
  flight_number: string | null;
  departure_airport: string | null;
  arrival_airport: string | null;
  overlap_start: string | null;
  overlap_end: string | null;
};

function matchRow(input: {
  userId: string;
  matchedUserId: string;
  matchType: MatchType;
  score: number;
  sourceTripId: string;
  matchedTripId: string;
  city?: string | null;
  flightNumber?: string | null;
  departureAirport?: string | null;
  arrivalAirport?: string | null;
  overlapStart?: string | null;
  overlapEnd?: string | null;
}): MatchInsert {
  return {
    user_id: input.userId,
    matched_user_id: input.matchedUserId,
    match_type: input.matchType,
    score: input.score,
    source_trip_id: input.sourceTripId,
    matched_trip_id: input.matchedTripId,
    city: input.city ?? null,
    flight_number: input.flightNumber ?? null,
    departure_airport: input.departureAirport ?? null,
    arrival_airport: input.arrivalAirport ?? null,
    overlap_start: input.overlapStart ?? null,
    overlap_end: input.overlapEnd ?? null,
  };
}

async function insertMatches(objects: MatchInsert[]): Promise<number> {
  if (!objects.length) return 0;
  await graphqlRaw(
    `
      mutation InsertTripMatches($objects: [trip_matches_insert_input!]!) {
        insert_trip_matches(
          objects: $objects
          on_conflict: {
            constraint: trip_matches_unique
            update_columns: [score, city, flight_number, departure_airport, arrival_airport, overlap_start, overlap_end, updated_at]
          }
        ) {
          affected_rows
        }
      }
    `,
    { objects },
  );
  return objects.length;
}

export async function recomputeTripMatches(tripId: string): Promise<{
  deletedMatches: number;
  insertedMatches: number;
}> {
  const source = await loadTripContext(tripId);
  if (!source || source.visibility === 'off' || !source.isActive) {
    const deleted = await clearMatchesForTrip(tripId);
    return { deletedMatches: deleted, insertedMatches: 0 };
  }

  const deletedMatches = await clearMatchesForTrip(tripId);
  if (!source.legs.length && !source.stays.length) {
    return { deletedMatches, insertedMatches: 0 };
  }

  const sourceBlocks = await loadBlockedUserIds(source.userId);
  const candidateTripIds = new Set<string>();

  if (source.legFlightIds.length) {
    const sameFlight = await graphqlRaw<{
      trip_flight_legs: Array<{ trip_id: string }>;
    }>(
      `
        query SameFlightCandidates($flightIds: [uuid!]!, $tripId: uuid!) {
          trip_flight_legs(
            where: {
              flight_instance_id: { _in: $flightIds }
              trip_id: { _neq: $tripId }
              trip: { is_active: { _eq: true } }
            }
          ) {
            trip_id
          }
        }
      `,
      { flightIds: source.legFlightIds, tripId: source.id },
    );
    for (const row of sameFlight.trip_flight_legs) candidateTripIds.add(row.trip_id);
  }

  if (source.stays.length) {
    const overlap = await graphqlRaw<{ trip_stays: Array<{ trip_id: string }> }>(
      `
        query OverlapStays($tripId: uuid!, $windows: [trip_stays_bool_exp!]!) {
          trip_stays(
            where: {
              trip_id: { _neq: $tripId }
              trip: { is_active: { _eq: true } }
              _or: $windows
            }
          ) {
            trip_id
          }
        }
      `,
      {
        tripId: source.id,
        windows: source.stays.map((stay) => ({
          city: { _ilike: stay.city },
          starts_at: { _lte: stay.endsAt },
          ends_at: { _gte: stay.startsAt },
        })),
      },
    );
    for (const row of overlap.trip_stays) candidateTripIds.add(row.trip_id);
  }

  const targets = await loadTripContexts([...candidateTripIds]);
  const comparable = [...targets.values()].filter(
    (target) => target.userId !== source.userId && target.isActive && !sourceBlocks.has(target.userId),
  );
  const friendMap = await loadFriendMap([source.userId, ...comparable.map((target) => target.userId)]);
  const sourceFriends = friendMap.get(source.userId) ?? new Set<string>();
  const rows: MatchInsert[] = [];

  for (const target of comparable) {
    const targetFriends = friendMap.get(target.userId) ?? new Set<string>();
    if (!canDiscover(source, target, sourceFriends, targetFriends)) continue;

    const matchesForPair: Array<{
      matchType: MatchType;
      score: number;
      city?: string | null;
      flightNumber?: string | null;
      departureAirport?: string | null;
      arrivalAirport?: string | null;
      overlapStart?: string | null;
      overlapEnd?: string | null;
    }> = [];

    for (const sourceLeg of source.legs) {
      for (const targetLeg of target.legs) {
        if (sourceLeg.flightInstanceId === targetLeg.flightInstanceId) {
          matchesForPair.push({
            matchType: 'same_flight',
            score: 100,
            flightNumber: sourceLeg.flightNumber,
            departureAirport: sourceLeg.departureAirport,
            arrivalAirport: sourceLeg.arrivalAirport,
            overlapStart: sourceLeg.scheduledDeparture,
            overlapEnd: targetLeg.scheduledDeparture,
          });
          continue;
        }

        if (
          sourceLeg.departureAirport === targetLeg.departureAirport &&
          sourceLeg.arrivalAirport === targetLeg.arrivalAirport &&
          Math.abs(
            new Date(sourceLeg.scheduledDeparture).getTime() -
              new Date(targetLeg.scheduledDeparture).getTime(),
          ) <= ROUTE_TOLERANCE_MS
        ) {
          matchesForPair.push({
            matchType: 'same_route',
            score: 70,
            flightNumber: sourceLeg.flightNumber,
            departureAirport: sourceLeg.departureAirport,
            arrivalAirport: sourceLeg.arrivalAirport,
            overlapStart: sourceLeg.scheduledDeparture,
            overlapEnd: targetLeg.scheduledDeparture,
          });
        }
      }
    }

    for (const sourceStay of source.stays) {
      for (const targetStay of target.stays) {
        if (sourceStay.city.toLowerCase() !== targetStay.city.toLowerCase()) continue;
        const overlap = overlapMs(
          sourceStay.startsAt,
          sourceStay.endsAt,
          targetStay.startsAt,
          targetStay.endsAt,
        );
        if (overlap <= 0) continue;
        const overlapHours = overlap / (60 * 60 * 1000);
        const overlapStart = new Date(
          Math.max(new Date(sourceStay.startsAt).getTime(), new Date(targetStay.startsAt).getTime()),
        ).toISOString();
        const overlapEnd = new Date(
          Math.min(new Date(sourceStay.endsAt).getTime(), new Date(targetStay.endsAt).getTime()),
        ).toISOString();
        matchesForPair.push({
          matchType: 'layover_overlap',
          score: overlapHours >= 8 ? 50 : 30,
          city: sourceStay.city,
          overlapStart,
          overlapEnd,
        });
      }
    }

    for (const match of matchesForPair) {
      const shared = {
        matchType: match.matchType,
        score: match.score,
        city: match.city,
        flightNumber: match.flightNumber,
        departureAirport: match.departureAirport,
        arrivalAirport: match.arrivalAirport,
        overlapStart: match.overlapStart,
        overlapEnd: match.overlapEnd,
      };
      rows.push(
        matchRow({
          ...shared,
          userId: source.userId,
          matchedUserId: target.userId,
          sourceTripId: source.id,
          matchedTripId: target.id,
        }),
        matchRow({
          ...shared,
          userId: target.userId,
          matchedUserId: source.userId,
          sourceTripId: target.id,
          matchedTripId: source.id,
        }),
      );
    }
  }

  const insertedMatches = await insertMatches(rows);
  return { deletedMatches, insertedMatches };
}
