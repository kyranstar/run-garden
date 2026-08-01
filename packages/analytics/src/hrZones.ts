import type { NormalizedActivity } from "@rg/domain";

/**
 * Heart-rate zones estimated from observed data (no age/lab input). Max HR is
 * the highest recorded max, else the highest average HR scaled up ~5%. Zones
 * are %HRmax: Z1 <68, Z2 68–79, Z3 80–87, Z4 88–94, Z5 95%+.
 */

export function estimateHrMax(activities: readonly NormalizedActivity[]): number | null {
  let maxObserved = 0;
  let maxAvg = 0;
  for (const a of activities) {
    if (a.maxHeartRate && a.maxHeartRate > maxObserved) maxObserved = a.maxHeartRate;
    if (a.avgHeartRate && a.avgHeartRate > maxAvg) maxAvg = a.avgHeartRate;
  }
  if (maxObserved > 0) return maxObserved;
  if (maxAvg > 0) return Math.round(maxAvg * 1.05);
  return null;
}

const UPPER = [0.68, 0.8, 0.88, 0.95]; // upper bounds of Z1..Z4 as fraction of HRmax

export function zoneOf(hr: number, hrMax: number): 1 | 2 | 3 | 4 | 5 {
  if (hrMax <= 0) return 1;
  const frac = hr / hrMax;
  if (frac < UPPER[0]!) return 1;
  if (frac < UPPER[1]!) return 2;
  if (frac < UPPER[2]!) return 3;
  if (frac < UPPER[3]!) return 4;
  return 5;
}
