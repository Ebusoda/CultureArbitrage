import type { AgentEvent, Modes, OpportunityCard } from "@/lib/agent/types";
import sample from "@/data/sample-run.json";
import { AgentBadge, REPO_URL } from "./explorer/AppHeader";
import { OpportunityDetail } from "./explorer/OpportunityDetail";

const STEPS = [
  { title: "Profile the neighbourhoods", body: "What do the people of each neighbourhood love?", api: "/v2/insights filter.type=urn:tag signal.location.query" },
  {
    title: "Find taste twins",
    body: "Which neighbourhoods in other cities are loved by people with the same tastes?",
    api: "urn:entity:locality signal.interests.tags filter.location.query",
  },
  { title: "Compare supply", body: "Count places per category in each neighbourhood and its twin.", api: "urn:entity:place filter.location.query" },
  {
    title: "Doubt every gap",
    body: "Does the rest of the city already have it? Do the category's fans match the people here? Is interest fading?",
    api: "urn:demographics, urn:entity:place filter.tags, /v2/trending signal.interests.entities",
  },
  { title: "Score", body: "Six scores and a confidence, computed in code from the answers above.", api: "no extra calls" },
];

const SCORES = [
  ["Proven elsewhere", "Qloo", "min(1, places in twin ÷ 15)"],
  ["Bridge audience", "Qloo", "twin's affinity for the home neighbourhood's top 4 tastes (a proxy)"],
  ["Core audience fit", "Qloo", "age-profile overlap between the category's fans and the neighbourhood's people"],
  ["Local undersupply", "Qloo", "(twin − here) ÷ twin, × 0.6 if more than 20 exist city-wide"],
  ["Product fit", "LLM judgment", "Claude, 0–1; not counted when pending"],
  ["Durability", "Qloo", "0.5 + 12-month change in /v2/trending, clamped 0–1"],
];

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
        <div className="mt-6 grid gap-10 lg:grid-cols-2">
          <div className="space-y-8">
            <div>
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Why this exists</h3>
              <p className="mt-2 max-w-[68ch]">
                Bubble tea and malatang both took off in Japan years after they were proven elsewhere. Big chains pay for research to see gaps like these early;
                small founders can’t. Culture Arbitrage closes that information gap with Qloo’s taste data.
              </p>
              <p className="mt-2 max-w-[68ch] text-muted">Who it’s for: independent founders, franchise scouts, landlords, local economic-development teams.</p>
            </div>
            <div>
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">How the agent works</h3>
              <ol className="mt-3 space-y-4">
                {STEPS.map((s, i) => (
                  <li key={s.title} className="flex gap-3">
                    <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-semibold text-on-accent">{i + 1}</span>
                    <div>
                      <p className="font-semibold">{s.title}</p>
                      <p className="text-muted">{s.body}</p>
                      <p className="mt-0.5 font-mono text-[12px] text-twin [overflow-wrap:anywhere]">{s.api}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-4 max-w-[68ch] text-[14px] text-muted">
                With Claude, the same tools are offered to the model, which decides the order, skips dead ends and writes the summary. Without it, a fixed
                pipeline runs the steps in order. Either way, every Qloo call is capped per run and logged.
              </p>
            </div>
          </div>
          <div className="space-y-8">
            <div>
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Six scores</h3>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-[14px]">
                  <thead className="text-[12px] text-muted">
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-normal">Score</th>
                      <th className="py-2 pr-4 font-normal">Source</th>
                      <th className="py-2 font-normal">How it’s computed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SCORES.map(([name, source, how]) => (
                      <tr key={name} className="border-b border-line align-top">
                        <td className="py-2 pr-4 font-semibold">{name}</td>
                        <td className={`py-2 pr-4 ${source === "Qloo" ? "text-twin" : "text-llm"}`}>{source}</td>
                        <td className="py-2 text-muted">{how}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[14px]">
                Confidence = average of the measured scores × (1 − 0.05 × open doubts, at most 0.4 off). Below 55%, the agent rules the idea out: it stays on screen greyed out, with the reasons, and is not counted as an opportunity.
              </p>
            </div>
            <div>
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">What the agent can’t know</h3>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[14px] text-muted">
                <li>A place missing from Qloo may be missing from the index, not from the street. The city-wide check and the thin-data flag catch some of these cases, not all.</li>
                <li>Results are a snapshot of today’s taste data, not a historical backtest.</li>
                <li>Boba and malatang are survivors. Tapioca shows a real gap can fade, which is why Durability is scored.</li>
                <li>Similarity is between audiences, not streets. Rent, regulation and footfall are out of scope.</li>
                {modes.qlooMode === "mock" && <li className="text-doubt">Qloo responses are currently simulated from hand-made sample data.</li>}
              </ul>
            </div>
          </div>
        </div>

        {ex && (
          <div id="example" className="mt-16 scroll-mt-6 rounded-2xl border border-line bg-surface p-4 md:p-8">
            <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">
              Example from a recorded run · {ex.start.type === "start" ? ex.start.city : ""} · all categories
              {ex.recordedAt && ` · ${ex.recordedAt.slice(0, 10)}`} · {ex.start.type === "start" && ex.start.qlooMode === "live" ? "live" : "simulated"} Qloo data
            </p>
            {ex.done.type === "done" && (
              <p className="mt-1 text-[14px] text-muted">
                {ex.done.cards} opportunities from {ex.done.callsUsed} of {ex.done.budget} Qloo calls
              </p>
            )}
            <div className="mt-6">
              <OpportunityDetail card={ex.top} llmMode={ex.start.type === "start" ? ex.start.llmMode : "none"} rank={1} />
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
