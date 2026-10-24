// Records one exploration into src/data/sample-run.json, shown on the page as
// "Example from a recorded run". Start the app first (npm run dev), then:
//   node scripts/record-sample.mjs [city] [focus] [baseUrl]
// Written from Node so the file is UTF-8 (PowerShell's > would write UTF-16).
import { writeFile } from "node:fs/promises";

const [city = "Tokyo", focus = "all", base = "http://localhost:3000"] = process.argv.slice(2);
const res = await fetch(`${base}/api/explore`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ city, focus }),
});
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

const events = (await res.text())
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const done = events.find((e) => e.type === "done");
const error = events.find((e) => e.type === "error");
if (error) throw new Error(`The run failed: ${error.message}`);
if (!done) throw new Error("The run was cut off before it finished.");

const out = new URL("../src/data/sample-run.json", import.meta.url);
await writeFile(out, JSON.stringify({ recordedAt: new Date().toISOString(), events }, null, 1) + "\n", "utf8");
console.log(`Saved ${events.length} events, ${done.cards} opportunities, ${done.callsUsed}/${done.budget} Qloo calls.`);
