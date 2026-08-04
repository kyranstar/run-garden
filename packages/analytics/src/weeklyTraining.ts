import type { LocalDate, NormalizedActivity, WorkoutCategory } from "@rg/domain";
import { addDays, startOfIsoWeek } from "@rg/domain";
import { activityLocalDate, mean } from "./stats.js";

/**
 * Weekly training totals bucketed by ISO week (Monday start). The easy/quality
 * split relies on the completion-matching category map; activities without a
 * match count as easy — we never guess intensity from raw data. The low/high
 * intensity split is separate: it prefers per-activity zone-time when supplied
 * (opts.intensityByActivity) and otherwise falls back to the same category
 * heuristic (quality/race → high, everything else low).
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
  lowSeconds: number;
  highSeconds: number;
  /** True for the ISO week containing opts.today — excluded from the rolling averages. */
  partial: boolean;
}

export interface WeeklyTrainingReport {
  /** Continuous ISO weeks from the first activity through the week containing
   *  `opts.today` (or the last activity week when no `today` is given). Gap
   *  weeks — including a trailing run of them after training stopped — are
   *  zeroed, not omitted. */
  weeks: WeeklyTotals[];
  /** Mean weekly durationSeconds over the most recent 4 COMPLETE weeks (the partial current week, if any, is skipped); needs >= 4 complete weeks. */
  fourWeekAvgDuration?: number;
  /** Mean weekly durationSeconds over the most recent 12 COMPLETE weeks; needs >= 12 complete weeks. */
  twelveWeekAvgDuration?: number;
}

export interface ComputeWeeklyTrainingOptions {
  /** Today's date; the ISO week containing it is marked partial and excluded from averages. */
  today?: LocalDate;
  /** Per-activity zone time, keyed by NormalizedActivity.id. Takes precedence over the category heuristic. */
  intensityByActivity?: Record<string, { lowSeconds: number; highSeconds: number }>;
}

type WeeklyBucket = Omit<WeeklyTotals, "partial">;

function isQualityCategory(category: WorkoutCategory | undefined): boolean {
  return category === "quality" || category === "race";
}

function emptyBucket(weekStart: LocalDate): WeeklyBucket {
  return {
    weekStart,
    durationSeconds: 0,
    distanceMeters: 0,
    trainingLoad: 0,
    runCount: 0,
    easySeconds: 0,
    qualitySeconds: 0,
    lowSeconds: 0,
    highSeconds: 0,
  };
}

export function computeWeeklyTraining(
  activities: NormalizedActivity[],
  categoryByMatchId: Record<string, WorkoutCategory>,
  opts?: ComputeWeeklyTrainingOptions,
): WeeklyTrainingReport {
  const byWeek = new Map<LocalDate, WeeklyBucket>();

  for (const a of activities) {
    const weekStart = startOfIsoWeek(activityLocalDate(a));
    let bucket = byWeek.get(weekStart);
    if (!bucket) {
      bucket = emptyBucket(weekStart);
      byWeek.set(weekStart, bucket);
    }
    bucket.durationSeconds += a.durationSeconds;
    bucket.distanceMeters += a.distanceMeters ?? 0;
    bucket.trainingLoad += a.trainingLoad ?? 0;
    bucket.runCount += 1;

    const category = a.completionMatchId ? categoryByMatchId[a.completionMatchId] : undefined;
    if (isQualityCategory(category)) bucket.qualitySeconds += a.durationSeconds;
    else bucket.easySeconds += a.durationSeconds;

    const intensity = opts?.intensityByActivity?.[a.id];
    if (intensity) {
      bucket.lowSeconds += intensity.lowSeconds;
      bucket.highSeconds += intensity.highSeconds;
    } else if (isQualityCategory(category)) {
      bucket.highSeconds += a.durationSeconds;
    } else {
      bucket.lowSeconds += a.durationSeconds;
    }
  }

  const partialWeekStart = opts?.today ? startOfIsoWeek(opts.today) : undefined;

  const starts = [...byWeek.keys()].sort();
  const weeks: WeeklyTotals[] = [];
  if (starts.length > 0) {
    const first = starts[0]!;
    const lastWithActivity = starts[starts.length - 1]!;
    // Run the loop through the CURRENT week, not just the last week that
    // happened to contain a run. Stopping at the last activity week made a
    // layoff invisible twice over: the trailing zero weeks never emitted (so
    // the bars ended at the last week trained, reading as "up to date"), and
    // the 4-week average was taken over the last four weeks *trained* — a
    // month off could leave the card claiming 5h/week. Zero weeks are real
    // weeks; they count. `>` guards the case where every activity is already
    // in or ahead of the current week, which leaves the range untouched.
    const last = partialWeekStart && partialWeekStart > lastWithActivity ? partialWeekStart : lastWithActivity;
    for (let ws = first; ws <= last; ws = addDays(ws, 7)) {
      const bucket = byWeek.get(ws) ?? emptyBucket(ws);
      weeks.push({ ...bucket, partial: ws === partialWeekStart });
    }
  }

  const report: WeeklyTrainingReport = { weeks };
  const completeWeeks = weeks.filter((w) => !w.partial);
  if (completeWeeks.length >= 4) {
    report.fourWeekAvgDuration = mean(completeWeeks.slice(-4).map((w) => w.durationSeconds));
  }
  if (completeWeeks.length >= 12) {
    report.twelveWeekAvgDuration = mean(completeWeeks.slice(-12).map((w) => w.durationSeconds));
  }
  return report;
}
