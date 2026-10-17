import type { Request, Response } from 'express';
import { GUIDELINES_VERSION } from '../../_shared/index.js';
import { assertTokenValid } from '../../_lib/accountDeletion.js';
import { requireUser } from '../../_lib/auth.js';
import { graphqlAsAdmin } from '../../_lib/graphql.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';

/**
 * POST /v1/client/legal/accept — records that the caller accepted the current community guidelines and
 * Terms of Use. Used by the acceptance sheet for accounts that finished onboarding on an older version
 * (or through the alpha/beta flows). Launched onboarding records it in client/onboarding/complete.
 */
export default async function acceptGuidelines(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization, userId } = requireUser(req);
    await assertTokenValid(authorization, userId);

    const version = (req.body as { version?: unknown } | undefined)?.version;
    if (version !== GUIDELINES_VERSION) {
      throw new HttpError(409, 'GUIDELINES_VERSION_MISMATCH', 'Update the app to see the latest guidelines', {
        currentVersion: GUIDELINES_VERSION,
      });
    }

    const now = new Date().toISOString();
    const data = await graphqlAsAdmin<{ update_onboarding_state_by_pk: { user_id: string } | null }>(
      `mutation AcceptGuidelines($userId: uuid!, $version: String!, $now: timestamptz!) {
        update_onboarding_state_by_pk(
          pk_columns: { user_id: $userId }
          _set: { guidelines_accepted_version: $version, guidelines_accepted_at: $now }
        ) { user_id }
      }`,
      { userId, version, now },
    );
    if (!data.update_onboarding_state_by_pk) {
      throw new HttpError(409, 'ONBOARDING_STATE_MISSING', 'Finish setting up your account first');
    }

    return res.status(200).json({ version, acceptedAt: now });
  } catch (error) {
    return sendClientError(res, error, 'client/legal/accept', 'GUIDELINES_ACCEPT_FAILED');
  }
}
