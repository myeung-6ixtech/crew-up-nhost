import { sendPushNotices } from './expoPush.js';
import { graphqlRaw } from './graphql.js';
import { normalizeFriendId } from './friendId.js';
import { recomputeMatchesForUsers } from './tripMatching.js';

export { formatFriendIdForDisplay, normalizeFriendId } from './friendId.js';

export type FriendProfilePreview = {
  user_id: string;
  display_name: string;
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
          role_type
          base_airport
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
        title: 'Connection request',
        body: input.message?.trim() || 'Someone wants to connect with you on CrewUp.',
        payload: {
          connection_id: input.connectionId,
          requester_id: input.requesterId,
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
    await insertConnectionNotification({
      addresseeId,
      connectionId: connection.id,
      requesterId,
      message,
    });
    await sendPushNotices([
      {
        userId: addresseeId,
        title: 'Connection request',
        body: 'Someone wants to connect',
        data: {
          type: 'connection_request',
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
