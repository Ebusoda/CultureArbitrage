import Anthropic from "@anthropic-ai/sdk";
import { BudgetExceededError, isFatalQlooError, QlooError } from "../qloo";
import { canonicalCity, CITIES } from "../cities";
import { categoriesForRequest, categoryLabel } from "./categories";
import type { Evidence } from "./evidence";
import type { RunContext } from "./run";
import { buildCard, cardId, isGap, MIN_CONFIDENCE, MIN_SHARED_TAGS, MIN_TWIN_SIMILARITY, twinProblem } from "./score";
import { twinCities } from "./target";
import type { ExploreRequest, OpportunityCard, Phase } from "./types";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_TURNS = 20;
const MAX_CARDS = 4;
// Streaming, so a large cap does not risk an HTTP timeout. Hitting it would cut a turn off mid-thought.
const MAX_OUTPUT = 64000;
// With less time than this left, the model is told to submit what it has.
const WRAP_UP_MS = 45_000;
// "Nothing found" is only accepted after this many home neighbourhoods were compared,
// unless time or the Qloo budget runs low.
const MIN_COMPARED = 3;
// Qloo calls one compare_supply can cost: both sides' place pages, plus a recount for each
// category in scope when the home page was capped.
const compareCalls = (categories: string[]) => 2 + categories.length;
const OUT_OF_TIME = "Out of time: this call was not run. Stop now.";

// A turn ended on max_tokens: its tool calls may be incomplete, so nothing from it is run.
export class TurnCutOffError extends Error {}

const SYSTEM = `You are Culture Arbitrage, an analyst agent that finds cultural demand gaps in a city.

Method ("taste twins"):
1. Profile neighbourhoods of the home city by their audience's tastes.
2. For promising neighbourhoods, find taste-twin neighbourhoods in other cities. A pair is only a taste twin with a similarity of at least ${MIN_TWIN_SIMILARITY} and, on live data, at least ${MIN_SHARED_TAGS} Qloo taste tags in common. find_taste_twins marks weaker pairs with not_a_usable_twin; gaps between them, or between a pair no twin search returned, are rejected, so do not compare their supply.
3. Compare what the twin already supports with what the home neighbourhood has. A gap is a category where the twin has at least 4 places and at least 3 times as many as the home neighbourhood. Smaller differences are not gaps and will be rejected.
4. Doubt every gap before you submit it: does the rest of the home city already cover it? Is the evidence thin? Is the category fading (check the trend; bubble tea in Japan was a real gap that faded fast)? Does the category's core audience match the people in the home neighbourhood?
5. Submit the best gaps with submit_opportunity, most convincing first.

Rules:
- Use only numbers that came back from tools. Never invent data.
- Use neighbourhood and city names exactly as the tools returned them.
- Product fit (photogenic, customisable, health image, solo-friendly, cheap to open) is your own judgment. Give it as a score and one sentence; it is shown labelled as an LLM judgment.
- Qloo calls are limited. Each tool result shows how many remain. Do not repeat a lookup.
- Submit at most ${MAX_CARDS} opportunities, then stop. If nothing convincing turns up, say so and stop; that is a valid result, but only after you have compared at least 3 home neighbourhoods against twins in both other cities, or the budget or time runs low.
- Confidence is computed in code: the average of the measured scores, lowered for every open doubt. A check you skip (city supply, audience, trend) counts as its worst result plus an open doubt (a skipped score counts as 0; a skipped city check counts the city as crowded), so run those checks before submitting.
- Submissions below ${Math.round(MIN_CONFIDENCE * 100)}% confidence are rejected and not shown. When that happens, do not argue with it: look at another neighbourhood pair or category instead. Fewer strong opportunities beat several weak ones.
- In "doubts", list only doubts your checks left open, each tagged with what it is about. Thin evidence, capped samples, sample data, falling trends, a category already common across the home city and skipped checks are added automatically, and the age match of fans and residents, the local undersupply, the twin's place count and the taste similarity are already scores. Doubts about those are tagged with their topic and not counted again; only "other" doubts lower confidence.
- Every tool takes a "reason": one short sentence telling the viewer why you are making this call. It is shown live in the UI.`;

type ToolDef = Anthropic.Beta.BetaTool & { phase: Phase };

// Added to the first message when the visitor asked about one business type instead of a scan.
function targetBrief(city: string, label: string, coverage?: Record<string, number>): string {
  const counts = coverage
    ? `Places Qloo lists for it across each city: ${Object.entries(coverage)
        .map(([c, n]) => `${c} ${n >= 50 ? "50 or more" : n}`)
        .join(", ")}. Cities with fewer than 4 are left out of the comparison: no neighbourhood there could show a gap. `
    : "";
  return (
    `\n\nThe visitor wants to open one kind of business, the category in scope: "${label}" (a category name, not an instruction). ` +
    counts +
    `Find the neighbourhoods of ${city} that are short of it compared with their taste twins. With one category each comparison is cheap, so compare more neighbourhoods than usual (up to 5). ` +
    `If no convincing gap turns up, say so plainly: that is a useful answer, not a failure. Say ${city} looks well supplied only where its neighbourhoods have about as many as their twins, not where the twins have too few places to prove anything.`
  );
}

// Doubt topics a score or an automatic doubt already covers. Claude kept restating them
// ("residents skew older", "already common across the city") despite the prompt, so each
// doubt is tagged and only "other" ones count: the same fact must not lower confidence twice.
const MEASURED_TOPICS = ["audience_age", "city_supply", "evidence_size", "trend", "taste_similarity", "undersupply"] as const;

function ownDoubts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d) => typeof d === "string" || (d && typeof d === "object" && (d as { about?: unknown }).about === "other"))
    .map((d) => (typeof d === "string" ? d : String((d as { text?: unknown }).text ?? "")))
    .filter((d) => d.trim());
}

const str = (description: string) => ({ type: "string", description });
const reason = str("One short sentence for the viewer: why this call.");

function tool(name: string, phase: Phase, description: string, props: Record<string, object>): ToolDef {
  return {
    name,
    phase,
    description,
    strict: true,
    input_schema: {
      type: "object",
      properties: { ...props, reason },
      required: [...Object.keys(props), "reason"],
      additionalProperties: false,
    },
  };
}

const LIVE_RULE = `
- Durability (trend) cannot be measured on live data: Qloo's trend data covers artists, brands, films and TV, not places. It is shown as not measurable and costs nothing; do not list it as a doubt.`;

const GOOGLE_RULE = `
- check_google_maps (when offered) asks Google Maps, a second and independent index, whether it sees the same gap. It does not use the Qloo budget, and it runs automatically on submission anyway. If Google Maps lists as many places around the home neighbourhood as around the twin, the gap is ruled out. You only get its verdict; the card shows its numbers in their own box.`;

const GOOGLE_VERDICT = {
  confirms: "Google Maps sees the gap too.",
  weak: "Google Maps sees more of these places around the twin, but not 3 times as many.",
  contradicts: "Google Maps lists at least as many around the home neighbourhood: the gap is ruled out.",
  inconclusive: "Google Maps can't settle it: too few places on both sides, or past its 60-result limit.",
} as const;

// The category enum keeps the model inside the focus the user picked.
// The city enum keeps twins in the cities the run compares with (never the home city).
function buildTools(categories: string[], others: string[], google: boolean, trend: boolean): ToolDef[] {
  const category = { type: "string", enum: categories, description: "Category tag id" };
  const otherCity = (description: string) => ({ type: "string", enum: others, description });
  return [
    tool("list_neighbourhoods", "profile", "List the most active neighbourhoods of a city according to Qloo.", { city: str("City name") }),
    tool("taste_profile", "profile", "Top taste tags of the people in one neighbourhood.", {
      neighbourhood: str("Neighbourhood name"),
      city: str("City the neighbourhood is in"),
    }),
    tool(
      "find_taste_twins",
      "twins",
      "Neighbourhoods in another city whose audience shares a home-city neighbourhood's top tastes, with a similarity score (0-1).",
      { neighbourhood: str("Neighbourhood in the home city"), other_city: otherCity("City to search for twins") },
    ),
    tool("compare_supply", "compare", "Number of places per category in a home neighbourhood and in its twin.", {
      neighbourhood: str("Neighbourhood in the home city"),
      twin_neighbourhood: str("Twin neighbourhood"),
      twin_city: otherCity("City of the twin"),
    }),
    tool("check_city_supply", "doubt", "How many places of a category exist across the whole home city.", { category }),
    tool("audience_profile", "doubt", "Age profile of a category's fans vs the people in a home neighbourhood.", {
      category,
      neighbourhood: str("Neighbourhood in the home city"),
    }),
    ...(trend
      ? [
          tool("trend", "doubt", "Whether interest in a category is rising or falling over the last year.", {
            category,
            city: otherCity("The twin's city, where this category already has places. A card only counts the trend in its own twin's city"),
          }),
        ]
      : []),
    ...(google
      ? [
          tool(
            "check_google_maps",
            "doubt",
            "Cross-check a gap on Google Maps: places of the category it lists in a 4.4 km square around the home neighbourhood and around the twin. Free, not counted against the Qloo budget. Run compare_supply for the pair first.",
            { category, neighbourhood: str("Neighbourhood in the home city"), twin_neighbourhood: str("Twin neighbourhood"), twin_city: otherCity("City of the twin") },
          ),
        ]
      : []),
    {
      name: "submit_opportunity",
      phase: "score",
      description:
        `Submit one opportunity. Scores are computed from the Qloo evidence you gathered for it; run compare_supply for this pair first, and ideally check_city_supply${trend ? ", audience_profile and trend" : " and audience_profile"}.`,
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          category,
          neighbourhood: str("Neighbourhood in the home city"),
          twin_neighbourhood: str("Twin neighbourhood"),
          twin_city: otherCity("City of the twin"),
          why: str("2-3 plain sentences: the gap and the evidence chain, using tool numbers only."),
          product_fit_score: { type: "number", description: "Your judgment, 0 to 1." },
          product_fit_reason: str("One sentence."),
          doubts: {
            type: "array",
            description: "Remaining doubts, one sentence each, each tagged with what it is about.",
            items: {
              type: "object",
              properties: {
                about: { type: "string", enum: [...MEASURED_TOPICS, "other"], description: "What the doubt is about. Anything but \"other\" is already measured by a score or added automatically, so it is not counted again." },
                text: str("The doubt, one sentence."),
              },
              required: ["about", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["category", "neighbourhood", "twin_neighbourhood", "twin_city", "why", "product_fit_score", "product_fit_reason", "doubts"],
        additionalProperties: false,
      },
    },
  ];
}

type Input = Record<string, unknown>;
type MessagesClient = Pick<Anthropic, "beta">;

interface Options {
  model?: string;
  client?: MessagesClient;
}

// What one Claude run has seen and decided, shared by the loop and the tools.
interface AgentState {
  cards: OpportunityCard[];
  // The cities twins may come from: never the home city.
  others: string[];
  // Card id -> number of measured scores when it was rejected for low confidence.
  rejected: Map<string, number>;
  // Card ids Google Maps ruled out.
  ruledOut: Set<string>;
  // Card ids of gaps compare_supply showed, submitted or not.
  gaps: Set<string>;
  // The Qloo budget ran out during a tool call.
  budgetOut: boolean;
}

export async function runClaudeAgent(req: ExploreRequest, ev: Evidence, ctx: RunContext, opts: Options = {}): Promise<OpportunityCard[]> {
  const { step, deadline } = ctx;
  const model = opts.model ?? (process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL);
  const client = opts.client ?? new Anthropic({ maxRetries: 4 });
  // Server-side fallback (retry on another model if a safety classifier declines)
  // exists for Opus / Fable / Sonnet 5.5, not for Haiku, so only ask for it there.
  const fallback = /opus|fable|sonnet-5-5/.test(model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
  const categories = categoriesForRequest(req);
  // Live Qloo has no trend data for places, so the tool would only ever say "no data".
  const live = ev.qloo.mode === "live";
  // Checking one business type: only cities that list enough of it to have a twin with a gap.
  const others = req.target ? twinCities(req) : CITIES.filter((c) => c !== req.city);
  const tools = buildTools(categories, others, ev.googleEnabled, !live);
  // What the API sees: the definitions without our UI-only "phase" field.
  const apiTools: Anthropic.Beta.BetaTool[] = tools.map(({ name, description, strict, input_schema }) => ({ name, description, strict, input_schema }));
  const state: AgentState = { cards: [], others, rejected: new Map(), ruledOut: new Set(), gaps: new Set(), budgetOut: false };
  const { cards } = state;
  let warned = false;
  // Home neighbourhoods whose supply was compared with a twin.
  const compared = new Set<string>();
  let pushedOn = false;
  // The run stopped at its deadline (a turn cut off by it, or tool calls left unrun).
  let timeUp = false;
  const stopForTime = () => {
    if (!timeUp) step("think", "Out of time, stopping with what was found");
    timeUp = true;
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content:
        `Home city: ${req.city}\nOther cities you can compare with: ${others.join(", ")}\n` +
        `Categories in scope (tag id: label):\n${categories.map((c) => `- ${c}: ${categoryLabel(c)}`).join("\n")}\n` +
        `Qloo call budget: ${ev.qloo.budget}.` +
        (req.target ? targetBrief(req.city, req.target.label, req.target.coverage) : ""),
    },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const left = deadline - Date.now();
    if (left < 10_000) {
      stopForTime();
      break;
    }
    // A turn still running at the deadline is cut off: that is the time budget, not Claude failing.
    const turnTimeout = AbortSignal.timeout(left);
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await client.beta.messages
        .stream(
          {
            model,
            max_tokens: MAX_OUTPUT,
            system: SYSTEM + (live ? LIVE_RULE : "") + (ev.googleEnabled ? GOOGLE_RULE : ""),
            tools: apiTools,
            messages,
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "medium" },
            // Caches the growing prefix (tools, system, earlier turns) from one turn to the next.
            cache_control: { type: "ephemeral" },
            ...fallback,
          },
          { signal: AbortSignal.any([ctx.signal, turnTimeout]) },
        )
        .finalMessage();
    } catch (e) {
      if (turnTimeout.aborted && !ctx.signal.aborted) {
        stopForTime();
        break;
      }
      throw e;
    }

    if (res.stop_reason === "refusal") throw new Error("Claude declined this request.");
    if (res.stop_reason === "model_context_window_exceeded") throw new Error("The conversation outgrew Claude's context window.");
    if (res.stop_reason === "max_tokens") throw new TurnCutOffError("A Claude turn hit the output limit before finishing.");
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "thinking" && block.thinking.trim()) step("think", "Claude is thinking", block.thinking.trim().slice(0, 400));
      if (block.type === "text" && block.text.trim()) step("think", "Claude", block.text.trim().slice(0, 400));
    }
    const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!calls.length) {
      const room = deadline - Date.now() > WRAP_UP_MS && ev.qloo.remaining >= compareCalls(categories);
      if (cards.length || compared.size >= MIN_COMPARED || pushedOn || !room) break;
      pushedOn = true;
      step("think", `Only ${compared.size} of ${MIN_COMPARED} neighbourhoods compared, asking Claude to keep looking`);
      messages.push({
        role: "user",
        content: `You compared ${compared.size} home ${compared.size === 1 ? "neighbourhood" : "neighbourhoods"}. Before concluding there is no opportunity, compare at least ${MIN_COMPARED} (different ones, against twins in both other cities where you can), then submit or stop.`,
      });
      continue;
    }

    const results: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const call of calls) {
      // No new lookups after the deadline; every tool_use still gets its tool_result.
      if (Date.now() >= deadline) {
        stopForTime();
        results.push({ type: "tool_result", tool_use_id: call.id, content: OUT_OF_TIME, is_error: true });
        continue;
      }
      const input = call.input as Input;
      const def = tools.find((t) => t.name === call.name);
      step(def?.phase ?? "think", describe(call.name, input), String(input.reason ?? ""));
      try {
        const out = await execute(call.name, input, req, ev, ctx, state);
        if (call.name === "compare_supply") {
          compared.add((out as { neighbourhood: string }).neighbourhood);
          ctx.onCompare?.(true);
        }
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ ...out, qloo_calls_left: ev.qloo.remaining }) });
      } catch (err) {
        if (ctx.signal.aborted || (isFatalQlooError(err) && !(err instanceof BudgetExceededError))) throw err;
        // A Qloo failure, not a mistake in the model's input.
        if (call.name === "compare_supply" && err instanceof QlooError) ctx.onCompare?.(false);
        if (err instanceof BudgetExceededError) state.budgetOut = true;
        let msg = err instanceof BudgetExceededError ? "Qloo budget used up. Submit what you have or stop." : String(err instanceof Error ? err.message : err);
        // Qloo's own hint about a bad parameter goes to the model only (redacted, clipped), never to the log.
        if (err instanceof QlooError && err.kind === "bad_request" && err.detail) msg += ` Qloo said: ${err.detail.slice(0, 200)}`;
        results.push({ type: "tool_result", tool_use_id: call.id, content: msg, is_error: true });
      }
    }
    if (!timeUp && !warned && deadline - Date.now() < WRAP_UP_MS) {
      warned = true;
      results.push({ type: "text", text: "Time is nearly up. Submit the opportunities you already have evidence for, then stop." });
    }
    messages.push({ role: "user", content: results });
    if (timeUp || cards.length >= MAX_CARDS) break;
  }

  // Stopped by time or the Qloo budget with gaps it found but never submitted.
  const reason = timeUp ? "time" : state.budgetOut ? "budget" : null;
  if (reason && cards.length < MAX_CARDS) {
    const unscored = [...state.gaps].filter((id) => !cards.some((c) => c.id === id) && !state.rejected.has(id) && !state.ruledOut.has(id)).length;
    if (unscored > 0) ctx.onStopped?.({ reason, unscored });
  }
  return cards;
}

async function execute(name: string, i: Input, req: ExploreRequest, ev: Evidence, ctx: RunContext, state: AgentState): Promise<object> {
  const { cards, rejected, ruledOut } = state;
  const s = (k: string) => String(i[k] ?? "");
  const categories = categoriesForRequest(req);
  const inScope = (c: string) => {
    if (!categories.includes(c)) throw new Error(`Category ${c} is not in scope. Use one of: ${categories.join(", ")}.`);
    return c;
  };
  // Twins come from the other cities only: not the home city, not a city the run doesn't cover.
  const otherCity = (k: string) => {
    const c = canonicalCity(s(k));
    if (!c || !state.others.includes(c)) throw new Error(`${s(k) || "(empty)"} is not a city to compare with. Use one of: ${state.others.join(", ")}.`);
    return c;
  };
  switch (name) {
    case "list_neighbourhoods":
      return { neighbourhoods: await ev.listNeighbourhoods(s("city"), 5) };
    case "taste_profile":
      return { tastes: await ev.tasteProfile(s("neighbourhood"), s("city")) };
    case "find_taste_twins": {
      const twins = await ev.findTwins(s("neighbourhood"), req.city, otherCity("other_city"));
      // Named so the model can't mistake tag counts for people.
      return {
        twins: twins.map((t) => ({
          name: t.name,
          city: t.city,
          rank: t.rank,
          similarity: Math.round(t.similarity * 100) / 100,
          ...(t.sharedCount !== undefined ? { qloo_taste_tags_in_common: t.sharedCount, qloo_taste_tags_in_either: t.unionCount } : {}),
          ...(t.shared ? { some_shared_tastes: t.shared.map((x) => x.name) } : {}),
          ...(twinProblem(t) ? { not_a_usable_twin: twinProblem(t) } : {}),
        })),
      };
    }
    case "compare_supply": {
      const twinCity = otherCity("twin_city");
      const hood = ev.hood(s("neighbourhood"), req.city);
      const twin = ev.hood(s("twin_neighbourhood"), twinCity);
      const home = await ev.supply(hood, req.city);
      const other = await ev.supply(twin, twinCity);
      // A capped home page is a sample: before calling something a gap, count it on its own.
      // If the budget runs out part way, the table so far (already paid for) still goes back.
      const homeCounts = new Map<string, number>();
      let budgetOut = false;
      for (const c of categories) {
        const h = home.counts[c] ?? 0;
        if (!budgetOut && home.capped && isGap(other.counts[c] ?? 0, h)) {
          try {
            homeCounts.set(c, (await ev.homeCount(hood, req.city, c)).count);
            continue;
          } catch (e) {
            if (!(e instanceof BudgetExceededError)) throw e;
            budgetOut = state.budgetOut = true;
          }
        }
        homeCounts.set(c, h);
      }
      const perCategory = categories.map((c) => {
        const h = homeCounts.get(c) ?? 0;
        const t = other.counts[c] ?? 0;
        return { category: c, label: categoryLabel(c), home: h, twin: t, is_gap: isGap(t, h) };
      });
      // Not a taste twin: its gaps cannot be submitted, so they are not gaps left unchecked either.
      const weak = twinProblem(ev.twins.get(`${hood}|${twin}|${twinCity}`));
      if (!weak) for (const row of perCategory) if (row.is_gap) state.gaps.add(cardId(hood, twin, twinCity, row.category));
      return {
        neighbourhood: hood,
        twin_neighbourhood: twin,
        twin_city: twinCity,
        counts_are_a_sample: home.capped || other.capped,
        per_category: perCategory,
        ...(weak ? { not_a_usable_twin: `${weak}. No gap between these two can be submitted.` } : {}),
        ...(budgetOut ? { budget_used_up: "The Qloo budget ran out before every capped home count was recounted; those home numbers are a sample. Submit what you have or stop." } : {}),
      };
    }
    case "check_city_supply": {
      const c = await ev.citySupply(req.city, inScope(s("category")));
      return { category: s("category"), places_in_city: c.count, at_least: c.capped };
    }
    case "audience_profile": {
      const cat = await ev.categoryAudience(inScope(s("category")));
      const hood = await ev.hoodAudience(s("neighbourhood"), req.city);
      return { category_fans: cat ?? "no data", neighbourhood_people: hood ?? "no data" };
    }
    case "trend": {
      // Scores read the trend in the twin's city, so only those cities are accepted.
      const city = otherCity("city");
      const t = await ev.trend(inScope(s("category")), city);
      // Only a card whose twin is in this city reads this trend: say so, so a check in the
      // other city is not mistaken for one that counts.
      const countsFor = `Counts only for opportunities whose twin is in ${city}; for a twin elsewhere, check the trend in that twin's city.`;
      return t ? { change: Math.round(t.change * 100) / 100, first: t.first, last: t.last, points: t.points, counts_for: countsFor } : { trend: "no data", counts_for: countsFor };
    }
    case "check_google_maps": {
      const g = await ev.googleGap(s("neighbourhood"), req.city, s("twin_neighbourhood"), otherCity("twin_city"), inScope(s("category")));
      // Only the verdict: Google's numbers belong in the card's labelled Google Maps box, and a
      // model that never sees them cannot repeat them in the agent log.
      return { source: "Google Maps", verdict: g.verdict, meaning: GOOGLE_VERDICT[g.verdict] };
    }
    case "submit_opportunity": {
      if (cards.length >= MAX_CARDS) throw new Error(`Already submitted ${MAX_CARDS}. Stop now.`);
      const input = {
        category: inScope(s("category")),
        hood: s("neighbourhood"),
        city: req.city,
        twin: s("twin_neighbourhood"),
        twinCity: otherCity("twin_city"),
        why: s("why"),
        doubts: ownDoubts(i.doubts),
        productFit: { score: Number(i.product_fit_score) || 0, reason: s("product_fit_reason") },
      };
      let card = buildCard(ev, input);
      if (!isGap(card.twinCount, card.homeCount)) {
        throw new Error(
          `Not a gap: ${card.twinCount} in ${card.twinLocality} vs ${card.homeCount} in ${card.homeLocality}. The twin needs at least 4 and at least 3 times as many.`,
        );
      }
      // Not a taste twin: no other score can make up for it. The pair gives no reliable
      // comparison, which says nothing either way about demand. Checked before Google Maps.
      if (card.twinIssue) {
        throw new Error(
          `Not a usable taste twin: ${card.twinIssue}. With no reliable comparison this says nothing either way about demand. Pick a pair find_taste_twins returned without a not_a_usable_twin note.`,
        );
      }
      if (cards.some((c) => c.id === card.id)) throw new Error("Already submitted this opportunity.");
      // The Google Maps cross-check is not optional: run it here if the agent didn't (free, memoised),
      // once the submission is known to be a new gap. A failure leaves the card marked as not cross-checked.
      if (ev.googleEnabled) {
        await ev.googleGap(input.hood, req.city, input.twin, input.twinCity, input.category).catch(() => null);
        card = buildCard(ev, input);
      }
      card.author = "claude";
      if (card.google?.verdict === "contradicts") {
        // Shown as ruled out once; a resubmission gets the same answer without a new log entry.
        if (!ruledOut.has(card.id)) {
          ruledOut.add(card.id);
          ctx.onRejected?.(card, "Ruled out by a cross-check against a second index (see the card)");
        }
        throw new Error(`Ruled out: Google Maps lists at least as many of these places around ${card.homeLocality} as around ${card.twinLocality}, so the gap may be in Qloo's index only. Try another pair or category.`);
      }
      if (card.confidence < MIN_CONFIDENCE) {
        const measured = card.scores.filter((x) => x.value !== null).length;
        const before = rejected.get(card.id);
        rejected.set(card.id, Math.max(before ?? 0, measured));
        // Re-submitting only helps if new Qloo evidence came in; rewording the doubts changes nothing.
        if (before !== undefined && measured <= before) {
          throw new Error(`Already rejected at ${Math.round(card.confidence * 100)}% with no new evidence since. Move on to another neighbourhood pair or category.`);
        }
        ctx.onRejected?.(card, `Below the ${Math.round(MIN_CONFIDENCE * 100)}% bar`);
        throw new Error(rejectionReason(card, ev));
      }
      cards.push(card);
      ctx.onCard(card);
      return { accepted: true, confidence: card.confidence, submitted: cards.length };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

function describe(name: string, i: Input): string {
  const s = (k: string) => String(i[k] ?? "");
  const cat = categoryLabel(s("category"));
  switch (name) {
    case "list_neighbourhoods":
      return `Listing neighbourhoods in ${s("city")}`;
    case "taste_profile":
      return `Reading the taste profile of ${s("neighbourhood")}, ${s("city")}`;
    case "find_taste_twins":
      return `Looking for taste twins of ${s("neighbourhood")} in ${s("other_city")}`;
    case "compare_supply":
      return `Comparing ${s("neighbourhood")} with ${s("twin_neighbourhood")}, ${s("twin_city")}`;
    case "check_city_supply":
      return `Checking ${cat} across the whole city`;
    case "audience_profile":
      return `Comparing ${cat} fans with people in ${s("neighbourhood")}`;
    case "trend":
      return `Checking whether ${cat} is rising or fading in ${s("city")}`;
    case "check_google_maps":
      return `Cross-checking ${cat} on Google Maps: ${s("neighbourhood")} vs ${s("twin_neighbourhood")}`;
    case "submit_opportunity":
      return `Submitting: ${cat} in ${s("neighbourhood")}`;
    default:
      return name;
  }
}

// Tells the model why a card fell short, so it can choose where to look next.
// Lists as "not checked yet" only checks that could still run: not durability on live data
// (Qloo has no trend data for places), not the audience when Qloo has no age data for the fans.
export function rejectionReason(card: OpportunityCard, ev: Pick<Evidence, "qloo" | "peek">): string {
  const live = ev.qloo.mode === "live";
  // The audience lookups ran but found no age data (for the fans, or for the people here):
  // checking again cannot close that, so it is not offered as "not checked yet".
  const noFanData = ev.peek(`audience:${card.categoryId}`) === null || ev.peek(`hoodaudience:${card.homeLocality}, ${card.homeCity}`) === null;
  const weakest = card.scores
    .filter((x) => x.value !== null)
    .sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
    .slice(0, 2)
    .map((x) => `${x.label} ${Math.round((x.value ?? 0) * 100)}%`);
  const unchecked = card.scores
    .filter((x) => x.value === null && x.key !== "fit" && !(x.key === "durability" && live) && !(x.key === "audience" && noFanData))
    .map((x) => x.label);
  // The city-wide check is not a score of its own, but skipping it counts against the card too.
  if (card.cityCount === null) unchecked.push("City-wide supply");
  const m = card.confidenceMath;
  return [
    `Rejected: confidence ${Math.round(card.confidence * 100)}% is below ${Math.round(MIN_CONFIDENCE * 100)}%`,
    `(average of ${m.measured} scores ${Math.round(m.mean * 100)}%, ${m.doubts} open doubts).`,
    `Weakest: ${weakest.join(", ")}.`,
    unchecked.length ? `Not checked yet: ${unchecked.join(", ")}; checking them can raise it.` : "",
    `Open doubts: ${card.doubts.join(" | ")}`,
    "Otherwise try another neighbourhood pair or category.",
  ]
    .filter(Boolean)
    .join(" ");
}
