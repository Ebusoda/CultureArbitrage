// Fixes from the 2026-10-24 review in the agent loop, the run and the fixed pipeline
// (claude-agent.ts, run.ts, pipeline.ts, config.ts). Offline: mock Qloo, a stubbed fetch,
// and scripted fake Claude clients.
import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { categoriesFor } from "../src/lib/agent/categories";
import { DEFAULT_MODEL, rejectionReason, runClaudeAgent } from "../src/lib/agent/claude-agent";
import { Evidence } from "../src/lib/agent/evidence";
import { runPipeline } from "../src/lib/agent/pipeline";
import { currentModes, explore, type ClaudeClient, type RunContext, type StopReason } from "../src/lib/agent/run";
import type { AgentEvent, OpportunityCard } from "../src/lib/agent/types";
import { config } from "../src/lib/config";
import { BudgetedQloo, BudgetExceededError, createQloo, QlooError, type QlooCallLog } from "../src/lib/qloo";

process.env.MOCK_DELAY_MS = "0";
process.env.QLOO_MODE = "mock";
process.env.LLM_MODE = "mock";
delete process.env.ANTHROPIC_MODEL;

type Call = { name: string; input: Record<string, unknown> };
type Turn = Call[] | (() => Promise<never>);
type Body = { messages: { role: string; content: unknown }[] };

// A fake Anthropic client: each turn is a list of tool calls, or a function that throws.
// Keeps every request body, so a test can read the tool results sent back.
function fakeClaude(turns: Turn[], opts: { retrieve?: (model: string) => Promise<unknown> } = {}) {
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
  const client = { beta: { messages: { stream } }, models: { retrieve: opts.retrieve ?? (async () => ({})) } };
  return { client: client as unknown as ClaudeClient, bodies };
}

type Result = { type: string; tool_use_id?: string; content?: string; is_error?: boolean };
// The tool results of the latest turn that had any (later bodies may only carry a nudge).
function lastResults(bodies: Body[]): Result[] {
  const msgs = bodies.at(-1)?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].content;
    const results = Array.isArray(c) ? (c as Result[]).filter((b) => b.type === "tool_result") : [];
    if (results.length) return results;
  }
  return [];
}
function allResults(bodies: Body[]) {
  const msgs = bodies.at(-1)?.messages ?? [];
  return msgs.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; content?: string; is_error?: boolean }[]).filter((b) => b.type === "tool_result") : []));
}

function setup(budget = 80) {
  const logs: QlooCallLog[] = [];
  const ev = new Evidence(new BudgetedQloo(createQloo(), budget, (l) => logs.push(l)), { categories: categoriesFor("all") });
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
  return { ev, ctx, got, rejected, steps, stopped, logs };
}

// A mock gap (from the review's repro): mala tang, Shin-Okubo vs Myeongdong.
const MALA = "urn:tag:mock:place:malatang";
const pairWalk: Call[][] = [
  [{ name: "list_neighbourhoods", input: { city: "Tokyo" } }],
  [{ name: "find_taste_twins", input: { neighbourhood: "Shin-Okubo", other_city: "Seoul" } }],
  [{ name: "compare_supply", input: { neighbourhood: "Shin-Okubo", twin_neighbourhood: "Myeongdong", twin_city: "Seoul" } }],
];
const malaSubmit = (fit: number, doubts: { about: string; text: string }[] = [], twinCity = "Seoul"): Call => ({
  name: "submit_opportunity",
  input: { category: MALA, neighbourhood: "Shin-Okubo", twin_neighbourhood: "Myeongdong", twin_city: twinCity, why: "Test.", product_fit_score: fit, product_fit_reason: "Test.", doubts },
});

async function runExplore(opts: { client?: ClaudeClient; deadline?: number } = {}) {
  const events: AgentEvent[] = [];
  let error: unknown = null;
  try {
    await explore({ city: "Tokyo", focus: "all" }, (e) => events.push(e), { deadline: opts.deadline ?? Date.now() + 120_000, signal: new AbortController().signal, client: opts.client });
  } catch (e) {
    error = e;
  }
  return { events, error };
}

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

// F28 / M-4
test("F28: a Qloo outage after the neighbourhood list ends as an error (so the recording plays), not as 'nothing found'", async () => {
  const realFetch = globalThis.fetch;
  const ents = ["Shibuya", "Shinjuku", "Taito"].map((n, i) => ({
    entity_id: `id${i}`,
    name: n,
    properties: { geocode: { latitude: 35.6, longitude: 139.7 } },
    tags: [{ id: `urn:tag:characteristic:qloo:t${i}`, name: `Taste ${i}`, type: "urn:tag:characteristic:qloo" }],
  }));
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.searchParams.get("filter.type") === "urn:entity:locality") return new Response(JSON.stringify({ results: { entities: ents } }), { status: 200 });
    return new Response("upstream down", { status: 503 });
  }) as typeof fetch;
  try {
    await withEnv({ QLOO_MODE: "live", QLOO_API_KEY: "fake-key", QLOO_RETRIES: "0", QLOO_CACHE_TTL_MS: "0", GOOGLE_MAPS_API_KEY: undefined }, async () => {
      const { events, error } = await runExplore();
      assert.ok(error instanceof Error, "the run fails");
      assert.match((error as Error).message, /comparison/);
      assert.ok(!events.some((e) => e.type === "done"), "no done event");

      const { exploreResponse } = await import("../src/lib/explore-stream");
      const recording = { recordedAt: "2026-10-24T09:00:00.000Z", events: [{ type: "start", city: "Tokyo", focus: "all", qlooMode: "live", llmMode: "none", budget: 40, t: 0 }, { type: "done", callsUsed: 1, budget: 40, cards: 0, t: 1 }] };
      const res = exploreResponse({ city: "Tokyo", focus: "all" }, new Request("http://x/", { method: "POST" }), { recording: () => recording as never });
      const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
      assert.ok(lines.some((e) => e.type === "replay"), "the recording takes over");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("F28: a Claude run that compared nothing ends as an error; one that compared and found nothing ends as done", async () => {
  await withEnv(claudeEnv, async () => {
    const none = await runExplore({ client: fakeClaude([[{ name: "list_neighbourhoods", input: { city: "Tokyo" } }], [], []]).client });
    assert.ok(none.error instanceof Error, "nothing compared: error");
    assert.ok(!none.events.some((e) => e.type === "done"));

    // Compared one pair (a real comparison), submitted nothing, then stopped: a real answer.
    const real = await runExplore({ client: fakeClaude([...pairWalk, [], []]).client });
    assert.equal(real.error, null);
    const done = real.events.at(-1);
    assert.equal(done?.type, "done");
    assert.equal(done?.type === "done" && done.cards, 0);
  });
});

// M10 / M-5
test("M10: the pipeline stopping on the Qloo budget with gaps unscored says so in done.stopped", async () => {
  // Small budgets stop the scoring loop with gaps found; find one that does (mock data).
  let hit: Extract<AgentEvent, { type: "done" }> | null = null;
  for (const b of [14, 16, 18, 20, 22, 24]) {
    const { events, error } = await withEnv({ QLOO_CALL_BUDGET: String(b) }, () => runExplore());
    const done = events.at(-1);
    if (!error && done?.type === "done" && done.stopped) {
      hit = done;
      break;
    }
  }
  assert.ok(hit, "some small budget stops the pipeline with gaps unscored");
  assert.equal(hit.stopped?.reason, "budget");
  assert.ok((hit.stopped?.unscored ?? 0) > 0);

  // A run that finishes its work carries no stop reason.
  const full = await runExplore();
  const done = full.events.at(-1);
  assert.equal(done?.type, "done");
  assert.equal(done?.type === "done" ? done.stopped : "x", undefined);
});

// F29 (+ M10 for Claude): deadline checked before every tool call.
test("F29: after the deadline the remaining tool calls get an 'out of time' result, and gaps left unscored are reported", async () => {
  const { ev, ctx, stopped, logs } = setup();
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const { client, bodies } = fakeClaude([
      ...pairWalk,
      [
        { name: "check_city_supply", input: { category: MALA } },
        { name: "audience_profile", input: { category: MALA, neighbourhood: "Shin-Okubo" } },
        { name: "trend", input: { category: MALA, city: "Seoul" } },
      ],
      [{ name: "list_neighbourhoods", input: { city: "Tokyo" } }],
    ]);
    // Jump past the deadline as soon as the city-wide lookup has run.
    const qlooCalls = () => logs.length;
    let jumpAt = Infinity;
    ctx.step = (_p, t) => {
      if (/across the whole city/.test(t)) jumpAt = qlooCalls() + 1;
    };
    const origInsights = ev.qloo.insights.bind(ev.qloo);
    ev.qloo.insights = async (p) => {
      const r = await origInsights(p);
      if (qlooCalls() >= jumpAt) offset = 200_000;
      return r;
    };
    await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
    const results = lastResults(bodies);
    assert.equal(bodies.length, 4, "no turn starts after the deadline");
    assert.equal(results.length, 3, "every tool_use gets a tool_result");
    assert.ok(!results[0].is_error, "the call before the deadline ran");
    assert.ok(results.slice(1).every((r) => r.is_error && /Out of time/.test(r.content ?? "")), "the rest are answered 'out of time'");
    assert.deepEqual(stopped.map((s) => s.reason), ["time"]);
    assert.ok(stopped[0].unscored > 0, "the compared gaps that were never submitted are counted");
  } finally {
    Date.now = realNow;
  }
});

test("F29: EXPLORE_TIME_BUDGET_MS is held between 30 s and 200 s", async () => {
  await withEnv({ EXPLORE_TIME_BUDGET_MS: "280000" }, async () => assert.equal(config.timeBudgetMs(), 200_000));
  await withEnv({ EXPLORE_TIME_BUDGET_MS: "10000" }, async () => assert.equal(config.timeBudgetMs(), 30_000));
  await withEnv({ EXPLORE_TIME_BUDGET_MS: undefined }, async () => assert.equal(config.timeBudgetMs(), 150_000));
});

// F27
test("F27: a turn cut off by the deadline is 'out of time': cards stay, no 'Claude is unavailable', no pipeline", async () => {
  // AbortSignal.timeout is replaced so the test can fire the per-turn deadline at once.
  const realTimeout = AbortSignal.timeout;
  const timers: AbortController[] = [];
  AbortSignal.timeout = () => {
    const c = new AbortController();
    timers.push(c);
    return c.signal;
  };
  try {
    await withEnv(claudeEnv, async () => {
      const cutOff = async (): Promise<never> => {
        timers.at(-1)!.abort(new DOMException("timed out", "TimeoutError"));
        throw new Anthropic.APIUserAbortError();
      };
      const { client } = fakeClaude([
        ...pairWalk,
        [
          { name: "check_city_supply", input: { category: MALA } },
          { name: "audience_profile", input: { category: MALA, neighbourhood: "Shin-Okubo" } },
          { name: "trend", input: { category: MALA, city: "Seoul" } },
        ],
        [malaSubmit(0.9)],
        cutOff,
      ]);
      const { events, error } = await runExplore({ client });
      assert.equal(error, null, `no error (${error})`);
      const titles = events.flatMap((e) => (e.type === "step" ? [e.title] : []));
      assert.ok(!events.some((e) => e.type === "mode"), "no switch to the pipeline");
      assert.ok(!titles.some((t) => /unavailable|Claude stopped early/.test(t)), "not reported as Claude failing");
      assert.ok(titles.includes("Out of time, stopping with what was found"));
      const done = events.at(-1);
      assert.equal(done?.type, "done");
      const cards = events.filter((e) => e.type === "card");
      assert.equal(cards.length, 1, "the submitted card stays");
      assert.equal(done?.type === "done" && done.cards, 1);
    });
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});

test("F27: the pipeline starts no lookup after the deadline", async () => {
  const { ev, ctx, logs } = setup();
  ctx.deadline = Date.now() - 1;
  const cards = await runPipeline({ city: "Tokyo", focus: "all" }, ev, ctx);
  assert.equal(cards.length, 0);
  assert.equal(logs.length, 0, "no Qloo call");
});

// N20 + F09 (run.ts)
test("N20: after Claude fails, the fallback pipeline does not bring back what Claude ruled out; the reason shown is generic", async () => {
  await withEnv(claudeEnv, async () => {
    const overloaded = async (): Promise<never> => {
      throw new Anthropic.InternalServerError(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded: secret upstream detail" } }, "529 Overloaded: secret upstream detail", new Headers());
    };
    const { client } = fakeClaude([
      ...pairWalk,
      [
        { name: "check_city_supply", input: { category: MALA } },
        { name: "audience_profile", input: { category: MALA, neighbourhood: "Shin-Okubo" } },
        { name: "trend", input: { category: MALA, city: "Seoul" } },
      ],
      [malaSubmit(0.1, [{ about: "other", text: "Rents are prohibitive." }, { about: "other", text: "Two openings closed in 2025." }])],
      overloaded,
    ]);
    const { events, error } = await runExplore({ client });
    assert.equal(error, null, `no error (${error})`);
    const ruledOut = events.flatMap((e) => (e.type === "rejected" ? [e.card] : []));
    const mala = ruledOut.find((c) => c.categoryId === MALA && c.homeLocality === "Shin-Okubo");
    assert.ok(mala, "Claude ruled the mala tang gap out");
    assert.equal(mala.author, "claude");
    const mode = events.find((e) => e.type === "mode");
    assert.ok(mode && mode.type === "mode", "the pipeline took over");
    assert.equal(mode.reason, "Claude is overloaded or down");
    assert.ok(!JSON.stringify(events).includes("secret upstream detail"), "the upstream message is not shown");
    const cards = events.flatMap((e) => (e.type === "card" ? [e.card] : []));
    assert.ok(!cards.some((c) => c.id === mala.id), "the ruled-out gap is not accepted by the pipeline");
    for (const c of cards) assert.equal(c.author, "pipeline");
    assert.equal(events.filter((e) => e.type === "rejected" && e.card.id === mala.id).length, 1, "nor ruled out a second time");
  });
});

// N21
test("N21: no re-scoring log lines for a gap already shown as a card or as ruled out", async () => {
  const { events } = await runExplore();
  const settled = new Set<string>();
  for (const e of events) {
    if (e.type === "card" || e.type === "rejected") settled.add(e.card.id);
    if (e.type === "rescore") assert.ok(!settled.has(e.id), `rescore of ${e.id} after it was settled`);
  }
});

// N09 + author
test("N09: the pipeline's 'why' names the card's own shared tastes; pipeline cards are marked as such", async () => {
  const { events } = await runExplore();
  const cards = events.flatMap((e) => (e.type === "card" || e.type === "rejected" ? [e.card] : []));
  assert.ok(cards.length > 0);
  for (const c of cards) {
    assert.equal(c.author, "pipeline");
    for (const t of c.sharedTastes) assert.ok(c.why.includes(t.name), `${c.id}: why names ${t.name}`);
  }
});

// N10
test("N10: a failed twin lookup in one city keeps the twin found in the other", async () => {
  const { ev, ctx, steps } = setup();
  const orig = ev.findTwins.bind(ev);
  ev.findTwins = async (hood, city, other, take) => {
    if (other === "Seoul") throw new QlooError("server", "Qloo 503");
    return orig(hood, city, other, take);
  };
  await runPipeline({ city: "Tokyo", focus: "all" }, ev, ctx);
  assert.ok(steps.some((t) => /^Skipped twins of .* in Seoul/.test(t)));
  assert.ok(steps.some((t) => /^Comparing .*, New York$/.test(t)), "the New York twins are still compared");
});

// N11
test("N11: a fallback pipeline reuses the neighbourhood list Claude already fetched", async () => {
  const { ev, ctx, logs } = setup();
  await ev.listNeighbourhoods("Tokyo", 5);
  const before = logs.length;
  await runPipeline({ city: "Tokyo", focus: "all" }, ev, ctx);
  const listings = logs.slice(before).filter((l) => l.params["filter.type"] === "urn:entity:locality" && !l.params["signal.interests.tags"]);
  assert.equal(listings.length, 0, "no second neighbourhood listing");
});

// F26 + N16
test("F26/N16: twin and trend cities must be one of the other cities (never the home city)", async () => {
  const { ev, ctx, got } = setup();
  const { client, bodies } = fakeClaude([
    ...pairWalk,
    [
      { name: "compare_supply", input: { neighbourhood: "Shin-Okubo", twin_neighbourhood: "Shibuya", twin_city: "Tokyo" } },
      { name: "find_taste_twins", input: { neighbourhood: "Shin-Okubo", other_city: "Paris" } },
      { name: "trend", input: { category: MALA, city: "Tokyo" } },
      malaSubmit(0.9, [], "Tokyo"),
    ],
  ]);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  const results = lastResults(bodies);
  assert.equal(results.length, 4);
  for (const r of results) {
    assert.ok(r.is_error, `refused: ${r.content}`);
    assert.match(r.content ?? "", /is not a city to compare with\. Use one of: New York, Seoul/);
  }
  assert.equal(got.length, 0);
  // The schema offers only those cities.
  const tools = (bodies[0] as unknown as { tools: { name: string; input_schema: { properties: Record<string, { enum?: string[] }> } }[] }).tools;
  const compare = tools.find((t) => t.name === "compare_supply")!;
  assert.deepEqual(compare.input_schema.properties.twin_city.enum, ["New York", "Seoul"]);
});

// F30
test("F30: a submission that is not a gap does not spend a Google Maps cross-check", async () => {
  const { ctx } = setup();
  const ev = new Evidence(new BudgetedQloo(createQloo(), 80, () => {}), { categories: categoriesFor("all"), google: {} as never });
  let google = 0;
  ev.googleGap = async () => {
    google++;
    throw new Error("no google in tests");
  };
  // Read the comparison, then submit a category that is not a gap for the pair.
  const probe = fakeClaude([[pairWalk[2][0]], []]);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client: probe.client });
  const rows = (JSON.parse(allResults(probe.bodies)[0].content!) as { per_category: { category: string; is_gap: boolean }[] }).per_category;
  const notGap = rows.find((r) => !r.is_gap)!;
  const { client, bodies } = fakeClaude([[{ ...malaSubmit(0.9), input: { ...malaSubmit(0.9).input, category: notGap.category } }]]);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  assert.match(lastResults(bodies)[0].content ?? "", /^Not a gap/);
  assert.equal(google, 0);
});

// M08
test("M08: resubmitting a gap Google Maps ruled out does not log it as ruled out again", async () => {
  const { ctx, rejected } = setup();
  const ev = new Evidence(new BudgetedQloo(createQloo(), 80, () => {}), { categories: categoriesFor("all"), google: {} as never });
  const contradicts = { home: { count: 12, saturated: false }, twin: { count: 10, saturated: false }, halfKm: 2.2, verdict: "contradicts" };
  ev.googleGap = async () => contradicts as never;
  const peek = ev.peek.bind(ev);
  ev.peek = ((key: string) => (key.startsWith("google:") ? contradicts : peek(key))) as typeof ev.peek;
  const { client, bodies } = fakeClaude([...pairWalk, [malaSubmit(0.9)], [malaSubmit(0.9)]]);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  const subs = allResults(bodies).filter((r) => /^Ruled out/.test(r.content ?? ""));
  assert.equal(subs.length, 2, "both submissions are told why");
  assert.equal(rejected.length, 1, "shown as ruled out once");
});

// F32
test("F32: the rejection reason lists only checks that could still run", () => {
  const card = {
    confidence: 0.5,
    categoryId: "urn:tag:x",
    cityCount: null,
    confidenceMath: { mean: 0.6, measured: 3, doubts: 2, penalty: 0.9 },
    doubts: ["a"],
    scores: [
      { key: "proven", label: "Proven elsewhere", value: 0.5 },
      { key: "audience", label: "Core audience fit", value: null },
      { key: "durability", label: "Durability", value: null },
      { key: "fit", label: "Product fit", value: null },
    ],
  } as unknown as OpportunityCard;
  const live = { qloo: { mode: "live" }, peek: () => null } as never;
  const text = rejectionReason(card, live);
  assert.match(text, /Not checked yet: City-wide supply;/);
  assert.doesNotMatch(text, /Durability|Core audience fit;/);
  const mock = { qloo: { mode: "mock" }, peek: () => undefined } as never;
  assert.match(rejectionReason(card, mock), /Not checked yet: Core audience fit, Durability, City-wide supply;/);
});

// N17
test("N17: when the budget runs out during a compare_supply recount, the paid-for table still comes back", async () => {
  const { ev, ctx } = setup();
  const cats = categoriesFor("all");
  ev.supply = (async (hood: string) => ({ counts: Object.fromEntries(cats.map((c) => [c, hood === "Shin-Okubo" ? 0 : 9])), capped: hood === "Shin-Okubo" })) as never;
  let recounts = 0;
  ev.homeCount = (async () => {
    if (++recounts > 1) throw new BudgetExceededError("Qloo call budget of 40 used up");
    return { count: 1, capped: false };
  }) as never;
  const { client, bodies } = fakeClaude([[pairWalk[2][0]]]);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  const out = JSON.parse(lastResults(bodies)[0].content ?? "{}") as { per_category?: unknown[]; budget_used_up?: string };
  assert.equal(out.per_category?.length, cats.length, "the whole table");
  assert.match(out.budget_used_up ?? "", /budget ran out/);
});

// N13 + F62 + F34
test("N13/F62: LLM_MODE is trimmed and case-insensitive; the modes say when live runs are off", async () => {
  await withEnv({ LLM_MODE: " Claude ", ANTHROPIC_API_KEY: "k", EXPLORE_FORCE_REPLAY: undefined, EXPLORE_LIVE_ENABLED: undefined }, async () => {
    assert.equal(currentModes().llmMode, "claude");
    assert.equal(currentModes().forceReplay, undefined);
  });
  await withEnv({ EXPLORE_FORCE_REPLAY: "1" }, async () => assert.equal(currentModes().forceReplay, true));
});

test("F34/N13: a mistyped ANTHROPIC_MODEL is caught before start, so the start event names the model that runs", async () => {
  await withEnv({ ...claudeEnv, ANTHROPIC_MODEL: "claude-opsu-typo" }, async () => {
    const used: string[] = [];
    const { client } = fakeClaude([...pairWalk, [], []], {
      retrieve: async () => {
        throw new Anthropic.NotFoundError(404, { type: "error" }, "model not found", new Headers());
      },
    });
    const stream = client.beta.messages.stream.bind(client.beta.messages);
    (client.beta.messages as { stream: unknown }).stream = (body: { model: string }, o: unknown) => {
      used.push(body.model);
      return (stream as (b: unknown, o: unknown) => unknown)(body, o);
    };
    const { events } = await runExplore({ client });
    const start = events[0];
    assert.equal(start.type === "start" && start.model, DEFAULT_MODEL);
    assert.ok(used.length > 0 && used.every((m) => m === DEFAULT_MODEL));
  });
  await withEnv({ ...claudeEnv, ANTHROPIC_MODEL: "  claude-haiku-4-5  " }, async () => {
    const { client } = fakeClaude([...pairWalk, [], []]);
    const { events } = await runExplore({ client });
    assert.equal(events[0].type === "start" && events[0].model, "claude-haiku-4-5", "trimmed");
  });
});

// Coordinator note (F09 follow-up): Qloo's parameter hint reaches the model, not the log.
test("F09: a Qloo bad_request tool error carries Qloo's (redacted) detail to the model only", async () => {
  const { ev, ctx, steps } = setup();
  ev.citySupply = (async () => {
    const e = new QlooError("bad_request", "Qloo rejected the request");
    e.detail = "filter.tags: unknown tag urn:tag:x";
    throw e;
  }) as never;
  const { client, bodies } = fakeClaude([[{ name: "check_city_supply", input: { category: MALA } }]]);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  assert.match(lastResults(bodies)[0].content ?? "", /Qloo said: filter\.tags: unknown tag/);
  assert.ok(!steps.some((t) => /unknown tag/.test(t)));
});
