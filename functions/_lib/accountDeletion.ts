import { graphqlAsAdmin, graphqlAsUser, nhostServiceUrl } from './graphql.js';
import { HttpError } from './httpError.js';
import { deleteFileAsAdmin } from './storage.js';

export const GRACE_PERIOD_DAYS = 30;
export const DELETE_CONFIRM_WORD = 'DELETE';
/** Purges per cron run, so one run stays well inside the function timeout. */
export const PURGE_BATCH = 20;

/** Auth tables and other people's rows are outside every client role, so deletion runs as Hasura admin. */
export function asAdmin<T>(query: string, variables?: Record<string, unknown>) {
  return graphqlAsAdmin<T>(query, variables, 'admin');
}

export function purgeAfter(from: Date = new Date()): string {
  return new Date(from.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Reads the caller as themselves, so Hasura verifies the token (requireUser only decodes it). */
export async function assertTokenValid(authorization: string, userId: string): Promise<void> {
  let ok = false;
  try {
    const data = await graphqlAsUser<{ user: { id: string } | null }>(
      `query VerifyCaller($id: uuid!) { user(id: $id) { id } }`,
      authorization,
      { id: userId },
    );
    ok = data.user?.id === userId;
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in again to continue');
}

/** True when Nhost Auth accepts the email and password. */
export async function passwordMatches(email: string, password: string): Promise<boolean> {
  const response = await fetch(`${nhostServiceUrl('auth')}/signin/email-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return response.ok;
}

export type DeletionRow = {
  user_id: string;
  purge_after: string;
  cancelled_at: string | null;
  purged_at: string | null;
  previous_visibility: string | null;
};

export function isPending(row: Pick<DeletionRow, 'cancelled_at' | 'purged_at'> | null | undefined): boolean {
  return Boolean(row && !row.cancelled_at && !row.purged_at);
}

/**
 * Removes everything that is the person's: their uploads, then their auth user (which cascades their
 * profile, trips, presence, connections, blocks, meets and notifications). Messages they sent stay in
 * other people's chats as "removed"; reports they filed stay with no reporter.
 */
export async function purgeAccount(userId: string, now: Date = new Date()): Promise<{ files: number }> {
  const files = await asAdmin<{ files: { id: string }[] }>(
    `query PurgeFiles($id: uuid!) { files(where: { uploadedByUserId: { _eq: $id } }) { id } }`,
    { id: userId },
  );
  for (const file of files.files) await deleteFileAsAdmin(file.id);

  await asAdmin(
    `mutation PurgeAccount($id: uuid!, $now: timestamptz!) {
      update_messages(
        where: { sender_id: { _eq: $id } }
        _set: { body: null, media_file_id: null, removed_at: $now }
      ) { affected_rows }
      deleteUser(id: $id) { id }
      update_account_deletions_by_pk(pk_columns: { user_id: $id }, _set: { purged_at: $now }) { user_id }
    }`,
    { id: userId, now: now.toISOString() },
  );
  return { files: files.files.length };
}
