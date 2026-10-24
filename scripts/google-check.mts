// One Google Maps search with the key in .env.local, to check the key works.
//   npm run google:check
// Asks only for place ids (Google's free "Text Search Essentials (IDs Only)" tier), at most 3 pages.
// Never prints the key.
import nextEnv from "@next/env";
import { boxAround, GooglePlaces, GooglePlacesError } from "../src/lib/google/places";

nextEnv.loadEnvConfig(process.cwd());
const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
if (!key) {
  console.error("GOOGLE_MAPS_API_KEY is not set in .env.local. Add it there (never paste it into a chat), then run this again.");
  process.exit(1);
}
console.log(`Key: set (${key.length} characters)`);

const google = new GooglePlaces(key, { maxRequests: 3, timeoutMs: 15_000 });
try {
  // Around Shibuya Station.
  const r = await google.count({ textQuery: "ベーグル", includedType: "bagel_shop", strict: true, languageCode: "ja", regionCode: "JP" }, boxAround(35.658, 139.7016, 1.5));
  console.log(`OK    bagel shops in a 3 km square around Shibuya: ${r.count}${r.saturated ? "+" : ""}`);
} catch (e) {
  console.log(`FAIL  ${e instanceof Error ? e.message : String(e)}`);
  if (e instanceof GooglePlacesError && e.fatal) console.log("      Check that the key was copied fully and that Places API (New) is enabled in the same project.");
  process.exitCode = 1;
}
console.log(`Google requests sent: ${google.requests}`);
