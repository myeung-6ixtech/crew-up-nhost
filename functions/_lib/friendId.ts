const FRIEND_ID_BODY = /CREW[0-9A-HJKMNP-TV-Z]{8}/;

/** Pulls a Crew ID out of a typed code or a pasted share message. Dashes and spaces are ignored. */
export function normalizeFriendId(input: string): string | null {
  const compact = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return compact.match(FRIEND_ID_BODY)?.[0] ?? null;
}

export function formatFriendIdForDisplay(friendId: string): string {
  const normalized = normalizeFriendId(friendId) ?? friendId.toUpperCase();
  if (!normalized.startsWith('CREW') || normalized.length !== 12) {
    return friendId;
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
}
