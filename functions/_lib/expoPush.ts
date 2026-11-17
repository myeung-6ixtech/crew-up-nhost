import { graphqlRaw } from './graphql.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export type PushNotice = {
  userId: string;
  title: string;
  body: string;
  data: Record<string, string>;
  /** Immediate alerts skip people who chose the daily digest. */
  includeDigest?: boolean;
};

type TokenRow = { id: string; user_id: string; expo_push_token: string };
type ProfileRow = { user_id: string; notification_mode: string };

type Ticket = {
  status?: string;
  message?: string;
  details?: { error?: string };
};

/** Sends through Expo. Android delivery uses the FCM key stored on the Expo project. iOS tokens send the same way once an APNs key is uploaded. */
export async function sendPushNotices(notices: PushNotice[]): Promise<void> {
  if (!notices.length) return;

  const userIds = [...new Set(notices.map((notice) => notice.userId))];
  const data = await graphqlRaw<{ push_tokens: TokenRow[]; profiles: ProfileRow[] }>(
    `
      query PushTargets($userIds: [uuid!]!) {
        push_tokens(where: { user_id: { _in: $userIds }, is_active: { _eq: true } }) {
          id
          user_id
          expo_push_token
        }
        profiles(where: { user_id: { _in: $userIds } }) {
          user_id
          notification_mode
        }
      }
    `,
    { userIds },
  );

  const digest = new Set(
    data.profiles.filter((profile) => profile.notification_mode === 'digest').map((profile) => profile.user_id),
  );
  const tokensByUser = new Map<string, TokenRow[]>();
  for (const token of data.push_tokens) {
    const list = tokensByUser.get(token.user_id) ?? [];
    list.push(token);
    tokensByUser.set(token.user_id, list);
  }

  const messages: Array<{ to: string; title: string; body: string; data: Record<string, string>; sound: 'default'; channelId: string }> = [];
  const tokenIds: string[] = [];
  for (const notice of notices) {
    if (!notice.includeDigest && digest.has(notice.userId)) continue;
    for (const token of tokensByUser.get(notice.userId) ?? []) {
      messages.push({
        to: token.expo_push_token,
        title: notice.title,
        body: notice.body,
        data: notice.data,
        sound: 'default',
        channelId: 'messages',
      });
      tokenIds.push(token.id);
    }
  }

  if (!messages.length) return;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  };
  const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const dead: string[] = [];
  for (let index = 0; index < messages.length; index += 100) {
    const chunk = messages.slice(index, index + 100);
    const ids = tokenIds.slice(index, index + 100);
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(chunk),
    });
    if (!response.ok) {
      console.error('expo push failed', response.status, await response.text());
      continue;
    }
    const payload = (await response.json()) as { data?: Ticket[] };
    (payload.data ?? []).forEach((ticket, ticketIndex) => {
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        const id = ids[ticketIndex];
        if (id) dead.push(id);
      }
    });
  }

  if (!dead.length) return;
  await graphqlRaw(
    `
      mutation DeactivatePushTokens($ids: [uuid!]!) {
        update_push_tokens(where: { id: { _in: $ids } }, _set: { is_active: false }) {
          affected_rows
        }
      }
    `,
    { ids: dead },
  );
}
