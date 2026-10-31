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
import { exploreResponse } from "../src/lib/explore-stream";
import { resetLimits, runningCount } from "../src/lib/limits";
import type { Recording } from "../src/lib/replay";

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

test("a tiny budget ends the run cleanly through the route's stream: an error (or the recording), never a crash", async () => {
  const budget = 3;
  process.env.QLOO_CALL_BUDGET = String(budget);
  const post = () => new Request("http://x/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const ndjson = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
  try {
    // On the mock data, Tokyo needs more than 3 Qloo calls before its first card: the run stops on the budget.
    resetLimits();
    const bare = await ndjson(exploreResponse({ city: "Tokyo", focus: "all" }, post(), { recording: () => null }));
    assert.equal(bare[0].type, "start");
    assert.equal(bare.filter((e) => e.type === "card").length, 0, "no card fits in 3 calls");
    const last = bare.at(-1)!;
    assert.equal(last.type, "error", `run ended with ${JSON.stringify(last)}`);
    assert.match(last.type === "error" ? last.message : "", /budget/);
    assert.ok(bare.filter((e) => e.type === "call").length <= budget, "no more Qloo calls than the budget");
    assert.equal(runningCount(), 0, "the live slot is released");

    // With a recording for the city, the same early failure is replaced by it.
    const tiny: Recording = {
      recordedAt: "2026-10-24T09:00:00.000Z",
      events: [
        { type: "start", city: "Tokyo", focus: "all", qlooMode: "live", llmMode: "claude", budget: 40 },
        { type: "done", callsUsed: 0, budget: 40, cards: 0 },
      ],
    };
    process.env.EXPLORE_REPLAY_SECONDS = "0";
    const replayed = await ndjson(exploreResponse({ city: "Tokyo", focus: "all" }, post(), { recording: () => tiny }));
    const at = replayed.findIndex((e) => e.type === "replay");
    assert.ok(at > 0, "the partial live run, then a replay");
    const reason = replayed[at].type === "replay" ? replayed[at].reason : "";
    assert.match(reason, /budget/);
    assert.ok(!replayed.some((e) => e.type === "error"), "the error is not shown");
    assert.ok(replayed.slice(0, at).filter((e) => e.type === "call").length <= budget);
    assert.deepEqual(replayed.slice(at + 1).map((e) => e.type), ["start", "done"], "the recording plays to its end");
    assert.equal(runningCount(), 0);
  } finally {
    delete process.env.QLOO_CALL_BUDGET;
    delete process.env.EXPLORE_REPLAY_SECONDS;
    resetLimits();
  }
});

// A fake Anthropic client that replays tool calls, so the Claude loop is tested offline.
// The agent passes its live messages array, so `conversation[0]` also holds the results of a
// last turn after which the agent stopped without calling the model again.
function scriptedClaude(turns: { name: string; input: Record<string, unknown> }[][], toolResults: string[] = [], conversation: { role: string; content: unknown }[][] = []) {
  let i = 0;
  const stream = (body: { messages: { role: string; content: unknown }[] }) => {
    conversation[0] = body.messages;
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

const toolResultsIn = (messages: { role: string; content: unknown }[] = []) =>
  messages.flatMap((m) => (m.role === "user" && Array.isArray(m.content) ? (m.content as { type: string; content?: string }[]).filter((b) => b.type === "tool_result").map((b) => String(b.content)) : []));

test("Claude agent loop (scripted, no API key): tool calls become a card with evidence", async () => {
  // Find a real mock gap with the pipeline first, then have "Claude" walk to it.
  const { cards } = checkInvariants(await run("Tokyo"));
  const g = cards[0];
  const logs: QlooCallLog[] = [];
  const qloo = new BudgetedQloo(createQloo(), 40, (l) => logs.push(l));
  const ev = new Evidence(qloo, { categories: categoriesFor("all") });
  const got: OpportunityCard[] = [];
  const ctx: RunContext = { step: () => {}, onCard: (c) => got.push(c), deadline: Date.now() + 60_000, signal: new AbortController().signal };
  const turns = [
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
          doubts: [
            { about: "audience_age", text: "Residents skew older than the fans." },
            { about: "other", text: "Rents are high here." },
          ],
        },
      },
    ],
  ];
  // The same opportunity again: sent back, not shown twice.
  const results: string[] = [];
  const client = scriptedClaude([...turns, [turns[4][0]]], results);
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, g.id);
  assert.match(results.at(-1) ?? "", /^Already submitted this opportunity/);
  assert.ok(got[0].scores.some((s) => s.source === "LLM"), "product fit is labelled as LLM judgment");
  assert.ok(got[0].doubts.includes("Rents are high here."), "a new doubt counts");
  assert.ok(!got[0].doubts.some((d) => /skew older/.test(d)), "a doubt about a measured score is not counted twice");
  const nums = new Set(logs.map((l) => l.n));
  for (const ns of Object.values(got[0].refs)) for (const n of ns) assert.ok(nums.has(n));
});

test("Claude agent: a non-gap submission is rejected back to the model, not shown", async () => {
  // A real pair (one the pipeline found a gap in), compared first, so the rejection is about the counts.
  const g = checkInvariants(await run("Tokyo")).cards[0];
  const compare = { name: "compare_supply", input: { neighbourhood: g.homeLocality, twin_neighbourhood: g.twinLocality, twin_city: g.twinCity } };
  const fresh = () => {
    const ev = new Evidence(new BudgetedQloo(createQloo(), 40, () => {}), { categories: categoriesFor("all") });
    const got: OpportunityCard[] = [];
    const ctx: RunContext = { step: () => {}, onCard: (c) => got.push(c), deadline: Date.now() + 60_000, signal: new AbortController().signal };
    return { ev, got, ctx };
  };

  // Read the comparison once to pick a category that is not a gap for this pair.
  const probe = fresh();
  const seen: string[] = [];
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, probe.ev, probe.ctx, { model: "test", client: scriptedClaude([[compare], []], seen) });
  const rows = (JSON.parse(seen[0]) as { per_category: { category: string; is_gap: boolean }[] }).per_category;
  const notGap = rows.find((r) => !r.is_gap);
  assert.ok(notGap, "the pair has a category that is not a gap");

  const { ev, got, ctx } = fresh();
  const results: string[] = [];
  const submit = { category: notGap.category, neighbourhood: g.homeLocality, twin_neighbourhood: g.twinLocality, twin_city: g.twinCity, why: "", product_fit_score: 1, product_fit_reason: "", doubts: [] };
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client: scriptedClaude([[compare], [{ name: "submit_opportunity", input: submit }], []], results) });
  assert.equal(got.length, 0);
  assert.match(results[1] ?? "", /^Not a gap/, `the model is told why (got ${results[1]})`);
});

test("Claude agent: at most 4 opportunities; a fifth submission is refused", async () => {
  const pipelineCards = checkInvariants(await run("Tokyo")).cards;
  assert.equal(pipelineCards.length, 4, "the mock data holds four real gaps for Tokyo");
  const ev = new Evidence(new BudgetedQloo(createQloo(), 200, () => {}), { categories: categoriesFor("all") });
  const got: OpportunityCard[] = [];
  const ctx: RunContext = { step: () => {}, onCard: (c) => got.push(c), deadline: Date.now() + 120_000, signal: new AbortController().signal };
  const submitOf = (c: OpportunityCard) => ({
    name: "submit_opportunity",
    input: { category: c.categoryId, neighbourhood: c.homeLocality, twin_neighbourhood: c.twinLocality, twin_city: c.twinCity, why: "Test.", product_fit_score: 0.7, product_fit_reason: "Test.", doubts: [] },
  });
  const conversation: { role: string; content: unknown }[][] = [];
  const client = scriptedClaude(
    [
      [{ name: "list_neighbourhoods", input: { city: "Tokyo" } }],
      pipelineCards.flatMap((c) => [
        { name: "find_taste_twins", input: { neighbourhood: c.homeLocality, other_city: c.twinCity } },
        { name: "compare_supply", input: { neighbourhood: c.homeLocality, twin_neighbourhood: c.twinLocality, twin_city: c.twinCity } },
        { name: "check_city_supply", input: { category: c.categoryId } },
        { name: "trend", input: { category: c.categoryId, city: c.twinCity } },
        // A skipped check counts as its worst result, so the script runs every check.
        { name: "audience_profile", input: { category: c.categoryId, neighbourhood: c.homeLocality } },
      ]),
      // Four good submissions and a fifth (a repeat), all in one turn.
      [...pipelineCards.map(submitOf), submitOf(pipelineCards[0])],
      [{ name: "list_neighbourhoods", input: { city: "Tokyo" } }],
    ],
    [],
    conversation,
  );
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  const results = toolResultsIn(conversation[0]);
  assert.equal(got.length, 4, `four cards (results: ${results.slice(-5).join(" | ")})`);
  assert.match(results.at(-1) ?? "", /^Already submitted 4\. Stop now\./);
  assert.equal(conversation[0].filter((m) => m.role === "assistant").length, 3, "the agent stops after the turn that filled the four slots");
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
  const cat = categoriesFor("all").find((c) => c.endsWith("bagel_shop"))!;
  // In the mock data this pair is taste twins (49%) and a gap on paper (6 vs 1), but weak on every other score.
  const submit = {
    name: "submit_opportunity",
    input: { category: cat, neighbourhood: "Shimokitazawa", twin_neighbourhood: "East Village", twin_city: "New York", why: "", product_fit_score: 0.2, product_fit_reason: "", doubts: [] },
  };
  const results: string[] = [];
  const client = scriptedClaude(
    [
      [{ name: "list_neighbourhoods", input: { city: "Tokyo" } }],
      [{ name: "find_taste_twins", input: { neighbourhood: "Shimokitazawa", other_city: "New York" } }],
      [{ name: "compare_supply", input: { neighbourhood: "Shimokitazawa", twin_neighbourhood: "East Village", twin_city: "New York" } }],
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

test("taste-twin gate: a pair that is not a taste twin is rejected whatever its other scores, and never shown", async () => {
  const twinEvents: string[] = [];
  const ev = new Evidence(new BudgetedQloo(createQloo(), 40, () => {}), { categories: categoriesFor("all"), onTwin: (e) => twinEvents.push(e.twin) });
  const got: OpportunityCard[] = [];
  const ruledOut: OpportunityCard[] = [];
  const ctx: RunContext = { step: () => {}, onCard: (c) => got.push(c), onRejected: (c) => ruledOut.push(c), deadline: Date.now() + 60_000, signal: new AbortController().signal };
  const cat = categoriesFor("all").find((c) => c.endsWith("korean_fried_chicken"))!;
  // In the mock data Flushing shares none of Shimokitazawa's tastes (similarity 0), yet 6 vs 0 is a gap on paper.
  const results: string[] = [];
  const client = scriptedClaude(
    [
      [{ name: "find_taste_twins", input: { neighbourhood: "Shimokitazawa", other_city: "New York" } }],
      [{ name: "compare_supply", input: { neighbourhood: "Shimokitazawa", twin_neighbourhood: "Flushing", twin_city: "New York" } }],
      [{ name: "check_city_supply", input: { category: cat } }],
      [{ name: "audience_profile", input: { category: cat, neighbourhood: "Shimokitazawa" } }],
      [{ name: "trend", input: { category: cat, city: "New York" } }],
      [{ name: "submit_opportunity", input: { category: cat, neighbourhood: "Shimokitazawa", twin_neighbourhood: "Flushing", twin_city: "New York", why: "", product_fit_score: 1, product_fit_reason: "", doubts: [] } }],
      [],
    ],
    results,
  );
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  const twins = JSON.parse(results[0]) as { twins: { name: string; not_a_usable_twin?: string }[] };
  assert.match(twins.twins.find((t) => t.name === "Flushing")?.not_a_usable_twin ?? "", /below the 40% minimum/, "the model is told before it compares");
  assert.ok(!twins.twins.find((t) => t.name === "Williamsburg")?.not_a_usable_twin, "a real twin carries no note");
  assert.deepEqual(twinEvents.sort(), ["East Village", "Williamsburg"], "the page is never sent the non-twin, so no map arc or verdict rests on it");
  assert.match((JSON.parse(results[1]) as { not_a_usable_twin?: string }).not_a_usable_twin ?? "", /No gap between these two can be submitted/);
  assert.match(results.at(-1) ?? "", /^Not a usable taste twin: taste similarity 0% is below the 40% minimum/);
  assert.equal(got.length, 0, "not shown as an opportunity");
  assert.equal(ruledOut.length, 0, "not shown as a ruled-out idea either: there was no reliable comparison");
});

test("taste-twin gate: the fixed pipeline skips a twin below the minimum and never scores a gap on it", async () => {
  const events = await run("New York");
  const steps = events.flatMap((e) => (e.type === "step" ? [e.title] : []));
  // East Village's best twin in Seoul (Hongdae, 36%) is below the bar; its Tokyo twin is kept.
  assert.ok(steps.includes("Not comparing East Village with Hongdae: not a reliable taste twin"), steps.join(" / "));
  const { cards } = checkInvariants(events);
  const rejected = events.flatMap((e) => (e.type === "rejected" ? [e.card] : []));
  for (const c of [...cards, ...rejected]) assert.ok((c.twinSimilarity ?? 0) >= 0.4 && !c.twinIssue, `${c.id} rests on a taste twin`);
  const sim = new Map(events.flatMap((e) => (e.type === "twin" ? [[`${e.home}|${e.twin}|${e.twinCity}`, e.similarity] as const] : [])));
  for (const r of events) if (r.type === "rescore") assert.ok((sim.get(`${r.hood}|${r.twin}|${r.twinCity}`) ?? 0) >= 0.4, `${r.id} re-scored on a taste twin`);
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

test("Claude agent: 'nothing found' after one comparison is sent back once to compare at least 3", async () => {
  const qloo = new BudgetedQloo(createQloo(), 40, () => {});
  const ev = new Evidence(qloo, { categories: categoriesFor("all") });
  const steps: string[] = [];
  const ctx: RunContext = { step: (_p, t) => steps.push(t), onCard: () => {}, deadline: Date.now() + 120_000, signal: new AbortController().signal };
  const hoods = (await ev.listNeighbourhoods("Tokyo", 5)).map((h) => (typeof h === "string" ? h : (h as { name: string }).name));
  const twin = (await ev.findTwins(hoods[0], "Tokyo", "New York City"))[0];
  const sent: unknown[] = [];
  const client = scriptedClaude([
    [{ name: "compare_supply", input: { neighbourhood: hoods[0], twin_neighbourhood: twin.name, twin_city: twin.city } }],
    [],
    [],
  ]);
  const stream = (client as { beta: { messages: { stream: (b: { messages: unknown[] }) => unknown } } }).beta.messages.stream;
  (client as { beta: { messages: { stream: unknown } } }).beta.messages.stream = (b: { messages: unknown[] }) => {
    sent.push(b.messages.at(-1));
    return stream(b);
  };
  await runClaudeAgent({ city: "Tokyo", focus: "all" }, ev, ctx, { model: "test", client });
  assert.equal(sent.length, 3, "one extra turn after the push, then it may stop");
  assert.match(JSON.stringify(sent[2]), /at least 3/);
  assert.ok(steps.some((t) => /1 of 3 neighbourhoods compared/.test(t)));
});
