import type { Request, Response } from 'express';
import { unauthorized, verifyWebhookSecret } from '../_lib/auth.js';
import {
  REFRESH_LEAD_MS,
  cacheExpiresAt,
  writeFlightSearchCache,
} from '../_lib/flightSearchCache.js';
import { searchFlightSchedules } from '../_lib/flightProviders.js';
import { graphqlRaw } from '../_lib/graphql.js';

const DEFAULT_REFRESH_BUDGET = 25;

interface CacheCandidate {
  id: string;
  departure_airport: string;
  arrival_airport: string;
  flight_date: string;
  expires_at: string;
  result_count: number;
}

function refreshBudget(): number {
  const raw = Number(process.env.FLIGHT_CACHE_REFRESH_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_REFRESH_BUDGET;
}

function routeKey(departure: string, arrival: string, flightDate: string): string {
  return `${departure}-${arrival}-${flightDate}`;
}

/** Route/date pairs that an active upcoming trip already depends on. */
async function tripReferencedRoutes(): Promise<Set<string>> {
  const data = await graphqlRaw<{
    trip_flight_legs: Array<{
      flight: {
        departure_airport: string;
        arrival_airport: string;
        service_date: string;
      } | null;
    }>;
  }>(
    `
      query TripReferencedRoutes($now: timestamptz!) {
        trip_flight_legs(
          where: {
            trip: { is_active: { _eq: true }, ends_at: { _gte: $now } }
          }
          limit: 500
        ) {
          flight {
            departure_airport
            arrival_airport
            service_date
          }
        }
      }
    `,
    { now: new Date().toISOString() },
  );

  const routes = new Set<string>();
  for (const leg of data.trip_flight_legs) {
    if (!leg.flight) continue;
    routes.add(
      routeKey(leg.flight.departure_airport, leg.flight.arrival_airport, leg.flight.service_date),
    );
  }
  return routes;
}

async function expiringCandidates(horizonIso: string, today: string): Promise<CacheCandidate[]> {
  const data = await graphqlRaw<{ flight_search_cache: CacheCandidate[] }>(
    `
      query ExpiringFlightCache($horizon: timestamptz!, $today: date!) {
        flight_search_cache(
          where: {
            expires_at: { _lte: $horizon }
            flight_date: { _gte: $today }
          }
          order_by: [{ flight_date: asc }, { expires_at: asc }]
          limit: 200
        ) {
          id
          departure_airport
          arrival_airport
          flight_date
          expires_at
          result_count
        }
      }
    `,
    { horizon: horizonIso, today },
  );
  return data.flight_search_cache;
}

export default async function flightCacheRefresh(req: Request, res: Response) {
  if (!verifyWebhookSecret(req)) {
    return unauthorized(res);
  }

  const startedAt = Date.now();
  const log = (
    level: 'info' | 'warn' | 'error',
    event: string,
    details: Record<string, unknown> = {},
  ) => {
    console[level](
      JSON.stringify({
        scope: 'internal/flight-cache-refresh',
        event,
        elapsedMs: Date.now() - startedAt,
        ...details,
      }),
    );
  };

  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const horizon = new Date(now.getTime() + REFRESH_LEAD_MS).toISOString();
    const budget = refreshBudget();

    const [candidates, referencedRoutes] = await Promise.all([
      expiringCandidates(horizon, today),
      tripReferencedRoutes().catch((error) => {
        log('warn', 'trip_route_lookup_failed', {
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        return new Set<string>();
      }),
    ]);

    // Routes a crew member already committed to refresh first; browse-only rows
    // fill whatever provider budget is left.
    const prioritized = [...candidates].sort((a, b) => {
      const aTracked = referencedRoutes.has(
        routeKey(a.departure_airport, a.arrival_airport, a.flight_date),
      );
      const bTracked = referencedRoutes.has(
        routeKey(b.departure_airport, b.arrival_airport, b.flight_date),
      );
      if (aTracked !== bTracked) return aTracked ? -1 : 1;
      return Date.parse(a.expires_at) - Date.parse(b.expires_at);
    });

    const selected = prioritized.slice(0, budget);
    log('info', 'refresh_started', {
      candidateCount: candidates.length,
      tripReferencedRouteCount: referencedRoutes.size,
      selectedCount: selected.length,
      budget,
      horizon,
    });

    let refreshed = 0;
    let failed = 0;
    let skippedRateLimited = 0;

    for (const candidate of selected) {
      const params = {
        depIata: candidate.departure_airport,
        arrIata: candidate.arrival_airport,
        flightDate: candidate.flight_date,
      };

      try {
        const { provider, schedules } = await searchFlightSchedules(params);
        await writeFlightSearchCache({
          params,
          provider,
          schedules,
          expiresAt: cacheExpiresAt(candidate.flight_date, new Date()),
          isRefresh: true,
        });
        refreshed += 1;
        log('info', 'route_refreshed', {
          cacheId: candidate.id,
          ...params,
          provider,
          previousResultCount: candidate.result_count,
          scheduleCount: schedules.length,
          tripReferenced: referencedRoutes.has(
            routeKey(candidate.departure_airport, candidate.arrival_airport, candidate.flight_date),
          ),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        failed += 1;
        log('warn', 'route_refresh_failed', { cacheId: candidate.id, ...params, code: message });

        // Burning through a rate limit or exhausted quota only makes it worse.
        if (message === 'FLIGHT_API_RATE_LIMIT' || message === 'FLIGHT_API_QUOTA_EXCEEDED') {
          skippedRateLimited = selected.length - (refreshed + failed);
          log('warn', 'refresh_aborted', { code: message, skipped: skippedRateLimited });
          break;
        }
      }
    }

    log('info', 'refresh_completed', { refreshed, failed, skipped: skippedRateLimited });

    return res.status(200).json({
      message: 'Flight schedule cache refresh complete',
      candidates: candidates.length,
      selected: selected.length,
      refreshed,
      failed,
      skipped: skippedRateLimited,
    });
  } catch (error) {
    log('error', 'refresh_error', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to refresh flight cache',
    });
  }
}
