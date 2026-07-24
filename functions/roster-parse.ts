import type { Request, Response } from 'express';
import {
  badRequest,
  requireAuthorization,
  unauthorized,
  type RosterParseEntry,
} from './_lib/auth.js';
import { graphqlAsUser } from './_lib/graphql.js';

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

function mockParseEntries(fileName: string): RosterParseEntry[] {
  const now = new Date();
  const start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 36 * 60 * 60 * 1000);

  return [
    {
      flightNumber: 'SQ123',
      departureAirport: 'SIN',
      arrivalAirport: 'BKK',
      layoverCity: 'Bangkok',
      layoverStart: start.toISOString(),
      layoverEnd: end.toISOString(),
    },
    {
      flightNumber: 'SQ124',
      departureAirport: 'BKK',
      arrivalAirport: 'SIN',
      layoverCity: 'Singapore',
      layoverStart: new Date(end.getTime() + 12 * 60 * 60 * 1000).toISOString(),
      layoverEnd: new Date(end.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    },
  ].map((entry) => ({
    ...entry,
    flightNumber: fileName.includes('mock') ? entry.flightNumber : entry.flightNumber,
  }));
}

export default async function rosterParse(req: Request, res: Response) {
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

    const ocrConfigured = Boolean(process.env.OCR_PROVIDER_API_KEY);
    const entries = mockParseEntries(file.name ?? 'roster');

    return res.status(200).json({
      sourceFileId: file.id,
      entries,
      parser: ocrConfigured ? 'mock-with-ocr-configured' : 'mock',
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }

    console.error('roster-parse error', error);
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to parse roster',
    });
  }
}
