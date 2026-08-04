import type { NormalizedActivity } from "@rg/domain";

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

export function estimateHrMax(activities: readonly NormalizedActivity[]): number | null {
  const maxes = activities
    .map((a) => a.maxHeartRate)
    .filter((h): h is number => h != null && h > 120)
    .sort((a, b) => b - a);
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

/** Shared "was this easy?" predicate: average HR sat in zones 1–2. */
export function isEasyHr(avgHr: number, hrMax: number): boolean {
  return zoneOf(avgHr, hrMax) <= 2;
}
