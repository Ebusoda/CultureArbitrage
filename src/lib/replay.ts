import type { AgentEvent } from "./agent/types";
import sampleRun from "../data/sample-run.json";
import newYork from "../data/replays/new-york.json";
import seoul from "../data/replays/seoul.json";
import tokyo from "../data/replays/tokyo.json";

// Recorded runs, played back when a live exploration can't run or fails before it found
// anything, so the public demo never shows an empty page. Always labelled as a recording.
//
// Recordings are imported statically so they ship inside the serverless bundle. Each city
// has a file in src/data/replays/<slug>.json; one with no events is a placeholder. Recording
// over it (node scripts/record-sample.mjs "<City>" all --out src/data/replays/<slug>.json)
// needs no code change. A new city needs one import and one line in RECORDINGS.

export type RecordedEvent = AgentEvent & { t?: number };

export interface Recording {
  recordedAt: string;
  events: RecordedEvent[];
}

// Per city slug, best first: the first usable recording is played.
const RECORDINGS: Record<string, unknown[]> = {
  tokyo: [tokyo, sampleRun],
  "new-york": [newYork],
  seoul: [seoul],
};

// "New York" -> "new-york"
export function replaySlug(city: string): string {
  return city.trim().toLowerCase().replace(/\s+/g, "-");
}

// A recording is usable if it is a whole run of this city: its own start to a done,
// with no error in between, and not itself a replay.
export function usableRecording(raw: unknown, city: string): Recording | null {
  if (!raw || typeof raw !== "object") return null;
  const { recordedAt, events } = raw as { recordedAt?: unknown; events?: unknown };
  if (typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt))) return null;
  if (!Array.isArray(events) || events.length < 2) return null;
  if (!events.every((e) => e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string")) return null;
  const list = events as RecordedEvent[];
  const start = list[0];
  if (start.type !== "start" || start.city !== city || list.at(-1)?.type !== "done") return null;
  if (list.some((e) => e.type === "error" || e.type === "replay")) return null;
  return { recordedAt, events: list };
}

// The recording to play for a city, or null if there is none yet.
export function recordingFor(city: string): Recording | null {
  for (const raw of RECORDINGS[replaySlug(city)] ?? []) {
    const rec = usableRecording(raw, city);
    if (rec) return rec;
  }
  return null;
}

// Longest pause between two events in a replay: a long silence reads as a hang.
export const MAX_REPLAY_GAP_MS = 2_500;

// The pause before each event, so the recording plays in about targetMs. The recorded gaps
// are scaled by one factor (at most 1, so a replay is never slower than the original run)
// and each is capped at maxGapMs, so the order and the rhythm of the run stay visible.
// Events without a time follow the previous one at once.
export function replayDelays(times: (number | undefined)[], targetMs: number, maxGapMs = MAX_REPLAY_GAP_MS): number[] {
  const gaps: number[] = [];
  let prev = 0;
  for (const t of times) {
    const now = typeof t === "number" && Number.isFinite(t) ? Math.max(prev, t) : prev;
    gaps.push(now - prev);
    prev = now;
  }
  const target = Math.max(0, targetMs);
  const length = (f: number) => gaps.reduce((sum, g) => sum + Math.min(g * f, maxGapMs), 0);
  let factor = 1;
  if (length(1) > target) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (length(mid) <= target) lo = mid;
      else hi = mid;
    }
    factor = lo;
  }
  return gaps.map((g) => Math.floor(Math.min(g * factor, maxGapMs)));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

// Streams a recording: a "replay" event saying when it was recorded and why it is shown
// instead of a live run, then the recorded events in their original order, paced.
export async function playRecording(
  rec: Recording,
  reason: string,
  emit: (e: AgentEvent) => void,
  opts: { signal: AbortSignal; targetMs: number; wait?: (ms: number, signal: AbortSignal) => Promise<void> },
): Promise<void> {
  const wait = opts.wait ?? sleep;
  emit({ type: "replay", recordedAt: rec.recordedAt, reason });
  const delays = replayDelays(rec.events.map((e) => e.t), opts.targetMs);
  for (let i = 0; i < rec.events.length; i++) {
    if (delays[i] > 0) await wait(delays[i], opts.signal);
    if (opts.signal.aborted) return;
    emit(rec.events[i]);
  }
}
