import { CITIES } from "@/lib/cities";
import { exploreResponse } from "@/lib/explore-stream";
import { currentModes } from "@/lib/agent/run";
import { FOCUSES, checkExploreHeaders, parseExploreBody, readExploreBody } from "@/lib/agent/request";

// A Claude run takes a few minutes; Vercel cuts functions off at this many seconds.
// src/lib/explore-stream.ts ends a replay before this too: keep the two in step.
// vercel.json turns on request cancellation for this route, so a viewer who leaves
// stops the run (and its Qloo, Claude and Google calls) instead of it running on.
export const maxDuration = 300;

const bad = (status: number, error: string) => Response.json({ error }, { status });

// What can be explored and which modes are on. Never exposes keys.
export function GET() {
  return Response.json({ cities: CITIES, focuses: FOCUSES, modes: currentModes() }, { headers: { "Cache-Control": "no-store" } });
}

// Streams the agent's progress as newline-delimited JSON, one AgentEvent per line,
// each stamped with t = ms since the run started. When a live run can't start (too busy,
// hourly limit, live runs switched off) or fails before it found anything, the city's
// recorded run is streamed instead, after a "replay" event that says so (src/lib/explore-stream.ts).
export async function POST(request: Request) {
  const refused = checkExploreHeaders(request.headers);
  if (refused) return bad(refused.status, refused.error);
  // Over 2 KB is refused from Content-Length, before the body is read.
  const body = await readExploreBody(request);
  if ("error" in body) return bad(body.status, body.error);
  const parsed = parseExploreBody(body.text);
  if ("error" in parsed) return bad(parsed.status, parsed.error);
  return exploreResponse({ city: parsed.city, focus: parsed.focus }, request);
}
