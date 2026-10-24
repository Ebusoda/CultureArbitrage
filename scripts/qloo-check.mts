// One small live Qloo request, to check the key and address once the key arrives.
//   npm run qloo:check            1 call: neighbourhoods of Tokyo
//   npm run qloo:check -- --tags  plus 1 call per category tag id in categories.ts
// Reads QLOO_API_KEY and QLOO_API_URL from .env.local. Never prints the key.
import nextEnv from "@next/env";
import { categoriesFor, categoryLabel } from "../src/lib/agent/categories";
import { DEFAULT_QLOO_URL, LiveQloo, QlooError } from "../src/lib/qloo/live";

nextEnv.loadEnvConfig(process.cwd());
const key = process.env.QLOO_API_KEY?.trim();
const baseUrl = process.env.QLOO_API_URL?.trim() || DEFAULT_QLOO_URL;
if (!key) {
  console.error("QLOO_API_KEY is not set in .env.local. Add it there (never paste it into a chat), then run this again.");
  process.exit(1);
}
// The category ids are only switched to live ones in live mode.
process.env.QLOO_MODE = "live";

const qloo = new LiveQloo(key, { baseUrl, retries: 0, timeoutMs: 15_000 });
console.log(`Qloo address: ${baseUrl}`);
console.log(`Key: set (${key.length} characters)`);

async function check(label: string, fn: () => Promise<unknown>) {
  try {
    const res = (await fn()) as { results: Record<string, unknown[] | unknown> };
    const parts = Object.entries(res.results).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.length : typeof v}`);
    console.log(`OK    ${label}  (${parts.join(", ") || "empty results"})`);
    return res;
  } catch (e) {
    const kind = e instanceof QlooError ? e.kind : "error";
    console.log(`FAIL  ${label}  [${kind}] ${e instanceof Error ? e.message : String(e)}`);
    if (kind === "auth") console.log("      The key was rejected. Check it was copied fully, and ask on the Qloo Discord whether hackathon keys use a different address (QLOO_API_URL).");
    if (kind === "not_found") console.log("      Wrong address? Set QLOO_API_URL in .env.local to the one Qloo gave you.");
    return null;
  }
}

const hoods = await check("neighbourhoods of Tokyo", () =>
  qloo.insights({ "filter.type": "urn:entity:locality", "filter.location.query": "Tokyo", take: 3 }),
);
const names = ((hoods?.results.entities as { name?: string }[] | undefined) ?? []).map((e) => e.name).join(", ");
if (names) console.log(`      ${names}`);

if (process.argv.includes("--tags")) {
  for (const tag of categoriesFor("all")) {
    if (tag.startsWith("urn:tag:mock:")) {
      console.log(`SKIP  ${categoryLabel(tag)}: no real tag id yet (set liveTag in src/lib/agent/categories.ts or QLOO_CATEGORY_TAGS)`);
      continue;
    }
    await check(`places tagged ${categoryLabel(tag)} in Tokyo`, () =>
      qloo.insights({ "filter.type": "urn:entity:place", "filter.location.query": "Tokyo", "filter.tags": tag, take: 5 }),
    );
  }
}
console.log(`Qloo requests sent: ${qloo.attempts}`);
process.exit(hoods ? 0 : 1);
