// Fixes for the issues Codex found when it re-checked the 2026-10-24 review fixes (2026-10-25).
// Offline: mock Qloo, fake clients, a local HTTP server; no keys, no network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { gapScan } from "../src/components/explorer/derive";
import { OpportunityDetail } from "../src/components/explorer/OpportunityDetail";
import { initialState, reducer, type RunState } from "../src/components/explorer/useExploreRun";
import { categoriesFor } from "../src/lib/agent/categories";
import { rejectionReason, runClaudeAgent } from "../src/lib/agent/claude-agent";
import { Evidence } from "../src/lib/agent/evidence";
import { runPipeline } from "../src/lib/agent/pipeline";
import { explore, type ClaudeClient, type RunContext, type StopReason } from "../src/lib/agent/run";
import type { AgentEvent, OpportunityCard, SupplyEvent } from "../src/lib/agent/types";
import { BudgetedQloo, createQloo, type QlooCallLog, type QlooClient } from "../src/lib/qloo";
import { CachedQloo, clearQlooCache } from "../src/lib/qloo/cache";
import { LiveQloo, QlooError } from "../src/lib/qloo/live";
import tokyo from "../src/data/replays/tokyo.json";

process.env.MOCK_DELAY_MS = "0";
process.env.QLOO_MODE = "mock";
process.env.LLM_MODE = "mock";
delete process.env.ANTHROPIC_MODEL;

const MALA = "urn:tag:mock:place:malatang";
const BASE = (tokyo.events as AgentEvent[]).find((e): e is Extract<AgentEvent, { type: "card" }> => e.type === "card")!.card;
const fresh = (): RunState => reducer(initialState("Tokyo", { qlooMode: "mock", llmMode: "claude", budget: 40 }), { type: "reset", city: "Tokyo", focus: "all" });
const run = (events: AgentEvent[], s: RunState = fresh()) => events.reduce((st, e) => reducer(st, { type: "event", event: e }), s);

function setup(budget = 80) {
  const logs: QlooCallLog[] = [];
  const supply: SupplyEvent[] = [];
  const ev = new Evidence(new BudgetedQloo(createQloo(), budget, (l) => logs.push(l)), { categories: categoriesFor("all"), onSupply: (e) => supply.push(e) });
  const got: OpportunityCard[] = [];
  const rejected: OpportunityCard[] = [];
  const steps: string[] = [];
  const stopped: StopReason[] = [];
  const ctx: RunContext = {
    step: (_p, t) => steps.push(t),
    onCard: (c) => got.push(c),
    onRejected: (c) => rejected.push(c),
    onStopped: (s) => stopped.push(s),
    deadline: Date.now() + 120_000,
    signal: new AbortController().signal,
  };
  return { ev, ctx, got, rejected, steps, stopped, logs, supply };
}

type Call = { name: string; input: Record<string, unknown> };
type Body = { messages: { role: string; content: unknown }[] };
function fakeClaude(turns: (Call[] | (() => Promise<never>))[], retrieve: () => Promise<unknown> = async () => ({})) {
  let i = 0;
  const bodies: Body[] = [];
  const stream = (body: Body) => {
    bodies.push(body);
    return {
      finalMessage: async () => {
        const turn = turns[i++] ?? [];
        if (typeof turn === "function") return turn();
        return {
          stop_reason: turn.length ? "tool_use" : "end_turn",
          content: turn.length ? turn.map((c, j) => ({ type: "tool_use", id: `t${i}_${j}`, name: c.name, input: { reason: "test", ...c.input } })) : [{ type: "text", text: "Done." }],
        };
      },
    };
  };
  return { client: { beta: { messages: { stream } }, models: { retrieve } } as unknown as ClaudeClient, bodies };
}
const toolResults = (bodies: Body[]) =>
  (bodies.at(-1)?.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; content?: string }[]).filter((b) => b.type === "tool_result") : []));

async function withEnv<T>(vars: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  try {
    return await f();
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
const claudeEnv = { LLM_MODE: "claude", ANTHROPIC_API_KEY: "test-key-not-real" };

// 1. The pipeline cut short by the time limit before it found any gap still says it stopped early.
test("codex-1: a pipeline cut short by the time limit while profiling reports a stop, not a finished answer", async () => {
  const { ev, ctx, stopped, steps } = setup();
  // No gaps anywhere, so the scoring loop (which already reported stops) never runs.
  ev.supply = async () => ({ counts: {}, capped: false });
  const realNow = Date.now;
  let profiled = 0;
  const taste = ev.tasteProfile.bind(ev);
  ev.tasteProfile = async (hood, city) => {
    const r = await taste(hood, city);
    // The clock passes the deadline after the first neighbourhood.
    if (++profiled === 1) Date.now = () => realNow() + 10_000_000;
    return r;
  };
  try {
    await runPipeline({ city: "Tokyo", focus: "all" }, ev, ctx);
  } finally {
    Date.now = realNow;
  }
  assert.equal(steps.filter((t) => t.startsWith("Reading the taste profile of")).length, 1, "the profile loop stopped at the deadline");
  assert.deepEqual(stopped, [{ reason: "time", unscored: 0 }]);
  assert.ok(steps.includes("Stopping early to stay within the time limit"));
});

// 2. A shared Qloo request is cancelled once every run waiting on it has left.
test("codex-2: the shared cached request is cancelled when the last waiting run leaves, not before", async () => {
  clearQlooCache();
  const seen: (AbortSignal | null | undefined)[] = [];
  const inner = {
    mode: "live",
    attempts: 0,
    insights: (_p: unknown, o?: { signal?: AbortSignal | null }) => {
      seen.push(o?.signal);
      return new Promise((_res, rej) => o?.signal?.addEventListener("abort", () => rej(new QlooError("aborted", "shared request cancelled"))));
    },
    trending: async () => ({ results: {} }),
  } as unknown as QlooClient;
  const a = new AbortController();
  const b = new AbortController();
  const ca = new CachedQloo(inner, 60_000, Date.now, a.signal);
  const cb = new CachedQloo(inner, 60_000, Date.now, b.signal);
  const pa = ca.insights({ "filter.type": "urn:entity:place", q: "codex-2" }).catch((e) => e);
  const pb = cb.insights({ "filter.type": "urn:entity:place", q: "codex-2" }).catch((e) => e);
  assert.equal(seen.length, 1, "one HTTP call for both runs");
  const shared = seen[0];
  assert.ok(shared, "the shared request has a signal of its own");
  a.abort();
  assert.equal((await pa).kind, "aborted");
  assert.equal(shared!.aborted, false, "run B still waits, so the request carries on");
  b.abort();
  assert.equal((await pb).kind, "aborted");
  assert.equal(shared!.aborted, true, "nobody waits any more: the request is cancelled");
  clearQlooCache();
});

// 3. record-sample says it comes from the site, so a production server's origin check lets it in.
test("codex-3: record-sample sends the site's Origin", async () => {
  let origin: string | undefined;
  const server = createServer((req, res) => {
    origin = req.headers.origin;
    res.writeHead(500);
    res.end("stop here");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), "rec-origin-"));
  try {
    await new Promise<void>((resolve) => execFile(process.execPath, ["scripts/record-sample.mjs", "Tokyo", "all", base, "--out", join(dir, "x.json")], { cwd: process.cwd() }, () => resolve()));
    assert.equal(origin, base);
  } finally {
    server.close();
  }
});

// 4. A single-category recount that hits the page size is still a lower bound in the gap table.
test("codex-4: a recount that hit the page size keeps its '+' (supply event and gap table)", async () => {
  const supply: SupplyEvent[] = [];
  const full = { results: { entities: Array.from({ length: 50 }, (_, i) => ({ entity_id: `p${i}`, name: `P${i}`, tags: [{ id: MALA }] })) } };
  const live = { mode: "live", attempts: 0, insights: async () => full, trending: async () => ({ results: {} }) } as unknown as QlooClient;
  const ev = new Evidence(new BudgetedQloo(live, 80, () => {}), { categories: [MALA], onSupply: (e) => supply.push(e) });
  const r = await ev.homeCount("Shin-Okubo", "Tokyo", MALA);
  assert.deepEqual(r, { count: 50, capped: true });
  const last = supply.at(-1)!;
  assert.ok(last.exact && Object.values(last.exact)[0] === 50);
  assert.deepEqual(Object.values(last.exactCapped ?? {}), [true], "the event says the recount is capped");

  // The page keeps it as a lower bound.
  const label = Object.keys(last.exact!)[0];
  const s = run([
    { type: "twin", home: "Shin-Okubo", homeCity: "Tokyo", twin: "Myeongdong", twinCity: "Seoul", similarity: 0.5, rank: 1, tastes: [], calls: [] },
    { type: "supply", hood: "Shin-Okubo", city: "Tokyo", counts: { [label]: 40 }, calls: [1], capped: true, exact: { [label]: 50 }, exactCapped: { [label]: true } },
    { type: "supply", hood: "Myeongdong", city: "Seoul", counts: { [label]: 10 }, calls: [2], capped: false },
  ]);
  const row = gapScan(s, null).find((x) => x.category === label)!;
  assert.equal(row.here, 50);
  assert.equal(row.hereCapped, true);
});

// 5. A capped twin count cannot settle that a gap is small.
test("codex-5: a gap below the bar on a capped twin count is 'possible', not 'small'", () => {
  const s = run([
    { type: "twin", home: "Shibuya", homeCity: "Tokyo", twin: "Manhattan", twinCity: "New York", similarity: 0.5, rank: 1, tastes: [], calls: [] },
    { type: "supply", hood: "Shibuya", city: "Tokyo", counts: { Bagels: 2 }, calls: [1], capped: false },
    { type: "supply", hood: "Manhattan", city: "New York", counts: { Bagels: 5 }, calls: [2], capped: true },
  ]);
  const row = gapScan(s, null).find((x) => x.category === "Bagels")!;
  assert.equal(row.verdict, "unclear");
  // Still "small" when both counts are exact.
  const exact = run([
    { type: "twin", home: "Shibuya", homeCity: "Tokyo", twin: "Manhattan", twinCity: "New York", similarity: 0.5, rank: 1, tastes: [], calls: [] },
    { type: "supply", hood: "Shibuya", city: "Tokyo", counts: { Bagels: 2 }, calls: [1], capped: false },
    { type: "supply", hood: "Manhattan", city: "New York", counts: { Bagels: 5 }, calls: [2], capped: false },
  ]);
  assert.equal(gapScan(exact, null).find((x) => x.category === "Bagels")!.verdict, "small");
});

// 6. No age data for the people here: not "not checked" (rejection advice and self-check).
test("codex-6: no age data for the neighbourhood is not offered as a check still to run", () => {
  const audience = { key: "audience", label: "Core audience fit", value: null, source: "pending" as const, note: `No age data for people in ${BASE.homeLocality}` };
  const c: OpportunityCard = { ...BASE, confidence: 0.4, scores: BASE.scores.map((s) => (s.key === "audience" ? audience : s)) };
  const peek = (k: string) => (k === `hoodaudience:${c.homeLocality}, ${c.homeCity}` ? null : k.startsWith("audience:") ? { age: {} } : undefined);
  const reason = rejectionReason(c, { qloo: { mode: "live" }, peek } as never);
  assert.ok(!/Not checked yet:[^.;]*Core audience fit/.test(reason), reason);
  const html = renderToStaticMarkup(h(OpportunityDetail, { card: c, llmMode: "claude", rank: null }));
  assert.match(html, /No local age data/);
});

// 7. The pipeline's own text never states a capped count as exact.
test("codex-7: the pipeline's 'why' says 'at least' for a capped twin count", async () => {
  const { ev, ctx, got, rejected } = setup();
  // The twin page is a capped sample with plenty of mala tang places.
  const supply = ev.supply.bind(ev);
  ev.supply = async (hood, city) => {
    const s = await supply(hood, city);
    return city === "Seoul" ? { counts: { ...s.counts, [MALA]: 30 }, capped: true } : s;
  };
  (ev as unknown as { cache: Map<string, unknown> }).cache.set("supply:Myeongdong, Seoul", { counts: { [MALA]: 30 }, capped: true });
  await runPipeline({ city: "Tokyo", focus: "all" }, ev, ctx);
  const capped = [...got, ...rejected].filter((c) => c.capped.twin);
  assert.ok(capped.length > 0, "a card was built on a capped twin page");
  for (const c of capped) assert.match(c.why, new RegExp(`at least ${c.twinCount} `), c.why);
});

// 8. Ruled-out rows in the agent log link to their evidence.
test("codex-8: a ruled-out row carries the card's Qloo calls", () => {
  const s = run([{ type: "rejected", card: BASE, reason: "Below the 55% bar" }]);
  const row = s.steps.find((st) => st.ruledOut)!;
  const expected = [...new Set(Object.values(BASE.refs).flat())].sort((a, b) => a - b);
  assert.ok(expected.length > 0);
  assert.deepEqual(row.refs, expected);
});

// 9. A retry on the default model renames the model the page shows.
test("codex-9: when the checked model vanishes mid-run, the retry on the default model is reported", async () => {
  await withEnv({ ...claudeEnv, ANTHROPIC_MODEL: "claude-sonnet-4-5" }, async () => {
    const notFound = async (): Promise<never> => {
      throw new Anthropic.NotFoundError(404, { type: "error" }, "model not found", new Headers());
    };
    const { client } = fakeClaude([notFound, [], []]);
    const events: AgentEvent[] = [];
    await explore({ city: "Tokyo", focus: "all" }, (e) => events.push(e), { deadline: Date.now() + 120_000, signal: new AbortController().signal, client }).catch(() => {});
    const mode = events.find((e): e is Extract<AgentEvent, { type: "mode" }> => e.type === "mode" && !!e.model);
    assert.ok(mode, "a mode event names the new model");
    const s = run(events);
    assert.equal(s.meta.model, mode!.model);
    assert.equal(s.meta.llmMode, "claude");
    assert.equal(s.meta.fallbackReason, undefined, "it is not a fallback to the pipeline");
  });
});

// 10. A trend checked in a city that isn't the card's twin's says it won't count.
test("codex-10: the trend tool says which cards it counts for", async () => {
  const { ev, ctx } = setup();
  const { client, bodies } = fakeClaude([[{ name: "trend", input: { category: MALA, city: "New York" } }], []]);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  const r = toolResults(bodies).find((b) => /counts_for/.test(b.content ?? ""));
  assert.ok(r, "the trend result carries counts_for");
  assert.match(r!.content!, /Counts only for opportunities whose twin is in New York/);
});

// 11. A run cancelled while Qloo's error body arrives is a cancel, not that status's error.
test("codex-11: a cancel during a non-OK response body is reported as aborted", async () => {
  const viewer = new AbortController();
  const fetchFn = (async () => {
    const body = new ReadableStream({
      start(c) {
        viewer.signal.addEventListener("abort", () => c.error(new Error("stream cut")));
      },
    });
    setTimeout(() => viewer.abort(), 20);
    return new Response(body, { status: 503 });
  }) as unknown as typeof fetch;
  const q = new LiveQloo("k", { fetch: fetchFn, signal: viewer.signal, retries: 2, sleep: async () => {} } as never);
  const err = await q.insights({ "filter.type": "urn:entity:place" }).catch((e) => e);
  assert.ok(err instanceof QlooError);
  assert.equal(err.kind, "aborted");
});

// 12. (Replaces the weak N21 check.) A card already shown is never re-scored in the log, even
// when a later lookup moves its provisional score.
test("codex-12/N21: a later lookup that moves a shown card's score logs no re-score for it", async () => {
  await withEnv(claudeEnv, async () => {
    const submit = { name: "submit_opportunity", input: { category: MALA, neighbourhood: "Shin-Okubo", twin_neighbourhood: "Myeongdong", twin_city: "Seoul", why: "Test.", product_fit_score: 1, product_fit_reason: "Test.", doubts: [] } };
    const { client } = fakeClaude([
      [{ name: "list_neighbourhoods", input: { city: "Tokyo" } }],
      [{ name: "find_taste_twins", input: { neighbourhood: "Shin-Okubo", other_city: "Seoul" } }],
      [{ name: "compare_supply", input: { neighbourhood: "Shin-Okubo", twin_neighbourhood: "Myeongdong", twin_city: "Seoul" } }],
      [submit],
      // These move the provisional score of the gap just settled.
      [{ name: "check_city_supply", input: { category: MALA } }],
      [{ name: "audience_profile", input: { category: MALA, neighbourhood: "Shin-Okubo" } }],
      [{ name: "trend", input: { category: MALA, city: "Seoul" } }],
      [],
    ]);
    const events: AgentEvent[] = [];
    await explore({ city: "Tokyo", focus: "all" }, (e) => events.push(e), { deadline: Date.now() + 120_000, signal: new AbortController().signal, client }).catch(() => {});
    const settled = events.find((e) => e.type === "card" || e.type === "rejected") as Extract<AgentEvent, { type: "card" | "rejected" }> | undefined;
    assert.ok(settled, "the submission was settled (shown or ruled out)");
    const id = settled!.card.id;
    const after = events.slice(events.indexOf(settled!) + 1);
    assert.ok(after.some((e) => e.type === "call"), "later lookups were made");
    assert.ok(!after.some((e) => e.type === "rescore" && e.id === id), `no re-score of ${id} after it was settled`);
  });
});
