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
  // Google Maps cross-check, when it ran: places listed in a square around each centre.
  // Shown labelled "Google Maps", apart from the Qloo evidence.
  google?: { home: number; twin: number; homeSaturated: boolean; twinSaturated: boolean; halfKm: number; verdict: "confirms" | "weak" | "contradicts" | "inconclusive" };
  // Live: share of Qloo taste tags the two neighbourhoods have in common (0..1, unscaled),
  // and the counts behind it: tags in common, and tags found in either.
  twinSharedShare?: number;
  twinTagCounts?: { shared: number; either: number };
  // Google Maps was configured but the cross-check did not run for this card: why.
  googleSkipped?: string;
  // Who the home side of the audience check describes, when it is not Qloo (ward statistics).
  audienceBasis?: string;
  // The broader tag whose fans stood in for the category's (e.g. "hot pot").
  audienceProxy?: string;
  // Who wrote the card's text and product fit: Claude, or the fixed pipeline's template.
  // Missing in recordings made before it existed.
  author?: "claude" | "pipeline";
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
  // True when the page of places hit its size limit, so the counts are a sample (lower bounds).
  capped?: boolean;
  // Category label -> exact single-category recount, for categories recounted because the
  // page was capped. Takes precedence over counts.
  exact?: Record<string, number>;
  // Category label -> true when that recount itself hit the page size (still a lower bound).
  exactCapped?: Record<string, boolean>;
}

export type AgentEvent =
  | { type: "start"; city: string; focus: Focus; qlooMode: string; llmMode: string; budget: number; model?: string }
  // model: the model now running, when it changed (a retry on the default model).
  | { type: "mode"; llmMode: string; reason: string; model?: string }
  | { type: "step"; id: string; phase: Phase; title: string; detail?: string }
  | { type: "call"; stepId: string; call: QlooCallLog }
  | TwinEvent
  | SupplyEvent
  | { type: "card"; card: OpportunityCard }
  // A gap found but not submitted yet moved after a check: the agent talking itself up or down.
  | { type: "rescore"; id: string; category: string; hood: string; twin: string; twinCity: string; from: number; to: number; reason: string; calls: number[] }
  // A submission the agent's own checks ruled out; never shown as an opportunity.
  | { type: "rejected"; card: OpportunityCard; reason: string }
  // stopped: the run ended early (Qloo budget or time) with gaps found but not checked yet.
  | { type: "done"; callsUsed: number; budget: number; cards: number; stopped?: { reason: "budget" | "time"; unscored: number } }
  | { type: "error"; message: string }
  // A run recorded earlier, played back instead of a live one (src/lib/replay.ts): when it was
  // recorded and why it is not live. Anything shown before it is dropped; the recording follows,
  // from its own "start" (with the modes it really ran in) to its "done".
  | { type: "replay"; recordedAt: string; reason: string };

export type Phase = "think" | "profile" | "twins" | "compare" | "doubt" | "score";

export interface Modes {
  qlooMode: "mock" | "live";
  llmMode: "claude" | "none";
  budget: number;
  // Live runs are switched off (EXPLORE_FORCE_REPLAY / EXPLORE_LIVE_ENABLED): every run plays a recording.
  forceReplay?: boolean;
}
