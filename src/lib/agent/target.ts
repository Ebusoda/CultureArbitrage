import { type BudgetedQloo, QlooError } from "../qloo";
import { CITIES, qlooLocation } from "../cities";
import { businessName, CATALOG, catalogByTag, catalogEntry, COVERAGE_CAP, COVERAGE_DATE, matchCatalog, normalizeQuery, singular, type CatalogEntry } from "./catalog";
import { catalogTag, registerCategory } from "./categories";
import type { StepFn } from "./run";
import type { ExploreRequest, Target } from "./types";

// Matching "check one business" requests to a Qloo tag, before the agent starts. A catalog key
// or a typed name the catalog knows costs no Qloo call. Anything else is looked up with Qloo's
// tag search (and, when it is not in Latin letters and Claude is on, put into English first),
// then counted across the three cities, so a type Qloo barely lists is turned away up front
// instead of spending the run on comparisons that cannot show a gap.

// Not a business type a visitor means: tag search returns these for almost any shop or food word.
const GENERIC = new Set([
  "store", "stores_shopping", "stores_and_shopping", "shopping", "shop", "restaurant", "restaurants", "cafe", "bar", "bars", "food",
  "place", "retail", "market", "service", "services", "business", "establishment", "restaurant_cafe", "bars_pubs", "point_of_interest",
]);
// Tag kinds that name a kind of place (live), or the sample data's place categories.
const PLACE_TAG = /^urn:tag:(genre:place|category:place|cuisine:qloo)(:restaurant)?:([a-z0-9_]+)$/;
const MOCK_PLACE_TAG = /^urn:tag:mock:place:([a-z0-9_]+)$/;
// Fewer places than this across a city cannot make a twin with a gap (a gap needs 4 there).
const MIN_TWIN_PLACES = 4;
const COUNT_TAKE = 50;

// Why a business type could not be checked, in words the page shows as they are.
export class TargetError extends Error {}

export interface Resolved {
  target: Target;
  // Places Qloo lists for it across each city (50 = 50 or more).
  coverage?: Record<string, number>;
  // When coverage was measured: the catalog's date, or omitted when counted in this run.
  coverageDate?: string;
}

// What the translation of a typed business type came back as: an English name, "none" (the text
// is not a kind of place), or "failed" (no usable answer: Claude unreachable, rate limited ...).
export type Translation = { english: string } | "none" | "failed";

export interface ResolveOptions {
  // Puts text in another script ("瑜伽", "요가", "CDショップ") into English for Qloo's tag search.
  translate?: (text: string) => Promise<Translation>;
  // Epoch ms after which matching starts no new lookup (the run's deadline).
  deadline?: number;
}

// Catalog entries usable in the current Qloo mode (the sample data has only the scan's 8).
function usable(): CatalogEntry[] {
  return CATALOG.filter((e) => catalogTag(e) !== null);
}

const quote = (s: string) => `“${s}”`;

function fromCatalog(e: CatalogEntry, live: boolean, city: string, query?: string): Resolved {
  const tag = catalogTag(e);
  if (!tag) throw new TargetError(`The sample data has no ${businessName(e.label)} places. Run with live Qloo data to check this business type.`);
  if (live) tooThin(e.label, city, e.coverage);
  return {
    target: { tag, label: e.label, key: e.key, source: "catalog", ...(query ? { query } : {}) },
    // Measured against live Qloo: meaningless for the sample data.
    ...(live ? { coverage: { ...e.coverage }, coverageDate: COVERAGE_DATE } : {}),
  };
}

// Words that say nothing about the kind of business ("yoga studio shop", "korean restaurant").
const STOP = new Set(["a", "an", "the", "of", "and", "for", "shop", "store", "place", "restaurant", "spot", "joint"]);

// "yoga studios" -> ["yoga", "studio"]: the words a tag must have, each in its singular form.
function words(text: string): string[] {
  return normalizeQuery(text)
    .split(" ")
    .map(singular)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// A tag's own words (slug and name), singular, without the words that say nothing.
function tagWords(slug: string, name: string): Set<string> {
  return new Set([...slug.split("_"), ...normalizeQuery(name).split(" ")].map(singular).filter((w) => w && !STOP.has(w)));
}

// A slug's own words, singular, without the words that say nothing ("korean_restaurant" -> korean).
function slugWords(slug: string): string[] {
  return slug.split("_").map(singular).filter((w) => w && !STOP.has(w));
}

// Any letter outside the Latin script ("瑜伽", "CDショップ"): Qloo's tag search reads English.
const NON_LATIN = /[^\p{Script=Latin}\P{L}]/u;

// An example to suggest that is not the text that just failed.
function example(typed: string): string {
  return normalizeQuery(typed).includes("yoga") ? "“ramen shop”" : "“yoga studio”";
}

function slugOf(id: string, live: boolean): string | null {
  const m = (live ? PLACE_TAG : MOCK_PLACE_TAG).exec(id);
  return m ? m[m.length - 1] : null;
}

// Sentence case for a Qloo tag name ("Yoga Studio" -> "Yoga studio").
function label(name: string): string {
  const n = name.trim();
  return n ? n[0].toUpperCase() + n.slice(1).toLowerCase() : n;
}

export async function resolveTarget(req: ExploreRequest, qloo: BudgetedQloo, step: StepFn, opts: ResolveOptions = {}): Promise<Resolved> {
  const live = qloo.mode === "live";
  // No new lookup (translation, tag search, count) once the run is out of time.
  const inTime = () => {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) throw new TargetError("The run ran out of time before the business type was matched. Try again.");
  };
  if (req.category) {
    const e = catalogEntry(req.category);
    if (!e) throw new TargetError(`${quote(req.category)} is not a business type on the list.`);
    const r = fromCatalog(e, live, req.city);
    step("profile", `Checking one business type: ${e.label}`, live ? coverageLine(r, req.city) : `Sample data tag ${r.target.tag}`);
    return r;
  }

  const typed = (req.query ?? "").trim();
  if (!typed) throw new TargetError("Type a business type to check, for example “yoga studio”.");
  // A listed type: no Qloo call. A listed type the sample data lacks gets that reason, not a search.
  const fromName = (text: string, what: string): Resolved | null => {
    const known = matchCatalog(text, usable());
    if (!known) {
      const listed = matchCatalog(text, CATALOG);
      if (listed && !catalogTag(listed)) fromCatalog(listed, live, req.city, typed);
      return null;
    }
    const r = fromCatalog(known, live, req.city, typed);
    step("profile", `Matched ${what} to ${known.label}`, live ? coverageLine(r, req.city) : `Sample data tag ${r.target.tag}`);
    return r;
  };
  const direct = fromName(typed, quote(typed));
  if (direct) return direct;

  let english = typed;
  if (NON_LATIN.test(typed)) {
    if (!opts.translate) throw new TargetError(`No business type on the list is called ${quote(typed)}. Try its English name, for example ${example(typed)}.`);
    inTime();
    step("profile", `Putting ${quote(typed)} into English for Qloo's tag search`, "One short Claude call: Qloo's tag search reads English.");
    const out = await opts.translate(typed);
    if (out === "failed") throw new TargetError(`Could not put ${quote(typed)} into English just now (Claude did not answer). Try its English name, for example ${example(typed)}.`);
    if (out === "none") throw new TargetError(`${quote(typed)} does not read as a kind of shop, restaurant or venue. Try its English name, for example ${example(typed)}.`);
    english = out.english;
    const again = fromName(english, `${quote(typed)} (${english})`);
    if (again) return again;
  }

  const want = words(english);
  if (!want.length) throw new TargetError(`${quote(typed)} is too general to match one business type. Try something like ${example(typed)}.`);
  // "bar", "cafe", "shopping": one word that names no particular business. Refused before any search,
  // whatever Qloo would return (a narrower tag must not stand in for it).
  if (GENERIC.has(want.join("_"))) {
    throw new TargetError(`${quote(typed)} is too general to check as one business. Try a narrower kind, for example “wine bar” or “cocktail bar” instead of “bar”.`);
  }
  inTime();
  step("profile", `Searching Qloo's tags for ${quote(english)}`, "The run will check the place category Qloo files these under.");
  const res = await qloo.tags({ "filter.query": english, "filter.parents.types": "urn:entity:place", take: 25 });
  const candidates: { id: string; name: string; slug: string; rank: number; order: number }[] = [];
  let tooGeneral = false;
  for (const [order, t] of (res.results.tags ?? []).entries()) {
    if (!t || typeof t.id !== "string" || typeof t.name !== "string") continue;
    const slug = slugOf(t.id, live);
    if (!slug || t.id.includes(":hotel:")) continue;
    // Whole words only: "ice" is not in "juice", "car" is not in "card".
    const have = tagWords(slug, t.name);
    if (!want.every((w) => have.has(w))) continue;
    // The tag is exactly what was asked for ("korean" -> Korean restaurant, not Korean barbecue).
    const exact = slugWords(slug).every((w) => want.includes(w));
    if (GENERIC.has(slug)) {
      // "bar" itself: too broad to check as one business, and no narrower tag should stand in.
      if (exact) tooGeneral = true;
      continue;
    }
    // Exact first, then a catalog type, then "this kind of place" tags over cuisine-served tags.
    const rank = (exact ? 0 : 10) + (catalogByTag(t.id) ? 0 : 3) + (t.id.includes(":genre:place") ? 0 : t.id.includes(":category:place") ? 1 : 2);
    candidates.push({ id: t.id, name: t.name, slug, rank, order });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.slug.length - b.slug.length || a.order - b.order);
  const best = candidates[0];
  if (tooGeneral && (!best || best.rank >= 10)) {
    throw new TargetError(`${quote(typed)} is too general to check as one business. Try a narrower kind, for example “wine bar” or “cocktail bar” instead of “bar”.`);
  }
  if (!best) {
    throw new TargetError(
      live
        ? `Qloo has no place category for ${quote(typed)}${english !== typed ? ` (${english})` : ""}. Try a more common name for the business, for example ${example(typed)}.`
        : `The sample data has no place category for ${quote(typed)}. Run with live Qloo data to check it.`,
    );
  }
  const listed = catalogByTag(best.id);
  if (listed && catalogTag(listed)) {
    const found = fromCatalog(listed, live, req.city, typed);
    const r: Resolved = { ...found, target: { ...found.target, source: "qloo" } };
    step("profile", `Qloo files ${quote(english)} under ${listed.label}`, live ? coverageLine(r, req.city) : `Sample data tag ${r.target.tag}`);
    return r;
  }

  const name = label(best.slug.replace(/_/g, " "));
  registerCategory(best.id, name);
  const target: Target = { tag: best.id, label: name, source: "qloo", query: typed };
  step("profile", `Counting ${name.toLowerCase()} places across the three cities`, `Qloo tag ${best.id}`);
  const coverage: Record<string, number> = {};
  for (const city of CITIES) {
    inTime();
    const r = await qloo.insights({ "filter.type": "urn:entity:place", "filter.location.query": live ? qlooLocation(city) : city, "filter.tags": best.id, take: COUNT_TAKE });
    coverage[city] = Math.min(COVERAGE_CAP, (r.results.entities ?? []).length);
  }
  tooThin(name, req.city, coverage);
  return { target, coverage };
}

// No other city lists enough of it for a twin there to show a gap: nothing to compare with.
function tooThin(name: string, city: string, coverage: Record<string, number>) {
  const others = CITIES.filter((c) => c !== city);
  if (others.every((c) => (coverage[c] ?? 0) < MIN_TWIN_PLACES)) {
    throw new TargetError(
      `Qloo lists too few ${businessName(name)} places in ${others.join(" or ")} (${others.map((c) => coverage[c] ?? 0).join(" and ")}) for a neighbourhood there to show a gap, so ${city} cannot be compared on it.`,
    );
  }
}

// The cities a twin may come from when checking one business type: the other cities, except one
// where Qloo lists fewer places than a gap needs (no neighbourhood there could show one).
// A scan, or a type whose coverage is unknown (sample data), keeps every other city.
export function twinCities(req: Pick<ExploreRequest, "city" | "target">): string[] {
  const others = CITIES.filter((c) => c !== req.city);
  const cov = req.target?.coverage;
  if (!cov) return others;
  const usable = others.filter((c) => (cov[c] ?? 0) >= MIN_TWIN_PLACES);
  return usable.length ? usable : others;
}

// "Qloo listed 9 / 50+ / 0 places in Tokyo / New York / Seoul (25 Oct 2026)."
export function coverageLine(r: Resolved, city: string): string {
  if (!r.coverage) return `Qloo tag ${r.target.tag}`;
  const cities = Object.keys(r.coverage);
  const n = (c: string) => (r.coverage![c] >= COVERAGE_CAP ? `${COVERAGE_CAP}+` : String(r.coverage![c]));
  const when = r.coverageDate ? ` (counted ${r.coverageDate})` : "";
  const thin = (r.coverage[city] ?? COVERAGE_CAP) < 5 ? ` Qloo lists few in ${city}, so a gap there may be missing data rather than missing shops.` : "";
  return `Qloo tag ${r.target.tag}. Places Qloo lists city-wide: ${cities.map((c) => `${c} ${n(c)}`).join(", ")}${when}.${thin}`;
}

// A failed tag search that only this request would hit (not the key or the address).
export function isTargetFailure(e: unknown): boolean {
  return e instanceof TargetError || (e instanceof QlooError && e.kind === "bad_request");
}
