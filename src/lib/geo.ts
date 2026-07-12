// Client-safe geography: the 20 demo cities and the great-circle helper.
//
// Split out of world.ts because world.ts imports node:crypto for its IDs and so
// cannot be pulled into a client component. The map wall needs the city list and
// the km label, so the data lives here (no node imports) and world.ts re-exports
// it. One source of truth for both server and client.

export interface City {
  name: string;
  lat: number;
  lon: number;
  currency: string;
}

// ~20 real cities spread across regions, each with its home currency.
export const CITIES: readonly City[] = [
  { name: "New York", lat: 40.7128, lon: -74.006, currency: "USD" },
  { name: "San Francisco", lat: 37.7749, lon: -122.4194, currency: "USD" },
  { name: "Chicago", lat: 41.8781, lon: -87.6298, currency: "USD" },
  { name: "Toronto", lat: 43.6532, lon: -79.3832, currency: "CAD" },
  { name: "Mexico City", lat: 19.4326, lon: -99.1332, currency: "MXN" },
  { name: "Sao Paulo", lat: -23.5505, lon: -46.6333, currency: "BRL" },
  { name: "London", lat: 51.5074, lon: -0.1278, currency: "GBP" },
  { name: "Paris", lat: 48.8566, lon: 2.3522, currency: "EUR" },
  { name: "Berlin", lat: 52.52, lon: 13.405, currency: "EUR" },
  { name: "Madrid", lat: 40.4168, lon: -3.7038, currency: "EUR" },
  { name: "Rome", lat: 41.9028, lon: 12.4964, currency: "EUR" },
  { name: "Amsterdam", lat: 52.3676, lon: 4.9041, currency: "EUR" },
  { name: "Stockholm", lat: 59.3293, lon: 18.0686, currency: "SEK" },
  { name: "Dubai", lat: 25.2048, lon: 55.2708, currency: "AED" },
  { name: "Mumbai", lat: 19.076, lon: 72.8777, currency: "INR" },
  { name: "Singapore", lat: 1.3521, lon: 103.8198, currency: "SGD" },
  { name: "Tokyo", lat: 35.6762, lon: 139.6503, currency: "JPY" },
  { name: "Sydney", lat: -33.8688, lon: 151.2093, currency: "AUD" },
  { name: "Johannesburg", lat: -26.2041, lon: 28.0473, currency: "ZAR" },
  { name: "Cape Town", lat: -33.9249, lon: 18.4241, currency: "ZAR" },
];

const EARTH_KM = 6371;

// Great-circle distance in km. Shared by features.ts (impossible_travel), the
// world generator, and the wall's geo-hop arc label.
export function haversineKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}
