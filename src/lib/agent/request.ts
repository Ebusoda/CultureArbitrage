import { CITIES, canonicalCity } from "../cities";
import type { Focus } from "./types";

// Validation for POST /api/explore, kept out of route.ts because Next.js only
// allows route handlers and route config to be exported from there.

export const FOCUSES: Focus[] = ["all", "dining", "nightlife", "retail"];
export const MAX_BODY_BYTES = 2_048;

const TOO_LARGE = { status: 413, error: "Request body is too large." };

// Reads the body as text, refusing it before reading when Content-Length is over the cap,
// and stopping as soon as more than the cap has arrived when there is no Content-Length.
export async function readExploreBody(request: Request): Promise<{ text: string } | { status: number; error: string }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && declared.trim() !== "") {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0) return { status: 400, error: "Invalid Content-Length." };
    if (n > MAX_BODY_BYTES) return TOO_LARGE;
  }
  if (!request.body) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } catch {
    return { text: "" };
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { text: new TextDecoder().decode(all) };
}

// Checks the request headers before the body is read. The body must be declared as
// exactly application/json: a missing type, text/plain or a form encoding would let any
// other website start live runs through a plain cross-site POST (no CORS preflight).
// In production the request must also come from this site's own page, judged by the
// browser's Sec-Fetch-Site header or, without it, by Origin against Host.
// Local development (`npm run dev`, tests) skips the origin check.
export function checkExploreHeaders(headers: Headers, production = process.env.NODE_ENV === "production"): { status: number; error: string } | null {
  const type = (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Send the request as application/json." };
  if (!production) return null;
  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site) return site === "same-origin" ? null : { status: 403, error: "Explorations can only be started from this site." };
  const origin = headers.get("origin");
  const host = headers.get("x-forwarded-host")?.split(",")[0].trim() || headers.get("host")?.trim();
  if (origin && host) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost.toLowerCase() === host.toLowerCase()) return null;
  }
  return { status: 403, error: "Explorations can only be started from this site." };
}

// Checks the request body. Returns the cleaned request, or an error response.
export function parseExploreBody(text: string): { city: string; focus: Focus } | { status: number; error: string } {
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return TOO_LARGE;
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
