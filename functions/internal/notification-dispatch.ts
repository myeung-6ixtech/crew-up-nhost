import type { Request, Response } from 'express';
import {
  isDigestCron,
  isHasuraEventPayload,
  unauthorized,
  verifyWebhookSecret,
  type HasuraEventPayload,
  type MessageRow,
} from '../_lib/auth.js';
import { sendPushNotices } from '../_lib/expoPush.js';
import { graphqlRaw } from '../_lib/graphql.js';
import { lookupSenderName } from '../_lib/connectionRequests.js';
import { POKE_TITLE, pokeBody, pokeSenderName } from '../_lib/pokeNotice.js';
import { digestBody, digestDue, digestSince, digestZone } from '../_lib/digestTiming.js';

interface ThreadParticipants {
  thread_participants: Array<{ user_id: string }>;
}

async function notifyMessageParticipants(message: MessageRow) {
  const participants = await graphqlRaw<ThreadParticipants>(
    `
      query Participants($threadId: uuid!) {
        thread_participants(where: { thread_id: { _eq: $threadId } }) {
          user_id
        }
      }
    `,
    { threadId: message.thread_id },
  );

  const recipients = participants.thread_participants
    .map((participant) => participant.user_id)
    .filter((userId) => userId !== message.sender_id);

  if (recipients.length === 0) {
    return { inserted: 0 };
  }

  const row = message as MessageRow & { kind?: string; meta?: { city?: string | null } | null };
  const wave = row.kind === 'wave';
  // A poke between friends names who poked and where: "Sam poked you · Tokyo layover".
  const pokeText = wave ? pokeBody(pokeSenderName(await lookupSenderName(message.sender_id)), row.meta) : null;
  const objects = recipients.map((userId) => ({
    user_id: userId,
    type: 'message',
    title: wave ? POKE_TITLE : 'New message',
    body: pokeText ?? 'New message',
    payload: {
      thread_id: message.thread_id,
      message_id: message.id,
      sender_id: message.sender_id,
      ...(wave ? { poke: true } : {}),
    },
  }));

  const result = await graphqlRaw<{ insert_notifications: { affected_rows: number } }>(
    `
      mutation InsertNotifications($objects: [notifications_insert_input!]!) {
        insert_notifications(objects: $objects) {
          affected_rows
        }
      }
    `,
    { objects },
  );

  try {
    await sendPushNotices(
      objects.map((object) => ({
        userId: object.user_id,
        title: object.title,
        body: object.body,
        includeDigest: wave,
        data: {
          type: wave ? 'poke' : 'message',
          threadId: message.thread_id,
          url: `crewup://messages/${message.thread_id}`,
        },
      })),
    );
  } catch (error) {
    console.error('notification-dispatch: push failed', error);
  }

  return { inserted: result.insert_notifications.affected_rows };
}

type DigestProfile = {
  user_id: string;
  time_zone: string | null;
  last_digest_at: string | null;
  base_airport_iata: string | null;
};

/**
 * Hourly. For each digest user it is now 8 AM for (their device zone, else their base airport's, else UTC), and who
 * hasn't had one in 20 hours: count notifications that are new since the last digest (not the digests themselves,
 * no cap), and send one push if there are any.
 */
async function runDigestBatch() {
  const now = new Date();
  const { profiles } = await graphqlRaw<{ profiles: DigestProfile[] }>(
    `
      query DigestProfiles {
        profiles(where: { notification_mode: { _eq: "digest" } }) {
          user_id
          time_zone
          last_digest_at
          base_airport_iata
        }
      }
    `,
  );
  const airportCodes = [...new Set(profiles.map((profile) => profile.base_airport_iata).filter((code): code is string => Boolean(code)))];
  const zones = new Map<string, string | null>();
  if (airportCodes.length) {
    const { airports } = await graphqlRaw<{ airports: Array<{ iata: string; tz: string | null }> }>(
      `query AirportZones($codes: [String!]!) { airports(where: { iata: { _in: $codes } }) { iata tz } }`,
      { codes: airportCodes },
    );
    for (const airport of airports) zones.set(airport.iata, airport.tz);
  }

  let sent = 0;
  for (const profile of profiles) {
    const zone = digestZone(profile.time_zone, profile.base_airport_iata ? zones.get(profile.base_airport_iata) : null);
    if (!digestDue(now, zone, profile.last_digest_at)) continue;

    const since = digestSince(now, profile.last_digest_at);
    const counted = await graphqlRaw<{ notifications_aggregate: { aggregate: { count: number } } }>(
      `
        query NewSinceDigest($userId: uuid!, $since: timestamptz!) {
          notifications_aggregate(
            where: {
              user_id: { _eq: $userId }
              read_at: { _is_null: true }
              created_at: { _gt: $since }
              _not: { payload: { _contains: { mode: "digest" } } }
            }
          ) {
            aggregate {
              count
            }
          }
        }
      `,
      { userId: profile.user_id, since },
    );
    const count = counted.notifications_aggregate.aggregate.count;
    if (count === 0) continue;

    const body = digestBody(count);
    // Saved already read: the digest is a nudge, not something else to clear, and never counted by the next one.
    await graphqlRaw(
      `
        mutation DigestNotification($object: notifications_insert_input!, $userId: uuid!, $at: timestamptz!) {
          insert_notifications_one(object: $object) {
            id
          }
          update_profiles_by_pk(pk_columns: { user_id: $userId }, _set: { last_digest_at: $at }) {
            user_id
          }
        }
      `,
      {
        userId: profile.user_id,
        at: now.toISOString(),
        object: {
          user_id: profile.user_id,
          type: 'beacon',
          title: 'Your CrewUp digest',
          body,
          read_at: now.toISOString(),
          payload: { mode: 'digest', new_count: count },
        },
      },
    );

    try {
      await sendPushNotices([
        {
          userId: profile.user_id,
          title: 'Your CrewUp digest',
          body,
          data: { type: 'beacon', url: 'crewup://messages' },
          includeDigest: true,
        },
      ]);
    } catch (error) {
      console.error('notification-dispatch: digest push failed', error);
    }
    sent += 1;
  }

  return { digestUsers: profiles.length, sent };
}

export default async function notificationDispatch(req: Request, res: Response) {
  if (!verifyWebhookSecret(req)) {
    return unauthorized(res);
  }

  try {
    if (isDigestCron(req)) {
      const digest = await runDigestBatch();
      return res.status(200).json({ message: 'Digest batch processed', ...digest });
    }

    if (!isHasuraEventPayload<MessageRow>(req.body)) {
      return res.status(400).json({ message: 'Invalid Hasura event payload' });
    }

    const message = req.body.event.data.new;
    if (!message) {
      return res.status(200).json({ message: 'No new message payload' });
    }

    const result = await notifyMessageParticipants(message);
    return res.status(200).json({ message: 'Message notifications dispatched', ...result });
  } catch (error) {
    console.error('internal/notification-dispatch error', error);
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to dispatch notifications',
    });
  }
}
