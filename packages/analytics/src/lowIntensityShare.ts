import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { isEasyHr } from "./hrZones.js";

/**
 * Share of heart-rate-tracked running time spent at low intensity (zones
 * 1–2) vs. high intensity (zones 3–5) — a time-in-zone view of polarized
 * training, complementing easyDiscipline's per-run average-HR view. Lap heart
 * rate is preferred when available (it catches a hard surge inside an
 * otherwise-easy run); an activity with no usable laps falls back to its
 * average HR for the whole duration. Time with no heart rate at all is
 * disclosed separately and excluded from the ratio.
 */

const MIN_RUNS = 4;
const MIN_TOTAL_SECONDS = 4 * 3600;

export interface IntensityRunInput {
  activityId: string;
  durationSeconds: number;
  avgHeartRate: number | null;
  laps: Array<{ avgHeartRate: number | null; durationSeconds: number }>;
}

export interface LowIntensityValue {
  /** low / (low+high) * 100, rounded. */
  lowPct: number;
  lowSeconds: number;
  highSeconds: number;
  /** Excluded time with no heart-rate data, disclosed rather than hidden. */
  noHrSeconds: number;
  perActivity: Record<string, { lowSeconds: number; highSeconds: number }>;
}

function bucketRun(run: IntensityRunInput, hrMax: number): { low: number; high: number; noHr: number } {
  const usableLaps = run.laps.filter(
    (l) => l.avgHeartRate != null && l.avgHeartRate > 0 && l.durationSeconds > 0,
  );
  if (usableLaps.length > 0) {
    let low = 0;
    let high = 0;
    for (const lap of usableLaps) {
      if (isEasyHr(lap.avgHeartRate!, hrMax)) low += lap.durationSeconds;
      else high += lap.durationSeconds;
    }
    return { low, high, noHr: 0 };
  }
  if (run.avgHeartRate != null && run.avgHeartRate > 0) {
    return isEasyHr(run.avgHeartRate, hrMax)
      ? { low: run.durationSeconds, high: 0, noHr: 0 }
      : { low: 0, high: run.durationSeconds, noHr: 0 };
  }
  return { low: 0, high: 0, noHr: run.durationSeconds };
}

export function computeLowIntensityShare(
  runs: IntensityRunInput[],
  hrMax: number,
): MetricResult<LowIntensityValue> {
  let lowSeconds = 0;
  let highSeconds = 0;
  let noHrSeconds = 0;
  let runsContributingHr = 0;
  const perActivity: Record<string, { lowSeconds: number; highSeconds: number }> = {};

  for (const run of runs) {
    const { low, high, noHr } = bucketRun(run, hrMax);
    lowSeconds += low;
    highSeconds += high;
    noHrSeconds += noHr;
    perActivity[run.activityId] = { lowSeconds: low, highSeconds: high };
    if (low + high > 0) runsContributingHr++;
  }

  if (runsContributingHr < MIN_RUNS) {
    return insufficient(
      MIN_RUNS,
      runsContributingHr,
      `Low-intensity share needs at least ${MIN_RUNS} runs with usable heart-rate data; only ${runsContributingHr} qualify.`,
    );
  }
  const totalSeconds = lowSeconds + highSeconds;
  if (totalSeconds < MIN_TOTAL_SECONDS) {
    // `needed`/`have` are in HOURS, matching the explanation's own unit. They
    // were raw seconds, so the UI's "N of M available so far" line rendered
    // "9000 of 14400 available" underneath a sentence about 4 hours and 2.5 —
    // two different units for one gate, one of them meaningless to a reader.
    const neededHours = MIN_TOTAL_SECONDS / 3600;
    const haveHours = Math.round((totalSeconds / 3600) * 10) / 10;
    return insufficient(
      neededHours,
      haveHours,
      `Low-intensity share needs at least ${neededHours} hours of heart-rate-tracked running; only have ${haveHours} hours.`,
    );
  }

  return ok(
    {
      lowPct: Math.round((lowSeconds / totalSeconds) * 100),
      lowSeconds,
      highSeconds,
      noHrSeconds,
      perActivity,
    },
    runsContributingHr,
    "Share of heart-rate-tracked running time spent in zones 1–2 (low intensity) vs. zones 3–5 (high intensity).",
  );
}
