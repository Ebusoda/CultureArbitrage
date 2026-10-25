"use client";

import type { Focus } from "@/lib/agent/types";
import { emptySummary, gapScan, type GapVerdict, unfinished } from "./derive";
import { count, FOCUS_OPTIONS, focusLabel, plural, stoppedText } from "./format";
import { QChips } from "./OpportunityDetail";
import type { RunState } from "./useExploreRun";

interface Props {
  state: RunState;
  cities: string[];
  onTry: (city: string, focus: Focus) => void;
  onChip: (n: number) => void;
}

const VERDICT: Record<GapVerdict, string> = {
  ruledOut: "Gap, ruled out by its checks",
  notSubmitted: "Gap, not submitted",
  unclear: "Possible gap, count here capped",
  supplied: "Already supplied",
  small: "Small gap, below the bar",
};

export function EmptyResult({ state, cities, onTry, onChip }: Props) {
  const { city, focus, meta } = state;
  // The summary and the table come from the same rows (derive.ts), so they cannot disagree.
  const sum = emptySummary(state);
  const early = unfinished(sum);
  const rows = gapScan(state);
  const closest = rows.findIndex((r) => r.there > r.here && r.verdict !== "ruledOut");
  const used = state.summary?.callsUsed ?? state.callsUsed;
  const found = sum.ruledOut + sum.notSubmitted + sum.unclear;
  return (
    <section className="fade-in">
      <h2 className="font-serif text-[26px] leading-tight">
        {early ? `No answer yet for ${city}` : `No convincing gap in ${city}`}
        {focus !== "all" && ` for ${focusLabel(focus)}`}.
      </h2>
      <p className="mt-3 max-w-[68ch] text-[15px] text-muted">
        The agent profiled {plural(sum.hoods, "neighbourhood")} and compared {plural(sum.pairs, "taste-twin pair")}, using {used}/{meta.budget} Qloo calls.{" "}
        {sum.stopped ? (
          <>{stoppedText(sum.stopped)} This is not an answer yet: try again, or try another city or focus.</>
        ) : sum.pairs === 0 ? (
          <>The run ended before it could compare any pair (out of Qloo calls or time), so this is not an answer yet: try again, or try another city or focus.</>
        ) : (
          <>
            {sum.ruledOut > 0 && (
              <>
                It found {plural(sum.ruledOut, "gap")}, but its own checks ruled {sum.ruledOut === 1 ? "it" : "them"} out (greyed out above; open one to see why).{" "}
              </>
            )}
            {sum.notSubmitted > 0 && (
              <>
                {sum.ruledOut > 0 ? `${sum.notSubmitted} more` : plural(sum.notSubmitted, "gap")} met the gap rule, but the agent did not submit{" "}
                {sum.notSubmitted === 1 ? "it" : "them"}.{" "}
              </>
            )}
            {sum.unclear > 0 && <>{plural(sum.unclear, "possible gap")} rested on a capped count, which may be too low. </>}
            {found === 0 && <>In every pair {city} already had about as much as its twin, or the twin had too few places to count as proven. </>}
            “Nothing here” is a valid answer: the agent is built to doubt itself rather than invent a gap.
          </>
        )}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {cities
          .filter((c) => c !== city)
          .map((c) => (
            <button key={c} type="button" onClick={() => onTry(c, focus)} className="rounded-full border border-line bg-surface px-3 py-1 text-[13px] hover:border-ink">
              Try {c}
            </button>
          ))}
        {FOCUS_OPTIONS.filter((f) => f.value !== focus).map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => onTry(city, f.value)}
            className="rounded-full border border-line bg-surface px-3 py-1 text-[13px] hover:border-ink"
          >
            Try {f.label.toLowerCase()}
          </button>
        ))}
      </div>
      {rows.length > 0 && (
        <div className="mt-8 max-w-[760px] overflow-x-auto">
          <h3 className="text-[13px] font-semibold text-muted">Gap scan</h3>
          <table className="mt-2 w-full text-left text-[13px]">
            <thead className="text-[12px] text-muted">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-3 font-normal">Category</th>
                <th className="py-1.5 pr-3 font-normal">Here</th>
                <th className="py-1.5 pr-3 font-normal">Twin</th>
                <th className="py-1.5 pr-3 font-normal">Verdict</th>
                <th className="py-1.5 font-normal" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.home}|${r.twin}|${r.category}`} className="border-b border-line">
                  <td className="py-1.5 pr-3">{r.category}</td>
                  <td className="num py-1.5 pr-3">
                    {count(r.here, r.hereCapped)} <span className="text-muted">{r.home}</span>
                  </td>
                  <td className="num py-1.5 pr-3">
                    {count(r.there, r.thereCapped)} <span className="text-muted">{r.twin}</span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {r.verdict === "unclear" && !r.hereCapped ? "Possible gap, count there capped" : VERDICT[r.verdict]}
                    {i === closest && <span className="ml-1 text-accent">(closest call)</span>}
                  </td>
                  <td className="py-1.5 text-right">
                    <QChips calls={r.calls} onChip={onChip} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
