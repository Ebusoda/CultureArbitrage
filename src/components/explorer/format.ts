import { businessName } from "@/lib/agent/catalog";
import { isFading as fadingDurability } from "@/lib/agent/rules";

export { businessName };
import type { Focus, OpportunityCard, Phase } from "@/lib/agent/types";
import { kmBetween } from "@/lib/cities";
import type { QlooCallLog } from "@/lib/qloo/types";

export const FOCUS_OPTIONS: { value: Focus; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "dining", label: "Dining" },
  { value: "nightlife", label: "Nightlife" },
  { value: "retail", label: "Retail" },
];

export const PHASE_LABEL: Record<Phase, string> = {
  think: "Claude is thinking",
  profile: "Profile",
  twins: "Taste twins",
  compare: "Compare supply",
  doubt: "Self-check",
  score: "Score",
};

// Text colour per phase, for the dots in the log and the stepper.
export const PHASE_DOT: Record<Phase, string> = {
  think: "bg-llm",
  profile: "bg-muted",
  twins: "bg-twin",
  compare: "bg-ink",
  doubt: "bg-doubt",
  score: "bg-accent",
};

// Q-number chips: berry-tinted pills in light mode so they do not outweigh the green route, solid berry at night.
export const Q_CHIP = "bg-twin/10 text-twin ring-1 ring-inset ring-twin/40 dark:bg-twin dark:text-surface dark:ring-0";
export const Q_CHIP_HOVER = "hover:bg-twin hover:text-surface dark:hover:bg-ink";

export const pct = (x: number) => Math.round(x * 100);

export type Band = "Strong" | "Promising" | "Weak";
export function band(confidence: number): Band {
  const p = pct(confidence);
  return p >= 75 ? "Strong" : p >= 55 ? "Promising" : "Weak";
}
export const BAND_TEXT: Record<Band, string> = { Strong: "text-accent", Promising: "text-ink", Weak: "text-muted" };

export function km(a: string, b: string): string | null {
  const d = kmBetween(a, b);
  return d === null ? null : d.toLocaleString("en-US");
}

// "21" or "50+" when the count filled the whole page of results.
export const count = (n: number, capped: boolean) => (capped ? `${n}+` : String(n));

// "1 place", "2 places"; words: the plural when it is not word + "s".
export const plural = (n: number, word: string, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

// Why a finished run stopped early (the done event's stopped), as one sentence.
export function stoppedText(stopped: { reason: "budget" | "time"; unscored: number }) {
  const ran = stopped.reason === "budget" ? "the Qloo call budget ran out" : "the time limit ran out";
  return stopped.unscored > 0 ? `Stopped early: ${ran} before ${plural(stopped.unscored, "gap")} could be checked.` : `Stopped early: ${ran}.`;
}

// Places the home neighbourhood lacks, as text. A capped home count may be too low, so the
// difference is at most this; a capped twin count may be too low, so it is at least this.
export function missingText(card: OpportunityCard) {
  const m = Math.max(0, card.twinCount - card.homeCount);
  if (card.capped.home && card.capped.twin) return `about ${m}`;
  if (card.capped.home) return `up to ${m}`;
  if (card.capped.twin) return `${m}+`;
  return String(m);
}

// Same rule as the "interest is falling" doubt in score.ts (src/lib/agent/rules.ts).
export function isFading(card: OpportunityCard) {
  return fadingDurability(card.scores.find((s) => s.key === "durability")?.value);
}

export function score(card: OpportunityCard, key: string) {
  return card.scores.find((s) => s.key === key);
}

export function focusLabel(focus: Focus) {
  return FOCUS_OPTIONS.find((f) => f.value === focus)?.label.toLowerCase() ?? focus;
}

// "all categories", "dining": a focus as words in a sentence.
export function focusName(focus: Focus) {
  return focus === "all" ? "all categories" : focusLabel(focus);
}

// Longest free-text business type the search box sends (the server's MAX_QUERY_CHARS).
export const MAX_QUERY = 60;

// "a yoga studio", "an izakaya".
export function withArticle(label: string) {
  const name = businessName(label);
  return `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
}

const KIND: Record<string, string> = {
  "urn:entity:locality": "neighbourhoods",
  "urn:entity:place": "places",
  "urn:tag": "taste tags",
  "urn:demographics": "demographics",
};

const tagName = (id: string) => (id.split(":").pop() ?? id).replace(/_/g, " ");

// "Q7  places in Shimokitazawa, Tokyo" style first line of a call row.
export function callLine(call: QlooCallLog): string {
  const p = call.params;
  // Tag search: the words it looked for.
  if (call.endpoint === "/v2/tags") return ["tag search", p["filter.query"] !== undefined && `“${p["filter.query"]}”`, call.mock && "· mock"].filter(Boolean).join(" ");
  const kind = call.endpoint.includes("trending") ? "trend" : (KIND[String(p["filter.type"])] ?? String(p["filter.type"] ?? call.endpoint));
  // A call that searches around a point says where in call.where (or the display-only "_where").
  const named = call.where ?? (p._where !== undefined && p._where !== "" ? String(p._where) : undefined);
  const where = named
    ? `in ${named}`
    : p["filter.location.query"]
      ? `in ${p["filter.location.query"]}`
      : p["signal.location.query"]
        ? `people in ${p["signal.location.query"]}`
        : "";
  const tagList = String(p["filter.tags"] ?? p["signal.interests.tags"] ?? "")
    .split(",")
    .filter(Boolean)
    .map(tagName);
  const tags = tagList.length > 2 ? `${tagList.slice(0, 2).join(", ")} +${tagList.length - 2}` : tagList.join(", ");
  return [kind, where, tags && `· ${tags}`, call.mock && "· mock"].filter(Boolean).join(" ");
}

export function requestLine(call: QlooCallLog): string {
  const q = new URLSearchParams();
  // Display-only params ("_where") are never sent to Qloo, so they are not part of the request.
  for (const [k, v] of Object.entries(call.params)) if (v !== undefined && !k.startsWith("_")) q.set(k, String(v));
  return `GET ${call.endpoint}?${q.toString()}`;
}

export function errorText(raw: string, budget: number): string {
  // Never throws, whatever reached it.
  const message = typeof raw === "string" ? raw : String(raw ?? "");
  const m = message.toLowerCase().trim();
  if (m.includes("budget")) return `Used all ${budget} Qloo calls before finishing. Results so far are kept.`;
  // Only a Qloo error names Qloo; a bare HTTP 429 comes from this site's own limits.
  if (m.includes("qloo") && (m.includes("429") || m.includes("rate limit"))) return "Qloo is rate-limiting requests. Try again in a minute.";
  if (m === "http 429") return "Too many explorations right now. Try again in a few minutes.";
  if (m.includes("declined")) return "Claude declined this request.";
  if (m === "network") return "Connection lost.";
  if (m === "bad data") return "The server sent a reply the page could not read.";
  if (m === "cut off") return "The run was cut off before it finished (the server may have hit its time limit).";
  if (/^http \d+$/.test(m)) return `The server could not start the run (${message.trim()}).`;
  if (!m) return "Something went wrong.";
  // The server's own message (limits, validation, a failed lookup), as it was sent.
  return clip(message.trim(), 160);
}

export function firstSentence(s: string, max = 120) {
  const one = s.split(/(?<=[.!?])\s/)[0] ?? s;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function clip(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
