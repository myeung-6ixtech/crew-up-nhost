const FRIEND_ID_PATTERN = /^CREW[0-9A-HJKMNP-TV-Z]{8}$/;

export function normalizeFriendId(input: string): string | null {
  const normalized = input.replace(/[\s-]/g, '').toUpperCase();
  if (!FRIEND_ID_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

export function formatFriendIdForDisplay(friendId: string): string {
  const normalized = normalizeFriendId(friendId) ?? friendId.toUpperCase();
  if (!normalized.startsWith('CREW') || normalized.length !== 12) {
    return friendId;
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 8)}-${normalized.slice(8, 12)}`;
}
