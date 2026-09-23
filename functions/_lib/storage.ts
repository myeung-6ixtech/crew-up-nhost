import { nhostServiceUrl } from './graphql.js';
import { RosterImportError } from './rosterErrors.js';

/**
 * Downloads a Storage file with the caller's own token, so bucket permissions
 * decide access exactly as they do for the app.
 */
export async function downloadFileAsUser(
  fileId: string,
  authorization: string,
  maxBytes: number,
): Promise<Buffer> {
  const response = await fetch(`${nhostServiceUrl('storage')}/files/${encodeURIComponent(fileId)}`, {
    headers: { authorization },
  });

  if (!response.ok) {
    throw new Error(`Storage download failed with status ${response.status}`);
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    throw new RosterImportError('ROSTER_FILE_TOO_LARGE', `File is ${declared} bytes`, 413);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new RosterImportError('ROSTER_FILE_TOO_LARGE', `File is ${bytes.byteLength} bytes`, 413);
  }
  return bytes;
}
