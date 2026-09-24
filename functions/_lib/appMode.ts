import { AppModeSchema, type AppMode } from '../_shared/index.js';

/** The only reader of CREWUP_APP_MODE (onboarding.md §2.2). Throws on an invalid value rather than guessing. */
export function getAppMode(): AppMode {
  return AppModeSchema.parse(process.env.CREWUP_APP_MODE?.trim() || 'beta');
}
