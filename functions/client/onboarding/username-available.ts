import type { Request, Response } from 'express';
import { requireUser } from '../../_lib/auth.js';
import { handleOnboardingFailure, isUsernameTaken } from '../../_lib/onboarding.js';
import { UsernameSchema, isReservedUsername } from '../../_shared/index.js';

const WINDOW_MS = 60_000;
const MAX_CHECKS_PER_WINDOW = 30;
/** Best-effort per-instance limiter; the unique index is the real guarantee. */
const recentChecks = new Map<string, number[]>();

function rateLimited(userId: string, now = Date.now()): boolean {
  const recent = (recentChecks.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
  recent.push(now);
  recentChecks.set(userId, recent);
  if (recentChecks.size > 5000) recentChecks.clear();
  return recent.length > MAX_CHECKS_PER_WINDOW;
}

/** GET /v1/client/onboarding/username-available?u= */
export default async function usernameAvailable(req: Request, res: Response) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { userId } = requireUser(req);
    if (rateLimited(userId)) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many checks. Wait a moment.' } });
    }

    const raw = typeof req.query.u === 'string' ? req.query.u.slice(0, 64) : '';
    const parsed = UsernameSchema.safeParse(raw);
    if (!parsed.success) {
      const reserved = isReservedUsername(raw.trim());
      return res.status(200).json({
        available: false,
        reason: reserved ? 'reserved' : 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Invalid username',
      });
    }

    const username = parsed.data;
    const taken = await isUsernameTaken(username, userId);
    return res.status(200).json({
      username,
      available: !taken,
      ...(taken ? { reason: 'taken', message: 'That username is taken' } : {}),
    });
  } catch (error) {
    return handleOnboardingFailure(res, error, 'client/onboarding/username-available');
  }
}
