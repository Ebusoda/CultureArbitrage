// Shapes of the Qloo API responses we use.
// Based on the official toolkit (@qloo/qloo-harness 0.1.26). Re-check against
// real responses once the API key arrives (see 01-tests.ps1).

export type QlooParams = Record<string, string | number | undefined>;

// Per-call options a wrapper passes down to the client that does the HTTP work.
export interface QlooCallOptions {
  // Aborts this call (the viewer left). Defaults to the client's own signal; null means
  // none at all, only the per-request timeout: used for a request several runs share.
  signal?: AbortSignal | null;
  // Most HTTP attempts this call may make, retries included (the run's remaining budget).
  maxAttempts?: number;
  // Called once per HTTP attempt this call makes, so the caller can charge exactly that.
  onAttempt?: () => void;
}

export interface QlooTag {
  id: string;
  name: string;
  type?: string;
}

export interface QlooEntity {
  entity_id: string;
  name: string;
  type?: string;
  subtype?: string;
  popularity?: number;
  query?: {
    affinity?: number;
    explainability?: unknown;
  };
  tags?: QlooTag[];
  // Live: the entity's point (for a locality, its centre).
  location?: { lat?: number; lon?: number };
  properties?: {
    address?: string;
    geocode?: { latitude?: number; longitude?: number; name?: string };
    price_level?: number;
    business_rating?: number;
    description?: string;
  };
}

export interface QlooTagResult {
  tag_id: string;
  name: string;
  type?: string;
  query?: { affinity?: number };
}

export interface InsightsResponse {
  results: {
    entities?: QlooEntity[];
    tags?: QlooTagResult[];
    heatmap?: { location: { latitude: number; longitude: number }; query: { affinity: number } }[];
    demographics?: unknown;
  };
}

export interface TrendingResponse {
  results: {
    trending?: { date: string; popularity: number }[];
  };
}

// One logged API call, shown live in the UI as evidence.
export interface QlooCallLog {
  // 1-based call number in this run, shown as "Q7" and cited on cards.
  n: number;
  endpoint: string;
  params: QlooParams;
  resultCount: number;
  // One readable line describing the result, e.g. "21 Natural wine bar · 14 Record store".
  summary: string;
  mock: boolean;
  // Answered from the server's Qloo cache, no quota used.
  cached?: boolean;
  error?: string;
  // Calls charged to the run's budget after this one, retries included.
  used?: number;
  // Where the call looks, for the log line, when params don't say it in words (a POINT
  // location). Set by the caller as the display-only param "_where".
  where?: string;
}

export interface QlooClient {
  readonly mode: "mock" | "live";
  // HTTP requests actually sent, including retries (counted against the budget).
  readonly attempts: number;
  // Requests answered from cache (CachedQloo only).
  readonly cacheHits?: number;
  insights(params: QlooParams, opts?: QlooCallOptions): Promise<InsightsResponse>;
  trending(params: QlooParams, opts?: QlooCallOptions): Promise<TrendingResponse>;
}

// Params whose key starts with "_" are display-only (e.g. "_where"): they never reach Qloo,
// the cache key or the mock. Returns the params to send, and the display-only ones.
export function splitDisplayParams(params: QlooParams): { send: QlooParams; display: Record<string, string> } {
  const send: QlooParams = {};
  const display: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith("_")) {
      if (v !== undefined && v !== "") display[k] = String(v);
    } else send[k] = v;
  }
  return { send, display };
}
