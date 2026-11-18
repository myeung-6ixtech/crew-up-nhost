/** How the viewer stands with someone, for the Add friend screen after a QR scan. Pure (unit-tested). */
export type Relationship = 'self' | 'none' | 'friends' | 'pending_sent' | 'pending_received';

export function relationshipFrom(
  viewerId: string,
  otherId: string,
  connection: { status: string; requester_id: string } | null,
): Relationship {
  if (viewerId === otherId) return 'self';
  if (!connection) return 'none';
  if (connection.status === 'accepted') return 'friends';
  if (connection.status === 'pending') return connection.requester_id === viewerId ? 'pending_sent' : 'pending_received';
  return 'none';
}
