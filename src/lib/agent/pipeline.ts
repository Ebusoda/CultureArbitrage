import { isFatalQlooError } from "../qloo";
import { CITIES } from "../cities";
import { categoriesFor, categoryLabel } from "./categories";
import type { Evidence } from "./evidence";
import type { RunContext } from "./run";
import { buildCard, isGap, MIN_CONFIDENCE } from "./score";
import type { ExploreRequest, OpportunityCard } from "./types";

const HOODS_TO_PROFILE = 3;
const MAX_CARDS = 4;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

// Fixed-order exploration with no language model. Used when LLM_MODE=mock,
// and as the fallback when Claude is unavailable.
export async function runPipeline(req: ExploreRequest, ev: Evidence, ctx: RunContext): Promise<OpportunityCard[]> {
  const { step, onCard, deadline } = ctx;
  const categories = categoriesFor(req.focus);
  const otherCities = CITIES.filter((c) => c !== req.city);
  const outOfTime = () => Date.now() > deadline;

  step("profile", `Listing neighbourhoods in ${req.city}`);
  const hoods = await ev.listNeighbourhoods(req.city, HOODS_TO_PROFILE);
  if (!hoods.length) throw new Error(`Qloo returned no neighbourhoods for ${req.city}.`);

  const pairs: { hood: string; twin: string; twinCity: string; similarity: number }[] = [];
  for (const { name } of hoods) {
    if (outOfTime()) break;
    try {
      step("profile", `Reading the taste profile of ${name}`);
      const tastes = await ev.tasteProfile(name, req.city);
      if (!tastes.length) continue;
      step("twins", `Looking for taste twins of ${name}`, tastes.map((t) => t.name).join(" · "));
      let best: (typeof pairs)[number] | null = null;
      for (const other of otherCities) {
        const twin = (await ev.findTwins(name, req.city, other, 1))[0];
        if (twin && (!best || twin.similarity > best.similarity)) {
          best = { hood: name, twin: twin.name, twinCity: other, similarity: twin.similarity };
        }
      }
      if (best) pairs.push(best);
    } catch (e) {
      if (isFatalQlooError(e)) throw e;
      step("profile", `Skipped ${name}: Qloo lookup failed`, message(e));
    }
  }

  const gaps: { pair: (typeof pairs)[number]; cat: string; home: number; twin: number }[] = [];
  for (const pair of pairs) {
    if (outOfTime()) break;
    try {
      step("compare", `Comparing ${pair.hood} with ${pair.twin}, ${pair.twinCity}`);
      const home = await ev.supply(pair.hood, req.city);
      const twin = await ev.supply(pair.twin, pair.twinCity);
      for (const cat of categories) {
        const h = home.counts[cat] ?? 0;
        const t = twin.counts[cat] ?? 0;
        if (isGap(t, h)) gaps.push({ pair, cat, home: h, twin: t });
      }
    } catch (e) {
      if (isFatalQlooError(e)) throw e;
      step("compare", `Skipped ${pair.hood} vs ${pair.twin}: Qloo lookup failed`, message(e));
    }
  }
  gaps.sort((a, b) => b.pair.similarity * (b.twin - b.home) - a.pair.similarity * (a.twin - a.home));

  const cards: OpportunityCard[] = [];
  // Gaps its own checks rule out don't use up a slot: keep going until there are enough.
  for (const g of gaps) {
    if (cards.length >= MAX_CARDS) break;
    if (ev.qloo.remaining < 5 || outOfTime()) {
      step("score", "Stopping early to stay within the Qloo budget and time limit");
      break;
    }
    const label = categoryLabel(g.cat);
    // The doubt checks are optional: a failed lookup leaves that score pending.
    const failed: string[] = [];
    const optional = async <T,>(what: string, f: () => Promise<T>): Promise<T | null> => {
      try {
        return await f();
      } catch (e) {
        if (isFatalQlooError(e)) throw e;
        failed.push(what);
        step("doubt", `${what} lookup failed, left as pending`, message(e));
        return null;
      }
    };
    step("doubt", `Checking ${label.toLowerCase()} across ${req.city}, its audience and its trend`);
    await optional("City-wide supply", () => ev.citySupply(req.city, g.cat));
    await optional("Category audience", () => ev.categoryAudience(g.cat));
    await optional("Neighbourhood audience", () => ev.hoodAudience(g.pair.hood, req.city));
    await optional("Trend", () => ev.trend(g.cat, g.pair.twinCity));

    step("score", `Scoring ${label} in ${g.pair.hood}`);
    const tastes = ev.peek<{ name: string }[]>(`taste:${g.pair.hood}, ${req.city}`) ?? [];
    const why =
      `People in ${g.pair.hood} share their taste profile with ${g.pair.twin} (${tastes.map((t) => t.name).join(", ")}). ` +
      `That audience supports ${g.twin} ${label.toLowerCase()} places in ${g.pair.twin}, but ${g.pair.hood} has only ${g.home}.`;
    try {
      const card = buildCard(ev, { category: g.cat, hood: g.pair.hood, city: req.city, twin: g.pair.twin, twinCity: g.pair.twinCity, why, doubts: [], productFit: null });
      if (card.confidence < MIN_CONFIDENCE) {
        ctx.onRejected?.(card, `Below the ${Math.round(MIN_CONFIDENCE * 100)}% bar`);
        continue;
      }
      cards.push(card);
      onCard(card);
    } catch (e) {
      step("score", `Skipped ${label} in ${g.pair.hood}`, message(e));
    }
  }
  return cards;
}
