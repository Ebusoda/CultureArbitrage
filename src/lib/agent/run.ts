import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { BudgetedQloo, createQloo, isFatalQlooError, qlooMode } from "../qloo";
import { categoriesFor, categoryLabel } from "./categories";
import { DEFAULT_MODEL, runClaudeAgent } from "./claude-agent";
import { Evidence, type Supply } from "./evidence";
import { runPipeline } from "./pipeline";
import { cardId, isGap, provisional } from "./score";
import type { AgentEvent, ExploreRequest, Modes, OpportunityCard, Phase } from "./types";

const MAX_CARDS = 4;

export type StepFn = (phase: Phase, title: string, detail?: string) => void;

export interface RunContext {
  step: StepFn;
  onCard: (card: OpportunityCard) => void;
  // A submission ruled out by its own checks, shown greyed out with the reason.
  onRejected?: (card: OpportunityCard, reason: string) => void;
  // Epoch ms after which no new lookups start.
  deadline: number;
  // Aborted when the viewer disconnects.
  signal: AbortSignal;
}

function budget() {
  return config.callBudget();
}

function claudeEnabled() {
  return process.env.LLM_MODE === "claude" && !!process.env.ANTHROPIC_API_KEY?.trim();
}

// What the page shows before a run starts. Never exposes keys, only whether they are set.
export function currentModes(): Modes {
  return { qlooMode: qlooMode(), llmMode: claudeEnabled() ? "claude" : "none", budget: budget() };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

// LLM_MODE=claude runs the Claude tool-calling agent (needs ANTHROPIC_API_KEY).
// Otherwise, or if Claude fails before submitting anything, the fixed pipeline runs.
export async function explore(req: ExploreRequest, emit: (e: AgentEvent) => void, opts: { deadline: number; signal: AbortSignal }) {
  let stepId = "";
  let stepNo = 0;
  const step: StepFn = (phase, title, detail) => {
    stepId = `s${++stepNo}`;
    emit({ type: "step", id: stepId, phase, title, detail });
  };

  const qloo = new BudgetedQloo(createQloo({ signal: opts.signal }), budget(), (call) => emit({ type: "call", stepId, call }));
  const categories = categoriesFor(req.focus);
  // Gaps found so far (card id -> confidence last shown). Each new answer re-scores them,
  // so the log shows the agent talking an idea down (or up) before it submits anything.
  const shown = new Map<string, number>();
  const rescore = () => {
    for (const [key, twin] of ev.twins) {
      const hood = key.split("|")[0];
      const here = ev.peek<Supply>(`supply:${hood}, ${req.city}`);
      const there = ev.peek<Supply>(`supply:${twin.name}, ${twin.city}`);
      if (!here || !there) continue;
      for (const category of categories) {
        if (!isGap(there.counts[category] ?? 0, here.counts[category] ?? 0)) continue;
        const now = provisional(ev, { category, hood, city: req.city, twin: twin.name, twinCity: twin.city });
        if (!now) continue;
        const id = cardId(hood, twin.name, twin.city, category);
        const before = shown.get(id);
        shown.set(id, now.confidence);
        if (before === undefined || Math.round(before * 100) === Math.round(now.confidence * 100)) continue;
        emit({ type: "rescore", id, category: categoryLabel(category), hood, twin: twin.name, twinCity: twin.city, from: before, to: now.confidence, reason: now.label, calls: now.calls });
      }
    }
  };
  const ev = new Evidence(qloo, {
    categories,
    onTwin: emit,
    onSupply: emit,
    onLookup: rescore,
  });
  const useClaude = claudeEnabled();
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  emit({ type: "start", city: req.city, focus: req.focus, qlooMode: qloo.mode, llmMode: useClaude ? "claude" : "none", budget: qloo.budget, model: useClaude ? model : undefined });

  // Cards are keyed by id so a fallback run cannot repeat one Claude already submitted.
  const emitted = new Map<string, OpportunityCard>();
  const ctx: RunContext = {
    step,
    deadline: opts.deadline,
    signal: opts.signal,
    onCard: (card) => {
      if (emitted.has(card.id) || emitted.size >= MAX_CARDS) return;
      emitted.set(card.id, card);
      emit({ type: "card", card });
    },
    onRejected: (card, reason) => {
      if (!emitted.has(card.id)) emit({ type: "rejected", card, reason });
    },
  };

  let runPipelineNext = !useClaude;
  if (useClaude) {
    try {
      try {
        await runClaudeAgent(req, ev, ctx, { model });
      } catch (e) {
        // A mistyped ANTHROPIC_MODEL should not sink the demo: retry once on the default.
        if (e instanceof Anthropic.NotFoundError && model !== DEFAULT_MODEL && emitted.size === 0) {
          step("think", `Model ${model} was not found, retrying with ${DEFAULT_MODEL}`);
          await runClaudeAgent(req, ev, ctx, { model: DEFAULT_MODEL });
        } else {
          throw e;
        }
      }
    } catch (e) {
      // A spent budget ends the run as an error; the cards already sent stay on screen.
      // So does a Qloo error every later call would repeat (rejected key, wrong URL).
      if (opts.signal.aborted || isFatalQlooError(e)) throw e;
      if (emitted.size > 0) {
        step("think", "Claude stopped early, keeping the opportunities it already submitted", message(e));
      } else {
        // Evidence already gathered stays cached, so the pipeline reuses it without new Qloo calls.
        emit({ type: "mode", llmMode: "none", reason: message(e) });
        step("think", "Claude is unavailable, switching to the fixed pipeline", message(e));
        runPipelineNext = true;
      }
    }
  }
  if (runPipelineNext) await runPipeline(req, ev, ctx);
  emit({ type: "done", callsUsed: qloo.used, budget: qloo.budget, cards: emitted.size });
}
