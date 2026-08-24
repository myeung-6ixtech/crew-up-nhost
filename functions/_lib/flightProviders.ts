import {
  createFlightSelectionToken,
  normalizeFlightNumber,
  normalizeIata,
  serviceDateFromIso,
} from './flightSelection.js';

export interface FlightSearchParams {
  depIata: string;
  arrIata: string;
  flightDate: string;
}

export interface FlightSearchDiagnostics {
  requestId?: string;
}

export interface NormalizedFlightResult {
  resultId: string;
  selectionToken: string;
  flightNumber: string;
  airlineIata?: string | null;
  airlineName: string;
  departureAirport: string;
  arrivalAirport: string;
  scheduledDeparture: string;
  scheduledArrival: string;
  status?: string | null;
}

const DEFAULT_AERODATABOX_HOST = 'aerodatabox.p.rapidapi.com';
const MIN_REQUEST_GAP_MS = 1500;
const RATE_LIMIT_RETRY_DELAY_MS = 2000;

let requestChain: Promise<void> = Promise.resolve();
let lastRequestFinishedAt = 0;

function logProvider(
  level: 'info' | 'warn' | 'error',
  event: string,
  diagnostics: FlightSearchDiagnostics,
  details: Record<string, unknown> = {},
): void {
  console[level](
    JSON.stringify({
      scope: 'flight_provider',
      event,
      requestId: diagnostics.requestId ?? null,
      ...details,
    }),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleRequest<T>(run: () => Promise<T>): Promise<T> {
  const scheduled = requestChain.then(async () => {
    const waitFor = lastRequestFinishedAt + MIN_REQUEST_GAP_MS - Date.now();
    if (waitFor > 0) await delay(waitFor);
    try {
      return await run();
    } finally {
      lastRequestFinishedAt = Date.now();
    }
  });
  requestChain = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

function readNumericHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function movementUtc(movement: Record<string, unknown> | undefined): string | null {
  for (const key of ['revisedTime', 'scheduledTime'] as const) {
    const time = movement?.[key] as Record<string, unknown> | undefined;
    const utc = typeof time?.utc === 'string' ? time.utc.trim() : '';
    if (!utc) continue;

    const parsed = new Date(utc.replace(' ', 'T'));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function resolveProvider(): 'aerodatabox' | 'aviationstack' {
  const configured = process.env.FLIGHT_PROVIDER?.trim().toLowerCase();
  if (configured === 'aviationstack' || configured === 'aerodatabox') {
    return configured;
  }
  if (process.env.RAPIDAPI_KEY?.trim()) return 'aerodatabox';
  if (process.env.AVIATIONSTACK_API_KEY?.trim()) return 'aviationstack';
  return 'aerodatabox';
}

async function requestAeroDataBoxWindow(
  host: string,
  apiKey: string,
  depIata: string,
  fromLocal: string,
  toLocal: string,
  diagnostics: FlightSearchDiagnostics,
  attempt = 1,
): Promise<Array<Record<string, unknown>>> {
  const path = `/flights/airports/iata/${encodeURIComponent(depIata)}/${fromLocal}/${toLocal}`;
  const url = new URL(`https://${host}${path}`);
  url.searchParams.set('direction', 'Departure');
  url.searchParams.set('withLeg', 'true');
  const startedAt = Date.now();

  logProvider('info', 'upstream_request_started', diagnostics, {
    provider: 'aerodatabox',
    depIata,
    fromLocal,
    toLocal,
    attempt,
  });

  const response = await scheduleRequest(async () =>
    fetch(url.toString(), {
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': host,
        'Content-Type': 'application/json',
      },
    }),
  );

  const apiUnitsRemaining = readNumericHeader(response, 'x-ratelimit-api-units-remaining');
  const requestsRemaining = readNumericHeader(response, 'x-ratelimit-requests-remaining');
  logProvider(response.ok ? 'info' : 'warn', 'upstream_response_received', diagnostics, {
    provider: 'aerodatabox',
    depIata,
    fromLocal,
    toLocal,
    attempt,
    status: response.status,
    durationMs: Date.now() - startedAt,
    apiUnitsRemaining,
    requestsRemaining,
  });

  if (response.status === 429) {
    const quotaExhausted = apiUnitsRemaining === 0 || requestsRemaining === 0;
    if (!quotaExhausted && attempt === 1) {
      logProvider('warn', 'upstream_rate_limit_retry', diagnostics, {
        provider: 'aerodatabox',
        retryDelayMs: RATE_LIMIT_RETRY_DELAY_MS,
      });
      await delay(RATE_LIMIT_RETRY_DELAY_MS);
      return requestAeroDataBoxWindow(
        host,
        apiKey,
        depIata,
        fromLocal,
        toLocal,
        diagnostics,
        attempt + 1,
      );
    }
    throw new Error(quotaExhausted ? 'FLIGHT_API_QUOTA_EXCEEDED' : 'FLIGHT_API_RATE_LIMIT');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('FLIGHT_API_NOT_CONFIGURED');
  }

  let payload: { departures?: Array<Record<string, unknown>>; message?: string };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    logProvider('error', 'upstream_invalid_json', diagnostics, {
      provider: 'aerodatabox',
      status: response.status,
    });
    throw new Error('FLIGHT_API_REQUEST_FAILED');
  }

  if (!response.ok) {
    logProvider('warn', 'upstream_request_failed', diagnostics, {
      provider: 'aerodatabox',
      status: response.status,
      providerMessage: payload.message ?? null,
    });
    throw new Error('FLIGHT_API_REQUEST_FAILED');
  }

  const departures = Array.isArray(payload.departures) ? payload.departures : [];
  logProvider('info', 'upstream_window_parsed', diagnostics, {
    provider: 'aerodatabox',
    depIata,
    fromLocal,
    toLocal,
    departureCount: departures.length,
  });
  return departures;
}

async function searchAeroDataBox(
  params: FlightSearchParams,
  diagnostics: FlightSearchDiagnostics,
): Promise<NormalizedFlightResult[]> {
  const apiKey = process.env.RAPIDAPI_KEY?.trim();
  const host = process.env.RAPIDAPI_AERODATABOX_HOST?.trim() || DEFAULT_AERODATABOX_HOST;
  if (!apiKey) throw new Error('FLIGHT_API_NOT_CONFIGURED');

  const depIata = normalizeIata(params.depIata);
  const arrIata = normalizeIata(params.arrIata);
  const dateKey = params.flightDate;
  const windows = [
    { from: `${dateKey}T00:00`, to: `${dateKey}T11:59` },
    { from: `${dateKey}T12:00`, to: `${dateKey}T23:59` },
  ];

  const departures: Array<Record<string, unknown>> = [];
  for (const window of windows) {
    departures.push(
      ...(await requestAeroDataBoxWindow(
        host,
        apiKey,
        depIata,
        window.from,
        window.to,
        diagnostics,
      )),
    );
  }

  const seen = new Set<string>();
  const results: NormalizedFlightResult[] = [];
  const arrivalIatas = new Set<string>();
  const filtered = {
    arrivalMismatch: 0,
    missingFlightNumber: 0,
    missingDepartureTime: 0,
    missingArrivalTime: 0,
    duplicate: 0,
  };

  for (const entry of departures) {
    const arrival = entry.arrival as Record<string, unknown> | undefined;
    const airport = arrival?.airport as Record<string, unknown> | undefined;
    const returnedArrivalIata = normalizeIata(
      typeof airport?.iata === 'string' ? airport.iata : '',
    );
    if (returnedArrivalIata) arrivalIatas.add(returnedArrivalIata);
    if (returnedArrivalIata !== arrIata) {
      filtered.arrivalMismatch += 1;
      continue;
    }

    const departure = entry.departure as Record<string, unknown> | undefined;
    const depUtc = movementUtc(departure);
    const arrUtc = movementUtc(arrival);
    const flightNumber = normalizeFlightNumber(String(entry.number ?? ''));
    if (!flightNumber) {
      filtered.missingFlightNumber += 1;
      continue;
    }
    if (!depUtc) {
      filtered.missingDepartureTime += 1;
      continue;
    }
    if (!arrUtc) {
      filtered.missingArrivalTime += 1;
      continue;
    }

    const scheduledDeparture = depUtc;
    const scheduledArrival = arrUtc;
    const dedupeKey = `${flightNumber}-${scheduledDeparture}`;
    if (seen.has(dedupeKey)) {
      filtered.duplicate += 1;
      continue;
    }
    seen.add(dedupeKey);

    const airline = entry.airline as Record<string, string> | undefined;
    const airlineIata = airline?.iata ?? null;
    const resultId = dedupeKey;
    const selectionToken = createFlightSelectionToken({
      flightNumber,
      airlineIata,
      serviceDate: serviceDateFromIso(scheduledDeparture),
      departureAirport: depIata,
      arrivalAirport: arrIata,
      scheduledDeparture,
      scheduledArrival,
      provider: 'aerodatabox',
      providerFlightId: resultId,
    });

    results.push({
      resultId,
      selectionToken,
      flightNumber,
      airlineIata,
      airlineName: airline?.name ?? 'Airline',
      departureAirport: depIata,
      arrivalAirport: arrIata,
      scheduledDeparture,
      scheduledArrival,
      status: typeof entry.status === 'string' ? entry.status : null,
    });
  }

  const emptyReason =
    results.length > 0
      ? null
      : departures.length === 0
        ? 'upstream_returned_no_departures'
        : filtered.arrivalMismatch === departures.length
          ? 'no_departures_matched_arrival'
          : 'all_matching_departures_missing_required_fields';

  logProvider(results.length > 0 ? 'info' : 'warn', 'normalization_completed', diagnostics, {
    provider: 'aerodatabox',
    departureAirport: depIata,
    requestedArrivalAirport: arrIata,
    rawDepartureCount: departures.length,
    returnedFlightCount: results.length,
    emptyReason,
    observedArrivalIatas: [...arrivalIatas].slice(0, 20),
    filtered,
  });

  return results.sort(
    (a, b) => new Date(a.scheduledDeparture).getTime() - new Date(b.scheduledDeparture).getTime(),
  );
}

async function searchAviationstack(
  params: FlightSearchParams,
  diagnostics: FlightSearchDiagnostics,
): Promise<NormalizedFlightResult[]> {
  const accessKey = process.env.AVIATIONSTACK_API_KEY?.trim();
  if (!accessKey) throw new Error('FLIGHT_API_NOT_CONFIGURED');

  const depIata = normalizeIata(params.depIata);
  const arrIata = normalizeIata(params.arrIata);
  const url = new URL('https://api.aviationstack.com/v1/flights');
  url.searchParams.set('access_key', accessKey);
  url.searchParams.set('dep_iata', depIata);
  url.searchParams.set('arr_iata', arrIata);
  url.searchParams.set('flight_date', params.flightDate);
  url.searchParams.set('limit', '100');

  const startedAt = Date.now();
  logProvider('info', 'upstream_request_started', diagnostics, {
    provider: 'aviationstack',
    depIata,
    arrIata,
    flightDate: params.flightDate,
  });
  const response = await fetch(url.toString());
  const payload = (await response.json()) as {
    data?: Array<Record<string, unknown>>;
    error?: { code?: string; message?: string };
  };
  logProvider(response.ok ? 'info' : 'warn', 'upstream_response_received', diagnostics, {
    provider: 'aviationstack',
    status: response.status,
    durationMs: Date.now() - startedAt,
    rawFlightCount: Array.isArray(payload.data) ? payload.data.length : 0,
    providerErrorCode: payload.error?.code ?? null,
  });

  if (payload.error?.code === 'function_access_restricted') {
    throw new Error('FLIGHT_API_PLAN_LIMIT');
  }
  if (!response.ok) throw new Error('FLIGHT_API_REQUEST_FAILED');

  const results: NormalizedFlightResult[] = [];
  for (const entry of payload.data ?? []) {
    const flight = entry.flight as Record<string, string> | undefined;
    const departure = entry.departure as Record<string, string> | undefined;
    const arrival = entry.arrival as Record<string, string> | undefined;
    const flightNumber = normalizeFlightNumber(flight?.iata ?? flight?.number ?? '');
    const scheduledDeparture = departure?.scheduled;
    const scheduledArrival = arrival?.scheduled;
    if (!flightNumber || !scheduledDeparture || !scheduledArrival) continue;

    const dep = normalizeIata(departure?.iata ?? depIata);
    const arr = normalizeIata(arrival?.iata ?? arrIata);
    const resultId = `${flightNumber}-${scheduledDeparture}`;
    const airline = entry.airline as Record<string, string> | undefined;

    results.push({
      resultId,
      selectionToken: createFlightSelectionToken({
        flightNumber,
        airlineIata: null,
        serviceDate: params.flightDate,
        departureAirport: dep,
        arrivalAirport: arr,
        scheduledDeparture: new Date(scheduledDeparture).toISOString(),
        scheduledArrival: new Date(scheduledArrival).toISOString(),
        provider: 'aviationstack',
        providerFlightId: resultId,
      }),
      flightNumber,
      airlineIata: null,
      airlineName: airline?.name ?? 'Airline',
      departureAirport: dep,
      arrivalAirport: arr,
      scheduledDeparture: new Date(scheduledDeparture).toISOString(),
      scheduledArrival: new Date(scheduledArrival).toISOString(),
      status: typeof entry.flight_status === 'string' ? entry.flight_status : null,
    });
  }

  logProvider(results.length > 0 ? 'info' : 'warn', 'normalization_completed', diagnostics, {
    provider: 'aviationstack',
    rawFlightCount: payload.data?.length ?? 0,
    returnedFlightCount: results.length,
    emptyReason:
      results.length > 0
        ? null
        : payload.data?.length
          ? 'all_provider_rows_missing_required_fields'
          : 'upstream_returned_no_flights',
  });

  return results.sort(
    (a, b) => new Date(a.scheduledDeparture).getTime() - new Date(b.scheduledDeparture).getTime(),
  );
}

export async function searchFlights(
  params: FlightSearchParams,
  diagnostics: FlightSearchDiagnostics = {},
): Promise<NormalizedFlightResult[]> {
  const depIata = normalizeIata(params.depIata);
  const arrIata = normalizeIata(params.arrIata);
  if (!/^[A-Z]{3}$/.test(depIata) || !/^[A-Z]{3}$/.test(arrIata) || depIata === arrIata) {
    throw new Error('INVALID_REQUEST');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.flightDate)) {
    throw new Error('INVALID_REQUEST');
  }
  if (!process.env.FLIGHT_SELECTION_SIGNING_SECRET?.trim()) {
    throw new Error('FLIGHT_SELECTION_SIGNING_SECRET is not configured');
  }

  const provider = resolveProvider();
  logProvider('info', 'provider_selected', diagnostics, {
    provider,
    departureAirport: depIata,
    arrivalAirport: arrIata,
    flightDate: params.flightDate,
  });
  return provider === 'aviationstack'
    ? searchAviationstack({ ...params, depIata, arrIata }, diagnostics)
    : searchAeroDataBox({ ...params, depIata, arrIata }, diagnostics);
}
