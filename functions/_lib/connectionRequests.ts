import { sendPushNotices } from './expoPush.js';
import { graphqlRaw } from './graphql.js';
import { normalizeFriendId } from './friendId.js';
import { recomputeMatchesForUsers } from './tripMatching.js';
import { POKE_TITLE, pokeBody, pokeSenderName } from './pokeNotice.js';
export { relationshipFrom, type Relationship } from './relationship.js';

export { formatFriendIdForDisplay, normalizeFriendId } from './friendId.js';

export type FriendProfilePreview = {
  user_id: string;
  display_name: string;
  preferred_name?: string | null;
  crew_role?: string | null;
  airline_id?: string | null;
  base_airport_iata?: string | null;
  role_type?: string | null;
  base_airport?: string | null;
  avatar_file_id?: string | null;
  friend_id: string;
  is_verified?: boolean;
};

export type ConnectionRow = {
  id: string;
  status: string;
  requester_id: string;
  addressee_id: string;
};

export type ConnectionRequestOutcome =
  | 'created'
  | 'already_sent'
  | 'accepted'
  | 'already_friends';

export class ConnectionRequestError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'ConnectionRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function lookupProfileByFriendId(
  friendId: string,
): Promise<FriendProfilePreview | null> {
  const normalized = normalizeFriendId(friendId);
  if (!normalized) {
    return null;
  }

  const data = await graphqlRaw<{ profiles: FriendProfilePreview[] }>(
    `
      query ProfileByFriendId($friendId: String!) {
        profiles(
          where: { friend_id: { _eq: $friendId } }
          limit: 1
        ) {
          user_id
          display_name
          preferred_name
          crew_role
          airline_id
          role_type
          base_airport
          base_airport_iata
          avatar_file_id
          friend_id
          is_verified
        }
      }
    `,
    { friendId: normalized },
  );

  return data.profiles[0] ?? null;
}

/** Name for notification copy. Admin read; returns nothing on failure so a notice still goes out. */
export async function lookupSenderName(userId: string): Promise<{ preferred_name?: string | null; display_name?: string | null } | null> {
  try {
    const data = await graphqlRaw<{ profiles_by_pk: { preferred_name?: string | null; display_name?: string | null } | null }>(
      `
        query SenderName($userId: uuid!) {
          profiles_by_pk(user_id: $userId) {
            preferred_name
            display_name
          }
        }
      `,
      { userId },
    );
    return data.profiles_by_pk;
  } catch {
    return null;
  }
}

export async function lookupProfileByUserId(
  userId: string,
): Promise<FriendProfilePreview | null> {
  const data = await graphqlRaw<{ profiles_by_pk: FriendProfilePreview | null }>(
    `
      query ProfileByUserId($userId: uuid!) {
        profiles_by_pk(user_id: $userId) {
          user_id
          display_name
          role_type
          base_airport
          avatar_file_id
          friend_id
          is_verified
        }
      }
    `,
    { userId },
  );

  return data.profiles_by_pk;
}

export async function getPairConnection(
  userA: string,
  userB: string,
): Promise<ConnectionRow | null> {
  const data = await graphqlRaw<{ connections: ConnectionRow[] }>(
    `
      query PairConnection($userA: uuid!, $userB: uuid!) {
        connections(
          where: {
            _or: [
              {
                _and: [
                  { requester_id: { _eq: $userA } }
                  { addressee_id: { _eq: $userB } }
                ]
              }
              {
                _and: [
                  { requester_id: { _eq: $userB } }
                  { addressee_id: { _eq: $userA } }
                ]
              }
            ]
          }
          limit: 1
        ) {
          id
          status
          requester_id
          addressee_id
        }
      }
    `,
    { userA, userB },
  );

  return data.connections[0] ?? null;
}

/** Friend requests one person can send per hour (Crew ID, QR or Connect). Past this: RATE_LIMITED (429). */
export const FRIEND_REQUESTS_PER_HOUR = 20;

export async function assertRequestRateLimit(requesterId: string, nowMs: number = Date.now()): Promise<void> {
  const since = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const data = await graphqlRaw<{ connections_aggregate: { aggregate: { count: number } } }>(
    `
      query RecentRequests($requesterId: uuid!, $since: timestamptz!) {
        connections_aggregate(where: { requester_id: { _eq: $requesterId }, created_at: { _gte: $since } }) {
          aggregate {
            count
          }
        }
      }
    `,
    { requesterId, since },
  );
  if (data.connections_aggregate.aggregate.count >= FRIEND_REQUESTS_PER_HOUR) {
    throw new ConnectionRequestError('RATE_LIMITED', 'Too many friend requests. Try again later.', 429);
  }
}

export async function isBlockedBetween(userA: string, userB: string): Promise<boolean> {
  const data = await graphqlRaw<{ user_blocks: Array<{ id: string }> }>(
    `
      query BlocksBetween($userA: uuid!, $userB: uuid!) {
        user_blocks(
          where: {
            _or: [
              {
                _and: [
                  { blocker_id: { _eq: $userA } }
                  { blocked_id: { _eq: $userB } }
                ]
              }
              {
                _and: [
                  { blocker_id: { _eq: $userB } }
                  { blocked_id: { _eq: $userA } }
                ]
              }
            ]
          }
          limit: 1
        ) {
          id
        }
      }
    `,
    { userA, userB },
  );

  return data.user_blocks.length > 0;
}

async function insertConnectionNotification(input: {
  addresseeId: string;
  connectionId: string;
  requesterId: string;
  message?: string | null;
  /** A poke from Discover / Matches: notified as a poke, not a plain request. */
  poke?: { title: string; body: string; meta: WaveMeta } | null;
}) {
  await graphqlRaw(
    `
      mutation InsertConnectionNotification($object: notifications_insert_input!) {
        insert_notifications_one(object: $object) {
          id
        }
      }
    `,
    {
      object: {
        user_id: input.addresseeId,
        type: 'connection_request',
        title: input.poke?.title ?? 'Connection request',
        body: input.poke?.body ?? (input.message?.trim() || 'Someone wants to connect with you on CrewUp.'),
        payload: {
          connection_id: input.connectionId,
          requester_id: input.requesterId,
          ...(input.poke ? { poke: true, wave_meta: input.poke.meta } : {}),
        },
      },
    },
  );
}

export type WaveMeta = {
  overlap_key: string;
  city?: string;
  match_type?: string;
  overlap_start?: string;
  overlap_end?: string;
  flight_number?: string;
};

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Layover snapshot stored on a wave request. Anything else is dropped. */
export function cleanWaveMeta(value: unknown): WaveMeta | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const overlap_key = clip(raw.overlap_key, 200);
  if (!overlap_key) return null;
  return {
    overlap_key,
    city: clip(raw.city, 80),
    match_type: clip(raw.match_type, 40),
    overlap_start: clip(raw.overlap_start, 40),
    overlap_end: clip(raw.overlap_end, 40),
    flight_number: clip(raw.flight_number, 20),
  };
}

export async function sendConnectionRequest(input: {
  requesterId: string;
  addresseeId: string;
  message?: string | null;
  waveMeta?: WaveMeta | null;
}): Promise<{ connection: ConnectionRow; outcome: ConnectionRequestOutcome }> {
  const { requesterId, addresseeId, message, waveMeta } = input;

  if (requesterId === addresseeId) {
    throw new ConnectionRequestError('SELF_INVITE', 'You cannot send a request to yourself', 400);
  }

  const addressee = await lookupProfileByUserId(addresseeId);
  if (!addressee) {
    throw new ConnectionRequestError('NOT_FOUND', 'Crew member not found', 404);
  }

  if (await isBlockedBetween(requesterId, addresseeId)) {
    throw new ConnectionRequestError('BLOCKED', 'Unable to send request', 403);
  }

  const existing = await getPairConnection(requesterId, addresseeId);

  if (existing?.status === 'accepted') {
    throw new ConnectionRequestError('ALREADY_FRIENDS', 'You are already connected', 409);
  }

  if (existing?.status === 'pending') {
    if (existing.requester_id === requesterId) {
      return { connection: existing, outcome: 'already_sent' };
    }

    const updated = await graphqlRaw<{ update_connections_by_pk: ConnectionRow | null }>(
      `
        mutation AcceptConnection($id: uuid!) {
          update_connections_by_pk(pk_columns: { id: $id }, _set: { status: accepted }) {
            id
            status
            requester_id
            addressee_id
          }
        }
      `,
      { id: existing.id },
    );

    const connection = updated.update_connections_by_pk;
    if (!connection) {
      throw new ConnectionRequestError('REQUEST_FAILED', 'Failed to accept connection', 500);
    }

    void recomputeMatchesForUsers([requesterId, addresseeId]).catch((error) => {
      console.error('connectionRequests: layover rematch failed', error);
    });
    return { connection, outcome: 'accepted' };
  }

  await assertRequestRateLimit(requesterId);

  const inserted = await graphqlRaw<{ insert_connections_one: ConnectionRow | null }>(
    `
      mutation InsertConnection($object: connections_insert_input!) {
        insert_connections_one(object: $object) {
          id
          status
          requester_id
          addressee_id
        }
      }
    `,
    {
      object: {
        requester_id: requesterId,
        addressee_id: addresseeId,
        status: 'pending',
        message: message?.trim() || null,
        wave_meta: waveMeta ?? null,
      },
    },
  );

  const connection = inserted.insert_connections_one;
  if (!connection) {
    throw new ConnectionRequestError('REQUEST_FAILED', 'Failed to send connection request', 500);
  }

  try {
    // A poke reads as a poke ("Sam poked you · Tokyo layover"), in the notifications list and the push.
    const poke = waveMeta
      ? { title: POKE_TITLE, body: pokeBody(pokeSenderName(await lookupSenderName(requesterId)), waveMeta), meta: waveMeta }
      : null;
    await insertConnectionNotification({
      addresseeId,
      connectionId: connection.id,
      requesterId,
      message,
      poke,
    });
    await sendPushNotices([
      {
        userId: addresseeId,
        title: poke?.title ?? 'Connection request',
        body: poke?.body ?? 'Someone wants to connect',
        // Pokes are time-sensitive (a layover now), so they reach digest users too; a plain request waits.
        includeDigest: Boolean(poke),
        data: {
          type: poke ? 'poke' : 'connection_request',
          connectionId: connection.id,
          requesterId,
          url: `crewup://network/${requesterId}`,
        },
      },
    ]);
  } catch (error) {
    console.error('connectionRequests: notification insert failed', error);
  }

  return { connection, outcome: 'created' };
}
