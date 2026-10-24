"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { AgentEvent, Focus, Modes, OpportunityCard, Phase, TwinTaste } from "@/lib/agent/types";
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
}

// A recorded run played back instead of a live one, and why.
export interface Replay {
  recordedAt: string;
  reason: string;
}

export interface RunState {
  status: Status;
  city: string;
  focus: Focus;
  meta: Meta;
  steps: Step[];
  callsUsed: number;
  twins: TwinLink[];
  supply: Record<string, { counts: Record<string, number>; calls: number[] }>;
  cards: OpportunityCard[];
  // Ideas the agent's own checks ruled out, kept on screen with the reason.
  rejected: Rejected[];
  selectedId: string | null;
  pinned: boolean;
  error: string | null;
  summary: { callsUsed: number; budget: number; cards: number } | null;
  focusCall: number | null;
  logOpen: boolean;
  // Set while a recording is on screen instead of a live run.
  replay: Replay | null;
}

export type Action =
  | { type: "reset"; city: string; focus: Focus }
  | { type: "setQuery"; city?: string; focus?: Focus }
  | { type: "event"; event: AgentEvent }
  | { type: "fail"; message: string }
  | { type: "select"; id: string }
  | { type: "focusCall"; n: number | null }
  | { type: "toggleLog" };

export const linkKey = (home: string, homeCity: string, twin: string, twinCity: string) => `${home}|${homeCity}|${twin}|${twinCity}`;

export function initialState(city: string, modes: Meta): RunState {
  return {
    status: "idle",
    city,
    focus: "all",
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

function onEvent(s: RunState, e: AgentEvent): RunState {
  switch (e.type) {
    case "replay":
      // Whatever the live run showed so far is dropped: the recording starts from its own beginning.
      return { ...initialState(s.city, s.meta), meta: { ...s.meta, fallbackReason: undefined }, status: "connecting", focus: s.focus, logOpen: s.logOpen, replay: { recordedAt: e.recordedAt, reason: e.reason } };
    case "start":
      // A replay's start carries the modes and focus it was really recorded with.
      return { ...s, status: "running", focus: e.focus, meta: { qlooMode: e.qlooMode, llmMode: e.llmMode, budget: e.budget, model: e.model } };
    case "mode":
      return { ...s, meta: { ...s.meta, llmMode: e.llmMode, fallbackReason: e.reason } };
    case "step":
      return { ...s, steps: [...s.steps, { id: e.id, phase: e.phase, title: e.title, detail: e.detail, calls: [] }] };
    case "call": {
      const steps = s.steps.some((st) => st.id === e.stepId)
        ? s.steps.map((st) => (st.id === e.stepId ? { ...st, calls: [...st.calls, e.call] } : st))
        : [...s.steps, { id: e.stepId || "setup", phase: "think" as Phase, title: "Setting up", calls: [e.call] }];
      return { ...s, steps, callsUsed: Math.max(s.callsUsed, e.call.n) };
    }
    case "twin": {
      const key = linkKey(e.home, e.homeCity, e.twin, e.twinCity);
      const link: TwinLink = { key, home: e.home, homeCity: e.homeCity, twin: e.twin, twinCity: e.twinCity, similarity: e.similarity, rank: e.rank, tastes: e.tastes, calls: e.calls };
      const i = s.twins.findIndex((t) => t.key === key);
      return { ...s, twins: i < 0 ? [...s.twins, link] : s.twins.map((t, j) => (j === i ? link : t)) };
    }
    case "supply":
      return { ...s, supply: { ...s.supply, [`${e.hood}|${e.city}`]: { counts: e.counts, calls: e.calls } } };
    case "card": {
      const c = e.card;
      // A re-submission with new evidence can clear an idea that was ruled out earlier.
      return { ...s, twins: withTwin(s.twins, c), cards: [...s.cards, c], rejected: s.rejected.filter((r) => r.card.id !== c.id), selectedId: s.pinned ? s.selectedId : c.id };
    }
    case "rescore": {
      const label = `${e.category} in ${e.hood}`;
      const step: Step = { id: `r${s.steps.length}`, phase: "doubt", title: `${label}: ${whole(e.from)}% to ${whole(e.to)}%`, detail: e.reason, calls: [], move: { label, from: e.from, to: e.to } };
      return { ...s, steps: [...s.steps, step] };
    }
    case "rejected": {
      const c = e.card;
      const step: Step = {
        id: `x${s.steps.length}`,
        phase: "score",
        title: `Ruled out: ${c.category} in ${c.homeLocality}, ${whole(c.confidence)}%`,
        detail: `${e.reason}. It stays on screen, greyed out, with the reasons.`,
        calls: [],
        ruledOut: true,
      };
      return { ...s, twins: withTwin(s.twins, c), steps: [...s.steps, step], rejected: [...s.rejected.filter((r) => r.card.id !== c.id), { card: c, reason: e.reason }] };
    }
    case "done":
      return {
        ...s,
        status: "done",
        summary: { callsUsed: e.callsUsed, budget: e.budget, cards: e.cards },
        selectedId: s.pinned ? s.selectedId : (best(s.cards)?.id ?? null),
      };
    case "error":
      return { ...s, status: "error", error: e.message };
  }
}

export function reducer(s: RunState, a: Action): RunState {
  switch (a.type) {
    case "reset":
      return { ...initialState(a.city, s.meta), meta: { ...s.meta, fallbackReason: undefined }, status: "connecting", focus: a.focus, logOpen: s.logOpen };
    case "setQuery":
      return { ...s, city: a.city ?? s.city, focus: a.focus ?? s.focus };
    case "event":
      return onEvent(s, a.event);
    case "fail":
      return s.status === "done" || s.status === "error" ? s : { ...s, status: "error", error: a.message };
    case "select":
      return { ...s, selectedId: a.id, pinned: true };
    case "focusCall":
      return { ...s, focusCall: a.n, logOpen: a.n === null ? s.logOpen : true };
    case "toggleLog":
      return { ...s, logOpen: !s.logOpen };
  }
}

export function useExploreRun(cities: string[], modes: Modes) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState(cities[0], modes));
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(async (city: string, focus: Focus) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    dispatch({ type: "reset", city, focus });
    let finished = false;
    const handle = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as AgentEvent;
      if (event.type === "done" || event.type === "error") finished = true;
      dispatch({ type: "event", event });
    };
    try {
      const res = await fetch("/api/explore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, focus }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        dispatch({ type: "fail", message: body?.error ?? `HTTP ${res.status}` });
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
      if (!ac.signal.aborted) dispatch({ type: "fail", message: finished ? "cut off" : "network" });
    }
  }, []);

  const actions = useMemo(
    () => ({
      run,
      setCity: (city: string) => dispatch({ type: "setQuery", city }),
      setFocus: (focus: Focus) => dispatch({ type: "setQuery", focus }),
      select: (id: string) => dispatch({ type: "select", id }),
      focusCall: (n: number | null) => dispatch({ type: "focusCall", n }),
      toggleLog: () => dispatch({ type: "toggleLog" }),
    }),
    [run],
  );
  return [state, actions] as const;
}
