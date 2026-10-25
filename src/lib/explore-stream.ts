import { explore as exploreLive } from "./agent/run";
import type { AgentEvent, ExploreRequest } from "./agent/types";
import { config } from "./config";
import { GooglePlacesError } from "./google/places";
import { BudgetExceededError, QlooError, type QlooErrorKind } from "./qloo";
import { admit, clientIp } from "./limits";
import { playRecording, recordingFor, type Recording } from "./replay";

// The body of POST /api/explore once the request is valid: a live exploration streamed as
// newline-delimited JSON, or the city's recorded run when a live one can't run or fails
// before it found anything, so the public demo never shows an empty page.

type Emit = (e: AgentEvent) => void;

export interface ExploreDeps {
  explore: (req: ExploreRequest, emit: Emit, opts: { deadline: number; signal: AbortSignal }) => Promise<void>;
  recording: (city: string) => Recording | null;
}

// Why a recording is shown instead of a live run; the page prints it on the replay banner.
export const REPLAY_REASON = {
  forced: "Live runs are switched off right now",
  busy: "Live runs are busy right now",
  hourly: "You've reached the hourly limit for live runs",
  failed: (message: string) => `The live run stopped before it found anything (${clip(message, 120)})`,
};

// route.ts sets maxDuration = 300 s: a replay after a long failed live run has to end before that.
const STREAM_LIMIT_MS = 285_000;

const NDJSON = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" };

// What the page may say about a failure. Upstream error text (Qloo, Google or Anthropic
// bodies, internal TypeErrors) can hold anything, so the page gets a short fixed sentence per
// kind of failure and the full error goes to the server log.
const QLOO_PUBLIC: Record<QlooErrorKind, string> = {
  auth: "Qloo rejected the API key",
  not_found: "The Qloo address is set up wrongly",
  bad_request: "Qloo did not accept a request",
  rate_limit: "Qloo is rate-limiting",
  server: "Qloo is having server trouble",
  timeout: "Qloo did not answer in time",
  network: "Qloo could not be reached",
  bad_response: "Qloo sent an answer that could not be read",
  aborted: "The run was cancelled",
};

export function publicErrorMessage(e: unknown): string {
  if (e instanceof BudgetExceededError) return e.message;
  if (e instanceof QlooError) return QLOO_PUBLIC[e.kind] ?? "Qloo failed";
  if (e instanceof GooglePlacesError) return "The Google Maps cross-check failed";
  return "The live run hit an unexpected error";
}

const errorMessage = (e: unknown) => {
  console.error("[explore]", e);
  return publicErrorMessage(e);
};

function clip(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const jsonError = (status: number, error: string, headers?: Record<string, string>) => Response.json({ error }, { status, headers });

export function exploreResponse(req: ExploreRequest, request: Request, deps: Partial<ExploreDeps> = {}): Response {
  const explore = deps.explore ?? exploreLive;
  const recording = (deps.recording ?? recordingFor)(req.city);

  // Testing, or an emergency switch: nothing runs live.
  if (config.forceReplay()) {
    if (!recording) return jsonError(503, `Live runs are off right now, and ${req.city} has no recorded run yet.`);
    return replayResponse(request, recording, REPLAY_REASON.forced);
  }

  const slot = admit(clientIp(request));
  if (!slot.ok) {
    const headers = { "Retry-After": String(slot.retryAfterSec) };
    if (!recording) return jsonError(slot.status, slot.error, headers);
    return replayResponse(request, recording, slot.reason === "hourly" ? REPLAY_REASON.hourly : REPLAY_REASON.busy, headers);
  }

  // When the viewer leaves, Vercel (with supportsCancellation in vercel.json) aborts
  // request.signal and then ends the function, possibly before the finally below runs.
  // Free the live slot right away, so a reused instance doesn't count a dead run.
  if (request.signal.aborted) slot.release();
  else request.signal.addEventListener("abort", () => slot.release(), { once: true });

  return ndjson(
    request,
    async (emit, signal, t0) => {
      // Stops the live run once a recording replaces it.
      const replaced = new AbortController();
      let cards = 0;
      let failed = null as string | null;
      // A run that fails before any card is replaced by the recording. Cards already shown
      // stay, with the error after them, and a finished run with no cards is a real answer.
      const forward: Emit = (e) => {
        if (failed !== null) return;
        if (e.type === "card") cards++;
        if (e.type === "error" && cards === 0 && recording && !signal.aborted) {
          failed = e.message;
          replaced.abort();
          return;
        }
        emit(e);
      };
      try {
        await explore(req, forward, { deadline: t0 + config.timeBudgetMs(), signal: AbortSignal.any([signal, replaced.signal]) });
      } catch (err) {
        forward({ type: "error", message: errorMessage(err) });
      } finally {
        slot.release();
      }
      if (failed !== null && recording && !signal.aborted) {
        const targetMs = Math.min(config.replayMs(), Math.max(0, t0 + STREAM_LIMIT_MS - Date.now()));
        await playRecording(recording, REPLAY_REASON.failed(failed), emit, { signal, targetMs });
      }
    },
    { onCancel: () => slot.release() },
  );
}

function replayResponse(request: Request, recording: Recording, reason: string, headers?: Record<string, string>): Response {
  return ndjson(request, (emit, signal) => playRecording(recording, reason, emit, { signal, targetMs: config.replayMs() }), { headers });
}

// One AgentEvent per line, each stamped with t = ms since the response started. The signal
// passed to body aborts when the viewer goes away.
function ndjson(
  request: Request,
  body: (emit: Emit, signal: AbortSignal, t0: number) => Promise<void>,
  opts: { headers?: Record<string, string>; onCancel?: () => void } = {},
): Response {
  const t0 = Date.now();
  const encoder = new TextEncoder();
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal]);
  // closed: the stream takes no more (closed, errored, or cancelled by the viewer). An event
  // that can't be serialised is skipped on its own and closes nothing.
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: Emit = (e) => {
        if (closed) return;
        let line: string;
        try {
          line = JSON.stringify({ ...e, t: Date.now() - t0 }) + "\n";
        } catch (err) {
          console.error("[explore] skipped an event that could not be serialised:", (e as { type?: unknown })?.type, err);
          return;
        }
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          closed = true;
        }
      };
      try {
        await body(emit, signal, t0);
      } catch (err) {
        emit({ type: "error", message: errorMessage(err) });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      }
    },
    cancel() {
      closed = true;
      cancelled.abort();
      opts.onCancel?.();
    },
  });

  return new Response(stream, { headers: { ...NDJSON, ...opts.headers } });
}
