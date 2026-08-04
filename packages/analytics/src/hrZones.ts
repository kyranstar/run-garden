/**
 * Heart-rate zones estimated from observed data (no age/lab input). Max HR is
 * the second-highest recorded max-heart-rate reading across activities: a
 * single spike (a device glitch, a sprint for the bus) shouldn't set the
 * ceiling, so we require two activities to agree near the top. Readings
 * ≤120bpm are ignored as implausible "max" values (e.g. a walk's peak).
 * With fewer than two qualifying readings, the estimate is unknown — the
 * caller decides what to do; there is no scaled-average fallback. Zones are
 * %HRmax: Z1 <68, Z2 68–79, Z3 80–87, Z4 88–94, Z5 95%+.
 */

/**
 * Only the one field the estimate reads. Deliberately narrower than
 * `NormalizedActivity` (which still satisfies it) so a caller can pass a
 * column projection: estimating the ceiling over a 26-week history has no
 * business loading 26 weeks of full activity rows to look at one number.
 * `null` is accepted alongside `undefined` because that is what a SQL row
 * carries.
 */
export interface HrMaxSample {
  maxHeartRate?: number | null;
}

/** A "max" at or below this is implausible (a walk's peak, a dropped strap). */
export const MIN_PLAUSIBLE_HR_MAX = 120;

/**
 * The readings `estimateHrMax` actually consumes, highest first. Exported so a
 * caller that wants to say how much evidence the estimate rests on counts the
 * same readings the estimate used — counting "runs with any heart rate" instead
 * would let a pile of average-only runs suppress the caveat while the ceiling
 * still balanced on two max readings, which overstates confidence in one
 * direction only.
 */
export function usableHrMaxReadings(activities: readonly HrMaxSample[]): number[] {
  return activities
    .map((a) => a.maxHeartRate)
    .filter((h): h is number => h != null && h > MIN_PLAUSIBLE_HR_MAX)
    .sort((a, b) => b - a);
}

export function estimateHrMax(activities: readonly HrMaxSample[]): number | null {
  const maxes = usableHrMaxReadings(activities);
  if (maxes.length === 0) return null;
  return maxes.length === 1 ? maxes[0]! : maxes[1]!;
}

const UPPER = [0.68, 0.8, 0.88, 0.95]; // upper bounds of Z1..Z4 as fraction of HRmax

/** The bpm ceiling of Zone 2 — an easy run's average HR should stay under it. */
export function easyCeiling(hrMax: number): number {
  return Math.round(UPPER[1]! * hrMax);
}

export function zoneOf(hr: number, hrMax: number): 1 | 2 | 3 | 4 | 5 {
  if (hrMax <= 0) return 1;
  const frac = hr / hrMax;
  if (frac < UPPER[0]!) return 1;
  if (frac < UPPER[1]!) return 2;
  if (frac < UPPER[2]!) return 3;
  if (frac < UPPER[3]!) return 4;
  return 5;
}

/**
 * Shared "was this easy?" predicate: at or under the Zone-2 ceiling. Defined
 * against `easyCeiling`'s rounded integer bpm value (not `zoneOf`'s raw
 * fraction) so it always agrees with the ceiling the drill-down UI displays
 * ("under your N bpm ceiling") — `zoneOf(easyCeiling(hrMax), hrMax) <= 2`
 * disagrees with the rounded ceiling for most hrMax values, since rounding
 * can push the integer ceiling to the far side of the 0.8 fraction boundary.
 */
export function isEasyHr(avgHr: number, hrMax: number): boolean {
  return avgHr <= easyCeiling(hrMax);
}
