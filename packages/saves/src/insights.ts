import { normalizeMoveName } from "./normalize.js";

/** An insight that holds a dose is dropped when it has this many content words or fewer. */
export const DOSE_ONLY_MAX_WORDS = 2;
/** An insight is dropped when at least this share of its content words is found in one move's summary. */
export const SUMMARY_OVERLAP_MIN = 0.7;

const FILLER = new Set([
  "and", "for", "this", "that", "you", "are", "from", "into", "each", "side", "per", "set", "rep", "second", "minute",
  "sec", "min", "breath", "hold", "perform", "complete", "movement", "exercise", "time", "round", "then", "also",
]);

const DOSE =
  /\b\d+\s*(x|×|sets?|reps?|rounds?|s|secs?|seconds?|mins?|minutes?|breaths?)\b|\b(x|×)\s*\d+\b/i;

/** The words that carry meaning (singular, 3+ letters, no numbers, no filler). */
function contentWords(text: string): string[] {
  return normalizeMoveName(text)
    .split(" ")
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !FILLER.has(w));
}

/**
 * Whether an insight is worth the coach's memory: guidance on when, why or how often. Not a restated dose, and not a
 * description of a move (words mostly found in one of the post's move summaries).
 */
export function keepInsight(text: string, summaries: readonly string[]): boolean {
  const words = contentWords(text);
  if (words.length === 0) return false;
  if (DOSE.test(text) && words.length <= DOSE_ONLY_MAX_WORDS) return false;
  for (const s of summaries) {
    const have = new Set(contentWords(s));
    if (words.filter((w) => have.has(w)).length / words.length >= SUMMARY_OVERLAP_MIN) return false;
  }
  return true;
}
