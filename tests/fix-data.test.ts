// Recorded runs agree with the current scoring rules (review finding F66: the How it works
// example had been scored by an older score.ts). Offline: reads the bundled recordings only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_CONFIDENCE, isGap } from "../src/lib/agent/rules";
import type { OpportunityCard } from "../src/lib/agent/types";
import sampleRun from "../src/data/sample-run.json";
import tokyo from "../src/data/replays/tokyo.json";
import newYork from "../src/data/replays/new-york.json";
import seoul from "../src/data/replays/seoul.json";

const recordings = { "sample-run": sampleRun, tokyo, "new-york": newYork, seoul } as Record<string, { events: { type: string; card?: OpportunityCard; cards?: number }[] }>;

for (const [name, rec] of Object.entries(recordings)) {
  test(`F66: ${name}: shown cards clear the bar, ruled-out ones don't, and the numbers add up`, () => {
    const cards = rec.events.filter((e) => e.type === "card").map((e) => e.card!);
    const ruledOut = rec.events.filter((e) => e.type === "rejected").map((e) => e.card!);
    for (const c of cards) assert.ok(c.confidence >= MIN_CONFIDENCE, `${c.id} is shown at ${c.confidence}`);
    for (const c of ruledOut) assert.ok(c.confidence < MIN_CONFIDENCE || c.google?.verdict === "contradicts", `${c.id} is ruled out at ${c.confidence}`);
    for (const c of [...cards, ...ruledOut]) {
      assert.ok(isGap(c.twinCount, c.homeCount), `${c.id} is a gap`);
      assert.equal(c.confidenceMath.doubts, c.doubts.length, `${c.id}: doubt count`);
      assert.ok(!c.doubts.some((d) => /capped sample of Qloo results, not a full census/.test(d)), `${c.id}: no doubt the current rules no longer raise`);
      if (c.trail) assert.equal(c.trail.at(-1)?.confidence, c.confidence, `${c.id}: the trail ends at the confidence`);
    }
    const done = rec.events.find((e) => e.type === "done");
    assert.equal(done?.cards, cards.length, "done counts the shown cards");
  });
}
