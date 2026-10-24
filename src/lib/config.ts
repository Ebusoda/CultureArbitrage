// Server-side settings read from environment variables, with defaults and
// sane bounds, so a typo in .env.local can't produce a zero or a huge budget.

export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${name}=${raw} is not a number, using ${fallback}`);
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

export const config = {
  // Max Qloo calls per exploration.
  callBudget: () => envInt("QLOO_CALL_BUDGET", 40, 1, 200),
  // No new lookups after this long; the run finishes with what it has.
  timeBudgetMs: () => envInt("EXPLORE_TIME_BUDGET_MS", 150_000, 10_000, 280_000),
  mockDelayMs: () => envInt("MOCK_DELAY_MS", 350, 0, 5_000),
  // Per-request timeout and retries for the live Qloo client.
  qlooTimeoutMs: () => envInt("QLOO_TIMEOUT_MS", 10_000, 1_000, 60_000),
  qlooRetries: () => envInt("QLOO_RETRIES", 2, 0, 4),
  // How long identical Qloo requests are answered from memory. 0 turns the cache off.
  qlooCacheTtlMs: () => envInt("QLOO_CACHE_TTL_MS", 6 * 3600_000, 0, 7 * 24 * 3600_000),
  // Max Google Maps requests (result pages) per exploration, for the cross-check.
  googleCallBudget: () => envInt("GOOGLE_CALL_BUDGET", 24, 0, 200),
  // Max Google Maps requests per UTC day, per server instance (the console won't lower Google's own quota).
  googleDailyLimit: () => envInt("GOOGLE_DAILY_LIMIT", 300, 0, 100_000),
  // Protects the public demo's Qloo and Claude credit.
  maxConcurrentRuns: () => envInt("EXPLORE_MAX_CONCURRENT", 3, 1, 50),
  runsPerIpPerHour: () => envInt("EXPLORE_RUNS_PER_IP_PER_HOUR", 20, 1, 10_000),
  // EXPLORE_FORCE_REPLAY=1: every request plays the city's recorded run instead of running live.
  forceReplay: () => ["1", "true"].includes((process.env.EXPLORE_FORCE_REPLAY ?? "").trim().toLowerCase()),
  // How long a recorded run takes to play back (it never plays slower than it ran live).
  replayMs: () => envInt("EXPLORE_REPLAY_SECONDS", 20, 0, 120) * 1000,
};
