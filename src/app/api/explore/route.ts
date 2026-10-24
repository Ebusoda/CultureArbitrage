import { CITIES } from "@/lib/cities";
import { config } from "@/lib/config";
import { admit, clientIp } from "@/lib/limits";
import { currentModes, explore } from "@/lib/agent/run";
import { FOCUSES, parseExploreBody } from "@/lib/agent/request";
import type { AgentEvent } from "@/lib/agent/types";

// A Claude run takes a few minutes; Vercel cuts functions off at this many seconds.
export const maxDuration = 300;

const bad = (status: number, error: string, headers?: HeadersInit) => Response.json({ error }, { status, headers });

// What can be explored and which modes are on. Never exposes keys.
export function GET() {
  return Response.json({ cities: CITIES, focuses: FOCUSES, modes: currentModes() }, { headers: { "Cache-Control": "no-store" } });
}

// Streams the agent's progress as newline-delimited JSON, one AgentEvent per line,
// each stamped with t = ms since the run started.
export async function POST(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (type && !type.includes("application/json")) return bad(415, "Send the request as application/json.");
  const parsed = parseExploreBody(await request.text().catch(() => ""));
  if ("error" in parsed) return bad(parsed.status, parsed.error);
  const { city, focus } = parsed;

  const slot = admit(clientIp(request));
  if (!slot.ok) return bad(slot.status, slot.error, { "Retry-After": String(slot.retryAfterSec) });

  const t0 = Date.now();
  const deadline = t0 + config.timeBudgetMs();
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ ...e, t: Date.now() - t0 }) + "\n"));
        } catch {
          closed = true;
        }
      };
      try {
        await explore({ city, focus }, emit, { deadline, signal: request.signal });
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        slot.release();
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      slot.release();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
