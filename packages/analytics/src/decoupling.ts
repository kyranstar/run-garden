import type { ActivityLap, NormalizedActivity, WorkoutCategory } from "@rg/domain";
import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { activityLocalDate, median, roundTo, weightedMean } from "./stats.js";

/**
 * Pace-adjusted decoupling ("Pa:HR"): the change in speed-to-heart-rate ratio
 * from the first half of a steady run to the second. Unlike a raw HR-only
 * drift figure, this does not mistake a deliberate pace change for aerobic
 * fatigue — if HR rises but pace slows by a proportional amount, the ratio
 * (and therefore the decoupling percentage) stays flat. Interval workouts
 * are never included, and runs whose lap paces surge more than 25% from the
 * run median are excluded with an explicit reason.
 */

const MIN_RUNS = 3;
const MIN_DURATION_SECONDS = 40 * 60;
const MIN_USABLE_LAPS = 4;
const MAX_PACE_DEVIATION = 0.25;
/** Laps ending at or before this many cumulative seconds are warm-up and dropped. */
const WARMUP_TRIM_SECONDS = 600;
const MAX_EXCLUDED_REASONS = 5;

const STEADY_CATEGORIES: ReadonlySet<WorkoutCategory> = new Set(["easy", "long", "recovery"]);

export interface DecouplingRunInput {
  activity: NormalizedActivity;
  laps: ActivityLap[];
  category: WorkoutCategory;
}

export interface DecouplingPoint {
  activityId: string;
  /** LocalDate of the run. */
  date: string;
  /** (ratio1 / ratio2 - 1) * 100, where ratio = speed / heart rate. */
  decouplingPct: number;
}

export interface DecouplingValue {
  perRun: DecouplingPoint[];
  medianPct: number;
  excluded: { count: number; reasons: string[] };
}

/**
 * Laps after dropping any that end at or before the first 600s of
 * cumulative run time (a lap straddling the 600s mark is kept). Unlike the
 * aerobic-efficiency trim, the final lap is NOT dropped — decoupling needs
 * the full second half of the run to compare against the first.
 */
function trimWarmup(laps: ActivityLap[]): ActivityLap[] {
  const sorted = [...laps].sort((a, b) => a.lapIndex - b.lapIndex);
  let cumulative = 0;
  const kept: ActivityLap[] = [];
  for (const lap of sorted) {
    cumulative += lap.durationSeconds;
    if (cumulative <= WARMUP_TRIM_SECONDS) continue;
    kept.push(lap);
  }
  return kept;
}

/** Trimmed laps with heart rate, pace, and duration all present and positive. */
function usableLaps(run: DecouplingRunInput): ActivityLap[] {
  return trimWarmup(run.laps).filter(
    (l) =>
      l.avgHeartRate != null &&
      l.avgHeartRate > 0 &&
      l.avgPaceSecPerKm != null &&
      l.avgPaceSecPerKm > 0 &&
      l.durationSeconds > 0,
  );
}

function exclusionReason(run: DecouplingRunInput): string | null {
  const { activity, category } = run;
  if (!STEADY_CATEGORIES.has(category)) {
    return `category "${category}" is not a steady run (only easy, long, recovery qualify)`;
  }
  if (activity.durationSeconds < MIN_DURATION_SECONDS) return "shorter than 40 minutes";

  const laps = usableLaps(run);
  if (laps.length < MIN_USABLE_LAPS) {
    return `fewer than ${MIN_USABLE_LAPS} laps with heart rate, pace, and duration data after trimming the first 10 minutes`;
  }
  const paces = laps.map((l) => l.avgPaceSecPerKm!);
  const med = median(paces);
  if (med > 0 && paces.some((p) => Math.abs(p - med) / med > MAX_PACE_DEVIATION)) {
    return "lap pace varied more than 25% from the run median (surging)";
  }
  return null;
}

/** speed-to-heart-rate ratio for one half's laps (0 when time or HR is 0). */
function halfRatio(laps: ActivityLap[]): number {
  const time = laps.reduce((s, l) => s + l.durationSeconds, 0);
  // Derive lap distance from pace: meters = duration / (sec/km) * 1000.
  const distance = laps.reduce((s, l) => s + (l.durationSeconds / l.avgPaceSecPerKm!) * 1000, 0);
  const hr = weightedMean(laps.map((l) => ({ value: l.avgHeartRate!, weight: l.durationSeconds })));
  if (time <= 0 || hr <= 0) return 0;
  return distance / time / hr;
}

/** Split usable laps into halves by cumulative time (lap belongs where its midpoint falls). */
function decouplingPct(run: DecouplingRunInput): number {
  const laps = usableLaps(run);
  const total = laps.reduce((s, l) => s + l.durationSeconds, 0);
  const first: ActivityLap[] = [];
  const second: ActivityLap[] = [];
  let elapsed = 0;
  for (const lap of laps) {
    const midpoint = elapsed + lap.durationSeconds / 2;
    (midpoint < total / 2 ? first : second).push(lap);
    elapsed += lap.durationSeconds;
  }
  const ratio1 = halfRatio(first);
  const ratio2 = halfRatio(second);
  if (ratio2 <= 0) return 0;
  return roundTo((ratio1 / ratio2 - 1) * 100, 2);
}

export function computeDecoupling(runs: DecouplingRunInput[]): MetricResult<DecouplingValue> {
  const perRun: DecouplingPoint[] = [];
  const reasons: string[] = [];

  for (const run of runs) {
    const reason = exclusionReason(run);
    if (reason != null) {
      reasons.push(reason);
      continue;
    }
    perRun.push({
      activityId: run.activity.id,
      date: activityLocalDate(run.activity),
      decouplingPct: decouplingPct(run),
    });
  }
  perRun.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.activityId < b.activityId ? -1 : 1));

  if (perRun.length < MIN_RUNS) {
    return insufficient(
      MIN_RUNS,
      perRun.length,
      `Pa:HR decoupling needs at least ${MIN_RUNS} steady runs of 40+ minutes with 4+ usable laps and even pacing; only ${perRun.length} qualify (${reasons.length} excluded).`,
    );
  }

  return ok(
    {
      perRun,
      medianPct: roundTo(median(perRun.map((p) => p.decouplingPct)), 2),
      excluded: { count: reasons.length, reasons: reasons.slice(0, MAX_EXCLUDED_REASONS) },
    },
    perRun.length,
    "Pace-adjusted speed-to-heart-rate decoupling (Pa:HR) from the first half to the second half of steady runs (easy, long, recovery) of 40+ minutes with even pacing; interval sessions and surging runs are excluded.",
  );
}
