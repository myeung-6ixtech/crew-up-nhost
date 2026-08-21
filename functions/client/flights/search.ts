import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';
import { searchFlights } from '../../_lib/flightProviders.js';

export default async function flightSearch(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    requireUser(req);
    const body = req.body as Record<string, unknown>;
    const departureAirport =
      typeof body.departure_airport === 'string' ? body.departure_airport : '';
    const arrivalAirport = typeof body.arrival_airport === 'string' ? body.arrival_airport : '';
    const flightDate = typeof body.flight_date === 'string' ? body.flight_date : '';

    if (!departureAirport || !arrivalAirport || !flightDate) {
      return badRequest(res, 'departure_airport, arrival_airport, and flight_date are required');
    }

    const flights = await searchFlights({
      depIata: departureAirport,
      arrIata: arrivalAirport,
      flightDate,
    });

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
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
    if (error instanceof Error && error.message.includes('Authorization')) {
      return unauthorized(res);
    }
    if (error instanceof Error && error.message.includes('User role')) {
      return res.status(403).json({ message: error.message });
    }
    if (error instanceof Error && error.message.startsWith('FLIGHT_API_')) {
      return res.status(503).json({
        error: { code: error.message, message: 'Flight lookup is unavailable right now.' },
      });
    }
    if (error instanceof Error && error.message === 'INVALID_REQUEST') {
      return badRequest(res, 'Invalid flight search request');
    }
    console.error('client/flights/search error', error);
    return res.status(500).json({
      error: { code: 'FLIGHT_SEARCH_FAILED', message: 'Flight search failed' },
    });
  }
}
