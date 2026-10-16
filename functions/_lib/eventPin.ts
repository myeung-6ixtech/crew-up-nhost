import type { Response } from 'express';
import { randomInt, timingSafeEqual } from 'node:crypto';

/** Same alphabet as public.generate_event_pin(): no 0, O, 1, I or L. */
export const PIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PIN_LENGTH = 6;
export const MAX_FAILED_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export class EventPinError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly extra?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'EventPinError';
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

export function sendEventPinError(res: Response, error: EventPinError) {
  return res.status(error.statusCode).json({ error: { code: error.code, message: error.message, ...error.extra } });
}

/** Accepts what people paste or type: any case, with a dash or spaces (`k7p-q4x`, `K7P Q4X`). */
export function normalizePin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const pin = value.toUpperCase().replace(/[\s-]/g, '');
  if (pin.length !== PIN_LENGTH) return null;
  for (const char of pin) {
    if (!PIN_ALPHABET.includes(char)) return null;
  }
  return pin;
}

export function pinsMatch(entered: string, stored: string): boolean {
  const a = Buffer.from(entered);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generatePin(): string {
  let pin = '';
  for (let i = 0; i < PIN_LENGTH; i += 1) pin += PIN_ALPHABET[randomInt(PIN_ALPHABET.length)];
  return pin;
}

/**
 * Seconds until the oldest failed attempt in the window expires, once `MAX_FAILED_ATTEMPTS` is reached;
 * 0 when another attempt is allowed.
 */
export function lockoutSeconds(failedAt: string[], now = Date.now()): number {
  const recent = failedAt
    .map((value) => new Date(value).getTime())
    .filter((time) => now - time < ATTEMPT_WINDOW_MS)
    .sort((a, b) => a - b);
  if (recent.length < MAX_FAILED_ATTEMPTS) return 0;
  const unlocksAt = recent[recent.length - MAX_FAILED_ATTEMPTS] + ATTEMPT_WINDOW_MS;
  return Math.max(1, Math.ceil((unlocksAt - now) / 1000));
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
