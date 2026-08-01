import type { NormalizedActivity } from "@rg/domain";

/** Pure deterministic math helpers shared by the analytics modules. */

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function populationStdDev(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let sq = 0;
  for (const x of xs) sq += (x - m) * (x - m);
  return Math.sqrt(sq / xs.length);
}

/** Time-weighted mean; entries with weight <= 0 are ignored. */
export function weightedMean(entries: ReadonlyArray<{ value: number; weight: number }>): number {
  let sum = 0;
  let total = 0;
  for (const e of entries) {
    if (e.weight <= 0) continue;
    sum += e.value * e.weight;
    total += e.weight;
  }
  return total > 0 ? sum / total : 0;
}

/** Least-squares fit of ys against x = 0..n-1. */
export function leastSquares(ys: readonly number[]): { slope: number; intercept: number } {
  const n = ys.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0]! };
  const xBar = (n - 1) / 2;
  const yBar = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xBar) * (ys[i]! - yBar);
    den += (i - xBar) * (i - xBar);
  }
  const slope = den > 0 ? num / den : 0;
  return { slope, intercept: yBar - slope * xBar };
}

export function roundTo(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

/** Calendar date ("YYYY-MM-DD") of an activity, preferring local wall-clock time. */
export function activityLocalDate(
  a: Pick<NormalizedActivity, "startTime" | "startTimeLocal">,
): string {
  return (a.startTimeLocal ?? a.startTime).slice(0, 10);
}

/** Small deterministic string hash (djb2 xor variant), hex-encoded. */
export function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
