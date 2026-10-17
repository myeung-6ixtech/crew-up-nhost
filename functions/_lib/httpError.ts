import type { Response } from 'express';

/** An expected client-facing failure: `{ error: { code, message, ...extra } }` with an HTTP status. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly extra?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

/** Maps HttpError and requireUser failures to their responses; anything else is logged and becomes a 500. */
export function sendClientError(res: Response, error: unknown, label: string, fallbackCode: string) {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ error: { code: error.code, message: error.message, ...error.extra } });
  }
  if (error instanceof Error && (error.message.includes('Authorization') || error.message === 'Invalid token')) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
  }
  if (error instanceof Error && error.message.includes('User role')) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: error.message } });
  }
  console.error(`${label} error`, error);
  return res.status(500).json({ error: { code: fallbackCode, message: 'Something went wrong. Try again.' } });
}
