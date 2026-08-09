import type { Request, Response } from 'express';
import {
  isHasuraEventPayload,
  unauthorized,
  verifyWebhookSecret,
  type HasuraEventPayload,
  type RosterRow,
} from './_lib/auth.js';
import { graphqlRaw } from './_lib/graphql.js';
import { normalizeVisibilityForAffiliation } from './_lib/airlineClaim.js';

interface ProfileRow {
  profiles_by_pk: {
    default_visibility: string;
    airline_id: string | null;
  } | null;
}

interface UserRosters {
  rosters: RosterRow[];
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

async function recomputePresenceForUser(userId: string) {
  const profileData = await graphqlRaw<ProfileRow>(
    `
      query Profile($userId: uuid!) {
        profiles_by_pk(user_id: $userId) {
          default_visibility
          airline_id
        }
      }
    `,
    { userId },
  );

  const profile = profileData.profiles_by_pk;
  const visibility = normalizeVisibilityForAffiliation(
    profile?.default_visibility ?? 'friends',
    profile?.airline_id,
  );

  if (visibility === 'off') {
    await graphqlRaw(
      `
        mutation ClearPresence($userId: uuid!) {
          delete_presence(where: { user_id: { _eq: $userId } }) {
            affected_rows
          }
        }
      `,
      { userId },
    );
    return { affectedRows: 0, visibility };
  }

  const rosterData = await graphqlRaw<UserRosters>(
    `
      query UserRosters($userId: uuid!) {
        rosters(where: { user_id: { _eq: $userId } }) {
          id
          layover_city
          layover_start
          layover_end
        }
      }
    `,
    { userId },
  );

  await graphqlRaw(
    `
      mutation ClearPresence($userId: uuid!) {
        delete_presence(where: { user_id: { _eq: $userId } }) {
          affected_rows
        }
      }
    `,
    { userId },
  );

  const objects = rosterData.rosters
    .filter((row) => row.layover_city && row.layover_start)
    .map((row) => ({
      user_id: userId,
      city: row.layover_city,
      date_start: toDateOnly(row.layover_start),
      date_end: toDateOnly(row.layover_end ?? row.layover_start),
      visibility,
      roster_id: row.id,
    }))
    .filter((row) => row.date_start && row.date_end);

  if (objects.length === 0) {
    return { affectedRows: 0, visibility };
  }

  const insertResult = await graphqlRaw<{ insert_presence: { affected_rows: number } }>(
    `
      mutation InsertPresence($objects: [presence_insert_input!]!) {
        insert_presence(objects: $objects) {
          affected_rows
        }
      }
    `,
    { objects },
  );

  return {
    affectedRows: insertResult.insert_presence.affected_rows,
    visibility,
  };
}

function resolveUserId(payload: HasuraEventPayload<RosterRow>): string | null {
  const op = payload.event.op;
  if (op === 'DELETE') {
    return payload.event.data.old?.user_id ?? null;
  }
  return payload.event.data.new?.user_id ?? null;
}

export default async function presenceCompute(req: Request, res: Response) {
  if (!verifyWebhookSecret(req)) {
    return unauthorized(res);
  }

  if (!isHasuraEventPayload<RosterRow>(req.body)) {
    return res.status(400).json({ message: 'Invalid Hasura event payload' });
  }

  try {
    const userId = resolveUserId(req.body);
    if (!userId) {
      return res.status(400).json({ message: 'Could not resolve roster user_id' });
    }

    const result = await recomputePresenceForUser(userId);
    return res.status(200).json({
      message: 'Presence recomputed',
      userId,
      ...result,
    });
  } catch (error) {
    console.error('presence-compute error', error);
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to recompute presence',
    });
  }
}
