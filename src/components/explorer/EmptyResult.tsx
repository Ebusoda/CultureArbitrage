"use client";

import type { Focus } from "@/lib/agent/types";
import { emptyStats, gapScan } from "./derive";
import { FOCUS_OPTIONS, focusLabel } from "./format";
import { QChips } from "./OpportunityDetail";
import type { RunState } from "./useExploreRun";

interface Props {
  state: RunState;
  cities: string[];
  onTry: (city: string, focus: Focus) => void;
  onChip: (n: number) => void;
}

export function EmptyResult({ state, cities, onTry, onChip }: Props) {
  const { city, focus, meta } = state;
  const stats = emptyStats(state);
  const rows = gapScan(state);
  const closest = rows.findIndex((r) => r.there > r.here);
  const used = state.summary?.callsUsed ?? state.callsUsed;
  return (
    <section className="fade-in">
      <h2 className="font-serif text-[26px] leading-tight">
        No convincing gap in {city}
        {focus !== "all" && ` for ${focusLabel(focus)}`}.
      </h2>
      <p className="mt-3 max-w-[68ch] text-[15px] text-muted">
        The agent profiled {stats.hoods} neighbourhoods and compared {stats.compares} taste-twin pairs, using {used}/{meta.budget} Qloo calls.{" "}
        {state.rejected.length > 0 ? (
          <>
            It found {state.rejected.length} {state.rejected.length === 1 ? "gap" : "gaps"}, but its own checks ruled {state.rejected.length === 1 ? "it" : "them"} out
            (greyed out above; open one to see why).
          </>
        ) : (
          <>
            In every pair {city} already had about as much as its twin, or the twin had too few places to count as proven.
          </>
        )}{" "}
        “Nothing here” is a valid answer: the agent is built to doubt itself rather than invent a gap.
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
          <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Gap scan</h3>
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
                    {r.here} <span className="text-muted">{r.home}</span>
                  </td>
                  <td className="num py-1.5 pr-3">
                    {r.there} <span className="text-muted">{r.twin}</span>
                  </td>
                  <td className="py-1.5 pr-3">
                    {r.here >= r.there ? "Already supplied" : "Small gap, not pursued"}
                    {i === closest && <span className="ml-1 text-accent">· closest call</span>}
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
