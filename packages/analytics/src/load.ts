import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";

/** Training-load balance and ramp metrics. Load is COROS training load per day
 * (or run duration when load is missing); the caller aggregates by day/week. */

const DAY = 86_400_000;
function cutoff(today: string, daysBack: number): string {
  return new Date(Date.parse(today) - daysBack * DAY).toISOString().slice(0, 10);
}

/** Acute:chronic workload ratio — acute (7-day) load over chronic (28-day
 * weekly average). Needs ~4 weeks of history to be meaningful. */
export function computeAcwr(
  loadsByDay: ReadonlyArray<{ date: string; load: number }>,
  today: string,
): MetricResult<{ acwr: number; acute: number; chronic: number }> {
  const entries = loadsByDay.filter((e) => e.load > 0 && e.date <= today);
  if (entries.length === 0) {
    return insufficient(14, 0, "The training-load ratio needs about four weeks of recorded runs.");
  }
  const earliest = entries.reduce((min, e) => (e.date < min ? e.date : min), today);
  const daysOfHistory = Math.round((Date.parse(today) - Date.parse(earliest)) / DAY) + 1;
  if (daysOfHistory < 14) {
    return insufficient(
      14,
      daysOfHistory,
      `The training-load ratio needs about four weeks of history; you have ${daysOfHistory} days.`,
    );
  }
  const d7 = cutoff(today, 6);
  const d28 = cutoff(today, 27);
  const acute = entries.filter((e) => e.date >= d7).reduce((s, e) => s + e.load, 0);
  const chronic = entries.filter((e) => e.date >= d28).reduce((s, e) => s + e.load, 0) / 4;
  const acwr = chronic > 0 ? Math.round((acute / chronic) * 100) / 100 : 0;
  return ok(
    { acwr, acute: Math.round(acute), chronic: Math.round(chronic) },
    entries.length,
    "Acute (last 7 days) training load divided by the chronic (28-day weekly average). COROS training load is used, or run duration when load is missing.",
  );
}

/** Week-over-week change in running volume. */
export function computeRampRate(
  weeklySeconds: readonly number[],
): MetricResult<{ pct: number }> {
  if (weeklySeconds.length < 2) {
    return insufficient(2, weeklySeconds.length, "Ramp rate needs at least two weeks of running.");
  }
  const last = weeklySeconds[weeklySeconds.length - 1]!;
  const prev = weeklySeconds[weeklySeconds.length - 2]!;
  if (prev <= 0) {
    return insufficient(2, weeklySeconds.length, "Ramp rate needs a previous week with running.");
  }
  return ok({ pct: Math.round(((last - prev) / prev) * 100) }, 2, "This week's running time versus last week's.");
}

/** Easy / quality / long share of running time. */
export function computeBalance(
  seconds: { easy: number; quality: number; long: number },
  totalRuns: number,
): MetricResult<{ easyPct: number; qualityPct: number; longPct: number }> {
  const total = seconds.easy + seconds.quality + seconds.long;
  if (totalRuns < 4 || total <= 0) {
    return insufficient(4, totalRuns, "Training balance needs at least 4 recorded runs.");
  }
  const pct = (x: number) => Math.round((x / total) * 100);
  return ok(
    { easyPct: pct(seconds.easy), qualityPct: pct(seconds.quality), longPct: pct(seconds.long) },
    totalRuns,
    "Share of running time by workout type over the recent window.",
  );
}
