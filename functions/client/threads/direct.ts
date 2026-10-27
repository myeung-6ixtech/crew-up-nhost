import type { Request, Response } from 'express';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';
import { getPairConnection, isBlockedBetween } from '../../_lib/connectionRequests.js';
import { graphqlRaw } from '../../_lib/graphql.js';
import { OnboardingError, assertOnboarded, sendOnboardingError } from '../../_lib/onboarding.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class DirectThreadError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'DirectThreadError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function findDirectThread(userId: string, otherUserId: string): Promise<string | null> {
  const data = await graphqlRaw<{ threads: Array<{ id: string }> }>(
    `
      query ExistingDirectThread($userId: uuid!, $otherUserId: uuid!) {
        threads(
          where: {
            type: { _eq: direct }
            _and: [
              { participants: { user_id: { _eq: $userId } } }
              { participants: { user_id: { _eq: $otherUserId } } }
            ]
          }
          order_by: { created_at: asc }
          limit: 1
        ) {
          id
        }
      }
    `,
    { userId, otherUserId },
  );
  return data.threads[0]?.id ?? null;
}

async function createDirectThread(userId: string, otherUserId: string): Promise<string> {
  const data = await graphqlRaw<{ insert_threads_one: { id: string } | null }>(
    `
      mutation CreateDirectThread($object: threads_insert_input!) {
        insert_threads_one(object: $object) {
          id
        }
      }
    `,
    {
      object: {
        type: 'direct',
        participants: {
          data: [{ user_id: userId }, { user_id: otherUserId }],
        },
      },
    },
  );
  const threadId = data.insert_threads_one?.id;
  if (!threadId) {
    throw new DirectThreadError(500, 'THREAD_FAILED', 'Could not open this chat');
  }
  return threadId;
}

/**
 * POST /v1/client/threads/direct — `{ user_id }`.
 * Returns the direct thread shared by the caller and that friend, creating it with both participants.
 * The user role cannot insert the other person: thread_participants forces user_id to the caller.
 */
export default async function openDirectThread(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    await assertOnboarded(userId);
    const otherUserId = typeof req.body?.user_id === 'string' ? req.body.user_id.trim() : '';
    if (!UUID_PATTERN.test(otherUserId)) {
      return badRequest(res, 'user_id is required');
    }
    if (otherUserId === userId) {
      throw new DirectThreadError(400, 'SELF', 'You cannot message yourself');
    }

    const connection = await getPairConnection(userId, otherUserId);
    if (!connection || connection.status !== 'accepted') {
      throw new DirectThreadError(403, 'NOT_FRIENDS', 'You can message someone after they accept your request');
    }
    if (await isBlockedBetween(userId, otherUserId)) {
      throw new DirectThreadError(403, 'BLOCKED', 'Unable to open this chat');
    }

    const existing = await findDirectThread(userId, otherUserId);
    const threadId = existing ?? (await createDirectThread(userId, otherUserId));
    return res.status(existing ? 200 : 201).json({ thread_id: threadId });
  } catch (error) {
    if (error instanceof OnboardingError) return sendOnboardingError(res, error);
    if (error instanceof DirectThreadError) {
      return res.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }
    if (error instanceof Error && error.message.includes('User role')) {
      return res.status(403).json({ message: error.message });
    }
    console.error('client/threads/direct error', error);
    return res.status(500).json({
      error: { code: 'THREAD_FAILED', message: 'Could not open this chat' },
    });
  }
}
