"use client";

import type { OpportunityCard } from "@/lib/agent/types";
import { Arrow } from "./Arrow";
import { BAND_TEXT, band, isFading, pct } from "./format";
import type { Rejected } from "./useExploreRun";

interface Props {
  cards: OpportunityCard[];
  rejected: Rejected[];
  selectedId: string | null;
  ranked: boolean;
  running: boolean;
  onSelect: (id: string) => void;
}

export function OpportunityTray({ cards, rejected, selectedId, ranked, running, onSelect }: Props) {
  if (!cards.length && !rejected.length) {
    if (!running) return null;
    return (
      <div className="mt-3 rounded-xl border border-dashed border-line p-4 text-[13px] text-muted">Opportunities appear here as the agent submits them.</div>
    );
  }
  return (
    <div className="-mx-4 mt-3 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:scroll-px-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0 lg:grid-cols-4">
      {cards.map((c, i) => {
        const selected = c.id === selectedId;
        const b = band(c.confidence);
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(c.id)}
            className={`row-in flex w-[78%] shrink-0 snap-start flex-col justify-start rounded-xl bg-surface p-3 text-left md:w-auto ${
              selected ? "border-2 border-accent shadow-md" : "border border-line shadow-xs hover:border-accent/50"
            }`}
          >
            <p className="flex items-baseline gap-1.5">
              {ranked && <span className="num text-[12px] text-muted">#{i + 1}</span>}
              <span className="font-serif text-[18px] leading-tight">{c.category}</span>
            </p>
            <p className="truncate text-[12px] text-muted">
              {c.twinLocality} <Arrow /> {c.homeLocality}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="num">
                {c.twinCount} vs {c.homeCount}
              </span>
              <span className={`rounded-full bg-page px-2 font-semibold ring-1 ring-inset ring-line ${BAND_TEXT[b]}`}>
                <span className="num">{pct(c.confidence)}%</span> {b}
              </span>
              {c.doubts.length > 0 && (
                <span className="font-medium text-doubt">
                  {c.doubts.length} {c.doubts.length === 1 ? "doubt" : "doubts"}
                </span>
              )}
              {isFading(c) && <span className="rounded-full border border-doubt px-1.5 text-doubt">Fading</span>}
            </p>
          </button>
        );
      })}
      {rejected.map(({ card: c, reason }) => {
        const selected = c.id === selectedId;
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(c.id)}
            className={`row-in flex w-[78%] shrink-0 snap-start flex-col justify-start rounded-xl border-dashed bg-page p-3 text-left md:w-auto ${
              selected ? "border-2 border-doubt" : "border border-line hover:border-doubt/60"
            }`}
          >
            <p className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-doubt">Ruled out</span>
              <span className="font-serif text-[18px] leading-tight text-muted">{c.category}</span>
            </p>
            <p className="truncate text-[12px] text-muted">
              {c.twinLocality} <Arrow /> {c.homeLocality}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              <span className="num">
                {c.twinCount} vs {c.homeCount}
              </span>
              <span className="rounded-full px-2 font-semibold ring-1 ring-inset ring-line">
                <span className="num">{pct(c.confidence)}%</span>
              </span>
              <span>{reason}</span>
            </p>
          </button>
        );
      })}
    </div>
  );
}
