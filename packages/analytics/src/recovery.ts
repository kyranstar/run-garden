import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { median } from "./stats.js";

/** Recovery/readiness metrics from COROS daily health. Rows may arrive in any
 * order; each function sorts newest-first internally. */

const DAY = 86_400_000;

export function computeRestingHr(
  rows: ReadonlyArray<{ date: string; restingHeartRate: number | null }>,
): MetricResult<{ latest: number; baseline: number; deltaBpm: number }> {
  const vals = rows
    .filter((r): r is { date: string; restingHeartRate: number } => r.restingHeartRate != null && r.restingHeartRate > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (vals.length < 7) {
    return insufficient(7, vals.length, "Resting heart-rate trend needs at least 7 days of COROS readings.");
  }
  const latest = vals[0]!.restingHeartRate;
  const baseline = Math.round(median(vals.slice(0, 30).map((r) => r.restingHeartRate)));
  return ok(
    { latest, baseline, deltaBpm: latest - baseline },
    vals.length,
    "Your most recent resting heart rate versus your 30-day median.",
  );
}

export function computeHrvTrend(
  rows: ReadonlyArray<{ date: string; hrv: number | null }>,
): MetricResult<{ latest: number; baseline: number; pctVsBaseline: number }> {
  const vals = rows
    .filter((r): r is { date: string; hrv: number } => r.hrv != null && r.hrv > 0)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (vals.length < 7) {
    return insufficient(7, vals.length, "HRV trend needs at least 7 days of COROS readings.");
  }
  const recent = median(vals.slice(0, 7).map((r) => r.hrv));
  const baseline = median(vals.slice(0, 30).map((r) => r.hrv));
  const pct = baseline > 0 ? Math.round(((recent - baseline) / baseline) * 100) : 0;
  return ok(
    { latest: Math.round(recent), baseline: Math.round(baseline), pctVsBaseline: pct },
    vals.length,
    "Your 7-day median HRV versus your 30-day baseline.",
  );
}

/** Consecutive days up to `today` that had a quality/race effort. 0 is a valid
 * answer (not suppressed). */
export function computeHardDayStacking(
  hardDates: readonly string[],
  today: string,
): MetricResult<{ consecutive: number }> {
  const set = new Set(hardDates);
  let consecutive = 0;
  let cursor = today;
  while (set.has(cursor)) {
    consecutive += 1;
    cursor = new Date(Date.parse(cursor) - DAY).toISOString().slice(0, 10);
  }
  return ok(
    { consecutive },
    hardDates.length,
    "Consecutive days up to today with a quality or race effort.",
  );
}
