import type { QlooCallLog } from "../qloo";

export type Focus = "all" | "dining" | "nightlife" | "retail";

export interface ExploreRequest {
  city: string;
  focus: Focus;
}

export interface ScoreItem {
  key: string;
  label: string;
  // null = not measured yet (shown as "pending" in the UI, never faked)
  value: number | null;
  source: "Qloo" | "LLM" | "pending";
  note: string;
}

// Qloo call numbers ("Q<n>") behind each piece of evidence on a card.
// An empty list means that lookup was never made.
export type EvidenceRef = "taste" | "twin" | "homeSupply" | "twinSupply" | "citySupply" | "audience" | "trend";

export interface OpportunityCard {
  id: string;
  category: string;
  categoryId: string;
  homeLocality: string;
  homeCity: string;
  twinLocality: string;
  twinCity: string;
  twinSimilarity: number | null;
  // Rank of the twin among the other city's neighbourhoods for these tastes (1 = best), if known.
  twinRank: number | null;
  sharedTastes: { name: string; affinity: number | null }[];
  homeCount: number;
  twinCount: number;
  cityCount: number | null;
  // True when a count hit the request's page size, so the real number may be higher.
  capped: { home: boolean; twin: boolean; city: boolean };
  why: string;
  scores: ScoreItem[];
  confidence: number;
  // The UI prints this formula next to the confidence number.
  confidenceMath: { mean: number; measured: number; doubts: number; penalty: number };
  doubts: string[];
  // Confidence after each check, in the order the checks ran; the last step is the card's
  // confidence. Missing in recordings made before it existed.
  trail?: TrailStep[];
  refs: Record<EvidenceRef, number[]>;
}

export interface TrailStep {
  label: string;
  confidence: number;
  calls: number[];
}

export interface TwinTaste {
  name: string;
  affinity: number | null;
}

export interface TwinEvent {
  type: "twin";
  home: string;
  homeCity: string;
  twin: string;
  twinCity: string;
  similarity: number;
  rank: number;
  tastes: TwinTaste[];
  calls: number[];
}

export interface SupplyEvent {
  type: "supply";
  hood: string;
  city: string;
  // Category label -> places, for the categories in scope.
  counts: Record<string, number>;
  calls: number[];
}

export type AgentEvent =
  | { type: "start"; city: string; focus: Focus; qlooMode: string; llmMode: string; budget: number; model?: string }
  | { type: "mode"; llmMode: string; reason: string }
  | { type: "step"; id: string; phase: Phase; title: string; detail?: string }
  | { type: "call"; stepId: string; call: QlooCallLog }
  | TwinEvent
  | SupplyEvent
  | { type: "card"; card: OpportunityCard }
  // A gap found but not submitted yet moved after a check: the agent talking itself up or down.
  | { type: "rescore"; id: string; category: string; hood: string; twin: string; twinCity: string; from: number; to: number; reason: string; calls: number[] }
  // A submission the agent's own checks ruled out; never shown as an opportunity.
  | { type: "rejected"; card: OpportunityCard; reason: string }
  | { type: "done"; callsUsed: number; budget: number; cards: number }
  | { type: "error"; message: string };

export type Phase = "think" | "profile" | "twins" | "compare" | "doubt" | "score";

export interface Modes {
  qlooMode: "mock" | "live";
  llmMode: "claude" | "none";
  budget: number;
}
