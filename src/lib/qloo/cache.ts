import { QlooError } from "./live";
import { splitDisplayParams, type InsightsResponse, type QlooCallOptions, type QlooClient, type QlooParams, type TrendingResponse } from "./types";

interface Entry {
  at: number;
  value: Promise<unknown>;
  // Rough size of the answer (length of its JSON), known once it has arrived.
  bytes: number;
  // While the request is in flight: runs still waiting on it, and what cancels it once none is.
  waiting?: { count: number; controller: AbortController; settled: boolean };
}

// Caps on what the cache holds: a twin search answer can be over a megabyte, so the count
// alone does not bound memory. Over either cap, the least recently used entries go first.
let maxEntries = 500;
let maxBytes = 50_000_000;
let totalBytes = 0;

// Shared by every run in this server process (on Vercel: one warm instance), so
// several viewers exploring Tokyo cost Qloo quota once. Only successful answers
// are kept; a failed request is forgotten and may be tried again by a later run.
const store = new Map<string, Entry>();

// Display-only "_" params never change the answer, so they are not part of the key.
export function cacheKey(endpoint: string, params: QlooParams): string {
  const parts = Object.entries(splitDisplayParams(params).send)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort();
  return `${endpoint}?${parts.join("&")}`;
}

export function clearQlooCache() {
  store.clear();
  totalBytes = 0;
}

export function qlooCacheSize() {
  return store.size;
}

export function qlooCacheBytes() {
  return totalBytes;
}

// For tests.
export function setQlooCacheLimits(limits: { entries?: number; bytes?: number }) {
  if (limits.entries !== undefined) maxEntries = limits.entries;
  if (limits.bytes !== undefined) maxBytes = limits.bytes;
}

function drop(key: string) {
  const e = store.get(key);
  if (!e) return;
  totalBytes -= e.bytes;
  store.delete(key);
}

function evict() {
  while (store.size > maxEntries || (totalBytes > maxBytes && store.size > 0)) drop(store.keys().next().value!);
}

// Settles like p, but rejects with "aborted" as soon as signal aborts. p itself carries on
// while other runs still wait on the same shared request; once the last waiting run has left,
// the request is cancelled (it would only spend Qloo calls on an answer nobody reads).
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined, endpoint: string, waiting?: Entry["waiting"]): Promise<T> {
  const cancelled = () => new QlooError("aborted", `Qloo ${endpoint}: run was cancelled`);
  if (signal?.aborted) return Promise.reject(cancelled());
  // A caller with no signal never leaves, so it keeps the request alive.
  if (waiting && !waiting.settled) waiting.count++;
  if (!signal) return p;
  const leave = () => {
    if (!waiting || waiting.settled) return;
    waiting.count--;
    if (waiting.count <= 0) waiting.controller.abort();
  };
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(cancelled());
      leave();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

// Wraps a client so identical requests within ttlMs are answered from memory.
// Concurrent identical requests share one HTTP call. That shared call is not tied to any
// one run's signal; each run waits on it with its own signal, so a viewer who leaves never
// fails another viewer's identical request. Once every run waiting on it has left, it is cancelled.
export class CachedQloo implements QlooClient {
  hits = 0;

  constructor(
    private readonly inner: QlooClient,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    // Aborted when this run's viewer disconnects.
    private readonly signal?: AbortSignal,
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

  insights(params: QlooParams, opts?: QlooCallOptions): Promise<InsightsResponse> {
    return this.get("/v2/insights", params, opts, (o) => this.inner.insights(params, o));
  }

  trending(params: QlooParams, opts?: QlooCallOptions): Promise<TrendingResponse> {
    return this.get("/v2/trending", params, opts, (o) => this.inner.trending(params, o));
  }

  private get<T>(endpoint: string, params: QlooParams, opts: QlooCallOptions = {}, fn: (o: QlooCallOptions) => Promise<T>): Promise<T> {
    const signal = opts.signal === undefined ? this.signal : (opts.signal ?? undefined);
    if (this.ttlMs <= 0) return fn(this.signal && opts.signal === undefined ? { ...opts, signal: this.signal } : opts);
    // Mock and live answers must never mix.
    const key = `${this.inner.mode}:${cacheKey(endpoint, params)}`;
    const hit = store.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) {
      this.hits++;
      // Re-insert so the least recently used entry is evicted first.
      store.delete(key);
      store.set(key, hit);
      return untilAborted(hit.value as Promise<T>, signal, endpoint, hit.waiting);
    }
    if (signal?.aborted) return Promise.reject(new QlooError("aborted", `Qloo ${endpoint}: run was cancelled`));
    // An expired entry is removed first, so the fresh one goes to the newest end of the order.
    drop(key);
    // The shared request has its own signal, aborted only when every run waiting on it has left.
    const waiting = { count: 0, controller: new AbortController(), settled: false };
    const value = fn({ maxAttempts: opts.maxAttempts, onAttempt: opts.onAttempt, signal: waiting.controller.signal });
    const entry: Entry = { at: this.now(), value, bytes: 0, waiting };
    store.set(key, entry);
    const settle = () => {
      waiting.settled = true;
      delete entry.waiting;
    };
    value.then(
      (v) => {
        settle();
        if (store.get(key) !== entry) return;
        let bytes = 0;
        try {
          bytes = JSON.stringify(v)?.length ?? 0;
        } catch {}
        entry.bytes = bytes;
        totalBytes += bytes;
        evict();
      },
      () => {
        settle();
        if (store.get(key) === entry) drop(key);
      },
    );
    evict();
    return untilAborted(value, signal, endpoint, waiting);
  }
}
