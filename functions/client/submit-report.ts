import type { Request, Response } from 'express';
import {
  badRequest,
  requireAuthorization,
  unauthorized,
} from '../_lib/auth.js';
import { graphqlAsUser, graphqlRaw } from '../_lib/graphql.js';
import { sendStaffAlert } from '../_lib/staffAlert.js';

interface SubmitReportInput {
  reason: string;
  details?: string | null;
  reportedUserId?: string | null;
  reportedMessageId?: string | null;
  reportedEventId?: string | null;
  /** From the app: where it was reported (profile, chat, event, crossing_paths) and the relationship. */
  context?: Record<string, unknown> | null;
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

    // Snapshot of the reported profile as it is now (read as the service role; the reporter may be blocked by them).
    let reportedProfile: Record<string, unknown> | null = null;
    if (input.reportedUserId) {
      try {
        const snap = await graphqlRaw<{ profiles_by_pk: Record<string, unknown> | null }>(
          `query ReportedProfile($id: uuid!) {
            profiles_by_pk(user_id: $id) {
              display_name preferred_name username crew_role airline_id base_airport_iata avatar_file_id
            }
          }`,
          { id: input.reportedUserId },
        );
        reportedProfile = snap.profiles_by_pk;
      } catch (error) {
        console.error('client/submit-report: profile snapshot failed', error);
      }
    }
    const clientContext = input.context && typeof input.context === 'object' && !Array.isArray(input.context) ? input.context : {};
    const context = {
      source: typeof clientContext.source === 'string' ? clientContext.source.slice(0, 40) : null,
      relationship: typeof clientContext.relationship === 'string' ? clientContext.relationship.slice(0, 40) : null,
      match: typeof clientContext.match === 'string' ? clientContext.match.slice(0, 200) : null,
      also_blocked: clientContext.also_blocked === true,
      reported_profile: reportedProfile,
      reported_at: new Date().toISOString(),
    };

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
          context,
        },
      },
    );

    const report = data.insert_reports_one;
    if (!report) {
      return res.status(500).json({ message: 'Failed to create report' });
    }

    console.info('Moderation ticket created', report.id);
    const target = input.reportedMessageId ? 'message' : input.reportedEventId ? 'meet' : 'person';
    // Blocking from a profile files a silent report; those reach the queue without an email.
    if (input.reason !== 'blocked_from_profile') await sendStaffAlert(
      `New CrewUp report: ${input.reason} (${target})`,
      [
        `Report ${report.id} was filed for a ${target}. Reason: ${input.reason}.`,
        'Review it in the admin Reports queue. Our published response time is 24 hours.',
        input.details ? `\nReporter's notes:\n${input.details.slice(0, 1000)}` : '',
      ].join('\n'),
    );

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
