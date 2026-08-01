import type { LocalDate, NormalizedActivity, WorkoutCategory } from "@rg/domain";
import { addDays, startOfIsoWeek } from "@rg/domain";
import { activityLocalDate, mean } from "./stats.js";

/**
 * Weekly training totals bucketed by ISO week (Monday start). The easy/quality
 * split relies on the completion-matching category map; activities without a
 * match count as easy — we never guess intensity from raw data.
 */

export interface WeeklyTotals {
  weekStart: LocalDate;
  durationSeconds: number;
  distanceMeters: number;
  /** Sum of provider training load where present. */
  trainingLoad: number;
  runCount: number;
  easySeconds: number;
  qualitySeconds: number;
}

export interface WeeklyTrainingReport {
  /** Continuous ISO weeks from first to last activity (gap weeks are zeroed). */
  weeks: WeeklyTotals[];
  /** Mean weekly durationSeconds over the most recent 4 weeks; needs >= 4 weeks. */
  fourWeekAvgDuration?: number;
  /** Mean weekly durationSeconds over the most recent 12 weeks; needs >= 12 weeks. */
  twelveWeekAvgDuration?: number;
}

function isQualityCategory(category: WorkoutCategory | undefined): boolean {
  return category === "quality" || category === "race";
}

export function computeWeeklyTraining(
  activities: NormalizedActivity[],
  categoryByMatchId: Record<string, WorkoutCategory>,
): WeeklyTrainingReport {
  const byWeek = new Map<LocalDate, WeeklyTotals>();

  for (const a of activities) {
    const weekStart = startOfIsoWeek(activityLocalDate(a));
    let bucket = byWeek.get(weekStart);
    if (!bucket) {
      bucket = {
        weekStart,
        durationSeconds: 0,
        distanceMeters: 0,
        trainingLoad: 0,
        runCount: 0,
        easySeconds: 0,
        qualitySeconds: 0,
      };
      byWeek.set(weekStart, bucket);
    }
    bucket.durationSeconds += a.durationSeconds;
    bucket.distanceMeters += a.distanceMeters ?? 0;
    bucket.trainingLoad += a.trainingLoad ?? 0;
    bucket.runCount += 1;

    const category = a.completionMatchId ? categoryByMatchId[a.completionMatchId] : undefined;
    if (isQualityCategory(category)) bucket.qualitySeconds += a.durationSeconds;
    else bucket.easySeconds += a.durationSeconds;
  }

  const starts = [...byWeek.keys()].sort();
  const weeks: WeeklyTotals[] = [];
  if (starts.length > 0) {
    const first = starts[0]!;
    const last = starts[starts.length - 1]!;
    for (let ws = first; ws <= last; ws = addDays(ws, 7)) {
      weeks.push(
        byWeek.get(ws) ?? {
          weekStart: ws,
          durationSeconds: 0,
          distanceMeters: 0,
          trainingLoad: 0,
          runCount: 0,
          easySeconds: 0,
          qualitySeconds: 0,
        },
      );
    }
  }

  const report: WeeklyTrainingReport = { weeks };
  if (weeks.length >= 4) {
    report.fourWeekAvgDuration = mean(weeks.slice(-4).map((w) => w.durationSeconds));
  }
  if (weeks.length >= 12) {
    report.twelveWeekAvgDuration = mean(weeks.slice(-12).map((w) => w.durationSeconds));
  }
  return report;
}
