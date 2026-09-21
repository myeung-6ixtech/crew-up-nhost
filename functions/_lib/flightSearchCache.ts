import {
  SELECTION_TOKEN_TTL_MS,
  cacheExpiresAt,
  cacheTtlMs,
  daysToDeparture,
  toSelectionResults,
  type CachedFlightResult,
} from './flightCachePolicy.js';
import {
  searchFlightSchedules,
  validateFlightSearchParams,
  type FlightProviderName,
  type FlightScheduleRecord,
  type FlightSearchDiagnostics,
  type FlightSearchParams,
} from './flightProviders.js';
import { graphqlRaw } from './graphql.js';

export {
  REFRESH_LEAD_MS,
  SELECTION_TOKEN_TTL_MS,
  cacheExpiresAt,
  cacheTtlMs,
  daysToDeparture,
} from './flightCachePolicy.js';

export interface FlightSearchOutcome {
  flights: CachedFlightResult[];
  provider: FlightProviderName;
  cached: boolean;
  fetchedAt: string;
  cacheExpiresAt: string;
  selectionExpiresAt: string;
  cacheAgeMs: number | null;
}

interface FlightSearchCacheRow {
  id: string;
  provider: string;
  results: FlightScheduleRecord[];
  result_count: number;
  fetched_at: string;
  expires_at: string;
}

export async function readFlightSearchCache(
  params: FlightSearchParams,
): Promise<FlightSearchCacheRow | null> {
  const data = await graphqlRaw<{ flight_search_cache: FlightSearchCacheRow[] }>(
    `
      query CachedFlightSearch(
        $departureAirport: String!
        $arrivalAirport: String!
        $flightDate: date!
      ) {
        flight_search_cache(
          where: {
            departure_airport: { _eq: $departureAirport }
            arrival_airport: { _eq: $arrivalAirport }
            flight_date: { _eq: $flightDate }
          }
          limit: 1
        ) {
          id
          provider
          results
          result_count
          fetched_at
          expires_at
        }
      }
    `,
    {
      departureAirport: params.depIata,
      arrivalAirport: params.arrIata,
      flightDate: params.flightDate,
    },
  );

  return data.flight_search_cache[0] ?? null;
}

export async function writeFlightSearchCache(input: {
  params: FlightSearchParams;
  provider: FlightProviderName;
  schedules: FlightScheduleRecord[];
  expiresAt: string;
  isRefresh?: boolean;
}): Promise<void> {
  const now = new Date().toISOString();
  await graphqlRaw(
    `
      mutation UpsertFlightSearchCache($object: flight_search_cache_insert_input!) {
        insert_flight_search_cache_one(
          object: $object
          on_conflict: {
            constraint: flight_search_cache_route_date_unique
            update_columns: [
              provider
              results
              result_count
              fetched_at
              expires_at
              refresh_count
              updated_at
            ]
          }
        ) {
          id
        }
      }
    `,
    {
      object: {
        departure_airport: input.params.depIata,
        arrival_airport: input.params.arrIata,
        flight_date: input.params.flightDate,
        provider: input.provider,
        results: input.schedules,
        result_count: input.schedules.length,
        fetched_at: now,
        expires_at: input.expiresAt,
        refresh_count: input.isRefresh ? 1 : 0,
        updated_at: now,
      },
    },
  );
}

/**
 * Cache-aside flight search: serve a fresh cache row when one exists, otherwise
 * call the provider and upsert the normalized result. Selection tokens are always
 * freshly minted regardless of which branch served the schedules.
 */
export async function getFlightSearchResults(
  rawParams: FlightSearchParams,
  diagnostics: FlightSearchDiagnostics & {
    log?: (
      level: 'info' | 'warn' | 'error',
      event: string,
      details?: Record<string, unknown>,
    ) => void;
  } = {},
): Promise<FlightSearchOutcome> {
  const params = validateFlightSearchParams(rawParams);
  const log = diagnostics.log ?? (() => undefined);
  const now = new Date();

  let cacheRow: FlightSearchCacheRow | null = null;
  try {
    cacheRow = await readFlightSearchCache(params);
  } catch (error) {
    // A cache read failure must not break search; fall through to the provider.
    log('warn', 'cache_read_failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  if (cacheRow) {
    const expiresAtMs = Date.parse(cacheRow.expires_at);
    const fetchedAtMs = Date.parse(cacheRow.fetched_at);
    const cacheAgeMs = Number.isFinite(fetchedAtMs) ? now.getTime() - fetchedAtMs : null;

    if (Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime()) {
      const flights = toSelectionResults(Array.isArray(cacheRow.results) ? cacheRow.results : []);
      log('info', 'cache_hit', {
        cacheId: cacheRow.id,
        provider: cacheRow.provider,
        cachedResultCount: cacheRow.result_count,
        returnedFlightCount: flights.length,
        cacheAgeMs,
        cacheExpiresAt: cacheRow.expires_at,
      });

      return {
        flights,
        provider: (cacheRow.provider as FlightProviderName) ?? 'aerodatabox',
        cached: true,
        fetchedAt: cacheRow.fetched_at,
        cacheExpiresAt: cacheRow.expires_at,
        selectionExpiresAt: new Date(now.getTime() + SELECTION_TOKEN_TTL_MS).toISOString(),
        cacheAgeMs,
      };
    }

    log('info', 'cache_expired', {
      cacheId: cacheRow.id,
      cacheExpiresAt: cacheRow.expires_at,
      cachedResultCount: cacheRow.result_count,
      cacheAgeMs,
    });
  } else {
    log('info', 'cache_miss', {
      departureAirport: params.depIata,
      arrivalAirport: params.arrIata,
      flightDate: params.flightDate,
    });
  }

  const { provider, schedules } = await searchFlightSchedules(params, diagnostics);
  const expiresAt = cacheExpiresAt(params.flightDate, now);

  try {
    await writeFlightSearchCache({ params, provider, schedules, expiresAt });
    log('info', 'cache_write_succeeded', {
      provider,
      scheduleCount: schedules.length,
      cacheExpiresAt: expiresAt,
      ttlMs: cacheTtlMs(params.flightDate, now),
      daysToDeparture: daysToDeparture(params.flightDate, now),
    });
  } catch (error) {
    // Serving the user matters more than persisting the cache row.
    log('warn', 'cache_write_failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  return {
    flights: toSelectionResults(schedules),
    provider,
    cached: false,
    fetchedAt: now.toISOString(),
    cacheExpiresAt: expiresAt,
    selectionExpiresAt: new Date(now.getTime() + SELECTION_TOKEN_TTL_MS).toISOString(),
    cacheAgeMs: 0,
  };
}
