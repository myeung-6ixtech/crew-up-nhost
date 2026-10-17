import type { Request, Response } from 'express';
import { asAdmin, isPending, type DeletionRow } from '../../_lib/accountDeletion.js';
import { requireUser } from '../../_lib/auth.js';
import { graphqlAsUser } from '../../_lib/graphql.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';

/**
 * POST /v1/client/account/restore — "Keep my account" during the grace period.
 * Puts profile visibility back. Meets cancelled when deletion was requested stay cancelled.
 */
export default async function restoreAccount(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization, userId } = requireUser(req);
    let row: Pick<DeletionRow, 'purge_after' | 'cancelled_at' | 'purged_at'> | null;
    try {
      const data = await graphqlAsUser<{
        account_deletions_by_pk: Pick<DeletionRow, 'purge_after' | 'cancelled_at' | 'purged_at'> | null;
      }>(
        `query OwnDeletion($id: uuid!) { account_deletions_by_pk(user_id: $id) { purge_after cancelled_at purged_at } }`,
        authorization,
        { id: userId },
      );
      row = data.account_deletions_by_pk;
    } catch {
      throw new HttpError(401, 'UNAUTHORIZED', 'Sign in again to continue');
    }

    if (!isPending(row)) throw new HttpError(404, 'ACCOUNT_DELETE_NOT_PENDING', 'This account is not scheduled for deletion');
    if (new Date(row!.purge_after).getTime() <= Date.now()) {
      throw new HttpError(410, 'ACCOUNT_DELETE_EXPIRED', 'The 30 days have passed and this account is being deleted');
    }

    const full = await asAdmin<{ account_deletions_by_pk: Pick<DeletionRow, 'previous_visibility'> | null }>(
      `query DeletionVisibility($id: uuid!) { account_deletions_by_pk(user_id: $id) { previous_visibility } }`,
      { id: userId },
    );
    const visibility = full.account_deletions_by_pk?.previous_visibility ?? 'friends';

    await asAdmin(
      `mutation RestoreAccount($id: uuid!, $now: timestamptz!, $visibility: visibility_level!) {
        update_account_deletions_by_pk(pk_columns: { user_id: $id }, _set: { cancelled_at: $now }) { user_id }
        update_profiles(where: { user_id: { _eq: $id } }, _set: { default_visibility: $visibility }) { affected_rows }
      }`,
      { id: userId, now: new Date().toISOString(), visibility },
    );
    return res.status(200).json({ restored: true });
  } catch (error) {
    return sendClientError(res, error, 'client/account/restore', 'ACCOUNT_RESTORE_FAILED');
  }
}
