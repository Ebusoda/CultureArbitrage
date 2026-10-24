import { BudgetExceededError, type BudgetedQloo } from "../qloo";
import { canonicalCity, qlooLocation } from "../cities";
import type { QlooEntity } from "../qloo";
import { audienceProxy, categoryLabel } from "./categories";
import { wardAudience } from "./census";
import type { SupplyEvent, TwinEvent } from "./types";

export interface Demographics {
  age: Record<string, number>;
  gender?: Record<string, number>;
  // Set when Qloo had no data for the category and a broader tag's fans stand in (e.g. "hot pot").
  proxy?: string;
  // Who a neighbourhood profile describes when it is not Qloo's own, e.g. "residents of Shibuya ward (...)".
  basis?: string;
}

export interface Trend {
  first: number;
  last: number;
  change: number; // relative change over the series, e.g. 0.4 = +40%
  points: number;
}

export interface Twin {
  name: string;
  city: string;
  // 0..1. Live: share of taste tags in common, scaled so that half of them shared is 1.
  similarity: number;
  rank: number;
  // Live: share of taste tags the two have in common (Jaccard), unscaled, e.g. 0.35.
  sharedShare?: number;
  // Live: some of the tastes they share.
  shared?: { name: string; affinity: number | null }[];
}

// Live locality entities carry a few hundred Qloo tags each. These kinds describe who goes
// there and what they do (trendy, vintage stores, cafe hopping, young professionals); the rest
// (monthly travel advisories, flora, transport, language) say nothing about taste.
const TASTE_TAG_TYPE = /^urn:tag:(characteristic|entertainment_option|demographic_characteristic|shopping|culture|ideal_traveler|popular_food_item|activity|culinary_experience):qloo$/;
// Localities scored per twin search. One call either way; the response is large (~1.4 MB for 30).
const TWIN_POOL = 30;
// Jaccard of real neighbourhood pairs runs from about 0.20 (Shibuya-ku vs Chinatown NYC) to 0.39
// (Taitō-ku vs Jung District), so half the tastes shared counts as a full match.
const FULL_MATCH = 0.5;

function tasteTags(e: QlooEntity): Map<string, string> {
  return new Map((e.tags ?? []).filter((t) => t.type && TASTE_TAG_TYPE.test(t.type)).map((t) => [t.id, t.name]));
}

export interface Supply {
  counts: Record<string, number>;
  // The response filled the whole page, so these counts are a sample, not a census.
  capped: boolean;
}

export interface CitySupply {
  count: number;
  capped: boolean;
}

interface Hooks {
  categories?: string[];
  onTwin?: (e: TwinEvent) => void;
  onSupply?: (e: SupplyEvent) => void;
  // After every new answer, so a run can re-score the gaps it has found.
  onLookup?: () => void;
}

// Live Qloo pages hold at most 50 results; the mock data has neighbourhoods with more.
const SUPPLY_TAKE = { live: 50, mock: 100 };
const CITY_TAKE = 50;

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\-_]+/g, " ").trim();

// Live locality results mix in the country, state, county and the city itself
// ("Japan", "Tokyo", "Kings County"); only parts of the city count as neighbourhoods.
const BROAD_PLACES = new Set(["country", "state", "province", "county", "region"]);
function isNeighbourhood(e: QlooEntity, city: string): boolean {
  const p = e.properties as { place?: string | null; admin_level?: number } | undefined;
  if (canonicalCity(e.name) || norm(e.name) === norm(qlooLocation(city))) return false;
  if (p?.place && BROAD_PLACES.has(p.place)) return false;
  return !(typeof p?.admin_level === "number" && p.admin_level < 6);
}

// Tags every live neighbourhood shares at ~1.0 affinity; they say nothing about its audience.
const GENERIC_TAGS = new Set([
  "urn:tag:genre:place",
  "urn:tag:genre:place:restaurant",
  "urn:tag:genre:place:shopping",
  "urn:tag:genre:place:tourist_attraction",
  "urn:tag:genre:place:hotel",
]);

// Every Qloo lookup the agent can make, cached per exploration. Scores are
// later computed only from what is stored here, so a card can never show a
// number that did not come from a Qloo response.
export class Evidence {
  private cache = new Map<string, unknown>();
  private failures = new Map<string, unknown>();
  // Memo key -> Qloo call numbers that produced it. Valid because lookups are
  // awaited one at a time, so a call range belongs to exactly one key.
  private prov = new Map<string, number[]>();
  // "<norm name>|<norm city>" -> neighbourhood name exactly as Qloo returned it.
  private names = new Map<string, string>();
  // Same key -> Qloo locality entity id, used as the signal when looking for twins.
  private ids = new Map<string, string>();
  // Same key -> its taste tags (live), id -> name.
  private tags = new Map<string, Map<string, string>>();
  // "<home>|<twin>|<twin city>" -> best twin found
  readonly twins = new Map<string, Twin>();

  constructor(
    readonly qloo: BudgetedQloo,
    private readonly hooks: Hooks = {},
  ) {}

  private async memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    // A lookup that failed once fails again for free, instead of spending quota.
    if (this.failures.has(key)) throw this.failures.get(key);
    const from = this.qloo.lastCall;
    let ok = false;
    try {
      const v = await fn();
      this.cache.set(key, v);
      ok = true;
      return v;
    } catch (e) {
      if (!(e instanceof BudgetExceededError)) this.failures.set(key, e);
      throw e;
    } finally {
      const calls = [...(this.prov.get(key) ?? [])];
      for (let n = from + 1; n <= this.qloo.lastCall; n++) calls.push(n);
      this.prov.set(key, calls);
      // After the provenance is recorded, so re-scoring can cite these calls.
      if (ok) this.hooks.onLookup?.();
    }
  }

  // Qloo location query for a city; mock data knows cities by their plain names.
  private loc(city: string): string {
    return this.qloo.mode === "live" ? qlooLocation(city) : city;
  }

  peek<T>(key: string): T | undefined {
    return this.cache.get(key) as T | undefined;
  }

  calls(...keys: string[]): number[] {
    return keys.flatMap((k) => this.prov.get(k) ?? []);
  }

  // Map whatever spelling the model used ("Shimokitazawa, Tokyo", "shimokitazawa",
  // "NYC") back to the names Qloo returned, so cache keys always match.
  city(raw: string): string {
    return canonicalCity(raw) ?? raw.trim();
  }

  hood(raw: string, rawCity: string): string {
    const city = norm(this.city(rawCity));
    const n = norm(raw);
    const candidates = [n, n.replace(new RegExp(`,\\s*${city}$`), ""), n.split(",")[0].trim()];
    for (const c of candidates) {
      const hit = this.names.get(`${c}|${city}`);
      if (hit) return hit;
    }
    return raw.split(",")[0].trim();
  }

  private remember(name: string, city: string, e?: QlooEntity) {
    const k = `${norm(name)}|${norm(city)}`;
    this.names.set(k, name);
    if (e?.entity_id) this.ids.set(k, e.entity_id);
    const t = e ? tasteTags(e) : null;
    if (t?.size) this.tags.set(k, t);
  }

  knownHoods(city: string): string[] {
    const c = `|${norm(this.city(city))}`;
    return [...this.names.entries()].filter(([k]) => k.endsWith(c)).map(([, v]) => v);
  }

  listNeighbourhoods(rawCity: string, take: number) {
    const city = this.city(rawCity);
    return this.memo(`hoods:${city}:${take}`, async () => {
      // Ask for a few extra: the country, state and city itself are dropped below.
      const extra = this.qloo.mode === "live" ? 8 : 0;
      const r = await this.qloo.insights({ "filter.type": "urn:entity:locality", "filter.location.query": this.loc(city), take: take + extra });
      const seen = new Set<string>();
      const out: { name: string; popularity: number | null }[] = [];
      for (const e of r.results.entities ?? []) {
        if (seen.has(norm(e.name)) || !isNeighbourhood(e, city)) continue;
        seen.add(norm(e.name));
        this.remember(e.name, city, e);
        out.push({ name: e.name, popularity: e.popularity ?? null });
      }
      return out.slice(0, take);
    });
  }

  tasteProfile(rawHood: string, rawCity: string, take = 4) {
    const city = this.city(rawCity);
    const hood = this.hood(rawHood, city);
    return this.memo(`taste:${hood}, ${city}`, async () => {
      const r = await this.qloo.insights({ "filter.type": "urn:tag", "signal.location.query": `${hood}, ${city}`, take: take + GENERIC_TAGS.size });
      return (r.results.tags ?? [])
        .filter((t) => !GENERIC_TAGS.has(t.tag_id))
        .slice(0, take)
        .map((t) => ({ id: t.tag_id, name: t.name, affinity: t.query?.affinity ?? null }));
    });
  }

  // Neighbourhoods in otherCity whose people share the home neighbourhood's top tastes.
  async findTwins(rawHood: string, rawCity: string, rawOther: string, take = 3) {
    const city = this.city(rawCity);
    const hood = this.hood(rawHood, city);
    const other = this.city(rawOther);
    const key = `twins:${hood}, ${city}->${other}`;
    const fresh = !this.cache.has(key);
    const twins = await this.memo(key, async (): Promise<Twin[]> => {
      const k = `${norm(hood)}|${norm(city)}`;
      const id = this.qloo.mode === "live" ? this.ids.get(k) : undefined;
      const homeTags = this.tags.get(k);
      if (id && homeTags) return this.liveTwins(id, homeTags, other, take);
      const tastes = await this.tasteProfile(hood, city);
      if (!tastes.length) return [] as Twin[];
      const r = await this.qloo.insights({
        "filter.type": "urn:entity:locality",
        "signal.interests.tags": tastes.map((t) => t.id).join(","),
        "filter.location.query": this.loc(other),
        take,
      });
      return (r.results.entities ?? [])
        .filter((e) => isNeighbourhood(e, other))
        .slice(0, take)
        .map((e, i) => ({ name: e.name, city: other, similarity: e.query?.affinity ?? 0, rank: i + 1 }));
    });
    if (fresh) {
      const profile = this.peek<{ name: string; affinity: number | null }[]>(`taste:${hood}, ${city}`) ?? [];
      for (const t of twins) {
        const tastes = t.shared ?? profile;
        this.remember(t.name, other);
        const k = `${hood}|${t.name}|${other}`;
        if (!this.twins.has(k)) this.twins.set(k, t);
        this.hooks.onTwin?.({
          type: "twin",
          home: hood,
          homeCity: city,
          twin: t.name,
          twinCity: other,
          similarity: t.similarity,
          rank: t.rank,
          tastes: tastes.map(({ name, affinity }) => ({ name, affinity })),
          calls: this.calls(`taste:${hood}, ${city}`, key),
        });
      }
    }
    return twins;
  }

  private async liveTwins(homeId: string, homeTags: Map<string, string>, other: string, take: number): Promise<Twin[]> {
    // Candidates: the other city's localities ranked with the home neighbourhood as the signal.
    // Qloo's own score for them is ~0.97 for every one (tag signals are ignored outright), so the
    // score used is how many taste tags each shares with home. Both lists come in this one response.
    const r = await this.qloo.insights({
      "filter.type": "urn:entity:locality",
      "signal.interests.entities": homeId,
      "filter.location.query": this.loc(other),
      take: TWIN_POOL,
    });
    const scored: Omit<Twin, "rank">[] = [];
    for (const e of r.results.entities ?? []) {
      // Seoul answers include tiny dong-level quarters named only in Hangul (순화동); Qloo lists
      // no places for them, so a gap could never be checked there. Named districts only.
      if (!isNeighbourhood(e, other) || !/[a-z]/i.test(e.name)) continue;
      const theirs = tasteTags(e);
      // No tags means Qloo knows nothing about the place, not that it is unlike.
      if (!theirs.size) continue;
      const shared = [...homeTags.keys()].filter((id) => theirs.has(id));
      const jaccard = shared.length / (homeTags.size + theirs.size - shared.length);
      this.remember(e.name, other, e);
      scored.push({
        name: e.name,
        city: other,
        similarity: Math.min(1, jaccard / FULL_MATCH),
        sharedShare: jaccard,
        shared: shared.slice(0, 6).map((id) => ({ name: homeTags.get(id)!, affinity: null })),
      });
    }
    return scored
      .sort((x, y) => y.similarity - x.similarity)
      .slice(0, take)
      .map((t, i) => ({ ...t, rank: i + 1 }));
  }

  // Places per category tag in one neighbourhood.
  async supply(rawHood: string, rawCity: string) {
    const city = this.city(rawCity);
    const hood = this.hood(rawHood, city);
    const key = `supply:${hood}, ${city}`;
    const fresh = !this.cache.has(key);
    const s = await this.memo(key, async (): Promise<Supply> => {
      // Live: only places in the categories being compared. Unfiltered, the page fills with
      // landmarks (Tokyo Disneyland, Haneda) and no category shows up at all.
      const cats = this.qloo.mode === "live" && this.hooks.categories?.length ? { "filter.tags": this.hooks.categories.join(",") } : {};
      const r = await this.qloo.insights({ "filter.type": "urn:entity:place", "filter.location.query": `${hood}, ${this.loc(city)}`, ...cats, take: SUPPLY_TAKE[this.qloo.mode] });
      const places = r.results.entities ?? [];
      const counts: Record<string, number> = {};
      for (const p of places) for (const t of p.tags ?? []) counts[t.id] = (counts[t.id] ?? 0) + 1;
      return { counts, capped: places.length >= SUPPLY_TAKE[this.qloo.mode] };
    });
    if (fresh && this.hooks.onSupply) {
      const cats = this.hooks.categories ?? Object.keys(s.counts);
      this.hooks.onSupply({
        type: "supply",
        hood,
        city,
        counts: Object.fromEntries(cats.map((c) => [categoryLabel(c), s.counts[c] ?? 0])),
        calls: this.calls(key),
      });
    }
    return s;
  }

  citySupply(rawCity: string, category: string) {
    const city = this.city(rawCity);
    return this.memo(`citysupply:${city}:${category}`, async (): Promise<CitySupply> => {
      const r = await this.qloo.insights({ "filter.type": "urn:entity:place", "filter.location.query": this.loc(city), "filter.tags": category, take: CITY_TAKE });
      const n = (r.results.entities ?? []).length;
      return { count: n, capped: n >= CITY_TAKE };
    });
  }

  categoryAudience(category: string) {
    return this.memo(`audience:${category}`, async () => {
      // Live Qloo has no fans' demographics for some categories (malatang, bubble tea); ask for a
      // broader tag in the same call and use it, labelled, only when the category itself is missing.
      const proxy = audienceProxy(category);
      const r = await this.qloo.insights({ "filter.type": "urn:demographics", "signal.interests.tags": proxy ? `${category},${proxy.tag}` : category });
      if (!proxy) return asDemographics(r.results.demographics);
      const rows = Array.isArray(r.results.demographics) ? (r.results.demographics as { entity_id?: string }[]) : [];
      const own = asDemographics(rows.filter((d) => d.entity_id === category));
      if (own) return own;
      const stand = asDemographics(rows.filter((d) => d.entity_id === proxy.tag));
      return stand ? { ...stand, proxy: proxy.label } : null;
    });
  }

  hoodAudience(rawHood: string, rawCity: string) {
    const city = this.city(rawCity);
    const hood = this.hood(rawHood, city);
    return this.memo(`hoodaudience:${hood}, ${city}`, async () => {
      if (this.qloo.mode === "live") {
        // Qloo has no residents' demographics (a location signal gets a 400). Tokyo wards use
        // official resident statistics; elsewhere the neighbourhood is described by the fans
        // of its top tastes, a weak stand-in (most neighbourhoods come out alike).
        const census = wardAudience(hood, city);
        if (census) return census;
        const tastes = await this.tasteProfile(hood, city);
        if (!tastes.length) return null;
        const r = await this.qloo.insights({ "filter.type": "urn:demographics", "signal.interests.tags": tastes.map((t) => t.id).join(",") });
        const d = asDemographics(r.results.demographics);
        return d ? { ...d, basis: `fans of ${hood}'s top tastes on Qloo` } : null;
      }
      const r = await this.qloo.insights({ "filter.type": "urn:demographics", "signal.location.query": `${hood}, ${city}` });
      return asDemographics(r.results.demographics);
    });
  }

  // Trending needs entity ids, so find a few representative places first.
  trend(category: string, rawCity: string) {
    const city = this.city(rawCity);
    return this.memo(`trend:${category}:${city}`, async (): Promise<Trend | null> => {
      // Live /v2/trending only covers artists, brands, films, people, podcasts and TV
      // (filter.type urn:entity:place gets a 400), so a place category has no trend to read.
      if (this.qloo.mode === "live") return null;
      const r = await this.qloo.insights({ "filter.type": "urn:entity:place", "filter.location.query": city, "filter.tags": category, take: 3 });
      const ids = (r.results.entities ?? []).map((e) => e.entity_id);
      if (!ids.length) return null;
      const end = new Date();
      const start = new Date(end);
      start.setUTCFullYear(end.getUTCFullYear() - 1);
      const t = await this.qloo.trending({
        "filter.type": "urn:entity:place",
        "signal.interests.entities": ids.join(","),
        "filter.start_date": start.toISOString().slice(0, 10),
        "filter.end_date": end.toISOString().slice(0, 10),
      });
      // If the API returns one row per entity per date, average per date first.
      const byDate = new Map<string, number[]>();
      for (const p of t.results.trending ?? []) {
        if (typeof p.popularity !== "number") continue;
        const k = String(p.date ?? byDate.size);
        byDate.set(k, [...(byDate.get(k) ?? []), p.popularity]);
      }
      const pts = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v.reduce((x, y) => x + y, 0) / v.length);
      if (pts.length < 2 || !pts[0]) return null;
      const first = pts[0];
      const last = pts[pts.length - 1];
      return { first, last, change: (last - first) / first, points: pts.length };
    });
  }
}

// Accepts the mock shape ({ age, gender } as shares) and the live one: an array with one
// entry per signal tag that has data, [{ entity_id, query: { age, gender } }], where each
// value is a lean from -1 to 1 against the average. Several live entries are averaged.
function asDemographics(v: unknown): Demographics | null {
  const all = (Array.isArray(v) ? v : [v])
    .map((x) => (x && typeof x === "object" && "query" in x ? (x as { query: unknown }).query : x))
    .filter((d): d is Demographics => !!d && typeof d === "object" && "age" in d && !!d.age && typeof d.age === "object");
  if (all.length <= 1) return all[0] ?? null;
  const age: Record<string, number> = {};
  for (const d of all) for (const [k, n] of Object.entries(d.age)) age[k] = (age[k] ?? 0) + n / all.length;
  return { age };
}
