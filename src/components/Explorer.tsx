"use client";

import { useCallback } from "react";
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
import { useExploreRun } from "./explorer/useExploreRun";

export function Explorer({ cities, modes }: { cities: string[]; modes: Modes }) {
  const [state, act] = useExploreRun(cities, modes);
  const { status, city, focus } = state;
  const idle = status === "idle";
  const running = status === "connecting" || status === "running";
  const tray = trayCards(state);
  const ruledOut = state.rejected.find((r) => r.card.id === state.selectedId) ?? null;
  const selected = state.cards.find((c) => c.id === state.selectedId) ?? ruledOut?.card ?? null;
  const rank = selected ? rankOf(state, selected.id) : null;
  const arcs = deriveArcs(state);

  const tryOther = (c: string, f: Focus) => {
    act.setCity(c);
    act.setFocus(f);
    void act.run(c, f);
  };
  const onFocusDone = useCallback(() => act.focusCall(null), [act]);

  return (
    <div className="mx-auto w-full max-w-[1360px] px-4 md:px-6 lg:px-8">
      <AppHeader meta={state.meta} />
      <Hero idle={idle} />
      <QueryBar state={state} cities={cities} onCity={act.setCity} onFocus={act.setFocus} onRun={() => void act.run(city, focus)} />

      <main className="mt-6 flex flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-x-6">
        <section aria-label="Route map" className="order-1 lg:col-start-1 lg:row-start-1">
          <div className="relative">
            <div className="relative h-[clamp(200px,64vw,300px)] overflow-hidden rounded-2xl border border-line bg-page shadow-xs md:h-[420px] lg:h-[clamp(360px,54vh,560px)]">
              <RouteMap
                cities={cities}
                home={city}
                status={status}
                arcs={arcs}
                selectedId={state.selectedId}
                revealId={status === "done" && !state.pinned ? state.selectedId : null}
                onSelect={act.select}
              />
              {state.meta.qlooMode !== "live" && (
                <p className="absolute left-3 top-3 rounded-full border border-doubt/30 bg-surface/90 px-2.5 py-0.5 text-[11px] font-semibold text-doubt">
                  SAMPLE DATA<span className="hidden md:inline"> · numbers are invented until the Qloo key arrives</span>
                </p>
              )}
            </div>
            <div className="mt-3 md:absolute md:bottom-0 md:left-0 md:m-4 md:mt-0 md:max-w-[460px] md:rounded-2xl md:border md:border-line md:bg-surface/95 md:p-4 md:shadow-md md:backdrop-blur-sm lg:max-w-[540px] lg:p-5">
              <StoryCaption
                state={state}
                selected={selected}
                ruledOut={ruledOut?.reason ?? null}
                rank={rank}
                total={state.cards.length}
                onRetry={() => void act.run(city, focus)}
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
            className={`${state.logOpen ? "mt-3 block" : "hidden"} max-h-[60vh] md:mt-6 md:block md:max-h-[420px] lg:absolute lg:inset-0 lg:mt-0 lg:max-h-none`}
          />
        </div>

        <div className="order-4 md:order-3 lg:col-start-1 lg:row-start-2">
          <OpportunityTray cards={tray} rejected={state.rejected} selectedId={state.selectedId} ranked={status === "done"} running={running} onSelect={act.select} />
        </div>
      </main>

      {!idle && (
        <div className="mt-10">
          {selected ? (
            <OpportunityDetail card={selected} ruledOut={ruledOut?.reason} llmMode={state.meta.llmMode} rank={rank} onChip={act.focusCall} />
          ) : status === "done" ? (
            <EmptyResult state={state} cities={cities} onTry={tryOther} onChip={act.focusCall} />
          ) : null}
        </div>
      )}
    </div>
  );
}
