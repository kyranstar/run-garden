import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { median } from "./stats.js";

/** Performance estimates. All gentle/rough — framed as estimates, never targets. */

export interface PacingValue {
  /** secondHalfPace - firstHalfPace, median across runs, seconds per km. Positive = fade. */
  medianDeltaSecPerKm: number;
  negativePct: number;
}

/** Pacing tendency across a run — how the second half compares to the first.
 * Pace is seconds per km (lower = faster). */
export function computePacing(
  runs: ReadonlyArray<{ firstHalfPace: number; secondHalfPace: number }>,
): MetricResult<PacingValue> {
  const valid = runs.filter((r) => r.firstHalfPace > 0 && r.secondHalfPace > 0);
  if (valid.length < 4) {
    return insufficient(4, valid.length, "Pacing needs at least 4 runs with lap data.");
  }
  const deltas = valid.map((r) => r.secondHalfPace - r.firstHalfPace);
  const neg = valid.filter((r) => r.secondHalfPace < r.firstHalfPace).length;
  return ok(
    {
      medianDeltaSecPerKm: median(deltas),
      negativePct: Math.round((neg / valid.length) * 100),
    },
    valid.length,
    "Typical shift in pace from the first half of a run to the second; negative means you sped up.",
  );
}
