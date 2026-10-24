// End-to-end exploration on mock Qloo data: the fixed pipeline, a scripted Claude
// (no API key needed), and the HTTP route. Checks the guarantees the UI relies on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runClaudeAgent } from "../src/lib/agent/claude-agent";
import { Evidence } from "../src/lib/agent/evidence";
import { explore, type RunContext } from "../src/lib/agent/run";
import type { AgentEvent, OpportunityCard } from "../src/lib/agent/types";
import { BudgetedQloo, createQloo, type QlooCallLog } from "../src/lib/qloo";
import { CITIES } from "../src/lib/cities";
import { categoriesFor } from "../src/lib/agent/categories";

process.env.MOCK_DELAY_MS = "0";
process.env.QLOO_MODE = "mock";
process.env.LLM_MODE = "mock";

async function run(city: string, focus: "all" | "dining" | "nightlife" | "retail" = "all") {
  const events: AgentEvent[] = [];
  await explore({ city, focus }, (e) => events.push(e), { deadline: Date.now() + 60_000, signal: new AbortController().signal });
  return events;
}

// Every number on a card must point at Qloo calls that really happened in this run.
function checkInvariants(events: AgentEvent[]) {
  const start = events[0];
  const done = events.at(-1);
  assert.equal(start.type, "start");
  assert.equal(done?.type, "done", `run ended with ${JSON.stringify(done)}`);
  const calls = events.filter((e): e is Extract<AgentEvent, { type: "call" }> => e.type === "call").map((e) => e.call);
  const nums = new Set(calls.map((c) => c.n));
  assert.equal(nums.size, calls.length, "call numbers are unique");
  const stepIds = new Set(events.filter((e) => e.type === "step").map((e) => (e as { id: string }).id));
  for (const e of events) if (e.type === "call") assert.ok(stepIds.has(e.stepId), `call Q${e.call.n} belongs to a step`);
  const cards = events.filter((e): e is Extract<AgentEvent, { type: "card" }> => e.type === "card").map((e) => e.card);
  for (const card of cards) {
    for (const [ref, ns] of Object.entries(card.refs)) for (const n of ns) assert.ok(nums.has(n), `${card.id} ${ref} cites Q${n}, which exists`);
    assert.ok(card.refs.homeSupply.length && card.refs.twinSupply.length, `${card.id} rests on a supply comparison`);
    assert.ok(card.twinCount >= 4 && card.twinCount >= 3 * Math.max(card.homeCount, 1), `${card.id} is a real gap`);
    assert.ok(card.confidence >= 0 && card.confidence <= 1, `${card.id} confidence in 0..1`);
    for (const s of card.scores) if (s.value !== null) assert.ok(s.value >= 0 && s.value <= 1, `${card.id} ${s.key} in 0..1`);
  }
  if (done?.type === "done") {
    assert.ok(done.callsUsed <= done.budget, "within the Qloo budget");
    assert.equal(done.cards, cards.length);
    assert.ok(cards.length <= 4);
  }
  return { calls, cards };
}

for (const city of CITIES) {
  test(`pipeline on mock data: ${city}`, async () => {
    const { cards } = checkInvariants(await run(city));
    if (city === "Tokyo") assert.ok(cards.length > 0, "Tokyo mock data should produce at least one opportunity");
  });
}

for (const focus of ["dining", "nightlife", "retail"] as const) {
  test(`pipeline keeps to the focus: ${focus}`, async () => {
    const { cards } = checkInvariants(await run("Tokyo", focus));
    const allowed = new Set(categoriesFor(focus));
    for (const c of cards) assert.ok(allowed.has(c.categoryId), `${c.categoryId} is in ${focus}`);
  });
}

test("a tiny budget ends the run cleanly, not with a crash", async () => {
  process.env.QLOO_CALL_BUDGET = "3";
  try {
    const events = await run("Tokyo");
    const last = events.at(-1)!;
    assert.ok(last.type === "done" || last.type === "error");
    assert.ok(events.filter((e) => e.type === "call").length <= 3);
  } catch (e) {
    assert.match(String(e), /budget/);
  } finally {
    delete process.env.QLOO_CALL_BUDGET;
  }
});

// A fake Anthropic client that replays tool calls, so the Claude loop is tested offline.
function scriptedClaude(turns: { name: string; input: Record<string, unknown> }[][], toolResults: string[] = []) {
  let i = 0;
  const stream = (body: { messages: { role: string; content: unknown }[] }) => {
    // Collect the tool results the agent sent back on this turn.
    const last = body.messages.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) {
      for (const b of last.content as { type: string; content?: string }[]) if (b.type === "tool_result") toolResults.push(String(b.content));
    }
    return { finalMessage };
  };
  const finalMessage = async () => {
    const calls = turns[i++] ?? [];
    return {
      stop_reason: calls.length ? "tool_use" : "end_turn",
      content: calls.length
        ? calls.map((c, j) => ({ type: "tool_use", id: `t${i}_${j}`, name: c.name, input: { reason: "test", ...c.input } }))
        : [{ type: "text", text: "Done." }],
    };
  };
  return { beta: { messages: { stream } } } as never;
}

test("Claude agent loop (scripted, no API key): tool calls become a card with evidence", async () => {
  // Find a real mock gap with the pipeline first, then have "Claude" walk to it.
  const { cards } = checkInvariants(await run("Tokyo"));
  const g = cards[0];
  const logs: QlooCallLog[] = [];
  const qloo = new BudgetedQloo(createQloo(), 40, (l) => logs.push(l));
  const ev = new Evidence(qloo, { categories: categoriesFor("all") });
  const got: OpportunityCard[] = [];
  const ctx: RunContext = { step: () => {}, onCard: (c) => got.push(c), deadline: Date.now() + 60_000, signal: new AbortController().signal };
  const client = scriptedClaude([
    [{ name: "list_neighbourhoods", input: { city: "tokyo" } }],
    [{ name: "find_taste_twins", input: { neighbourhood: g.homeLocality.toLowerCase(), other_city: g.twinCity } }],
    [{ name: "compare_supply", input: { neighbourhood: g.homeLocality, twin_neighbourhood: g.twinLocality, twin_city: g.twinCity } }],
    [
      { name: "check_city_supply", input: { category: g.categoryId } },
      { name: "trend", input: { category: g.categoryId, city: g.twinCity } },
    ],
    [
      {
        name: "submit_opportunity",
        input: {
          category: g.categoryId,
          neighbourhood: g.homeLocality,
          twin_neighbourhood: g.twinLocality,
          twin_city: g.twinCity,
          why: "Test.",
          product_fit_score: 0.7,
          product_fit_reason: "Test.",
          doubts: [],
        },
      },
    ],
  ]);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, g.id);
  assert.ok(got[0].scores.some((s) => s.source === "LLM"), "product fit is labelled as LLM judgment");
  const nums = new Set(logs.map((l) => l.n));
  for (const ns of Object.values(got[0].refs)) for (const n of ns) assert.ok(nums.has(n));
});

test("Claude agent: a non-gap submission is rejected back to the model, not shown", async () => {
  const qloo = new BudgetedQloo(createQloo(), 40, () => {});
  const ev = new Evidence(qloo, { categories: categoriesFor("all") });
  const got: OpportunityCard[] = [];
  const ctx: RunContext = { step: () => {}, onCard: (c) => got.push(c), deadline: Date.now() + 60_000, signal: new AbortController().signal };
  const cat = categoriesFor("all")[0];
  const client = scriptedClaude([
    [{ name: "submit_opportunity", input: { category: cat, neighbourhood: "Nowhere", twin_neighbourhood: "Elsewhere", twin_city: "Seoul", why: "", product_fit_score: 1, product_fit_reason: "", doubts: [] } }],
  ]);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  assert.equal(got.length, 0);
});

test("HTTP route: streams NDJSON for a valid request and 400s a bad one", async () => {
  const { POST, GET } = await import("../src/app/api/explore/route");
  const bad = await POST(new Request("http://x/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: '{"city":"Paris"}' }));
  assert.equal(bad.status, 400);
  const res = await POST(new Request("http://x/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: '{"city":"Tokyo"}' }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /ndjson/);
  const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  checkInvariants(events);
  const info = await (await GET()).json();
  assert.deepEqual(info.cities, CITIES);
  assert.deepEqual(Object.keys(info.modes).sort(), ["budget", "llmMode", "qlooMode"], "GET exposes mode names only, never keys");
});

test("Claude agent: a weak opportunity is rejected with reasons, and resubmitting it unchanged doesn't help", async () => {
  const qloo = new BudgetedQloo(createQloo(), 40, () => {});
  const ev = new Evidence(qloo, { categories: categoriesFor("all") });
  const got: OpportunityCard[] = [];
  const ctx: RunContext = { step: () => {}, onCard: (c) => got.push(c), deadline: Date.now() + 60_000, signal: new AbortController().signal };
  const cat = categoriesFor("all").find((c) => c.endsWith("korean_fried_chicken"))!;
  // In the mock data this pair is a gap on paper (6 vs 0) but weak on every other score.
  const submit = {
    name: "submit_opportunity",
    input: { category: cat, neighbourhood: "Shimokitazawa", twin_neighbourhood: "Flushing", twin_city: "New York", why: "", product_fit_score: 0.2, product_fit_reason: "", doubts: [] },
  };
  const results: string[] = [];
  const client = scriptedClaude(
    [
      [{ name: "list_neighbourhoods", input: { city: "Tokyo" } }],
      [{ name: "find_taste_twins", input: { neighbourhood: "Shimokitazawa", other_city: "New York" } }],
      [{ name: "compare_supply", input: { neighbourhood: "Shimokitazawa", twin_neighbourhood: "Flushing", twin_city: "New York" } }],
      [submit],
      [submit],
      [{ name: "trend", input: { category: cat, city: "New York" } }],
      [submit],
    ],
    results,
  );
  const ruledOut: OpportunityCard[] = [];
  ctx.onRejected = (c) => ruledOut.push(c);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  assert.equal(got.length, 0, "nothing below the bar reaches the screen");
  assert.equal(ruledOut.length, 2, "each evaluation with new evidence is shown as ruled out, the unchanged resubmission is not");
  const subs = results.filter((r) => /ejected/.test(r));
  assert.match(subs[0], /^Rejected: confidence \d+% is below 55%.*Not checked yet/);
  assert.match(subs[1], /^Already rejected/);
  assert.match(subs[2], /^Rejected:/, "new evidence earns a fresh evaluation");
});

test("the agent's own checks: gaps are re-scored as checks come in, weak ones are ruled out with a score trail", async () => {
  const events = await run("Tokyo");
  const { cards } = checkInvariants(events);
  const rescores = events.filter((e): e is Extract<AgentEvent, { type: "rescore" }> => e.type === "rescore");
  const rejected = events.filter((e): e is Extract<AgentEvent, { type: "rejected" }> => e.type === "rejected").map((e) => e.card);
  // Mock data plants the tapioca case: bubble tea in Shin-Okubo is a gap on paper, but common across Tokyo and fading.
  const tea = rejected.find((c) => c.homeLocality === "Shin-Okubo" && c.category === "Bubble tea");
  assert.ok(tea, "the fading bubble tea gap is ruled out");
  assert.ok(tea.confidence < 0.55);
  assert.ok(rescores.some((r) => r.id === tea.id && r.to < r.from), "the log shows its score dropping before it is ruled out");
  for (const c of rejected) assert.ok(!cards.some((k) => k.id === c.id), `${c.id} is not also shown as an opportunity`);
  assert.equal(cards.length, 4, "a ruled-out gap does not use up one of the four slots");
  for (const c of [...cards, ...rejected]) {
    const trail = c.trail ?? [];
    assert.match(trail[0]?.label ?? "", /^Gap found/, `${c.id} trail starts at the supply comparison`);
    assert.equal(trail.at(-1)?.confidence, Math.round(c.confidence * 100) / 100, `${c.id} trail ends at the card's confidence`);
    const nums = new Set(events.flatMap((e) => (e.type === "call" ? [e.call.n] : [])));
    for (const t of trail) for (const n of t.calls) assert.ok(nums.has(n), `${c.id} trail step cites Q${n}, which exists`);
  }
});
