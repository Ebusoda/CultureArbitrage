import { config } from "../config";
import { CachedQloo } from "./cache";
import { LiveQloo, QlooError } from "./live";
import { MockQloo } from "./mock";
import { summarize } from "./summary";
import { splitDisplayParams, type InsightsResponse, type QlooCallLog, type QlooClient, type QlooParams, type TrendingResponse } from "./types";

export * from "./types";
export { QlooError, type QlooErrorKind } from "./live";

let warned = false;

export function qlooMode(): "mock" | "live" {
  const wantsLive = process.env.QLOO_MODE?.trim().toLowerCase() === "live";
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
    // The cache races each shared request against this run's signal (see cache.ts).
    return new CachedQloo(live, config.qlooCacheTtlMs(), Date.now, opts.signal);
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
    return this.call("/v2/insights", params, (send, o) => this.inner.insights(send, o));
  }

  trending(params: QlooParams): Promise<TrendingResponse> {
    return this.call("/v2/trending", params, (send, o) => this.inner.trending(send, o));
  }

  private async call<T extends InsightsResponse | TrendingResponse>(
    endpoint: string,
    raw: QlooParams,
    fn: (send: QlooParams, o: { maxAttempts: number; onAttempt: () => void }) => Promise<T>,
  ): Promise<T> {
    if (this.used >= this.budget) {
      throw new BudgetExceededError(`Qloo call budget of ${this.budget} used up`);
    }
    // "_" params (e.g. "_where") are for the log line only: never sent, cached on or mocked.
    const { send: params, display } = splitDisplayParams(raw);
    const hitsBefore = this.inner.cacheHits ?? 0;
    const n = ++this.lastCall;
    const base = { n, endpoint, params, mock: this.inner.mode === "mock", ...(display._where ? { where: display._where } : {}) };
    let attempts = 0;
    // Charge every HTTP attempt, retries included, so the budget matches real quota use.
    // A cached answer still counts as one call, so a run behaves the same cached or not.
    // Retries stop at the remaining budget, so used never goes past it.
    const charge = () => {
      this.used += Math.max(1, attempts);
      return this.used;
    };
    const o = { maxAttempts: this.remaining, onAttempt: () => void attempts++ };
    let res: T;
    try {
      res = await fn(params, o);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onCall({ ...base, resultCount: 0, summary: "failed", error: message.slice(0, 200), used: charge() });
      throw err;
    }
    const r = (res.results ?? {}) as InsightsResponse["results"] & TrendingResponse["results"];
    const count =
      (r.entities?.length ?? 0) + (r.tags?.length ?? 0) + (r.heatmap?.length ?? 0) + (r.trending?.length ?? 0) + (r.demographics ? 1 : 0);
    const cached = (this.inner.cacheHits ?? 0) > hitsBefore;
    const used = charge();
    this.onCall({ ...base, resultCount: count, summary: summarize(endpoint, params, res), ...(cached ? { cached } : {}), used });
    return res;
  }
}
