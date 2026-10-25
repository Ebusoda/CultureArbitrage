// Live Qloo client and cache, against a fake fetch. No network, no key needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CachedQloo, cacheKey, clearQlooCache } from "../src/lib/qloo/cache";
import { LiveQloo, QlooError } from "../src/lib/qloo/live";
import { BudgetedQloo, isFatalQlooError, type QlooCallLog } from "../src/lib/qloo";

const KEY = "test-key-123";
const OK = { results: { entities: [{ entity_id: "e1", name: "Shimokitazawa" }] } };

// Answers each fetch with the next scripted response; records what was asked.
function fakeFetch(script: (Response | Error | "hang")[]) {
  const seen: { url: string; headers: Headers }[] = [];
  const fn = (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers) });
    const next = script.shift() ?? new Error("script ran out");
    if (next === "hang") {
      // AbortSignal.timeout's timer doesn't keep Node alive on its own, so hold the loop open.
      const keepAlive = setTimeout(() => {}, 5_000);
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal!.reason);
        }),
      );
    }
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};

test("sends the key as a header, never in the URL, and joins a base URL with a path prefix", async () => {
  const f = fakeFetch([json(OK)]);
  const q = new LiveQloo(KEY, { baseUrl: "https://example.test/prefix/", fetch: f.fn });
  await q.insights({ "filter.type": "urn:entity:locality", take: 3, "signal.interests.tags": "a,b", empty: "" });
  const u = new URL(f.seen[0].url);
  assert.equal(u.origin + u.pathname, "https://example.test/prefix/v2/insights");
  assert.equal(u.searchParams.get("take"), "3");
  assert.equal(u.searchParams.get("signal.interests.tags"), "a,b");
  assert.equal(u.searchParams.has("empty"), false);
  assert.equal(f.seen[0].headers.get("x-api-key"), KEY);
  assert.ok(!f.seen[0].url.includes(KEY));
});

test("retries 429 and 5xx, then succeeds", async () => {
  const f = fakeFetch([json({}, 429), json({}, 503), json(OK)]);
  const q = new LiveQloo(KEY, { fetch: f.fn, sleep: noSleep, retries: 2 });
  const r = await q.insights({});
  assert.equal(r.results.entities?.length, 1);
  assert.equal(q.attempts, 3);
});

test("gives up after the retry limit with a rate_limit error", async () => {
  const f = fakeFetch([json({}, 429), json({}, 429), json({}, 429)]);
  const q = new LiveQloo(KEY, { fetch: f.fn, sleep: noSleep, retries: 2 });
  await assert.rejects(q.insights({}), (e: unknown) => e instanceof QlooError && e.kind === "rate_limit" && e.status === 429);
  assert.equal(q.attempts, 3);
});

test("does not retry a 400 (wrong parameters would fail again)", async () => {
  const f = fakeFetch([json({ error: "bad signal" }, 400), json(OK)]);
  const q = new LiveQloo(KEY, { fetch: f.fn, sleep: noSleep });
  // Qloo's own text is kept as detail (server log), never in the message the page may show.
  await assert.rejects(q.insights({}), (e: unknown) => e instanceof QlooError && e.kind === "bad_request" && /bad signal/.test(e.detail ?? "") && !/bad signal/.test(e.message));
  assert.equal(q.attempts, 1);
});

test("a rejected key is an auth error, is not retried, and stops the run", async () => {
  const f = fakeFetch([json({ message: `invalid key ${KEY}` }, 401)]);
  const q = new LiveQloo(KEY, { fetch: f.fn, sleep: noSleep });
  await assert.rejects(q.insights({}), (e: unknown) => {
    assert.ok(e instanceof QlooError && e.kind === "auth");
    assert.ok(!e.message.includes(KEY), "key must be redacted from the message");
    assert.ok(isFatalQlooError(e));
    return true;
  });
  assert.equal(q.attempts, 1);
});

test("times out a stalled request and retries it", async () => {
  const f = fakeFetch(["hang", json(OK)]);
  const q = new LiveQloo(KEY, { fetch: f.fn, sleep: noSleep, timeoutMs: 50 });
  const r = await q.insights({});
  assert.equal(r.results.entities?.length, 1);
  assert.equal(q.attempts, 2);
});

test("network errors are retried, then reported as network errors", async () => {
  const f = fakeFetch([new TypeError("fetch failed"), new TypeError("fetch failed")]);
  const q = new LiveQloo(KEY, { fetch: f.fn, sleep: noSleep, retries: 1 });
  await assert.rejects(q.insights({}), (e: unknown) => e instanceof QlooError && e.kind === "network");
});

test("a 200 without results is a bad_response, not an empty answer", async () => {
  const f = fakeFetch([json({ success: false, errors: ["nope"] })]);
  const q = new LiveQloo(KEY, { fetch: f.fn });
  await assert.rejects(q.insights({}), (e: unknown) => e instanceof QlooError && e.kind === "bad_response" && /success/.test(e.message));
});

test("honours Retry-After (seconds), capped", async () => {
  const waits: number[] = [];
  const f = fakeFetch([json({}, 429, { "retry-after": "2" }), json(OK)]);
  const q = new LiveQloo(KEY, { fetch: f.fn, sleep: async (ms) => void waits.push(ms) });
  await q.insights({});
  assert.ok(waits[0] >= 2000 && waits[0] < 2500, `waited ${waits[0]}`);
});

test("a cancelled run stops without retrying", async () => {
  const ac = new AbortController();
  const f = fakeFetch([json({}, 503), json(OK)]);
  const q = new LiveQloo(KEY, { fetch: f.fn, signal: ac.signal, sleep: async () => ac.abort() });
  await assert.rejects(q.insights({}), (e: unknown) => e instanceof QlooError);
  assert.equal(q.attempts, 1);
});

test("cache: identical requests hit Qloo once, in any parameter order, and are logged as cached", async () => {
  clearQlooCache();
  const f = fakeFetch([json(OK)]);
  const cached = new CachedQloo(new LiveQloo(KEY, { fetch: f.fn }), 60_000);
  const logs: QlooCallLog[] = [];
  const b = new BudgetedQloo(cached, 10, (l) => logs.push(l));
  await b.insights({ a: 1, b: 2 });
  await b.insights({ b: 2, a: 1 });
  assert.equal(f.seen.length, 1);
  assert.equal(logs[0].cached, undefined);
  assert.equal(logs[1].cached, true);
  assert.equal(b.used, 2, "a cached call still counts once against the run budget");
  assert.equal(cacheKey("/x", { b: 2, a: 1, c: undefined }), "/x?a=1&b=2");
});

test("cache: concurrent identical requests share one HTTP call; failures are not cached", async () => {
  clearQlooCache();
  const f = fakeFetch([json({}, 400), json(OK)]);
  const cached = new CachedQloo(new LiveQloo(KEY, { fetch: f.fn }), 60_000);
  await assert.rejects(cached.insights({ q: 1 }));
  const [x, y] = await Promise.all([cached.insights({ q: 1 }), cached.insights({ q: 1 })]);
  assert.equal(x, y);
  assert.equal(f.seen.length, 2);
});

test("cache: entries expire after the TTL, and TTL 0 turns it off", async () => {
  clearQlooCache();
  let now = 0;
  const f = fakeFetch([json(OK), json(OK), json(OK), json(OK)]);
  const cached = new CachedQloo(new LiveQloo(KEY, { fetch: f.fn }), 1_000, () => now);
  await cached.insights({ q: 1 });
  now = 500;
  await cached.insights({ q: 1 });
  now = 1_600;
  await cached.insights({ q: 1 });
  assert.equal(f.seen.length, 2);
  const off = new CachedQloo(new LiveQloo(KEY, { fetch: f.fn }), 0);
  await off.insights({ q: 1 });
  await off.insights({ q: 1 });
  assert.equal(f.seen.length, 4);
});

test("budget: retries are charged, and the cap is enforced", async () => {
  const f = fakeFetch([json({}, 500), json(OK), json(OK)]);
  const b = new BudgetedQloo(new LiveQloo(KEY, { fetch: f.fn, sleep: noSleep }), 3, () => {});
  await b.insights({});
  assert.equal(b.used, 2);
  await b.insights({});
  await assert.rejects(b.insights({}), /budget/);
});
