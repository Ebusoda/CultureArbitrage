// Shapes of the Qloo API responses we use.
// Based on the official toolkit (@qloo/qloo-harness 0.1.26). Re-check against
// real responses once the API key arrives (see 01-tests.ps1).

export type QlooParams = Record<string, string | number | undefined>;

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
}

export interface QlooClient {
  readonly mode: "mock" | "live";
  // HTTP requests actually sent, including retries (counted against the budget).
  readonly attempts: number;
  // Requests answered from cache (CachedQloo only).
  readonly cacheHits?: number;
  insights(params: QlooParams): Promise<InsightsResponse>;
  trending(params: QlooParams): Promise<TrendingResponse>;
}
