import type { Modes } from "@/lib/agent/types";

export function Footer({ modes }: { modes: Modes }) {
  return (
    <footer className="mx-auto mt-16 w-full max-w-[1360px] px-4 pb-10 md:px-6 lg:px-8">
      <p className="max-w-[90ch] border-t border-line pt-6 text-[12px] text-muted">
        Built for the Qloo Agentic Hackathon 2026. Every number comes from Qloo’s Insights and Trending APIs, except Product fit (Claude’s judgment, labelled).
        Map data: Natural Earth (public domain) via world-atlas. MIT License.{modes.qlooMode === "mock" && " Currently running on sample data."}
      </p>
    </footer>
  );
}
