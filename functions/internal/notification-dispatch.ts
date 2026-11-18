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

interface ThreadParticipants {
  thread_participants: Array<{ user_id: string }>;
}

interface DigestProfiles {
  profiles: Array<{ user_id: string }>;
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

async function runDigestBatch() {
  const profiles = await graphqlRaw<DigestProfiles>(
    `
      query DigestProfiles {
        profiles(where: { notification_mode: { _eq: "digest" } }) {
          user_id
        }
      }
    `,
  );

  let inserted = 0;
  for (const profile of profiles.profiles) {
    const unread = await graphqlRaw<{ notifications: Array<{ id: string }> }>(
      `
        query Unread($userId: uuid!) {
          notifications(
            where: { user_id: { _eq: $userId }, read_at: { _is_null: true } }
            limit: 20
          ) {
            id
          }
        }
      `,
      { userId: profile.user_id },
    );

    if (unread.notifications.length === 0) {
      continue;
    }

    await graphqlRaw(
      `
        mutation DigestNotification($object: notifications_insert_input!) {
          insert_notifications_one(object: $object) {
            id
          }
        }
      `,
      {
        object: {
          user_id: profile.user_id,
          type: 'beacon',
          title: 'Your CrewUp digest',
          body: `You have ${unread.notifications.length} unread notifications`,
          payload: {
            mode: 'digest',
            unread_count: unread.notifications.length,
          },
        },
      },
    );

    try {
      await sendPushNotices([
        {
          userId: profile.user_id,
          title: 'Your CrewUp digest',
          body: `You have ${unread.notifications.length} unread notifications`,
          data: { type: 'beacon', url: 'crewup://messages' },
          includeDigest: true,
        },
      ]);
    } catch (error) {
      console.error('notification-dispatch: digest push failed', error);
    }

    inserted += 1;
  }

  return { digestUsers: profiles.profiles.length, inserted };
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
