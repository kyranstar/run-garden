/**
 * MEMORY V2, IN WORDS (Stage 3 Task 10; spec §9; principles §6.7): what the Settings list says about each item — its
 * kind, how sure it is, where it came from — and the history a newer item superseded, never an id.
 */
import type { CoachMemoryItem } from "@rg/api-client";
import { formatShortDate } from "../../components.js";

export type MemoryKind = CoachMemoryItem["kind"];

/** The list's groups, in order: the three it always had, then what the coach noticed. */
export const MEMORY_GROUPS: ReadonlyArray<{ kind: MemoryKind; label: string }> = [
  { kind: "fact", label: "About you" },
  { kind: "rule", label: "Rules & preferences" },
  { kind: "note", label: "Notes (time-boxed)" },
  { kind: "observation", label: "Things the coach noticed" },
];

const KIND_WORDS: Record<MemoryKind, string> = {
  fact: "Fact",
  rule: "Rule",
  note: "Note",
  observation: "Something the coach noticed",
};

/** "Fact", "Rule", "Note (until Oct 26)", "Something the coach noticed". */
export function kindWords(item: Pick<CoachMemoryItem, "kind" | "expiresAt">): string {
  const words = KIND_WORDS[item.kind] ?? "Note";
  return item.kind === "note" && item.expiresAt ? `${words} (until ${formatShortDate(item.expiresAt.slice(0, 10))})` : words;
}

const CONFIDENCE_WORDS: Record<NonNullable<CoachMemoryItem["confidence"]>, string> = {
  stated: "You said",
  inferred: "The coach inferred",
  confirmed: "Confirmed",
};

/** "You said", "The coach inferred", "Confirmed" (an item from before memory v2 is what the athlete said). */
export function confidenceWords(item: Pick<CoachMemoryItem, "confidence">): string {
  return CONFIDENCE_WORDS[item.confidence ?? "stated"] ?? CONFIDENCE_WORDS.stated;
}

const SOURCE_WORDS: Record<string, string> = {
  message: "From your message",
  question: "From your answer to a question",
  manual: "From a check-in",
  open: "From your recent training",
  athlete_words: "From your request to the coach",
  // A request, never the coach's "run" (fix wave 3B, B-I12).
  coach_inference: "From a coach request",
  studio_brief: "From the old Studio's brief",
};

/** Where it came from, in a few words, and when: "From your message, Oct 3". Never an id. */
export function provenanceWords(item: Pick<CoachMemoryItem, "provenance" | "learnedAt">): string {
  const from = SOURCE_WORDS[item.provenance?.source] ?? "From the coach";
  const day = (item.learnedAt ?? item.provenance?.at ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${from}, ${formatShortDate(day)}` : from;
}

/** The item's line under its words: "Rule · You said · From your message, Oct 3 · Pinned". */
export function metaLine(item: CoachMemoryItem): string {
  return [kindWords(item), confidenceWords(item), provenanceWords(item), ...(item.pinned ? ["Pinned"] : [])].join(" · ");
}

/** Versions a history may hold, at most: a loop in stored data never runs away. */
export const HISTORY_MAX = 20;

/**
 * The versions an item replaced, newest first: those it superseded, then those they superseded, and so on — at most
 * HISTORY_MAX, each once.
 */
export function historyOf(id: string, history: readonly CoachMemoryItem[]): CoachMemoryItem[] {
  const out: CoachMemoryItem[] = [];
  const seen = new Set<string>([id]);
  let wave = [id];
  while (wave.length > 0 && out.length < HISTORY_MAX) {
    const next = history
      .filter((h) => h.supersededBy && wave.includes(h.supersededBy) && !seen.has(h.id))
      .sort((a, b) => b.learnedAt.localeCompare(a.learnedAt));
    for (const h of next) {
      if (out.length >= HISTORY_MAX) break;
      seen.add(h.id);
      out.push(h);
    }
    wave = next.map((h) => h.id);
  }
  return out;
}

/** A group's items: pinned first, then newest. */
export function groupItems(items: readonly CoachMemoryItem[], kind: MemoryKind): CoachMemoryItem[] {
  return items
    .filter((m) => m.kind === kind)
    .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.learnedAt.localeCompare(a.learnedAt));
}

/** The words for a pin past the cap: the server's own, else the same. */
export const PIN_CAP_LINE = "You can pin up to 12. Unpin one first.";

/** What the list is, said once at its top (fix wave 3B, M9). */
export const MEMORY_CAPTION = "Everything the coach remembers about you — from your messages, answers and requests. Edit or delete any of it.";

/** Delete asks first, inline, on the item (M9): deleting is for good. */
export const DELETE_ASK = "Delete for good?";
