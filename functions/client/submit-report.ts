import type { Request, Response } from 'express';
import {
  badRequest,
  requireAuthorization,
  unauthorized,
} from '../_lib/auth.js';
import { graphqlAsUser } from '../_lib/graphql.js';

interface SubmitReportInput {
  reason: string;
  details?: string | null;
  reportedUserId?: string | null;
  reportedMessageId?: string | null;
  reportedEventId?: string | null;
}

interface ActionPayload {
  action: { name: string };
  input: SubmitReportInput;
  session_variables: Record<string, string>;
}

export default async function submitReport(req: Request, res: Response) {
  try {
    const authorization = requireAuthorization(req);
    const payload = req.body as ActionPayload;
    const input = payload?.input;

    if (!input?.reason?.trim()) {
      return badRequest(res, 'reason is required');
    }

    if (!input.reportedUserId && !input.reportedMessageId && !input.reportedEventId) {
      return badRequest(res, 'At least one report target is required');
    }

    const data = await graphqlAsUser<{
      insert_reports_one: { id: string; status: string } | null;
    }>(
      `
        mutation SubmitReport($object: reports_insert_input!) {
          insert_reports_one(object: $object) {
            id
            status
          }
        }
      `,
      authorization,
      {
        object: {
          reason: input.reason,
          details: input.details ?? null,
          reported_user_id: input.reportedUserId ?? null,
          reported_message_id: input.reportedMessageId ?? null,
          reported_event_id: input.reportedEventId ?? null,
        },
      },
    );

    const report = data.insert_reports_one;
    if (!report) {
      return res.status(500).json({ message: 'Failed to create report' });
    }

    console.info('Moderation ticket created', report.id);

    return res.status(200).json({
      reportId: report.id,
      status: report.status,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }

    console.error('client/submit-report error', error);
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to submit report',
    });
  }
}
