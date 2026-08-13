import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";

/**
 * Share of heart-rate-tracked running time spent at low intensity (zones
 * 1–2) vs. high intensity (zones 3–5) — a time-in-zone view of polarized
 * training, complementing easyDiscipline's per-run average-HR view.
 *
 * Classification order (audit#2 resolved question (a)): the watch's OWN
 * time-in-zone record (`hrZones`) is authoritative when an activity carries
 * one — zones 1–2 are low, 3+ high, with no ceiling involved at all. Only
 * zone-less activities fall back to bucketing against `easyCeilingBpm`: lap
 * heart rate when usable laps exist (it catches a hard surge inside an
 * otherwise-easy run), whole-run average otherwise. Time with no heart rate
 * at all is disclosed separately and excluded from the ratio.
 */

const MIN_RUNS = 4;
const MIN_TOTAL_SECONDS = 4 * 3600;

export interface IntensityRunInput {
  activityId: string;
  durationSeconds: number;
  avgHeartRate: number | null;
  laps: Array<{ avgHeartRate: number | null; durationSeconds: number }>;
  /**
   * The activity's own time-in-zone record (`telemetry.hrZones`), Z1 first.
   * When present with any positive seconds it IS the classification; the
   * lap/average fallback below never runs (audit#2 (a1)). Only `seconds` is
   * read here — the bpm bounds ride along because that is the stored shape.
   */
  hrZones?: ReadonlyArray<{ lo?: number; hi?: number; seconds: number }> | null;
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

function bucketRun(
  run: IntensityRunInput,
  easyCeilingBpm: number,
): { low: number; high: number; noHr: number } {
  // audit#2 (a1): the watch already classified this run's every second
  // against its own configured zones — that record outranks anything we
  // could rebuild from lap averages against an estimated ceiling.
  const zones = run.hrZones ?? [];
  const zoneTotal = zones.reduce((s, z) => s + z.seconds, 0);
  if (zoneTotal > 0) {
    const low = (zones[0]?.seconds ?? 0) + (zones[1]?.seconds ?? 0);
    // Zone seconds sum to the activity's duration within a second; the
    // sub-second residue is rounding, not untracked time, so noHr stays 0.
    return { low, high: zoneTotal - low, noHr: 0 };
  }
  const usableLaps = run.laps.filter(
    (l) => l.avgHeartRate != null && l.avgHeartRate > 0 && l.durationSeconds > 0,
  );
  if (usableLaps.length > 0) {
    let low = 0;
    let high = 0;
    for (const lap of usableLaps) {
      if (lap.avgHeartRate! <= easyCeilingBpm) low += lap.durationSeconds;
      else high += lap.durationSeconds;
    }
    return { low, high, noHr: 0 };
  }
  if (run.avgHeartRate != null && run.avgHeartRate > 0) {
    return run.avgHeartRate <= easyCeilingBpm
      ? { low: run.durationSeconds, high: 0, noHr: 0 }
      : { low: 0, high: run.durationSeconds, noHr: 0 };
  }
  return { low: 0, high: 0, noHr: run.durationSeconds };
}

export function computeLowIntensityShare(
  runs: IntensityRunInput[],
  /** The Z2 upper bound in bpm — `watchEasyCeiling` where the history has
   * zone records, `easyCeiling(estimateHrMax(...))` as the last resort. Only
   * consulted for activities WITHOUT their own `hrZones` record. */
  easyCeilingBpm: number,
): MetricResult<LowIntensityValue> {
  let lowSeconds = 0;
  let highSeconds = 0;
  let noHrSeconds = 0;
  let runsContributingHr = 0;
  const perActivity: Record<string, { lowSeconds: number; highSeconds: number }> = {};

  for (const run of runs) {
    const { low, high, noHr } = bucketRun(run, easyCeilingBpm);
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

// ── Band + honest suppression (audit#2 (a4)) ─────────────────────────────────

export type IntensityBand = "high" | "watch" | "healthy";

/**
 * The one band rule for the low-intensity headline, shared with the worker's
 * presentation so the stability probe below can never drift from the band
 * the card actually shows: under 65% is "high" (alarmingly intensity-heavy),
 * under 75% "watch", at/above 75% "healthy".
 */
export function intensityBand(lowPct: number): IntensityBand {
  return lowPct < 65 ? "high" : lowPct < 75 ? "watch" : "healthy";
}

/** How far the easy ceiling is probed in each direction before a band claim
 * is allowed to stand (audit#2 (a4)). */
export const CEILING_PROBE_BPM = 5;

/**
 * Whether the headline's band survives the easy ceiling's own error bar:
 * recompute lowPct at ceiling ± `toleranceBpm` and demand the SAME band at
 * every point. A runner whose aerobic runs sit a few bpm either side of an
 * estimated ceiling can swing from "3% low" to "66% low" inside that band —
 * a classification that flips across it is a fact about the estimate, not
 * the runner, and must not be claimed (audit#2 (a4)). Time classified by the
 * watch's own `hrZones` record is immune by construction — moving the
 * ceiling moves nothing — so a fully zone-backed month always reads stable.
 */
export function intensityBandStable(
  runs: IntensityRunInput[],
  easyCeilingBpm: number,
  toleranceBpm: number = CEILING_PROBE_BPM,
): boolean {
  const bandAt = (ceiling: number): IntensityBand | null => {
    const r = computeLowIntensityShare(runs, ceiling);
    return r.status === "ok" ? intensityBand(r.value.lowPct) : null;
  };
  const bands = [
    bandAt(easyCeilingBpm - toleranceBpm),
    bandAt(easyCeilingBpm),
    bandAt(easyCeilingBpm + toleranceBpm),
  ];
  return bands.every((b) => b != null && b === bands[0]);
}
