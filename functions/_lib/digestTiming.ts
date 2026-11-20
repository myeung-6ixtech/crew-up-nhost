/**
 * When a daily digest goes out: 8 AM in the person's own time zone, at most once a day.
 * Pure, so it is unit-tested (scripts/digest-timing.test.mjs).
 */
export const DIGEST_LOCAL_HOUR = 8;
/** A second digest never goes out within this long of the last one (covers DST and late cron runs). */
const MIN_GAP_MS = 20 * 60 * 60 * 1000;

/** A usable IANA zone, or null. */
export function validZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return null;
  }
}

/** The hour (0-23) it is now in `zone`. */
export function localHour(now: Date, zone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(now);
  return Number(hour) % 24;
}

/** Zone to use: the device's, else the base airport's, else UTC. */
export function digestZone(deviceZone: string | null | undefined, baseAirportZone: string | null | undefined): string {
  return validZone(deviceZone) ?? validZone(baseAirportZone) ?? 'UTC';
}

/** True when it is the digest hour in `zone` and no digest has gone out in the last 20 hours. */
export function digestDue(now: Date, zone: string, lastDigestAt: string | null | undefined): boolean {
  if (localHour(now, zone) !== DIGEST_LOCAL_HOUR) return false;
  const last = lastDigestAt ? Date.parse(lastDigestAt) : NaN;
  return !Number.isFinite(last) || now.getTime() - last >= MIN_GAP_MS;
}

/** Where "new" starts: the last digest, or 24 hours ago for a first digest. */
export function digestSince(now: Date, lastDigestAt: string | null | undefined): string {
  const last = lastDigestAt ? Date.parse(lastDigestAt) : NaN;
  return new Date(Number.isFinite(last) ? last : now.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

export function digestBody(count: number): string {
  return count === 1 ? 'You have 1 new notification' : `You have ${count} new notifications`;
}
