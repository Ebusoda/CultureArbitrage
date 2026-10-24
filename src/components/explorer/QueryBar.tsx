"use client";

import type { Focus } from "@/lib/agent/types";
import { Arrow } from "./Arrow";
import { FOCUS_OPTIONS } from "./format";
import type { RunState } from "./useExploreRun";

interface Props {
  state: RunState;
  cities: string[];
  onCity: (city: string) => void;
  onFocus: (focus: Focus) => void;
  onRun: () => void;
}

export function QueryBar({ state, cities, onCity, onFocus, onRun }: Props) {
  const { status, city, focus, meta, callsUsed } = state;
  const busy = status === "connecting" || status === "running";
  const label = busy ? "Exploring…" : status === "done" ? "Explore again" : status === "error" ? "Try again" : (
    <>
      Explore {city} <Arrow />
    </>
  );
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

      <div role="radiogroup" aria-label="Focus" className="grid w-full grid-cols-4 rounded-full bg-line/60 p-1 md:inline-grid md:w-auto">
        {FOCUS_OPTIONS.map((f) => {
          const on = f.value === focus;
          return (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy}
              onClick={() => onFocus(f.value)}
              className={`rounded-full px-3 py-1.5 text-[13px] md:px-4 md:text-[14px] ${on ? "bg-surface font-semibold text-ink shadow-sm" : "font-medium text-muted hover:text-ink"} disabled:opacity-60`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onRun}
        disabled={busy}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-7 text-[15px] font-bold text-on-accent shadow-sm disabled:opacity-80 md:h-11 md:w-auto"
      >
        {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-accent border-t-transparent motion-reduce:animate-none" aria-hidden="true" />}
        {label}
      </button>

      <div className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p className="text-[13px] text-muted">
          {meta.llmMode === "claude" ? "About 1–2 minutes" : "About 15 seconds"} · at most {meta.budget} Qloo calls ·{" "}
          <a href="#example" className="font-medium text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent">
            or see an example result ↓
          </a>
        </p>
        {status !== "idle" && (
          <div className="ml-auto flex items-center gap-2">
            <span className="num text-[12px] text-muted">
              Qloo calls {used} / {meta.budget}
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
