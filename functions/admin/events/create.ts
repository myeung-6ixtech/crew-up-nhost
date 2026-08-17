import type { Request, Response } from 'express';
import {
  badRequest,
  requireStaffAdmin,
  unauthorized,
} from '../../_lib/auth.js';
import { graphqlAsUser } from '../../_lib/graphql.js';

interface CreatePlatformEventBody {
  title: string;
  description?: string | null;
  city: string;
  venue_name?: string | null;
  venue_address?: string | null;
  starts_at: string;
  ends_at?: string | null;
  capacity?: number | null;
  languages?: string[];
  activity_ids?: string[];
  tags?: string[];
  is_published?: boolean;
  featured_until?: string | null;
}

function parseBody(body: unknown): CreatePlatformEventBody {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body is required');
  }

  const input = body as Record<string, unknown>;
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const city = typeof input.city === 'string' ? input.city.trim() : '';
  const startsAt = typeof input.starts_at === 'string' ? input.starts_at : '';

  if (!title || !city || !startsAt) {
    throw new Error('title, city, and starts_at are required');
  }

  return {
    title,
    description: typeof input.description === 'string' ? input.description : null,
    city,
    venue_name: typeof input.venue_name === 'string' ? input.venue_name : null,
    venue_address: typeof input.venue_address === 'string' ? input.venue_address : null,
    starts_at: startsAt,
    ends_at: typeof input.ends_at === 'string' ? input.ends_at : null,
    capacity: typeof input.capacity === 'number' ? input.capacity : null,
    languages: Array.isArray(input.languages)
      ? input.languages.filter((value): value is string => typeof value === 'string')
      : ['en'],
    activity_ids: Array.isArray(input.activity_ids)
      ? input.activity_ids.filter((value): value is string => typeof value === 'string')
      : [],
    tags: Array.isArray(input.tags)
      ? input.tags.filter((value): value is string => typeof value === 'string')
      : [],
    is_published: typeof input.is_published === 'boolean' ? input.is_published : true,
    featured_until: typeof input.featured_until === 'string' ? input.featured_until : null,
  };
}

export default async function createPlatformEvent(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization } = requireStaffAdmin(req);
    const input = parseBody(req.body);
    const publishedAt = input.is_published ? new Date().toISOString() : null;

    const eventResult = await graphqlAsUser<{
      insert_events_one: { id: string } | null;
    }>(
      `
        mutation CreatePlatformEvent($object: events_insert_input!) {
          insert_events_one(object: $object) {
            id
          }
        }
      `,
      authorization,
      {
        object: {
          title: input.title,
          description: input.description,
          city: input.city,
          venue_name: input.venue_name,
          venue_address: input.venue_address,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
          capacity: input.capacity,
          visibility_scope: 'all_verified',
          tags: input.tags ?? [],
          languages: input.languages ?? ['en'],
          host_type: 'platform',
          is_published: input.is_published ?? true,
          published_at: publishedAt,
          featured_until: input.featured_until,
        },
      },
      'staff_admin',
    );

    const eventId = eventResult.insert_events_one?.id;
    if (!eventId) {
      return res.status(500).json({ message: 'Failed to create platform event' });
    }

    if (input.activity_ids?.length) {
      await graphqlAsUser(
        `
          mutation InsertEventActivities($objects: [event_activities_insert_input!]!) {
            insert_event_activities(objects: $objects) {
              affected_rows
            }
          }
        `,
        authorization,
        {
          objects: input.activity_ids.map((activityId) => ({
            event_id: eventId,
            activity_id: activityId,
          })),
        },
        'staff_admin',
      );
    }

    const threadResult = await graphqlAsUser<{ threads: Array<{ id: string }> }>(
      `
        query EventThread($eventId: uuid!) {
          threads(where: { event_id: { _eq: $eventId } }, limit: 1) {
            id
          }
        }
      `,
      authorization,
      { eventId },
      'staff_admin',
    );

    return res.status(200).json({
      event_id: eventId,
      thread_id: threadResult.threads[0]?.id ?? null,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }

    if (error instanceof Error && error.message.includes('Staff admin')) {
      return res.status(403).json({ message: error.message });
    }

    if (error instanceof Error && (error.message.includes('required') || error.message.includes('body'))) {
      return badRequest(res, error.message);
    }

    console.error('admin/events/create error', error);
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to create platform event',
    });
  }
}
