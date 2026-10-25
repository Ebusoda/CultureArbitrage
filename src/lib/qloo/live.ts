import type { InsightsResponse, QlooCallOptions, QlooClient, QlooParams, TrendingResponse } from "./types";

export const DEFAULT_QLOO_URL = "https://api.qloo.com";
export const MAX_TAKE = 50;

// What went wrong, in terms the agent and the UI can act on.
// auth: key missing, wrong or not allowed on this endpoint. Retrying won't help.
// bad_request: our parameters are wrong (e.g. an entity id Qloo won't take as a signal).
// not_found: wrong address (QLOO_API_URL), every call would fail the same way.
// rate_limit / server / timeout / network: transient, retried a few times.
// bad_response: 200 but not the JSON shape we expect.
export type QlooErrorKind = "auth" | "bad_request" | "not_found" | "rate_limit" | "server" | "timeout" | "network" | "bad_response" | "aborted";

export class QlooError extends Error {
  // From a Retry-After header, if Qloo sent one.
  retryAfterMs?: number;
  // Qloo's own error text (key redacted, then shortened). Not part of message: message can
  // reach the page, this only goes to the server log or to code that chooses to use it.
  detail?: string;

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

// Longest wait before a retry. A Retry-After longer than this is not waited out: a retry
// sent sooner would fail again and still be charged to the budget.
export const MAX_BACKOFF_MS = 8_000;

// Real Qloo client. Server-side only: the key is read from an environment
// variable and must never reach the browser, the repo, or a screen recording.
export class LiveQloo implements QlooClient {
  readonly mode = "live" as const;
  attempts = 0;
  private readonly baseUrl: string;
  // QLOO_API_URL is not a usable http(s) address: every call fails the same way.
  private readonly badUrl: boolean;
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
    this.badUrl = !validBaseUrl(this.baseUrl);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  async insights(params: QlooParams, opts?: QlooCallOptions): Promise<InsightsResponse> {
    return this.get("/v2/insights", params, opts) as Promise<InsightsResponse>;
  }

  async trending(params: QlooParams, opts?: QlooCallOptions): Promise<TrendingResponse> {
    return this.get("/v2/trending", params, opts) as Promise<TrendingResponse>;
  }

  private async get(path: string, params: QlooParams, call: QlooCallOptions = {}): Promise<unknown> {
    // Nothing is sent. not_found is fatal, so the run stops at the first call.
    if (this.badUrl) throw new QlooError("not_found", `Qloo ${path}: QLOO_API_URL is not a valid http(s) address`);
    // A request shared by several runs (cache.ts) passes signal: null and only has its timeout.
    const signal = call.signal === undefined ? this.opts.signal : (call.signal ?? undefined);
    const maxAttempts = Math.max(1, Math.min(this.retries + 1, call.maxAttempts ?? Infinity));
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      // "_" params are display-only and never sent (see splitDisplayParams).
      if (k.startsWith("_")) continue;
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    // Qloo answers 400 for take > 50.
    if (Number(params.take) > MAX_TAKE) url.searchParams.set("take", String(MAX_TAKE));

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(path, url, signal, call.onAttempt);
      } catch (e) {
        let err: QlooError;
        if (e instanceof QlooError) err = e;
        else {
          console.error(`[qloo] ${path}:`, this.redactText(String(e)));
          err = new QlooError("network", `Qloo ${path}: could not reach Qloo`);
        }
        // 4xx other than 429 mean the request itself is wrong, so the same request would fail
        // again and only waste quota. No retry may take the run past its budget, and a
        // Retry-After longer than we would wait means an earlier retry would fail too.
        const waitTooLong = err.retryAfterMs !== undefined && err.retryAfterMs > MAX_BACKOFF_MS;
        if (!err.retryable || attempt + 1 >= maxAttempts || signal?.aborted || waitTooLong) throw this.redact(err);
        await this.sleep(backoffMs(attempt, err), signal);
      }
    }
  }

  private async once(path: string, url: URL, runSignal: AbortSignal | undefined, onAttempt?: () => void): Promise<unknown> {
    if (runSignal?.aborted) throw new QlooError("aborted", `Qloo ${path}: run was cancelled`);
    this.attempts++;
    onAttempt?.();
    // A stalled request must not eat the whole run's time budget.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = runSignal ? AbortSignal.any([timeout, runSignal]) : timeout;
    // A cancel or timeout can land while the body is still arriving, not only before the headers.
    const interrupted = (): QlooError | null => {
      if (runSignal?.aborted) return new QlooError("aborted", `Qloo ${path}: run was cancelled`);
      if (timeout.aborted) return new QlooError("timeout", `Qloo ${path}: no answer within ${this.timeoutMs / 1000}s`);
      return null;
    };

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
        cache: "no-store",
        signal,
      });
    } catch (e) {
      const stop = interrupted();
      if (stop) throw stop;
      console.error(`[qloo] ${path} network error:`, this.redactText(e instanceof Error ? e.message : String(e)));
      throw new QlooError("network", `Qloo ${path}: could not reach Qloo`);
    }

    if (!res.ok) {
      // Qloo's error body can hold anything, so it goes to the server log (key redacted first,
      // then shortened), not into the message, which can reach the page.
      let raw = "";
      try {
        raw = await res.text();
      } catch {
        // A run cancelled while the error body arrived is a cancel, not this status's error.
        // Otherwise the status alone decides the error; the body was only for the log.
        if (runSignal?.aborted) throw new QlooError("aborted", `Qloo ${path}: run was cancelled`);
      }
      const body = this.redactText(raw.replace(/\s+/g, " ")).slice(0, 200);
      if (body) console.error(`[qloo] ${path} ${res.status}: ${body}`);
      const err = new QlooError(kindFor(res.status), `Qloo ${path} failed: ${res.status} ${hintFor(res.status)}`.trim(), res.status);
      if (body) err.detail = body;
      err.retryAfterMs = retryAfterMs(res.headers.get("retry-after"));
      throw err;
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      const stop = interrupted();
      if (stop) throw stop;
      if (e instanceof SyntaxError) throw new QlooError("bad_response", `Qloo ${path}: response was not JSON`, res.status);
      console.error(`[qloo] ${path} reading the answer failed:`, this.redactText(e instanceof Error ? e.message : String(e)));
      throw new QlooError("network", `Qloo ${path}: the answer was cut off`, res.status);
    }
    // Every endpoint we use answers { results: {...} }. Anything else is an error
    // body sent with 200, or an API change; fail loudly rather than show "0 places".
    if (!json || typeof json !== "object" || typeof (json as { results?: unknown }).results !== "object" || (json as { results?: unknown }).results === null) {
      const keys = json && typeof json === "object" ? Object.keys(json).slice(0, 5).join(", ") : typeof json;
      throw new QlooError("bad_response", `Qloo ${path}: unexpected response (no "results"; got ${keys || "nothing"})`, res.status);
    }
    return json;
  }

  private redactText(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join("[key]") : text;
  }

  // The key must never end up in a log line or on screen, even if an error echoes it.
  private redact(err: QlooError): QlooError {
    if (!this.apiKey || !err.message.includes(this.apiKey)) return err;
    const out = new QlooError(err.kind, this.redactText(err.message), err.status);
    out.detail = err.detail;
    out.retryAfterMs = err.retryAfterMs;
    return out;
  }
}

function validBaseUrl(base: string): boolean {
  try {
    const u = new URL(base);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
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

// Never negative: a negative Retry-After would mean an immediate retry.
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// 0.5s, 1s, 2s ... plus jitter; honours Retry-After (one longer than MAX_BACKOFF_MS is not retried).
function backoffMs(attempt: number, err: QlooError): number {
  const base = err.retryAfterMs ?? 500 * 2 ** attempt;
  return Math.min(MAX_BACKOFF_MS, base + Math.random() * 250);
}

// Resolves after ms, or at once when signal aborts. The abort listener is removed when the
// timer fires, so a long run doesn't pile listeners onto its signal.
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
