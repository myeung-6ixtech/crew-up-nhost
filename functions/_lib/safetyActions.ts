import { graphqlRaw } from './graphql.js';

/**
 * Block and unfriend, run as the service role after the caller is authenticated. Both are idempotent: repeating one
 * leaves the same state and succeeds.
 */

/** Blocks `blockedId` for `blockerId`, and ends any friendship or pending request between them in either direction. */
export async function blockPair(blockerId: string, blockedId: string, reason?: string | null): Promise<void> {
  await graphqlRaw(
    `
      mutation BlockPair($blocker: uuid!, $blocked: uuid!, $reason: String) {
        insert_user_blocks_one(
          object: { blocker_id: $blocker, blocked_id: $blocked, reason: $reason }
          on_conflict: { constraint: user_blocks_pair_unique, update_columns: [] }
        ) {
          id
        }
        delete_connections(
          where: {
            _or: [
              { _and: [{ requester_id: { _eq: $blocker } }, { addressee_id: { _eq: $blocked } }] }
              { _and: [{ requester_id: { _eq: $blocked } }, { addressee_id: { _eq: $blocker } }] }
            ]
          }
        ) {
          affected_rows
        }
      }
    `,
    { blocker: blockerId, blocked: blockedId, reason: reason?.slice(0, 200) ?? null },
  );
}

/** Ends an accepted friendship between the two, either direction. No friendship: nothing to do. */
export async function unfriendPair(userId: string, otherId: string): Promise<number> {
  const data = await graphqlRaw<{ delete_connections: { affected_rows: number } }>(
    `
      mutation UnfriendPair($me: uuid!, $other: uuid!) {
        delete_connections(
          where: {
            status: { _eq: accepted }
            _or: [
              { _and: [{ requester_id: { _eq: $me } }, { addressee_id: { _eq: $other } }] }
              { _and: [{ requester_id: { _eq: $other } }, { addressee_id: { _eq: $me } }] }
            ]
          }
        ) {
          affected_rows
        }
      }
    `,
    { me: userId, other: otherId },
  );
  return data.delete_connections.affected_rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
