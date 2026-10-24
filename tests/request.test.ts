// Input checks for POST /api/explore.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExploreBody } from "../src/lib/agent/request";
import { canonicalCity } from "../src/lib/cities";
import { admit, resetLimits } from "../src/lib/limits";

test("accepts known cities in any spelling we alias", () => {
  assert.deepEqual(parseExploreBody('{"city":"Tokyo","focus":"dining"}'), { city: "Tokyo", focus: "dining" });
  assert.deepEqual(parseExploreBody('{"city":" tokyo "}'), { city: "Tokyo", focus: "all" });
  assert.equal(canonicalCity("NYC"), "New York");
  assert.equal(canonicalCity("東京"), "Tokyo");
  assert.equal(canonicalCity("서울"), "Seoul");
});

test("rejects bad input with a clear message", () => {
  const err = (text: string) => {
    const r = parseExploreBody(text);
    assert.ok("error" in r, `expected an error for ${text}`);
    return r;
  };
  assert.equal(err("{").status, 400);
  assert.equal(err("[]").status, 400);
  assert.equal(err('"Tokyo"').status, 400);
  assert.match(err('{"city":"Paris"}').error, /Tokyo, New York, Seoul/);
  assert.match(err('{"city":123}').error, /city/);
  assert.match(err('{"city":"Tokyo","focus":"shopping"}').error, /focus/);
  assert.equal(err(JSON.stringify({ city: "Tokyo", pad: "x".repeat(5000) })).status, 413);
});

test("limits: concurrent runs are capped and slots are released", () => {
  resetLimits();
  process.env.EXPLORE_MAX_CONCURRENT = "2";
  const a = admit("1.1.1.1");
  const b = admit("1.1.1.2");
  const c = admit("1.1.1.3");
  assert.ok(a.ok && b.ok);
  assert.ok(!c.ok && c.status === 429);
  a.release();
  a.release(); // releasing twice must not free two slots
  assert.ok(admit("1.1.1.3").ok);
  assert.ok(!admit("1.1.1.4").ok);
  delete process.env.EXPLORE_MAX_CONCURRENT;
  resetLimits();
});
