import type { Request, Response } from 'express';
import { badRequest, requireUser, unauthorized } from '../../_lib/auth.js';

/**
 * Venue search for meets (Places API (New); the key stays on the server).
 *
 * POST /v1/client/places/search
 *  - { query, city?, lat?, lng?, originLat?, originLng?, sessionToken }   autocomplete, biased to the city
 *  - { placeId, sessionToken }                                           details (name, address, city, coordinates)
 *  - { mode: 'nearby', city, lat?, lng?, types?, originLat?, originLng? } places near the city centre, by distance
 *  - { mode: 'reverse', lat, lng }                                        the place at a spot ("Use current location")
 * Every place carries Google's types so the app can pick an activity icon, and coordinates or a distance.
 */

const PLACES = 'https://places.googleapis.com/v1';
const CITY_TYPES = ['locality', 'postal_town', 'administrative_area_level_1'];
/** Searches lean to this radius around the meet's city. */
const CITY_BIAS_METERS = 25_000;
const NEARBY_RADIUS_METERS = 6_000;
/** When the meet has no activities, nearby shows everyday meetup places. */
const DEFAULT_NEARBY_TYPES = ['cafe', 'bar', 'restaurant', 'gym', 'park'];

type AddressComponent = { longText?: string; shortText?: string; long_name?: string; types?: string[] };
type LatLng = { latitude: number; longitude: number };
type PlacePrediction = {
  placeId?: string;
  types?: string[];
  distanceMeters?: number;
  text?: { text?: string };
  structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
};
type NearbyPlace = {
  id?: string;
  displayName?: { text?: string };
  shortFormattedAddress?: string;
  formattedAddress?: string;
  location?: LatLng;
  types?: string[];
  primaryType?: string;
  addressComponents?: AddressComponent[];
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

function countryCodeFrom(components: AddressComponent[]): string | null {
  return components.find((component) => component.types?.includes('country'))?.shortText?.trim() || null;
}

function sessionTokenOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(token) ? token : '';
}

function coordinate(value: unknown, limit: number): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

function point(lat: unknown, lng: unknown): LatLng | null {
  const latitude = coordinate(lat, 90);
  const longitude = coordinate(lng, 180);
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

/** Google types that are safe to pass on (letters and underscores only), at most 20. */
function typeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[a-z_]{2,40}$/.test(item)))].slice(0, 20);
}

async function google<T>(path: string, apiKey: string, init: { method?: string; body?: unknown; fieldMask?: string; event: string }): Promise<T> {
  const response = await fetch(`${PLACES}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      ...(init.fieldMask ? { 'X-Goog-FieldMask': init.fieldMask } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    // Google's reason (API not enabled, key restricted, billing off) is logged, never returned.
    const reason = await response.text().catch(() => '');
    console.error(JSON.stringify({ scope: 'client/places/search', event: `google_${init.event}_error`, status: response.status, reason: reason.slice(0, 400) }));
    throw new Error(`places_${init.event}_${response.status}`);
  }
  return (await response.json()) as T;
}

/** A city's centre and "City, CC" label, cached for the life of the function instance. */
const cityCache = new Map<string, { center: LatLng; label: string } | null>();
async function cityCenter(apiKey: string, city: string): Promise<{ center: LatLng; label: string } | null> {
  const key = city.trim().toLowerCase();
  if (!key) return null;
  if (cityCache.has(key)) return cityCache.get(key) ?? null;
  const body = await google<{ places?: NearbyPlace[] }>('/places:searchText', apiKey, {
    body: { textQuery: city, includedType: 'locality', languageCode: 'en', maxResultCount: 1 },
    fieldMask: 'places.location,places.displayName,places.addressComponents',
    event: 'city',
  }).catch(() => ({ places: [] }));
  const place = body.places?.[0];
  const found = place?.location
    ? {
        center: place.location,
        label: [place.displayName?.text?.trim() || city, countryCodeFrom(place.addressComponents ?? [])].filter(Boolean).join(', '),
      }
    : null;
  if (cityCache.size > 500) cityCache.clear();
  cityCache.set(key, found);
  return found;
}

function toPlace(place: NearbyPlace) {
  const id = place.id?.trim();
  const name = place.displayName?.text?.trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    detail: place.shortFormattedAddress?.trim() || place.formattedAddress?.trim() || '',
    address: place.formattedAddress?.trim() || '',
    city: cityFrom(place.addressComponents ?? []),
    types: place.types ?? (place.primaryType ? [place.primaryType] : []),
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
  };
}

const NEARBY_MASK =
  'places.id,places.displayName,places.shortFormattedAddress,places.formattedAddress,places.location,places.types,places.primaryType,places.addressComponents';

async function autocomplete(apiKey: string, query: string, center: LatLng | null, origin: LatLng | null, sessionToken: string) {
  const body = await google<{ suggestions?: { placePrediction?: PlacePrediction }[] }>('/places:autocomplete', apiKey, {
    body: {
      input: query.slice(0, 200),
      languageCode: 'en',
      ...(center ? { locationBias: { circle: { center, radius: CITY_BIAS_METERS } } } : {}),
      ...(origin ?? center ? { origin: origin ?? center } : {}),
      ...(sessionToken ? { sessionToken } : {}),
    },
    event: 'autocomplete',
  });
  if (!body.suggestions?.length) {
    // An empty answer for a real place name usually means the wrong API or project behind the key.
    console.warn(JSON.stringify({ scope: 'client/places/search', event: 'google_empty', inputLength: query.length, keys: Object.keys(body) }));
  }
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
      types: prediction?.types ?? [],
      distanceMeters: typeof prediction?.distanceMeters === 'number' ? prediction.distanceMeters : null,
    });
    if (places.length >= 8) break;
  }
  return places;
}

async function details(apiKey: string, placeId: string, sessionToken: string) {
  const query = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '';
  const body = await google<NearbyPlace>(`/places/${placeId}${query}`, apiKey, {
    method: 'GET',
    fieldMask: 'id,displayName,formattedAddress,addressComponents,location,types',
    event: 'details',
  });
  const name = body.displayName?.text?.trim() ?? '';
  const address = body.formattedAddress?.trim() ?? '';
  if (!name && !address) throw new Error('places_details_empty');
  return {
    id: placeId,
    name: name || address,
    address,
    city: cityFrom(body.addressComponents ?? []),
    types: body.types ?? [],
    lat: body.location?.latitude ?? null,
    lng: body.location?.longitude ?? null,
  };
}

async function nearby(apiKey: string, center: LatLng, types: string[], radius: number, max: number) {
  const body = await google<{ places?: NearbyPlace[] }>('/places:searchNearby', apiKey, {
    body: {
      includedTypes: types.length ? types : DEFAULT_NEARBY_TYPES,
      maxResultCount: max,
      rankPreference: 'DISTANCE',
      languageCode: 'en',
      locationRestriction: { circle: { center, radius } },
    },
    fieldMask: NEARBY_MASK,
    event: 'nearby',
  });
  return (body.places ?? []).map(toPlace).filter((place) => place !== null);
}

export default async function placesSearch(req: Request, res: Response) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    requireUser(req);
    const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim() ?? '';
    if (!apiKey) {
      return res.status(503).json({ error: { code: 'PLACES_UNAVAILABLE', message: 'Place search is unavailable right now.' } });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionToken = sessionTokenOf(body.sessionToken);
    const city = typeof body.city === 'string' ? body.city.trim().slice(0, 80) : '';
    const origin = point(body.originLat, body.originLng);

    if (body.mode === 'reverse') {
      const at = point(body.lat, body.lng);
      if (!at) return badRequest(res, 'lat and lng are required');
      // The closest named place within ~80 m (no Geocoding API needed).
      const [place] = await nearby(apiKey, at, [], 80, 1).catch(() => []);
      return res.status(200).json({ place: place ?? null });
    }

    if (body.mode === 'nearby') {
      const known = point(body.lat, body.lng);
      const resolved = await cityCenter(apiKey, city);
      const center = known ?? resolved?.center ?? null;
      if (!center) return res.status(200).json({ places: [], center: null, cityLabel: city || null });
      const places = await nearby(apiKey, center, typeList(body.types), NEARBY_RADIUS_METERS, 12);
      return res.status(200).json({ places, center: { lat: center.latitude, lng: center.longitude }, cityLabel: resolved?.label ?? city });
    }

    const placeId = typeof body.placeId === 'string' ? body.placeId.trim() : '';
    if (placeId) {
      if (!/^[A-Za-z0-9_-]+$/.test(placeId)) return badRequest(res, 'placeId is invalid');
      const place = await details(apiKey, placeId, sessionToken);
      return res.status(200).json({ place });
    }

    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (query.length < 2) return res.status(200).json({ places: [] });
    if (query.length > 120) return badRequest(res, 'query is too long');
    const center = point(body.lat, body.lng) ?? (await cityCenter(apiKey, city))?.center ?? null;
    // Without coordinates the city name still narrows the search, as before.
    const input = center ? query : [query, city].filter(Boolean).join(', ');
    const places = await autocomplete(apiKey, input, center, origin, sessionToken);
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
    return res.status(503).json({ error: { code: 'PLACES_UNAVAILABLE', message: 'Place search is unavailable right now.' } });
  }
}
