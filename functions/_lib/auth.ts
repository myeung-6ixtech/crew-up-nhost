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

export interface UserTripRow {
  id: string;
  user_id: string;
  title?: string | null;
  source?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  visibility?: string | null;
  is_active?: boolean | null;
  idempotency_key?: string | null;
}

export interface TripStayRow {
  id: string;
  trip_id: string;
  city: string;
  airport_iata?: string | null;
  starts_at: string;
  ends_at: string;
}

export interface TripFlightLegRow {
  id: string;
  trip_id: string;
  flight_instance_id: string;
  sequence_number: number;
}

export interface FlightInstanceRow {
  id: string;
  airline_iata?: string | null;
  flight_number: string;
  service_date: string;
  departure_airport: string;
  arrival_airport: string;
  scheduled_departure: string;
  scheduled_arrival: string;
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

const HASURA_CLAIMS_KEY = 'https://hasura.io/jwt/claims';

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.replace(/^Bearer /, '').split('.');
  if (parts.length < 2) return null;

  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getAllowedRolesFromToken(token: string): string[] {
  const payload = decodeJwtPayload(token);
  const claims = payload?.[HASURA_CLAIMS_KEY] as Record<string, unknown> | undefined;
  const allowedRoles = claims?.['x-hasura-allowed-roles'];

  if (Array.isArray(allowedRoles)) {
    return allowedRoles.filter((role): role is string => typeof role === 'string');
  }

  if (typeof allowedRoles === 'string') {
    return [allowedRoles];
  }

  return [];
}

export function requireStaffAdmin(req: Request): { authorization: string; userId: string } {
  const authorization = requireAuthorization(req);
  const token = authorization.replace(/^Bearer /, '');
  const roles = getAllowedRolesFromToken(token);

  if (!roles.includes('staff_admin')) {
    throw new Error('Staff admin role required');
  }

  const payload = decodeJwtPayload(token);
  const claims = payload?.[HASURA_CLAIMS_KEY] as Record<string, unknown> | undefined;
  const userId = claims?.['x-hasura-user-id'];

  if (typeof userId !== 'string') {
    throw new Error('Invalid token');
  }

  return { authorization, userId };
}

export function requireUser(req: Request): { authorization: string; userId: string } {
  const authorization = requireAuthorization(req);
  const token = authorization.replace(/^Bearer /, '');
  const payload = decodeJwtPayload(token);
  const claims = payload?.[HASURA_CLAIMS_KEY] as Record<string, unknown> | undefined;
  const userId = claims?.['x-hasura-user-id'];
  const defaultRole = claims?.['x-hasura-default-role'];

  if (typeof userId !== 'string') {
    throw new Error('Invalid token');
  }

  const roles = getAllowedRolesFromToken(token);
  if (
    !roles.includes('user') &&
    !roles.includes('me') &&
    defaultRole !== 'user' &&
    defaultRole !== 'me'
  ) {
    throw new Error('User role required');
  }

  return { authorization, userId };
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
