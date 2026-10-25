import type { InsightsResponse, QlooParams, TagsResponse, TrendingResponse } from "./types";

const AGE_LABEL: Record<string, string> = {
  "24_and_younger": "≤24",
  "25_to_29": "25–29",
  "30_to_34": "30–34",
  "35_to_44": "35–44",
  "45_and_older": "45+",
  "45_to_54": "45–54",
  "55_and_older": "55+",
};

// "Name 0.83", or just "Name" when Qloo sent no affinity (not a made-up 0.00).
function withAffinity(name: string, affinity: number | undefined): string {
  return typeof affinity === "number" && Number.isFinite(affinity) ? `${name} ${affinity.toFixed(2)}` : name;
}

const places = (n: number) => `${n} ${n === 1 ? "place" : "places"}`;

// One readable line per Qloo response, shown under the call in the agent log.
export function summarize(endpoint: string, params: QlooParams, res: InsightsResponse | TrendingResponse | TagsResponse): string {
  // Tag search: the tags it found, by name.
  if (endpoint === "/v2/tags") {
    const found = ((res as TagsResponse)?.results?.tags ?? []).filter((t) => t && typeof t.name === "string");
    if (!found.length) return "no tags found";
    return found
      .slice(0, 4)
      .map((t) => t.name)
      .join(" · ") + (found.length > 4 ? ` (+${found.length - 4} more)` : "");
  }

  const r = (res?.results ?? {}) as InsightsResponse["results"] & TrendingResponse["results"];

  if (endpoint === "/v2/trending") {
    const pts = (r.trending ?? []).map((p) => p.popularity).filter((n) => typeof n === "number");
    if (pts.length < 2) return "no trend data";
    return `${pts.length} points, ${pts[0].toFixed(2)} → ${pts[pts.length - 1].toFixed(2)}`;
  }

  if (r.tags?.length) {
    return r.tags
      .slice(0, 4)
      .map((t) => withAffinity(t.name, t.query?.affinity))
      .join(" · ");
  }

  // Live: [{ entity_id, query: { age } }], one row per signal tag, each band a lean from -1 to 1.
  // Summarised as the agent reads it by default: the rows averaged (evidence.ts asDemographics).
  if (Array.isArray(r.demographics)) {
    const rows = r.demographics
      .map((d) => (d as { query?: { age?: Record<string, number> } } | null)?.query?.age)
      .filter((a): a is Record<string, number> => !!a && typeof a === "object" && Object.keys(a).length > 0);
    if (!rows.length) return "no demographics for this signal";
    const age: Record<string, number> = {};
    for (const row of rows) for (const [k, v] of Object.entries(row)) if (typeof v === "number") age[k] = (age[k] ?? 0) + v / rows.length;
    const top = Object.entries(age).sort((a, b) => b[1] - a[1])[0];
    if (!top) return "no demographics for this signal";
    const [band, lean] = top;
    const averaged = rows.length > 1 ? `, ${rows.length} rows averaged` : "";
    return `age profile, leans ${AGE_LABEL[band] ?? band} (${lean >= 0 ? "+" : ""}${lean.toFixed(2)})${averaged}`;
  }

  if (r.demographics && typeof r.demographics === "object") {
    const age = (r.demographics as { age?: Record<string, number> }).age;
    if (age && Object.keys(age).length) {
      const [band, share] = Object.entries(age).sort((a, b) => b[1] - a[1])[0];
      return `age profile, largest band ${AGE_LABEL[band] ?? band} (${Math.round(share * 100)}%)`;
    }
    return "demographics returned";
  }

  const entities = r.entities ?? [];
  if (!entities.length) return "no results";
  const take = Number(params.take ?? 0);
  const capped = take > 0 && entities.length >= take ? ` (capped at ${take})` : "";
  const type = String(params["filter.type"] ?? "");

  if (type === "urn:entity:locality") {
    return (
      entities
        .slice(0, 3)
        .map((e) => withAffinity(e.name, e.query?.affinity))
        .join(" · ") + capped
    );
  }
  if (params["filter.tags"]) return `${places(entities.length)}${capped}`;

  const byTag = new Map<string, number>();
  for (const e of entities) for (const t of e.tags ?? []) byTag.set(t.name, (byTag.get(t.name) ?? 0) + 1);
  if (!byTag.size) return `${places(entities.length)}${capped}`;
  return (
    [...byTag.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, n]) => `${n} ${name}`)
      .join(" · ") + capped
  );
}
