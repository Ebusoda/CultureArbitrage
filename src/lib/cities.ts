import { geoDistance } from "d3-geo";

// Cities a viewer can explore, and that the agent compares against each other.
// Each must exist in mock-data.ts too, so the app still runs without a Qloo key.
export const CITIES = ["Tokyo", "New York", "Seoul"];

// What to send Qloo as a location query: plain "New York" also matches the state.
const QLOO_LOCATION: Record<string, string> = { "New York": "New York City" };
export function qlooLocation(city: string): string {
  return own(QLOO_LOCATION, city) ?? city;
}

// Language and region for Google Maps searches in each city.
export const CITY_LANGUAGE: Record<string, { lang: "ja" | "en" | "ko"; region: string }> = {
  Tokyo: { lang: "ja", region: "JP" },
  "New York": { lang: "en", region: "US" },
  Seoul: { lang: "ko", region: "KR" },
};

const CITY_ALIASES: Record<string, string> = {
  nyc: "New York",
  "new york city": "New York",
  ny: "New York",
  tokyo: "Tokyo",
  "東京": "Tokyo",
  "东京": "Tokyo",
  "서울": "Seoul",
  "首尔": "Seoul",
  "ソウル": "Seoul",
};

// A plain object lookup that ignores inherited keys: "constructor" or "__proto__" is not a city.
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\-_]+/g, " ").trim();

// "tokyo", " NYC ", "東京" -> the city's name in CITIES. Null if it isn't one.
export function canonicalCity(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = norm(raw);
  if (!n) return null;
  return CITIES.find((c) => norm(c) === n) ?? own(CITY_ALIASES, n) ?? null;
}

// [lng, lat] of each city the map can draw.
export const CITY_COORDS: Record<string, [number, number]> = {
  Tokyo: [139.6917, 35.6895],
  "New York": [-74.006, 40.7128],
  Seoul: [126.978, 37.5665],
  Taipei: [121.5654, 25.033],
  "Los Angeles": [-118.2437, 34.0522],
  Chicago: [-87.6298, 41.8781],
  "San Francisco": [-122.4194, 37.7749],
};

// Past trends that travelled, drawn on the idle map.
export const PRECEDENTS = [
  { id: "boba", from: "Taipei", to: "Tokyo", label: "Boba, 2013–2019" },
  { id: "malatang", from: "Seoul", to: "Tokyo", label: "Malatang, via Seoul and K-pop" },
];

// Great-circle distance, rounded to 100 km. Null if either city has no coordinates.
export function kmBetween(a: string, b: string): number | null {
  const p = own(CITY_COORDS, a);
  const q = own(CITY_COORDS, b);
  if (!p || !q) return null;
  return Math.round((geoDistance(p, q) * 6371) / 100) * 100;
}
