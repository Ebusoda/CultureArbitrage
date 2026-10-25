import type { Meta } from "./useExploreRun";

export const REPO_URL = "https://github.com/Ebusoda/CultureArbitrage";

export function QlooBadge({ meta }: { meta: Meta }) {
  return meta.qlooMode === "live" ? (
    <span title="Taste and place numbers come from live Qloo API responses; other sources are labelled where they appear." className="whitespace-nowrap rounded-full border border-twin/30 bg-twin/10 px-2.5 py-0.5 text-[12px] text-twin">
      Live Qloo data
    </span>
  ) : (
    <span
      title="Sample data: demo numbers, not real Qloo data. The site falls back to this when no Qloo key is set."
      className="whitespace-nowrap rounded-full border border-doubt/30 bg-doubt/10 px-2.5 py-0.5 text-[12px] text-doubt"
    >
      Sample data
    </span>
  );
}

export function AgentBadge({ meta }: { meta: Meta }) {
  return meta.llmMode === "claude" ? (
    <span title={`Claude plans the search and calls Qloo through tools${meta.model ? ` (${meta.model})` : ""}.`} className="rounded-full border border-llm/30 bg-llm/10 px-2.5 py-0.5 text-[12px] text-llm">
      Planned by Claude
    </span>
  ) : (
    <span
      title={meta.fallbackReason ? `Claude was unavailable (${meta.fallbackReason}), so the fixed pipeline ran.` : "A fixed sequence of Qloo lookups, with no language model."}
      className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-muted"
    >
      Fixed pipeline, no LLM
    </span>
  );
}

export function AppHeader({ meta }: { meta: Meta }) {
  return (
    <header className="flex h-14 items-center justify-between gap-3 border-b border-line">
      <p className="flex items-center gap-2 whitespace-nowrap font-serif text-[20px] font-extrabold leading-none before:size-[14px] before:shrink-0 before:rounded-tl-full before:rounded-br-full before:bg-accent before:content-[''] md:text-[22px] md:before:size-[16px]">Culture Arbitrage</p>
      <div className="flex items-center gap-2">
        <QlooBadge meta={meta} />
        <span className="hidden md:inline">
          <AgentBadge meta={meta} />
        </span>
        <a href={REPO_URL} className="ml-1 flex items-center gap-1.5 text-[13px] text-muted hover:text-ink" aria-label="Source code on GitHub">
          <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" className="fill-current">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          <span className="hidden md:inline">GitHub</span>
        </a>
      </div>
    </header>
  );
}
