import { CITIES, canonicalCity } from "../cities";
import type { Focus } from "./types";

// Validation for POST /api/explore, kept out of route.ts because Next.js only
// allows route handlers and route config to be exported from there.

export const FOCUSES: Focus[] = ["all", "dining", "nightlife", "retail"];
const MAX_BODY_BYTES = 2_048;

// Checks the request body. Returns the cleaned request, or an error response.
export function parseExploreBody(text: string): { city: string; focus: Focus } | { status: number; error: string } {
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { status: 413, error: "Request body is too large." };
  let body: unknown;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    return { status: 400, error: "Request body must be JSON, e.g. {\"city\":\"Tokyo\",\"focus\":\"all\"}." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "Request body must be a JSON object." };
  const b = body as Record<string, unknown>;
  const city = canonicalCity(b.city);
  if (!city) return { status: 400, error: `city must be one of ${CITIES.join(", ")}.` };
  const rawFocus = b.focus === undefined || b.focus === null || b.focus === "" ? "all" : b.focus;
  if (!FOCUSES.includes(rawFocus as Focus)) return { status: 400, error: `focus must be one of ${FOCUSES.join(", ")}.` };
  return { city, focus: rawFocus as Focus };
}
