export type RosterErrorCode =
  | 'ROSTER_PARSER_UNAVAILABLE'
  | 'ROSTER_PARSER_TIMEOUT'
  | 'ROSTER_PARSER_BUSY'
  | 'ROSTER_PARSE_INVALID'
  | 'ROSTER_TEXT_UNAVAILABLE'
  | 'ROSTER_FILE_TOO_LARGE'
  | 'ROSTER_FILE_UNSUPPORTED';

/** Failure with a stable code the app maps to user-facing copy. The message is for logs only. */
export class RosterImportError extends Error {
  readonly code: RosterErrorCode;
  readonly statusCode: number;

  constructor(code: RosterErrorCode, message: string, statusCode = 422) {
    super(message);
    this.name = 'RosterImportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
