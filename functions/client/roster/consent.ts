import type { Request, Response } from 'express';
import { assertTokenValid } from '../../_lib/accountDeletion.js';
import { requireUser } from '../../_lib/auth.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';
import { recordRosterConsent, rosterConsentInfo, storedRosterConsentVersion } from '../../_lib/rosterConsent.js';

/**
 * GET  /v1/client/roster/consent — the AI provider to name on the consent screen and whether the caller agreed to it.
 * POST /v1/client/roster/consent { version } — records agreement to that exact version.
 */
export default async function rosterConsent(req: Request, res: Response) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization, userId } = requireUser(req);
    await assertTokenValid(authorization, userId);
    const info = rosterConsentInfo();

    if (req.method === 'GET') {
      const stored = await storedRosterConsentVersion(userId);
      return res.status(200).json({
        enabled: info.enabled,
        providerName: info.providerName,
        version: info.version,
        consented: stored === info.version,
      });
    }

    const version = (req.body as { version?: unknown } | undefined)?.version;
    if (version !== info.version) {
      throw new HttpError(409, 'ROSTER_CONSENT_VERSION_MISMATCH', 'The AI service changed. Review the details again.', {
        providerName: info.providerName,
        currentVersion: info.version,
      });
    }
    await recordRosterConsent(userId, info.version);
    return res.status(200).json({ consented: true, version: info.version });
  } catch (error) {
    return sendClientError(res, error, 'client/roster/consent', 'ROSTER_CONSENT_FAILED');
  }
}
