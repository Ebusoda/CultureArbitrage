import type { OpportunityCard, Phase } from "@/lib/agent/types";
import { isGap } from "@/lib/agent/rules";
import { isFading } from "./format";
import { linkKey, type HoodSupply, type RunState, type TwinLink } from "./useExploreRun";

export function currentStep(s: RunState) {
  return s.steps.at(-1) ?? null;
}

export function currentPhase(s: RunState): Phase | null {
  for (let i = s.steps.length - 1; i >= 0; i--) if (s.steps[i].phase !== "think") return s.steps[i].phase;
  return null;
}

// Arrival order while running; strongest first once the run is over.
export function trayCards(s: RunState): OpportunityCard[] {
  return s.status === "done" ? [...s.cards].sort((a, b) => b.confidence - a.confidence) : s.cards;
}

export function rankOf(s: RunState, id: string): number | null {
  if (s.status !== "done") return null;
  const i = trayCards(s).findIndex((c) => c.id === id);
  return i < 0 ? null : i + 1;
}

export type ArcState = "twin" | "opportunity" | "fading";

export interface Arc {
  key: string;
  link: TwinLink;
  cards: OpportunityCard[];
  state: ArcState;
  // Position among arcs that join the same two cities, so they fan apart.
  index: number;
}

export function arcs(s: RunState): Arc[] {
  const seen = new Map<string, number>();
  return s.twins.map((link) => {
    const cards = s.cards.filter((c) => linkKey(c.homeLocality, c.homeCity, c.twinLocality, c.twinCity) === link.key);
    const state: ArcState = !cards.length ? "twin" : cards.every(isFading) ? "fading" : "opportunity";
    const pair = [link.homeCity, link.twinCity].sort().join("|");
    const index = seen.get(pair) ?? 0;
    seen.set(pair, index + 1);
    return { key: link.key, link, cards, state, index };
  });
}

// Twin pairs whose supply was fetched on both sides: the pairs actually compared.
function comparedPairs(s: RunState) {
  return s.twins.filter((t) => s.supply[`${t.home}|${t.homeCity}`] && s.supply[`${t.twin}|${t.twinCity}`]);
}

export function emptyStats(s: RunState) {
  return {
    hoods: new Set(s.twins.map((t) => t.home)).size,
    pairs: comparedPairs(s).length,
  };
}

export type GapVerdict = "ruledOut" | "notSubmitted" | "unclear" | "supplied" | "small";

export interface GapRow {
  category: string;
  home: string;
  twin: string;
  twinCity: string;
  here: number;
  there: number;
  // The count is a lower bound: the shared page of places was capped and nothing recounted it.
  hereCapped: boolean;
  thereCapped: boolean;
  calls: number[];
  verdict: GapVerdict;
}

// An exact recount wins over the shared page; without one, a capped page only gives a lower bound.
function countOf(h: HoodSupply, category: string) {
  const exact = h.exact?.[category];
  return exact !== undefined ? { n: exact, capped: !!h.exactCapped?.[category] } : { n: h.counts[category] ?? 0, capped: !!h.capped };
}

// Every category compared in every twin pair, biggest difference first.
// limit: how many rows to keep (the table shows 6); omit for all of them.
export function gapScan(s: RunState, limit: number | null = 6): GapRow[] {
  const rows: GapRow[] = [];
  for (const t of comparedPairs(s)) {
    const h = s.supply[`${t.home}|${t.homeCity}`];
    const o = s.supply[`${t.twin}|${t.twinCity}`];
    for (const category of [...new Set([...Object.keys(h.counts), ...Object.keys(h.exact ?? {})])]) {
      const here = countOf(h, category);
      const there = countOf(o, category);
      if (!here.n && !there.n) continue;
      const ruledOut = s.rejected.some(({ card }) => card.homeLocality === t.home && card.twinLocality === t.twin && card.category === category);
      // Same bar as isGap() in score.ts. A capped home count may be too low, so it cannot settle a
      // gap; a capped twin count may be too low too, so it cannot settle that a gap is small.
      const verdict: GapVerdict = ruledOut
        ? "ruledOut"
        : isGap(there.n, here.n)
          ? here.capped
            ? "unclear"
            : "notSubmitted"
          : here.n >= there.n
            ? "supplied"
            : there.capped && !here.capped
              ? "unclear"
              : "small";
      rows.push({
        category,
        home: t.home,
        twin: t.twin,
        twinCity: t.twinCity,
        here: here.n,
        there: there.n,
        hereCapped: here.capped,
        thereCapped: there.capped,
        calls: [...new Set([...h.calls, ...o.calls])].sort((a, b) => a - b),
        verdict,
      });
    }
  }
  const sorted = rows.sort((a, b) => b.there - b.here - (a.there - a.here));
  return limit === null ? sorted : sorted.slice(0, limit);
}

// What a finished run with no opportunities found, taken from the same rows as the gap scan,
// so the summary never contradicts the table.
export interface EmptySummary {
  hoods: number;
  pairs: number;
  // The run stopped early (Qloo budget or time) with this many gaps not checked yet.
  stopped: { reason: "budget" | "time"; unscored: number } | null;
  // Ideas the agent submitted and its own checks ruled out.
  ruledOut: number;
  // Rows that meet the gap rule but were never submitted.
  notSubmitted: number;
  // Rows that meet the rule only on a capped (lower-bound) home count.
  unclear: number;
}

export function emptySummary(s: RunState): EmptySummary {
  const rows = gapScan(s, null);
  const n = (v: GapVerdict) => rows.filter((r) => r.verdict === v).length;
  const stats = emptyStats(s);
  return {
    ...stats,
    stopped: s.summary?.stopped ?? null,
    ruledOut: s.rejected.length,
    notSubmitted: n("notSubmitted"),
    unclear: n("unclear"),
  };
}

// The run did not get as far as an answer: it stopped early, or compared no pair at all.
export function unfinished(e: EmptySummary) {
  return e.stopped !== null || e.pairs === 0;
}
