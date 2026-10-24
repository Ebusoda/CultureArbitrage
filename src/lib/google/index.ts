import { config } from "../config";
import { qlooMode } from "../qloo";
import { GooglePlaces } from "./places";

export * from "./places";

// The Google Maps cross-check runs only with a key, and only on live Qloo data: checking
// mock neighbourhoods against real Google Maps listings would compare made-up with real.
export function googleEnabled(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY?.trim() && qlooMode() === "live";
}

export function createGooglePlaces(signal?: AbortSignal): GooglePlaces | null {
  if (!googleEnabled()) return null;
  return new GooglePlaces(process.env.GOOGLE_MAPS_API_KEY!.trim(), {
    maxRequests: config.googleCallBudget(),
    dailyLimit: config.googleDailyLimit(),
    timeoutMs: config.qlooTimeoutMs(),
    signal,
  });
}
