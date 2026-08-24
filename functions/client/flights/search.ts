import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';
import { searchFlights } from '../../_lib/flightProviders.js';

export default async function flightSearch(req: Request, res: Response) {
  const startedAt = Date.now();
  const requestId =
    (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id']) ||
    randomUUID();
  res.setHeader('x-request-id', requestId);

  const log = (
    level: 'info' | 'warn' | 'error',
    event: string,
    details: Record<string, unknown> = {},
  ) => {
    console[level](
      JSON.stringify({
        scope: 'client/flights/search',
        event,
        requestId,
        elapsedMs: Date.now() - startedAt,
        ...details,
      }),
    );
  };

  log('info', 'request_received', {
    method: req.method,
    contentType: req.headers['content-type'] ?? null,
    hasAuthorization: typeof req.headers.authorization === 'string',
  });

  if (req.method !== 'POST') {
    log('warn', 'request_rejected', { status: 405, reason: 'method_not_allowed' });
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    requireUser(req);
    log('info', 'authentication_succeeded');

    const body = req.body as Record<string, unknown>;
    const departureAirport =
      typeof body.departure_airport === 'string' ? body.departure_airport : '';
    const arrivalAirport = typeof body.arrival_airport === 'string' ? body.arrival_airport : '';
    const flightDate = typeof body.flight_date === 'string' ? body.flight_date : '';

    if (!departureAirport || !arrivalAirport || !flightDate) {
      log('warn', 'request_rejected', {
        status: 400,
        reason: 'missing_search_parameters',
        hasDepartureAirport: Boolean(departureAirport),
        hasArrivalAirport: Boolean(arrivalAirport),
        hasFlightDate: Boolean(flightDate),
      });
      return badRequest(res, 'departure_airport, arrival_airport, and flight_date are required');
    }

    log('info', 'search_started', {
      departureAirport: departureAirport.trim().toUpperCase(),
      arrivalAirport: arrivalAirport.trim().toUpperCase(),
      flightDate,
      configuredProvider: process.env.FLIGHT_PROVIDER?.trim().toLowerCase() || 'auto',
      hasRapidApiKey: Boolean(process.env.RAPIDAPI_KEY?.trim()),
      hasAviationstackKey: Boolean(process.env.AVIATIONSTACK_API_KEY?.trim()),
      hasSelectionSigningSecret: Boolean(process.env.FLIGHT_SELECTION_SIGNING_SECRET?.trim()),
    });

    const flights = await searchFlights(
      {
        depIata: departureAirport,
        arrIata: arrivalAirport,
        flightDate,
      },
      { requestId },
    );

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    log('info', 'search_completed', {
      status: 200,
      flightCount: flights.length,
      empty: flights.length === 0,
    });
    return res.status(200).json({
      search_id: randomUUID(),
      expires_at: expiresAt,
      flights: flights.map((flight) => ({
        result_id: flight.resultId,
        selection_token: flight.selectionToken,
        flight_number: flight.flightNumber,
        airline_iata: flight.airlineIata,
        airline_name: flight.airlineName,
        departure_airport: flight.departureAirport,
        arrival_airport: flight.arrivalAirport,
        scheduled_departure: flight.scheduledDeparture,
        scheduled_arrival: flight.scheduledArrival,
        status: flight.status,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.includes('Authorization') || message === 'Invalid token') {
      log('warn', 'search_failed', { status: 401, stage: 'authentication', code: message });
      return unauthorized(res);
    }
    if (message.includes('User role')) {
      log('warn', 'search_failed', { status: 403, stage: 'authorization', code: message });
      return res.status(403).json({ message });
    }
    if (message.startsWith('FLIGHT_API_')) {
      log('warn', 'search_failed', { status: 503, stage: 'provider', code: message });
      return res.status(503).json({
        error: { code: message, message: 'Flight lookup is unavailable right now.' },
      });
    }
    if (message === 'INVALID_REQUEST') {
      log('warn', 'search_failed', { status: 400, stage: 'validation', code: message });
      return badRequest(res, 'Invalid flight search request');
    }
    if (message === 'FLIGHT_SELECTION_SIGNING_SECRET is not configured') {
      log('error', 'search_failed', {
        status: 503,
        stage: 'selection_token',
        code: 'FLIGHT_SELECTION_NOT_CONFIGURED',
      });
      return res.status(503).json({
        error: {
          code: 'FLIGHT_SELECTION_NOT_CONFIGURED',
          message: 'Flight selection is unavailable right now.',
        },
      });
    }

    log('error', 'search_failed', {
      status: 500,
      stage: 'unexpected',
      errorName: error instanceof Error ? error.name : typeof error,
      message,
    });
    return res.status(500).json({
      error: { code: 'FLIGHT_SEARCH_FAILED', message: 'Flight search failed' },
    });
  }
}
