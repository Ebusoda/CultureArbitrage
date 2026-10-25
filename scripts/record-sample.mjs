// Records one exploration. Start the app first (npm run dev), then:
//   node scripts/record-sample.mjs [city] [focus] [baseUrl] [--out <file>]
// Without --out it writes src/data/sample-run.json, shown on the page as
// "Example from a recorded run". With --out src/data/replays/<slug>.json it writes the
// city's recorded-run fallback (slug: tokyo, new-york, seoul), played when a live run
// can't run or fails before it finds anything (src/lib/replay.ts).
// Written from Node so the file is UTF-8 (PowerShell's > would write UTF-16).
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let outArg = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") {
    outArg = args[++i];
    if (!outArg) throw new Error("--out needs a file path, e.g. --out src/data/replays/seoul.json");
  } else if (a.startsWith("--out=")) {
    outArg = a.slice("--out=".length);
  } else {
    positional.push(a);
  }
}
const [city = "Tokyo", focus = "all", base = "http://localhost:3000"] = positional;
const out = outArg ? resolve(process.cwd(), outArg) : fileURLToPath(new URL("../src/data/sample-run.json", import.meta.url));
if (!out.endsWith(".json")) throw new Error(`--out must name a .json file, not ${out}`);

const res = await fetch(`${base}/api/explore`, {
  method: "POST",
  // In production (`npm start`, a deployment) the route only takes requests from the site's own
  // origin, so say we are that site, as a browser on the page would.
  headers: { "Content-Type": "application/json", Origin: new URL(base).origin },
  body: JSON.stringify({ city, focus }),
});
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

const events = (await res.text())
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
// A busy server, a spent hourly limit, a failed live run or EXPLORE_FORCE_REPLAY answer with a
// recording; saving that again would pass an old run off under a new date.
if (events.some((e) => e.type === "replay")) {
  throw new Error("The server played a recorded run instead of a live one (busy, hourly limit, a failed live run, or EXPLORE_FORCE_REPLAY=1). Fix that and record again.");
}
const error = events.find((e) => e.type === "error");
if (error) throw new Error(`The run failed: ${error.message}`);
// The same shape src/lib/replay.ts (usableRecording) accepts: its own start first, done last.
const start = events[0]?.type === "start" ? events[0] : null;
const done = events.at(-1)?.type === "done" ? events.at(-1) : null;
if (!start) throw new Error(`The first event is ${events[0]?.type ?? "missing"}, not "start". Record again.`);
if (!done) throw new Error("The run was cut off before it finished (the last event is not \"done\").");

// Google's terms don't allow storing Places results, and this file ships with the page.
if (events.some((e) => e.card?.google || e.card?.googleSkipped) || JSON.stringify(events).includes("Google Maps")) {
  throw new Error("This run used the Google Maps cross-check, whose results may not be stored. Remove GOOGLE_MAPS_API_KEY from .env.local, restart npm run dev, and record again.");
}

// src/lib/replay.ts looks a city's fallback up by file name, and only plays it for that city.
if (basename(dirname(out)) === "replays") {
  // A recorded run stands in for a live one: made-up mock data must not be shown as that.
  if (start.qlooMode !== "live") throw new Error(`This run used ${start.qlooMode ?? "unknown"} Qloo data. A replay must be a live run: set QLOO_MODE=live and QLOO_API_KEY, restart npm run dev, and record again.`);
  const slug = String(start?.city ?? city).trim().toLowerCase().replace(/\s+/g, "-");
  if (basename(out) !== `${slug}.json`) throw new Error(`This is a run of ${start?.city ?? city}; save it as src/data/replays/${slug}.json.`);
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ recordedAt: new Date().toISOString(), events }, null, 1) + "\n", "utf8");
console.log(`Saved ${events.length} events, ${done.cards} opportunities, ${done.callsUsed}/${done.budget} Qloo calls to ${out}.`);
if (done.cards === 0) console.log("Note: this run found no opportunities. That is a valid answer, but a thin fallback for the demo.");
