import type { InsightsResponse, QlooParams, TrendingResponse } from "./types";

const AGE_LABEL: Record<string, string> = {
  "24_and_younger": "≤24",
  "25_to_29": "25–29",
  "30_to_34": "30–34",
  "35_to_44": "35–44",
  "45_and_older": "45+",
  "45_to_54": "45–54",
  "55_and_older": "55+",
};

// One readable line per Qloo response, shown under the call in the agent log.
export function summarize(endpoint: string, params: QlooParams, res: InsightsResponse | TrendingResponse): string {
  const r = (res?.results ?? {}) as InsightsResponse["results"] & TrendingResponse["results"];

  if (endpoint === "/v2/trending") {
    const pts = (r.trending ?? []).map((p) => p.popularity).filter((n) => typeof n === "number");
    if (pts.length < 2) return "no trend data";
    return `${pts.length} points, ${pts[0].toFixed(2)} → ${pts[pts.length - 1].toFixed(2)}`;
  }

  if (r.tags?.length) {
    return r.tags
      .slice(0, 4)
      .map((t) => `${t.name} ${(t.query?.affinity ?? 0).toFixed(2)}`)
      .join(" · ");
  }

  // Live: [{ entity_id, query: { age } }], each band a lean from -1 to 1.
  if (Array.isArray(r.demographics)) {
    const age = (r.demographics[0] as { query?: { age?: Record<string, number> } } | undefined)?.query?.age;
    if (!age || !Object.keys(age).length) return "no demographics for this signal";
    const [band, lean] = Object.entries(age).sort((a, b) => b[1] - a[1])[0];
    return `age profile, leans ${AGE_LABEL[band] ?? band} (${lean >= 0 ? "+" : ""}${lean.toFixed(2)})`;
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
        .map((e) => `${e.name} ${(e.query?.affinity ?? 0).toFixed(2)}`)
        .join(" · ") + capped
    );
  }
  if (params["filter.tags"]) return `${entities.length} places${capped}`;

  const byTag = new Map<string, number>();
  for (const e of entities) for (const t of e.tags ?? []) byTag.set(t.name, (byTag.get(t.name) ?? 0) + 1);
  if (!byTag.size) return `${entities.length} places${capped}`;
  return (
    [...byTag.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, n]) => `${n} ${name}`)
      .join(" · ") + capped
  );
}
