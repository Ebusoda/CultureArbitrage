import data from "../../data/categories.json";

// Every business type a visitor can ask about on its own ("check one business"), with the
// Qloo tag it is looked up by. Plain data and pure functions, so the page can import it too
// (categories.ts holds the server side: which tag to use in which Qloo mode).
//
// Built on 2026-10-25 from live Qloo answers: about 350 candidate types were counted across
// Tokyo, New York City and Seoul (one place search per city, 50 results at most). A type is in
// the catalog when Qloo lists at least 5 places in at least two of the three cities, so a
// taste twin can have the 4 places a gap needs. coverage keeps those counts (50 = 50 or more).
// The scan's 8 categories (categories.ts) are in it too, with the same tags and labels.

export type CatalogGroup = "dining" | "nightlife" | "retail" | "lifestyle";

export interface CatalogEntry {
  key: string;
  label: string;
  group: CatalogGroup;
  // Live Qloo tag id.
  tag: string;
  // Tag id in the sample data, for the 8 categories the sample data has.
  mockTag?: string;
  // Places Qloo listed across each city on the date below (50 means 50 or more).
  coverage: Record<string, number>;
  // Google Maps text query per language, for the cross-check (as in categories.ts).
  google: { ja: string; en: string; ko: string; type?: string; strict?: boolean };
  // Other words a visitor may type for it (synonyms, Chinese, Japanese, Korean).
  aliases: string[];
}

export const CATALOG: CatalogEntry[] = data.entries as CatalogEntry[];
export const COVERAGE_DATE: string = data.measuredAt;
// A city-wide count at this cap is a lower bound.
export const COVERAGE_CAP = 50;
// Below this many places city-wide, a gap in that city may only be Qloo not listing them.
export const THIN_COVERAGE = 5;

export const CATALOG_GROUPS: { value: CatalogGroup; label: string }[] = [
  { value: "dining", label: "Food and cafés" },
  { value: "nightlife", label: "Bars and nightlife" },
  { value: "retail", label: "Shops" },
  { value: "lifestyle", label: "Wellness and leisure" },
];

const byKey = new Map(CATALOG.map((e) => [e.key, e]));
const byTag = new Map(CATALOG.flatMap((e) => [[e.tag, e] as const, ...(e.mockTag ? [[e.mockTag, e] as const] : [])]));

export function catalogEntry(key: string): CatalogEntry | undefined {
  return byKey.get(key);
}

// The entry a Qloo tag (live or sample) belongs to.
export function catalogByTag(tag: string): CatalogEntry | undefined {
  return byTag.get(tag);
}

// Lowercase, no accents, width-folded (ｶﾌｪ = カフェ), punctuation and spacing collapsed.
// Invisible format characters (soft hyphens, zero-width spaces) are dropped, and dashes, emoji
// and other symbols ("ramen 🍜", "yoga–studio") count as spaces.
export function normalizeQuery(s: string): string {
  return s
    .normalize("NFKC")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Pd}\p{Sm}\p{So}\p{Sk}\p{Me}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Variation_Selector}\u00b7\u2022\u2027:;*#]+/gu, " ")
    .replace(/[\s\-_.,/&'’"“”!?()（）・、。]+/g, " ")
    .trim();
}

// Singulars that end in "che", whose plural only adds "s".
const ENDS_IN_CHE = new Set(["quiche", "creche", "brioche", "ceviche", "niche", "cliche", "cache", "avalanche", "moustache", "mustache", "headache", "panache", "psyche", "douche", "pastiche", "fiche"]);
// Words that only come in the plural: "glasses" (an optician) is not more than one "glass".
const PLURAL_ONLY = new Set(["glasses", "eyeglasses", "sunglasses"]);

// One form for the singular and plural of an English word, so "yoga studios" meets "yoga studio"
// and "cookies" meets "cookie": "-ies" and "-ie" both become "-y", and a plain plural "s" goes.
export function singular(word: string): string {
  if (PLURAL_ONLY.has(word)) return word;
  // "dresses", "boxes", "dishes", "sandwiches", "churches": after ss, x, sh and ch the plural adds "es"
  // (not after "che": quiches, creches, niches).
  if (word.length > 4 && word.endsWith("ches") && ENDS_IN_CHE.has(word.slice(0, -1))) return word.slice(0, -1);
  if (word.length > 4 && /(ss|x|sh|ch)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("ie")) return word.slice(0, -2) + "y";
  if (word.length > 3 && /(ss|us)$/.test(word)) return word;
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function singularPhrase(s: string): string {
  return s.split(" ").map(singular).join(" ");
}

// The test matchCatalog uses: the same name, plurals and spacing aside ("sportsbar" is "sports bar").
function sameName(n: string, q: string, qs: string, compact: string): boolean {
  return n === q || singularPhrase(n) === qs || singularPhrase(n).replace(/ /g, "") === compact || n.replace(/ /g, "") === compact;
}

// Scripts written without spaces between words, where a name can only be searched as a whole.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;

// Words that say nothing about the kind of business ("a cafe", "yoga studio shop", "korean restaurant").
export const STOP_WORDS = new Set(["a", "an", "the", "of", "and", "n", "for", "shop", "store", "place", "restaurant", "spot", "joint"]);
const ARTICLES = new Set(["a", "an", "the"]);

// The words of a typed business type that name it, each singular: "the yoga studios" -> yoga, studio.
// One-letter words stay ("e-sports", "k-pop", "t-shirt"); only the possessive "s" of "women's" goes.
export function queryWords(text: string): string[] {
  return normalizeQuery(text)
    .split(" ")
    .map(singular)
    .filter((w) => w && w !== "s" && !STOP_WORDS.has(w));
}

// Every name an entry answers to, normalised.
function namesOf(e: CatalogEntry): string[] {
  const all = [e.label, e.key.replace(/_/g, " "), e.google.en, e.google.ja, e.google.ko, ...e.aliases];
  return [...new Set(all.map(normalizeQuery).filter(Boolean))];
}

const names = new Map(CATALOG.map((e) => [e.key, namesOf(e)]));

// Every name an entry answers to (label, key, Google queries, aliases), normalised.
export function catalogNames(e: CatalogEntry): string[] {
  return names.get(e.key) ?? namesOf(e);
}

// The ways typed text is read, in order: as typed; without a/an/the ("a sweet shop" is "sweet
// shop", a candy store); without any filler word ("a cafe" and "cafe shop" are "cafe").
export function typedForms(raw: string): string[] {
  const q = normalizeQuery(raw);
  const bare = q
    .split(" ")
    .filter((w) => !ARTICLES.has(w))
    .join(" ");
  return [...new Set([q, bare, queryWords(raw).join(" ")].filter(Boolean))];
}

// The listed type typed text means, read the way the server reads it (typedForms).
export function matchTyped(raw: string, entries: CatalogEntry[] = CATALOG): CatalogEntry | null {
  for (const form of typedForms(raw)) {
    const m = matchCatalog(form, entries);
    if (m) return m;
  }
  return null;
}

// The one entry a typed name means, or null when none or more than one does. Exact names only
// (plurals and spacing aside): "yoga" alone is not "yoga studio".
export function matchCatalog(raw: string, entries: CatalogEntry[] = CATALOG): CatalogEntry | null {
  const q = normalizeQuery(raw);
  if (!q) return null;
  const qs = singularPhrase(q);
  const compact = qs.replace(/ /g, "");
  const hits = entries.filter((e) => (names.get(e.key) ?? namesOf(e)).some((n) => sameName(n, q, qs, compact)));
  return hits.length === 1 ? hits[0] : null;
}

// Entries for a search box, best first: the same name, then one with the text as a whole word,
// then a name that starts with it, then one with a word that starts with it, then one that has it
// starting at a word (anywhere, for Japanese and Chinese, which have no spaces). minScore 20 keeps
// only word-start matches. Empty text lists nothing.
export function searchCatalog(raw: string, entries: CatalogEntry[] = CATALOG, limit = 12, minScore = 1): CatalogEntry[] {
  return scoreCatalog(raw, entries)
    .filter((x) => x.score >= minScore)
    .slice(0, limit)
    .map((x) => x.e);
}

// searchCatalog's ranking with the scores: 40 the same name, 35 a whole word (or, in Japanese and
// Chinese, the end of a name: バー in カクテルバー), 30 the start of a name, 20 the start of a word,
// 10 inside a name. The label scores one more than an alias.
export function scoreCatalog(raw: string, entries: CatalogEntry[] = CATALOG): { e: CatalogEntry; score: number }[] {
  const q = normalizeQuery(raw);
  if (!q) return [];
  const qs = singularPhrase(q);
  const compact = qs.replace(/ /g, "");
  const unspaced = !q.includes(" ") && UNSPACED.test(q);
  const compound = unspaced || HANGUL.test(q);
  const scored: { e: CatalogEntry; score: number }[] = [];
  for (const e of entries) {
    let score = 0;
    const label = normalizeQuery(e.label);
    for (const n of names.get(e.key) ?? namesOf(e)) {
      const s = n === label ? 1 : 0;
      // The same name, as matchCatalog reads it ("tapas bars", "ramenshop"), always comes first.
      if (n === q || n === qs || sameName(n, q, qs, compact)) score = Math.max(score, 40 + s);
      // A whole word ("bar" in "wine bar") beats the start of a longer one ("barbecue"). Without
      // spaces, the end of a name is its last word: バー in カクテルバー, not バーベキュー.
      else if (n.split(" ").some((w) => w === q || w === qs) || (unspaced && n.endsWith(q) && !n.startsWith(q))) score = Math.max(score, 35 + s);
      else if (n.startsWith(q) || n.startsWith(qs)) score = Math.max(score, 30 + s);
      else if (n.split(" ").some((w) => w.startsWith(q) || w.startsWith(qs))) score = Math.max(score, 20 + s);
      // Inside a name: at a word start for spaced text ("a cafe" is not in "manga cafe").
      else if (compound ? n.includes(q) : (" " + n).includes(" " + q) || (" " + n).includes(" " + qs)) score = Math.max(score, 10 + s);
    }
    if (score) scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.e.label.localeCompare(b.e.label));
}

// Words that keep their capital mid-sentence (places and peoples).
const PROPER =
  /^(American|Argentinian|Asian|Belgian|Brazilian|British|Cajun|Chinese|Cuban|Ethiopian|Filipino|French|Georgian|German|Greek|Hawaiian|Hong|Indian|Irish|Israeli|Italian|Jamaican|Japanese|Korean|Lebanese|Malaysian|Mexican|Middle|Nepalese|New|Peruvian|Polish|Russian|Sichuan|Spanish|Sri|Taiwanese|Thai|Turkish|Ukrainian|Vietnamese)$/;

// A business type in the middle of a sentence: "yoga studio", but "Korean barbecue" keeps its capital.
export function businessName(label: string) {
  const [first, ...rest] = label.trim().split(" ");
  const keep = PROPER.test(first) || /^[A-Z]{2,}/.test(first);
  return [keep ? first : first.toLowerCase(), ...rest].join(" ");
}

// Qloo lists so few of these across the city that a gap there may be missing data.
export function thinIn(e: { coverage?: Record<string, number> } | null | undefined, city: string): boolean {
  const n = e?.coverage?.[city];
  return typeof n === "number" && n < THIN_COVERAGE;
}
