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

export function isFading(card: OpportunityCard) {
  const d = card.scores.find((s) => s.key === "durability")?.value;
  return d != null && d < 0.35;
}

export function score(card: OpportunityCard, key: string) {
  return card.scores.find((s) => s.key === key);
}

export function focusLabel(focus: Focus) {
  return FOCUS_OPTIONS.find((f) => f.value === focus)?.label.toLowerCase() ?? focus;
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
  const kind = call.endpoint.includes("trending") ? "trend" : (KIND[String(p["filter.type"])] ?? String(p["filter.type"] ?? call.endpoint));
  const where = p["filter.location.query"] ? `in ${p["filter.location.query"]}` : p["signal.location.query"] ? `people in ${p["signal.location.query"]}` : "";
  const tagList = String(p["filter.tags"] ?? p["signal.interests.tags"] ?? "")
    .split(",")
    .filter(Boolean)
    .map(tagName);
  const tags = tagList.length > 2 ? `${tagList.slice(0, 2).join(", ")} +${tagList.length - 2}` : tagList.join(", ");
  return [kind, where, tags && `· ${tags}`, call.mock && "· mock"].filter(Boolean).join(" ");
}

export function requestLine(call: QlooCallLog): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(call.params)) if (v !== undefined) q.set(k, String(v));
  return `GET ${call.endpoint}?${q.toString()}`;
}

export function errorText(message: string, budget: number): string {
  const m = message.toLowerCase();
  if (m.includes("budget")) return `Used all ${budget} Qloo calls before finishing. Results so far are kept.`;
  if (m.includes("429")) return "Qloo is rate-limiting requests. Try again in a minute.";
  if (m.includes("declined")) return "Claude declined this request.";
  if (m === "network") return "Connection lost.";
  if (m === "cut off") return "The run was cut off before it finished (the server may have hit its time limit).";
  if (m.startsWith("city must be")) return message;
  return `Something went wrong: ${message}`.slice(0, 100);
}

export function firstSentence(s: string, max = 120) {
  const one = s.split(/(?<=[.!?])\s/)[0] ?? s;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function clip(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
