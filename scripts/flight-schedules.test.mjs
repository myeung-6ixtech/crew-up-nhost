import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLIGHT_SELECTION_SIGNING_SECRET = 'test-secret';
process.env.FLIGHT_PROVIDER = 'aerodatabox';
process.env.RAPIDAPI_KEY = 'test-rapidapi-key';
process.env.FLIGHT_PROVIDER_MIN_REQUEST_GAP_MS = '0';

const {
  SELECTION_TOKEN_TTL_MS,
  TTL_TIERS_MS,
  cacheExpiresAt,
  cacheTtlMs,
  daysToDeparture,
  isUsableSchedule,
  toSelectionResults,
} = await import('../functions/_lib/flightCachePolicy.ts');

const { searchFlightSchedules, validateFlightSearchParams } = await import(
  '../functions/_lib/flightProviders.ts'
);

const { verifyFlightSelectionToken } = await import('../functions/_lib/flightSelection.ts');

const NOW = new Date('2026-09-21T00:00:00.000Z');

function schedule(overrides = {}) {
  return {
    flightNumber: 'CX255',
    airlineIata: 'CX',
    airlineName: 'Cathay Pacific',
    serviceDate: '2026-09-21',
    departureAirport: 'HKG',
    arrivalAirport: 'LHR',
    scheduledDeparture: '2026-09-21T02:00:00.000Z',
    scheduledArrival: '2026-09-21T15:00:00.000Z',
    status: 'Scheduled',
    provider: 'aerodatabox',
    providerFlightId: 'CX255-2026-09-21T02:00:00.000Z',
    ...overrides,
  };
}

/** Minimal AeroDataBox departure entry; both daily windows return the same shape. */
function departure(overrides = {}) {
  return {
    number: 'CX 255',
    airline: { iata: 'CX', name: 'Cathay Pacific' },
    status: 'Scheduled',
    departure: {
      scheduledTime: { utc: '2026-09-21 02:00Z', local: '2026-09-21 10:00+08:00' },
    },
    arrival: {
      airport: { iata: 'LHR', name: 'London Heathrow' },
      scheduledTime: { utc: '2026-09-21 15:00Z', local: '2026-09-21 16:00+01:00' },
    },
    ...overrides,
  };
}

function stubAeroDataBox(windows) {
  const calls = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const departures = windows[index] ?? [];
    index += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ departures }),
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('TTL tiers scale with days to departure', () => {
  assert.equal(cacheTtlMs('2026-10-20', NOW), TTL_TIERS_MS.farOut, 'more than 14 days out');
  assert.equal(cacheTtlMs('2026-09-30', NOW), TTL_TIERS_MS.midRange, '9 days out');
  assert.equal(cacheTtlMs('2026-09-24', NOW), TTL_TIERS_MS.midRange, 'exactly 3 days out');
  assert.equal(cacheTtlMs('2026-09-23', NOW), TTL_TIERS_MS.nearTerm, '2 days out');
  assert.equal(cacheTtlMs('2026-09-21', NOW), TTL_TIERS_MS.nearTerm, 'same day');
  assert.equal(cacheTtlMs('2026-09-10', NOW), TTL_TIERS_MS.farOut, 'settled history');
});

test('days to departure counts whole calendar days', () => {
  assert.equal(daysToDeparture('2026-09-21', NOW), 0);
  assert.equal(daysToDeparture('2026-09-22', NOW), 1);
  assert.equal(daysToDeparture('2026-09-20', NOW), -1);
});

test('cache expiry is derived from the TTL tier', () => {
  assert.equal(
    cacheExpiresAt('2026-09-22', NOW),
    new Date(NOW.getTime() + TTL_TIERS_MS.nearTerm).toISOString(),
  );
});

test('cached schedules mint fresh short-lived selection tokens', () => {
  const before = Date.now();
  const [result] = toSelectionResults([schedule()]);

  assert.equal(result.resultId, 'CX255-2026-09-21T02:00:00.000Z');
  const payload = verifyFlightSelectionToken(result.selectionToken);
  assert.equal(payload.flightNumber, 'CX255');
  assert.equal(payload.serviceDate, '2026-09-21');
  assert.equal(payload.departureAirport, 'HKG');
  assert.ok(
    payload.exp >= before + SELECTION_TOKEN_TTL_MS - 1000 &&
      payload.exp <= Date.now() + SELECTION_TOKEN_TTL_MS,
    'token expiry is measured from now, not from when the row was cached',
  );
});

test('malformed cache rows are dropped instead of returned', () => {
  assert.equal(isUsableSchedule(schedule()), true);
  assert.equal(isUsableSchedule({ flightNumber: 'CX255' }), false);
  assert.equal(isUsableSchedule(null), false);
  assert.deepEqual(toSelectionResults([{ flightNumber: 'CX255' }, null]), []);
});

test('normalization prefers scheduled times over operational revisions', async () => {
  const stub = stubAeroDataBox([
    [
      departure({
        departure: {
          scheduledTime: { utc: '2026-09-21 02:00Z' },
          revisedTime: { utc: '2026-09-21 03:45Z' },
        },
        arrival: {
          airport: { iata: 'LHR' },
          scheduledTime: { utc: '2026-09-21 15:00Z' },
          revisedTime: { utc: '2026-09-21 16:30Z' },
        },
      }),
    ],
    [],
  ]);

  try {
    const { provider, schedules } = await searchFlightSchedules({
      depIata: 'HKG',
      arrIata: 'LHR',
      flightDate: '2026-09-21',
    });

    assert.equal(provider, 'aerodatabox');
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].scheduledDeparture, '2026-09-21T02:00:00.000Z');
    assert.equal(schedules[0].scheduledArrival, '2026-09-21T15:00:00.000Z');
  } finally {
    stub.restore();
  }
});

test('revised times are only a fallback when no scheduled time exists', async () => {
  const stub = stubAeroDataBox([
    [
      departure({
        departure: { revisedTime: { utc: '2026-09-21 02:30Z' } },
        arrival: { airport: { iata: 'LHR' }, revisedTime: { utc: '2026-09-21 15:30Z' } },
      }),
    ],
    [],
  ]);

  try {
    const { schedules } = await searchFlightSchedules({
      depIata: 'HKG',
      arrIata: 'LHR',
      flightDate: '2026-09-21',
    });
    assert.equal(schedules[0].scheduledDeparture, '2026-09-21T02:30:00.000Z');
  } finally {
    stub.restore();
  }
});

test('service date is the requested local date, not a UTC slice', async () => {
  // Departs 23:30 local in Hong Kong, which is 15:30Z on the same day; a flight
  // leaving just after local midnight would otherwise be dated a day early.
  const stub = stubAeroDataBox([
    [],
    [
      departure({
        number: 'CX 251',
        departure: { scheduledTime: { utc: '2026-09-20 16:30Z' } },
        arrival: { airport: { iata: 'LHR' }, scheduledTime: { utc: '2026-09-21 05:30Z' } },
      }),
    ],
  ]);

  try {
    const { schedules } = await searchFlightSchedules({
      depIata: 'HKG',
      arrIata: 'LHR',
      flightDate: '2026-09-21',
    });

    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].serviceDate, '2026-09-21');
    assert.equal(schedules[0].scheduledDeparture, '2026-09-20T16:30:00.000Z');
  } finally {
    stub.restore();
  }
});

test('departures to other airports and incomplete rows are filtered out', async () => {
  const stub = stubAeroDataBox([
    [
      departure({ arrival: { airport: { iata: 'NRT' }, scheduledTime: { utc: '2026-09-21 07:00Z' } } }),
      departure({ number: '' }),
      departure({ number: 'CX 257', arrival: { airport: { iata: 'LHR' } } }),
      departure(),
      departure(),
    ],
    [],
  ]);

  try {
    const { schedules } = await searchFlightSchedules({
      depIata: 'HKG',
      arrIata: 'LHR',
      flightDate: '2026-09-21',
    });

    assert.equal(schedules.length, 1, 'one valid flight survives, the duplicate is dropped');
    assert.equal(schedules[0].flightNumber, 'CX255');
  } finally {
    stub.restore();
  }
});

test('an empty upstream response yields no schedules rather than an error', async () => {
  const stub = stubAeroDataBox([[], []]);
  try {
    const { schedules } = await searchFlightSchedules({
      depIata: 'HKG',
      arrIata: 'LHR',
      flightDate: '2026-09-21',
    });
    assert.deepEqual(schedules, []);
  } finally {
    stub.restore();
  }
});

test('both halves of the local service day are queried', async () => {
  const stub = stubAeroDataBox([[], []]);
  try {
    await searchFlightSchedules({ depIata: 'HKG', arrIata: 'LHR', flightDate: '2026-09-21' });
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.calls[0].includes('/HKG/2026-09-21T00:00/2026-09-21T11:59'), stub.calls[0]);
    assert.ok(stub.calls[1].includes('/HKG/2026-09-21T12:00/2026-09-21T23:59'), stub.calls[1]);
    assert.ok(stub.calls[0].includes('direction=Departure'));
  } finally {
    stub.restore();
  }
});

test('search parameters are validated before any provider call', () => {
  assert.deepEqual(validateFlightSearchParams({ depIata: 'hkg', arrIata: 'lhr', flightDate: '2026-09-21' }), {
    depIata: 'HKG',
    arrIata: 'LHR',
    flightDate: '2026-09-21',
  });
  assert.throws(
    () => validateFlightSearchParams({ depIata: 'HKG', arrIata: 'HKG', flightDate: '2026-09-21' }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => validateFlightSearchParams({ depIata: 'HK', arrIata: 'LHR', flightDate: '2026-09-21' }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => validateFlightSearchParams({ depIata: 'HKG', arrIata: 'LHR', flightDate: '21-09-2026' }),
    /INVALID_REQUEST/,
  );
});
