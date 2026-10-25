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
