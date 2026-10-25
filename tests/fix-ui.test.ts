// Page logic fixed after the 2026-10-24 review: the run reducer, what the page derives from it,
// and the text it shows. Offline: recorded runs and hand-made events, rendered with react-dom/server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentLog, NowTicker } from "../src/components/explorer/AgentLog";
import { emptyStats, emptySummary, gapScan, unfinished } from "../src/components/explorer/derive";
import { EmptyResult } from "../src/components/explorer/EmptyResult";
import { callLine, errorText, focusName, isFading, missingText, plural, requestLine } from "../src/components/explorer/format";
import { OpportunityDetail } from "../src/components/explorer/OpportunityDetail";
import { OpportunityTray } from "../src/components/explorer/OpportunityTray";
import { QueryBar } from "../src/components/explorer/QueryBar";
import { ReplayBanner } from "../src/components/explorer/ReplayBanner";
import { RouteMap } from "../src/components/explorer/RouteMap";
import { checking, StoryCaption } from "../src/components/explorer/StoryCaption";
import { arcs } from "../src/components/explorer/derive";
import { initialState, reducer, type RunState } from "../src/components/explorer/useExploreRun";
import { hasExample, HowItWorks } from "../src/components/HowItWorks";
import type { AgentEvent, OpportunityCard } from "../src/lib/agent/types";
import type { QlooCallLog } from "../src/lib/qloo/types";
import newYork from "../src/data/replays/new-york.json";
import tokyo from "../src/data/replays/tokyo.json";

const CITIES = ["Tokyo", "Seoul", "New York"];
const noop = () => {};
const text = (el: ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const meta = { qlooMode: "mock", llmMode: "none", budget: 40 } as const;
function play(events: AgentEvent[], city = "Tokyo", focus: RunState["focus"] = "all", s0?: RunState) {
  let s = s0 ?? reducer(initialState(city, { ...meta }), { type: "reset", city, focus });
  for (const e of events) s = reducer(s, { type: "event", event: e });
  return s;
}
const recorded = (r: { events: unknown[] }) => r.events as AgentEvent[];
const start = (focus: RunState["focus"] = "all"): AgentEvent => ({ type: "start", city: "Tokyo", focus, qlooMode: "mock", llmMode: "none", budget: 40 });

// A recorded live card, with whatever the test needs changed.
const BASE = (tokyo.events as AgentEvent[]).find((e): e is Extract<AgentEvent, { type: "card" }> => e.type === "card")!.card;
function card(over: Partial<OpportunityCard> = {}): OpportunityCard {
  return { ...structuredClone(BASE), ...over };
}

function call(n: number, over: Partial<QlooCallLog> = {}): QlooCallLog {
  return { n, endpoint: "/v2/insights", params: { "filter.type": "urn:entity:place" }, resultCount: 1, summary: "1 place", mock: true, ...over };
}

function caption(s: RunState) {
  const ruled = s.rejected.find((r) => r.card.id === s.selectedId) ?? null;
  const selected = s.cards.find((c) => c.id === s.selectedId) ?? ruled?.card ?? null;
  return text(h(StoryCaption, { state: s, selected, ruledOut: ruled?.reason ?? null, rank: null, total: s.cards.length, onRetry: noop }));
}

// N22
test("a ruled-out idea picked in a run with no cards can be put away again, back to the summary", () => {
  let s = play(recorded(newYork), "New York");
  assert.equal(s.status, "done");
  assert.equal(s.cards.length, 0);
  assert.ok(s.rejected.length > 0);
  assert.equal(s.selectedId, null, "the summary shows first");
  const id = s.rejected[0].card.id;
  s = reducer(s, { type: "select", id });
  assert.equal(s.selectedId, id);
  assert.equal(s.pinned, true);
  s = reducer(s, { type: "select", id });
  assert.equal(s.selectedId, null, "picking it again un-picks it");
  assert.equal(s.pinned, false);
  s = reducer(s, { type: "select", id });
  s = reducer(s, { type: "select", id: null });
  assert.equal(s.selectedId, null, "Back to summary does the same");
});

test("a ruled-out idea picked during the run does not hide the strongest card at the end", () => {
  const out = card({ id: "out", confidence: 0.5 });
  const a = card({ id: "a", confidence: 0.6 });
  const b = card({ id: "b", confidence: 0.8 });
  let s = play([start(), { type: "rejected", card: out, reason: "Too weak" }]);
  s = reducer(s, { type: "select", id: "out" });
  s = play([{ type: "card", card: a }, { type: "card", card: b }], "Tokyo", "all", s);
  assert.equal(s.selectedId, "out", "while running, the visitor's pick stays");
  s = play([{ type: "done", callsUsed: 10, budget: 40, cards: 2 }], "Tokyo", "all", s);
  assert.equal(s.selectedId, "b");
  assert.equal(s.pinned, false);

  // A real card the visitor picked stays picked.
  let t = play([start(), { type: "card", card: a }, { type: "card", card: b }]);
  t = reducer(t, { type: "select", id: "a" });
  t = play([{ type: "done", callsUsed: 10, budget: 40, cards: 2 }], "Tokyo", "all", t);
  assert.equal(t.selectedId, "a");
  // Picking the selected card again lets the page choose: the strongest.
  t = reducer(t, { type: "select", id: "a" });
  assert.equal(t.selectedId, "b");
});

// M-5 (N23 + M10)
test("a run that stopped early, or compared nothing, is not called a real answer", () => {
  const twin: AgentEvent = { type: "twin", home: "Shibuya", homeCity: "Tokyo", twin: "Hongdae", twinCity: "Seoul", similarity: 0.5, rank: 1, tastes: [], calls: [1] };
  const supply = (hood: string, city: string, counts: Record<string, number>, calls: number[]): AgentEvent => ({ type: "supply", hood, city, counts, calls });
  const events: AgentEvent[] = [
    start(),
    twin,
    supply("Shibuya", "Tokyo", { "Bubble tea": 1 }, [2]),
    supply("Hongdae", "Seoul", { "Bubble tea": 12 }, [3]),
    { type: "done", callsUsed: 18, budget: 18, cards: 0, stopped: { reason: "budget", unscored: 3 } },
  ];
  const s = play(events);
  const sum = emptySummary(s);
  assert.ok(unfinished(sum));
  const cap = caption(s);
  assert.match(cap, /Stopped early/);
  assert.match(cap, /before 3 gaps could be checked/);
  assert.doesNotMatch(cap, /real answer/);
  assert.match(cap, /Try again/, "a retry is offered");
  const empty = text(h(EmptyResult, { state: s, cities: CITIES, onTry: noop, onChip: noop }));
  assert.doesNotMatch(empty, /about as much|valid answer/);
  assert.match(empty, /not an answer yet/);
  assert.match(empty, /Try Seoul/, "the try-another chips stay");
  const log = text(h(AgentLog, { state: s, onFocusDone: noop }));
  assert.match(log, /Stopped early/);

  // Twins found, but no pair compared: nothing to answer with.
  const none = play([start(), twin, { type: "done", callsUsed: 3, budget: 40, cards: 0 }]);
  assert.equal(emptyStats(none).pairs, 0);
  const cap2 = caption(none);
  assert.doesNotMatch(cap2, /real answer/);
  assert.match(cap2, /before it could compare any taste-twin pair/);
  const empty2 = text(h(EmptyResult, { state: none, cities: CITIES, onTry: noop, onChip: noop }));
  assert.doesNotMatch(empty2, /about as much/);
  assert.match(empty2, /No answer yet for Tokyo/);

  // A finished run that compared pairs and found nothing still says so.
  const real = play([start(), twin, supply("Shibuya", "Tokyo", { "Bubble tea": 9 }, [2]), supply("Hongdae", "Seoul", { "Bubble tea": 10 }, [3]), { type: "done", callsUsed: 3, budget: 40, cards: 0 }]);
  assert.match(caption(real), /compared 1 taste-twin pair, but none/);
  assert.match(text(h(EmptyResult, { state: real, cities: CITIES, onTry: noop, onChip: noop })), /about as much/);
});

// F17
test("the call counter shows charged calls, and the header and the finished line agree", () => {
  let s = play([start(), { type: "step", id: "s1", phase: "profile", title: "Profile" }]);
  s = play([{ type: "call", stepId: "s1", call: call(1, { used: 2 }) }, { type: "call", stepId: "s1", call: call(2, { used: 3 }) }, { type: "call", stepId: "s1", call: call(3, { cached: true, used: 3 }) }], "Tokyo", "all", s);
  assert.equal(s.callsUsed, 3, "retries count, a cached answer does not");
  // Without used, the highest call number stands in.
  assert.equal(play([start(), { type: "call", stepId: "", call: call(4) }]).callsUsed, 4);
  s = play([{ type: "done", callsUsed: 42, budget: 40, cards: 0 }], "Tokyo", "all", s);
  assert.equal(s.callsUsed, 42);
  const log = text(h(AgentLog, { state: s, onFocusDone: noop }));
  assert.match(log, /42 of 40 Qloo calls/);
  assert.match(log, /from 42 of 40 Qloo calls/);
  assert.doesNotMatch(log, /\b3 of 40\b/);
});

// F56
test("calls made before any step go under one setup step", () => {
  const s = play([start(), { type: "call", stepId: "", call: call(1) }, { type: "call", stepId: "", call: call(2) }]);
  assert.equal(s.steps.length, 1);
  assert.equal(s.steps[0].id, "setup");
  assert.equal(s.steps[0].calls.length, 2);
});

// F37, F38, F39
test("the gap scan counts compared pairs, prefers exact recounts, marks capped counts, and the summary matches its rows", () => {
  const twin = (home: string, t: string): AgentEvent => ({ type: "twin", home, homeCity: "Tokyo", twin: t, twinCity: "Seoul", similarity: 0.5, rank: 1, tastes: [], calls: [1] });
  const events: AgentEvent[] = [
    start(),
    twin("Shibuya", "Hongdae"),
    twin("Shibuya", "Gangnam"), // no supply for Gangnam: found, never compared
    twin("Ginza", "Myeongdong"),
    { type: "supply", hood: "Shibuya", city: "Tokyo", counts: { Bakery: 2, Bar: 1 }, calls: [2], capped: true },
    { type: "supply", hood: "Hongdae", city: "Seoul", counts: { Bakery: 12, Bar: 9 }, calls: [3] },
    // The capped shared page said 2 bakeries; the recount says 30.
    { type: "supply", hood: "Shibuya", city: "Tokyo", counts: { Bakery: 2, Bar: 1 }, calls: [4], capped: true, exact: { Bakery: 30 } },
    { type: "supply", hood: "Ginza", city: "Tokyo", counts: { Cafe: 1 }, calls: [5] },
    { type: "supply", hood: "Myeongdong", city: "Seoul", counts: { Cafe: 9 }, calls: [6] },
    { type: "done", callsUsed: 6, budget: 40, cards: 0 },
  ];
  const s = play(events);
  assert.equal(s.twins.length, 3);
  assert.equal(emptyStats(s).pairs, 2, "only pairs with supply on both sides count");
  assert.deepEqual(s.supply["Shibuya|Tokyo"].calls, [2, 4], "the recount's call is kept with the first");
  const rows = gapScan(s, null);
  const bakery = rows.find((r) => r.category === "Bakery")!;
  assert.equal(bakery.here, 30);
  assert.equal(bakery.hereCapped, false);
  assert.equal(bakery.verdict, "supplied");
  const bar = rows.find((r) => r.category === "Bar")!;
  assert.equal(bar.hereCapped, true, "no recount: the capped sample is a lower bound");
  assert.equal(bar.verdict, "unclear", "a capped home count cannot settle a gap");
  const cafe = rows.find((r) => r.category === "Cafe")!;
  assert.equal(cafe.verdict, "notSubmitted");
  const sum = emptySummary(s);
  assert.equal(sum.notSubmitted, 1);
  assert.equal(sum.unclear, 1);
  const empty = text(h(EmptyResult, { state: s, cities: CITIES, onTry: noop, onChip: noop }));
  assert.match(empty, /compared 2 taste-twin pairs/);
  assert.match(empty, /1 gap met the gap rule, but the agent did not submit it/);
  assert.doesNotMatch(empty, /about as much/, "rows that meet the rule are not called 'about as much'");
  assert.match(empty, /1\+ Shibuya/, "a capped count shows +");
  assert.match(empty, /Gap, not submitted/);
  assert.doesNotMatch(caption(s), /none of them supports/);
});

test("the New York recording's summary agrees with its gap table", () => {
  const s = play(recorded(newYork), "New York");
  const sum = emptySummary(s);
  const empty = text(h(EmptyResult, { state: s, cities: CITIES, onTry: noop, onChip: noop }));
  const tableNotSubmitted = gapScan(s, null).filter((r) => r.verdict === "notSubmitted").length;
  assert.equal(sum.notSubmitted, tableNotSubmitted);
  if (tableNotSubmitted) assert.match(empty, /met the gap rule, but the agent did not submit/);
  assert.ok(sum.pairs <= s.twins.length);
  assert.match(empty, new RegExp(`compared ${sum.pairs} taste-twin pair`));
});

// F40
test("Fading uses the same rule as the falling-interest doubt", () => {
  const withDurability = (v: number) => card({ scores: BASE.scores.map((s) => (s.key === "durability" ? { ...s, value: v, source: "Qloo" as const } : s)) });
  assert.equal(isFading(withDurability(0.32)), false, "a -18% trend is no doubt, so not fading");
  assert.equal(isFading(withDurability(0.29)), true);
  assert.equal(isFading(card({ scores: BASE.scores.map((s) => (s.key === "durability" ? { ...s, value: null } : s)) })), false);
});

// F36, F42, F46, F47, F48, F49, F50, M09
test("the card detail uses the scoring rules and says what it measured", () => {
  const detail = (c: OpportunityCard, llmMode = "none") => text(h(OpportunityDetail, { card: c, llmMode, rank: null }));
  const mark = (html: string) => /\((passes|warning|for information|not checked)\) Rest of Tokyo/.exec(html)?.[1];
  // F36: 25 across the city, 8 here: crowded, not "local only" (25 <= 3*8+5), so no warning.
  assert.equal(mark(detail(card({ cityCount: 25, homeCount: 8 }))), "for information");
  assert.equal(mark(detail(card({ cityCount: 15, homeCount: 2 }))), "warning", "15 > 3*2+5: may be local only");
  assert.equal(mark(detail(card({ cityCount: 10, homeCount: 3 }))), "passes");

  const d = detail(card());
  // F42: the average with one decimal, and ≈ since the parts are rounded.
  assert.match(d, /Average of \d of 6 scores \(\d+\.\d\) × doubt penalty [\d.]+ \(\d+ doubts?\) ≈ \d+%/);
  // F49: live cards call the bridge the shared-taste score.
  assert.match(d, /shared-taste score/);
  assert.doesNotMatch(d, /Measured as taste affinity/);
  // F47: residents only when the audience basis is residents.
  assert.match(d, /age match, fans vs residents/);
  assert.doesNotMatch(detail(card({ audienceBasis: "fans of Minato's top tastes on Qloo" })), /age match, fans vs residents/);

  // F46: fetched but no fan data is not "not fetched".
  const noFans = card({ scores: BASE.scores.map((s) => (s.key === "audience" ? { ...s, value: null, source: "pending" as const, note: "Qloo has no age data for this category's fans" } : s)) });
  const nf = detail(noFans);
  assert.match(nf, /no Qloo fan data for this category/);
  assert.match(nf, /No fan data/);
  assert.doesNotMatch(nf, /audience overlap not fetched/);
  // Duplicate doubts render as two rows (unique keys).
  const twice = detail(card({ doubts: ["Same doubt.", "Same doubt."] }));
  assert.equal(twice.split("Same doubt.").length - 1, 2);

  // F48: capped counts carry "+" or "up to".
  const capped = detail(card({ twinCount: 50, homeCount: 5, capped: { home: true, twin: false, city: false } }));
  assert.match(capped, /up to 45 missing/);
  assert.match(capped, /up to .*places missing in Minato/);
  assert.equal(missingText(card({ twinCount: 50, homeCount: 5, capped: { home: false, twin: true, city: false } })), "45+");
  assert.match(detail(card({ twinCount: 50, capped: { home: false, twin: true, city: false } })), /50\+ places in Tribeca/);
  const tray = text(h(OpportunityTray, { cards: [card({ homeCount: 5, capped: { home: true, twin: true, city: false } })], rejected: [], selectedId: null, ranked: false, running: false, onSelect: noop }));
  assert.match(tray, /18\+ vs 5\+/);

  // F50: the Google rule mentions the inconclusive cases.
  const g = detail(card({ google: { home: 2, twin: 3, homeSaturated: false, twinSaturated: false, halfKm: 1, verdict: "inconclusive" } }));
  assert.match(g, /inconclusive and rules nothing out/);

  // M09: who wrote the card, from the card when it says.
  assert.match(detail(card({ author: "claude" }), "none"), /Written by Claude/);
  assert.match(detail(card({ author: "pipeline" }), "claude"), /Template text/);
  assert.match(detail(card(), "claude"), /Written by Claude/, "older recordings fall back to the run's mode");
});

// F57
test("error text names the right culprit and passes server messages through", () => {
  assert.doesNotMatch(errorText("HTTP 429", 40), /Qloo/);
  assert.match(errorText("HTTP 429", 40), /Too many explorations/);
  assert.match(errorText("Qloo /v2/insights failed: 429 rate limited", 40), /Qloo is rate-limiting/);
  const limiter = "Several explorations are already running. Please try again in a minute.";
  assert.equal(errorText(limiter, 40), limiter, "the server's own words, without a prefix");
  const long = errorText("x".repeat(300), 40);
  assert.ok(long.endsWith("…") && long.length <= 160);
  assert.match(errorText("HTTP 500", 40), /HTTP 500/);
  assert.match(errorText("Qloo call budget of 40 used up", 40), /Used all 40/);
});

// F58
test("a recording made for another focus says so, and Retry keeps the visitor's focus", () => {
  let s = reducer(initialState("Tokyo", { ...meta }), { type: "reset", city: "Tokyo", focus: "dining" });
  s = play([{ type: "replay", recordedAt: "2026-10-24T09:00:00Z", reason: "Live runs are busy" }, start("all")], "Tokyo", "dining", s);
  assert.equal(s.focus, "all");
  assert.equal(s.askedFocus, "dining", "the question asked is kept for Retry");
  const banner = text(h(ReplayBanner, { replay: s.replay!, focus: s.focus, askedFocus: s.askedFocus }));
  assert.match(banner, /recorded for all categories, not dining/);
  assert.doesNotMatch(text(h(ReplayBanner, { replay: s.replay!, focus: "all", askedFocus: "all" })), /recorded for/);
  assert.match(caption(s), /recorded for all categories, not dining/);
});

// F59, N28
test("the caption leaves out the rank when there is none, and names the final step in words", () => {
  const c = card();
  let s = play([start(), { type: "card", card: c }, { type: "error", message: "Qloo call budget of 40 used up" }]);
  s = reducer(s, { type: "select", id: c.id });
  const cap = text(h(StoryCaption, { state: s, selected: c, ruledOut: null, rank: null, total: 3, onRetry: noop }));
  assert.doesNotMatch(cap, /opportunity 1 of/);
  assert.match(text(h(StoryCaption, { state: s, selected: c, ruledOut: null, rank: 2, total: 3, onRetry: noop })), /opportunity 2 of 3/);
  assert.equal(checking("Final score, with product fit 50%, 2 doubts of its own"), "product fit and its own doubts");
  assert.equal(checking("Checked the trend: -50% over the year"), "checking the trend (-50% over the year)");
});

// M04
test("a call that searches around a point says where", () => {
  const c = call(7, { params: { "filter.type": "urn:entity:place", "filter.location": "POINT(139.7 35.6)", _where: "Shibuya-ku, Tokyo" }, where: "Shibuya-ku, Tokyo" });
  assert.match(callLine(c), /^places in Shibuya-ku, Tokyo/);
  assert.doesNotMatch(requestLine(c), /_where/, "display-only params are not part of the request");
  assert.match(callLine(call(8, { params: { "filter.type": "urn:entity:place", "filter.location.query": "Ginza" } })), /in Ginza/);
});

// M05
test("re-score and ruled-out rows name the twin and keep their Q numbers", () => {
  const s = play([
    start(),
    { type: "rescore", id: "x", category: "Bubble tea", hood: "Mapo District", twin: "Shibuya", twinCity: "Tokyo", from: 0.71, to: 0.68, reason: "Checked the city", calls: [12, 14] },
    { type: "rejected", card: card(), reason: "Too weak" },
  ]);
  const rescore = s.steps.find((x) => x.move)!;
  assert.match(rescore.title, /Bubble tea in Mapo District vs Shibuya \(Tokyo\): 71% to 68%/);
  assert.deepEqual(rescore.refs, [12, 14]);
  assert.match(s.steps.find((x) => x.ruledOut)!.title, /in Minato vs Tribeca \(New York\)/);
  const log = renderToStaticMarkup(h(AgentLog, { state: s, onFocusDone: noop, onChip: noop }));
  assert.match(log, /Show Qloo call 12 in the agent log/);
});

// N26, N27, N29, N31, F62 (the forced-replay line)
test("controls keep focus while busy, the log toggle is labelled, counts are pluralised", () => {
  const busy = play([start()]);
  const bar = renderToStaticMarkup(h(QueryBar, { state: busy, cities: CITIES, onCity: noop, onFocus: noop, onRun: noop }));
  const run = /<button type="button" aria-disabled="true"[^>]*>[^]*?Exploring/.exec(bar);
  assert.ok(run, "the run button is aria-disabled");
  assert.doesNotMatch(run![0], /\sdisabled=""/);
  assert.doesNotMatch(bar.replace(/<select[^>]*>/, ""), /\sdisabled=""/, "only the city picker uses disabled");
  assert.doesNotMatch(renderToStaticMarkup(h(QueryBar, { state: busy, cities: CITIES, onCity: noop, onFocus: noop, onRun: noop, hasExample: false })), /#example/);
  const forced = reducer(initialState("Tokyo", { ...meta, forceReplay: true }), { type: "reset", city: "Tokyo", focus: "all" });
  assert.match(text(h(QueryBar, { state: forced, cities: CITIES, onCity: noop, onFocus: noop, onRun: noop })), /Live runs are off right now/);
  assert.equal(play([start()], "Tokyo", "all", forced).meta.forceReplay, true, "a run's start keeps it");

  const one = play([start(), { type: "step", id: "s1", phase: "profile", title: "Profile" }, { type: "call", stepId: "s1", call: call(1) }]);
  const ticker = renderToStaticMarkup(h(NowTicker, { state: one, onToggle: noop }));
  assert.match(ticker, /aria-expanded="false"/);
  assert.match(ticker, /aria-controls="agent-log"/);
  assert.match(text(h(NowTicker, { state: one, onToggle: noop })), /Show full log \(1 step, 1 call\)/);
  assert.match(renderToStaticMarkup(h(AgentLog, { state: one, onFocusDone: noop })), /id="agent-log"/);
  assert.equal(plural(1, "opportunity", "opportunities"), "1 opportunity");
  assert.equal(focusName("all"), "all categories");

  assert.equal(hasExample(), true);
  assert.match(text(h(HowItWorks, { modes: { qlooMode: "mock", llmMode: "none", budget: 40 } })), /Example from a recorded run in \w+ \(all categories/);
});

// N29, N30, F49 on the map
test("the map highlights the pair behind a picked ruled-out idea and names the live twin score", () => {
  const out = card();
  let s = play([start(), { type: "rejected", card: out, reason: "Too weak" }, { type: "done", callsUsed: 3, budget: 40, cards: 0 }]);
  s = reducer(s, { type: "select", id: out.id });
  const key = `${out.homeLocality}|${out.homeCity}|${out.twinLocality}|${out.twinCity}`;
  const map = (selectedKey: string | null) =>
    renderToStaticMarkup(h(RouteMap, { cities: CITIES, home: "Tokyo", status: s.status, arcs: arcs(s), selectedId: s.selectedId, revealId: null, onSelect: noop, selectedKey, sharedTaste: true }));
  assert.match(map(key), /stroke-doubt/, "the pair gets a halo");
  assert.doesNotMatch(map(null), /stroke-doubt/);
  assert.match(map(key), /1 taste twin found/);
  assert.match(map(key), /shared-taste score/);
  assert.doesNotMatch(map(key), /taste affinity/);
});
