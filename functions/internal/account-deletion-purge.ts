import type { Request, Response } from 'express';
import { PURGE_BATCH, asAdmin, purgeAccount } from '../_lib/accountDeletion.js';
import { unauthorized, verifyWebhookSecret } from '../_lib/auth.js';
import { deleteFileAsAdmin } from '../_lib/storage.js';

/** roster-parse deletes files as it finishes; this catches uploads that were never parsed or whose delete failed. */
const ROSTER_FILE_MAX_AGE_MS = 60 * 60 * 1000;

async function sweepRosterFiles(now: Date): Promise<number> {
  const stale = await asAdmin<{ files: { id: string }[] }>(
    `query StaleRosterFiles($cutoff: timestamptz!) {
      files(where: { bucketId: { _eq: "rosters" }, createdAt: { _lt: $cutoff } }, limit: 500) { id }
    }`,
    { cutoff: new Date(now.getTime() - ROSTER_FILE_MAX_AGE_MS).toISOString() },
  );
  let deleted = 0;
  for (const { id } of stale.files) {
    try {
      await deleteFileAsAdmin(id);
      deleted += 1;
    } catch (error) {
      console.error('roster file sweep failed', id, error);
    }
  }
  return deleted;
}

/** Daily cron: purges accounts whose 30-day grace period has ended and deletes leftover roster files. Failures retry next run. */
export default async function accountDeletionPurge(req: Request, res: Response) {
  if (!verifyWebhookSecret(req)) {
    return unauthorized(res);
  }

  const now = new Date();
  const due = await asAdmin<{ account_deletions: { user_id: string }[] }>(
    `query DueDeletions($now: timestamptz!, $limit: Int!) {
      account_deletions(
        where: { purge_after: { _lte: $now }, cancelled_at: { _is_null: true }, purged_at: { _is_null: true } }
        order_by: { purge_after: asc }
        limit: $limit
      ) { user_id }
    }`,
    { now: now.toISOString(), limit: PURGE_BATCH },
  );

  let purged = 0;
  const failed: string[] = [];
  for (const { user_id } of due.account_deletions) {
    try {
      await purgeAccount(user_id, now);
      purged += 1;
    } catch (error) {
      console.error('account-deletion-purge failed', user_id, error);
      failed.push(user_id);
    }
  }

  const rosterFilesDeleted = await sweepRosterFiles(now).catch((error) => {
    console.error('roster file sweep failed', error);
    return 0;
  });

  return res.status(200).json({ due: due.account_deletions.length, purged, failed: failed.length, rosterFilesDeleted });
}
