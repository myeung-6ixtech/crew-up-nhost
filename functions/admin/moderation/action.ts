import type { Request, Response } from 'express';
import { requireStaffAdmin } from '../../_lib/auth.js';
import { graphqlAsAdmin, graphqlAsUser } from '../../_lib/graphql.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';

export const MODERATION_ACTIONS = ['reviewing', 'dismiss', 'resolve', 'remove_message', 'cancel_meet', 'disable_user'] as const;
type ModerationAction = (typeof MODERATION_ACTIONS)[number];

type ReportRow = {
  id: string;
  status: string;
  reason: string;
  reported_user_id: string | null;
  reported_message_id: string | null;
  reported_event_id: string | null;
};

function asAdmin<T>(query: string, variables?: Record<string, unknown>) {
  return graphqlAsAdmin<T>(query, variables, 'admin');
}

/**
 * POST /v1/admin/moderation/action — staff actions on a report from the crew-up-admin queue.
 * Runs as Hasura admin because staff_admin can't edit user-hosted meets, message bodies or auth sessions.
 * The staff role is verified by reading the report as staff_admin (requireStaffAdmin only decodes the token).
 */
export default async function moderationAction(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization, userId: actorId } = requireStaffAdmin(req);
    const body = (req.body ?? {}) as { reportId?: unknown; action?: unknown; note?: unknown };
    const reportId = typeof body.reportId === 'string' ? body.reportId : '';
    const action = body.action as ModerationAction;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
    if (!reportId || !MODERATION_ACTIONS.includes(action)) {
      throw new HttpError(400, 'MODERATION_BAD_REQUEST', 'reportId and a valid action are required');
    }

    let report: ReportRow | null;
    try {
      const data = await graphqlAsUser<{ reports_by_pk: ReportRow | null }>(
        `query ModerationReport($id: uuid!) {
          reports_by_pk(id: $id) { id status reason reported_user_id reported_message_id reported_event_id }
        }`,
        authorization,
        { id: reportId },
        'staff_admin',
      );
      report = data.reports_by_pk;
    } catch {
      throw new HttpError(403, 'FORBIDDEN', 'Staff admin role required');
    }
    if (!report) throw new HttpError(404, 'REPORT_NOT_FOUND', 'Report not found');

    const now = new Date().toISOString();
    let outcome = '';
    let targetUserId = report.reported_user_id;

    if (action === 'remove_message') {
      if (!report.reported_message_id) throw new HttpError(400, 'REPORT_HAS_NO_MESSAGE', 'This report is not about a message');
      const data = await asAdmin<{ update_messages_by_pk: { sender_id: string | null } | null }>(
        `mutation RemoveMessage($id: uuid!, $now: timestamptz!) {
          update_messages_by_pk(pk_columns: { id: $id }, _set: { body: null, media_file_id: null, removed_at: $now }) { sender_id }
        }`,
        { id: report.reported_message_id, now },
      );
      targetUserId ??= data.update_messages_by_pk?.sender_id ?? null;
      outcome = 'Message removed';
    }

    if (action === 'cancel_meet') {
      if (!report.reported_event_id) throw new HttpError(400, 'REPORT_HAS_NO_MEET', 'This report is not about a meet');
      await asAdmin(
        `mutation CancelReportedMeet($id: uuid!, $now: timestamptz!) {
          update_events_by_pk(pk_columns: { id: $id }, _set: { cancelled_at: $now }) { id }
        }`,
        { id: report.reported_event_id, now },
      );
      outcome = 'Meet cancelled';
    }

    if (action === 'disable_user') {
      // Roster feedback is filed against the reporter's own account.
      if (report.reason === 'roster_parse_issue') throw new HttpError(400, 'REPORT_IS_FEEDBACK', 'Roster feedback cannot disable an account');
      if (!targetUserId && report.reported_message_id) {
        const data = await asAdmin<{ messages_by_pk: { sender_id: string | null } | null }>(
          `query ReportedSender($id: uuid!) { messages_by_pk(id: $id) { sender_id } }`,
          { id: report.reported_message_id },
        );
        targetUserId = data.messages_by_pk?.sender_id ?? null;
      }
      if (!targetUserId && report.reported_event_id) {
        const data = await asAdmin<{ events_by_pk: { creator_id: string } | null }>(
          `query ReportedHost($id: uuid!) { events_by_pk(id: $id) { creator_id } }`,
          { id: report.reported_event_id },
        );
        targetUserId = data.events_by_pk?.creator_id ?? null;
      }
      if (!targetUserId) throw new HttpError(400, 'REPORT_HAS_NO_USER', 'No account is linked to this report');
      if (targetUserId === actorId) throw new HttpError(400, 'MODERATION_SELF', 'You cannot disable your own account');
      await asAdmin(
        `mutation DisableReportedUser($id: uuid!) {
          updateUser(pk_columns: { id: $id }, _set: { disabled: true }) { id }
          deleteAuthRefreshTokens(where: { userId: { _eq: $id } }) { affected_rows }
        }`,
        { id: targetUserId },
      );
      outcome = 'Account disabled and signed out';
    }

    const status = action === 'reviewing' ? 'reviewing' : action === 'dismiss' ? 'dismissed' : 'resolved';
    const notes = [outcome, note].filter(Boolean).join(' — ') || null;
    await asAdmin(
      `mutation CloseReport($id: uuid!, $status: report_status!, $notes: String, $actor: uuid, $at: timestamptz) {
        update_reports_by_pk(
          pk_columns: { id: $id }
          _set: { status: $status, resolution_notes: $notes, resolved_by: $actor, resolved_at: $at }
        ) { id }
      }`,
      {
        id: report.id,
        status,
        notes,
        actor: status === 'reviewing' ? null : actorId,
        at: status === 'reviewing' ? null : now,
      },
    );

    console.info(JSON.stringify({ event: 'admin.moderation.action', actorId, reportId: report.id, action, targetUserId, at: now }));
    return res.status(200).json({ status, outcome: outcome || null });
  } catch (error) {
    if (error instanceof Error && error.message === 'Staff admin role required') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: error.message } });
    }
    return sendClientError(res, error, 'admin/moderation/action', 'MODERATION_ACTION_FAILED');
  }
}
