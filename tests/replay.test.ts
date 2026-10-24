// The recorded-run fallback: when a live exploration can't run or fails before it found
// anything, the server streams a run recorded earlier for that city, labelled as a recording.
// Offline: mock Qloo, no keys, no network; recordings play back without pauses here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState, reducer, type RunState } from "../src/components/explorer/useExploreRun";
import type { AgentEvent, OpportunityCard } from "../src/lib/agent/types";
import { exploreResponse, REPLAY_REASON, type ExploreDeps } from "../src/lib/explore-stream";
import { admit, resetLimits, runningCount } from "../src/lib/limits";
import { MAX_REPLAY_GAP_MS, playRecording, recordingFor, replayDelays, type RecordedEvent, type Recording } from "../src/lib/replay";

process.env.MOCK_DELAY_MS = "0";
process.env.QLOO_MODE = "mock";
process.env.LLM_MODE = "mock";
process.env.EXPLORE_REPLAY_SECONDS = "0";
delete process.env.EXPLORE_FORCE_REPLAY;

type Line = AgentEvent & { t: number };

const post = (city: string, headers: Record<string, string> = {}, focus = "all") =>
  new Request("http://x/api/explore", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ city, focus }) });

async function lines(res: Response): Promise<Line[]> {
  return (await res.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const types = (events: { type: string }[]) => events.map((e) => e.type);

function withoutT(e: object) {
  const copy: Record<string, unknown> = { ...e };
  delete copy.t;
  return copy;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// The real Tokyo recording (src/data/sample-run.json until src/data/replays/tokyo.json holds one).
const TOKYO = recordingFor("Tokyo")!;

// A small recording, for the paths that don't need the real one.
const tiny: Recording = {
  recordedAt: "2026-10-24T09:00:00.000Z",
  events: [
    { type: "start", city: "Tokyo", focus: "all", qlooMode: "live", llmMode: "claude", budget: 40, model: "m", t: 1 },
    { type: "step", id: "s1", phase: "profile", title: "Listing neighbourhoods in Tokyo", t: 500 },
    { type: "done", callsUsed: 0, budget: 40, cards: 0, t: 900 },
  ],
};

const TOKYO_ALL = { city: "Tokyo", focus: "all" } as const;
const mustNotRunLive: ExploreDeps["explore"] = async () => assert.fail("nothing may run live here");
const card = { id: "c1", category: "Bagels" } as unknown as OpportunityCard;
const liveStart = (city: string): AgentEvent => ({ type: "start", city, focus: "all", qlooMode: "live", llmMode: "none", budget: 40 });

test("recordings: Tokyo has one, from its own start to done; a placeholder file counts as none", () => {
  assert.ok(TOKYO, "Tokyo has a recording");
  assert.equal(TOKYO.events[0].type, "start");
  assert.equal(TOKYO.events.at(-1)?.type, "done");
  assert.ok(!TOKYO.events.some((e) => e.type === "error" || e.type === "replay"));
  for (const city of ["New York", "Seoul"]) {
    const rec = recordingFor(city);
    if (rec) assert.equal((rec.events[0] as Extract<AgentEvent, { type: "start" }>).city, city, `${city}'s recording is a run of ${city}`);
  }
  assert.equal(recordingFor("Paris"), null);
});

test("EXPLORE_FORCE_REPLAY=1: the route streams replay, then the recording from start to done, unchanged", async () => {
  resetLimits();
  process.env.EXPLORE_FORCE_REPLAY = "1";
  try {
    const { POST } = await import("../src/app/api/explore/route");
    const res = await POST(post("tokyo"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /ndjson/);
    const events = await lines(res);
    assert.deepEqual(withoutT(events[0]), { type: "replay", recordedAt: TOKYO.recordedAt, reason: REPLAY_REASON.forced });
    const start = events[1];
    const recorded = TOKYO.events[0];
    assert.ok(start.type === "start" && recorded.type === "start");
    assert.equal(start.qlooMode, recorded.qlooMode, "the replay's start says which Qloo mode it really ran in");
    assert.equal(start.llmMode, recorded.llmMode, "and which agent");
    assert.equal(events.at(-1)?.type, "done");
    assert.deepEqual(events.slice(1).map(withoutT), TOKYO.events.map(withoutT), "the recorded events, in their order");
    assert.ok(events.every((e) => typeof e.t === "number"), "every line is stamped");
    assert.equal(runningCount(), 0, "a replay takes no live slot");

    // A city with no recording says so instead of running live.
    const none = exploreResponse({ city: "Seoul", focus: "all" }, post("Seoul"), { recording: () => null, explore: mustNotRunLive });
    assert.equal(none.status, 503);
    assert.match((await none.json()).error, /no recorded run/);
  } finally {
    delete process.env.EXPLORE_FORCE_REPLAY;
  }
});

test("a refused admit() replays when a recording exists (200, Retry-After kept) and 429s when not", async () => {
  resetLimits();
  process.env.EXPLORE_MAX_CONCURRENT = "1";
  const held = admit("9.9.9.9");
  assert.ok(held.ok);
  try {
    const { POST } = await import("../src/app/api/explore/route");
    const res = await POST(post("Tokyo"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("retry-after"), "60");
    const events = await lines(res);
    assert.deepEqual(withoutT(events[0]), { type: "replay", recordedAt: TOKYO.recordedAt, reason: REPLAY_REASON.busy });
    assert.equal(events[1].type, "start");
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(runningCount(), 1, "the replay took no slot of its own");

    const refused = exploreResponse({ city: "New York", focus: "all" }, post("New York"), { recording: () => null, explore: mustNotRunLive });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "60");
    assert.match((await refused.json()).error, /already running/);
  } finally {
    if (held.ok) held.release();
    delete process.env.EXPLORE_MAX_CONCURRENT;
    resetLimits();
  }

  // The per-visitor hourly limit (production only) replays with its own reason.
  const env = process.env as Record<string, string | undefined>;
  const nodeEnv = env.NODE_ENV;
  env.NODE_ENV = "production";
  env.EXPLORE_RUNS_PER_IP_PER_HOUR = "1";
  try {
    const first = admit("5.5.5.5");
    assert.ok(first.ok);
    if (first.ok) first.release();
    const res = exploreResponse(TOKYO_ALL, post("Tokyo", { "x-forwarded-for": "5.5.5.5" }), { recording: () => tiny, explore: mustNotRunLive });
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    const events = await lines(res);
    assert.deepEqual(withoutT(events[0]), { type: "replay", recordedAt: tiny.recordedAt, reason: REPLAY_REASON.hourly });
    assert.deepEqual(types(events), ["replay", "start", "step", "done"]);
  } finally {
    env.NODE_ENV = nodeEnv;
    delete env.EXPLORE_RUNS_PER_IP_PER_HOUR;
    resetLimits();
  }
});

test("a live run that fails before any card is replaced by the recording; later failures are not", async () => {
  resetLimits();
  const run = (explore: ExploreDeps["explore"], recording: Recording | null = tiny) => exploreResponse(TOKYO_ALL, post("Tokyo"), { explore, recording: () => recording }).text().then((t) => t.trim().split("\n").map((l) => JSON.parse(l) as Line));

  // explore() throws.
  const thrown = await run(async (req, emit) => {
    emit(liveStart(req.city));
    emit({ type: "step", id: "s1", phase: "profile", title: "Listing neighbourhoods in Tokyo" });
    throw new Error("Qloo rejected the API key");
  });
  assert.deepEqual(types(thrown), ["start", "step", "replay", "start", "step", "done"], "the partial live run, then the recording");
  assert.deepEqual(withoutT(thrown[2]), { type: "replay", recordedAt: tiny.recordedAt, reason: REPLAY_REASON.failed("Qloo rejected the API key") });
  assert.match(REPLAY_REASON.failed("Qloo rejected the API key"), /before it found anything \(Qloo rejected the API key\)/);
  assert.equal(runningCount(), 0, "the live slot is released");

  // explore() emits an error event and would carry on: the rest is dropped and the run is told to stop.
  let stopped = false;
  const reported = await run(async (req, emit, { signal }) => {
    emit(liveStart(req.city));
    emit({ type: "error", message: "Qloo is down" });
    stopped = signal.aborted;
    emit({ type: "step", id: "s9", phase: "think", title: "still going" });
    emit({ type: "done", callsUsed: 1, budget: 40, cards: 0 });
  });
  assert.deepEqual(types(reported), ["start", "replay", "start", "step", "done"]);
  assert.ok(stopped, "the live run's signal is aborted");
  assert.equal(runningCount(), 0);

  // Once a card is out, an error stays an error: the cards stay on screen.
  const late = await run(async (req, emit) => {
    emit(liveStart(req.city));
    emit({ type: "card", card });
    throw new Error("Used the whole Qloo call budget");
  });
  assert.deepEqual(types(late), ["start", "card", "error"]);

  // With no recording, an early failure is shown as before.
  const bare = await run(async (req, emit) => {
    emit(liveStart(req.city));
    throw new Error("Qloo is down");
  }, null);
  assert.deepEqual(types(bare), ["start", "error"]);
  assert.equal(runningCount(), 0);
});

test("a finished live run with zero cards is a valid answer, not replaced", async () => {
  resetLimits();
  const events = await lines(
    exploreResponse(TOKYO_ALL, post("Tokyo"), {
      recording: () => tiny,
      explore: async (req, emit) => {
        emit(liveStart(req.city));
        emit({ type: "step", id: "s1", phase: "compare", title: "Comparing Shibuya with Brooklyn" });
        emit({ type: "done", callsUsed: 12, budget: 40, cards: 0 });
      },
    }),
  );
  assert.deepEqual(types(events), ["start", "step", "done"]);
  assert.equal(runningCount(), 0);

  // The same through the route and the mock pipeline, for a city that has a recording
  // (on the mock data, Tokyo retail finds nothing): whatever it finds stays live.
  const { POST } = await import("../src/app/api/explore/route");
  const live = await lines(await POST(post("Tokyo", {}, "retail")));
  assert.equal(live[0].type, "start");
  assert.equal(live.at(-1)?.type, "done");
  assert.ok(!live.some((e) => e.type === "replay"));
  assert.equal(runningCount(), 0);
});

test("pacing: a 90 s run plays in 15-25 s, in order, never slower than it ran", async () => {
  // A 90 s run with a long first think, like a Claude run.
  const times: number[] = [1, 21_800];
  while (times.length < 106) times.push(times.at(-1)! + 200 + ((times.length * 7919) % 1100));
  const scale = (90_000 - 21_800) / (times.at(-1)! - 21_800);
  const ninety = times.map((t, i) => (i < 2 ? t : Math.round(21_800 + (t - 21_800) * scale)));
  assert.equal(ninety.at(-1), 90_000);
  const gaps = ninety.map((t, i) => t - (i ? ninety[i - 1] : 0));

  const delays = replayDelays(ninety, 20_000);
  const total = sum(delays);
  assert.ok(total >= 15_000 && total <= 25_000, `plays in ${total} ms`);
  delays.forEach((d, i) => {
    assert.ok(d >= 0 && d <= gaps[i], `pause ${i} is never longer than the original`);
    assert.ok(d <= MAX_REPLAY_GAP_MS);
  });

  // The real recording too.
  const real = TOKYO.events.map((e) => e.t);
  const realTotal = sum(replayDelays(real, 20_000));
  assert.ok(realTotal <= Math.max(...real.map((t) => t ?? 0)), "never longer than the recording");
  assert.ok(realTotal <= 25_000);

  // A short run plays at its own speed or faster, never stretched to the target.
  assert.ok(sum(replayDelays([0, 1_000, 2_500, 5_000], 20_000)) <= 5_000);
  // Missing or out-of-order times never produce a negative or invented pause.
  assert.deepEqual(replayDelays([undefined, 100, undefined, 50, 300], 20_000), [0, 100, 0, 0, 200]);
  assert.deepEqual(replayDelays(ninety, 0), ninety.map(() => 0));

  // playRecording waits those pauses and emits the events in their recorded order.
  const waited: number[] = [];
  const out: AgentEvent[] = [];
  await playRecording(TOKYO, "test", (e) => out.push(e), { signal: new AbortController().signal, targetMs: 20_000, wait: async (ms) => void waited.push(ms) });
  assert.equal(out[0].type, "replay");
  assert.deepEqual(out.slice(1), TOKYO.events);
  assert.ok(sum(waited) <= 25_000);

  // A viewer who leaves stops the replay: here, during the pause after "start".
  const ac = new AbortController();
  const cut: AgentEvent[] = [];
  let pauses = 0;
  await playRecording(tiny, "test", (e) => cut.push(e), {
    signal: ac.signal,
    targetMs: 20_000,
    wait: async () => {
      if (++pauses === 2) ac.abort();
    },
  });
  assert.deepEqual(types(cut), ["replay", "start"]);
});

test("the page drops the partial live run on a replay event and keeps the banner until the next run", () => {
  const ev = (event: AgentEvent | RecordedEvent) => (s: RunState) => reducer(s, { type: "event", event });
  let s = initialState("Tokyo", { qlooMode: "live", llmMode: "claude", budget: 40 });
  s = reducer(s, { type: "reset", city: "Tokyo", focus: "dining" });
  s = ev({ type: "start", city: "Tokyo", focus: "dining", qlooMode: "live", llmMode: "claude", budget: 40 })(s);
  s = ev({ type: "step", id: "s1", phase: "profile", title: "a live step" })(s);
  s = ev({ type: "replay", recordedAt: TOKYO.recordedAt, reason: REPLAY_REASON.busy })(s);
  assert.equal(s.steps.length, 0, "the partial live run is gone");
  assert.equal(s.status, "connecting");
  assert.deepEqual(s.replay, { recordedAt: TOKYO.recordedAt, reason: REPLAY_REASON.busy });

  for (const e of TOKYO.events) s = ev(e)(s);
  const recorded = TOKYO.events[0] as Extract<AgentEvent, { type: "start" }>;
  assert.equal(s.status, "done");
  assert.equal(s.meta.qlooMode, recorded.qlooMode);
  assert.equal(s.meta.llmMode, recorded.llmMode);
  assert.equal(s.focus, recorded.focus, "the focus shown is the one the recording ran with");
  assert.ok(s.replay, "the banner stays while the recording is on screen");

  s = reducer(s, { type: "reset", city: "Tokyo", focus: "all" });
  assert.equal(s.replay, null, "a new run clears it");
});
