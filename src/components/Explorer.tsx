"use client";

import { useCallback, useRef } from "react";
import type { Focus, Modes } from "@/lib/agent/types";
import { AgentLog, NowTicker } from "./explorer/AgentLog";
import { AppHeader } from "./explorer/AppHeader";
import { arcs as deriveArcs, rankOf, trayCards } from "./explorer/derive";
import { EmptyResult } from "./explorer/EmptyResult";
import { Hero } from "./explorer/Hero";
import { MapLegend } from "./explorer/MapLegend";
import { OpportunityDetail } from "./explorer/OpportunityDetail";
import { OpportunityTray } from "./explorer/OpportunityTray";
import { QueryBar } from "./explorer/QueryBar";
import { RouteMap } from "./explorer/RouteMap";
import { StoryCaption } from "./explorer/StoryCaption";
import { linkKey, useExploreRun } from "./explorer/useExploreRun";

// hasExample: How it works below has an example result to link to.
export function Explorer({ cities, modes, hasExample = true }: { cities: string[]; modes: Modes; hasExample?: boolean }) {
  const [state, act] = useExploreRun(cities, modes);
  const caption = useRef<HTMLDivElement>(null);
  const { status, city } = state;
  const idle = status === "idle";
  const running = status === "connecting" || status === "running";
  const tray = trayCards(state);
  const ruledOut = state.rejected.find((r) => r.card.id === state.selectedId) ?? null;
  const selected = state.cards.find((c) => c.id === state.selectedId) ?? ruledOut?.card ?? null;
  const rank = selected ? rankOf(state, selected.id) : null;
  const arcs = deriveArcs(state);
  const selectedKey = selected ? linkKey(selected.homeLocality, selected.homeCity, selected.twinLocality, selected.twinCity) : null;

  // The Retry button and the try-another chips go away once a run starts, so keyboard focus
  // moves to the caption that reports the new run instead of falling back to the page.
  const focusCaption = () => caption.current?.focus({ preventScroll: true });
  // Try-another chips start a run straight away, so the picker follows them.
  const tryOther = (c: string, f: Focus) => {
    act.setCity(c);
    act.setFocus(f);
    void act.run(c, f);
    focusCaption();
  };
  // A retry asks the visitor's question again, even when a recording for another focus answered it.
  const retry = () => {
    void act.run(city, state.askedFocus);
    focusCaption();
  };
  const onFocusDone = useCallback(() => act.focusCall(null), [act]);

  return (
    <div className="mx-auto w-full max-w-[1360px] px-4 md:px-6 lg:px-8">
      <AppHeader meta={state.meta} />
      <Hero idle={idle} />
      <QueryBar state={state} cities={cities} onCity={act.setCity} onFocus={act.setFocus} onRun={() => void act.run(state.pickCity, state.pickFocus)} hasExample={hasExample} />

      <main>
        <div className="mt-6 flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-x-6">
          <section aria-label="Route map" className="order-1 lg:col-start-1 lg:row-start-1">
            <div className="relative">
              <div className="relative h-[clamp(200px,64vw,300px)] overflow-hidden rounded-2xl border border-line bg-page shadow-xs md:h-[420px] lg:h-[clamp(400px,60vh,600px)]">
                <RouteMap
                  cities={cities}
                  home={city}
                  status={status}
                  arcs={arcs}
                  selectedId={state.selectedId}
                  revealId={status === "done" && !state.pinned ? state.selectedId : null}
                  onSelect={act.select}
                  selectedKey={selectedKey}
                  sharedTaste={state.meta.qlooMode === "live"}
                />
                {state.meta.qlooMode !== "live" && (
                  <p className="absolute left-3 top-3 rounded-full border border-doubt/30 bg-surface/90 px-2.5 py-0.5 text-[11px] font-semibold text-doubt">
                    Sample data<span className="hidden md:inline">: demo numbers, not real Qloo data</span>
                  </p>
                )}
              </div>
              {/* Below lg the caption sits under the map. On lg it floats bottom-left, narrow enough to leave room for the legend. */}
              <div
                ref={caption}
                tabIndex={-1}
                className="mt-3 outline-none lg:absolute lg:bottom-0 lg:left-0 lg:m-4 lg:mt-0 lg:max-w-[min(400px,calc(100%-15rem))] lg:rounded-2xl lg:border lg:border-line lg:bg-surface/95 lg:p-4 lg:shadow-md lg:backdrop-blur-sm"
              >
                <StoryCaption
                  state={state}
                  selected={selected}
                  ruledOut={ruledOut?.reason ?? null}
                  rank={rank}
                  total={state.cards.length}
                  onRetry={retry}
                />
              </div>
              <div className="mt-3 md:absolute md:bottom-0 md:right-0 md:m-4 md:mt-0 md:rounded-xl md:bg-surface/90 md:px-3 md:py-2.5 md:shadow-sm md:backdrop-blur-sm">
                <MapLegend idle={idle} cities={cities} />
              </div>
            </div>
            <NowTicker state={state} onToggle={act.toggleLog} />
          </section>

          <div className="order-3 md:order-4 lg:relative lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <AgentLog
              state={state}
              onFocusDone={onFocusDone}
              onChip={act.focusCall}
              className={`${state.logOpen ? "mt-3 block" : "hidden"} max-h-[60vh] md:mt-6 md:block md:max-h-[420px] lg:absolute lg:inset-0 lg:mt-0 lg:max-h-none`}
            />
          </div>

          <div className="order-4 md:order-3 lg:col-start-1 lg:row-start-2">
            <OpportunityTray cards={tray} rejected={state.rejected} selectedId={state.selectedId} ranked={status === "done"} running={running} onSelect={act.select} />
          </div>
        </div>

        {!idle && (
          <div className="mt-10">
            {selected ? (
              <OpportunityDetail
                key={selected.id}
                card={selected}
                ruledOut={ruledOut?.reason}
                llmMode={state.meta.llmMode}
                rank={rank}
                onChip={act.focusCall}
                // With no opportunities, the run's summary is one step back from a ruled-out idea.
                onBack={ruledOut && status === "done" && !state.cards.length ? () => act.select(null) : undefined}
              />
            ) : status === "done" && !state.cards.length ? (
              <EmptyResult state={state} cities={cities} onTry={tryOther} onChip={act.focusCall} />
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
