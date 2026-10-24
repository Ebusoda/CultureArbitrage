"use client";

import { useState } from "react";
import type { EvidenceRef, OpportunityCard, ScoreItem } from "@/lib/agent/types";
import { Arrow } from "./Arrow";
import { BAND_TEXT, Q_CHIP, Q_CHIP_HOVER, band, count, isFading, km, pct, score } from "./format";

interface Props {
  card: OpportunityCard;
  // Why the agent ruled this idea out, when it did.
  ruledOut?: string;
  llmMode: string;
  rank?: number | null;
  // Without it, Q-numbers are plain text (the static example on the page).
  onChip?: (n: number) => void;
}

export function OpportunityDetail({ card, ruledOut, llmMode, rank, onChip }: Props) {
  const distance = km(card.twinCity, card.homeCity);
  return (
    <article className="fade-in">
      {ruledOut && (
        <p className="mb-6 max-w-[80ch] rounded-xl border border-dashed border-doubt/60 bg-page px-4 py-3 text-[14px]">
          <span className="font-semibold text-doubt">Ruled out by the agent’s own checks.</span> {ruledOut}, so it is not counted as an opportunity. It stays
          here so you can see why.
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:gap-10">
        <div>
          {rank === 1 && <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-accent">#1 · Strongest opportunity</p>}
          <h2 className="mt-1 font-serif text-[28px] leading-[1.1] md:text-[32px]">
            {card.category}: {card.twinLocality} <Arrow /> {card.homeLocality}
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            {card.twinCity} <Arrow /> {card.homeCity}
            {distance && ` · about ${distance} km`}
          </p>
          <p className="mt-4 max-w-[68ch] text-[15px] md:text-[16px]">{card.why}</p>
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
            {llmMode === "claude" ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-llm" aria-hidden="true" />
                Written by Claude
              </>
            ) : (
              "Template text (no LLM in this mode)"
            )}
          </p>
        </div>
        <ConfidenceBlock card={card} ruledOut={!!ruledOut} />
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:gap-8">
        <EvidenceChain card={card} onChip={onChip} />
        <div className="space-y-10">
          <ScoreList card={card} onChip={onChip} />
          <SelfCheck card={card} onChip={onChip} />
        </div>
      </div>
    </article>
  );
}

function ConfidenceBlock({ card, ruledOut }: { card: OpportunityCard; ruledOut: boolean }) {
  const p = pct(card.confidence);
  const b = band(card.confidence);
  const m = card.confidenceMath;
  const fitPending = score(card, "fit")?.value == null;
  return (
    <div className="md:w-[260px] md:text-right">
      <p className="font-serif text-[56px] font-extrabold leading-none tabular-nums">{p}%</p>
      <p className={`mt-1 text-[14px] font-semibold ${ruledOut ? "text-doubt" : BAND_TEXT[b]}`}>{ruledOut ? "Ruled out" : b}</p>
      {m && (
        <p className="num mt-2 text-[12px] text-muted">
          Average of {m.measured} of 6 scores ({Math.round(m.mean * 100)}) × doubt penalty {m.penalty.toFixed(2)} ({m.doubts} {m.doubts === 1 ? "doubt" : "doubts"}) ={" "}
          {p}%.
        </p>
      )}
      {fitPending && <p className="mt-1 text-[12px] text-muted">Product fit is pending and not counted.</p>}
    </div>
  );
}

export function QChips({ calls, onChip }: { calls: number[]; onChip?: (n: number) => void }) {
  const [all, setAll] = useState(false);
  if (!calls.length) return <span className="text-[11px] text-muted">not fetched</span>;
  const shown = all ? calls : calls.slice(0, 3);
  const chip = `rounded-full px-1.5 font-mono text-[11px] font-semibold leading-[18px] ${Q_CHIP}`;
  return (
    <span className="inline-flex shrink-0 flex-wrap justify-end gap-1">
      {shown.map((n) =>
        onChip ? (
          <button key={n} type="button" onClick={() => onChip(n)} className={`${chip} ${Q_CHIP_HOVER}`} aria-label={`Show Qloo call ${n} in the agent log`}>
            Q{n}
          </button>
        ) : (
          <span key={n} className={chip} title={`Call Q${n} of the recorded run`}>
            Q{n}
          </span>
        ),
      )}
      {!all && calls.length > 3 && (
        <button type="button" onClick={() => setAll(true)} className={chip}>
          +{calls.length - 3}
        </button>
      )}
    </span>
  );
}

function Row({ n, children, refs, onChip }: { n: number | null; children: React.ReactNode; refs?: number[]; onChip?: (n: number) => void }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-line/70 text-[11px] font-semibold text-ink">{n ?? "·"}</span>
      <p className="min-w-0 flex-1 text-[14px] md:text-[15px]">{children}</p>
      {refs && <QChips calls={refs} onChip={onChip} />}
    </li>
  );
}

const B = ({ children }: { children: React.ReactNode }) => <span className="font-semibold tabular-nums">{children}</span>;

const VERDICT: Record<NonNullable<OpportunityCard["google"]>["verdict"], string> = {
  confirms: "sees the gap too",
  weak: "sees a smaller gap",
  contradicts: "does not see this gap",
  inconclusive: "can’t settle it either way (too few places, or past its 60-result limit)",
};

// Google Maps data must be shown apart from other sources and labelled "Google Maps".
function GoogleMapsCheck({ card }: { card: OpportunityCard }) {
  const g = card.google;
  const n = (v: number, sat: boolean) => (sat ? `${v}+` : String(v));
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px]">
      {g ? (
        <p>
          Places listed for “{card.category.toLowerCase()}” in a {g.halfKm * 2} km square around each centre: <B>{n(g.home, g.homeSaturated)}</B> around {card.homeLocality}, <B>{n(g.twin, g.twinSaturated)}</B> around {card.twinLocality}. Google Maps {VERDICT[g.verdict]}.
        </p>
      ) : (
        <p className="text-muted">Cross-check not run: {card.googleSkipped}.</p>
      )}
      <p className="mt-1 text-[12px] text-muted">
        Cross-check against a second index. It changes no score or confidence; a gap it does not see is ruled out. Source:{" "}
        <span translate="no" className="font-medium text-ink">
          Google Maps
        </span>
      </p>
    </div>
  );
}

function EvidenceChain({ card, onChip }: { card: OpportunityCard; onChip?: (n: number) => void }) {
  const r = card.refs;
  const t = card.sharedTastes.slice(0, 3);
  const audience = score(card, "audience");
  const durability = score(card, "durability");
  const fit = score(card, "fit");
  return (
    <section>
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Evidence chain</h3>
      <ol className="mt-2 divide-y divide-line">
        <Row n={1} refs={card.twinSharedShare !== undefined ? r.twin : r.taste} onChip={onChip}>
          {card.twinSharedShare !== undefined ? <>{card.homeLocality} and {card.twinLocality} share Qloo tastes such as </> : <>People in {card.homeLocality} are into </>}
          {t.length
            ? t.map((x, i) => (
                <span key={x.name}>
                  {i > 0 && (i === t.length - 1 ? " and " : ", ")}
                  {x.name}
                  {x.affinity !== null && (
                    <>
                      {" "}
                      (<B>{x.affinity.toFixed(2)}</B>)
                    </>
                  )}
                </span>
              ))
            : "(no taste tags returned)"}
          .
        </Row>
        <Row n={2} refs={r.twin} onChip={onChip}>
          {card.twinSharedShare !== undefined ? (
            <>
              {card.twinLocality} {card.twinRank !== null && <>(<B>#{card.twinRank}</B> in {card.twinCity}) </>}and {card.homeLocality} share <B>{pct(card.twinSharedShare)}%</B> of the Qloo taste tags found in either
              {card.twinTagCounts && (
                <>
                  {" "}
                  ({card.twinTagCounts.shared} of {card.twinTagCounts.either})
                </>
              )}
              .
            </>
          ) : (
            <>
              Qloo ranks {card.twinLocality} {card.twinRank !== null && <B>#{card.twinRank} </B>}in {card.twinCity} for people with those tastes
              {card.twinSimilarity !== null && (
                <>
                  {" "}
                  (affinity <B>{card.twinSimilarity.toFixed(2)}</B>)
                </>
              )}
              .
            </>
          )}
        </Row>
        <Row n={3} refs={r.twinSupply} onChip={onChip}>
          Qloo lists <B>{count(card.twinCount, card.capped.twin)}</B> places tagged “{card.category.toLowerCase()}” in {card.twinLocality}.
        </Row>
        <Row n={4} refs={r.homeSupply} onChip={onChip}>
          <B>{count(card.homeCount, card.capped.home)}</B> in {card.homeLocality}.
        </Row>
        <li className="py-3 pl-9">
          <SupplyLedger card={card} />
        </li>
        <Row n={5} refs={r.citySupply} onChip={onChip}>
          {card.cityCount !== null ? (
            <>
              <B>{count(card.cityCount, card.capped.city)}</B> across all of {card.homeCity}.
            </>
          ) : (
            <span className="text-muted">Not checked: the agent did not look at the rest of {card.homeCity}.</span>
          )}
        </Row>
        {(card.google || card.googleSkipped) && (
          <li className="py-3 pl-9">
            <GoogleMapsCheck card={card} />
          </li>
        )}
        <Row n={6} refs={r.audience} onChip={onChip}>
          {audience?.value != null ? (
            <>
              Age profiles match <B>{pct(audience.value)}%</B>: the category’s fans{card.audienceProxy ? ` (${card.audienceProxy} fans standing in)` : ""} on Qloo vs {card.audienceBasis ?? `people in ${card.homeLocality}`}.
            </>
          ) : (
            <span className="text-muted">Audience overlap: not fetched.</span>
          )}
        </Row>
        <Row n={7} refs={r.trend} onChip={onChip}>
          {durability?.value != null ? <>Interest over the period: {durability.note}.</> : <span className="text-muted">Trend: {durability?.note ?? "not fetched"}.</span>}
        </Row>
        <Row n={8}>
          <LlmBadge />{" "}
          {fit?.value != null ? <>Product fit, Claude: “{fit.note}”</> : <span className="text-muted">Not judged: product fit needs Claude (LLM mode).</span>}
        </Row>
      </ol>
      <p className="mt-3 text-[12px] text-muted">
        Every number above comes from the Qloo response named on its right{card.google || card.audienceBasis ? ", except where another source is named" : ""}.{onChip ? " Click a Q-number to see the exact request in the agent log." : ""}
      </p>
    </section>
  );
}

const MAX_DOTS = 30;

function Dots({ filled, hollow }: { filled: number; hollow: number }) {
  const f = Math.min(filled, MAX_DOTS);
  const h = Math.min(hollow, MAX_DOTS - f);
  const rest = filled + hollow - f - h;
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-[3px]" aria-hidden="true">
      {Array.from({ length: f }, (_, i) => (
        <span key={`f${i}`} className="h-2 w-2 rounded-full bg-ink" />
      ))}
      {Array.from({ length: h }, (_, i) => (
        <span key={`h${i}`} className="h-2 w-2 rounded-full border-[1.5px] border-accent" />
      ))}
      {rest > 0 && <span className="num ml-1 text-[11px] text-muted">+{rest}</span>}
    </span>
  );
}

function SupplyLedger({ card }: { card: OpportunityCard }) {
  const missing = Math.max(0, card.twinCount - card.homeCount);
  const label = "w-full shrink-0 truncate text-[12px] md:w-[180px]";
  const row = "flex flex-wrap items-center gap-x-3 gap-y-1 md:flex-nowrap";
  return (
    <div className="space-y-1.5">
      <div className={row}>
        <span className={label}>
          {card.twinLocality}, {card.twinCity}
        </span>
        <Dots filled={card.twinCount} hollow={0} />
        <span className="num ml-auto text-[12px]">{count(card.twinCount, card.capped.twin)}</span>
      </div>
      <div className={row}>
        <span className={label}>
          {card.homeLocality}, {card.homeCity}
        </span>
        <Dots filled={card.homeCount} hollow={missing} />
        <span className="num ml-auto whitespace-nowrap text-[12px]">
          {count(card.homeCount, card.capped.home)} <span className="text-accent">({missing} missing)</span>
        </span>
      </div>
      {card.cityCount !== null && (
        <div className={`${row} text-[12px] text-muted`}>
          <span className={label}>All of {card.homeCity}</span>
          <span className="num">{count(card.cityCount, card.capped.city)} places</span>
        </div>
      )}
      <p className="pt-1 text-[12px] text-muted">
        Each dot is one place Qloo returned with this tag. Hollow dots are the empty storefronts: places {card.twinLocality} has that {card.homeLocality} doesn’t.
      </p>
    </div>
  );
}

const FIXED: Record<string, { sentence: string; refs: EvidenceRef[] }> = {
  proven: { sentence: "15 or more places = 100.", refs: ["twinSupply"] },
  bridge: {
    sentence: "Measured as taste affinity between the two neighbourhoods. Cross-interest bridges (like K-pop → malatang) are not measured yet.",
    refs: ["twin"],
  },
  audience: { sentence: "Age overlap only; gender is not used yet.", refs: ["audience"] },
  gap: { sentence: "Reduced when the whole city already has more than 20.", refs: ["homeSupply", "twinSupply", "citySupply"] },
  fit: { sentence: "Claude’s judgment: photogenic, customisable, health image, solo-friendly, cheap to open. Not Qloo data.", refs: [] },
  durability: { sentence: "Bubble tea in Japan is the warning case: a real gap that faded.", refs: ["trend"] },
};

function LlmBadge() {
  return <span className="rounded-full border border-llm/40 bg-llm/10 px-1.5 text-[11px] font-medium text-llm">LLM judgment</span>;
}

function SourceBadge({ s }: { s: ScoreItem }) {
  if (s.source === "LLM") return <LlmBadge />;
  if (s.source === "pending") return <span className="rounded-full border border-dashed border-pending px-1.5 text-[11px] font-medium text-muted">Pending</span>;
  return <span className="rounded-full border border-twin/40 px-1.5 text-[11px] font-medium text-twin">Qloo</span>;
}

function ScoreList({ card, onChip }: { card: OpportunityCard; onChip?: (n: number) => void }) {
  return (
    <section>
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Six scores</h3>
      <ol className="mt-2 space-y-4">
        {card.scores.map((s, i) => {
          const fixed = FIXED[s.key];
          const refs = [...new Set((fixed?.refs ?? []).flatMap((k) => card.refs[k]))].sort((a, b) => a - b);
          const pending = s.value === null;
          return (
            <li key={s.key}>
              <div className="flex items-center gap-2">
                <span className="num text-[12px] text-muted">{i + 1}</span>
                <span className="text-[14px] font-semibold">{s.label}</span>
                <SourceBadge s={s} />
                <span className="num ml-auto text-[14px] font-semibold">{pending ? "—" : Math.round(s.value! * 100)}</span>
              </div>
              <div className={`mt-1 h-1.5 overflow-hidden rounded-full ${pending ? "track-pending" : "bg-line"}`}>
                {!pending && <div className={`h-full rounded-full ${s.source === "LLM" ? "bar-llm" : "bg-twin"}`} style={{ width: `${Math.round(s.value! * 100)}%` }} />}
              </div>
              <div className="mt-1 flex items-start gap-2">
                <p className="flex-1 text-[12px] text-muted">
                  {s.note}
                  {s.note && !/[.!?]$/.test(s.note) ? "." : ""} {fixed?.sentence}
                  {s.source === "LLM" && " Not Qloo data. Included in confidence."}
                  {pending && " Not counted in confidence."}
                </p>
                {fixed && fixed.refs.length > 0 && <QChips calls={refs} onChip={onChip} />}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// Confidence after each check, in the order the checks ran.
function ScoreTrail({ card, onChip }: { card: OpportunityCard; onChip?: (n: number) => void }) {
  const trail = card.trail ?? [];
  // The final step only adds something when product fit or the agent's own doubts moved the score.
  const steps = trail.filter((t, i) => !(i > 0 && i === trail.length - 1 && t.label === "Final score" && pct(t.confidence) === pct(trail[i - 1].confidence)));
  if (steps.length < 2) return null;
  return (
    <div className="mt-3">
      <h4 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">How the score moved</h4>
      <ol className="mt-1 divide-y divide-line">
        {steps.map((t, i) => {
          const by = i ? pct(t.confidence) - pct(steps[i - 1].confidence) : 0;
          return (
            <li key={t.label} className="flex items-center gap-3 py-2 text-[13px]">
              <span className="min-w-0 flex-1">{t.label}</span>
              {t.calls.length > 0 && <QChips calls={t.calls} onChip={onChip} />}
              <span className={`num w-8 shrink-0 text-right text-[12px] font-semibold ${by < 0 ? "text-doubt" : "text-accent"}`}>
                {by === 0 ? "" : `${by > 0 ? "+" : "−"}${Math.abs(by)}`}
              </span>
              <span className="num w-10 shrink-0 text-right font-semibold">{pct(t.confidence)}%</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SelfCheck({ card, onChip }: { card: OpportunityCard; onChip?: (n: number) => void }) {
  const audience = score(card, "audience");
  const durability = score(card, "durability");
  const facts: [string, string][] = [
    [`Already common elsewhere in ${card.homeCity}?`, card.cityCount !== null ? `${count(card.cityCount, card.capped.city)} across ${card.homeCity}` : "Not checked"],
    ["Do the fans match the people here?", audience?.value != null ? `${pct(audience.value)}% age overlap` : "Not checked"],
    ["Is it fading?", durability?.value != null ? `${durability.note}${isFading(card) ? ": fading" : ""}` : "Not checked"],
    [
      "Enough evidence?",
      card.twinCount >= 8 ? `${card.twinCount} places in ${card.twinLocality}: enough` : `Only ${card.twinCount} places in ${card.twinLocality}: thin`,
    ],
  ];
  return (
    <section>
      <h3 className="font-serif text-[22px] leading-tight">The agent tried to prove itself wrong.</h3>
      <ScoreTrail card={card} onChip={onChip} />
      <dl className="mt-3 divide-y divide-line">
        {facts.map(([q, a]) => (
          <div key={q} className="flex justify-between gap-4 py-2 text-[13px]">
            <dt className="text-muted">{q}</dt>
            <dd className="text-right">{a}</dd>
          </div>
        ))}
      </dl>
      <h4 className="mt-5 text-[12px] font-semibold uppercase tracking-[0.06em] text-doubt">Doubts still standing ({card.doubts.length})</h4>
      {card.doubts.length ? (
        <ul className="mt-2 space-y-1.5">
          {card.doubts.map((d) => (
            <li key={d} className="flex items-start gap-2 text-[13px]">
              <span className="num mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-doubt text-[10px] text-doubt">?</span>
              <span className="flex-1">{d}</span>
              <span className="num shrink-0 text-[11px] text-doubt">−5%</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[13px] text-muted">No doubts left standing.</p>
      )}
    </section>
  );
}
