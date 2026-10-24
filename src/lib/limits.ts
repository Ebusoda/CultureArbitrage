import { config } from "./config";

// In-memory guards for the public demo, so a burst of visitors (or a script)
// can't drain the Qloo quota or the Claude credit. On Vercel each warm instance
// keeps its own counts, so this is best-effort, not a hard global limit.

let running = 0;
const recent = new Map<string, number[]>();
const HOUR = 3600_000;

// reason: "busy" when the concurrency cap is hit, "hourly" when this visitor used up the hour.
export type Admission = { ok: true; release: () => void } | { ok: false; status: 429; reason: "busy" | "hourly"; error: string; retryAfterSec: number };

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0].trim() || request.headers.get("x-real-ip")?.trim() || "local";
}

// The per-visitor hourly limit only applies in production (Vercel), so local
// testing with `npm run dev` is never blocked.
export function admit(ip: string, now = Date.now()): Admission {
  if (running >= config.maxConcurrentRuns()) {
    return { ok: false, status: 429, reason: "busy", error: "Several explorations are already running. Please try again in a minute.", retryAfterSec: 60 };
  }
  if (process.env.NODE_ENV === "production") {
    const times = (recent.get(ip) ?? []).filter((t) => now - t < HOUR);
    const limit = config.runsPerIpPerHour();
    if (times.length >= limit) {
      const retryAfterSec = Math.ceil((times[0] + HOUR - now) / 1000);
      return { ok: false, status: 429, reason: "hourly", error: `You have started ${limit} explorations in the last hour. Please try again later.`, retryAfterSec };
    }
    times.push(now);
    recent.set(ip, times);
    if (recent.size > 5_000) recent.delete(recent.keys().next().value!);
  }
  running++;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      running--;
    },
  };
}

export function runningCount() {
  return running;
}

export function resetLimits() {
  running = 0;
  recent.clear();
}
