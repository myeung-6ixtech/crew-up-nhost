/**
 * JWT `x-hasura-airline-id` sentinel when `profiles.airline_id` is null.
 * Must stay in sync with `nhost/nhost.toml` customClaims default.
 */
export const AIRLINE_CLAIM_SENTINEL = '00000000-0000-0000-0000-000000000000';

/** Downgrade same_airline visibility when the user has no airline affiliation. */
export function normalizeVisibilityForAffiliation(
  visibility: string,
  airlineId: string | null | undefined,
): string {
  if (visibility === 'same_airline' && !airlineId) return 'friends';
  return visibility;
}

/** Downgrade same_airline event scope when the creator has no airline affiliation. */
export function normalizeEventVisibilityScope(
  scope: string,
  airlineId: string | null | undefined,
): string {
  if (scope === 'same_airline' && !airlineId) return 'all_verified';
  return scope;
}
