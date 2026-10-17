import type { Request, Response } from 'express';
import { requireStaffAdmin } from '../../_lib/auth.js';
import { graphqlAsAdmin, graphqlAsUser } from '../../_lib/graphql.js';
import { HttpError, sendClientError } from '../../_lib/httpError.js';

/**
 * GET /v1/admin/moderation/message?reportId= — the reported message's content for the admin queue.
 * staff_admin can't read message bodies through Hasura; this returns only the one message a report points at.
 */
export default async function reportedMessage(req: Request, res: Response) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { authorization, userId: actorId } = requireStaffAdmin(req);
    const reportId = typeof req.query.reportId === 'string' ? req.query.reportId : '';
    if (!reportId) throw new HttpError(400, 'MODERATION_BAD_REQUEST', 'reportId is required');

    let messageId: string | null;
    try {
      const data = await graphqlAsUser<{ reports_by_pk: { reported_message_id: string | null } | null }>(
        `query ReportMessageRef($id: uuid!) { reports_by_pk(id: $id) { reported_message_id } }`,
        authorization,
        { id: reportId },
        'staff_admin',
      );
      if (!data.reports_by_pk) throw new HttpError(404, 'REPORT_NOT_FOUND', 'Report not found');
      messageId = data.reports_by_pk.reported_message_id;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(403, 'FORBIDDEN', 'Staff admin role required');
    }
    if (!messageId) return res.status(200).json({ message: null });

    const data = await graphqlAsAdmin<{
      messages_by_pk: {
        id: string;
        body: string | null;
        media_file_id: string | null;
        removed_at: string | null;
        created_at: string;
        sender_id: string | null;
      } | null;
    }>(
      `query ReportedMessage($id: uuid!) {
        messages_by_pk(id: $id) { id body media_file_id removed_at created_at sender_id }
      }`,
      { id: messageId },
      'admin',
    );

    console.info(JSON.stringify({ event: 'admin.moderation.message_viewed', actorId, reportId, at: new Date().toISOString() }));
    return res.status(200).json({ message: data.messages_by_pk });
  } catch (error) {
    if (error instanceof Error && error.message === 'Staff admin role required') {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: error.message } });
    }
    return sendClientError(res, error, 'admin/moderation/message', 'MODERATION_MESSAGE_FAILED');
  }
}
