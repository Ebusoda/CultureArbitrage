// The thresholds a card is judged by, in one place, so the scoring code (score.ts) and the
// page that explains a card (src/components/explorer) apply the same rules. Pure: no imports,
// safe in client components.

// Cards below this confidence are not shown: Claude gets them back with the reasons,
// and the fixed pipeline skips them. Matches where the UI's "Promising" band starts.
// Compared against the unrounded confidence; a card below it is stored at 0.54 at most.
export const MIN_CONFIDENCE = 0.55;

// Same bar the fixed pipeline uses to call something a gap: the twin has at least 4 places
// and at least 3 times as many as home.
export function isGap(twinCount: number, homeCount: number) {
  return twinCount >= 4 && twinCount >= 3 * Math.max(homeCount, 1);
}

// A gap only counts between taste twins, so the pair has to be one before any score is worked
// out: no other score can make up for it. Live, the pairs behind recorded cards share 45 to 59
// Qloo taste tags, 29% to 45% of all tags either has. The bar is a heuristic floor, not a
// calibrated one: at least a fifth of all tags shared (a bridge score of 40%, as half shared
// is a full match) and at least 10 tags in common, so a high share of a handful of tags does
// not count. A pair below it means no reliable comparison, not that the category has no demand.
export const MIN_TWIN_SIMILARITY = 0.4;
export const MIN_SHARED_TAGS = 10;

// Why a home/twin pair is not a usable taste twin, or null when it is. sharedCount is only
// known live; sample data has a similarity alone.
export function twinProblem(twin: { similarity: number; sharedCount?: number } | null | undefined): string | null {
  if (!twin) return "no twin search found this pair, so nothing shows the two neighbourhoods share tastes";
  if (!Number.isFinite(twin.similarity)) return "the taste similarity could not be measured";
  if (twin.sharedCount !== undefined && twin.sharedCount < MIN_SHARED_TAGS) {
    return `only ${twin.sharedCount} Qloo taste tags in common (at least ${MIN_SHARED_TAGS} needed)`;
  }
  if (twin.similarity < MIN_TWIN_SIMILARITY) {
    return `taste similarity ${Math.round(twin.similarity * 100)}% is below the ${Math.round(MIN_TWIN_SIMILARITY * 100)}% minimum`;
  }
  return null;
}

// Interest is falling when the trend changed by less than this over the period (-20%).
export const FALLING_TREND = -0.2;

export function isFalling(change: number) {
  return change < FALLING_TREND;
}

// Durability is clamp(0.5 + trend change) (score.ts), so a falling trend is a durability
// below 0.5 + FALLING_TREND (0.3). Same expression as score.ts, so the two always agree.
export function isFading(durability: number | null | undefined) {
  return durability != null && durability < 0.5 + FALLING_TREND;
}

// The rest of the city has so many of these places that the gap may be local only:
// more than 3 times home's count plus 5. Adds a doubt to the card.
export function cityMayBeLocal(cityCount: number, homeCount: number) {
  return cityCount > 3 * Math.max(homeCount, 1) + 5;
}

// More than this many across the city: the category is not scarce there, so the
// local-undersupply score is multiplied by CITY_CROWDED_FACTOR.
export const CITY_CROWDED = 20;
export const CITY_CROWDED_FACTOR = 0.6;

export function cityCrowded(cityCount: number) {
  return cityCount > CITY_CROWDED;
}
