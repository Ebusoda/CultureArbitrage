"use client";

import type { OpportunityCard } from "@/lib/agent/types";
import { MoveTitle } from "./AgentLog";
import { currentStep, emptySummary, unfinished } from "./derive";
import { BAND_TEXT, band, clip, count, errorText, firstSentence, focusLabel, isFading, km, PHASE_LABEL, pct, plural, stoppedText } from "./format";
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

const eyebrow = "text-[13px] font-semibold";
const headline = "font-serif text-[26px] leading-[1.12] tabular-nums md:text-[28px] lg:text-[26px] lg:leading-[1.15]";

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
        <span className="text-muted">{rank !== null ? `, opportunity ${rank} of ${total}, ` : ", "}</span>
        <span className={BAND_TEXT[b]}>{pct(selected.confidence)}% confidence</span>
      </span>
    );
    // The count pair is the answer; the sentence stays for screen readers.
    main = (
      <>
        <span className="sr-only">
          Qloo lists {count(selected.twinCount, selected.capped.twin)} in {selected.twinLocality}, {count(selected.homeCount, selected.capped.home)} in{" "}
          {selected.homeLocality}.
        </span>
        <span aria-hidden="true" className="flex items-end gap-4">
          <Count n={count(selected.twinCount, selected.capped.twin)} place={selected.twinLocality} />
          <span className="pb-6 text-[15px] font-medium text-muted">vs</span>
          <Count n={count(selected.homeCount, selected.capped.home)} place={selected.homeLocality} accent />
        </span>
      </>
    );
    const pill = "rounded-full px-2.5 py-0.5 text-[13px] font-medium";
    extra = (
      <div className="mt-3 flex flex-wrap gap-1.5">
        {/* Live: the share of Qloo taste tags the two have in common, computed in code, not a Qloo score. */}
        {selected.twinSharedShare !== undefined ? (
          <span className={`${pill} bg-twin/10 text-twin`} title="Share of Qloo taste tags the two neighbourhoods have in common">
            {pct(selected.twinSharedShare)}% same taste
          </span>
        ) : (
          selected.twinSimilarity !== null && (
            <span className={`${pill} bg-twin/10 text-twin`} title="Qloo taste similarity">
              Same taste {selected.twinSimilarity.toFixed(2)}
            </span>
          )
        )}
        {tastes.map((t) => (
          <span key={t} className={`${pill} bg-surface ring-1 ring-inset ring-line`}>
            {t}
          </span>
        ))}
        {distance && <span className={`${pill} text-muted ring-1 ring-inset ring-line`}>{distance} km apart</span>}
        {fading && (
          <span className={`${pill} text-doubt ring-1 ring-inset ring-doubt/40`} title="Interest is falling, like tapioca after 2019">
            Fading
          </span>
        )}
      </div>
    );
    if (ruledOut) {
      extra = null;
      main = (
        <>
          Qloo lists {count(selected.twinCount, selected.capped.twin)} in {selected.twinLocality}, {count(selected.homeCount, selected.capped.home)} in{" "}
          {selected.homeLocality}.
        </>
      );
      const trail = selected.trail ?? [];
      const drop = trail.slice(1).reduce<{ label: string; by: number } | null>((d, t, i) => {
        const by = trail[i].confidence - t.confidence;
        return by > 0 && (!d || by > d.by) ? { label: t.label, by } : d;
      }, null);
      top = (
        <span>
          <span className="text-doubt">{selected.category}</span>
          <span className="text-muted">, ruled out by its own checks at </span>
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
    if (status === "error")
      extra = (
        <>
          {extra}
          <p className="mt-2 text-[13px] text-danger">{errorText(state.error ?? "", meta.budget)}</p>
        </>
      );
  } else if (status === "done") {
    // The try-another chips sit in the result panel below, not here.
    const sum = emptySummary(state);
    if (unfinished(sum)) {
      // Stopped early, or nothing compared: not an answer, so say so and offer a retry.
      top = <span className="text-doubt">Stopped early</span>;
      main = `No answer yet for ${city}${focus !== "all" ? ` in ${focusLabel(focus)}` : ""}.`;
      sub = sum.stopped
        ? `${stoppedText(sum.stopped)} The agent compared ${plural(sum.pairs, "taste-twin pair")} before it stopped.`
        : "The run ended before it could compare any taste-twin pair (out of Qloo calls or time).";
      extra = <Retry onClick={onRetry} />;
    } else {
      top = <span className="text-muted">No convincing gap</span>;
      main = `Nothing ${city} is clearly missing${focus !== "all" ? ` in ${focusLabel(focus)}` : ""}.`;
      const found = sum.ruledOut + sum.notSubmitted + sum.unclear;
      sub = found
        ? `The agent compared ${plural(sum.pairs, "taste-twin pair")}. ${[
            sum.ruledOut && `Its own checks ruled out ${plural(sum.ruledOut, "gap")}`,
            sum.notSubmitted && `${plural(sum.notSubmitted, "gap")} met the rule but ${sum.notSubmitted === 1 ? "was" : "were"} not submitted`,
            sum.unclear && `${plural(sum.unclear, "gap")} rested on a capped count`,
          ]
            .filter(Boolean)
            .join("; ")}. None made it to an opportunity.`
        : `The agent compared ${plural(sum.pairs, "taste-twin pair")}, but none of them supports something ${city} lacks. That is a real answer, not an error.`;
    }
  } else {
    const step = currentStep(state);
    const phase = step?.phase ?? "profile";
    top = step?.ruledOut ? <span className="text-doubt">Ruled out</span> : <span className={phase === "think" ? "text-llm" : "text-muted"}>{PHASE_LABEL[phase]}</span>;
    main = step ? (phase === "think" ? firstSentence(step.detail ?? step.title) : step.move ? <MoveTitle move={step.move} /> : step.title.replace(/^Ruled out: /, "")) : `Asking Qloo about ${city}…`;
    sub = (
      <>
        {step?.detail && phase !== "think" && <span className="block">{clip(step.detail, 140)}</span>}
        <span className="num mt-1 block text-[12px]">
          Step {state.steps.length}, {state.callsUsed} of {meta.budget} Qloo calls
        </span>
      </>
    );
  }

  // Screen readers hear the outcome once, not every step of the run.
  const outcome =
    status === "done"
      ? state.cards.length
        ? `Finished: ${state.cards.length} ${state.cards.length === 1 ? "opportunity" : "opportunities"} for ${city}.`
        : unfinished(emptySummary(state))
          ? `Stopped early: no answer yet for ${city}.`
          : `Finished: no convincing gap in ${city}.`
      : status === "error"
        ? `Run stopped: ${errorText(state.error ?? "", meta.budget)}`
        : "";

  return (
    <div>
      {state.replay && <ReplayBanner replay={state.replay} className="mb-3" focus={state.focus} askedFocus={state.askedFocus} />}
      <p className="sr-only" aria-live="polite">
        {outcome}
      </p>
      <p className={eyebrow}>{top}</p>
      <p className={`${headline} mt-1`}>{main}</p>
      {sub && <div className="mt-2 line-clamp-4 text-[15px] text-muted lg:line-clamp-3 lg:text-[14px]">{sub}</div>}
      {extra}
    </div>
  );
}

function Count({ n, place, accent = false }: { n: string; place: string; accent?: boolean }) {
  return (
    <span className="min-w-0">
      <span className={`block text-[44px] font-extrabold leading-none tabular-nums ${accent ? "text-accent" : ""}`}>{n}</span>
      <span className="mt-1 block truncate font-sans text-[13px] font-medium tracking-normal text-muted">{place}</span>
    </span>
  );
}

function Retry({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mt-3 h-9 rounded-full bg-accent px-5 text-[13px] font-semibold text-on-accent">
      Try again
    </button>
  );
}

// "Checked the trend: -50% over the year" -> "checking the trend (-50% over the year)".
// The last trail step ("Final score, with product fit 50%, 2 doubts of its own") is product fit and
// the agent's own doubts, not a check.
export function checking(label: string) {
  if (label.startsWith("Final score")) return /product fit|doubt/.test(label) ? "product fit and its own doubts" : "the checks it skipped";
  const text = label.replace(/^Checked /, "checking ");
  const at = text.indexOf(": ");
  return at < 0 ? text : `${text.slice(0, at)} (${text.slice(at + 2)})`;
}
