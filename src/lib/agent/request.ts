import { CITIES, canonicalCity } from "../cities";
import { catalogEntry } from "./catalog";
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

// Longest free-text business type accepted ("yoga studio", "猫カフェ").
export const MAX_QUERY_CHARS = 60;

// Free text as typed, made safe to log and send on: control characters dropped, spacing
// collapsed. Empty when nothing is left.
export function cleanQuery(raw: string): string {
  return raw
    .normalize("NFKC")
    // Characters that join a word (soft hyphen, grapheme and word joiners, variation selectors) go.
    .replace(/[\u00ad\u034f\u200c\u200d\u2060\p{Variation_Selector}]/gu, "")
    // Control characters, line separators, every other default-ignorable character (zero-width spaces,
    // bidi marks, Hangul fillers, tag characters) and the blank braille pattern become spaces.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// At most MAX_QUERY_CHARS characters (code points), cut at a character, not inside one.
export function clipQuery(q: string): string {
  return [...q].slice(0, MAX_QUERY_CHARS).join("").trim();
}

// Checks the request body. Returns the cleaned request, or an error response.
// category (a catalog key) or query (free text) asks to check one business type; a body
// without them is the scan it always was, answered exactly as before.
export function parseExploreBody(text: string): { city: string; focus: Focus; category?: string; query?: string } | { status: number; error: string } {
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
  const target = parseTarget(b.category, b.query);
  if ("error" in target) return target;
  return { city, focus: rawFocus as Focus, ...target };
}

// The optional business type. Absent, null or "" means none.
function parseTarget(category: unknown, query: unknown): { category?: string; query?: string } | { status: number; error: string } {
  const none = (v: unknown) => v === undefined || v === null || v === "";
  if (!none(category)) {
    if (typeof category !== "string" || !catalogEntry(category)) return { status: 400, error: "category must be a business type from the list (see src/data/categories.json)." };
    return { category };
  }
  if (none(query)) return {};
  if (typeof query !== "string") return { status: 400, error: "query must be text, e.g. \"yoga studio\"." };
  // Blank means no business type: a scan, as before.
  if (!query.trim()) return {};
  // Counted as typed (the search box counts the same way), before NFKC can lengthen it ("…" -> "...").
  if ([...query.trim()].length > MAX_QUERY_CHARS) return { status: 400, error: `query must be at most ${MAX_QUERY_CHARS} characters.` };
  const q = clipQuery(cleanQuery(query));
  // Only invisible characters: not a business type, and not a request for a scan either.
  if (!q) return { status: 400, error: "query must name a business type, e.g. \"yoga studio\"." };
  return { query: q };
}
