import type { Request, Response } from 'express';
import {
  DELETE_CONFIRM_WORD,
  GRACE_PERIOD_DAYS,
  asAdmin,
  assertTokenValid,
  isPending,
  passwordMatches,
  purgeAfter,
  type DeletionRow,
} from '../../_lib/accountDeletion.js';
import { requireUser } from '../../_lib/auth.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';

type Target = {
  user: { email: string | null; passwordHash: string | null } | null;
  profiles_by_pk: { default_visibility: string | null } | null;
  account_deletions_by_pk: DeletionRow | null;
};

async function loadTarget(userId: string): Promise<Target> {
  return asAdmin<Target>(
    `query DeletionTarget($id: uuid!) {
      user(id: $id) { email passwordHash }
      profiles_by_pk(user_id: $id) { default_visibility }
      account_deletions_by_pk(user_id: $id) { user_id purge_after cancelled_at purged_at previous_visibility }
    }`,
    { id: userId },
  );
}

/**
 * GET  /v1/client/account/delete → `{ requiresPassword, graceDays, pending }` for the confirm screen.
 * POST /v1/client/account/delete  { confirm: "DELETE", password? }
 *   Schedules deletion in 30 days and hides the person now: profile hidden, upcoming meets they host
 *   cancelled, their RSVPs cancelled, every session signed out. Accounts with a password must re-enter it.
 */
export default async function deleteAccount(req: Request, res: Response) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization, userId } = requireUser(req);
    await assertTokenValid(authorization, userId);
    const target = await loadTarget(userId);
    if (!target.user) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    const requiresPassword = Boolean(target.user.passwordHash);
    const existing = target.account_deletions_by_pk;

    if (req.method === 'GET') {
      return res.status(200).json({
        requiresPassword,
        graceDays: GRACE_PERIOD_DAYS,
        pending: isPending(existing) ? { purgeAfter: existing!.purge_after } : null,
      });
    }

    if (req.body?.confirm !== DELETE_CONFIRM_WORD) {
      throw new HttpError(400, 'ACCOUNT_DELETE_CONFIRM_REQUIRED', `Type ${DELETE_CONFIRM_WORD} to confirm`);
    }
    if (requiresPassword) {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!password) throw new HttpError(400, 'ACCOUNT_DELETE_PASSWORD_REQUIRED', 'Enter your password');
      if (!target.user.email || !(await passwordMatches(target.user.email, password))) {
        throw new HttpError(403, 'ACCOUNT_DELETE_BAD_PASSWORD', "That password isn't right");
      }
    }

    const now = new Date();
    const previousVisibility = isPending(existing)
      ? existing!.previous_visibility
      : (target.profiles_by_pk?.default_visibility ?? null);
    const scheduled = isPending(existing) ? existing!.purge_after : purgeAfter(now);

    await asAdmin(
      `mutation ScheduleAccountDeletion($row: account_deletions_insert_input!, $id: uuid!, $now: timestamptz!) {
        insert_account_deletions_one(
          object: $row
          on_conflict: {
            constraint: account_deletions_pkey
            update_columns: [requested_at, purge_after, cancelled_at, purged_at, previous_visibility]
          }
        ) { user_id }
        update_profiles(where: { user_id: { _eq: $id } }, _set: { default_visibility: "off" }) { affected_rows }
        update_events(
          where: { creator_id: { _eq: $id }, starts_at: { _gt: $now }, cancelled_at: { _is_null: true } }
          _set: { cancelled_at: $now }
        ) { affected_rows }
        update_event_attendees(
          where: { user_id: { _eq: $id }, status: { _in: ["going", "waitlisted"] }, event: { starts_at: { _gt: $now } } }
          _set: { status: "cancelled" }
        ) { affected_rows }
        deleteAuthRefreshTokens(where: { userId: { _eq: $id } }) { affected_rows }
      }`,
      {
        id: userId,
        now: now.toISOString(),
        row: {
          user_id: userId,
          requested_at: now.toISOString(),
          purge_after: scheduled,
          cancelled_at: null,
          purged_at: null,
          previous_visibility: previousVisibility,
        },
      },
    );

    return res.status(200).json({ purgeAfter: scheduled });
  } catch (error) {
    return sendClientError(res, error, 'client/account/delete', 'ACCOUNT_DELETE_FAILED');
  }
}
