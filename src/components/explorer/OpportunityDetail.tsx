"use client";

import { useRef, useState } from "react";
import { CITY_CROWDED, cityMayBeLocal } from "@/lib/agent/rules";
import type { EvidenceRef, OpportunityCard, ScoreItem } from "@/lib/agent/types";
import { Arrow } from "./Arrow";
import { BAND_TEXT, Q_CHIP, Q_CHIP_HOVER, band, count, isFading, km, missingText, pct, plural, score } from "./format";
import { useOverflows } from "./hooks";

interface Props {
  card: OpportunityCard;
  // Why the agent ruled this idea out, when it did.
  ruledOut?: string;
  llmMode: string;
  rank?: number | null;
  // Without it, Q-numbers are plain text (the static example on the page).
  onChip?: (n: number) => void;
  // 3 when the detail sits inside another section with its own h2 (the example in How it works).
  headingLevel?: 2 | 3;
  // Closes this idea and goes back to the run's summary (a ruled-out idea in a run with no cards).
  onBack?: () => void;
}

export function OpportunityDetail({ card, ruledOut, llmMode, rank, onChip, headingLevel = 2, onBack }: Props) {
  const distance = km(card.twinCity, card.homeCity);
  const Title = headingLevel === 3 ? "h3" : "h2";
  // Who wrote the text: the card says when it can (Claude's ideas stay Claude's after a fallback).
  const byClaude = card.author ? card.author === "claude" : llmMode === "claude";
  return (
    <article className="fade-in">
      {ruledOut && (
        <p className="mb-6 max-w-[80ch] rounded-xl border border-dashed border-doubt/60 bg-page px-4 py-3 text-[14px]">
          <span className="font-semibold text-doubt">Ruled out by the agent’s own checks.</span> {ruledOut}, so it is not counted as an opportunity. It stays
          here so you can see why.
          {onBack && (
            <>
              {" "}
              <button type="button" onClick={onBack} className="text-[12px] text-muted underline underline-offset-2 hover:text-ink">
                Back to summary
              </button>
            </>
          )}
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:gap-10">
        <div>
          {rank === 1 && <p className="text-[13px] font-semibold text-accent">Strongest opportunity</p>}
          <Title className="mt-1 font-serif text-[28px] leading-[1.1] md:text-[32px]">
            {card.category}: {card.twinLocality} <Arrow /> {card.homeLocality}
          </Title>
          <p className="mt-1 text-[13px] text-muted">
            {card.twinCity} <Arrow /> {card.homeCity}
            {distance && `, about ${distance} km apart`}
          </p>
          <WhyText text={card.why} />
          <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
            {byClaude ? (
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
        {/* The answer to "can I trust this?" comes first; the score breakdown opens on request. */}
        <div className="space-y-8">
          <SelfCheck card={card} onChip={onChip} />
          <ScoreList card={card} onChip={onChip} />
        </div>
      </div>
    </article>
  );
}

// The agent's own explanation, two lines until opened.
function WhyText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLParagraphElement>(null);
  // The button shows when the two lines really cut the text off, whatever its length.
  const cut = useOverflows(box, text);
  return (
    <div className="mt-4 max-w-[68ch]">
      <p ref={box} className={`text-[15px] md:text-[16px] ${open ? "" : "line-clamp-2"}`}>
        {text}
      </p>
      {(open || cut) && (
        <button type="button" onClick={() => setOpen(!open)} className="text-[12px] text-muted underline underline-offset-2 hover:text-ink">
          {open ? "Less" : "Read more"}
        </button>
      )}
    </div>
  );
}

function ConfidenceBlock({ card, ruledOut }: { card: OpportunityCard; ruledOut: boolean }) {
  const p = pct(card.confidence);
  const b = band(card.confidence);
  const m = card.confidenceMath;
  const fitPending = score(card, "fit")?.value == null;
  // The unrounded average when the scores give it, so the formula below multiplies out.
  const values = card.scores.flatMap((s) => (s.value === null ? [] : [s.value]));
  const exactMean = m && values.length === m.measured ? (values.reduce((a, v) => a + v, 0) / Math.max(values.length, 1)) * 100 : m ? m.mean * 100 : p;
  const mean = Math.round(exactMean);
  return (
    <div className="md:w-[260px] md:text-right">
      <p className="font-serif text-[56px] font-extrabold leading-none tabular-nums">{p}%</p>
      <p className={`mt-1 text-[14px] font-semibold ${ruledOut ? "text-doubt" : BAND_TEXT[b]}`}>{ruledOut ? "Ruled out" : b}</p>
      {/* The bar: the average of the scores, with the part the doubts took off hatched. */}
      <div className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-line" title={`Average ${mean}, open doubts take it to ${p}`} aria-hidden="true">
        <div className="bar-doubt absolute inset-y-0 left-0" style={{ width: `${mean}%` }} />
        <div className={`absolute inset-y-0 left-0 rounded-full ${ruledOut ? "bg-doubt" : "bg-accent"}`} style={{ width: `${p}%` }} />
        <div className="absolute inset-y-0 w-px bg-ink/40" style={{ left: "55%" }} />
      </div>
      <details className="mt-2 text-[12px] text-muted">
        <summary className="cursor-pointer hover:text-ink">How {p}% is worked out</summary>
        {m && (
          <p className="num mt-1">
            Average of {m.measured} of 6 scores ({exactMean.toFixed(1)}) × doubt penalty {m.penalty.toFixed(2)} ({plural(m.doubts, "doubt")}) ≈ {p}%. The line
            marks 55%: below it an idea is ruled out.
          </p>
        )}
        {fitPending && <p className="mt-1">Product fit is pending and not counted.</p>}
      </details>
    </div>
  );
}

export function QChips({ calls, onChip }: { calls: number[]; onChip?: (n: number) => void }) {
  const [all, setAll] = useState(false);
  if (!calls.length) return <span className="text-[11px] text-muted">not fetched</span>;
  const shown = all ? calls : calls.slice(0, 3);
  const chip = `rounded-full px-1.5 text-[11px] font-semibold tabular-nums leading-[18px] ${Q_CHIP}`;
  // Buttons get an invisible 24px-tall hit area so they are easier to tap; the chip looks the same.
  const hit = "relative after:absolute after:inset-x-0 after:-inset-y-[3px] after:content-['']";
  return (
    <span className="inline-flex shrink-0 flex-wrap justify-end gap-1">
      {shown.map((n) =>
        onChip ? (
          <button key={n} type="button" onClick={() => onChip(n)} className={`${chip} ${hit} ${Q_CHIP_HOVER}`} aria-label={`Show Qloo call ${n} in the agent log`}>
            Q{n}
          </button>
        ) : (
          <span key={n} className={chip} title={`Call Q${n} of the recorded run`}>
            Q{n}
          </span>
        ),
      )}
      {!all && calls.length > 3 && (
        <button type="button" onClick={() => setAll(true)} className={`${chip} ${hit}`} aria-label={`Show ${calls.length - 3} more Qloo calls`}>
          +{calls.length - 3}
        </button>
      )}
    </span>
  );
}

// One piece of evidence: the figure first, a short line beside it, its sources on the right.
function Row({ big, children, refs, onChip, muted = false }: { big: React.ReactNode; children: React.ReactNode; refs?: number[]; onChip?: (n: number) => void; muted?: boolean }) {
  return (
    <li className="flex items-start gap-3 py-3">
      <span className={`w-[4.5rem] shrink-0 font-serif text-[24px] leading-none tabular-nums ${muted ? "text-muted" : ""}`}>{big}</span>
      <div className="min-w-0 flex-1 pt-0.5 text-[14px]">{children}</div>
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
        Cross-check against a second index. It changes no score or confidence. A gap it does not see (at least as many places around the home neighbourhood
        as around the twin) is ruled out; with fewer than 4 places on both sides, or past its 60-result limit, it is inconclusive and rules nothing out. Source:{" "}
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
  const live = card.twinSharedShare !== undefined;
  // "+42% over 12 points" -> "+42%" as the figure, the rest beside it. Anything else stays as text.
  const trend = durability?.value != null ? /^([+−-]?\d+(?:\.\d+)?%)\s+(.+)$/.exec(durability.note) : null;
  const notMeasurable = durability?.value == null && durability?.note.startsWith("Not measurable");
  const noFanData = audience?.value == null && !!audience?.note.startsWith("Qloo has no age data");
  const missing = Math.max(0, card.twinCount - card.homeCount);
  // A capped home count may be too low (so fewer are missing); a capped twin count, too low (so more are).
  const missingBig = `−${missing}${card.capped.twin && !card.capped.home ? "+" : ""}`;
  const residents = !!card.audienceBasis?.startsWith("residents");
  return (
    <section>
      <h3 className="text-[13px] font-semibold text-muted">Evidence chain</h3>
      <ol className="mt-1 divide-y divide-line">
        <Row
          big={
            <svg viewBox="0 0 20 20" className="h-7 w-7 fill-none stroke-twin" strokeWidth={1.6} aria-hidden="true">
              <circle cx="7" cy="10" r="5" />
              <circle cx="13" cy="10" r="5" />
            </svg>
          }
          refs={live ? r.twin : r.taste}
          onChip={onChip}
        >
          <p className="sr-only">{live ? `${card.homeLocality} and ${card.twinLocality} share these Qloo tastes:` : `People in ${card.homeLocality} are into:`}</p>
          <div className="flex flex-wrap gap-1.5">
            {t.length ? (
              t.map((x) => (
                <span key={x.name} className="rounded-full bg-twin/10 px-2.5 py-0.5 text-[13px] font-medium text-twin">
                  {x.name}
                  {x.affinity !== null && <span className="ml-1 text-[11px] tabular-nums opacity-80">{x.affinity.toFixed(2)}</span>}
                </span>
              ))
            ) : (
              <span className="text-muted">No taste tags returned</span>
            )}
          </div>
        </Row>
        <Row big={live ? `${pct(card.twinSharedShare!)}%` : card.twinRank !== null ? `#${card.twinRank}` : "—"} refs={r.twin} onChip={onChip}>
          {live ? (
            <>
              of taste tags shared{card.twinTagCounts && ` (${card.twinTagCounts.shared} of ${card.twinTagCounts.either})`}
              {card.twinRank !== null && `, #${card.twinRank} in ${card.twinCity}`}
            </>
          ) : (
            <>
              {card.twinLocality} in {card.twinCity} for these tastes
              {card.twinSimilarity !== null && <span className="text-muted"> (affinity {card.twinSimilarity.toFixed(2)})</span>}
            </>
          )}
        </Row>
        <Row big={<span className="text-accent">{missingBig}</span>} refs={[...new Set([...r.twinSupply, ...r.homeSupply])].sort((a, b) => a - b)} onChip={onChip}>
          <p className="mb-2">
            {card.capped.home && "up to "}
            {card.category.toLowerCase()} places missing in {card.homeLocality}
          </p>
          <SupplyLedger card={card} />
        </Row>
        <Row big={card.cityCount !== null ? count(card.cityCount, card.capped.city) : "—"} muted={card.cityCount === null} refs={r.citySupply} onChip={onChip}>
          {card.cityCount !== null ? `across all of ${card.homeCity}` : `rest of ${card.homeCity} not checked`}
        </Row>
        {(card.google || card.googleSkipped) && (
          <li className="py-3 pl-[5.25rem]">
            <GoogleMapsCheck card={card} />
          </li>
        )}
        <Row big={audience?.value != null ? `${pct(audience.value)}%` : "—"} muted={audience?.value == null} refs={r.audience} onChip={onChip}>
          {audience?.value != null ? (
            <div title={`The category’s fans${card.audienceProxy ? ` (${card.audienceProxy} fans standing in)` : ""} on Qloo vs ${card.audienceBasis ?? `people in ${card.homeLocality}`}`}>
              {residents ? "age match, fans vs residents" : "age match, category fans vs fans of local tastes"}
              <div className="mt-1.5 h-1.5 w-full max-w-[200px] overflow-hidden rounded-full bg-line" aria-hidden="true">
                <div className="h-full rounded-full bg-twin" style={{ width: `${pct(audience.value)}%` }} />
              </div>
              <p className="mt-1 text-[12px] text-muted">
                {card.audienceProxy ? `${card.audienceProxy} fans standing in; ` : ""}
                {card.audienceBasis ?? `people in ${card.homeLocality}`}
              </p>
            </div>
          ) : noFanData ? (
            "no Qloo fan data for this category"
          ) : (
            "audience overlap not fetched"
          )}
        </Row>
        <Row big={trend ? trend[1] : "—"} muted={!trend} refs={notMeasurable ? undefined : r.trend} onChip={onChip}>
          {trend ? (
            `interest, ${trend[2]}`
          ) : notMeasurable ? (
            <>
              trend not measurable for places
              <span className="mt-0.5 block text-[12px] text-muted">{durability!.note.replace(/^Not measurable:\s*/, "")}</span>
            </>
          ) : durability?.value != null ? (
            `interest: ${durability.note}`
          ) : (
            (durability?.note ?? "trend not fetched")
          )}
        </Row>
        <Row big={fit?.value != null ? pct(fit.value) : "—"} muted={fit?.value == null}>
          <LlmBadge /> {fit?.value != null ? <>product fit: “{fit.note}”</> : <span className="text-muted">not judged without Claude</span>}
        </Row>
      </ol>
      <p className="mt-2 text-[12px] text-muted">
        Numbers link to their source on the right{card.google || card.audienceBasis ? "; other sources are named" : ""}.
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
          {count(card.homeCount, card.capped.home)} <span className="text-accent">({missingText(card)} missing)</span>
        </span>
      </div>
      {card.cityCount !== null && (
        <div className={`${row} text-[12px] text-muted`}>
          <span className={label}>All of {card.homeCity}</span>
          <span className="num">
            {count(card.cityCount, card.capped.city)} {card.cityCount === 1 && !card.capped.city ? "place" : "places"}
          </span>
        </div>
      )}
      <details className="pt-1 text-[12px] text-muted">
        <summary className="cursor-pointer hover:text-ink">What the dots mean</summary>
        <p className="mt-1">
          Each dot is one place Qloo returned with this tag. Hollow dots are the empty storefronts: places {card.twinLocality} has that {card.homeLocality} doesn’t.
        </p>
      </details>
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
  gap: { sentence: `Reduced when the whole city already has more than ${CITY_CROWDED}.`, refs: ["homeSupply", "twinSupply", "citySupply"] },
  fit: { sentence: "Claude’s judgment: photogenic, customisable, health image, solo-friendly, cheap to open. Not Qloo data.", refs: [] },
  durability: { sentence: "Bubble tea in Japan is the warning case: a real gap that faded.", refs: ["trend"] },
};

const LIVE_BRIDGE = {
  sentence: "Measured as the shared-taste score: the share of Qloo taste tags both neighbourhoods have, ÷ 0.5, max 1. Cross-interest bridges (like K-pop → malatang) are not measured yet.",
  refs: ["twin"] as EvidenceRef[],
};

function LlmBadge() {
  return <span className="rounded-full border border-llm/40 bg-llm/10 px-1.5 text-[11px] font-medium text-llm">LLM judgment</span>;
}

function SourceBadge({ s }: { s: ScoreItem }) {
  if (s.source === "LLM") return <LlmBadge />;
  if (s.source === "pending") return <span className="rounded-full border border-dashed border-pending px-1.5 text-[11px] font-medium text-muted">Pending</span>;
  return <span className="rounded-full border border-twin/40 px-1.5 text-[11px] font-medium text-twin">Qloo</span>;
}

// The six scores as short bars; what each one means opens on request.
function ScoreList({ card, onChip }: { card: OpportunityCard; onChip?: (n: number) => void }) {
  return (
    <section className="border-t border-line pt-4">
      <h3 className="text-[13px] font-semibold text-muted">Six scores</h3>
      <ul className="mt-2 space-y-2">
        {card.scores.map((s) => {
          const pending = s.value === null;
          return (
            <li key={s.key} className="grid grid-cols-[9.5rem_minmax(0,1fr)_2rem] items-center gap-3 text-[13px]">
              <span className="truncate font-medium">{s.label}</span>
              <span className={`h-1.5 overflow-hidden rounded-full ${pending ? "track-pending" : "bg-line"}`}>
                {!pending && <span className={`block h-full rounded-full ${s.source === "LLM" ? "bar-llm" : "bg-twin"}`} style={{ width: `${Math.round(s.value! * 100)}%` }} />}
              </span>
              <span className="num text-right font-semibold">{pending ? "—" : Math.round(s.value! * 100)}</span>
            </li>
          );
        })}
      </ul>
      <details className="mt-3">
        <summary className="cursor-pointer text-[12px] text-muted hover:text-ink">What each score means</summary>
        <ol className="mt-2 space-y-3">
          {card.scores.map((s) => {
            // Live, the bridge is the shared-taste score (share of tags in common), not a Qloo affinity.
            const fixed = s.key === "bridge" && card.twinSharedShare !== undefined ? LIVE_BRIDGE : FIXED[s.key];
            const refs = [...new Set((fixed?.refs ?? []).flatMap((k) => card.refs[k]))].sort((a, b) => a - b);
            const pending = s.value === null;
            return (
              <li key={s.key} className="flex items-start gap-2 text-[12px]">
                <div className="flex-1">
                  <p className="flex items-center gap-1.5 font-semibold">
                    {s.label} <SourceBadge s={s} />
                  </p>
                  <p className="text-muted">
                    {s.note}
                    {s.note && !/[.!?]$/.test(s.note) ? "." : ""} {fixed?.sentence}
                    {s.source === "LLM" && " Included in confidence."}
                    {pending && " Not counted in confidence."}
                  </p>
                </div>
                {fixed && fixed.refs.length > 0 && <QChips calls={refs} onChip={onChip} />}
              </li>
            );
          })}
        </ol>
      </details>
    </section>
  );
}

// Confidence as each check's evidence came in: "Gap found" first, then the other checks by
// their last Qloo call. A check answered from evidence fetched earlier cites that older call,
// so the Q numbers need not rise from row to row.
function ScoreTrail({ card, onChip }: { card: OpportunityCard; onChip?: (n: number) => void }) {
  const trail = card.trail ?? [];
  // The final step only adds something when product fit or the agent's own doubts moved the score.
  const steps = trail.filter((t, i) => !(i > 0 && i === trail.length - 1 && t.label === "Final score" && pct(t.confidence) === pct(trail[i - 1].confidence)));
  if (steps.length < 2) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[13px] font-semibold text-muted hover:text-ink">How the score moved, check by check</summary>
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
    </details>
  );
}

type Mark = "ok" | "warn" | "info" | "unknown";
type Check = { q: string; label: string; answer: string; mark: Mark };

const MARK: Record<Mark, { sign: string; cls: string; word: string }> = {
  ok: { sign: "✓", cls: "bg-accent/15 text-accent", word: "passes" },
  warn: { sign: "!", cls: "bg-doubt/15 text-doubt", word: "warning" },
  info: { sign: "i", cls: "bg-line text-ink", word: "for information" },
  unknown: { sign: "?", cls: "border border-dashed border-pending text-muted", word: "not checked" },
};

// A box that shows the question it answers when tapped or clicked, so it is not hover-only.
function CheckBox({ check: c }: { check: Check }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={c.q}
        className="flex h-full w-full items-start gap-2 rounded-xl bg-surface p-2.5 text-left ring-1 ring-line hover:ring-accent/50"
      >
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${MARK[c.mark].cls}`} aria-hidden="true">
          {MARK[c.mark].sign}
        </span>
        <span className="min-w-0 text-[13px]">
          <span className="sr-only">({MARK[c.mark].word}) </span>
          <span className="block text-muted">{c.label}</span>
          <span className="block font-semibold">{c.answer}</span>
          {open && <span className="mt-1 block text-[12px] text-muted">{c.q}</span>}
        </span>
      </button>
    </li>
  );
}

// Each check as a mark and a short answer. Marks only use rules the agent already applies
// (src/lib/agent/rules.ts: "may be local only", more than 20 city-wide, fading; fewer than 8 places).
function SelfCheck({ card, onChip }: { card: OpportunityCard; onChip?: (n: number) => void }) {
  const audience = score(card, "audience");
  const durability = score(card, "durability");
  const notMeasurable = durability?.value == null && durability?.note.startsWith("Not measurable");
  const checks: Check[] = [
    {
      q: `Already common elsewhere in ${card.homeCity}?`,
      label: `Rest of ${card.homeCity}`,
      answer: card.cityCount !== null ? `${count(card.cityCount, card.capped.city)} ${card.cityCount === 1 && !card.capped.city ? "place" : "places"}` : "Not checked",
      // Same rule as the "may be local only" doubt; a crowded city short of that only lowers the gap score.
      mark: card.cityCount === null ? "unknown" : cityMayBeLocal(card.cityCount, card.homeCount) ? "warn" : card.cityCount > CITY_CROWDED ? "info" : "ok",
    },
    {
      q: "Do the fans match the people here?",
      label: "Age match",
      answer:
        audience?.value != null
          ? `${pct(audience.value)}%`
          : audience?.note.startsWith("Qloo has no age data")
            ? "No fan data"
            : audience?.note.startsWith("No age data for people")
              ? "No local age data"
              : "Not checked",
      mark: audience?.value != null ? "info" : "unknown",
    },
    {
      q: "Is it fading?",
      label: "Trend",
      answer: durability?.value != null ? `${durability.note}${isFading(card) ? ", fading" : ""}` : notMeasurable ? "Not measurable on Qloo" : "Not checked",
      mark: durability?.value == null ? "unknown" : isFading(card) ? "warn" : "ok",
    },
    { q: "Enough evidence?", label: "Evidence", answer: `${count(card.twinCount, card.capped.twin)} ${card.twinCount === 1 && !card.capped.twin ? "place" : "places"} in ${card.twinLocality}`, mark: card.twinCount >= 8 ? "ok" : "warn" },
  ];
  return (
    <section>
      <h3 className="font-serif text-[22px] leading-tight">The agent tried to prove itself wrong.</h3>
      <ul className="mt-3 grid grid-cols-2 gap-2">
        {checks.map((c) => (
          <CheckBox key={c.label} check={c} />
        ))}
      </ul>
      <ScoreTrail card={card} onChip={onChip} />
      <h4 className="mt-5 text-[13px] font-semibold text-doubt">Doubts still standing ({card.doubts.length})</h4>
      {card.doubts.length ? (
        <>
          <ul className="mt-2 space-y-1.5">
            {card.doubts.map((d, i) => (
              <li key={`${i}:${d}`} className="flex items-start gap-2 text-[13px]">
                <span className="num mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-doubt text-[10px] text-doubt">?</span>
                <span className="flex-1">{d}</span>
              </li>
            ))}
          </ul>
          {/* Same rule as the confidence maths: × (1 − 0.05 × doubts), at most 0.4 off. */}
          <p className="mt-2 text-[12px] text-doubt">
            Together they multiply the average score by <span className="num">{(card.confidenceMath?.penalty ?? 1 - Math.min(0.4, 0.05 * card.doubts.length)).toFixed(2)}</span>.
          </p>
        </>
      ) : (
        <p className="mt-2 text-[13px] text-muted">No doubts left standing.</p>
      )}
    </section>
  );
}
