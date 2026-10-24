import { categoryLabel } from "./categories";
import type { CitySupply, Demographics, Evidence, GoogleGap, Supply, Trend } from "./evidence";
import type { OpportunityCard, ScoreItem, TrailStep } from "./types";

export interface CardInput {
  category: string;
  hood: string;
  city: string;
  twin: string;
  twinCity: string;
  why: string;
  doubts: string[];
  // LLM judgment, 0..1, always labelled as such. Null without an LLM.
  productFit: { score: number; reason: string } | null;
}

// Cards below this confidence are not shown: Claude gets them back with the reasons,
// and the fixed pipeline skips them. Matches where the UI's "Promising" band starts.
export const MIN_CONFIDENCE = 0.55;

// Each open doubt costs this much confidence, down to at most MAX_DOUBT_PENALTY off.
const DOUBT_COST = 0.05;
const MAX_DOUBT_PENALTY = 0.4;

export function cardId(hood: string, twin: string, twinCity: string, category: string) {
  return `${hood}|${twin}|${twinCity}|${category}`;
}

// Same bar the fixed pipeline uses to call something a gap.
export function isGap(twinCount: number, homeCount: number) {
  return twinCount >= 4 && twinCount >= 3 * Math.max(homeCount, 1);
}

// Builds a card from cached Qloo evidence only. Throws if the supply
// comparison this card rests on was never fetched.
export function buildCard(ev: Evidence, input: CardInput): OpportunityCard {
  const { category } = input;
  const city = ev.city(input.city);
  const twinCity = ev.city(input.twinCity);
  const hood = ev.hood(input.hood, city);
  const twin = ev.hood(input.twin, twinCity);

  const k = {
    taste: `taste:${hood}, ${city}`,
    twin: `twins:${hood}, ${city}->${twinCity}`,
    homeSupply: `supply:${hood}, ${city}`,
    twinSupply: `supply:${twin}, ${twinCity}`,
    citySupply: `citysupply:${city}:${category}`,
    catAudience: `audience:${category}`,
    hoodAudience: `hoodaudience:${hood}, ${city}`,
    trend: `trend:${category}:${twinCity}`,
    google: `google:${category}:${hood}, ${city}->${twin}, ${twinCity}`,
  };
  const homeSupply = ev.peek<Supply>(k.homeSupply);
  const twinSupply = ev.peek<Supply>(k.twinSupply);
  if (!homeSupply || !twinSupply) {
    throw new Error(`No supply comparison for ${hood} (${city}) vs ${twin} (${twinCity}). Call compare_supply with those exact names first.`);
  }
  // A capped shared page undercounts; a single-category count, when fetched, is exact.
  const exactHome = ev.peek<{ count: number; capped: boolean }>(`supply1:${category}:${hood}, ${city}`);
  const homeCount = exactHome?.count ?? homeSupply.counts[category] ?? 0;
  const homeCapped = exactHome ? exactHome.capped : homeSupply.capped;
  const twinCount = twinSupply.counts[category] ?? 0;
  const twinInfo = ev.twins.get(`${hood}|${twin}|${twinCity}`) ?? null;
  const similarity = twinInfo?.similarity ?? null;
  const city_ = ev.peek<CitySupply>(k.citySupply) ?? null;
  const catAudience = ev.peek<Demographics | null>(k.catAudience) ?? null;
  const hoodAudience = ev.peek<Demographics | null>(k.hoodAudience) ?? null;
  // Trend is checked where the category already exists: the twin's city first.
  const trendKey = ev.peek<Trend | null>(k.trend) !== undefined ? k.trend : `trend:${category}:${city}`;
  const trend = ev.peek<Trend | null>(trendKey) ?? null;
  const tastes = twinInfo?.shared ?? ev.peek<{ name: string; affinity: number | null }[]>(k.taste) ?? [];
  // Google Maps is a second index used only to rule a gap out (the caller does that when it
  // contradicts the gap). It changes no score and no confidence, and its numbers stay in their
  // own labelled box on the card, apart from the Qloo evidence, as Google's terms require.
  const google = ev.peek<GoogleGap>(k.google) ?? null;
  // Live /v2/trending rejects places, so no run can measure a place category's trend.
  const trendUnmeasurable = ev.qloo.mode === "live" && trend === null;
  const googleSkipped = ev.googleEnabled && !google ? ev.failureOf(k.google) ?? "the agent did not run it" : null;

  // Doubts raised in code, tagged with the check that raised them (for the score trail).
  const auto: { at: Check; text: string }[] = [];
  if (trend && trend.change < -0.2) auto.push({ at: "trend", text: `Interest is falling (${pct(trend.change)} over the period): a real gap may still fade, like tapioca.` });
  if (twinCount < 8) auto.push({ at: "compare", text: `Thin evidence: only ${twinCount} places in ${twin}.` });
  if (twinSupply.capped || homeCapped) auto.push({ at: "compare", text: "Place counts come from a capped sample of Qloo results, not a full census." });
  if (ev.qloo.mode === "mock") auto.push({ at: "compare", text: "Built on sample data, not real Qloo results." });
  if (city_ && city_.count > 3 * Math.max(homeCount, 1) + 5) {
    auto.push({ at: "city", text: `${city_.count}${city_.capped ? "+" : ""} exist elsewhere in ${city}, so the gap may be local only.` });
  }
  const doubts = [...input.doubts, ...auto.map((d) => d.text)];

  const overlap = catAudience && hoodAudience ? ageOverlap(catAudience, hoodAudience) : null;
  const gapHere = clamp((twinCount - homeCount) / Math.max(twinCount, 1));
  const gap = gapHere * (city_ && city_.count > 20 ? 0.6 : 1);
  const cityNote = city_ ? `, ${city_.count}${city_.capped ? "+" : ""} across ${city}` : "";
  const scores: ScoreItem[] = [
    { key: "proven", label: "Proven elsewhere", value: clamp(twinCount / 15), source: "Qloo", note: `${twinCount} places in ${twin}` },
    similarity === null
      ? pending("bridge", "Bridge audience", "Twin search not run for this pair")
      : { key: "bridge", label: "Bridge audience", value: clamp(similarity), source: "Qloo", note: twinInfo?.sharedShare !== undefined ? `${share(twinInfo.sharedShare)} of Qloo taste tags shared by ${hood} and ${twin} (half shared counts as a full match)` : `Taste similarity of ${hood} and ${twin}` },
    overlap === null
      ? pending("audience", "Core audience fit", "Demographics not fetched")
      : { key: "audience", label: "Core audience fit", value: overlap, source: "Qloo", note: `Age profile of the category's fans${catAudience?.proxy ? ` (${catAudience.proxy} fans standing in)` : ""} vs ${hoodAudience?.basis ?? `people in ${hood}`}` },
    {
      key: "gap",
      label: "Local undersupply",
      value: gap,
      source: "Qloo",
      note: `${homeCount} in ${hood} vs ${twinCount} in ${twin}${cityNote}`,
    },
    input.productFit
      ? { key: "fit", label: "Product fit", value: clamp(input.productFit.score), source: "LLM", note: input.productFit.reason }
      : pending("fit", "Product fit", "LLM judgment, needs Claude"),
    trend === null
      ? pending("durability", "Durability", trendUnmeasurable ? "Not measurable: Qloo's trend data covers artists, brands, films and TV, not places" : "Trend not fetched")
      : { key: "durability", label: "Durability", value: clamp(0.5 + trend.change), source: "Qloo", note: `${pct(trend.change)} over ${trend.points} points` },
  ];

  // Skipping a Qloo check must not raise confidence: each unchecked one counts as an open doubt.
  // A check no agent could run (durability on live data) is shown as not measurable instead.
  let skipped = 0;
  for (const s of scores) {
    if (s.value === null && s.key !== "fit" && !(s.key === "durability" && trendUnmeasurable)) {
      doubts.push(`Not checked: ${s.label.toLowerCase()}.`);
      skipped++;
    }
  }

  const measured = scores.filter((s) => s.value !== null);
  const mean = average(measured.map((s) => s.value ?? 0));
  const penalty = doubtPenalty(doubts.length);
  const confidence = mean * penalty;

  // How confidence moved as each check came in, in the order the checks completed.
  // Every step uses only the evidence up to that check, so the last one is the card itself.
  const value = (key: string) => scores.find((s) => s.key === key)?.value ?? null;
  const checks: { at: Check; label: string; key: string; v: number | null; calls: number[] }[] = [
    { at: "city", key: "gap", v: city_ ? gap : null, calls: ev.calls(k.citySupply), label: `Checked the rest of ${city}: ${city_ ? `${count(city_.count, city_.capped)} ${city_.count === 1 && !city_.capped ? "place" : "places"}` : ""}` },
    { at: "audience", key: "audience", v: overlap, calls: ev.calls(k.catAudience, k.hoodAudience), label: `Checked who it is for: ${overlap === null ? "" : share(overlap)} age match` },
    { at: "trend", key: "durability", v: value("durability"), calls: ev.calls(trendKey), label: `Checked the trend: ${trend ? pct(trend.change) : ""} over the year` },
  ];
  const sofar: Record<string, number> = { proven: clamp(twinCount / 15), gap: gapHere };
  if (similarity !== null) sofar.bridge = clamp(similarity);
  let open = auto.filter((d) => d.at === "compare").length;
  const trail: TrailStep[] = [
    {
      label: `Gap found: ${twinCount} in ${twin}, ${homeCount} in ${hood}`,
      confidence: round2(average(Object.values(sofar)) * doubtPenalty(open)),
      calls: ev.calls(k.homeSupply, k.twinSupply),
    },
  ];
  // A check is complete at its last Qloo call (the audience check needs two lookups).
  const done = (calls: number[]) => (calls.length ? Math.max(...calls) : Infinity);
  for (const c of checks.filter((c) => c.v !== null).sort((a, b) => done(a.calls) - done(b.calls))) {
    sofar[c.key] = c.v!;
    open += auto.filter((d) => d.at === c.at).length;
    trail.push({ label: c.label, confidence: round2(average(Object.values(sofar)) * doubtPenalty(open)), calls: c.calls });
  }
  const extras = [
    input.productFit && `product fit ${share(clamp(input.productFit.score))}`,
    input.doubts.length && `${input.doubts.length} ${input.doubts.length === 1 ? "doubt" : "doubts"} of its own`,
    skipped && `${skipped} ${skipped === 1 ? "check" : "checks"} skipped`,
  ].filter(Boolean);
  trail.push({ label: extras.length ? `Final score, with ${extras.join(", ")}` : "Final score", confidence: round2(confidence), calls: [] });

  return {
    id: cardId(hood, twin, twinCity, category),
    category: categoryLabel(category),
    categoryId: category,
    homeLocality: hood,
    homeCity: city,
    twinLocality: twin,
    twinCity,
    twinSimilarity: similarity,
    twinRank: twinInfo?.rank ?? null,
    sharedTastes: tastes.map(({ name, affinity }) => ({ name, affinity })),
    homeCount,
    twinCount,
    cityCount: city_?.count ?? null,
    capped: { home: homeCapped, twin: twinSupply.capped, city: city_?.capped ?? false },
    why: input.why,
    scores,
    confidence: round2(confidence),
    confidenceMath: { mean: round2(mean), measured: measured.length, doubts: doubts.length, penalty: round2(penalty) },
    doubts,
    trail,
    ...(google ? { google: { home: google.home.count, twin: google.twin.count, homeSaturated: google.home.saturated, twinSaturated: google.twin.saturated, halfKm: google.halfKm, verdict: google.verdict } } : {}),
    ...(googleSkipped ? { googleSkipped } : {}),
    ...(twinInfo?.sharedCount !== undefined && twinInfo.unionCount !== undefined ? { twinTagCounts: { shared: twinInfo.sharedCount, either: twinInfo.unionCount } } : {}),
    ...(twinInfo?.sharedShare !== undefined ? { twinSharedShare: twinInfo.sharedShare } : {}),
    ...(hoodAudience?.basis ? { audienceBasis: hoodAudience.basis } : {}),
    ...(catAudience?.proxy ? { audienceProxy: catAudience.proxy } : {}),
    refs: {
      taste: ev.calls(k.taste),
      twin: ev.calls(k.twin),
      homeSupply: ev.calls(k.homeSupply),
      twinSupply: ev.calls(k.twinSupply),
      citySupply: ev.calls(k.citySupply),
      audience: ev.calls(k.catAudience, k.hoodAudience),
      trend: ev.calls(trendKey),
    },
  };
}

// The score trail for a gap the agent has found but not submitted yet: what the
// evidence gathered so far says, before product fit and its own doubts.
export function provisional(ev: Evidence, gap: Omit<CardInput, "why" | "doubts" | "productFit">): TrailStep | null {
  try {
    return buildCard(ev, { ...gap, why: "", doubts: [], productFit: null }).trail?.at(-2) ?? null;
  } catch {
    return null;
  }
}

type Check = "compare" | "city" | "audience" | "trend";

function average(values: number[]) {
  return values.reduce((a, v) => a + v, 0) / Math.max(values.length, 1);
}
function doubtPenalty(doubts: number) {
  return 1 - Math.min(MAX_DOUBT_PENALTY, DOUBT_COST * doubts);
}
function count(n: number, capped: boolean) {
  return capped ? `${n}+` : String(n);
}
function pending(key: string, label: string, note: string): ScoreItem {
  return { key, label, value: null, source: "pending", note };
}
function clamp(n: number) {
  return Math.min(1, Math.max(0, n));
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function pct(n: number) {
  return `${n >= 0 ? "+" : ""}${Math.round(n * 100)}%`;
}
function share(n: number) {
  return `${Math.round(n * 100)}%`;
}
const FULL_LEAN = 0.1;

// 1 = identical age profiles, 0 = no overlap.
export function ageOverlap(a: Demographics, b: Demographics) {
  const keys = [...new Set([...Object.keys(a.age), ...Object.keys(b.age)])];
  // Live profiles give each age band a lean from -1 to 1, not a share, and the two sides come
  // from different sources (Qloo fans vs ward residents) whose leans differ in scale. So compare
  // their shape: do the same age bands lean the same way? Correlation -1..1 mapped to 0..1.
  // A side that barely leans (a ward close to the 23-ward average) has a shape that is mostly
  // noise, so the correlation is weighted by how strongly the flatter side leans: a lean of 0.1
  // or more in some band counts in full, a flat profile lands at 0.5 (neither match nor mismatch).
  if ([...Object.values(a.age), ...Object.values(b.age)].some((n) => n < 0)) {
    const r = correlation(keys.map((k) => a.age[k] ?? 0), keys.map((k) => b.age[k] ?? 0));
    const amp = (d: Demographics) => Math.max(0, ...Object.values(d.age).map(Math.abs));
    const weight = Math.min(1, Math.min(amp(a), amp(b)) / FULL_LEAN);
    return r === null ? 0.5 : clamp(0.5 + (r * weight) / 2);
  }
  let shared = 0;
  for (const k of keys) shared += Math.min(a.age[k] ?? 0, b.age[k] ?? 0);
  return clamp(shared);
}

// Pearson correlation; null when either side is flat.
function correlation(x: number[], y: number[]): number | null {
  const mx = average(x);
  const my = average(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
