import type { Request, Response } from 'express';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';

const PLACES_AUTOCOMPLETE = 'https://places.googleapis.com/v1/places:autocomplete';
const CITY_TYPES = ['locality', 'postal_town', 'administrative_area_level_1'];

type AddressComponent = {
  longText?: string;
  long_name?: string;
  types?: string[];
};

type PlacePrediction = {
  placeId?: string;
  text?: { text?: string };
  structuredFormat?: {
    mainText?: { text?: string };
    secondaryText?: { text?: string };
  };
};

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message === 'Invalid token' || message === 'User role required' || message.includes('Authorization');
}

function cityFrom(components: AddressComponent[]): string | null {
  for (const type of CITY_TYPES) {
    const match = components.find((component) => component.types?.includes(type));
    const name = match?.longText?.trim() || match?.long_name?.trim();
    if (name) return name;
  }
  return null;
}

function sessionTokenOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(token) ? token : '';
}

async function autocomplete(apiKey: string, query: string, city: string, sessionToken: string) {
  const input = [query, city].filter(Boolean).join(', ').slice(0, 200);
  const response = await fetch(PLACES_AUTOCOMPLETE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
    },
    body: JSON.stringify({
      input,
      languageCode: 'en',
      ...(sessionToken ? { sessionToken } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`places_autocomplete_${response.status}`);
  }
  const body = (await response.json()) as {
    suggestions?: { placePrediction?: PlacePrediction }[];
  };
  const places = [];
  for (const suggestion of body.suggestions ?? []) {
    const prediction = suggestion.placePrediction;
    const id = prediction?.placeId?.trim();
    const name = prediction?.structuredFormat?.mainText?.text?.trim() || prediction?.text?.text?.trim();
    if (!id || !name) continue;
    places.push({
      id,
      name,
      detail: prediction?.structuredFormat?.secondaryText?.text?.trim() ?? '',
    });
    if (places.length >= 8) break;
  }
  return places;
}

async function details(apiKey: string, placeId: string, sessionToken: string) {
  const url = new URL(`https://places.googleapis.com/v1/places/${placeId}`);
  if (sessionToken) url.searchParams.set('sessionToken', sessionToken);
  const response = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'displayName,formattedAddress,addressComponents',
    },
  });
  if (!response.ok) {
    throw new Error(`places_details_${response.status}`);
  }
  const body = (await response.json()) as {
    displayName?: { text?: string };
    formattedAddress?: string;
    addressComponents?: AddressComponent[];
  };
  const name = body.displayName?.text?.trim() ?? '';
  const address = body.formattedAddress?.trim() ?? '';
  if (!name && !address) {
    throw new Error('places_details_empty');
  }
  return {
    name: name || address,
    address,
    city: cityFrom(body.addressComponents ?? []),
  };
}

/** POST /v1/client/places/search  { query, city?, sessionToken } or { placeId, sessionToken } */
export default async function placesSearch(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    requireUser(req);
    const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim() ?? '';
    if (!apiKey) {
      return res.status(503).json({
        error: { code: 'PLACES_UNAVAILABLE', message: 'Place search is unavailable right now.' },
      });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionToken = sessionTokenOf(body.sessionToken);
    const placeId = typeof body.placeId === 'string' ? body.placeId.trim() : '';
    if (placeId) {
      if (!/^[A-Za-z0-9_-]+$/.test(placeId)) {
        return badRequest(res, 'placeId is invalid');
      }
      const place = await details(apiKey, placeId, sessionToken);
      return res.status(200).json({ place });
    }

    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (query.length < 2) {
      return res.status(200).json({ places: [] });
    }
    if (query.length > 120) {
      return badRequest(res, 'query is too long');
    }
    const city = typeof body.city === 'string' ? body.city.trim().slice(0, 80) : '';
    const places = await autocomplete(apiKey, query, city, sessionToken);
    return res.status(200).json({ places });
  } catch (error) {
    if (isAuthError(error)) return unauthorized(res);
    console.error(
      JSON.stringify({
        scope: 'client/places/search',
        event: 'search_failed',
        message: error instanceof Error ? error.message : 'unknown',
      }),
    );
    return res.status(503).json({
      error: { code: 'PLACES_UNAVAILABLE', message: 'Place search is unavailable right now.' },
    });
  }
}
