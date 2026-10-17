import { graphqlAsAdmin } from './graphql.js';
import { rosterLlmConfig } from './rosterLlm.js';

/** Bump when the consent wording changes in a way people must agree to again. */
const CONSENT_REVISION = '2026-10';

const PROVIDER_NAMES: Record<string, string> = {
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
};

/** The provider named on the consent screen. ROSTER_AI_PROVIDER_NAME overrides the default per provider. */
export function rosterConsentInfo(): { enabled: boolean; providerName: string; version: string } {
  const config = rosterLlmConfig();
  const providerName = process.env.ROSTER_AI_PROVIDER_NAME?.trim() || PROVIDER_NAMES[config.provider] || 'an AI service';
  return { enabled: config.enabled, providerName, version: `${CONSENT_REVISION}:${providerName}` };
}

export async function storedRosterConsentVersion(userId: string): Promise<string | null> {
  const data = await graphqlAsAdmin<{ user_private_by_pk: { roster_ai_consent_version: string | null } | null }>(
    `query RosterConsent($userId: uuid!) { user_private_by_pk(user_id: $userId) { roster_ai_consent_version } }`,
    { userId },
  );
  return data.user_private_by_pk?.roster_ai_consent_version ?? null;
}

export async function hasCurrentRosterConsent(userId: string): Promise<boolean> {
  return (await storedRosterConsentVersion(userId)) === rosterConsentInfo().version;
}

export async function recordRosterConsent(userId: string, version: string): Promise<void> {
  await graphqlAsAdmin(
    `mutation RecordRosterConsent($object: user_private_insert_input!) {
      insert_user_private_one(
        object: $object
        on_conflict: { constraint: user_private_pkey, update_columns: [roster_ai_consent_at, roster_ai_consent_version] }
      ) { user_id }
    }`,
    { object: { user_id: userId, roster_ai_consent_at: new Date().toISOString(), roster_ai_consent_version: version } },
  );
}
