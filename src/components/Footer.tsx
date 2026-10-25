import type { Modes } from "@/lib/agent/types";

export function Footer({ modes }: { modes: Modes }) {
  return (
    <footer className="mx-auto mt-16 w-full max-w-[1360px] px-4 pb-10 md:px-6 lg:px-8">
      <p className="max-w-[90ch] border-t border-line pt-6 text-[12px] text-muted">
        Built for the Qloo Agentic Hackathon 2026. Taste, neighbourhood and place numbers come from Qloo’s Insights API. Resident ages for Tokyo come from Tokyo
        Metropolitan Government statistics (ward population by age), and the place-count cross-check comes from Google Maps; both are labelled where they appear.
        Product fit is Claude’s judgment, also labelled. Map data: Natural Earth (public domain) via world-atlas. MIT License.
        {modes.qlooMode === "mock" && " Currently showing sample data: demo numbers, not real Qloo data."}
      </p>
    </footer>
  );
}
