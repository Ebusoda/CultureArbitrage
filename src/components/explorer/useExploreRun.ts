"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { AgentEvent, AskedTarget, Focus, Modes, OpportunityCard, Phase, Target, TwinTaste } from "@/lib/agent/types";
import type { QlooCallLog } from "@/lib/qloo/types";

export type Status = "idle" | "connecting" | "running" | "done" | "error";

export interface TwinLink {
  key: string;
  home: string;
  homeCity: string;
  twin: string;
  twinCity: string;
  similarity: number;
  rank: number | null;
  tastes: TwinTaste[];
  calls: number[];
}

export interface Step {
  id: string;
  phase: Phase;
  title: string;
  detail?: string;
  calls: QlooCallLog[];
  // Q numbers the step cites without logging the calls itself (a re-score's evidence).
  refs?: number[];
  // A found gap re-scored after a check, e.g. "Bubble tea in Shin-Okubo" from 0.73 to 0.61.
  move?: { label: string; from: number; to: number };
  // The agent ruled one of its own ideas out.
  ruledOut?: boolean;
}

export interface Rejected {
  card: OpportunityCard;
  reason: string;
}

export interface Meta {
  qlooMode: string;
  llmMode: string;
  budget: number;
  model?: string;
  // Set when Claude failed and the fixed pipeline took over.
  fallbackReason?: string;
  // The server plays recordings only (live runs switched off), as the page was told at request time.
  forceReplay?: boolean;
}

// A recorded run played back instead of a live one, and why.
export interface Replay {
  recordedAt: string;
  reason: string;
}

// One neighbourhood's place counts. exact: single-category recounts, which replace the count
// from the shared page; capped: the shared page hit its size limit, so other counts are lower bounds.
export interface HoodSupply {
  counts: Record<string, number>;
  calls: number[];
  capped?: boolean;
  exact?: Record<string, number>;
  // Recounts that hit the page size themselves (still lower bounds).
  exactCapped?: Record<string, boolean>;
}

// The done event's numbers; stopped: the run ended early with gaps it had not checked yet.
export interface Summary {
  callsUsed: number;
  budget: number;
  cards: number;
  stopped?: { reason: "budget" | "time"; unscored: number };
}

// The business type a run checked, as matched to a Qloo tag (from its "target" event).
export interface Matched {
  target: Target;
  coverage?: Record<string, number>;
  coverageDate?: string;
  calls: number[];
}

// Same business type? null is a scan.
export function sameTarget(a: AskedTarget | null, b: AskedTarget | null): boolean {
  if (!a || !b) return a === b;
  return a.key ? a.key === b.key : !b.key && (a.query ?? a.label) === (b.query ?? b.label);
}

export interface RunState {
  status: Status;
  // The city and focus the results on screen belong to. Before the first run they follow the picker.
  city: string;
  focus: Focus;
  // What the picker shows; it can differ from city and focus once a run is on screen.
  pickCity: string;
  pickFocus: Focus;
  // The focus the visitor asked for in the run on screen. A recording may have run with another.
  askedFocus: Focus;
  meta: Meta;
  steps: Step[];
  callsUsed: number;
  twins: TwinLink[];
  supply: Record<string, HoodSupply>;
  cards: OpportunityCard[];
  // Ideas the agent's own checks ruled out, kept on screen with the reason.
  rejected: Rejected[];
  selectedId: string | null;
  pinned: boolean;
  error: string | null;
  summary: Summary | null;
  focusCall: number | null;
  logOpen: boolean;
  // Set while a recording is on screen instead of a live run.
  replay: Replay | null;
  // Checking one business type instead of scanning: the picker's choice, and what the run on
  // screen was asked. null means a scan of the focus, as before.
  pickTarget: AskedTarget | null;
  askedTarget: AskedTarget | null;
  // What the run on screen really checks, from its start event: null for a scan, and for a
  // recording (recordings are scans), so the page can say a recording answers another question.
  runTarget: AskedTarget | null;
  // The business type matched to a Qloo tag, or why it could not be.
  matched: Matched | null;
  unmatched: { query: string; reason: string; calls: number[] } | null;
}

export type Action =
  // target: the business type to check; absent or null for a scan.
  | { type: "reset"; city: string; focus: Focus; target?: AskedTarget | null }
  // target: undefined leaves the picker's business type as it is; null clears it.
  | { type: "setQuery"; city?: string; focus?: Focus; target?: AskedTarget | null }
  | { type: "event"; event: AgentEvent }
  | { type: "fail"; message: string }
  // The id of a tray item; the selected one again (or null) lets the page choose again.
  | { type: "select"; id: string | null }
  | { type: "focusCall"; n: number | null }
  | { type: "toggleLog" };

export const linkKey = (home: string, homeCity: string, twin: string, twinCity: string) => `${home}|${homeCity}|${twin}|${twinCity}`;

export function initialState(city: string, modes: Meta): RunState {
  return {
    status: "idle",
    city,
    focus: "all",
    pickCity: city,
    pickFocus: "all",
    askedFocus: "all",
    meta: { ...modes },
    steps: [],
    callsUsed: 0,
    twins: [],
    supply: {},
    cards: [],
    rejected: [],
    selectedId: null,
    pinned: false,
    error: null,
    summary: null,
    focusCall: null,
    logOpen: false,
    replay: null,
    pickTarget: null,
    askedTarget: null,
    runTarget: null,
    matched: null,
    unmatched: null,
  };
}

function withTwin(twins: TwinLink[], c: OpportunityCard): TwinLink[] {
  const key = linkKey(c.homeLocality, c.homeCity, c.twinLocality, c.twinCity);
  if (twins.some((t) => t.key === key)) return twins;
  return [...twins, { key, home: c.homeLocality, homeCity: c.homeCity, twin: c.twinLocality, twinCity: c.twinCity, similarity: c.twinSimilarity ?? 0, rank: null, tastes: c.sharedTastes, calls: c.refs.twin }];
}

const whole = (x: number) => Math.round(x * 100);

function best(cards: OpportunityCard[]) {
  return cards.reduce<OpportunityCard | null>((b, c) => (!b || c.confidence > b.confidence ? c : b), null);
}

// What is selected when nothing is pinned: the newest card while running, the strongest once done.
function autoSelect(s: RunState, status = s.status): string | null {
  return status === "done" ? (best(s.cards)?.id ?? null) : (s.cards.at(-1)?.id ?? null);
}

function onEvent(s: RunState, e: AgentEvent): RunState {
  switch (e.type) {
    case "replay":
      // Whatever the live run showed so far is dropped: the recording starts from its own beginning.
      return {
        ...initialState(s.city, s.meta),
        meta: { ...s.meta, fallbackReason: undefined },
        status: "connecting",
        focus: s.focus,
        pickCity: s.pickCity,
        pickFocus: s.pickFocus,
        askedFocus: s.askedFocus,
        pickTarget: s.pickTarget,
        askedTarget: s.askedTarget,
        logOpen: s.logOpen,
        replay: { recordedAt: e.recordedAt, reason: e.reason },
      };
    case "start":
      // A replay's start carries the modes and focus it was really recorded with.
      return {
        ...s,
        status: "running",
        focus: e.focus,
        runTarget: e.target ?? null,
        meta: { qlooMode: e.qlooMode, llmMode: e.llmMode, budget: e.budget, model: e.model, ...(s.meta.forceReplay ? { forceReplay: true } : {}) },
      };
    case "mode":
      // A fallback to the pipeline carries its reason; a retry on another Claude model only renames the model.
      return { ...s, meta: { ...s.meta, llmMode: e.llmMode, ...(e.llmMode === "claude" ? {} : { fallbackReason: e.reason }), ...(e.model ? { model: e.model } : {}) } };
    case "step":
      return { ...s, steps: [...s.steps, { id: e.id, phase: e.phase, title: e.title, detail: e.detail, calls: [] }] };
    case "call": {
      // A call made before any step goes under one "Setting up" step, looked up by the same id.
      const id = e.stepId || "setup";
      const steps = s.steps.some((st) => st.id === id)
        ? s.steps.map((st) => (st.id === id ? { ...st, calls: [...st.calls, e.call] } : st))
        : [...s.steps, { id, phase: "think" as Phase, title: "Setting up", calls: [e.call] }];
      // Calls charged so far, retries included, when the server says; else the highest call number.
      return { ...s, steps, callsUsed: Math.max(s.callsUsed, e.call.used ?? e.call.n) };
    }
    case "twin": {
      const key = linkKey(e.home, e.homeCity, e.twin, e.twinCity);
      const link: TwinLink = { key, home: e.home, homeCity: e.homeCity, twin: e.twin, twinCity: e.twinCity, similarity: e.similarity, rank: e.rank, tastes: e.tastes, calls: e.calls };
      const i = s.twins.findIndex((t) => t.key === key);
      return { ...s, twins: i < 0 ? [...s.twins, link] : s.twins.map((t, j) => (j === i ? link : t)) };
    }
    case "supply": {
      // A later event for the same neighbourhood can add exact recounts to the earlier counts.
      const key = `${e.hood}|${e.city}`;
      const prev = s.supply[key];
      const exact = { ...prev?.exact, ...e.exact };
      const exactCapped = { ...prev?.exactCapped, ...e.exactCapped };
      const hood: HoodSupply = {
        counts: e.counts,
        calls: [...new Set([...(prev?.calls ?? []), ...e.calls])].sort((a, b) => a - b),
        capped: e.capped ?? prev?.capped,
        ...(Object.keys(exact).length ? { exact } : {}),
        ...(Object.keys(exactCapped).length ? { exactCapped } : {}),
      };
      return { ...s, supply: { ...s.supply, [key]: hood } };
    }
    case "card": {
      const c = e.card;
      // A re-submission with new evidence can clear an idea that was ruled out earlier.
      return { ...s, twins: withTwin(s.twins, c), cards: [...s.cards, c], rejected: s.rejected.filter((r) => r.card.id !== c.id), selectedId: s.pinned ? s.selectedId : c.id };
    }
    case "rescore": {
      // The same category and neighbourhood can be a gap against more than one twin.
      const label = `${e.category} in ${e.hood} vs ${e.twin} (${e.twinCity})`;
      const step: Step = {
        id: `r${s.steps.length}`,
        phase: "doubt",
        title: `${label}: ${whole(e.from)}% to ${whole(e.to)}%`,
        detail: e.reason,
        calls: [],
        refs: e.calls ?? [],
        move: { label, from: e.from, to: e.to },
      };
      return { ...s, steps: [...s.steps, step] };
    }
    case "rejected": {
      const c = e.card;
      const step: Step = {
        id: `x${s.steps.length}`,
        phase: "score",
        title: `Ruled out: ${c.category} in ${c.homeLocality} vs ${c.twinLocality} (${c.twinCity}), ${whole(c.confidence)}%`,
        detail: `${e.reason}. It stays on screen, greyed out, with the reasons.`,
        calls: [],
        // The Qloo calls behind the card, so the row links to its evidence like a re-score row.
        refs: [...new Set(Object.values(c.refs ?? {}).flat())].sort((a, b) => a - b),
        ruledOut: true,
      };
      return { ...s, twins: withTwin(s.twins, c), steps: [...s.steps, step], rejected: [...s.rejected.filter((r) => r.card.id !== c.id), { card: c, reason: e.reason }] };
    }
    case "done": {
      // A card the visitor picked stays picked. A ruled-out idea picked during the run gives way
      // to the strongest card, when there is one.
      const keep = s.pinned && (s.cards.some((c) => c.id === s.selectedId) || !s.cards.length);
      return {
        ...s,
        status: "done",
        // The header counter and the finished line show the same number.
        callsUsed: e.callsUsed,
        summary: { callsUsed: e.callsUsed, budget: e.budget, cards: e.cards, ...(e.stopped ? { stopped: e.stopped } : {}) },
        selectedId: keep ? s.selectedId : autoSelect(s, "done"),
        pinned: keep,
      };
    }
    case "error":
      return { ...s, status: "error", error: e.message };
    case "target":
      return e.status === "matched"
        ? { ...s, matched: { target: e.target, coverage: e.coverage, coverageDate: e.coverageDate, calls: e.calls }, unmatched: null }
        : { ...s, matched: null, unmatched: { query: e.query, reason: e.reason, calls: e.calls } };
    default:
      // An event this page does not know (a newer server): nothing to show for it.
      return s;
  }
}

export function reducer(s: RunState, a: Action): RunState {
  switch (a.type) {
    case "reset":
      return {
        ...initialState(a.city, s.meta),
        meta: { ...s.meta, fallbackReason: undefined },
        status: "connecting",
        focus: a.focus,
        pickFocus: a.focus,
        askedFocus: a.focus,
        pickTarget: a.target ?? null,
        askedTarget: a.target ?? null,
        logOpen: s.logOpen,
      };
    case "setQuery": {
      const pickCity = a.city ?? s.pickCity;
      const pickFocus = a.focus ?? s.pickFocus;
      const pickTarget = a.target === undefined ? s.pickTarget : a.target;
      // Results on screen keep the city and focus they were found for.
      return s.status === "idle" ? { ...s, pickCity, pickFocus, pickTarget, city: pickCity, focus: pickFocus } : { ...s, pickCity, pickFocus, pickTarget };
    }
    case "event":
      return onEvent(s, a.event);
    case "fail":
      return s.status === "done" || s.status === "error" ? s : { ...s, status: "error", error: a.message };
    case "select":
      // Picking the selected item again un-picks it, so a ruled-out idea can be put away again.
      if (a.id === null || (a.id === s.selectedId && s.pinned)) return { ...s, selectedId: autoSelect(s), pinned: false };
      return { ...s, selectedId: a.id, pinned: true };
    case "focusCall":
      return { ...s, focusCall: a.n, logOpen: a.n === null ? s.logOpen : true };
    case "toggleLog":
      return { ...s, logOpen: !s.logOpen };
  }
}

// What a refused request says: this site's own errors carry a string; others (Vercel's firewall
// answers {"error": {"code": "429", ...}}) get the status, which the page turns into words.
export function failMessage(body: unknown, status: number): string {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" && error.trim() ? error : `HTTP ${status}`;
}

export function useExploreRun(cities: string[], modes: Modes) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(cities[0], modes));
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  // target: check one business type instead of scanning the focus (null or absent: a scan).
  const run = useCallback(async (city: string, focus: Focus, target: AskedTarget | null = null) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    dispatch({ type: "reset", city, focus, target });
    let finished = false;
    let malformed = false;
    const handle = (line: string) => {
      if (!line.trim()) return;
      let event: AgentEvent;
      try {
        event = JSON.parse(line) as AgentEvent;
      } catch {
        malformed = true;
        throw new Error("bad data");
      }
      if (event.type === "done" || event.type === "error") finished = true;
      dispatch({ type: "event", event });
    };
    try {
      const res = await fetch("/api/explore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A scan sends exactly what it always did.
        body: JSON.stringify({ city, focus, ...(target?.key ? { category: target.key } : target?.query ? { query: target.query } : {}) }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        dispatch({ type: "fail", message: failMessage(await res.json().catch(() => null), res.status) });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        lines.forEach(handle);
      }
      handle(buf + decoder.decode());
      if (!finished) dispatch({ type: "fail", message: "cut off" });
    } catch {
      if (!ac.signal.aborted) dispatch({ type: "fail", message: malformed ? "bad data" : finished ? "cut off" : "network" });
    }
  }, []);

  const actions = useMemo(
    () => ({
      run,
      setCity: (city: string) => dispatch({ type: "setQuery", city }),
      setFocus: (focus: Focus) => dispatch({ type: "setQuery", focus }),
      setTarget: (target: AskedTarget | null) => dispatch({ type: "setQuery", target }),
      select: (id: string | null) => dispatch({ type: "select", id }),
      focusCall: (n: number | null) => dispatch({ type: "focusCall", n }),
      toggleLog: () => dispatch({ type: "toggleLog" }),
    }),
    [run],
  );
  return [state, actions] as const;
}
