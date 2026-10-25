import type { AgentEvent, Modes, OpportunityCard } from "@/lib/agent/types";
import sample from "@/data/sample-run.json";
import { AgentBadge, REPO_URL } from "./explorer/AppHeader";
import { Arrow } from "./explorer/Arrow";
import { focusName } from "./explorer/format";
import { OpportunityDetail } from "./explorer/OpportunityDetail";

const STEPS = [
  { title: "Profile the neighbourhoods", body: "What do the people of each neighbourhood love?", api: "/v2/insights filter.type=urn:tag signal.location.query" },
  {
    title: "Find taste twins",
    body: "Which neighbourhoods in other cities are loved by people with the same tastes?",
    api: "urn:entity:locality signal.interests.entities (the home neighbourhood), then the taste tags each locality shares with it",
  },
  { title: "Compare supply", body: "Count places per category within 2.5 km of each neighbourhood’s centre, the same area on both sides.", api: "urn:entity:place filter.tags filter.location filter.location.radius" },
  {
    title: "Doubt every gap",
    body: "Does the rest of the city already have it? Do the category’s fans match the people who live here? Is interest fading? With a key, does Google Maps see the same gap?",
    api: "urn:demographics, urn:entity:place filter.tags, /v2/trending (not available for places); Tokyo ward statistics; Google Maps (cross-check only)",
  },
  { title: "Score", body: "Six scores and a confidence, computed in code from the answers above.", api: "no extra calls" },
];

const SCORES = [
  ["Proven elsewhere", "Qloo", "min(1, places in twin ÷ 15)"],
  ["Bridge audience", "Qloo", "share of Qloo taste tags the two neighbourhoods have in common ÷ 0.5, max 1"],
  [
    "Core audience fit",
    "Qloo + Tokyo ward statistics",
    "do the category’s fans (Qloo) and the people here lean to the same age bands? In Tokyo, the residents (ward statistics); elsewhere, fans of the neighbourhood’s top tastes (Qloo). Correlation, mapped to 0–1",
  ],
  ["Local undersupply", "Qloo", "(twin − here) ÷ twin, × 0.6 if more than 20 exist city-wide"],
  ["Product fit", "LLM judgment", "Claude, 0–1; not counted when pending"],
  ["Durability", "Qloo", "0.5 + 12-month change in /v2/trending, clamped 0–1; not measurable for places on live data, so not counted"],
];

// The longer explanations, folded so the page leads with the step diagram.
function FOLDS(mock: boolean): [string, React.ReactNode][] {
  return [
    [
      "Why this exists",
      <div key="why">
        <p>
          Bubble tea and malatang both took off in Japan years after they were proven elsewhere. Big chains pay for research to see gaps like these early; small
          founders can’t. Culture Arbitrage closes that information gap with Qloo’s taste data.
        </p>
        <p className="mt-2">Who it’s for: independent founders, franchise scouts, landlords, local economic-development teams.</p>
      </div>,
    ],
    [
      "Six scores and the confidence",
      <div key="scores">
        <table className="w-full text-left">
          <thead className="text-[12px]">
            <tr className="border-b border-line">
              <th className="py-2 pr-4 font-normal">Score</th>
              <th className="py-2 pr-4 font-normal">Source</th>
              <th className="py-2 font-normal">How it’s computed</th>
            </tr>
          </thead>
          <tbody>
            {SCORES.map(([name, source, how]) => (
              <tr key={name} className="border-b border-line align-top">
                <td className="py-2 pr-4 font-semibold text-ink">{name}</td>
                <td className={`py-2 pr-4 ${source.startsWith("Qloo") ? "text-twin" : "text-llm"}`}>{source}</td>
                <td className="py-2">{how}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3">
          Confidence = average of the measured scores × (1 − 0.05 × open doubts, at most 0.4 off). Below 55%, the agent rules the idea out: it stays on screen greyed
          out, with the reasons, and is not counted as an opportunity.
        </p>
      </div>,
    ],
    [
      "With or without Claude",
      <p key="claude">
        With Claude, the same tools are offered to the model, which decides the order, skips dead ends and writes the summary. Without it, a fixed pipeline runs the
        steps in order. Either way, every Qloo call is capped per run and logged.
      </p>,
    ],
    [
      "What the agent can’t know",
      <ul key="limits" className="list-disc space-y-1.5 pl-5">
        <li>A place missing from Qloo may be missing from the index, not from the street. The city-wide check and the thin-data flag catch some of these cases, not all.</li>
        <li>Results are a snapshot of today’s taste data, not a historical backtest.</li>
        <li>Boba and malatang are survivors. Tapioca shows a real gap can fade, which is why Durability is scored.</li>
        <li>Similarity is between audiences, not streets. Rent, regulation and footfall are out of scope.</li>
        {mock && <li className="text-doubt">No Qloo key is set, so the page is showing sample data: demo numbers, not real Qloo data.</li>}
      </ul>,
    ],
  ];
}

type Recorded = { recordedAt: string | null; events: (AgentEvent & { t?: number })[] };

function example() {
  const { recordedAt, events } = sample as Recorded;
  const start = events.find((e) => e.type === "start");
  const done = events.find((e) => e.type === "done");
  const cards = events.filter((e): e is { type: "card"; card: OpportunityCard } => e.type === "card").map((e) => e.card);
  if (!start || !done || !cards.length) return null;
  const top = [...cards].sort((a, b) => b.confidence - a.confidence)[0];
  return { recordedAt, start, done, top };
}

// Whether the page has an example result for the "See an example result" link to point at.
export function hasExample() {
  return example() !== null;
}

export function HowItWorks({ modes }: { modes: Modes }) {
  const ex = example();
  return (
    <section id="how" className="mx-auto mt-16 w-full max-w-[1360px] px-4 md:px-6 lg:px-8">
      <div className="border-t border-line pt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-serif text-[32px] leading-tight">How it works</h2>
          <span className="md:hidden">
            <AgentBadge meta={modes} />
          </span>
        </div>
        <ol className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((st, n) => (
            <li key={st.title} className="relative rounded-2xl bg-surface p-4 ring-1 ring-line">
              <span className="num flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[13px] font-semibold text-on-accent">{n + 1}</span>
              <p className="mt-3 font-semibold leading-snug">{st.title}</p>
              <p className="mt-1 text-[13px] text-muted">{st.body}</p>
              <details className="mt-2">
                <summary className="cursor-pointer text-[12px] text-muted underline decoration-line underline-offset-2">Show request</summary>
                <p className="mt-1 font-mono text-[11px] text-twin [overflow-wrap:anywhere]">{st.api}</p>
              </details>
              {n < STEPS.length - 1 && (
                <span className="absolute -right-2.5 top-6 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-page text-muted lg:flex" aria-hidden="true">
                  <Arrow silent />
                </span>
              )}
            </li>
          ))}
        </ol>

        <div className="mt-8 grid gap-x-10 gap-y-3 lg:grid-cols-2">
          {FOLDS(modes.qlooMode === "mock").map(([title, body]) => (
            <details key={title} className="border-t border-line pt-3">
              <summary className="cursor-pointer font-semibold hover:text-accent">{title}</summary>
              <div className="mt-2 max-w-[68ch] text-[14px] text-muted">{body}</div>
            </details>
          ))}
        </div>

        {ex && (
          <div id="example" className="mt-16 scroll-mt-6 rounded-2xl border border-line bg-surface p-4 md:p-8">
            <p className="text-[13px] font-semibold text-muted">
              Example from a recorded run in {ex.start.type === "start" ? ex.start.city : ""} ({ex.start.type === "start" ? focusName(ex.start.focus) : "all categories"}
              {ex.recordedAt && `, ${ex.recordedAt.slice(0, 10)}`},{" "}
              {ex.start.type === "start" && ex.start.qlooMode === "live" ? "live" : "simulated"} Qloo data)
            </p>
            {ex.done.type === "done" && (
              <p className="mt-1 text-[14px] text-muted">
                {ex.done.cards} {ex.done.cards === 1 ? "opportunity" : "opportunities"} from {ex.done.callsUsed} of {ex.done.budget} Qloo calls
              </p>
            )}
            <div className="mt-6">
              <OpportunityDetail card={ex.top} llmMode={ex.start.type === "start" ? ex.start.llmMode : "none"} rank={1} headingLevel={3} />
            </div>
          </div>
        )}

        <p className="mt-10 flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
          <a href={REPO_URL} className="underline decoration-line underline-offset-4 hover:decoration-ink">
            GitHub repository
          </a>
          <a href={`${REPO_URL}#readme`} className="underline decoration-line underline-offset-4 hover:decoration-ink">
            README
          </a>
          <a href={`${REPO_URL}/blob/main/LICENSE`} className="underline decoration-line underline-offset-4 hover:decoration-ink">
            MIT License
          </a>
        </p>
      </div>
    </section>
  );
}
