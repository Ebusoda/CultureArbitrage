import { qlooMode } from "../qloo";
import type { Focus } from "./types";

interface Category {
  key: string;
  label: string;
  focus: Exclude<Focus, "all">;
  // Tag id in mock-data.ts.
  mockTag: string;
  // Real Qloo tag id. Fill in after 01-tests.ps1 (section A) shows what they are,
  // or set them without a code change: QLOO_CATEGORY_TAGS=malatang=urn:tag:...,bubble_tea=urn:tag:...
  liveTag: string | null;
  // Live Qloo has no fan demographics for some categories; this broader tag stands in, labelled as such.
  audienceProxy?: { tag: string; label: string };
  // How to look the category up on Google Maps for the cross-check: a query per language, and a
  // Places "Table A" type when one exists (strict = count only places of that type).
  google: { ja: string; en: string; ko: string; type?: string; strict?: boolean };
}

// Live ids checked against real Qloo results on 2026-10-23 (places found in Tokyo / New York City / Seoul).
// Listening bar and K-beauty store have no Qloo tag that matches them (the nearest return 0 places,
// or every cosmetics shop), so live runs leave them out instead of counting the wrong thing.
const CATEGORIES: Category[] = [
  { key: "malatang", label: "Malatang", focus: "dining", mockTag: "urn:tag:mock:place:malatang", liveTag: "urn:tag:cuisine:qloo:malatang", audienceProxy: { tag: "urn:tag:genre:place:restaurant:hot_pot", label: "hot pot" }, google: { ja: "麻辣湯", en: "malatang", ko: "마라탕" } },
  { key: "bubble_tea", label: "Bubble tea", focus: "dining", mockTag: "urn:tag:mock:place:bubble_tea", liveTag: "urn:tag:genre:place:restaurant:bubble_tea_store", audienceProxy: { tag: "urn:tag:genre:place:restaurant:tea_house", label: "tea house" }, google: { ja: "タピオカ", en: "bubble tea", ko: "버블티" } },
  { key: "korean_fried_chicken", label: "Korean fried chicken", focus: "dining", mockTag: "urn:tag:mock:place:korean_fried_chicken", liveTag: "urn:tag:cuisine:qloo:korean_fried_chicken", audienceProxy: { tag: "urn:tag:genre:place:restaurant:korean", label: "Korean restaurant" }, google: { ja: "韓国チキン", en: "Korean fried chicken", ko: "치킨", type: "chicken_restaurant" } },
  { key: "bagel_shop", label: "Bagel shop", focus: "dining", mockTag: "urn:tag:mock:place:bagel_shop", liveTag: "urn:tag:genre:place:restaurant:bagel_shop", google: { ja: "ベーグル", en: "bagel shop", ko: "베이글", type: "bagel_shop", strict: true } },
  { key: "natural_wine_bar", label: "Natural wine bar", focus: "nightlife", mockTag: "urn:tag:mock:place:natural_wine_bar", liveTag: "urn:tag:cuisine:qloo:natural_wine", audienceProxy: { tag: "urn:tag:genre:place:restaurant:wine_bar", label: "wine bar" }, google: { ja: "自然派ワイン", en: "natural wine bar", ko: "내추럴 와인", type: "wine_bar" } },
  { key: "listening_bar", label: "Listening bar", focus: "nightlife", mockTag: "urn:tag:mock:place:listening_bar", liveTag: null, google: { ja: "リスニングバー", en: "listening bar", ko: "리스닝 바" } },
  { key: "record_store", label: "Record store", focus: "retail", mockTag: "urn:tag:mock:place:record_store", liveTag: "urn:tag:genre:place:record_store", google: { ja: "レコード店", en: "record store", ko: "레코드 가게" } },
  { key: "k_beauty", label: "K-beauty store", focus: "retail", mockTag: "urn:tag:mock:place:k_beauty", liveTag: null, google: { ja: "韓国コスメ", en: "K-beauty store", ko: "화장품 가게" } },
];

// "key=urn:tag:...,key2=urn:tag:..." from QLOO_CATEGORY_TAGS.
function envTags(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (process.env.QLOO_CATEGORY_TAGS ?? "").split(",")) {
    const [k, v] = pair.split("=").map((s) => s?.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

let warned = false;

// The tag id each category is looked up by in the current Qloo mode. In live mode a
// category with no real id yet keeps its mock id, which simply finds no places.
function tagOf(c: Category): string {
  if (qlooMode() === "mock") return c.mockTag;
  const id = envTags()[c.key] ?? c.liveTag;
  if (!id && !warned) {
    warned = true;
    console.warn(`[categories] no real Qloo tag id for ${c.key} (and maybe others); set liveTag in categories.ts or QLOO_CATEGORY_TAGS`);
  }
  return id ?? c.mockTag;
}

export function categoriesFor(focus: Focus): string[] {
  return CATEGORIES.filter((c) => focus === "all" || c.focus === focus)
    .map(tagOf)
    .filter((id) => qlooMode() === "mock" || !id.startsWith("urn:tag:mock:"));
}

// The broader tag whose fans stand in for this category's when Qloo has no demographics for it (live only).
export function audienceProxy(id: string): { tag: string; label: string } | null {
  if (qlooMode() === "mock") return null;
  const env = envTags();
  return CATEGORIES.find((c) => c.liveTag === id || env[c.key] === id)?.audienceProxy ?? null;
}

// The Google Maps query for a category, in the language of the city it is searched in.
export function googleQuery(id: string, lang: "ja" | "en" | "ko"): { textQuery: string; includedType?: string; strict?: boolean } | null {
  const env = envTags();
  const c = CATEGORIES.find((c) => c.mockTag === id || c.liveTag === id || env[c.key] === id);
  if (!c) return null;
  return { textQuery: c.google[lang], includedType: c.google.type, strict: c.google.strict };
}

export function categoryLabel(id: string): string {
  const env = envTags();
  const c = CATEGORIES.find((c) => c.mockTag === id || c.liveTag === id || env[c.key] === id);
  return c?.label ?? id;
}
