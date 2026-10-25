// Fixes from the 2026-10-24 review in scoring (score.ts, rules.ts), evidence (evidence.ts) and
// the Tokyo ward table (census.ts). Offline: Evidence is seeded directly or driven by a fake
// Qloo client; no network, no keys.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findWard, wardAudience } from "../src/lib/agent/census";
import { Evidence, type Demographics } from "../src/lib/agent/evidence";
import * as rules from "../src/lib/agent/rules";
import { ageOverlap, buildCard, type CardInput, isGap, MIN_CONFIDENCE } from "../src/lib/agent/score";
import type { SupplyEvent } from "../src/lib/agent/types";
import { BudgetedQloo, type InsightsResponse, type QlooCallLog, type QlooClient, QlooError, type QlooParams } from "../src/lib/qloo";

process.env.QLOO_MODE = "mock";
process.env.MOCK_DELAY_MS = "0";

// --- helpers -------------------------------------------------------------------------------

// An Evidence whose cache is filled directly, as a recording or the review's repro does.
function seeded(mode: "mock" | "live", entries: Record<string, unknown>, twin?: { key: string; similarity: number; sharedShare?: number }) {
  const ev = new Evidence({ mode, lastCall: 0, remaining: 100 } as unknown as BudgetedQloo, {});
  const cache = (ev as unknown as { cache: Map<string, unknown> }).cache;
  const prov = (ev as unknown as { prov: Map<string, number[]> }).prov;
  let n = 0;
  for (const [k, v] of Object.entries(entries)) {
    cache.set(k, v);
    prov.set(k, [++n]);
  }
  if (twin) {
    const [, name, city] = twin.key.split("|");
    ev.twins.set(twin.key, { name, city, similarity: twin.similarity, rank: 1, sharedShare: twin.sharedShare });
  }
  return ev;
}

// A live Qloo client that answers with answer(params) and records what was asked.
function fakeLive(answer: (p: QlooParams) => InsightsResponse | Promise<InsightsResponse>) {
  const asked: QlooParams[] = [];
  const logs: QlooCallLog[] = [];
  const inner: QlooClient = {
    mode: "live",
    attempts: 0,
    insights: async (p) => {
      asked.push(p);
      return answer(p);
    },
    trending: async () => ({ success: true, results: {} }) as never,
  };
  const qloo = new BudgetedQloo(inner, 100, (l) => logs.push(l));
  return { qloo, asked, logs };
}

const share = (v: number): Demographics => ({ age: { x: v }, kind: "share" });

// The recorded Tokyo replay card "Bagel shop, Shibuya-ku vs Manhattan" (src/data/replays/tokyo.json).
const BAGEL = "urn:tag:genre:place:restaurant:bagel_shop";
const SHIBUYA = { similarity: 0.691358024691358, audience: 0.30702782377427323, fit: 0.6, recorded: 0.68 };
function shibuyaBagel(opts: { audience?: number | null | "skip"; city?: { count: number; capped: boolean } | "skip" } = {}) {
  const entries: Record<string, unknown> = {
    "supply:Shibuya-ku, Tokyo": { counts: { [BAGEL]: 1 }, capped: false },
    "supply:Manhattan, New York": { counts: { [BAGEL]: 34 }, capped: true },
  };
  const city = opts.city ?? { count: 15, capped: false };
  if (city !== "skip") entries[`citysupply:Tokyo:${BAGEL}`] = city;
  const aud = opts.audience === undefined ? SHIBUYA.audience : opts.audience;
  if (aud === null) entries[`audience:${BAGEL}`] = null;
  else if (aud !== "skip") {
    entries[`audience:${BAGEL}`] = share(aud);
    entries["hoodaudience:Shibuya-ku, Tokyo"] = share(aud);
  }
  const ev = seeded("live", entries, { key: "Shibuya-ku|Manhattan|New York", similarity: SHIBUYA.similarity });
  const input: CardInput = { category: BAGEL, hood: "Shibuya-ku", city: "Tokyo", twin: "Manhattan", twinCity: "New York", why: "", doubts: [], productFit: { score: SHIBUYA.fit, reason: "r" } };
  return buildCard(ev, input);
}

// --- rules.ts -------------------------------------------------------------------------------

test("rules.ts: score.ts re-exports the same rules, and the fading/falling/city rules agree with buildCard", () => {
  assert.equal(MIN_CONFIDENCE, rules.MIN_CONFIDENCE);
  assert.equal(MIN_CONFIDENCE, 0.55);
  assert.equal(isGap, rules.isGap);
  assert.equal(rules.CITY_CROWDED, 20);
  assert.equal(rules.FALLING_TREND, -0.2);
  const cat = "urn:tag:mock:place:malatang";
  for (const change of [-0.15, -0.19, -0.2, -0.2000001, -0.21, -0.5]) {
    const ev = seeded(
      "mock",
      {
        "supply:Koenji, Tokyo": { counts: { [cat]: 0 }, capped: false },
        "supply:Brooklyn, New York": { counts: { [cat]: 15 }, capped: false },
        [`citysupply:Tokyo:${cat}`]: { count: 3, capped: false },
        [`trend:${cat}:New York`]: { first: 1, last: 1 + change, change, points: 12 },
      },
      { key: "Koenji|Brooklyn|New York", similarity: 0.8 },
    );
    const card = buildCard(ev, { category: cat, hood: "Koenji", city: "Tokyo", twin: "Brooklyn", twinCity: "New York", why: "", doubts: [], productFit: null });
    const durability = card.scores.find((s) => s.key === "durability")!.value;
    const falling = card.doubts.some((d) => d.startsWith("Interest is falling"));
    assert.equal(rules.isFading(durability), falling, `change ${change}: the UI's fading mark matches the code's doubt`);
    assert.equal(rules.isFalling(change), falling);
  }
  // The city doubt (score.ts) and the UI's mark use one rule.
  assert.equal(rules.cityMayBeLocal(15, 1), true);
  assert.equal(rules.cityMayBeLocal(8, 1), false);
  assert.equal(rules.cityMayBeLocal(11, 2), false);
  assert.equal(rules.cityMayBeLocal(12, 2), true);
  const card = shibuyaBagel();
  assert.equal(card.doubts.some((d) => /may be local only/.test(d)), rules.cityMayBeLocal(card.cityCount!, card.homeCount));
});

// --- F35 / N14: skipping never raises confidence ------------------------------------------------

test("F35: the recorded Shibuya bagel card scores 0.68; skipping the audience check gives no more", () => {
  const checked = shibuyaBagel();
  assert.equal(checked.confidence, SHIBUYA.recorded, "the seeded evidence reproduces the recording");
  const skipped = shibuyaBagel({ audience: "skip" });
  assert.ok(skipped.confidence <= SHIBUYA.recorded, `skipped ${skipped.confidence} must not beat checked ${SHIBUYA.recorded}`);
  assert.ok(skipped.doubts.includes("Not checked: core audience fit."));
  assert.match(skipped.trail!.at(-1)!.label, /1 check skipped/);
  // Whatever the audience check would have found, skipping it is no better.
  for (let a = 0; a <= 1; a += 0.05) {
    const c = shibuyaBagel({ audience: a });
    assert.ok(skipped.confidence <= c.confidence, `audience ${a.toFixed(2)}: checked ${c.confidence} vs skipped ${skipped.confidence}`);
  }
});

test("N14: skipping the city-wide check adds a doubt, counts as skipped and never beats running it", () => {
  const skipped = shibuyaBagel({ city: "skip" });
  assert.ok(skipped.doubts.includes("Not checked: rest of the city."));
  assert.match(skipped.trail!.at(-1)!.label, /1 check skipped/);
  assert.equal(skipped.cityCount, null);
  for (const count of [0, 5, 15, 21, 50]) {
    const c = shibuyaBagel({ city: { count, capped: count >= 50 } });
    assert.ok(skipped.confidence <= c.confidence, `city ${count}: checked ${c.confidence} vs skipped ${skipped.confidence}`);
  }
});

// --- F46 / F32: ran but no data is not "skipped" ---------------------------------------------

test("F46/F32: an audience lookup that found no age data is an open doubt, not a skipped check; doubts are deduplicated", () => {
  const card = shibuyaBagel({ audience: null });
  const audience = card.scores.find((s) => s.key === "audience")!;
  assert.equal(audience.value, null);
  assert.equal(audience.note, "Qloo has no age data for this category's fans");
  assert.ok(card.doubts.includes("Unknown audience: Qloo has no age data for this category's fans."));
  assert.ok(!card.doubts.some((d) => d.startsWith("Not checked")), "nothing was skipped");
  assert.doesNotMatch(card.trail!.at(-1)!.label, /skipped/);
  assert.equal(card.confidenceMath.measured, 4, "not averaged in: no agent could have measured it");

  // People-side no data: same treatment, and the note says which side.
  const ev = seeded(
    "live",
    {
      "supply:Shibuya-ku, Tokyo": { counts: { [BAGEL]: 1 }, capped: false },
      "supply:Manhattan, New York": { counts: { [BAGEL]: 34 }, capped: true },
      [`citysupply:Tokyo:${BAGEL}`]: { count: 15, capped: false },
      [`audience:${BAGEL}`]: share(0.4),
      "hoodaudience:Shibuya-ku, Tokyo": null,
    },
    { key: "Shibuya-ku|Manhattan|New York", similarity: SHIBUYA.similarity },
  );
  const dup = "15 exist elsewhere in Tokyo, so the gap may be local only.";
  const c2 = buildCard(ev, { category: BAGEL, hood: "Shibuya-ku", city: "Tokyo", twin: "Manhattan", twinCity: "New York", why: "", doubts: [dup], productFit: { score: 0.6, reason: "r" } });
  assert.equal(c2.scores.find((s) => s.key === "audience")!.note, "No age data for people in Shibuya-ku");
  assert.ok(c2.doubts.includes("Unknown audience: no age data for people in Shibuya-ku."));
  assert.equal(c2.doubts.filter((d) => d === dup).length, 1, "the same doubt twice counts once");
  assert.equal(c2.confidenceMath.doubts, c2.doubts.length);
});

// --- F41: the bar uses the unrounded value ---------------------------------------------------

test("F41: a confidence just under 55% is never stored or shown as 55%", () => {
  let found = 0;
  for (let fit = 0; fit <= 1; fit += 0.0005) {
    const c = buildCard(
      seeded(
        "live",
        {
          "supply:Shibuya-ku, Tokyo": { counts: { [BAGEL]: 1 }, capped: false },
          "supply:Manhattan, New York": { counts: { [BAGEL]: 34 }, capped: true },
          [`citysupply:Tokyo:${BAGEL}`]: { count: 15, capped: false },
          [`audience:${BAGEL}`]: share(0.1),
          "hoodaudience:Shibuya-ku, Tokyo": share(0.1),
        },
        { key: "Shibuya-ku|Manhattan|New York", similarity: 0.3 },
      ),
      { category: BAGEL, hood: "Shibuya-ku", city: "Tokyo", twin: "Manhattan", twinCity: "New York", why: "", doubts: ["a", "b"], productFit: { score: fit, reason: "r" } },
    );
    const vals = c.scores.filter((s) => s.value !== null).map((s) => s.value!);
    const raw = (vals.reduce((a, v) => a + v, 0) / vals.length) * (1 - 0.05 * c.doubts.length);
    if (raw < MIN_CONFIDENCE) {
      assert.ok(c.confidence < MIN_CONFIDENCE, `raw ${raw} stored as ${c.confidence}`);
      assert.equal(c.trail!.at(-1)!.confidence, c.confidence);
      if (raw >= 0.545) found++;
    } else {
      assert.ok(c.confidence >= MIN_CONFIDENCE, `raw ${raw} stored as ${c.confidence}`);
    }
  }
  assert.ok(found > 0, "the sweep hit the 54.5%..55% band");
});

// --- F48 / N02: capped counts and the recount's call ------------------------------------------

test("F48: capped counts read 'at least N' in the card's text", () => {
  const card = shibuyaBagel();
  assert.equal(card.scores.find((s) => s.key === "proven")!.note, "at least 34 places in Manhattan");
  assert.match(card.scores.find((s) => s.key === "gap")!.note, /^1 in Shibuya-ku vs at least 34 in Manhattan/);
  assert.equal(card.trail![0].label, "Gap found: at least 34 in Manhattan, 1 in Shibuya-ku");
});

test("N02/F38/M04: the single-category recount is cited, re-sent as an exact supply event, and every area call names its place", async () => {
  const CAT = "urn:tag:genre:place:restaurant:bagel_shop";
  const OTHER = "urn:tag:genre:place:record_store";
  const place = (i: number, tag: string) => ({ entity_id: `p${i}`, name: `P${i}`, tags: [{ id: tag, name: tag }] });
  const { qloo, asked, logs } = fakeLive((p) => {
    // Shared page: 50 places, only 1 bagel shop. The recount finds 6.
    if (p["filter.tags"] === CAT) return { success: true, results: { entities: Array.from({ length: 6 }, (_, i) => place(i, CAT)) } } as InsightsResponse;
    return { success: true, results: { entities: [place(0, CAT), ...Array.from({ length: 49 }, (_, i) => place(i + 1, OTHER))] } } as InsightsResponse;
  });
  const events: SupplyEvent[] = [];
  const ev = new Evidence(qloo, { categories: [CAT, OTHER], onSupply: (e) => events.push(e) });
  await ev.supply("Shibuya-ku", "Tokyo");
  await ev.supply("Manhattan", "New York");
  const exact = await ev.homeCount("Shibuya-ku", "Tokyo", CAT);
  assert.deepEqual(exact, { count: 6, capped: false });
  await ev.homeCount("Shibuya-ku", "Tokyo", CAT); // memoised: no second event

  assert.equal(events.length, 3);
  assert.equal(events[0].capped, true, "a capped page says so");
  assert.equal(events[0].exact, undefined);
  const re = events[2];
  assert.equal(re.hood, "Shibuya-ku");
  assert.deepEqual(re.exact, { "Bagel shop": 6 });
  assert.deepEqual(re.calls, [1, 3], "the shared page and the recount");

  // M04: every supply call carries the display-only place name; it is not sent to Qloo.
  for (const l of logs) assert.ok(l.where === "Shibuya-ku, Tokyo" || l.where === "Manhattan, New York", `call ${l.n} names its place`);
  for (const p of asked) assert.ok(!("_where" in p), "never sent to Qloo");

  // N02: the card's home count comes from the recount, and cites it.
  ev.twins.set("Shibuya-ku|Manhattan|New York", { name: "Manhattan", city: "New York", similarity: 0.7, rank: 1 });
  const card = buildCard(ev, { category: CAT, hood: "Shibuya-ku", city: "Tokyo", twin: "Manhattan", twinCity: "New York", why: "", doubts: [], productFit: null });
  assert.equal(card.homeCount, 6);
  assert.deepEqual(card.refs.homeSupply, [1, 3]);
  assert.deepEqual(card.trail![0].calls, [1, 3, 2]);
});

// --- F12 / N01: what is memoised --------------------------------------------------------------

test("F12/N01: cancelled lookups and precondition errors are not memoised; Qloo errors are", async () => {
  let fail: unknown = new QlooError("aborted", "Qloo /v2/insights: run was cancelled");
  let calls = 0;
  const { qloo } = fakeLive(() => {
    calls++;
    if (fail) throw fail;
    return { success: true, results: { entities: [] } } as InsightsResponse;
  });
  const ev = new Evidence(qloo, {});
  await assert.rejects(ev.citySupply("Tokyo", BAGEL), /cancelled/);
  fail = null;
  assert.deepEqual(await ev.citySupply("Tokyo", BAGEL), { count: 0, capped: false }, "a cancelled request is asked again");
  assert.equal(calls, 2);

  fail = new QlooError("server", "Qloo /v2/insights: 503");
  await assert.rejects(ev.citySupply("Tokyo", OTHER_CAT), /503/);
  fail = null;
  await assert.rejects(ev.citySupply("Tokyo", OTHER_CAT), /503/, "a Qloo error fails again for free");
  assert.equal(calls, 3);

  // N01: twins asked for before the neighbourhoods were listed; listing them fixes it.
  const tag = { id: "urn:tag:t1", name: "Trendy", type: "urn:tag:characteristic:qloo" };
  const { qloo: q2 } = fakeLive((p) => {
    if (p["filter.location.query"] === "Tokyo") return { success: true, results: { entities: [{ entity_id: "L1", name: "Shibuya-ku", tags: [tag] }] } } as InsightsResponse;
    return { success: true, results: { entities: [{ entity_id: "L2", name: "Manhattan", tags: [tag] }] } } as InsightsResponse;
  });
  const ev2 = new Evidence(q2, {});
  await assert.rejects(ev2.findTwins("Shibuya-ku", "Tokyo", "New York"), /call list_neighbourhoods first/);
  await ev2.listNeighbourhoods("Tokyo", 5);
  const twins = await ev2.findTwins("Shibuya-ku", "Tokyo", "New York");
  assert.equal(twins[0]?.name, "Manhattan", "the precondition error was not cached");
});
const OTHER_CAT = "urn:tag:genre:place:record_store";

// --- hood names: F33, N05, N06 ----------------------------------------------------------------

test("F33/N05: odd city names don't throw, and an unlisted neighbourhood keeps its first spelling", async () => {
  const ev = new Evidence(new BudgetedQloo({ mode: "mock", attempts: 0, insights: async () => ({ success: true, results: {} }) as InsightsResponse, trending: async () => ({}) as never }, 10, () => {}), {});
  assert.doesNotThrow(() => ev.hood("Midtown, New York (", "New York ("));
  assert.equal(ev.hood("Midtown, New York (", "New York ("), "Midtown");
  assert.equal(ev.hood("shimokitazawa", "Tokyo"), "shimokitazawa");
  assert.equal(ev.hood("Shimokitazawa", "Tokyo"), "shimokitazawa", "same key as the first spelling");
  assert.equal(ev.hood("shimokitazawa, Tokyo", "Tokyo"), "shimokitazawa");
  assert.equal(ev.hood("Kōenji", "Tokyo"), "Kōenji");
  assert.equal(ev.hood("koenji", "Tokyo"), "Kōenji", "diacritics and case don't make a new neighbourhood");
});

test("N05: compare_supply with one spelling and a card with another meet in the same evidence (mock)", async () => {
  const { BudgetedQloo: B, createQloo } = await import("../src/lib/qloo");
  const ev = new Evidence(new B(createQloo(), 50, () => {}), {});
  await ev.supply("koenji", "Tokyo"); // Not listed in this run: no names known yet.
  await ev.supply("Williamsburg", "New York");
  const cat = "urn:tag:mock:place:malatang";
  assert.doesNotThrow(() => buildCard(ev, { category: cat, hood: "Koenji", city: "Tokyo", twin: "williamsburg", twinCity: "New York", why: "", doubts: [], productFit: null }));
});

test("N06: live listing drops neighbourhoods that twin search could never use", async () => {
  const tag = { id: "urn:tag:t1", name: "Trendy", type: "urn:tag:characteristic:qloo" };
  const { qloo } = fakeLive(() => ({
    success: true,
    results: {
      entities: [
        { entity_id: "A", name: "Mapo District", tags: [tag] },
        { entity_id: "B", name: "순화동", tags: [tag] },
        { entity_id: "C", name: "Jung District", tags: [] },
        { entity_id: "D", name: "Gangnam District", tags: [tag] },
      ],
    },
  }) as InsightsResponse);
  const ev = new Evidence(qloo, {});
  const hoods = await ev.listNeighbourhoods("Seoul", 5);
  assert.deepEqual(hoods.map((h) => h.name), ["Mapo District", "Gangnam District"]);
});

// --- F43: ageOverlap by kind ----------------------------------------------------------------

test("F43: identical all-positive lean profiles match fully; shares still compare as shares", () => {
  // Before: no negative band, so these were read as shares and scored about 0.6.
  const lean: Demographics = { age: { a: 0.3, b: 0.2, c: 0.1 }, kind: "lean" };
  assert.ok(ageOverlap(lean, { ...lean }) > 0.99, "identical leans");
  assert.ok(ageOverlap(lean, { age: { a: 0.1, b: 0.2, c: 0.3 }, kind: "lean" }) < 0.01, "opposite shapes");
  assert.ok(Math.abs(ageOverlap(share(0.3), share(0.3)) - 0.3) < 1e-9, "shares: sum of the smaller share per band");
  // Ward statistics are leans.
  assert.equal(wardAudience("Shibuya", "Tokyo")?.kind, "lean");
});

// --- N08: census ---------------------------------------------------------------------------

test("N08: more Tokyo districts and Japanese spellings find their ward", () => {
  const ward = (h: string) => findWard(h)?.ward.en ?? null;
  assert.equal(ward("Ōkubo"), "Shinjuku");
  assert.equal(ward("Yoyogi"), "Shibuya");
  assert.equal(ward("Nihonbashi-Hakozakichō"), "Chuo");
  assert.equal(ward("Azabu-Juban"), "Minato");
  assert.equal(ward("Kita-Senju"), "Adachi", "not Kita ward");
  assert.equal(ward("Sakuragaokachō"), "Shibuya");
  assert.equal(ward("渋谷"), "Shibuya");
  assert.equal(ward("渋谷区"), "Shibuya");
  assert.equal(ward("渋谷区神南"), "Shibuya");
  assert.equal(ward("Nihonbashi-Kabutocho"), "Chuo", "prefix of a known district");
  assert.equal(ward("Ginza, Chuo City"), "Chuo");
  assert.equal(ward("Kita-ku"), "Kita");
  assert.equal(ward("Kita-Aoyama"), null, "no prefix match on ward names");
  assert.equal(ward("Brooklyn"), null);
});
