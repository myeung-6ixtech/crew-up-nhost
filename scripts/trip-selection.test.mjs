import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.FLIGHT_SELECTION_SIGNING_SECRET = 'test-secret';

const { createFlightSelectionToken, verifyFlightSelectionToken } = await import(
  '../functions/_lib/flightSelection.ts'
);

test('flight selection token round trip', () => {
  const token = createFlightSelectionToken({
    flightNumber: 'CX123',
    airlineIata: 'CX',
    serviceDate: '2026-08-22',
    departureAirport: 'HKG',
    arrivalAirport: 'NRT',
    scheduledDeparture: '2026-08-22T08:00:00.000Z',
    scheduledArrival: '2026-08-22T13:00:00.000Z',
    provider: 'test',
    providerFlightId: 'cx123',
  });

  const payload = verifyFlightSelectionToken(token);
  assert.equal(payload.flightNumber, 'CX123');
  assert.equal(payload.departureAirport, 'HKG');
});

test('rejects tampered flight selection token', () => {
  const token = createFlightSelectionToken({
    flightNumber: 'CX123',
    serviceDate: '2026-08-22',
    departureAirport: 'HKG',
    arrivalAirport: 'NRT',
    scheduledDeparture: '2026-08-22T08:00:00.000Z',
    scheduledArrival: '2026-08-22T13:00:00.000Z',
  });

  assert.throws(() => verifyFlightSelectionToken(`${token}x`), /INVALID_FLIGHT_SELECTION/);
});

void createHmac;
