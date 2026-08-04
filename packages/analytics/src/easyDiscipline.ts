import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { isEasyHr } from "./hrZones.js";

const MIN_RUNS = 5;

export interface EasyDisciplineValue {
  inEasyPct: number;
  /** Chronological, one entry per contributing run. */
  ticks: Array<{ activityId: string; date: string; easy: boolean }>;
}

/** How often your easy runs actually stay easy: the share whose average heart
 * rate sat in zones 1–2 (the same isEasyHr predicate used everywhere else).
 * A polarized (~80/20) approach keeps most easy runs genuinely easy. */
export function computeEasyDiscipline(
  easyRuns: ReadonlyArray<{ activityId: string; date: string; avgHr: number }>,
  hrMax: number,
): MetricResult<EasyDisciplineValue> {
  const withHr = easyRuns.filter((r) => r.avgHr > 0);
  if (withHr.length < MIN_RUNS) {
    return insufficient(
      MIN_RUNS,
      withHr.length,
      `Easy-run discipline needs at least ${MIN_RUNS} easy runs with heart rate.`,
    );
  }
  const sorted = [...withHr].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.activityId < b.activityId ? -1 : 1,
  );
  const ticks = sorted.map((r) => ({
    activityId: r.activityId,
    date: r.date,
    easy: isEasyHr(r.avgHr, hrMax),
  }));
  const easyCount = ticks.filter((t) => t.easy).length;
  return ok(
    { inEasyPct: Math.round((easyCount / ticks.length) * 100), ticks },
    ticks.length,
    "Share of your easy runs whose average heart rate stayed in zones 1–2.",
  );
}
