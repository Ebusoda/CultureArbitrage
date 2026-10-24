// Google Maps cross-check and Tokyo ward statistics, against a fake fetch and the mock
// Qloo data. No network, no keys needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { wardAudience } from "../src/lib/agent/census";
import { Evidence, googleVerdict } from "../src/lib/agent/evidence";
import { ageOverlap, buildCard } from "../src/lib/agent/score";
import { boxAround, GOOGLE_MAX, GooglePlaces, GooglePlacesError, PLACES_URL, resetGoogleDaily } from "../src/lib/google/places";
import { BudgetedQloo, createQloo } from "../src/lib/qloo";

process.env.MOCK_DELAY_MS = "0";
process.env.QLOO_MODE = "mock";

const KEY = "google-test-key-456";
const BOX = boxAround(35.658, 139.7016, 1.5);
const Q = { textQuery: "ベーグル", includedType: "bagel_shop", strict: true, languageCode: "ja", regionCode: "JP" };

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

// Answers each request with the next scripted reply, or with reply(body) when given a function.
function fakeFetch(replies: ((body: Record<string, unknown>) => Response) | Response[]) {
  const seen: Seen[] = [];
  const fn = (async (url: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ url: String(url), headers: new Headers(init?.headers), body });
    if (typeof replies === "function") return replies(body);
    return replies.shift() ?? new Response("script ran out", { status: 500 });
  }) as typeof fetch;
  return { fn, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${from + i}` }));

test("asks only for place ids, inside a hard rectangle, with the key in a header", async () => {
  const f = fakeFetch([json({ places: ids(0, 3) })]);
  const g = new GooglePlaces(KEY, { fetch: f.fn });
  const r = await g.count(Q, BOX);
  assert.deepEqual(r, { count: 3, saturated: false });
  const s = f.seen[0];
  assert.equal(s.url, PLACES_URL);
  assert.equal(s.headers.get("x-goog-api-key"), KEY);
  // The free "IDs Only" tier: any other field would move every request to a paid tier.
  assert.equal(s.headers.get("x-goog-fieldmask"), "places.id,nextPageToken");
  assert.deepEqual(s.body.locationRestriction, { rectangle: BOX });
  assert.equal(s.body.includedType, "bagel_shop");
  assert.equal(s.body.strictTypeFiltering, true);
  assert.equal(s.body.pageSize, 20);
  assert.ok(!JSON.stringify(s.body).includes(KEY) && !s.url.includes(KEY), "key only in the header");
});

test("follows pages with the same request plus the token, counts distinct ids, and marks Google's 60 ceiling", async () => {
  const f = fakeFetch([json({ places: ids(0, 20), nextPageToken: "t1" }), json({ places: ids(15, 20), nextPageToken: "t2" }), json({ places: ids(40, 20), nextPageToken: "t3" })]);
  const g = new GooglePlaces(KEY, { fetch: f.fn });
  const r = await g.count(Q, BOX);
  assert.equal(r.count, 55, "ids repeated across pages count once");
  assert.equal(r.saturated, true, "a token left after the last page means there are more");
  assert.equal(g.requests, 3);
  assert.equal(f.seen[1].body.pageToken, "t1");
  const withoutToken = (b: Record<string, unknown>) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "pageToken"));
  assert.deepEqual(withoutToken(f.seen[1].body), withoutToken(f.seen[0].body), "later pages repeat the first request exactly");
  assert.ok(GOOGLE_MAX === 60);
});

test("a rejected key is a fatal error, and the key never appears in the message", async () => {
  const f = fakeFetch([json({ error: { message: `API key not valid: ${KEY}` } }, 403)]);
  const g = new GooglePlaces(KEY, { fetch: f.fn });
  await assert.rejects(g.count(Q, BOX), (e: unknown) => e instanceof GooglePlacesError && e.fatal && !e.message.includes(KEY) && e.message.includes("[key]"));
});

test("stops at the per-run request cap", async () => {
  const f = fakeFetch(() => json({ places: ids(0, 20), nextPageToken: "more" }));
  const g = new GooglePlaces(KEY, { fetch: f.fn, maxRequests: 2 });
  await assert.rejects(g.count(Q, BOX), /request limit of 2/);
  assert.equal(g.requests, 2);
});

test("stops at the daily cap shared by every run in the process", async () => {
  resetGoogleDaily();
  const f = fakeFetch(() => json({ places: ids(0, 3) }));
  const a = new GooglePlaces(KEY, { fetch: f.fn, dailyLimit: 2 });
  const b = new GooglePlaces(KEY, { fetch: f.fn, dailyLimit: 2 });
  await a.count(Q, BOX);
  await b.count(Q, BOX);
  assert.equal(b.remaining, 0);
  await assert.rejects(b.count(Q, BOX), /daily limit of 2/);
  resetGoogleDaily();
});

test("verdicts: confirms, weak, contradicts, inconclusive", () => {
  const c = (count: number, saturated = false) => ({ count, saturated });
  assert.equal(googleVerdict(c(2), c(12)), "confirms");
  assert.equal(googleVerdict(c(0), c(5)), "confirms");
  assert.equal(googleVerdict(c(5), c(9)), "weak");
  assert.equal(googleVerdict(c(9), c(9)), "contradicts");
  assert.equal(googleVerdict(c(20), c(6)), "contradicts");
  assert.equal(googleVerdict(c(1), c(3)), "inconclusive");
  assert.equal(googleVerdict(c(60, true), c(60, true)), "inconclusive");
});

// A real mock gap: natural wine bars, Shimokitazawa (2) vs its twin Williamsburg (21).
async function gapEvidence(homeIds: number, twinIds: number) {
  const google = new GooglePlaces(KEY, {
    // Japanese queries are the Tokyo side, English the New York side.
    fetch: fakeFetch((b) => json({ places: ids(0, /[a-z]/i.test(String(b.textQuery)) ? twinIds : homeIds) })).fn,
  });
  const ev = new Evidence(new BudgetedQloo(createQloo(), 40, () => {}), { google });
  const cat = "urn:tag:mock:place:natural_wine_bar";
  await ev.listNeighbourhoods("Tokyo", 5);
  await ev.findTwins("Shimokitazawa", "Tokyo", "New York");
  await ev.supply("Shimokitazawa", "Tokyo");
  await ev.supply("Williamsburg", "New York");
  const gap = await ev.googleGap("Shimokitazawa", "Tokyo", "Williamsburg", "New York", cat);
  const card = buildCard(ev, { category: cat, hood: "Shimokitazawa", city: "Tokyo", twin: "Williamsburg", twinCity: "New York", why: "", doubts: [], productFit: null });
  return { gap, card };
}

test("Google Maps never moves a score or the confidence; its numbers stay out of the Qloo doubts and trail", async () => {
  const contra = await gapEvidence(12, 10);
  const confirm = await gapEvidence(1, 9);
  assert.equal(contra.gap.verdict, "contradicts");
  assert.equal(contra.card.google?.verdict, "contradicts");
  assert.deepEqual(contra.card.google && [contra.card.google.home, contra.card.google.twin], [12, 10]);
  assert.equal(confirm.card.google?.verdict, "confirms");
  assert.equal(contra.card.confidence, confirm.card.confidence, "same Qloo evidence, same confidence");
  for (const card of [contra.card, confirm.card]) {
    assert.ok(!card.doubts.some((d) => d.includes("Google")), "no Google text among the doubts");
    assert.ok(!card.trail?.some((t) => t.label.includes("Google")), "no Google step in the score trail");
    assert.ok(!card.scores.some((s) => /google/i.test(s.note)), "Google Maps never feeds a score");
  }
});

test("a saturated twin count is a lower bound: no 'smaller gap' verdict from it", () => {
  const c = (count: number, saturated = false) => ({ count, saturated });
  assert.equal(googleVerdict(c(21), c(60, true)), "inconclusive");
  assert.equal(googleVerdict(c(10), c(60, true)), "confirms");
  assert.equal(googleVerdict(c(60, true), c(40)), "contradicts");
});

test("the Google cross-check fails fast when the run's request budget can't cover both sides", async () => {
  const f = fakeFetch(() => json({ places: ids(0, 5) }));
  const google = new GooglePlaces(KEY, { fetch: f.fn, maxRequests: 4 });
  const ev = new Evidence(new BudgetedQloo(createQloo(), 40, () => {}), { google });
  await ev.listNeighbourhoods("Tokyo", 5);
  await ev.findTwins("Shimokitazawa", "Tokyo", "New York");
  await assert.rejects(ev.googleGap("Shimokitazawa", "Tokyo", "Williamsburg", "New York", "urn:tag:mock:place:natural_wine_bar"), /budget for this run is used up/);
  assert.equal(google.requests, 0, "no half check");
});

test("ward statistics: Tokyo wards and their parts resolve, other cities don't", () => {
  for (const name of ["Shibuya-ku", "Chūō-ku", "Ota", "Kōtō-ku", "Minato", "渋谷区", "Shinjuku", "Shinjuku-ku", "Shinjuku City", "Harajuku", "Shimo-Kitazawa"]) assert.ok(wardAudience(name, "Tokyo"), `${name} resolves`);
  const ginza = wardAudience("Ginza", "Tokyo");
  assert.match(ginza?.basis ?? "", /Chuo ward, which contains Ginza/);
  assert.equal(wardAudience("Shibuya-ku", "New York"), null);
  assert.equal(wardAudience("Kichijoji", "Tokyo"), null, "not one of the 23 wards");
  // Shinjuku's residents lean young against the 23 wards as a whole, Adachi's lean old.
  const shinjuku = wardAudience("Shinjuku", "Tokyo")!.age;
  const adachi = wardAudience("Adachi", "Tokyo")!.age;
  assert.ok(shinjuku["24_and_younger"] > 0 && shinjuku["55_and_older"] < 0);
  assert.ok(adachi["55_and_older"] > 0);
  for (const v of Object.values(shinjuku)) assert.ok(v >= -1 && v <= 1);
});

test("age match: a ward that barely leans lands near neutral, a clear lean counts in full", () => {
  const young = { age: { "24_and_younger": 0.3, "25_to_29": 0.2, "30_to_34": 0.1, "35_to_44": -0.05, "45_to_54": -0.15, "55_and_older": -0.3 } };
  assert.ok(Math.abs(ageOverlap(young, wardAudience("Suginami", "Tokyo")!) - 0.5) < 0.1, "Suginami sits at the 23-ward average");
  assert.ok(ageOverlap(young, wardAudience("Shinjuku", "Tokyo")!) > 0.8, "young fans vs young-leaning Shinjuku");
  assert.ok(ageOverlap(young, wardAudience("Adachi", "Tokyo")!) < 0.4, "young fans vs old-leaning Adachi");
});
