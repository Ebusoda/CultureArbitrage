import table from "../../data/tokyo-ward-ages.json";
import type { Demographics } from "./evidence";

// Age profile of the people who live in a Tokyo ward, from official resident statistics
// (see src/data/tokyo-ward-ages.json for the source and date). Qloo's demographics only
// describe fans of a taste, not residents of a place (a location signal gets a 400), so
// this fills the "people in the neighbourhood" side of the audience check for Tokyo.

interface Ward {
  ja: string;
  en: string;
  counts: Record<string, number>;
  total: number;
}

// Census bands -> the keys Qloo's demographics use, so the two can be compared band by band.
const QLOO_BAND: Record<string, string> = {
  "20_to_24": "24_and_younger",
  "25_to_29": "25_to_29",
  "30_to_34": "30_to_34",
  "35_to_44": "35_to_44",
  "45_to_54": "45_to_54",
  "55_and_older": "55_and_older",
};

// Qloo localities that are part of a ward rather than a ward themselves.
const PART_OF: Record<string, string> = {
  ginza: "Chuo",
  nihonbashi: "Chuo",
  tsukiji: "Chuo",
  roppongi: "Minato",
  azabu: "Minato",
  odaiba: "Minato",
  akihabara: "Chiyoda",
  marunouchi: "Chiyoda",
  harajuku: "Shibuya",
  ebisu: "Shibuya",
  shimokitazawa: "Setagaya",
  sangenjaya: "Setagaya",
  ikebukuro: "Toshima",
  asakusa: "Taito",
  ueno: "Taito",
  koenji: "Suginami",
  nakameguro: "Meguro",
  "naka meguro": "Meguro",
  "shin okubo": "Shinjuku",
  shinokubo: "Shinjuku",
  kabukicho: "Shinjuku",
};

// "Chūō-ku", "Shibuya-ku", "Ota", "渋谷区" -> "chuo", "shibuya", "ota", "渋谷区"
const key = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_-]*(ku|city|ward)$/, "")
    .replace(/[\s\-_]+/g, " ")
    .trim();

const wards = table.wards as Ward[];
const total = table.wards23.counts as Record<string, number>;

function shares(counts: Record<string, number>): Record<string, number> {
  const sum = Object.keys(QLOO_BAND).reduce((a, b) => a + (counts[b] ?? 0), 0);
  return Object.fromEntries(Object.keys(QLOO_BAND).map((b) => [b, sum ? (counts[b] ?? 0) / sum : 0]));
}

const base = shares(total);

export function findWard(hood: string): { ward: Ward; partOf: boolean } | null {
  const k = key(hood);
  const direct = wards.find((w) => key(w.en) === k || w.ja === hood.trim());
  if (direct) return { ward: direct, partOf: false };
  const parent = PART_OF[k];
  const w = parent ? wards.find((x) => x.en === parent) : undefined;
  return w ? { ward: w, partOf: true } : null;
}

// Each band as a lean from -1 to 1 against the 23 wards as a whole, (ward - all) / (ward + all),
// the same shape as Qloo's demographics. Adults 20 and over only, since Qloo's audiences are adults.
export function wardAudience(hood: string, city: string): Demographics | null {
  if (city !== "Tokyo") return null;
  const hit = findWard(hood);
  if (!hit) return null;
  const s = shares(hit.ward.counts);
  const age = Object.fromEntries(
    Object.entries(QLOO_BAND).map(([b, q]) => [q, s[b] + base[b] ? round2((s[b] - base[b]) / (s[b] + base[b])) : 0]),
  );
  const where = hit.partOf ? `${hit.ward.en} ward, which contains ${hood}` : `${hit.ward.en} ward`;
  return { age, basis: `residents of ${where} (${table.source.publisher}, ${table.source.asOf})` };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
