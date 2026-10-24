// Google Maps Places API (New), Text Search, used for one thing: a cross-check of Qloo.
// Does Google Maps also see the gap, with fewer places of a category around the home
// neighbourhood than around its twin? If not, the gap may be in Qloo's index, not on the street.
//
// Only place ids are requested (field mask "places.id,nextPageToken"). That is Google's
// "Text Search Essentials (IDs Only)" tier, listed as free without limit, and ids are the one
// piece of Places data the terms allow keeping. The area is a hard rectangle
// (locationRestriction), so no coordinates are needed. Server-side only, like the Qloo key.

export const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = "places.id,nextPageToken";
// Google returns at most 20 per page and stops at 60.
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
export const GOOGLE_PAGES = MAX_PAGES;
export const GOOGLE_MAX = PAGE_SIZE * MAX_PAGES;

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface Box {
  low: LatLng;
  high: LatLng;
}

export interface PlacesQuery {
  textQuery: string;
  // A Places "Table A" type. With strict, only places of that type count; without, it only biases.
  includedType?: string;
  strict?: boolean;
  languageCode: string;
  regionCode?: string;
}

export interface GoogleCount {
  count: number;
  // Google's 60-result ceiling was hit: the real number may be higher.
  saturated: boolean;
}

export class GooglePlacesError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GooglePlacesError";
  }

  // A rejected key or a disabled API fails every later request the same way.
  get fatal() {
    return this.status === 401 || this.status === 403;
  }
}

export interface GoogleOptions {
  timeoutMs?: number;
  // Hard cap on HTTP requests (pages) per exploration.
  maxRequests?: number;
  signal?: AbortSignal;
  // For tests.
  fetch?: typeof fetch;
}

export class GooglePlaces {
  requests = 0;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly apiKey: string,
    private readonly opts: GoogleOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  get remaining() {
    return Math.max(0, (this.opts.maxRequests ?? 24) - this.requests);
  }

  // Number of distinct places Google Maps returns for the query inside the box.
  async count(q: PlacesQuery, box: Box): Promise<GoogleCount> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.page(q, box, pageToken);
      for (const p of res.places ?? []) if (p.id) ids.add(p.id);
      pageToken = res.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return { count: ids.size, saturated: !!pageToken || ids.size >= GOOGLE_MAX };
  }

  private async page(q: PlacesQuery, box: Box, pageToken?: string): Promise<{ places?: { id?: string }[]; nextPageToken?: string }> {
    if (this.remaining <= 0) throw new GooglePlacesError(`Google Maps request limit of ${this.opts.maxRequests ?? 24} per run used up`);
    if (this.opts.signal?.aborted) throw new GooglePlacesError("Google Maps: run was cancelled");
    this.requests++;
    // Every page must repeat the first request exactly, plus the token.
    const body = {
      textQuery: q.textQuery,
      pageSize: PAGE_SIZE,
      languageCode: q.languageCode,
      ...(q.regionCode ? { regionCode: q.regionCode } : {}),
      ...(q.includedType ? { includedType: q.includedType, strictTypeFiltering: !!q.strict } : {}),
      locationRestriction: { rectangle: box },
      ...(pageToken ? { pageToken } : {}),
    };
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await this.fetchFn(PLACES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": this.apiKey, "X-Goog-FieldMask": FIELD_MASK },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: this.opts.signal ? AbortSignal.any([timeout, this.opts.signal]) : timeout,
      });
    } catch (e) {
      throw this.redact(new GooglePlacesError(timeout.aborted ? "Google Maps: no answer in time" : `Google Maps: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      const hint = res.status === 403 || res.status === 401 ? " (key rejected, or Places API (New) not enabled for it)" : res.status === 429 ? " (quota reached)" : "";
      throw this.redact(new GooglePlacesError(`Google Maps failed: ${res.status}${hint}${text ? ` ${text}` : ""}`, res.status));
    }
    try {
      return (await res.json()) as { places?: { id?: string }[]; nextPageToken?: string };
    } catch {
      throw new GooglePlacesError("Google Maps: response was not JSON", res.status);
    }
  }

  // The key must never reach a log line or the screen, even if an error echoes it.
  private redact(err: GooglePlacesError): GooglePlacesError {
    if (!this.apiKey || !err.message.includes(this.apiKey)) return err;
    return new GooglePlacesError(err.message.split(this.apiKey).join("[key]"), err.status);
  }
}

// A square of side 2 x halfKm around a point. Rough at Tokyo's latitude, fine for a cross-check.
export function boxAround(lat: number, lng: number, halfKm: number): Box {
  const dLat = halfKm / 111;
  const dLng = halfKm / (111 * Math.cos((lat * Math.PI) / 180));
  return { low: { latitude: lat - dLat, longitude: lng - dLng }, high: { latitude: lat + dLat, longitude: lng + dLng } };
}
