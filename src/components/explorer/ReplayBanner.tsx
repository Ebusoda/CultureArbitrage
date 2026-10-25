import type { AskedTarget, Focus } from "@/lib/agent/types";
import { focusName, withArticle } from "./format";
import { sameTarget, type Replay } from "./useExploreRun";

// "2026-10-24T09:21:40Z" -> "24 Oct 2026" (UTC, so every viewer sees the same day).
export function recordedDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "an earlier run" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

interface Props {
  replay: Replay;
  className?: string;
  announce?: boolean;
  // The focus the recording ran with, and the one the visitor asked for, when known.
  focus?: Focus;
  askedFocus?: Focus;
  // The business type the visitor asked to check, and the one the recording checks (recordings
  // are scans: none). Only set when the visitor asked about one business type.
  askedTarget?: AskedTarget | null;
  runTarget?: AskedTarget | null;
}

// Shown for as long as a recorded run is on screen, so it is never taken for a live one.
// The banner appears twice on the page; only one copy is a status region, so it is announced once.
export function ReplayBanner({ replay, className = "", announce = true, focus, askedFocus, askedTarget = null, runTarget = null }: Props) {
  const reason = replay.reason.trim().replace(/[.\s]+$/, "");
  // Recordings exist per city, not per focus or business type, so say so when the recording
  // answers another question.
  const otherTarget = askedTarget && !sameTarget(askedTarget, runTarget) ? ` It scans ${focusName(focus ?? "all")}; it does not check ${withArticle(askedTarget.label)}.` : "";
  const otherFocus = focus && askedFocus && focus !== askedFocus ? ` It was recorded for ${focusName(focus)}, not ${focusName(askedFocus)}.` : "";
  return (
    <p role={announce ? "status" : undefined} className={`rounded-xl border border-doubt/30 bg-doubt/10 px-3 py-2 text-[12px] leading-snug text-doubt ${className}`}>
      <span className="font-semibold">
        Recorded run from {recordedDay(replay.recordedAt)}, not live
        {reason ? ":" : "."}
      </span>
      {reason && ` ${reason}.`}
      {otherTarget || otherFocus}
    </p>
  );
}
