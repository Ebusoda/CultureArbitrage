import { CITIES } from "@/lib/cities";
import { exploreResponse } from "@/lib/explore-stream";
import { currentModes } from "@/lib/agent/run";
import { FOCUSES, parseExploreBody } from "@/lib/agent/request";

// A Claude run takes a few minutes; Vercel cuts functions off at this many seconds.
// src/lib/explore-stream.ts ends a replay before this too: keep the two in step.
export const maxDuration = 300;

const bad = (status: number, error: string) => Response.json({ error }, { status });

// What can be explored and which modes are on. Never exposes keys.
export function GET() {
  return Response.json({ cities: CITIES, focuses: FOCUSES, modes: currentModes() }, { headers: { "Cache-Control": "no-store" } });
}

// Streams the agent's progress as newline-delimited JSON, one AgentEvent per line,
// each stamped with t = ms since the run started. When a live run can't start (too busy,
// hourly limit) or fails before it found anything, the city's recorded run is streamed
// instead, after a "replay" event that says so (src/lib/explore-stream.ts).
export async function POST(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (type && !type.includes("application/json")) return bad(415, "Send the request as application/json.");
  const parsed = parseExploreBody(await request.text().catch(() => ""));
  if ("error" in parsed) return bad(parsed.status, parsed.error);
  return exploreResponse({ city: parsed.city, focus: parsed.focus }, request);
}
