"use client";

import { useEffect, useRef, useState } from "react";
import type { Phase } from "@/lib/agent/types";
import type { QlooCallLog } from "@/lib/qloo/types";
import { Arrow } from "./Arrow";
import { currentPhase } from "./derive";
import { callLine, errorText, PHASE_DOT, plural, Q_CHIP, pct, requestLine, stoppedText } from "./format";
import { useOverflows, usePrefersReducedMotion } from "./hooks";
import { QChips } from "./OpportunityDetail";
import { ReplayBanner } from "./ReplayBanner";
import type { RunState, Step } from "./useExploreRun";

const STEPPER: { phase: Phase; label: string }[] = [
  { phase: "profile", label: "Profile" },
  { phase: "twins", label: "Twins" },
  { phase: "compare", label: "Compare" },
  { phase: "doubt", label: "Doubt" },
  { phase: "score", label: "Score" },
];

const QUESTIONS = [
  { label: "Profile", q: "What do people here love?", tag: "insights · urn:tag" },
  { label: "Taste twins", q: "Where else do people love the same things?", tag: "insights · urn:entity:locality" },
  { label: "Compare", q: "What do the twins have that we don't?", tag: "insights · urn:entity:place" },
  { label: "Doubt", q: "Is the gap real, wanted and lasting?", tag: "urn:demographics · /v2/trending (not available for places)" },
  { label: "Score", q: "Six scores and a confidence, computed from the Qloo answers (plus Tokyo ward statistics, labelled). Product fit is Claude's judgment, labelled.", tag: "" },
];

interface Props {
  state: RunState;
  className?: string;
  onFocusDone: () => void;
  // Q-number links on re-score rows, which cite calls logged elsewhere.
  onChip?: (n: number) => void;
}

// The log's id, for the phone's Show full log button.
export const AGENT_LOG_ID = "agent-log";

export function AgentLog({ state, className = "", onFocusDone, onChip }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Where the last automatic scroll left the log.
  const autoTop = useRef(0);
  const reduced = usePrefersReducedMotion();
  const { status, steps, meta } = state;
  const rows = steps.reduce((n, s) => n + 1 + s.calls.length, 0);

  useEffect(() => {
    const el = scroller.current;
    if (el && following.current) {
      el.scrollTop = el.scrollHeight;
      autoTop.current = el.scrollTop;
    }
  }, [rows, status]);

  useEffect(() => {
    if (state.focusCall === null) return;
    const el = document.getElementById(`call-${state.focusCall}`) as HTMLDetailsElement | null;
    if (el) {
      el.open = true;
      following.current = false;
      el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
      // Keyboard and screen-reader users land on the call too, not only the eye.
      el.querySelector("summary")?.focus({ preventScroll: true });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      window.setTimeout(() => el.classList.remove("flash"), 1500);
    }
    onFocusDone();
  }, [state.focusCall, reduced, onFocusDone]);

  const phase = currentPhase(state);
  const visited = new Set(steps.map((s) => s.phase));
  const claude = meta.llmMode === "claude";

  return (
    <div
      ref={scroller}
      id={AGENT_LOG_ID}
      onScroll={(e) => {
        const el = e.currentTarget;
        // Rows can land between an automatic scroll and its scroll event, so only scrolling up stops following.
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48 || el.scrollTop >= autoTop.current - 1;
      }}
      className={`overflow-y-auto rounded-2xl border border-line bg-surface shadow-xs ${className}`}
    >
      <div className="sticky top-0 z-10 border-b border-line bg-surface px-4 pb-3 pt-4">
        <h2 className="font-serif text-[17px] leading-tight">Agent log</h2>
        {state.replay && <ReplayBanner replay={state.replay} className="mt-2" announce={false} focus={state.focus} askedFocus={state.askedFocus} askedTarget={state.askedTarget} runTarget={state.runTarget} />}
        <ol className="mt-2 flex flex-wrap gap-1">
          {STEPPER.map(({ phase: p, label }) => {
            const current = p === phase && status !== "done" && status !== "idle";
            const stopped = current && status === "error";
            return (
              <li
                key={p}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                  current ? "bg-accent/10 font-semibold text-ink ring-1 ring-inset ring-accent/40" : visited.has(p) ? "bg-line/70 font-medium text-ink" : "text-muted ring-1 ring-inset ring-line"
                }`}
              >
                {current && !stopped && <span className={`h-1.5 w-1.5 rounded-full ${PHASE_DOT[p]} animate-pulse motion-reduce:animate-none`} />}
                {stopped ? <span className="text-danger">✕ stopped</span> : label}
              </li>
            );
          })}
        </ol>
        {status !== "idle" && (
          <p className="num mt-2 text-[12px] text-muted">
            {plural(steps.length, "step")}, {state.callsUsed} of {meta.budget} Qloo calls
          </p>
        )}
      </div>

      {status === "idle" ? (
        <ol className="space-y-4 px-4 py-4">
          {QUESTIONS.map((x, i) => (
            <li key={x.label} className="flex gap-3">
              <span className="num mt-0.5 text-[12px] text-muted">{i + 1}</span>
              <div>
                <p className="text-[13px] font-semibold text-muted">{x.label}</p>
                <p className="text-[14px]">{x.q}</p>
                {x.tag && (
                  <details className="mt-0.5">
                    <summary className="cursor-pointer text-[12px] text-muted underline decoration-line underline-offset-2">Show request</summary>
                    <p className="mt-1 font-mono text-[11px] text-twin">{x.tag}</p>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="px-4 py-4">
          {steps.map((s, i) => (
            <StepRow key={s.id + i} step={s} claude={claude} last={i === steps.length - 1 && status === "running"} onChip={onChip} />
          ))}
          {status === "connecting" && <li className="dots text-[13px] text-muted">Connecting</li>}
          {status === "done" && state.summary && (
            <li className="row-in mt-1 rounded-xl bg-accent/10 px-3 py-2.5 text-[13px] font-semibold text-accent">
              Finished: {plural(state.summary.cards, "opportunity", "opportunities")} from {state.summary.callsUsed} of {state.summary.budget} Qloo calls.
              {state.summary.stopped && ` ${stoppedText(state.summary.stopped)}`}
            </li>
          )}
          {status === "error" && <li className="row-in border-t border-line pt-3 text-[13px] text-danger">Stopped: {errorText(state.error ?? "", meta.budget)}</li>}
        </ol>
      )}
    </div>
  );
}

// "Bubble tea in Shin-Okubo: 73% → 61%", coloured by which way the agent's own check moved it.
export function MoveTitle({ move }: { move: NonNullable<Step["move"]> }) {
  const down = move.to < move.from;
  return (
    <>
      {move.label}:{" "}
      <span className="num whitespace-nowrap">
        {pct(move.from)}% <Arrow thin /> <span className={`font-semibold ${down ? "text-doubt" : "text-accent"}`}>{pct(move.to)}%</span>
      </span>
    </>
  );
}

function StepRow({ step, claude, last, onChip }: { step: Step; claude: boolean; last: boolean; onChip?: (n: number) => void }) {
  const [more, setMore] = useState(false);
  const thought = useRef<HTMLParagraphElement>(null);
  // "More" shows when the one line really cuts the thought off.
  const cut = useOverflows(thought, step.detail ?? step.title);
  if (step.move || step.ruledOut) {
    const down = step.ruledOut || step.move!.to < step.move!.from;
    return (
      <li className="row-in relative border-l-2 border-line pb-3 pl-4">
        <span className={`absolute -left-[7px] top-[5px] h-3 w-3 rounded-full border-[2.5px] border-surface ${down ? "bg-doubt" : "bg-accent"}`} aria-hidden="true" />
        <p className={`text-[14px] ${step.ruledOut ? "font-semibold text-doubt" : "font-medium"}`}>{step.move ? <MoveTitle move={step.move} /> : step.title}</p>
        {step.detail && <p className="text-[13px] text-muted">{step.detail}</p>}
        {step.refs && step.refs.length > 0 && (
          <div className="mt-1">
            <QChips calls={step.refs} onChip={onChip} />
          </div>
        )}
      </li>
    );
  }
  if (step.phase === "think") {
    const text = step.detail ?? step.title;
    return (
      <li className="row-in border-l-2 border-llm pb-3 pl-4">
        <p className="text-[12px] font-semibold text-llm">Claude</p>
        <p ref={thought} className={`whitespace-pre-line text-[13px] ${more ? "" : "line-clamp-1"}`}>
          {step.detail ? text : step.title}
          {last && <span className="dots" />}
        </p>
        {(more || cut) && (
          <button type="button" onClick={() => setMore(!more)} className="text-[12px] text-muted underline underline-offset-2">
            {more ? "Less" : "More"}
          </button>
        )}
        <Calls calls={step.calls} />
      </li>
    );
  }
  return (
    <li className="row-in relative border-l-2 border-line pb-3 pl-4">
      <div className="flex gap-2">
        <span className={`absolute -left-[7px] top-[5px] h-3 w-3 shrink-0 rounded-full border-[2.5px] border-surface ${PHASE_DOT[step.phase]}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[14px] font-medium">
            {step.title}
            {last && <span className="dots" />}
          </p>
          {step.detail && (
            <p className="text-[13px] text-muted [overflow-wrap:anywhere]">
              {claude && "Why: "}
              {step.detail}
            </p>
          )}
        </div>
      </div>
      <Calls calls={step.calls} />
    </li>
  );
}

function Calls({ calls }: { calls: QlooCallLog[] }) {
  if (!calls.length) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {calls.map((c) => (
        <details key={c.n} id={`call-${c.n}`} className="group rounded-lg">
          <summary className="cursor-pointer list-none rounded-lg px-1.5 py-0.5 hover:bg-line/40">
            <span className="block font-mono text-[12px] [overflow-wrap:anywhere]">
              <span className={`rounded-full px-1.5 font-semibold ${Q_CHIP}`}>Q{c.n}</span> {callLine(c)}
            </span>
            <span className={`block text-[12px] [overflow-wrap:anywhere] ${c.error ? "text-danger" : "text-muted"}`}>→ {c.error ? `failed: ${c.error}` : c.summary}
              {c.cached && <span className="ml-1.5 rounded-full bg-line/70 px-1.5 text-[11px] text-muted">cached</span>}
            </span>
          </summary>
          <div className="mb-2 mt-1 space-y-1 rounded-lg bg-page p-2.5">
            <p className="font-mono text-[11px] [overflow-wrap:anywhere]">{requestLine(c)}</p>
            <pre className="overflow-x-auto font-mono text-[11px] text-muted">{JSON.stringify(sentParams(c), null, 2)}</pre>
            <p className="text-[11px] text-muted">The API key is sent server-side and never shown.</p>
          </div>
        </details>
      ))}
    </div>
  );
}

// The params as sent to Qloo: display-only ones ("_where") never are.
function sentParams(c: QlooCallLog) {
  return Object.fromEntries(Object.entries(c.params).filter(([k]) => !k.startsWith("_")));
}

export function NowTicker({ state, onToggle }: { state: RunState; onToggle: () => void }) {
  if (state.status === "idle") return null;
  const last = state.steps.slice(-3);
  return (
    <div className="mt-3 md:hidden">
      <p className="text-[12px] font-semibold text-muted">
        {state.replay ? "Recorded run, not live" : state.status === "running" || state.status === "connecting" ? "Live" : "Log"}
      </p>
      <ul className="mt-1 space-y-0.5">
        {last.map((s, i) => (
          <li key={s.id + i} className={`flex items-center gap-2 text-[13px] ${i < last.length - 1 ? "opacity-50" : ""}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOT[s.phase]}`} />
            <span className="truncate">{s.phase === "think" ? `Claude: ${s.detail ?? s.title}` : s.move ? <MoveTitle move={s.move} /> : s.title}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={state.logOpen}
        aria-controls={AGENT_LOG_ID}
        className="mt-2 text-[13px] font-medium text-accent underline decoration-accent/30 underline-offset-4"
      >
        {state.logOpen ? "Hide full log" : `Show full log (${plural(state.steps.length, "step")}, ${plural(state.callsUsed, "call")})`}
      </button>
    </div>
  );
}
