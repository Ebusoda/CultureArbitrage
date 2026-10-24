"use client";

import type { OpportunityCard } from "@/lib/agent/types";
import { MoveTitle } from "./AgentLog";
import { currentStep } from "./derive";
import { BAND_TEXT, band, clip, errorText, firstSentence, focusLabel, isFading, km, PHASE_LABEL, pct } from "./format";
import { ReplayBanner } from "./ReplayBanner";
import type { RunState } from "./useExploreRun";

interface Props {
  state: RunState;
  selected: OpportunityCard | null;
  // Set when the selected idea is one the agent ruled out.
  ruledOut: string | null;
  rank: number | null;
  total: number;
  onRetry: () => void;
}

const eyebrow = "text-[12px] font-semibold uppercase tracking-[0.06em]";
const headline = "font-serif text-[26px] leading-[1.12] tabular-nums md:text-[30px] lg:text-[36px] lg:leading-[1.1]";

export function StoryCaption({ state, selected, ruledOut, rank, total, onRetry }: Props) {
  const { status, city, focus, meta } = state;
  let top: React.ReactNode;
  let main: React.ReactNode;
  let sub: React.ReactNode = null;
  let extra: React.ReactNode = null;

  if (status === "idle") {
    top = <span className="text-muted">How trends travel</span>;
    main = "Trends travel between cities.";
    sub =
      "Taiwanese bubble-tea chains opened in Tokyo from 2013; by 2019 “tapiru” was a buzzword of the year. Malatang reached Japan’s Gen Z by way of Seoul and K-pop. The demand was visible somewhere else first.";
  } else if (status === "connecting") {
    top = <span className="text-muted">Starting</span>;
    main = `Asking Qloo about ${city}…`;
    if (meta.llmMode === "claude") sub = "Claude is planning the search…";
  } else if (status === "error" && !selected) {
    top = <span className="text-danger">Run stopped</span>;
    main = errorText(state.error ?? "", meta.budget);
    sub = "Steps so far stay in the log.";
    extra = <Retry onClick={onRetry} />;
  } else if ((status === "done" || status === "error") && selected) {
    const fading = isFading(selected);
    const distance = km(selected.twinCity, selected.homeCity);
    const tastes = selected.sharedTastes.slice(0, 3).map((t) => t.name);
    const b = band(selected.confidence);
    top = (
      <span>
        <span className="text-accent">{selected.category}</span>
        <span className="text-muted">
          {" "}
          · Opportunity {rank ?? 1} of {total} ·{" "}
        </span>
        <span className={BAND_TEXT[b]}>{pct(selected.confidence)}%</span>
      </span>
    );
    main = (
      <>
        Qloo lists {selected.twinCount} in {selected.twinLocality}, {selected.homeCount} in {selected.homeLocality}.
      </>
    );
    sub = (
      <>
        {selected.twinSimilarity !== null && <>Same taste (Qloo affinity {selected.twinSimilarity.toFixed(2)})</>}
        {tastes.length > 0 && <>: {tastes.join(", ")}.</>}
        {distance && <> About {distance} km apart.</>}
        {fading && <span className="text-doubt"> Interest is falling, like tapioca after 2019.</span>}
      </>
    );
    if (ruledOut) {
      const trail = selected.trail ?? [];
      const drop = trail.slice(1).reduce<{ label: string; by: number } | null>((d, t, i) => {
        const by = trail[i].confidence - t.confidence;
        return by > 0 && (!d || by > d.by) ? { label: t.label, by } : d;
      }, null);
      top = (
        <span>
          <span className="text-doubt">{selected.category}</span>
          <span className="text-muted"> · Ruled out by its own checks · </span>
          <span className="text-doubt">{pct(selected.confidence)}%</span>
        </span>
      );
      sub = (
        <>
          {trail.length > 1 && <>Its checks took it from {pct(trail[0].confidence)}% to {pct(selected.confidence)}%. </>}
          {drop && <>The biggest drop, −{pct(drop.by)} points, came from {checking(drop.label)}. </>}
          {ruledOut}.
        </>
      );
    }
    if (status === "error") extra = <p className="mt-2 text-[13px] text-danger">{errorText(state.error ?? "", meta.budget)}</p>;
  } else if (status === "done") {
    // The try-another chips sit in the result panel below, not here.
    top = <span className="text-muted">No convincing gap</span>;
    main = `Nothing ${city} is clearly missing${focus !== "all" ? ` in ${focusLabel(focus)}` : ""}.`;
    sub = `The agent found ${state.twins.length} taste twins, but none of them supports something ${city} lacks. That is a real answer, not an error.`;
  } else {
    const step = currentStep(state);
    const phase = step?.phase ?? "profile";
    top = step?.ruledOut ? <span className="text-doubt">Ruled out</span> : <span className={phase === "think" ? "text-llm" : "text-muted"}>{PHASE_LABEL[phase]}</span>;
    main = step ? (phase === "think" ? firstSentence(step.detail ?? step.title) : step.move ? <MoveTitle move={step.move} /> : step.title.replace(/^Ruled out: /, "")) : `Asking Qloo about ${city}…`;
    sub = (
      <>
        {step?.detail && phase !== "think" && <span className="block">{clip(step.detail, 140)}</span>}
        <span className="num mt-1 block text-[12px]">
          Step {state.steps.length} · {state.callsUsed}/{meta.budget} Qloo calls
        </span>
      </>
    );
  }

  return (
    <div>
      {state.replay && <ReplayBanner replay={state.replay} className="mb-3" />}
      <p className={eyebrow}>{top}</p>
      <p className={`${headline} mt-1`} aria-live="polite">
        {main}
      </p>
      {sub && <div className="mt-2 line-clamp-4 text-[15px] text-muted md:line-clamp-3">{sub}</div>}
      {extra}
    </div>
  );
}

function Retry({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-3 h-9 rounded-full bg-accent px-5 text-[13px] font-semibold text-on-accent">
      Try again
    </button>
  );
}

// "Checked the trend: -50% over the year" -> "checking the trend (-50% over the year)"
function checking(label: string) {
  const text = label.replace(/^Checked /, "checking ");
  const at = text.indexOf(": ");
  return at < 0 ? text : `${text.slice(0, at)} (${text.slice(at + 2)})`;
}
