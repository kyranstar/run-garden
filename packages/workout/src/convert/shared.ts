/**
 * What every converter shares: the `kept` ledger, bounded text, loads as typed plus kg, and the open block a session
 * with no named movements becomes.
 *
 * LOSSLESS (principles §3.2): a converter never drops what its source carried. A field the document has no place
 * for — or a value outside the document's bounds — goes to `kept`, one entry per field, saying where it came from and
 * why the document cannot hold it. A clipped text keeps its whole original in `kept`.
 */
import { formatWeight, parseWeight, toKg, type Weight, type WorkoutDose, type WorkoutItem } from "@rg/domain";

/** Something a source carried that the document cannot say, kept beside it. */
export interface KeptEntry {
  /** Where in the source: "stage 7", "exercise 2", "block 4", "session". */
  at: string;
  /** The source's own field name. */
  field: string;
  value: unknown;
  /** Why the document does not hold it. */
  why: string;
}

/** A converter's result: the document, and what it could not hold. */
export interface Converted<D> {
  doc: D;
  kept: KeptEntry[];
}

/** The kilograms of a load, to two decimals (the document's canonical value beside what was typed). */
export const kg2 = (kg: number): number => Math.round(kg * 100) / 100;

/** A number as a short string: at most two decimals, no trailing zeros. */
export const trimNumber = (n: number): string => String(Number(n.toFixed(2)));

/** `text` cut to `max` characters, the original kept when cut. */
export function bounded(text: string, max: number, kept: KeptEntry[], at: string, field: string): string {
  const t = text.trim();
  if (t.length <= max) return t;
  kept.push({ at, field, value: text, why: `longer than the document's ${max} characters` });
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/** `n` within the document's [min, max]; a value outside is clamped and the original kept. */
export function within(n: number, min: number, max: number, kept: KeptEntry[], at: string, field: string, what: string): number {
  if (n >= min && n <= max) return n;
  kept.push({ at, field, value: n, why: `outside the document's ${min}–${max} ${what}` });
  return Math.min(max, Math.max(min, n));
}

/** A load in kilograms, typed as kilograms. */
export function loadOfKg(kg: number): Exclude<WorkoutDose["load"], undefined | "bodyweight"> {
  return { typed: `${trimNumber(kg)} kg`, kg: kg2(kg) };
}

/** A load from a weight as typed or suggested ({ v, u }), with its kilograms. */
export function loadOfWeight(w: Weight): Exclude<WorkoutDose["load"], undefined | "bodyweight"> {
  return { typed: formatWeight(w), kg: kg2(toKg(w)) };
}

/** The weight a load was typed as ("25 lb" → { v: 25, u: "lb" }); null for bodyweight or a typed text no unit reads. */
export function weightOfLoad(load: WorkoutDose["load"]): Weight | null {
  if (load === undefined || load === "bodyweight") return null;
  return parseWeight(load.typed, "kg");
}

/** The document's ceiling on a load. */
export const MAX_LOAD_KG = 500;
/** The document's ceiling on a typed load's text. */
export const MAX_TYPED = 20;

/**
 * A block with no named movements ("strength Friday, we'll pick on the day"): one open free-text item of the
 * session's length, so the document still says what kind of time it is. Over an hour it is split into equal sets.
 */
export function openBlock(name: string, seconds: number): WorkoutItem {
  const sets = Math.max(1, Math.ceil(seconds / 3600));
  const holdSec = Math.max(1, Math.round(seconds / sets));
  return { kind: "free_exercise", name, dose: sets > 1 ? { sets, holdSec } : { holdSec } };
}

/** The open block's name when a source names no movements. */
export const OPEN_BLOCK_NAME = "Your choice of movements";

/** "each side", "per side", "/side" — how a note says the work is per side (the push path writes "each side"). */
export const PER_SIDE_WORDS = /\b(?:each|per) side\b|\/side\b/i;
/** "4s down", "3 s down" — how a note says the lowering is slow (the push path writes "<n>s down"). */
export const ECCENTRIC_WORDS = /(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\s+down\b/i;
