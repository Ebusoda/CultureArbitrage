import type { InsightsResponse, QlooClient, QlooParams, TrendingResponse } from "./types";

export const DEFAULT_QLOO_URL = "https://api.qloo.com";
export const MAX_TAKE = 50;

// What went wrong, in terms the agent and the UI can act on.
// auth: key missing, wrong or not allowed on this endpoint. Retrying won't help.
// bad_request: our parameters are wrong (e.g. an entity id Qloo won't take as a signal).
// rate_limit / server / timeout / network: transient, retried a few times.
// bad_response: 200 but not the JSON shape we expect.
export type QlooErrorKind = "auth" | "bad_request" | "not_found" | "rate_limit" | "server" | "timeout" | "network" | "bad_response" | "aborted";

export class QlooError extends Error {
  // From a Retry-After header, if Qloo sent one.
  retryAfterMs?: number;

  constructor(
    readonly kind: QlooErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "QlooError";
  }

  get retryable() {
    return this.kind === "rate_limit" || this.kind === "server" || this.kind === "timeout" || this.kind === "network";
  }
}

export interface LiveOptions {
  baseUrl?: string;
  timeoutMs?: number;
  // Extra attempts after the first, for transient failures only.
  retries?: number;
  // Aborted when the viewer disconnects: stop waiting and don't retry.
  signal?: AbortSignal;
  // For tests.
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// Real Qloo client. Server-side only: the key is read from an environment
// variable and must never reach the browser, the repo, or a screen recording.
export class LiveQloo implements QlooClient {
  readonly mode = "live" as const;
  attempts = 0;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly apiKey: string,
    private readonly opts: LiveOptions = {},
  ) {
    // Joined by hand: new URL("/v2/insights", "https://host/prefix") would drop "/prefix".
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_QLOO_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  async insights(params: QlooParams): Promise<InsightsResponse> {
    return this.get("/v2/insights", params) as Promise<InsightsResponse>;
  }

  async trending(params: QlooParams): Promise<TrendingResponse> {
    return this.get("/v2/trending", params) as Promise<TrendingResponse>;
  }

  private async get(path: string, params: QlooParams): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    // Qloo answers 400 for take > 50.
    if (Number(params.take) > MAX_TAKE) url.searchParams.set("take", String(MAX_TAKE));

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(path, url);
      } catch (e) {
        const err = e instanceof QlooError ? e : new QlooError("network", `Qloo ${path}: ${String(e)}`);
        // 4xx other than 429 mean the request itself is wrong, so the same request
        // would fail again and only waste quota.
        if (!err.retryable || attempt >= this.retries || this.opts.signal?.aborted) throw this.redact(err);
        await this.sleep(backoffMs(attempt, err), this.opts.signal);
      }
    }
  }

  private async once(path: string, url: URL): Promise<unknown> {
    if (this.opts.signal?.aborted) throw new QlooError("aborted", `Qloo ${path}: run was cancelled`);
    this.attempts++;
    // A stalled request must not eat the whole run's time budget.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = this.opts.signal ? AbortSignal.any([timeout, this.opts.signal]) : timeout;

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
        cache: "no-store",
        signal,
      });
    } catch (e) {
      if (this.opts.signal?.aborted) throw new QlooError("aborted", `Qloo ${path}: run was cancelled`);
      if (timeout.aborted) throw new QlooError("timeout", `Qloo ${path}: no answer within ${this.timeoutMs / 1000}s`);
      throw new QlooError("network", `Qloo ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!res.ok) {
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      const err = new QlooError(kindFor(res.status), `Qloo ${path} failed: ${res.status} ${hintFor(res.status)}${body ? ` (${body})` : ""}`, res.status);
      err.retryAfterMs = retryAfterMs(res.headers.get("retry-after"));
      throw err;
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new QlooError("bad_response", `Qloo ${path}: response was not JSON`, res.status);
    }
    // Every endpoint we use answers { results: {...} }. Anything else is an error
    // body sent with 200, or an API change; fail loudly rather than show "0 places".
    if (!json || typeof json !== "object" || typeof (json as { results?: unknown }).results !== "object" || (json as { results?: unknown }).results === null) {
      const keys = json && typeof json === "object" ? Object.keys(json).slice(0, 5).join(", ") : typeof json;
      throw new QlooError("bad_response", `Qloo ${path}: unexpected response (no "results"; got ${keys || "nothing"})`, res.status);
    }
    return json;
  }

  // The key must never end up in a log line or on screen, even if an error echoes it.
  private redact(err: QlooError): QlooError {
    if (!this.apiKey || !err.message.includes(this.apiKey)) return err;
    return new QlooError(err.kind, err.message.split(this.apiKey).join("[key]"), err.status);
  }
}

function kindFor(status: number): QlooErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}

function hintFor(status: number): string {
  if (status === 401 || status === 403) return "the API key was rejected or lacks access to this endpoint";
  if (status === 404) return "endpoint not found, check QLOO_API_URL";
  if (status === 429) return "rate limited";
  if (status >= 500) return "Qloo server error";
  if (status === 400) return "Qloo did not accept these parameters";
  return "";
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// 0.5s, 1s, 2s ... plus jitter; honours Retry-After but never waits more than 8s.
function backoffMs(attempt: number, err: QlooError): number {
  const base = err.retryAfterMs ?? 500 * 2 ** attempt;
  return Math.min(8_000, base + Math.random() * 250);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
