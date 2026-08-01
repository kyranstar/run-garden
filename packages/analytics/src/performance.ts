import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";

/** Performance estimates. All gentle/rough — framed as estimates, never targets. */

/** Riegel race-time prediction from your fastest recent run (3 km+): the classic
 * t2 = t1 * (d2/d1)^1.06. */
export function predictRaces(
  bestRun: { distanceMeters: number; durationSeconds: number } | null,
): MetricResult<{ k5: number; k10: number; half: number }> {
  if (!bestRun || bestRun.distanceMeters < 3000 || bestRun.durationSeconds <= 0) {
    return insufficient(1, bestRun ? 1 : 0, "Race predictions need a recent run of at least 3 km.");
  }
  const riegel = (d2: number) =>
    Math.round(bestRun.durationSeconds * Math.pow(d2 / bestRun.distanceMeters, 1.06));
  return ok(
    { k5: riegel(5000), k10: riegel(10000), half: riegel(21097) },
    1,
    "A Riegel estimate scaled from your fastest recent run of 3 km or longer.",
  );
}

/** How often you finish faster than you start — a durability/pacing signal.
 * Pace is seconds per km (lower = faster). */
export function negativeSplit(
  runs: ReadonlyArray<{ firstHalfPace: number; secondHalfPace: number }>,
): MetricResult<{ negativePct: number }> {
  const valid = runs.filter((r) => r.firstHalfPace > 0 && r.secondHalfPace > 0);
  if (valid.length < 4) {
    return insufficient(4, valid.length, "Split tendency needs at least 4 runs with lap data.");
  }
  const neg = valid.filter((r) => r.secondHalfPace < r.firstHalfPace).length;
  return ok(
    { negativePct: Math.round((neg / valid.length) * 100) },
    valid.length,
    "Share of runs where your second half was faster than your first.",
  );
}
