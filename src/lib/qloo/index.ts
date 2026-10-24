import { config } from "../config";
import { CachedQloo } from "./cache";
import { LiveQloo, QlooError } from "./live";
import { MockQloo } from "./mock";
import { summarize } from "./summary";
import type { InsightsResponse, QlooCallLog, QlooClient, QlooParams, TrendingResponse } from "./types";

export * from "./types";
export { QlooError, type QlooErrorKind } from "./live";

let warned = false;

export function qlooMode(): "mock" | "live" {
  const wantsLive = process.env.QLOO_MODE === "live";
  const hasKey = !!process.env.QLOO_API_KEY?.trim();
  if (wantsLive && !hasKey && !warned) {
    warned = true;
    console.warn("[qloo] QLOO_MODE=live but QLOO_API_KEY is empty, using mock data");
  }
  return wantsLive && hasKey ? "live" : "mock";
}

// QLOO_MODE=live uses the real API (needs QLOO_API_KEY). Anything else, or a
// missing key, falls back to mock data so the app always runs.
// Live answers are cached across runs (QLOO_CACHE_TTL_MS); mock answers are not,
// so a mock run keeps its on-screen pacing.
export function createQloo(opts: { signal?: AbortSignal } = {}): QlooClient {
  if (qlooMode() === "live") {
    const live = new LiveQloo(process.env.QLOO_API_KEY!.trim(), {
      baseUrl: process.env.QLOO_API_URL || undefined,
      timeoutMs: config.qlooTimeoutMs(),
      retries: config.qlooRetries(),
      signal: opts.signal,
    });
    return new CachedQloo(live, config.qlooCacheTtlMs());
  }
  return new MockQloo(config.mockDelayMs());
}

export class BudgetExceededError extends Error {}

// Errors that every later Qloo call would hit too (budget spent, key rejected,
// wrong QLOO_API_URL): stop the run instead of skipping one lookup and trying the next.
export function isFatalQlooError(e: unknown): boolean {
  return e instanceof BudgetExceededError || (e instanceof QlooError && (e.kind === "auth" || e.kind === "not_found"));
}

// Wraps a client with a hard cap on calls per exploration and logs every call,
// so the UI can show each request as evidence and quota can't run away.
export class BudgetedQloo {
  used = 0;
  // Number of the last logged call, cited on cards as "Q<n>".
  lastCall = 0;

  constructor(
    private readonly inner: QlooClient,
    readonly budget: number,
    private readonly onCall: (log: QlooCallLog) => void,
  ) {}

  get mode() {
    return this.inner.mode;
  }

  get remaining() {
    return Math.max(0, this.budget - this.used);
  }

  insights(params: QlooParams): Promise<InsightsResponse> {
    return this.call("/v2/insights", params, () => this.inner.insights(params));
  }

  trending(params: QlooParams): Promise<TrendingResponse> {
    return this.call("/v2/trending", params, () => this.inner.trending(params));
  }

  private async call<T extends InsightsResponse | TrendingResponse>(endpoint: string, params: QlooParams, fn: () => Promise<T>): Promise<T> {
    if (this.used >= this.budget) {
      throw new BudgetExceededError(`Qloo call budget of ${this.budget} used up`);
    }
    const before = this.inner.attempts;
    const hitsBefore = this.inner.cacheHits ?? 0;
    const n = ++this.lastCall;
    const base = { n, endpoint, params, mock: this.inner.mode === "mock" };
    try {
      const res = await fn();
      const r = (res.results ?? {}) as InsightsResponse["results"] & TrendingResponse["results"];
      const count =
        (r.entities?.length ?? 0) + (r.tags?.length ?? 0) + (r.heatmap?.length ?? 0) + (r.trending?.length ?? 0) + (r.demographics ? 1 : 0);
      const cached = (this.inner.cacheHits ?? 0) > hitsBefore;
      this.onCall({ ...base, resultCount: count, summary: summarize(endpoint, params, res), ...(cached ? { cached } : {}) });
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onCall({ ...base, resultCount: 0, summary: "failed", error: message.slice(0, 200) });
      throw err;
    } finally {
      // Charge every HTTP attempt, retries included, so the budget matches real quota use.
      // A cached answer still counts as one call, so a run behaves the same cached or not.
      this.used += Math.max(1, this.inner.attempts - before);
    }
  }
}
