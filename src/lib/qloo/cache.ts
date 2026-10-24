import type { InsightsResponse, QlooClient, QlooParams, TrendingResponse } from "./types";

interface Entry {
  at: number;
  value: Promise<unknown>;
}

const MAX_ENTRIES = 500;

// Shared by every run in this server process (on Vercel: one warm instance), so
// several viewers exploring Tokyo cost Qloo quota once. Only successful answers
// are kept; a failed request is forgotten and may be tried again by a later run.
const store = new Map<string, Entry>();

export function cacheKey(endpoint: string, params: QlooParams): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort();
  return `${endpoint}?${parts.join("&")}`;
}

export function clearQlooCache() {
  store.clear();
}

export function qlooCacheSize() {
  return store.size;
}

// Wraps a client so identical requests within ttlMs are answered from memory.
// Concurrent identical requests share one HTTP call.
export class CachedQloo implements QlooClient {
  hits = 0;

  constructor(
    private readonly inner: QlooClient,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get mode() {
    return this.inner.mode;
  }

  get attempts() {
    return this.inner.attempts;
  }

  get cacheHits() {
    return this.hits;
  }

  insights(params: QlooParams): Promise<InsightsResponse> {
    return this.get("/v2/insights", params, () => this.inner.insights(params));
  }

  trending(params: QlooParams): Promise<TrendingResponse> {
    return this.get("/v2/trending", params, () => this.inner.trending(params));
  }

  private get<T>(endpoint: string, params: QlooParams, fn: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return fn();
    // Mock and live answers must never mix.
    const key = `${this.inner.mode}:${cacheKey(endpoint, params)}`;
    const hit = store.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) {
      this.hits++;
      // Re-insert so the least recently used entry is evicted first.
      store.delete(key);
      store.set(key, hit);
      return hit.value as Promise<T>;
    }
    const value = fn();
    store.set(key, { at: this.now(), value });
    value.catch(() => {
      if (store.get(key)?.value === value) store.delete(key);
    });
    while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value!);
    return value;
  }
}
