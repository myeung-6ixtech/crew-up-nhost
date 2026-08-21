import { createHmac, timingSafeEqual } from 'node:crypto';

export interface FlightSelectionPayload {
  flightNumber: string;
  airlineIata?: string | null;
  serviceDate: string;
  departureAirport: string;
  arrivalAirport: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  provider?: string | null;
  providerFlightId?: string | null;
  exp: number;
}

function signingSecret(): string {
  const secret = process.env.FLIGHT_SELECTION_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error('FLIGHT_SELECTION_SIGNING_SECRET is not configured');
  }
  return secret;
}

function encodePayload(payload: FlightSelectionPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function sign(encoded: string): string {
  return createHmac('sha256', signingSecret()).update(encoded).digest('base64url');
}

export function createFlightSelectionToken(
  payload: Omit<FlightSelectionPayload, 'exp'>,
  ttlMs = 30 * 60 * 1000,
): string {
  const full: FlightSelectionPayload = {
    ...payload,
    exp: Date.now() + ttlMs,
  };
  const encoded = encodePayload(full);
  return `${encoded}.${sign(encoded)}`;
}

export function verifyFlightSelectionToken(token: string): FlightSelectionPayload {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) {
    throw new Error('INVALID_FLIGHT_SELECTION');
  }

  const expected = sign(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('INVALID_FLIGHT_SELECTION');
  }

  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as FlightSelectionPayload;
  if (!payload.exp || payload.exp < Date.now()) {
    throw new Error('FLIGHT_SELECTION_EXPIRED');
  }

  return payload;
}

export function normalizeFlightNumber(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

export function normalizeIata(value: string): string {
  return value.trim().toUpperCase();
}

export function serviceDateFromIso(iso: string): string {
  return iso.slice(0, 10);
}
