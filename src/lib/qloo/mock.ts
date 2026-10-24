import {
  CATEGORY_DEMOGRAPHICS,
  CATEGORY_TAGS,
  CATEGORY_TRENDS,
  LOCALITIES,
  LOCALITY_DEMOGRAPHICS,
  TASTE_TAGS,
  type MockLocality,
} from "./mock-data";
import type { InsightsResponse, QlooClient, QlooEntity, QlooParams, TrendingResponse } from "./types";

// Answers the same /v2/insights requests the live client sends, from mock-data.ts,
// in the same response shape. Only the parameter combinations the agent uses are
// supported; anything else returns an empty result, like the real API often does.
export class MockQloo implements QlooClient {
  readonly mode = "mock" as const;
  attempts = 0;

  constructor(private readonly delayMs = 250) {}

  async insights(params: QlooParams): Promise<InsightsResponse> {
    this.attempts++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    const type = String(params["filter.type"] ?? "");
    const take = Number(params.take ?? 10);
    const filterLoc = str(params["filter.location.query"]);
    const signalLoc = str(params["signal.location.query"]);
    const signalTags = list(params["signal.interests.tags"]);
    const filterTags = list(params["filter.tags"]);

    if (type === "urn:entity:locality") {
      const scored = LOCALITIES.filter((l) => !filterLoc || matches(l, filterLoc)).map((l) => ({
        l,
        affinity: signalTags.length ? overlap(l.taste, signalTags) : popularity(l),
      }));
      scored.sort((a, b) => b.affinity - a.affinity);
      return {
        results: {
          entities: scored.slice(0, take).map(({ l, affinity }) => localityEntity(l, affinity)),
        },
      };
    }

    if (type === "urn:tag") {
      const loc = LOCALITIES.find((l) => signalLoc && matches(l, signalLoc));
      if (!loc) return { results: { tags: [] } };
      const tags = Object.entries(loc.taste)
        .sort((a, b) => b[1] - a[1])
        .slice(0, take)
        .map(([id, affinity]) => ({ tag_id: id, name: TASTE_TAGS[id] ?? id, query: { affinity } }));
      return { results: { tags } };
    }

    if (type === "urn:entity:place") {
      const locs = LOCALITIES.filter((l) => filterLoc && matches(l, filterLoc));
      const entities: QlooEntity[] = [];
      for (const loc of locs) {
        for (const [cat, n] of Object.entries(loc.supply)) {
          if (filterTags.length && !filterTags.includes(cat)) continue;
          for (let i = 1; i <= n; i++) entities.push(placeEntity(loc, cat, i));
        }
      }
      return { results: { entities: entities.slice(0, take) } };
    }

    if (type === "urn:demographics") {
      if (signalTags.length) return { results: { demographics: CATEGORY_DEMOGRAPHICS[signalTags[0]] ?? null } };
      const loc = LOCALITIES.find((l) => signalLoc && matches(l, signalLoc));
      return { results: { demographics: loc ? LOCALITY_DEMOGRAPHICS[loc.name] ?? null : null } };
    }

    return { results: { entities: [] } };
  }

  // Trend of the category the first signal entity belongs to (mock place ids encode it).
  async trending(params: QlooParams): Promise<TrendingResponse> {
    this.attempts++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    const entity = list(params["signal.interests.entities"])[0] ?? "";
    const cat = `urn:tag:mock:place:${entity.split(":").at(-2) ?? ""}`;
    const values = CATEGORY_TRENDS[cat] ?? [];
    return {
      results: {
        trending: values.map((popularity, i) => ({ date: monthsAgo(values.length - 1 - i), popularity })),
      },
    };
  }
}

function monthsAgo(n: number) {
  const d = new Date(Date.UTC(2026, 9, 1));
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}
function str(v: unknown) {
  return v === undefined ? "" : String(v);
}
function list(v: unknown) {
  return v ? String(v).split(",").filter(Boolean) : [];
}
// "Shimokitazawa, Tokyo" matches the locality; "Tokyo" matches every Tokyo locality.
function matches(l: MockLocality, query: string) {
  const q = query.toLowerCase();
  return q.includes(l.name.toLowerCase()) || q.trim() === l.city.toLowerCase();
}
function overlap(taste: Record<string, number>, tags: string[]) {
  return tags.reduce((sum, t) => sum + (taste[t] ?? 0), 0) / tags.length;
}
function popularity(l: MockLocality) {
  return Object.values(l.supply).reduce((a, b) => a + b, 0) / 60;
}
function localityEntity(l: MockLocality, affinity: number): QlooEntity {
  return {
    entity_id: l.id,
    name: l.name,
    type: "urn:entity",
    subtype: "urn:entity:locality",
    popularity: Math.min(1, popularity(l)),
    query: { affinity: round(affinity) },
    properties: { geocode: { latitude: l.lat, longitude: l.lng, name: `${l.name}, ${l.city}` } },
  };
}
function placeEntity(l: MockLocality, cat: string, i: number): QlooEntity {
  const label = CATEGORY_TAGS[cat] ?? cat;
  return {
    entity_id: `urn:entity:place:mock:${l.id.split(":").pop()}:${cat.split(":").pop()}:${i}`,
    name: `${label} ${l.name} #${i}`,
    type: "urn:entity",
    subtype: "urn:entity:place",
    tags: [{ id: cat, name: label }],
    properties: { address: `${l.name}, ${l.city}` },
  };
}
function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
