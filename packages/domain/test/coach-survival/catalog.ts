/**
 * The athlete's synced COROS strength catalog, as a fixture.
 *
 * Shape and CONTENTS are the live ones: `coros_exercises` holds 382 rows whose
 * `name` column is an i18n key, and the live set is exactly T1001–T1397 minus
 * fifteen gaps (read once from prod, 2026-08-17, `SELECT name FROM
 * coros_exercises` — a global reference table, no personal data in it). Ids are
 * synthesized because only their identity matters to the resolver.
 *
 * Reconstructing it from the range rather than pasting 382 strings keeps the
 * fixture honest AND small: if COROS's catalog grows, the gap list is the only
 * thing that goes stale, and `catalogSize()` says so.
 */
import { COROS_EXERCISE_NAMES } from "../../../providers/src/coros/exercise-names.js";

/** T-codes inside the range that the live catalog does NOT carry. */
const GAPS = new Set([1003, 1008, 1012, 1062, 1102, 1111, 1118, 1119, 1124, 1125, 1140, 1172, 1208, 1209, 1210]);

export function liveExerciseCatalog(): Map<string, string> {
  const cat = new Map<string, string>();
  for (let n = 1001; n <= 1397; n++) {
    if (GAPS.has(n)) continue;
    cat.set(`4258276155475${String(n).padStart(6, "0")}`, `T${n}`);
  }
  return cat;
}

/** English name of a catalog code, for readable diagnostics. */
export function englishName(code: string): string {
  return COROS_EXERCISE_NAMES[code] ?? code;
}
