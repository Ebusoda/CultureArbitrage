// Fixes from the 2026-10-24 review, server side: Qloo client and cache, limits, the explore
// stream, request checks, Google errors, config headers. Offline: fake fetch, mock Qloo.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nextConfig from "../next.config";
import { parseExploreBody, readExploreBody } from "../src/lib/agent/request";
import type { AgentEvent } from "../src/lib/agent/types";
import { canonicalCity, kmBetween, qlooLocation } from "../src/lib/cities";
import { exploreResponse, publicErrorMessage } from "../src/lib/explore-stream";
import { admit, ipBucket, resetLimits } from "../src/lib/limits";
import { BudgetedQloo, BudgetExceededError, createQloo, isFatalQlooError, qlooMode, type QlooCallLog } from "../src/lib/qloo";
import { CachedQloo, cacheKey, clearQlooCache, qlooCacheBytes, qlooCacheSize, setQlooCacheLimits } from "../src/lib/qloo/cache";
import { abortableSleep, LiveQloo, QlooError } from "../src/lib/qloo/live";
import { summarize } from "../src/lib/qloo/summary";
import type { Recording } from "../src/lib/replay";

process.env.MOCK_DELAY_MS = "0";
process.env.QLOO_MODE = "mock";
process.env.LLM_MODE = "mock";
process.env.EXPLORE_REPLAY_SECONDS = "0";
delete process.env.EXPLORE_FORCE_REPLAY;
delete process.env.EXPLORE_LIVE_ENABLED;

const KEY = "test-key-123";
const OK = { results: { entities: [{ entity_id: "e1", name: "Shimokitazawa" }] } };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const err = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = err;
  }
};

// Each fetch takes the next reply; records the URL and the signal it was given.
function scripted(replies: (Response | (() => Promise<Response>))[]) {
  const seen: { url: string; signal?: AbortSignal | null }[] = [];
  const fn = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), signal: init?.signal });
    const next = replies.shift();
    if (!next) throw new Error("script ran out");
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fn, seen };
}

// A 200 whose body never finishes arriving, until the request's signal aborts.
function stalledBody(signal?: AbortSignal | null): Response {
  const keepAlive = setTimeout(() => {}, 5_000);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"results":'));
      signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        c.error(signal.reason);
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

// F12
test("F12: a viewer who leaves does not fail another run waiting on the same shared Qloo request", async () => {
  clearQlooCache();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = scripted([
    async () => {
      await gate;
      return json(OK);
    },
  ]);
  const a = new AbortController();
  const b = new AbortController();
  const runA = new CachedQloo(new LiveQloo(KEY, { fetch: f.fn, signal: a.signal }), 60_000, Date.now, a.signal);
  const runB = new CachedQloo(new LiveQloo(KEY, { fetch: f.fn, signal: b.signal }), 60_000, Date.now, b.signal);
  const pa = runA.insights({ q: "shared" });
  const pb = runB.insights({ q: "shared" });
  await new Promise((r) => setImmediate(r));
  a.abort();
  await assert.rejects(pa, (e: unknown) => e instanceof QlooError && e.kind === "aborted");
  assert.equal(f.seen[0].signal?.aborted, false, "the shared HTTP request is not tied to run A's signal");
  release();
  const rb = await pb;
  assert.equal(rb.results.entities?.[0].name, "Shimokitazawa");
  assert.equal(f.seen.length, 1, "one HTTP call for both runs");
  clearQlooCache();
});

test("F12: a cancelled run's own uncached call still stops at once", async () => {
  clearQlooCache();
  const ac = new AbortController();
  ac.abort();
  const f = scripted([json(OK)]);
  const q = new CachedQloo(new LiveQloo(KEY, { fetch: f.fn, signal: ac.signal }), 60_000, Date.now, ac.signal);
  await assert.rejects(q.insights({ q: 2 }), (e: unknown) => e instanceof QlooError && e.kind === "aborted");
  assert.equal(f.seen.length, 0);
});

// F09
test("F09: the page gets a short fixed message per kind of failure, never upstream text", async () => {
  assert.equal(publicErrorMessage(new QlooError("rate_limit", "Qloo /v2/insights failed: 429 rate limited (secret body)")), "Qloo is rate-limiting");
  assert.equal(publicErrorMessage(new TypeError("Cannot read properties of undefined (reading 'x') at /srv/app.js")), "The live run hit an unexpected error");
  assert.match(publicErrorMessage(new BudgetExceededError("Qloo call budget of 40 used up")), /budget/);

  const tiny: Recording = {
    recordedAt: "2026-10-20T00:00:00.000Z",
    events: [
      { type: "start", city: "Tokyo", focus: "all", qlooMode: "live", llmMode: "none", budget: 40 },
      { type: "done", callsUsed: 1, budget: 40, cards: 0 },
    ],
  };
  const boom = async () => {
    throw new Error("Your credit balance is too low: org-12345 (upstream body)");
  };
  const post = () => new Request("http://x/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  for (const recording of [null, tiny]) {
    resetLimits();
    const text = await quiet(() => exploreResponse({ city: "Tokyo", focus: "all" }, post(), { explore: boom, recording: () => recording }).text());
    assert.ok(!text.includes("credit balance") && !text.includes("org-12345"), `no upstream text reaches the page: ${text}`);
    assert.match(text, recording ? /"type":"replay".*unexpected error/ : /"type":"error".*unexpected error/);
  }
});

test("F09: Qloo's error body stays out of the message (kept as detail for the server log)", async () => {
  const f = scripted([json({ error: "internal trace id 777 at host db-3" }, 503), json({ error: "x" }, 503)]);
  const q = new LiveQloo(KEY, { fetch: f.fn, sleep: noSleep, retries: 1 });
  await quiet(() =>
    assert.rejects(q.insights({}), (e: unknown) => e instanceof QlooError && e.kind === "server" && !e.message.includes("trace id") && /Qloo server error/.test(e.message)),
  );
});

// F17
test("F17: retries stop at the run's budget, and every logged call carries the total charged", async () => {
  const f = scripted([json({}, 500), json({}, 500), json({}, 500), json(OK)]);
  const logs: QlooCallLog[] = [];
  const b = new BudgetedQloo(new LiveQloo(KEY, { fetch: f.fn, sleep: noSleep, retries: 5 }), 2, (l) => logs.push(l));
  await quiet(() => assert.rejects(b.insights({}), (e: unknown) => e instanceof QlooError && e.kind === "server"));
  assert.equal(b.used, 2, "never past the budget of 2");
  assert.equal(f.seen.length, 2);
  assert.equal(logs[0].used, 2);
  await assert.rejects(b.insights({}), BudgetExceededError);

  const ok = new BudgetedQloo(createQloo(), 10, (l) => logs.push(l));
  await ok.insights({ "filter.type": "urn:entity:locality", "filter.location.query": "Tokyo", take: 3 });
  await ok.insights({ "filter.type": "urn:entity:locality", "filter.location.query": "Seoul", take: 3 });
  assert.deepEqual(logs.slice(-2).map((l) => l.used), [1, 2]);
});

// M04 support
test("M04: '_' params are display-only: not sent, not in the cache key or the logged params, shown as where", async () => {
  clearQlooCache();
  const f = scripted([json(OK)]);
  const logs: QlooCallLog[] = [];
  const b = new BudgetedQloo(new CachedQloo(new LiveQloo(KEY, { fetch: f.fn }), 60_000), 10, (l) => logs.push(l));
  await b.insights({ "filter.type": "urn:entity:place", "filter.location": "POINT(139.7 35.6)", _where: "Shibuya-ku, Tokyo" });
  await b.insights({ "filter.type": "urn:entity:place", "filter.location": "POINT(139.7 35.6)", _where: "somewhere else" });
  assert.equal(f.seen.length, 1, "the display param does not split the cache");
  assert.ok(!new URL(f.seen[0].url).searchParams.has("_where"));
  assert.equal(logs[0].where, "Shibuya-ku, Tokyo");
  assert.equal(logs[1].where, "somewhere else");
  assert.ok(!("_where" in logs[0].params));
  assert.equal(cacheKey("/x", { a: 1, _where: "y" }), cacheKey("/x", { a: 1 }));

  const mock = new BudgetedQloo(createQloo(), 10, (l) => logs.push(l));
  const plain = await mock.insights({ "filter.type": "urn:entity:locality", "filter.location.query": "Tokyo", take: 3 });
  const tagged = await mock.insights({ "filter.type": "urn:entity:locality", "filter.location.query": "Tokyo", take: 3, _where: "Tokyo" });
  assert.deepEqual(tagged, plain, "the mock ignores display params");
  clearQlooCache();
});

// F04
test("F04: IPv6 visitors count per /64, IPv4 per address", () => {
  assert.equal(ipBucket("2001:db8:1:2:aaaa::1"), ipBucket("2001:0db8:0001:0002:ffff:1:2:3"));
  assert.equal(ipBucket("2001:db8:1:2::5"), "2001:db8:1:2::/64");
  assert.notEqual(ipBucket("2001:db8:1:2::5"), ipBucket("2001:db8:1:3::5"));
  assert.equal(ipBucket("[2001:db8:1:2::9]:443"), "2001:db8:1:2::/64");
  assert.equal(ipBucket("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipBucket("203.0.113.7"), "203.0.113.7");
  assert.notEqual(ipBucket("203.0.113.7"), ipBucket("203.0.113.8"));

  const env = process.env.NODE_ENV;
  const limit = process.env.EXPLORE_RUNS_PER_IP_PER_HOUR;
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.EXPLORE_RUNS_PER_IP_PER_HOUR = "2";
  try {
    resetLimits();
    const now = 1_000_000;
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2::2"]) {
      const slot = admit(ip, now);
      assert.ok(slot.ok);
      slot.release();
    }
    const third = admit("2001:db8:1:2:dead:beef:0:3", now);
    assert.ok(!third.ok && third.reason === "hourly", "a new address in the same /64 is the same visitor");
    const other = admit("2001:db8:9:9::1", now);
    assert.ok(other.ok);
    other.release();
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = env;
    if (limit === undefined) delete process.env.EXPLORE_RUNS_PER_IP_PER_HOUR;
    else process.env.EXPLORE_RUNS_PER_IP_PER_HOUR = limit;
    resetLimits();
  }
});

// F06
test("F06: an event that can't be serialised is skipped, later events still arrive and the stream closes", async () => {
  resetLimits();
  const post = new Request("http://x/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const err = console.error;
  console.error = () => {};
  const res = exploreResponse({ city: "Tokyo", focus: "all" }, post, {
    recording: () => null,
    explore: async (_req, emit) => {
      emit({ type: "start", city: "Tokyo", focus: "all", qlooMode: "mock", llmMode: "none", budget: 40 });
      emit({ type: "step", id: "s1", phase: "think", title: "bad", detail: BigInt(1) as unknown as string } as AgentEvent);
      emit({ type: "done", callsUsed: 0, budget: 40, cards: 0 });
    },
  });
  const text = await res.text().finally(() => (console.error = err));
  const types = text
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { type: string }).type);
  assert.deepEqual(types, ["start", "done"]);
  resetLimits();
});

// F08
test("F08: inherited object keys are not cities", () => {
  for (const name of ["constructor", "Constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(canonicalCity(name), null, name);
    const r = parseExploreBody(JSON.stringify({ city: name }));
    assert.ok("error" in r && r.status === 400, name);
  }
  assert.equal(canonicalCity(" NYC "), "New York");
  assert.equal(qlooLocation("constructor"), "constructor");
  assert.equal(kmBetween("constructor", "Tokyo"), null);
});

// F10
test("F10: no x-powered-by, and security headers on every path", async () => {
  assert.equal(nextConfig.poweredByHeader, false);
  const rules = await nextConfig.headers!();
  const all = rules.find((r) => r.source === "/:path*");
  const h = Object.fromEntries((all?.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.equal(h["referrer-policy"], "strict-origin-when-cross-origin");
  assert.equal(h["x-frame-options"], "DENY");
  assert.match(h["content-security-policy"], /frame-ancestors 'none'/);
});

// F11
test("F11: a body declared over 2 KB is refused before it is read; an undeclared one stops at 2 KB", async () => {
  let pulled = false;
  const never = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const big = new Request("http://x/api/explore", { method: "POST", headers: { "content-length": "5000" }, body: never, duplex: "half" } as RequestInit);
  const r = await readExploreBody(big);
  assert.ok("error" in r && r.status === 413);
  assert.equal(pulled, false, "not read");

  const chunk = new TextEncoder().encode("x".repeat(1024));
  let sent = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(c) {
      sent++;
      c.enqueue(chunk);
    },
  });
  const r2 = await readExploreBody(new Request("http://x/api/explore", { method: "POST", body: endless, duplex: "half" } as RequestInit));
  assert.ok("error" in r2 && r2.status === 413);
  assert.ok(sent <= 4, `stopped early (${sent} chunks)`);

  const ok = await readExploreBody(new Request("http://x/api/explore", { method: "POST", body: '{"city":"東京"}' }));
  assert.deepEqual(ok, { text: '{"city":"東京"}' });
});

// F13
test("F13: a timeout while the body arrives is a retried timeout, a cancel is aborted, only bad JSON is bad_response", async () => {
  const f = scripted([]);
  const timeoutFetch = (async (url: URL | string, init?: RequestInit) => {
    f.seen.push({ url: String(url) });
    return f.seen.length === 1 ? stalledBody(init?.signal) : json(OK);
  }) as typeof fetch;
  const q = new LiveQloo(KEY, { fetch: timeoutFetch, sleep: noSleep, timeoutMs: 50 });
  const r = await q.insights({});
  assert.equal(r.results.entities?.length, 1, "the timed-out read was retried");
  assert.equal(q.attempts, 2);

  const ac = new AbortController();
  const cancelFetch = (async (_url: URL | string, init?: RequestInit) => {
    setTimeout(() => ac.abort(), 10);
    return stalledBody(init?.signal);
  }) as typeof fetch;
  const c = new LiveQloo(KEY, { fetch: cancelFetch, sleep: noSleep, signal: ac.signal, timeoutMs: 5_000 });
  await assert.rejects(c.insights({}), (e: unknown) => e instanceof QlooError && e.kind === "aborted");
  assert.equal(c.attempts, 1);

  const bad = new LiveQloo(KEY, { fetch: scripted([new Response("<html>oops</html>", { status: 200 })]).fn, sleep: noSleep });
  await assert.rejects(bad.insights({}), (e: unknown) => e instanceof QlooError && e.kind === "bad_response");
  assert.equal(bad.attempts, 1);
});

// F14
test("F14: an invalid QLOO_API_URL is a fatal error and sends nothing", async () => {
  for (const baseUrl of ["api.qloo.com", "ftp://api.qloo.com", "http://"]) {
    const f = scripted([json(OK)]);
    const q = new LiveQloo(KEY, { baseUrl, fetch: f.fn });
    await assert.rejects(q.insights({}), (e: unknown) => e instanceof QlooError && isFatalQlooError(e) && /QLOO_API_URL/.test(e.message), baseUrl);
    assert.equal(f.seen.length, 0);
    assert.equal(q.attempts, 0);
  }
});

// F15
test("F15: the key is redacted before the error body is shortened, so no prefix of it is left", async () => {
  const body = { e: "x".repeat(180) + KEY + "y".repeat(50) };
  const f = scripted([json(body, 400)]);
  const q = new LiveQloo(KEY, { fetch: f.fn });
  const logged: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    await assert.rejects(q.insights({}), (e: unknown) => e instanceof QlooError && !(e.detail ?? "").includes("test-") && !e.message.includes("test-"));
  } finally {
    console.error = err;
  }
  assert.ok(logged.length && logged.every((l) => !l.includes("test-")), "nor in the server log");
});

// F16
test("F16: a negative Retry-After never means a negative wait; one longer than the cap is not retried", async () => {
  const waits: number[] = [];
  const neg = new LiveQloo(KEY, { fetch: scripted([json({}, 429, { "retry-after": "-5" }), json(OK)]).fn, sleep: async (ms) => void waits.push(ms) });
  await quiet(() => neg.insights({}));
  assert.ok(waits[0] >= 0 && waits[0] < 300, `waited ${waits[0]}`);

  const long = new LiveQloo(KEY, { fetch: scripted([json({}, 429, { "retry-after": "60" }), json(OK)]).fn, sleep: noSleep });
  await quiet(() => assert.rejects(long.insights({}), (e: unknown) => e instanceof QlooError && e.kind === "rate_limit"));
  assert.equal(long.attempts, 1, "a doomed retry is not sent or charged");
});

// F18
test("F18: a refetched expired entry is the newest in the eviction order", async () => {
  clearQlooCache();
  setQlooCacheLimits({ entries: 2 });
  try {
    let now = 0;
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return json(OK);
    }) as typeof fetch;
    const c = new CachedQloo(new LiveQloo(KEY, { fetch: fetchFn }), 1_000, () => now);
    await c.insights({ k: "A" });
    now = 900;
    await c.insights({ k: "B" });
    now = 1_100;
    await c.insights({ k: "A" }); // expired: refetched
    assert.equal(calls, 3);
    await c.insights({ k: "C" }); // evicts the oldest: B, not the fresh A
    assert.equal(calls, 4);
    await c.insights({ k: "A" });
    assert.equal(calls, 4, "A is still cached");
    await c.insights({ k: "B" });
    assert.equal(calls, 5, "B was evicted");
  } finally {
    setQlooCacheLimits({ entries: 500 });
    clearQlooCache();
  }
});

// F24
test("F24: the cache is capped by size too, oldest first", async () => {
  clearQlooCache();
  const one = JSON.stringify(OK).length;
  setQlooCacheLimits({ bytes: one * 2 + 1 });
  try {
    const fetchFn = (async () => json(OK)) as typeof fetch;
    const c = new CachedQloo(new LiveQloo(KEY, { fetch: fetchFn }), 60_000);
    for (const k of ["A", "B", "C", "D"]) await c.insights({ k });
    assert.equal(qlooCacheSize(), 2);
    assert.ok(qlooCacheBytes() <= one * 2 + 1);
  } finally {
    setQlooCacheLimits({ bytes: 50_000_000 });
    clearQlooCache();
  }
  assert.equal(qlooCacheBytes(), 0);
});

// F25
test("F25: the backoff sleep removes its abort listener when the timer fires", async () => {
  const ac = new AbortController();
  for (let i = 0; i < 5; i++) await abortableSleep(1, ac.signal);
  assert.equal(getEventListeners(ac.signal, "abort").length, 0);
});

// F23, N07, N29
test("F23/N07/N29: summary lines omit missing affinities, average demographics rows, and count 1 place", () => {
  const tags = summarize("/v2/insights", { "filter.type": "urn:tag" }, { results: { tags: [{ tag_id: "a", name: "Jazz" }, { tag_id: "b", name: "Vinyl", query: { affinity: 0.5 } }] } });
  assert.equal(tags, "Jazz · Vinyl 0.50");
  const hoods = summarize("/v2/insights", { "filter.type": "urn:entity:locality" }, { results: { entities: [{ entity_id: "x", name: "Ginza" }] } });
  assert.equal(hoods, "Ginza");

  const demo = summarize("/v2/insights", { "filter.type": "urn:demographics" }, {
    results: {
      demographics: [
        { entity_id: "a", query: { age: { "24_and_younger": 0.4, "55_and_older": -0.2 } } },
        { entity_id: "b", query: { age: { "24_and_younger": -0.2, "55_and_older": 0.6 } } },
      ],
    },
  });
  assert.equal(demo, "age profile, leans 55+ (+0.20), 2 rows averaged");
  const single = summarize("/v2/insights", { "filter.type": "urn:demographics" }, { results: { demographics: [{ query: { age: { "25_to_29": 0.3 } } }] } });
  assert.equal(single, "age profile, leans 25–29 (+0.30)");

  const onePlace = summarize("/v2/insights", { "filter.type": "urn:entity:place", "filter.tags": "t" }, { results: { entities: [{ entity_id: "p", name: "Bar" }] } });
  assert.equal(onePlace, "1 place");
  const twoPlaces = summarize("/v2/insights", { "filter.type": "urn:entity:place", "filter.tags": "t" }, { results: { entities: [{ entity_id: "p", name: "Bar" }, { entity_id: "q", name: "Pub" }] } });
  assert.equal(twoPlaces, "2 places");
});

// N13
test("N13: QLOO_MODE is read trimmed and case-insensitively", () => {
  const mode = process.env.QLOO_MODE;
  const key = process.env.QLOO_API_KEY;
  try {
    process.env.QLOO_API_KEY = "k";
    for (const v of ["live", " live ", "LIVE", "Live\n"]) {
      process.env.QLOO_MODE = v;
      assert.equal(qlooMode(), "live", JSON.stringify(v));
    }
    process.env.QLOO_MODE = "mock";
    assert.equal(qlooMode(), "mock");
  } finally {
    process.env.QLOO_MODE = mode;
    if (key === undefined) delete process.env.QLOO_API_KEY;
    else process.env.QLOO_API_KEY = key;
  }
});

// F71: against a local fake server (no Qloo, no keys).
test("F71: record-sample refuses runs that don't go start..done, and mock runs as replays", async () => {
  let reply = "";
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(reply);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), "rec-"));
  const record = (out: string) =>
    new Promise<{ code: number; text: string }>((resolve) => {
      execFile(process.execPath, ["scripts/record-sample.mjs", "Tokyo", "all", base, "--out", out], { cwd: process.cwd() }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, text: stdout + stderr }),
      );
    });
  const nd = (events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const start = (qlooMode: string) => ({ type: "start", city: "Tokyo", focus: "all", qlooMode, llmMode: "none", budget: 40 });
  const done = { type: "done", callsUsed: 3, budget: 40, cards: 0 };
  const step = { type: "step", id: "s1", phase: "think", title: "x" };
  try {
    const replay = join(dir, "replays", "tokyo.json");
    reply = nd([start("mock"), step, done]);
    const mock = await record(replay);
    assert.notEqual(mock.code, 0);
    assert.match(mock.text, /must be a live run/);

    reply = nd([step, start("live"), done]);
    const late = await record(join(dir, "a.json"));
    assert.notEqual(late.code, 0);
    assert.match(late.text, /not "start"/);

    reply = nd([start("live"), done, step]);
    const cut = await record(join(dir, "b.json"));
    assert.notEqual(cut.code, 0);

    reply = nd([start("live"), step, done]);
    const good = await record(replay);
    assert.equal(good.code, 0, good.text);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
