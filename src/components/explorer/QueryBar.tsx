"use client";

import { useRef } from "react";
import type { AskedTarget, Focus } from "@/lib/agent/types";
import { Arrow } from "./Arrow";
import { CategoryPicker } from "./CategoryPicker";
import { businessName, clip, FOCUS_OPTIONS } from "./format";
import { sameTarget, type RunState } from "./useExploreRun";

interface Props {
  state: RunState;
  cities: string[];
  onCity: (city: string) => void;
  onFocus: (focus: Focus) => void;
  onRun: () => void;
  // Whether the page has an example result to link to (How it works).
  hasExample?: boolean;
  // Picks (or clears) one business type to check instead of a scan. Without it, no search box.
  onTarget?: (target: AskedTarget | null) => void;
  // The server's Qloo mode (a recording on screen carries the mode it was recorded in).
  qlooMode?: string;
}

export function QueryBar({ state, cities, onCity, onFocus, onRun, hasExample = true, onTarget, qlooMode }: Props) {
  const { status, pickCity: city, pickFocus: focus, meta, callsUsed } = state;
  const target = state.pickTarget;
  const busy = status === "connecting" || status === "running";
  // Once results are on screen, a changed picker means a new question, so the button names it.
  const changed = city !== state.city || focus !== state.focus || !sameTarget(target, state.askedTarget);
  const label = busy ? "Exploring…" : status === "done" && !changed ? "Explore again" : status === "error" && !changed ? "Try again" : (
    <>
      {target ? `Check ${clip(businessName(target.label), 28)} in ${city}` : `Explore ${city}`} <Arrow silent />
    </>
  );
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  // Arrow keys move the choice within the group, as for native radio buttons.
  const onRadioKey = (e: React.KeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || busy) return;
    e.preventDefault();
    const next = (i + step + FOCUS_OPTIONS.length) % FOCUS_OPTIONS.length;
    onFocus(FOCUS_OPTIONS[next].value);
    radios.current[next]?.focus();
  };
  const used = state.summary?.callsUsed ?? callsUsed;
  const share = meta.budget ? used / meta.budget : 0;

  return (
    <section className="mt-6 flex flex-wrap items-end gap-x-6 gap-y-3">
      <label className="flex items-center gap-2 font-serif text-[22px] leading-none md:text-[26px]">
        <span>What is</span>
        <span className="relative inline-flex items-center">
          <select
            value={city}
            disabled={busy}
            onChange={(e) => onCity(e.target.value)}
            aria-label="City"
            className="cursor-pointer appearance-none rounded-full bg-surface py-1 pl-3.5 pr-9 font-serif text-[22px] leading-tight text-accent shadow-sm ring-1 ring-line disabled:opacity-60 md:text-[26px]"
          >
            {cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true" className="pointer-events-none absolute right-3.5 fill-none stroke-accent" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 1.5l5 5 5-5" />
          </svg>
        </span>
        <span>missing?</span>
      </label>

      <div role="radiogroup" aria-label="Focus" className={`grid w-full grid-cols-4 rounded-full bg-line/60 p-1 md:inline-grid md:w-auto${target ? " opacity-60" : ""}`}>
        {FOCUS_OPTIONS.map((f, i) => {
          // Checking one business type: no focus is in use (picking one goes back to a scan).
          const on = f.value === focus && !target;
          return (
            <button
              key={f.value}
              ref={(el) => {
                radios.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on || (target && f.value === focus) ? 0 : -1}
              // aria-disabled, not disabled: a disabled button drops keyboard focus to the page.
              aria-disabled={busy}
              onClick={() => !busy && onFocus(f.value)}
              onKeyDown={(e) => onRadioKey(e, i)}
              className={`rounded-full px-3 py-1.5 text-[13px] md:px-4 md:text-[14px] ${on ? "bg-surface font-semibold text-ink shadow-sm" : "font-medium text-muted hover:text-ink"} aria-disabled:opacity-60`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        // aria-disabled, not disabled, so the button keeps keyboard focus while the run starts.
        onClick={() => !busy && onRun()}
        aria-disabled={busy}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-7 text-[15px] font-bold text-on-accent shadow-sm aria-disabled:opacity-80 md:h-11 md:w-auto"
      >
        {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-accent border-t-transparent motion-reduce:animate-none" aria-hidden="true" />}
        {label}
      </button>

      {/* Live runs off: every run plays a recorded scan, so a business check could not run. */}
      {onTarget && !meta.forceReplay && (
        <div className="w-full">
          <CategoryPicker value={target} onChange={onTarget} city={city} cities={cities} qlooMode={qlooMode ?? meta.qlooMode} disabled={busy} />
        </div>
      )}

      <div className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p className="text-[13px] text-muted">
          {meta.forceReplay
            ? "Live runs are off right now: each run plays a recorded one."
            : `${meta.llmMode === "claude" ? "About 1–2 minutes" : "About 15 seconds"}, at most ${meta.budget} Qloo calls.`}{" "}
          {hasExample && (
            <a href="#example" className="font-medium text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent">
              See an example result ↓
            </a>
          )}
        </p>
        {status !== "idle" && (
          <div className="ml-auto flex items-center gap-2">
            <span className="num text-[12px] text-muted">
              {used} of {meta.budget} Qloo calls
            </span>
            <span className="h-2 w-[120px] overflow-hidden rounded-full bg-line" aria-hidden="true">
              <span className={`block h-full rounded-full ${share >= 0.9 ? "bg-doubt" : "bg-accent"}`} style={{ width: `${Math.min(100, share * 100)}%` }} />
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
