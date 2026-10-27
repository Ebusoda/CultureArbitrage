// Fixes from testing the live site (2026-10-27): a firewall 429 must not crash the page, the
// search box and the matching read typed text the way a visitor means it, and a business check
// only calls a city "well supplied" when the comparisons show it. Offline: mock Qloo, fake clients.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CATALOG, catalogEntry, matchCatalog, normalizeQuery, queryWords, searchCatalog, singular } from "../src/lib/agent/catalog";
import { cleanQuery, clipQuery, MAX_QUERY_CHARS, parseExploreBody } from "../src/lib/agent/request";
import type { StepFn } from "../src/lib/agent/run";
import { resolveTarget, TargetError } from "../src/lib/agent/target";
import type { AgentEvent, ExploreRequest } from "../src/lib/agent/types";
import { BudgetedQloo, createQloo, type QlooCallLog, type QlooClient, type QlooParams } from "../src/lib/qloo";
import { pickerOptions } from "../src/components/explorer/CategoryPicker";
import { emptySummary, wellSupplied } from "../src/components/explorer/derive";
import { EmptyResult } from "../src/components/explorer/EmptyResult";
import { errorText } from "../src/components/explorer/format";
import { StoryCaption } from "../src/components/explorer/StoryCaption";
import { AgentLog } from "../src/components/explorer/AgentLog";
import { failMessage, initialState, reducer, type RunState } from "../src/components/explorer/useExploreRun";

process.env.MOCK_DELAY_MS = "0";
process.env.QLOO_MODE = "mock";
process.env.LLM_MODE = "mock";

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

const text = (el: ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const meta = { qlooMode: "live", llmMode: "none", budget: 40 } as const;
const noStep: StepFn = () => {};
const req = (r: Partial<ExploreRequest>): ExploreRequest => ({ city: "Tokyo", focus: "all", ...r });

// A live-mode client that answers tag search and place counts from fixed data.
function fakeLive(tags: { id: string; name: string }[], counts: Record<string, number> = {}): QlooClient {
  let attempts = 0;
  return {
    mode: "live",
    get attempts() {
      return attempts;
    },
    async insights(p: QlooParams) {
      attempts++;
      const n = counts[String(p["filter.location.query"])] ?? 50;
      return { results: { entities: Array.from({ length: n }, (_, i) => ({ entity_id: `e${i}`, name: `Place ${i}` })) } };
    },
    async trending() {
      attempts++;
      return { results: {} };
    },
    async tags() {
      attempts++;
      return { results: { tags } };
    },
  };
}
const live = (tags: { id: string; name: string }[], logs: QlooCallLog[] = []) => new BudgetedQloo(fakeLive(tags), 40, (l) => logs.push(l));

// ---------------------------------------------------------------- the firewall's 429

test("firewall 429: an error that is not a string becomes the status, and the page does not throw", () => {
  const firewall = { error: { code: "429", message: "Too Many Requests", id: "kix1::abc" } };
  assert.equal(failMessage(firewall, 429), "HTTP 429");
  assert.equal(failMessage(null, 502), "HTTP 502");
  assert.equal(failMessage({ error: "Several explorations are already running." }, 429), "Several explorations are already running.");
  assert.equal(errorText("HTTP 429", 40), "Too many explorations right now. Try again in a few minutes.");
  // Even an object that slipped through renders as words.
  assert.doesNotThrow(() => errorText({ code: "429" } as never, 40));
  const s = reducer(reducer(initialState("Tokyo", { ...meta }), { type: "reset", city: "Tokyo", focus: "all" }), { type: "fail", message: failMessage(firewall, 429) });
  assert.match(text(h(StoryCaption, { state: s, selected: null, ruledOut: null, rank: null, total: 0, onRetry: () => {} })), /Too many explorations right now/);
  assert.doesNotThrow(() => text(h(AgentLog, { state: s, onFocusDone: () => {}, onChip: () => {} })));
});

// ---------------------------------------------------------------- reading typed text

test("words: one-letter words stay (e-sports, k-pop), the possessive s and filler words go", () => {
  assert.deepEqual(queryWords("e-sports bar"), ["e", "sport", "bar"]);
  assert.deepEqual(queryWords("K-Beauty shop"), ["k", "beauty"]);
  assert.deepEqual(queryWords("women's clothing store"), ["women", "clothing"]);
  assert.deepEqual(queryWords("a cafe"), ["cafe"]);
});

test("plurals in -es, run-together names, emoji, dashes and soft hyphens", () => {
  for (const [plural, one] of [["dresses", "dress"], ["boxes", "box"], ["dishes", "dish"], ["sandwiches", "sandwich"], ["churches", "church"], ["businesses", "business"]]) assert.equal(singular(plural), one, plural);
  assert.equal(matchCatalog("sandwich shops")?.key, "sandwich_shop");
  assert.equal(matchCatalog("sportsbar")?.key, "sports_bar");
  assert.equal(matchCatalog("tapasbars")?.key, "tapas_bar");
  assert.equal(matchCatalog("pilatesstudio")?.key, "pilates_studio");
  assert.equal(normalizeQuery("ramen 🍜"), "ramen");
  assert.equal(matchCatalog("ramen 🍜")?.key, "ramen");
  assert.equal(matchCatalog("yoga–studio")?.key, "yoga_studio");
  assert.equal(matchCatalog("yoga" + String.fromCharCode(0xad) + "studio")?.key, "yoga_studio");
});

test("catalog: after the changes every name still means its own type, and only it", () => {
  for (const e of CATALOG) {
    for (const n of [e.label, e.google.en, e.google.ja, e.google.ko, ...e.aliases]) {
      const m = matchCatalog(n);
      assert.equal(m?.key ?? null, e.key, `${e.key}: "${n}" -> ${m?.key ?? "none"}`);
    }
  }
});

test("search: Japanese bars rank above barbecue, and 'a cafe' is not inside 'manga cafe'", () => {
  const bar = searchCatalog("バー", CATALOG, 3).map((e) => e.key);
  assert.ok(!bar.includes("barbecue") && !bar.includes("barber_shop") && !bar.includes("hamburger"), bar.join(","));
  assert.notEqual(searchCatalog("a cafe")[0]?.key, "comic_cafe");
});

test("search box: Enter sends the text as typed unless it names a type or clearly starts one", () => {
  const opts = (t: string) => {
    const { options, preferred } = pickerOptions(t, CATALOG);
    const o = options[preferred];
    return o.kind === "entry" ? o.entry.key : `free:${o.text}`;
  };
  assert.equal(opts("yoga"), "yoga_studio");
  assert.equal(opts("pilat"), "pilates_studio");
  assert.equal(opts("food"), "free:food");
  assert.equal(opts("バー"), "free:バー");
  // "a cafe" is read without its article, as the server reads it (a coffee shop).
  assert.equal(opts("a cafe"), "coffee_shop");
  assert.equal(pickerOptions("", CATALOG, true).options.length, CATALOG.length);
});

// ---------------------------------------------------------------- matching on the server

test("match: filler words are dropped before the catalog ('a cafe', 'cafe shop' are a coffee shop)", async () => {
  await withEnv({ QLOO_MODE: "live", QLOO_API_KEY: "k" }, async () => {
    for (const q of ["a cafe", "the cafe", "cafe shop"]) {
      const logs: QlooCallLog[] = [];
      const r = await resolveTarget(req({ query: q }), live([], logs), noStep);
      assert.equal(r.target.key, "coffee_shop", q);
      assert.equal(logs.length, 0, `${q}: no Qloo call`);
    }
  });
});

test("match: a too-general word gets advice about that word, not about bars", async () => {
  await withEnv({ QLOO_MODE: "live", QLOO_API_KEY: "k" }, async () => {
    const reason = async (q: string) => {
      try {
        await resolveTarget(req({ query: q }), live([]), noStep);
        return "matched";
      } catch (e) {
        return e instanceof TargetError ? e.message : String(e);
      }
    };
    assert.match(await reason("bar"), /wine bar/);
    assert.match(await reason("food"), /too general/);
    assert.doesNotMatch(await reason("food"), /bar/);
    assert.doesNotMatch(await reason("shopping"), /instead of “bar”/);
  });
});

test("match (live): one-letter words count, so e-sports is not sports and K-beauty is not beauty", async () => {
  await withEnv({ QLOO_MODE: "live", QLOO_API_KEY: "k" }, async () => {
    const sports = catalogEntry("sports_bar")!.tag;
    const r = await resolveTarget(req({ query: "e-sports bar" }), live([{ id: "urn:tag:genre:place:e_sports_bar", name: "E-Sports Bar" }, { id: sports, name: "Sports Bar" }]), noStep);
    assert.equal(r.target.tag, "urn:tag:genre:place:e_sports_bar");
    const beauty = catalogEntry("beauty_salon")!.tag;
    await assert.rejects(resolveTarget(req({ query: "K-beauty" }), live([{ id: beauty, name: "Beauty Salon" }]), noStep), TargetError);
  });
});

test("match (live): an -es plural finds its tag", async () => {
  await withEnv({ QLOO_MODE: "live", QLOO_API_KEY: "k" }, async () => {
    const r = await resolveTarget(req({ query: "wedding dresses" }), live([{ id: "urn:tag:category:place:wedding_dress_shop", name: "Wedding Dress Shop" }]), noStep);
    assert.equal(r.target.tag, "urn:tag:category:place:wedding_dress_shop");
  });
});

// ---------------------------------------------------------------- the request

test("request: invisible-only text is refused, not turned into a scan; length is counted as typed", () => {
  const zw = String.fromCharCode(0x200b);
  assert.equal((parseExploreBody(JSON.stringify({ city: "Tokyo", query: zw + zw })) as { status: number }).status, 400);
  // Blank still means a scan, as before.
  assert.deepEqual(parseExploreBody(JSON.stringify({ city: "Tokyo", query: "   " })), { city: "Tokyo", focus: "all" });
  // 59 characters ending in an ellipsis: NFKC makes it 61, but it is accepted and kept to 60.
  const long = "x".repeat(MAX_QUERY_CHARS - 1) + String.fromCharCode(0x2026);
  const ok = parseExploreBody(JSON.stringify({ city: "Tokyo", query: long })) as { query?: string };
  assert.ok(ok.query && [...ok.query].length <= MAX_QUERY_CHARS);
  assert.equal((parseExploreBody(JSON.stringify({ city: "Tokyo", query: "x".repeat(MAX_QUERY_CHARS + 1) })) as { status: number }).status, 400);
});

// ---------------------------------------------------------------- the empty result

function checked(here: number, there: number, extra: AgentEvent[] = []): RunState {
  const target = { key: "yoga_studio", label: "Yoga studio" };
  let s: RunState = reducer(initialState("Tokyo", { ...meta }), { type: "reset", city: "Tokyo", focus: "all", target });
  for (const e of [
    { type: "start", city: "Tokyo", focus: "all", qlooMode: "live", llmMode: "none", budget: 40, target },
    { type: "twin", home: "Shibuya", homeCity: "Tokyo", twin: "Hongdae", twinCity: "Seoul", similarity: 0.5, rank: 1, tastes: [], calls: [1] },
    { type: "supply", hood: "Shibuya", city: "Tokyo", counts: { "Yoga studio": here }, calls: [2] },
    { type: "supply", hood: "Hongdae", city: "Seoul", counts: { "Yoga studio": there }, calls: [3] },
    ...extra,
    { type: "done", callsUsed: 3, budget: 40, cards: 0 },
  ] as AgentEvent[])
    s = reducer(s, { type: "event", event: e });
  return s;
}

test("well supplied: only when every compared pair has at least 4 places at home and as many as the twin", () => {
  assert.equal(wellSupplied(emptySummary(checked(1, 0))), false, "1 vs 0 proves nothing");
  assert.equal(wellSupplied(emptySummary(checked(3, 3))), false, "3 vs 3 is too few");
  assert.equal(wellSupplied(emptySummary(checked(5, 3))), true);
  const page = (s: RunState) => text(h(StoryCaption, { state: s, selected: null, ruledOut: null, rank: null, total: 0, onRetry: () => {} })) + " | " + text(h(EmptyResult, { state: s, cities: ["Tokyo", "Seoul"], onTry: () => {}, onChip: () => {} }));
  assert.doesNotMatch(page(checked(1, 0)), /well supplied with/);
  assert.match(page(checked(5, 3)), /looks well supplied/);
});

test("empty result: while a recording answers a business check, the chips keep the business type", () => {
  const target = { key: "yoga_studio", label: "Yoga studio" };
  let s: RunState = reducer(initialState("Tokyo", { ...meta }), { type: "reset", city: "Tokyo", focus: "all", target });
  for (const e of [
    { type: "replay", recordedAt: "2026-10-24T00:00:00Z", reason: "Live runs are busy right now" },
    { type: "start", city: "Tokyo", focus: "all", qlooMode: "live", llmMode: "none", budget: 40 },
    { type: "done", callsUsed: 3, budget: 40, cards: 0 },
  ] as AgentEvent[])
    s = reducer(s, { type: "event", event: e });
  const out = text(h(EmptyResult, { state: s, cities: ["Tokyo", "Seoul"], onTry: () => {}, onChip: () => {} }));
  assert.match(out, /Scan everything in Tokyo/);
  assert.doesNotMatch(out, /Try dining/);
});

test("empty result: close names come from the words that name the business, never from an article", () => {
  const unmatched = (query: string) => {
    let s: RunState = reducer(initialState("Tokyo", { ...meta }), { type: "reset", city: "Tokyo", focus: "all", target: { label: query, query } });
    for (const e of [
      { type: "start", city: "Tokyo", focus: "all", qlooMode: "live", llmMode: "none", budget: 40, target: { label: query, query } },
      { type: "target", status: "unmatched", query, reason: "Refused.", calls: [] },
      { type: "done", callsUsed: 0, budget: 40, cards: 0 },
    ] as AgentEvent[])
      s = reducer(s, { type: "event", event: e });
    return text(h(EmptyResult, { state: s, cities: ["Tokyo"], onTry: () => {}, onChip: () => {} }));
  };
  assert.doesNotMatch(unmatched("a bar"), /Peruvian|amusement|Argentinian/);
  assert.match(unmatched("a bar"), /Check (wine|cocktail|dart|sports|tapas|espresso|gay|hookah|oyster|live music) bar/);
  assert.match(unmatched("a cat cafe"), /Check \w+ cafe/);
  assert.doesNotMatch(unmatched("the kite place"), /Check /);
});

// ---------------------------------------------------------------- the tab icon

test("the tab icon is the leaf, not the Next.js template's", () => {
  assert.ok(existsSync("src/app/icon.svg"));
  assert.ok(!existsSync("src/app/favicon.ico"));
});

void createQloo;

// ---------------------------------------------------------------- fixes from the Codex review of these fixes

test("codex N1: every invisible character is dropped, so it never makes a blank business type", () => {
  for (const cp of [0x00ad, 0x061c, 0xfe0f, 0x3164, 0x200b, 0x202e, 0xe0041]) {
    const only = String.fromCodePoint(cp);
    assert.equal((parseExploreBody(JSON.stringify({ city: "Tokyo", query: only + only })) as { status: number }).status, 400, cp.toString(16));
    // The box cleans the same way, so it offers nothing for it.
    assert.equal(clipQuery(cleanQuery(only + only)), "", cp.toString(16));
  }
  const ok = parseExploreBody(JSON.stringify({ city: "Tokyo", query: "yoga" + String.fromCharCode(0x00ad) + " studio" })) as { query?: string };
  assert.equal(ok.query, "yoga studio");
});

test("codex N2: a 0 vs 0 pair keeps a check from being called well supplied", () => {
  const s = checked(5, 3, [
    { type: "twin", home: "Minato", homeCity: "Tokyo", twin: "Mapo", twinCity: "Seoul", similarity: 0.5, rank: 1, tastes: [], calls: [4] },
    { type: "supply", hood: "Minato", city: "Tokyo", counts: { "Yoga studio": 0 }, calls: [5] },
    { type: "supply", hood: "Mapo", city: "Seoul", counts: { "Yoga studio": 0 }, calls: [6] },
  ] as AgentEvent[]);
  assert.equal(emptySummary(s).pairs, 2);
  assert.equal(wellSupplied(emptySummary(s)), false);
});

test("codex N3: words whose singular ends in 'che' keep their e", () => {
  for (const [plural, one] of [["quiches", "quiche"], ["creches", "creche"], ["niches", "niche"], ["brioches", "brioche"], ["sandwiches", "sandwich"], ["beaches", "beach"]]) assert.equal(singular(plural), one, plural);
});

// ---------------------------------------------------------------- fixes from the independent re-check

test("recheck: 'glass' is not an optician, and 'glasses' still is", () => {
  assert.equal(matchCatalog("glass"), null);
  assert.equal(matchCatalog("glass shop"), null);
  assert.equal(matchCatalog("glasses")?.key, "optician");
  assert.equal(singular("ceviches"), "ceviche");
  assert.equal(matchCatalog("ceviches")?.key, "peruvian");
});

test("recheck: an article does not change which business is checked", async () => {
  await withEnv({ QLOO_MODE: "live", QLOO_API_KEY: "k" }, async () => {
    const key = async (q: string) => (await resolveTarget(req({ query: q }), live([]), noStep)).target.key;
    assert.equal(await key("sweet shop"), await key("a sweet shop"));
    assert.equal(await key("coffee store"), await key("a coffee store"));
    assert.equal(await key("a cafe"), "coffee_shop");
  });
});

test("recheck: 'n' is filler (fish n chips), and only-letters text is refused without a search", async () => {
  await withEnv({ QLOO_MODE: "live", QLOO_API_KEY: "k" }, async () => {
    const r = await resolveTarget(req({ query: "fish n chips" }), live([{ id: "urn:tag:genre:place:restaurant:fish_chips", name: "Fish & Chips" }]), noStep);
    assert.equal(r.target.tag, "urn:tag:genre:place:restaurant:fish_chips");
    const logs: QlooCallLog[] = [];
    await assert.rejects(resolveTarget(req({ query: "b&b" }), live([], logs), noStep), TargetError);
    assert.equal(logs.length, 0);
  });
});

test("recheck: the search box reads text the way the server does, and Enter stays on the typed text for a shared word", () => {
  const pre = (t: string) => {
    const { options, preferred } = pickerOptions(t, CATALOG);
    const o = options[preferred];
    return o.kind === "entry" ? o.entry.key : `free:${o.text}`;
  };
  assert.equal(pre("a cafe"), "coffee_shop");
  assert.equal(pre("a sweet shop"), "candy_store");
  for (const t of ["japanese", "korean", "beer", "health"]) assert.equal(pre(t), `free:${t}`, t);
  assert.equal(pre("pilat"), "pilates_studio");
  assert.equal(pre("カクテル"), "cocktail_bar");
});

test("recheck: math symbols and dots are spaces, Korean compounds are searched inside, soft hyphens join", () => {
  for (const t of ["yoga" + String.fromCharCode(0x2212) + "studio", "yoga+studio", "yoga" + String.fromCharCode(0xb7) + "studio", "yoga" + String.fromCharCode(0x2022) + "studio"]) assert.equal(matchCatalog(t)?.key, "yoga_studio", t);
  assert.ok(searchCatalog("술집").some((e) => e.key === "izakaya"));
  assert.equal(cleanQuery("tat" + String.fromCharCode(0xad) + "too par" + String.fromCharCode(0xad) + "lor"), "tattoo parlor");
  assert.equal((parseExploreBody(JSON.stringify({ city: "Tokyo", query: String.fromCharCode(0x2800) })) as { status: number }).status, 400);
});

test("recheck: a one-letter last word gives no unrelated chips", () => {
  let s: RunState = reducer(initialState("Tokyo", { ...meta }), { type: "reset", city: "Tokyo", focus: "all", target: { label: "plan b", query: "plan b" } });
  for (const e of [
    { type: "start", city: "Tokyo", focus: "all", qlooMode: "live", llmMode: "none", budget: 40, target: { label: "plan b", query: "plan b" } },
    { type: "target", status: "unmatched", query: "plan b", reason: "Refused.", calls: [] },
    { type: "done", callsUsed: 0, budget: 40, cards: 0 },
  ] as AgentEvent[])
    s = reducer(s, { type: "event", event: e });
  assert.doesNotMatch(text(h(EmptyResult, { state: s, cities: ["Tokyo"], onTry: () => {}, onChip: () => {} })), /Check bag|Check bagel|Check bakery/);
});

test("codex round 2: a listed type with an article in another script needs no translation", async () => {
  for (const q of ["a ヨガ", "the 요가"]) {
    const r = await withEnv({ QLOO_MODE: "live", QLOO_API_KEY: "k" }, () => resolveTarget(req({ query: q }), live([]), noStep, { translate: async () => "failed" }));
    assert.equal(r.target.key, "yoga_studio", q);
  }
});
