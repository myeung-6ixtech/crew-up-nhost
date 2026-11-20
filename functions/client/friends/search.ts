import type { Request, Response } from 'express';
import { requireUser } from '../../_lib/auth.js';
import {
  getPairConnection,
  isBlockedBetween,
  lookupProfileByFriendId,
  normalizeFriendId,
  relationshipFrom,
  type Relationship,
} from '../../_lib/connectionRequests.js';
import { cleanUsernameQuery, containsPattern, createRateLimiter } from '../../_lib/crewSearch.js';
import { graphqlAsUser, graphqlRaw } from '../../_lib/graphql.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';

/** 30 searches per 10 seconds per user (typing with a 300 ms debounce stays well under). */
const allow = createRateLimiter(30, 10_000);
const MAX_RESULTS = 20;

type Row = {
  user_id: string;
  username: string | null;
  display_name: string | null;
  preferred_name: string | null;
  crew_role: string | null;
  role_type: string | null;
  base_airport_iata: string | null;
  base_airport: string | null;
  avatar_file_id: string | null;
};

type Result = {
  id: string;
  displayName: string;
  handle: string | null;
  role: string | null;
  base: string | null;
  avatarFileId: string | null;
  friendshipStatus: Relationship;
};

function toResult(row: Row, friendshipStatus: Relationship): Result {
  return {
    id: row.user_id,
    displayName: row.preferred_name || row.display_name || row.username || '',
    handle: row.username,
    role: row.crew_role ?? row.role_type,
    base: row.base_airport_iata ?? row.base_airport,
    avatarFileId: row.avatar_file_id,
    friendshipStatus,
  };
}

/** How the caller stands with each person, in one query. */
async function relationships(userId: string, ids: string[]): Promise<Map<string, Relationship>> {
  const map = new Map<string, Relationship>();
  if (!ids.length) return map;
  const { connections } = await graphqlRaw<{ connections: Array<{ status: string; requester_id: string; addressee_id: string }> }>(
    `query Pairs($me: uuid!, $ids: [uuid!]!) {
      connections(where: { _or: [
        { requester_id: { _eq: $me }, addressee_id: { _in: $ids } }
        { addressee_id: { _eq: $me }, requester_id: { _in: $ids } }
      ] }) { status requester_id addressee_id }
    }`,
    { me: userId, ids },
  );
  for (const id of ids) map.set(id, 'none');
  for (const row of connections) {
    const other = row.requester_id === userId ? row.addressee_id : row.requester_id;
    map.set(other, relationshipFrom(userId, other, row));
  }
  return map;
}

const PROFILE_FIELDS = 'user_id username display_name preferred_name crew_role role_type base_airport_iata base_airport avatar_file_id';

/**
 * GET /v1/client/friends/search?type=username|crew_id&q=
 *  - username: 2+ characters, part of the @username or name (case-insensitive), up to 20 results.
 *  - crew_id: the exact full code only.
 * Never returns the caller, anyone blocked either way, unfinished or deleted accounts (the user-role profile
 * permissions enforce that), and never a Crew ID.
 */
export default async function friendsSearch(req: Request, res: Response) {
  if (req.method !== 'GET') return res.status(405).json({ message: 'Method not allowed' });
  try {
    const { userId, authorization } = requireUser(req);
    if (!allow(userId)) throw new HttpError(429, 'RATE_LIMITED', 'Too many searches. Try again in a moment.');

    const type = req.query.type === 'crew_id' ? 'crew_id' : 'username';

    if (type === 'crew_id') {
      const code = normalizeFriendId(typeof req.query.q === 'string' ? req.query.q : '');
      if (!code) return res.status(200).json({ results: [] });
      const profile = await lookupProfileByFriendId(code);
      if (!profile || profile.user_id === userId || (await isBlockedBetween(userId, profile.user_id))) {
        return res.status(200).json({ results: [] });
      }
      const status = relationshipFrom(userId, profile.user_id, await getPairConnection(userId, profile.user_id));
      return res.status(200).json({ results: [toResult(profile as unknown as Row, status)] });
    }

    const term = cleanUsernameQuery(req.query.q);
    if (term.length < 2) return res.status(200).json({ results: [] });
    const pattern = containsPattern(term);
    // As the caller: their profile permissions hide blocked people, unfinished and deleted accounts.
    const { profiles } = await graphqlAsUser<{ profiles: Row[] }>(
      `query SearchCrew($me: uuid!, $pattern: String!, $limit: Int!) {
        profiles(
          where: {
            user_id: { _neq: $me }
            _or: [
              { username: { _ilike: $pattern } }
              { display_name: { _ilike: $pattern } }
              { preferred_name: { _ilike: $pattern } }
            ]
          }
          order_by: [{ username: asc }]
          limit: $limit
        ) { ${PROFILE_FIELDS} }
      }`,
      authorization,
      { me: userId, pattern, limit: MAX_RESULTS },
    );
    // Closest first: handle starts with the term, then name starts with it, then anywhere.
    const rank = (row: Row) =>
      (row.username ?? '').toLowerCase().startsWith(term) ? 0 : (row.preferred_name || row.display_name || '').toLowerCase().startsWith(term) ? 1 : 2;
    const sorted = [...profiles].sort((a, b) => rank(a) - rank(b));
    const status = await relationships(userId, sorted.map((row) => row.user_id));
    return res.status(200).json({ results: sorted.map((row) => toResult(row, status.get(row.user_id) ?? 'none')) });
  } catch (error) {
    return sendClientError(res, error, 'client/friends/search', 'SEARCH_FAILED');
  }
}
