import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { zoneOf } from "./hrZones.js";

/** How often your easy runs actually stay easy: the share whose average heart
 * rate sat in zones 1–2. A polarized (~80/20) approach keeps most easy runs
 * genuinely easy. */
export function computeEasyDiscipline(
  easyRuns: ReadonlyArray<{ avgHr: number }>,
  hrMax: number,
): MetricResult<{ inEasyPct: number }> {
  const withHr = easyRuns.filter((r) => r.avgHr > 0);
  if (withHr.length < 5) {
    return insufficient(5, withHr.length, "Easy-run discipline needs at least 5 easy runs with heart rate.");
  }
  const easy = withHr.filter((r) => zoneOf(r.avgHr, hrMax) <= 2).length;
  return ok(
    { inEasyPct: Math.round((easy / withHr.length) * 100) },
    withHr.length,
    "Share of your easy runs whose average heart rate stayed in zones 1–2.",
  );
}
