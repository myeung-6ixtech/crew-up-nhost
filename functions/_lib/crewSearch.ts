/**
 * Pure helpers for crew search (unit-tested in scripts/connection-requests.test.mjs): query cleanup, the LIKE
 * pattern, and a simple per-user rate limit.
 */

/** "@Sam_K " → "sam_k". Letters, digits, _ . - and spaces are kept (names have spaces), at most 40 characters. */
export function cleanUsernameQuery(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/^@+/, '')
    .replace(/[^\p{L}\p{N}_.\- ]/gu, '')
    .replace(/\s+/g, ' ')
    .slice(0, 40)
    .toLowerCase();
}

/** `%term%` for ILIKE, with LIKE's own wildcards escaped so they match literally. */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Sliding-window limit per key, per function instance (enough to stop a runaway client; a determined abuser across
 * instances is the job of a gateway limit).
 */
export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now: number = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}
