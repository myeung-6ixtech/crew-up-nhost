import type { Request, Response } from 'express';
import { badRequest, requireAuthorization, unauthorized } from '../_lib/auth.js';
import { graphqlAsUser } from '../_lib/graphql.js';
import { RosterImportError } from '../_lib/rosterErrors.js';
import { extractRosterDuties, rosterLlmConfig, type RosterLlmInput } from '../_lib/rosterLlm.js';
import { extractPdfText } from '../_lib/rosterPdf.js';
import { redactRosterText } from '../_lib/rosterRedact.js';
import { PARSER_VERSION, layoversFromExtraction } from '../_lib/rosterSchema.js';
import { downloadFileAsUser } from '../_lib/storage.js';

interface ActionPayload {
  action: { name: string };
  input: { fileId: string };
  session_variables: Record<string, string>;
}

interface StorageFileRow {
  files_by_pk: {
    id: string;
    bucket_id: string;
    name: string;
    mime_type: string | null;
  } | null;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 20;
/** Below this, a PDF is treated as a scan with no usable text layer. */
const MIN_TEXT_CHARS = 200;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

function log(level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown> = {}) {
  console[level](JSON.stringify({ scope: 'client/roster-parse', event, ...details }));
}

/** Hasura surfaces `message` and `extensions` from a non-2xx action response as the GraphQL error. */
function rosterError(res: Response, error: RosterImportError) {
  return res.status(error.statusCode).json({
    message: error.message,
    extensions: { code: error.code },
  });
}

async function modelInput(
  bytes: Buffer,
  mimeType: string,
  allowRawFiles: boolean,
): Promise<{ input: RosterLlmInput; pages: number | null; redactedLines: number }> {
  if (mimeType === 'application/pdf') {
    let extracted: { text: string; pages: number };
    try {
      extracted = await extractPdfText(bytes, MAX_PDF_PAGES);
    } catch (error) {
      if (error instanceof RosterImportError) throw error;
      throw new RosterImportError('ROSTER_PARSE_INVALID', 'PDF could not be opened');
    }

    if (extracted.text.replace(/\s/g, '').length >= MIN_TEXT_CHARS) {
      const { text, redactedLines } = redactRosterText(extracted.text);
      return { input: { kind: 'text', text }, pages: extracted.pages, redactedLines };
    }
    if (allowRawFiles) {
      return { input: { kind: 'file', mimeType, bytes }, pages: extracted.pages, redactedLines: 0 };
    }
    throw new RosterImportError('ROSTER_TEXT_UNAVAILABLE', 'PDF has no text layer');
  }

  if (IMAGE_MIME_TYPES.has(mimeType)) {
    if (allowRawFiles) {
      return { input: { kind: 'file', mimeType, bytes }, pages: null, redactedLines: 0 };
    }
    throw new RosterImportError('ROSTER_TEXT_UNAVAILABLE', 'Image rosters need raw file mode');
  }

  throw new RosterImportError('ROSTER_FILE_UNSUPPORTED', `Unsupported type ${mimeType}`, 415);
}

export default async function rosterParse(req: Request, res: Response) {
  const startedAt = Date.now();
  try {
    const authorization = requireAuthorization(req);
    const payload = req.body as ActionPayload;
    const fileId = payload?.input?.fileId;

    if (!fileId) {
      return badRequest(res, 'fileId is required');
    }

    const data = await graphqlAsUser<StorageFileRow>(
      `
        query GetFile($id: uuid!) {
          files_by_pk(id: $id) {
            id
            bucket_id
            name
            mime_type
          }
        }
      `,
      authorization,
      { id: fileId },
    );

    const file = data.files_by_pk;
    if (!file) {
      return res.status(404).json({ message: 'File not found or not accessible' });
    }

    if (file.bucket_id !== 'rosters') {
      return badRequest(res, 'File must be uploaded to the rosters bucket');
    }

    const config = rosterLlmConfig();
    if (!config.enabled) {
      throw new RosterImportError('ROSTER_PARSER_UNAVAILABLE', 'Roster LLM is not configured', 503);
    }

    const mimeType = (file.mime_type ?? '').toLowerCase();
    if (mimeType !== 'application/pdf' && !IMAGE_MIME_TYPES.has(mimeType)) {
      throw new RosterImportError('ROSTER_FILE_UNSUPPORTED', `Unsupported type ${mimeType}`, 415);
    }

    const bytes = await downloadFileAsUser(file.id, authorization, MAX_FILE_BYTES);
    const { input, pages, redactedLines } = await modelInput(bytes, mimeType, config.allowRawFiles);
    const result = await extractRosterDuties(input);
    const entries = layoversFromExtraction(result.extraction);

    log('info', 'parsed', {
      parser: PARSER_VERSION,
      model: result.model,
      inputKind: input.kind,
      pages,
      redactedLines,
      duties: result.extraction.duties.length,
      layovers: entries.length,
      warnings: result.extraction.warnings.length,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startedAt,
    });

    return res.status(200).json({ sourceFileId: file.id, entries });
  } catch (error) {
    if (error instanceof RosterImportError) {
      log('warn', 'parse_failed', { code: error.code, reason: error.message, latencyMs: Date.now() - startedAt });
      return rosterError(res, error);
    }
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }

    log('error', 'parse_error', { reason: error instanceof Error ? error.message : 'unknown' });
    return res.status(500).json({ message: 'Failed to parse roster' });
  }
}
