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

function resolveProvider(): 'aerodatabox' | 'aviationstack' {
  const configured = process.env.FLIGHT_PROVIDER?.trim().toLowerCase();
  if (configured === 'aviationstack' || configured === 'aerodatabox') {
    return configured;
  }
  if (process.env.RAPIDAPI_KEY?.trim()) return 'aerodatabox';
  if (process.env.AVIATIONSTACK_API_KEY?.trim()) return 'aviationstack';
  return 'aerodatabox';
}

async function searchAeroDataBox(params: FlightSearchParams): Promise<NormalizedFlightResult[]> {
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
    const path = `/flights/airports/iata/${encodeURIComponent(depIata)}/${window.from}/${window.to}`;
    const url = new URL(`https://${host}${path}`);
    url.searchParams.set('direction', 'Departure');
    url.searchParams.set('withLeg', 'true');

    const response = await scheduleRequest(async () =>
      fetch(url.toString(), {
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': host,
          'Content-Type': 'application/json',
        },
      }),
    );

    if (response.status === 429) throw new Error('FLIGHT_API_RATE_LIMIT');
    if (response.status === 401 || response.status === 403) {
      throw new Error('FLIGHT_API_NOT_CONFIGURED');
    }

    const payload = (await response.json()) as { departures?: Array<Record<string, unknown>> };
    if (!response.ok) throw new Error('FLIGHT_API_REQUEST_FAILED');
    departures.push(...(payload.departures ?? []));
  }

  const seen = new Set<string>();
  const results: NormalizedFlightResult[] = [];

  for (const entry of departures) {
    const arrival = entry.arrival as Record<string, unknown> | undefined;
    const airport = arrival?.airport as Record<string, unknown> | undefined;
    if (airport?.iata !== arrIata) continue;

    const departure = entry.departure as Record<string, unknown> | undefined;
    const depTimeObj = (departure?.revisedTime ?? departure?.scheduledTime) as
      | Record<string, string>
      | undefined;
    const arrTimeObj = (arrival?.revisedTime ?? arrival?.scheduledTime) as
      | Record<string, string>
      | undefined;
    const depUtc = depTimeObj?.utc?.replace(' ', 'T');
    const arrUtc = arrTimeObj?.utc?.replace(' ', 'T');
    const flightNumber = normalizeFlightNumber(String(entry.number ?? ''));
    if (!flightNumber || !depUtc || !arrUtc) continue;

    const scheduledDeparture = new Date(depUtc).toISOString();
    const scheduledArrival = new Date(arrUtc).toISOString();
    const dedupeKey = `${flightNumber}-${scheduledDeparture}`;
    if (seen.has(dedupeKey)) continue;
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

  return results.sort(
    (a, b) => new Date(a.scheduledDeparture).getTime() - new Date(b.scheduledDeparture).getTime(),
  );
}

async function searchAviationstack(params: FlightSearchParams): Promise<NormalizedFlightResult[]> {
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

  const response = await fetch(url.toString());
  const payload = (await response.json()) as {
    data?: Array<Record<string, unknown>>;
    error?: { code?: string; message?: string };
  };

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

  return results.sort(
    (a, b) => new Date(a.scheduledDeparture).getTime() - new Date(b.scheduledDeparture).getTime(),
  );
}

export async function searchFlights(params: FlightSearchParams): Promise<NormalizedFlightResult[]> {
  const depIata = normalizeIata(params.depIata);
  const arrIata = normalizeIata(params.arrIata);
  if (!/^[A-Z]{3}$/.test(depIata) || !/^[A-Z]{3}$/.test(arrIata) || depIata === arrIata) {
    throw new Error('INVALID_REQUEST');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.flightDate)) {
    throw new Error('INVALID_REQUEST');
  }

  const provider = resolveProvider();
  return provider === 'aviationstack'
    ? searchAviationstack({ ...params, depIata, arrIata })
    : searchAeroDataBox({ ...params, depIata, arrIata });
}
