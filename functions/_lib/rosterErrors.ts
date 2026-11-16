export type RosterErrorCode =
  | 'ROSTER_PARSER_UNAVAILABLE'
  | 'ROSTER_PARSER_TIMEOUT'
  | 'ROSTER_PARSER_BUSY'
  | 'ROSTER_PARSE_INVALID'
  | 'ROSTER_TEXT_UNAVAILABLE'
  | 'ROSTER_FILE_TOO_LARGE'
  | 'ROSTER_FILE_UNSUPPORTED'
  | 'ROSTER_CONSENT_REQUIRED';

/** Failure with a stable code the app maps to user-facing copy. The message is for logs only. */
export class RosterImportError extends Error {
  readonly code: RosterErrorCode;
  readonly statusCode: number;
  /** A busy or flaky provider: the app may try the same file again. Never shown to the user. */
  readonly retryable: boolean;
  /** From the provider's Retry-After, when it sent one. */
  readonly retryAfterSeconds: number | null;
  /** The provider's HTTP status (or the code in an error body), for logs. */
  readonly providerStatus: number | null;

  constructor(
    code: RosterErrorCode,
    message: string,
    statusCode = 422,
    options: { retryable?: boolean; retryAfterSeconds?: number | null; providerStatus?: number | null } = {},
  ) {
    super(message);
    this.name = 'RosterImportError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.providerStatus = options.providerStatus ?? null;
  }
}
