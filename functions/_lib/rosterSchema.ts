import type { RosterParseEntry } from './auth.js';

export const DUTY_TYPES = ['flight', 'deadhead', 'standby', 'off', 'training', 'other'] as const;
export type DutyType = (typeof DUTY_TYPES)[number];

export interface ExtractedDuty {
  type: DutyType;
  flight_number: string | null;
  departure_airport: string | null;
  arrival_airport: string | null;
  arrival_city: string | null;
  scheduled_departure: string | null;
  scheduled_arrival: string | null;
  confidence: number;
}

export interface RosterExtraction {
  home_base: string | null;
  duties: ExtractedDuty[];
  warnings: string[];
}

/**
 * JSON Schema sent to the model as `responseJsonSchema`. There is deliberately
 * no field for names, staff numbers, hotels or crew lists.
 */
export const ROSTER_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    home_base: {
      type: ['string', 'null'],
      description: 'IATA code of the crew home base if printed, otherwise null.',
    },
    duties: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...DUTY_TYPES] },
          flight_number: {
            type: ['string', 'null'],
            description: 'Airline designator plus number, e.g. SQ321. Null for non-flying duties.',
          },
          departure_airport: { type: ['string', 'null'], description: 'IATA code, e.g. SIN.' },
          arrival_airport: { type: ['string', 'null'], description: 'IATA code, e.g. LHR.' },
          arrival_city: { type: ['string', 'null'], description: 'City name of the arrival airport.' },
          scheduled_departure: {
            type: ['string', 'null'],
            description: 'ISO 8601 with explicit UTC offset, e.g. 2026-10-03T08:15:00+08:00.',
          },
          scheduled_arrival: {
            type: ['string', 'null'],
            description: 'ISO 8601 with explicit UTC offset.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: [
          'type',
          'flight_number',
          'departure_airport',
          'arrival_airport',
          'arrival_city',
          'scheduled_departure',
          'scheduled_arrival',
          'confidence',
        ],
      },
    },
    warnings: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
  required: ['home_base', 'duties', 'warnings'],
} as const;

export const ROSTER_EXTRACTION_INSTRUCTIONS = `You extract airline crew duties from a roster.

Rules:
1. Return every duty in the roster, including non-flying duties (standby, off, training).
2. Use type "deadhead" for positioning flights (often marked DH, DHD, PAX or POS).
3. Times must be ISO 8601 with an explicit UTC offset. If the roster states times are UTC/Z, use +00:00. If they are local times, use the offset of that airport on that date. If you cannot tell which, set the time to null and add a warning.
4. Arrivals after midnight belong to the next date; do not reuse the departure date.
5. Use IATA airport codes. If only ICAO codes are printed, convert them when you are certain, otherwise keep the ICAO code.
6. Never output a person's name, staff number, hotel, or crew list, even if present. Text shown as [redacted] was removed on purpose.
7. Set confidence below 0.8 for anything read from an unclear or ambiguous layout.`;

export const PARSER_VERSION = 'gemini-roster-v1';

const FLIGHT_NUMBER = /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/;
const AIRPORT = /^[A-Z]{3,4}$/;
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function cleanString(value: unknown, max = 80): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function cleanFlightNumber(value: unknown): string | null {
  const raw = cleanString(value)?.toUpperCase().replace(/[\s-]/g, '');
  return raw && FLIGHT_NUMBER.test(raw) ? raw : null;
}

function cleanAirport(value: unknown): string | null {
  const raw = cleanString(value)?.toUpperCase();
  return raw && AIRPORT.test(raw) ? raw : null;
}

function cleanTimestamp(value: unknown): string | null {
  const raw = cleanString(value);
  if (!raw || !OFFSET_TIMESTAMP.test(raw)) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Keeps only fields in the contract; anything else the model returns is dropped. */
export function validateExtraction(raw: unknown): RosterExtraction | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { duties?: unknown }).duties)) {
    return null;
  }
  const source = raw as { home_base?: unknown; duties: unknown[]; warnings?: unknown };

  const duties: ExtractedDuty[] = [];
  for (const item of source.duties) {
    if (!item || typeof item !== 'object') continue;
    const duty = item as Record<string, unknown>;
    const type = DUTY_TYPES.includes(duty.type as DutyType) ? (duty.type as DutyType) : 'other';
    const confidence = typeof duty.confidence === 'number' ? Math.min(1, Math.max(0, duty.confidence)) : 0;

    duties.push({
      type,
      flight_number: cleanFlightNumber(duty.flight_number),
      departure_airport: cleanAirport(duty.departure_airport),
      arrival_airport: cleanAirport(duty.arrival_airport),
      arrival_city: cleanString(duty.arrival_city, 60),
      scheduled_departure: cleanTimestamp(duty.scheduled_departure),
      scheduled_arrival: cleanTimestamp(duty.scheduled_arrival),
      confidence,
    });
  }

  const warnings = Array.isArray(source.warnings)
    ? source.warnings.map((w) => cleanString(w, 200)).filter((w): w is string => Boolean(w))
    : [];

  return { home_base: cleanAirport(source.home_base), duties, warnings };
}

type FlightLeg = ExtractedDuty & {
  departure_airport: string;
  arrival_airport: string;
  scheduled_departure: string;
  scheduled_arrival: string;
};

const HOUR_MS = 60 * 60 * 1000;
/** Shorter ground time is a turnaround, not a layover. */
const MIN_LAYOVER_MS = 4 * HOUR_MS;
/** Longer gaps usually mean a missing duty between the two flights. */
const MAX_LAYOVER_MS = 7 * 24 * HOUR_MS;

function isCompleteLeg(duty: ExtractedDuty): duty is FlightLeg {
  return (
    (duty.type === 'flight' || duty.type === 'deadhead') &&
    Boolean(duty.departure_airport && duty.arrival_airport) &&
    Boolean(duty.scheduled_departure && duty.scheduled_arrival)
  );
}

/**
 * Derives layovers from consecutive legs: the crew lands away from base and the
 * next leg departs from that same airport.
 */
export function layoversFromExtraction(extraction: RosterExtraction): RosterParseEntry[] {
  const legs = extraction.duties
    .filter(isCompleteLeg)
    .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));

  const homeBase = extraction.home_base ?? legs[0]?.departure_airport ?? null;
  const layovers: RosterParseEntry[] = [];

  for (let index = 0; index < legs.length - 1; index += 1) {
    const inbound = legs[index];
    const outbound = legs[index + 1];
    if (inbound.arrival_airport === homeBase) continue;
    if (inbound.arrival_airport !== outbound.departure_airport) continue;

    const groundMs =
      new Date(outbound.scheduled_departure).getTime() - new Date(inbound.scheduled_arrival).getTime();
    if (groundMs < MIN_LAYOVER_MS || groundMs > MAX_LAYOVER_MS) continue;

    layovers.push({
      flightNumber: inbound.flight_number,
      departureAirport: inbound.departure_airport,
      arrivalAirport: inbound.arrival_airport,
      layoverCity: inbound.arrival_city ?? inbound.arrival_airport,
      layoverStart: inbound.scheduled_arrival,
      layoverEnd: outbound.scheduled_departure,
    });
  }

  return layovers;
}
