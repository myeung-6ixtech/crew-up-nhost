import { recomputeMatchesForUsers } from '../functions/_lib/tripMatching.ts';
import { graphqlRaw } from '../functions/_lib/graphql.ts';

const data = await graphqlRaw(`
  query ActiveTripOwners {
    user_trips(where: { is_active: { _eq: true } }) {
      user_id
    }
  }
`);

const userIds = [...new Set(data.user_trips.map((trip) => trip.user_id))];
const inserted = await recomputeMatchesForUsers(userIds);
console.log(`Recomputed layover matches for ${userIds.length} people, ${inserted} match rows written.`);
