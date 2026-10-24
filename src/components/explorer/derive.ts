import type { OpportunityCard, Phase } from "@/lib/agent/types";
import { isFading } from "./format";
import { linkKey, type RunState, type TwinLink } from "./useExploreRun";

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

export function emptyStats(s: RunState) {
  return {
    hoods: new Set(s.twins.map((t) => t.home)).size,
    pairs: s.twins.length,
    compares: s.steps.filter((st) => st.phase === "compare").length,
  };
}

export interface GapRow {
  category: string;
  home: string;
  twin: string;
  twinCity: string;
  here: number;
  there: number;
  calls: number[];
}

// Every category compared in every twin pair, biggest difference first.
export function gapScan(s: RunState): GapRow[] {
  const rows: GapRow[] = [];
  for (const t of s.twins) {
    const h = s.supply[`${t.home}|${t.homeCity}`];
    const o = s.supply[`${t.twin}|${t.twinCity}`];
    if (!h || !o) continue;
    for (const category of Object.keys(h.counts)) {
      if (!h.counts[category] && !o.counts[category]) continue;
      rows.push({ category, home: t.home, twin: t.twin, twinCity: t.twinCity, here: h.counts[category] ?? 0, there: o.counts[category] ?? 0, calls: [...h.calls, ...o.calls] });
    }
  }
  return rows.sort((a, b) => b.there - b.here - (a.there - a.here)).slice(0, 6);
}
