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

// The key the hourly limit counts under. One IPv6 subscriber usually gets a whole /64, so
// rotating through it must not buy more runs: IPv6 addresses count per /64. IPv4 (also
// written as ::ffff:1.2.3.4) counts per address.
export function ipBucket(ip: string): string {
  let a = ip.trim().toLowerCase();
  if (a.startsWith("[")) a = a.slice(1, a.indexOf("]") > 0 ? a.indexOf("]") : undefined);
  a = a.split("%")[0];
  // IPv4 with a port.
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(a)) a = a.split(":")[0];
  if (!a.includes(":")) return a;
  const v4 = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (v4) return v4[1];
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length < 4 || groups.some((g) => !/^[0-9a-f]{0,4}$/.test(g))) return a;
  return `${groups
    .slice(0, 4)
    .map((g) => (g.replace(/^0+/, "") || "0"))
    .join(":")}::/64`;
}

// The per-visitor hourly limit only applies in production (Vercel), so local
// testing with `npm run dev` is never blocked.
export function admit(rawIp: string, now = Date.now()): Admission {
  const ip = ipBucket(rawIp);
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
