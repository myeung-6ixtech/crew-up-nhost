import { createFlightSelectionToken } from './flightSelection.js';
import type { FlightScheduleRecord } from './flightProviders.js';

/**
 * Route existence is stable for weeks while scheduled times drift as the service
 * day approaches, so the TTL scales with days-to-departure instead of using one
 * flat expiry. Past dates are settled history and get the long tier.
 */
export const TTL_TIERS_MS = {
  farOut: 7 * 24 * 60 * 60 * 1000,
  midRange: 24 * 60 * 60 * 1000,
  nearTerm: 6 * 60 * 60 * 1000,
} as const;

/** Selection tokens are minted per response and never cached. */
export const SELECTION_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Refresh rows expiring within this window on the next scheduled run. */
export const REFRESH_LEAD_MS = 24 * 60 * 60 * 1000;

export interface CachedFlightResult extends FlightScheduleRecord {
  resultId: string;
  selectionToken: string;
}

export function daysToDeparture(flightDate: string, now = new Date()): number {
  const departureUtc = Date.parse(`${flightDate}T00:00:00Z`);
  const todayUtc = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((departureUtc - todayUtc) / (24 * 60 * 60 * 1000));
}

export function cacheTtlMs(flightDate: string, now = new Date()): number {
  const days = daysToDeparture(flightDate, now);
  if (days < 0) return TTL_TIERS_MS.farOut;
  if (days > 14) return TTL_TIERS_MS.farOut;
  if (days >= 3) return TTL_TIERS_MS.midRange;
  return TTL_TIERS_MS.nearTerm;
}

export function cacheExpiresAt(flightDate: string, now = new Date()): string {
  return new Date(now.getTime() + cacheTtlMs(flightDate, now)).toISOString();
}

/** Guards against partially written or schema-drifted cache rows. */
export function isUsableSchedule(value: unknown): value is FlightScheduleRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<FlightScheduleRecord>;
  return (
    typeof record.flightNumber === 'string' &&
    typeof record.serviceDate === 'string' &&
    typeof record.departureAirport === 'string' &&
    typeof record.arrivalAirport === 'string' &&
    typeof record.scheduledDeparture === 'string' &&
    typeof record.scheduledArrival === 'string'
  );
}

/**
 * Mints a fresh selection token per schedule so a long-lived cache row can never
 * hand back a token that has already expired.
 */
export function toSelectionResults(schedules: FlightScheduleRecord[]): CachedFlightResult[] {
  return schedules.filter(isUsableSchedule).map((schedule) => {
    const resultId =
      schedule.providerFlightId || `${schedule.flightNumber}-${schedule.scheduledDeparture}`;

    return {
      ...schedule,
      resultId,
      selectionToken: createFlightSelectionToken(
        {
          flightNumber: schedule.flightNumber,
          airlineIata: schedule.airlineIata ?? null,
          serviceDate: schedule.serviceDate,
          departureAirport: schedule.departureAirport,
          arrivalAirport: schedule.arrivalAirport,
          scheduledDeparture: schedule.scheduledDeparture,
          scheduledArrival: schedule.scheduledArrival,
          provider: schedule.provider,
          providerFlightId: resultId,
        },
        SELECTION_TOKEN_TTL_MS,
      ),
    };
  });
}
