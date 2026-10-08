/**
 * THE LIBRARY ↔ COROS MAPPING, BY T-CODE (Phase 3 Task 2; spec
 * 2026-09-30-phase-3-watch-design.md §2; ruling 3-R1).
 *
 * Identity on COROS is the catalog's T-code ("T1041"): `coros_exercises.name`
 * carries it, and so does a strength lap's `exerciseNameKey`. The athlete's
 * catalog id (`originId`) is per account and is resolved only at send time.
 *
 * Two tiers, one answer per library move:
 *  - CURATED: a human wrote `providers.coros` on a lift. It is authoritative.
 *    `exact` is the key the watch gets; `close` and `generic` stay on record
 *    and the move goes to the watch as free text (spike outcome A makes a
 *    doubtful catalog step worse than none: it would show another movement's
 *    name and animation).
 *  - COMPUTED: every record no one curated gets the unique strength-catalog
 *    T-code whose English name (`COROS_EXERCISE_NAMES`) normalizes
 *    (`normalizeExerciseKey`) to the record's name. Two T-codes with that
 *    name, or none, means no mapping. Exact name only: no fuzzy match.
 *
 * Pure and deterministic, from public data only (the catalog's T-codes and
 * COROS's own English locale) — no D1 read anywhere in here.
 */
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { normalizeExerciseKey } from "./exercise-catalog.js";

/** The generic catalog steps (Warm Up, Training, Cool Down, Rest): never a movement's mapping. */
export const GENERIC_COROS_KEYS: ReadonlySet<string> = new Set(["T1120", "T1121", "T1122", "T1123"]);

/**
 * The strength catalog's key shape. The locale bundle also names run-workout
 * segments (T3xxx, "Run", "Rest"), coaches (T09xx) and other surfaces; none of
 * them is a strength exercise.
 */
const STRENGTH_KEY = /^T1\d{3}$/;

/** normalized English name → its unique strength T-code, or null when two T-codes share it. */
let keyByName: Map<string, string | null> | null = null;

function keysByName(): Map<string, string | null> {
  if (keyByName) return keyByName;
  const out = new Map<string, string | null>();
  for (const [key, english] of Object.entries(COROS_EXERCISE_NAMES)) {
    if (!STRENGTH_KEY.test(key) || GENERIC_COROS_KEYS.has(key)) continue;
    const name = normalizeExerciseKey(english);
    if (!name) continue;
    out.set(name, out.has(name) ? null : key);
  }
  return (keyByName = out);
}

/** The unique T-code whose English name normalizes to the record's name; null for none or several. */
export function computedCorosKey(record: Pick<ExerciseRecord, "name">): string | null {
  const name = normalizeExerciseKey(record.name ?? "");
  return name ? (keysByName().get(name) ?? null) : null;
}

/** A record's key: its curated mapping when it has one (`exact` only), else the computed key. */
function keyOfRecord(record: ExerciseRecord): string | null {
  const curated = record.providers?.coros;
  if (curated) return curated.confidence === "exact" ? curated.key : null;
  return computedCorosKey(record);
}

let shippedById: Map<string, ExerciseRecord> | null = null;

/** The key the watch gets for a library move: a curated `exact` mapping, else the computed one, else null. */
export function corosKeyOf(exerciseId: string, library?: readonly ExerciseRecord[]): string | null {
  const record = library
    ? library.find((e) => e.id === exerciseId)
    : (shippedById ??= new Map(EXERCISES.map((e) => [e.id, e]))).get(exerciseId);
  return record ? keyOfRecord(record) : null;
}

function reverse(library: readonly ExerciseRecord[]): Map<string, string> {
  const claims = new Map<string, string[]>();
  for (const e of library) {
    const key = keyOfRecord(e);
    if (key) claims.set(key, [...(claims.get(key) ?? []), e.id]);
  }
  const out = new Map<string, string>();
  for (const [key, ids] of claims) if (ids.length === 1) out.set(key, ids[0]!);
  return out;
}

let shippedReverse: Map<string, string> | null = null;

/** T-code → library id for every key `corosKeyOf` yields; a key two records yield maps to neither. */
export function libraryIdsByKey(library?: readonly ExerciseRecord[]): Map<string, string> {
  return library ? reverse(library) : (shippedReverse ??= reverse(EXERCISES));
}
