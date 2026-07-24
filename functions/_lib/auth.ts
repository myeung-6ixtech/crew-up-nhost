import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface HasuraEventPayload<T = Record<string, unknown>> {
  created_at: string;
  delivery_info: {
    current_retry: number;
    max_retries: number;
  };
  event: {
    op: 'INSERT' | 'UPDATE' | 'DELETE' | 'MANUAL';
    data: {
      old: T | null;
      new: T | null;
    };
    session_variables: Record<string, string>;
    trace_context: Record<string, unknown>;
  };
  id: string;
  table: {
    name: string;
    schema: string;
  };
  trigger: {
    name: string;
  };
}

export interface RosterRow {
  id: string;
  user_id: string;
  flight_number?: string | null;
  departure_airport?: string | null;
  arrival_airport?: string | null;
  layover_city?: string | null;
  layover_start?: string | null;
  layover_end?: string | null;
  source?: string | null;
}

export interface RosterParseEntry {
  flightNumber?: string | null;
  departureAirport?: string | null;
  arrivalAirport?: string | null;
  layoverCity?: string | null;
  layoverStart?: string | null;
  layoverEnd?: string | null;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  sender_id: string;
  body?: string | null;
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function verifyWebhookSecret(req: Request): boolean {
  const provided = req.headers['nhost-webhook-secret'];
  const expected = process.env.NHOST_WEBHOOK_SECRET;

  if (typeof provided !== 'string' || !expected) {
    return false;
  }

  try {
    return timingSafeEqual(hash(provided), hash(expected));
  } catch {
    return false;
  }
}

export function requireAuthorization(req: Request): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  return header;
}

export function unauthorized(res: { status: (code: number) => { json: (body: unknown) => void } }) {
  return res.status(401).json({ message: 'Unauthorized' });
}

export function badRequest(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  message: string,
) {
  return res.status(400).json({ message });
}

export function isDigestCron(req: Request): boolean {
  return req.body?.payload?.mode === 'digest';
}

export function isHasuraEventPayload(body: unknown): body is HasuraEventPayload {
  return (
    typeof body === 'object' &&
    body !== null &&
    'event' in body &&
    'table' in body &&
    'trigger' in body
  );
}
