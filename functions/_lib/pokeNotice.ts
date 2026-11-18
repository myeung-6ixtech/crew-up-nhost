/**
 * Notification copy for a poke (a "wave" from Discover / Matches), the same wording the app uses in chat:
 * "Sam poked you · Tokyo layover". Pure, so it's unit-tested (scripts/connection-requests.test.mjs).
 */
export type PokeMeta = { city?: string | null } | null | undefined;

export const POKE_TITLE = 'Poke';

/** First name, or "A crew member" when there's no name. */
export function pokeSenderName(profile: { preferred_name?: string | null; display_name?: string | null } | null | undefined): string {
  const name = (profile?.preferred_name || profile?.display_name || '').trim();
  return name ? name.split(/\s+/)[0] : 'A crew member';
}

export function pokeBody(senderName: string, meta: PokeMeta): string {
  const city = typeof meta?.city === 'string' ? meta.city.trim() : '';
  return city ? `${senderName} poked you · ${city} layover` : `${senderName} poked you`;
}
