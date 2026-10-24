import type { Replay } from "./useExploreRun";

// "2026-10-24T09:21:40Z" -> "24 Oct 2026" (UTC, so every viewer sees the same day).
export function recordedDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "an earlier run" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Shown for as long as a recorded run is on screen, so it is never taken for a live one.
export function ReplayBanner({ replay, className = "" }: { replay: Replay; className?: string }) {
  const reason = replay.reason.trim().replace(/[.\s]+$/, "");
  return (
    <p role="status" className={`rounded-xl border border-doubt/30 bg-doubt/10 px-3 py-2 text-[12px] leading-snug text-doubt ${className}`}>
      <span className="font-semibold">
        Recorded run from {recordedDay(replay.recordedAt)}, not live
        {reason ? ":" : "."}
      </span>
      {reason && ` ${reason}.`}
    </p>
  );
}
