import { isFatalQlooError } from "../qloo";
import { CITIES } from "../cities";
import { categoriesForRequest, categoryLabel } from "./categories";
import type { Evidence } from "./evidence";
import type { RunContext } from "./run";
import { twinCities } from "./target";
import { buildCard, cardId, isGap, MIN_CONFIDENCE } from "./score";
import type { ExploreRequest, OpportunityCard } from "./types";

const HOODS_TO_PROFILE = 3;
// Checking one business type costs less per comparison (one category), so it looks at one more.
const HOODS_FOR_TARGET = 4;
// Claude lists this many; a fallback run reuses that list instead of asking Qloo again.
const CLAUDE_HOODS = 5;
const MAX_CARDS = 4;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

// Fixed-order exploration with no language model. Used when LLM_MODE=mock,
// and as the fallback when Claude is unavailable.
export async function runPipeline(req: ExploreRequest, ev: Evidence, ctx: RunContext): Promise<OpportunityCard[]> {
  const { step, onCard, deadline } = ctx;
  const categories = categoriesForRequest(req);
  // Checking one business type: only cities that list enough of it to have a twin with a gap.
  const otherCities = req.target ? twinCities(req) : CITIES.filter((c) => c !== req.city);
  const outOfTime = () => Date.now() > deadline;
  // Ids already shown or ruled out in this run (by Claude, before a fallback): not looked at again.
  const skip = (id: string) => ctx.skip?.(id) ?? false;
  if (outOfTime()) {
    step("think", "Out of time, stopping with what was found");
    return [];
  }

  step("profile", `Listing neighbourhoods in ${req.city}`);
  const listed = ev.peek<{ name: string }[]>(`hoods:${ev.city(req.city)}:${CLAUDE_HOODS}`);
  const profile = req.target ? HOODS_FOR_TARGET : HOODS_TO_PROFILE;
  const hoods = listed ? listed.slice(0, profile) : await ev.listNeighbourhoods(req.city, profile);
  if (!hoods.length) throw new Error(`Qloo returned no neighbourhoods for ${req.city}.`);

  // The run said it stopped early, or a loop below was cut short by the time limit (then the
  // run must say so too, not look like "nothing found").
  let stopReported = false;
  let cutShort = false;
  const stopped = (s: { reason: "budget" | "time"; unscored: number }) => {
    stopReported = true;
    ctx.onStopped?.(s);
  };
  const pairs: { hood: string; twin: string; twinCity: string; similarity: number }[] = [];
  for (const { name } of hoods) {
    if (outOfTime()) {
      cutShort = true;
      break;
    }
    try {
      step("profile", `Reading the taste profile of ${name}`);
      const tastes = await ev.tasteProfile(name, req.city);
      if (!tastes.length) continue;
      step("twins", `Looking for taste twins of ${name}`, tastes.map((t) => t.name).join(" · "));
      let best: (typeof pairs)[number] | null = null;
      // Each city on its own: a failed lookup in one keeps the twin found in the other.
      for (const other of otherCities) {
        try {
          const twin = (await ev.findTwins(name, req.city, other, 1))[0];
          if (twin && (!best || twin.similarity > best.similarity)) {
            best = { hood: name, twin: twin.name, twinCity: other, similarity: twin.similarity };
          }
        } catch (e) {
          if (isFatalQlooError(e)) throw e;
          step("twins", `Skipped twins of ${name} in ${other}: Qloo lookup failed`, message(e));
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
    if (outOfTime()) {
      cutShort = true;
      break;
    }
    try {
      step("compare", `Comparing ${pair.hood} with ${pair.twin}, ${pair.twinCity}`);
      const home = await ev.supply(pair.hood, req.city);
      const twin = await ev.supply(pair.twin, pair.twinCity);
      ctx.onCompare?.(true);
      for (const cat of categories) {
        const t = twin.counts[cat] ?? 0;
        let h = home.counts[cat] ?? 0;
        // A capped home page is a sample: before calling something a gap, count it on its own.
        if (home.capped && isGap(t, h)) h = (await ev.homeCount(pair.hood, req.city, cat)).count;
        if (isGap(t, h) && !skip(cardId(pair.hood, pair.twin, pair.twinCity, cat))) gaps.push({ pair, cat, home: h, twin: t });
      }
    } catch (e) {
      if (isFatalQlooError(e)) throw e;
      ctx.onCompare?.(false);
      step("compare", `Skipped ${pair.hood} vs ${pair.twin}: Qloo lookup failed`, message(e));
    }
  }
  gaps.sort((a, b) => b.pair.similarity * (b.twin - b.home) - a.pair.similarity * (a.twin - a.home));

  const cards: OpportunityCard[] = [];
  // Gaps its own checks rule out don't use up a slot: keep going until there are enough.
  for (const [i, g] of gaps.entries()) {
    if (cards.length >= MAX_CARDS) break;
    if (ev.qloo.remaining < 5 || outOfTime()) {
      step("score", "Stopping early to stay within the Qloo budget and time limit");
      // Found but never scored: the run says so instead of looking like "nothing found".
      stopped({ reason: outOfTime() ? "time" : "budget", unscored: gaps.length - i });
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
    if (ev.googleEnabled) {
      step("doubt", `Cross-checking ${label.toLowerCase()} on Google Maps: ${g.pair.hood} vs ${g.pair.twin}`);
      await optional("Google Maps", () => ev.googleGap(g.pair.hood, req.city, g.pair.twin, g.pair.twinCity, g.cat));
    }

    step("score", `Scoring ${label} in ${g.pair.hood}`);
    try {
      const card = buildCard(ev, { category: g.cat, hood: g.pair.hood, city: req.city, twin: g.pair.twin, twinCity: g.pair.twinCity, why: "", doubts: [], productFit: null });
      // The tastes named are the card's own shared tastes (the twin's, when known).
      const tastes = card.sharedTastes.map((t) => t.name);
      card.why =
        `People in ${g.pair.hood} share their taste profile with ${g.pair.twin}${tastes.length ? ` (${tastes.join(", ")})` : ""}. ` +
        `That audience supports ${card.capped.twin ? "at least " : ""}${card.twinCount} ${label.toLowerCase()} places in ${g.pair.twin}, ` +
        `but ${g.pair.hood} has ${card.capped.home ? `at least ${card.homeCount} (a capped count)` : `only ${card.homeCount}`}.`;
      card.author = "pipeline";
      if (card.google?.verdict === "contradicts") {
        ctx.onRejected?.(card, "Ruled out by a cross-check against a second index (see the card)");
        continue;
      }
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
  // Out of time before every neighbourhood was profiled or every pair compared.
  if (cutShort && !stopReported) {
    step("score", "Stopping early to stay within the time limit");
    stopped({ reason: "time", unscored: 0 });
  }
  return cards;
}
