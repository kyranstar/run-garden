/**
 * Intensity → pace bands, anchored on the athlete's COROS-measured lactate
 * threshold (2026-08-14). The offsets are chosen so the threshold band
 * reproduces what COROS itself prescribes for threshold work on this
 * account (thr 289 → 289–313 s/km, live-verified against the imported
 * plan's own targets) rather than competing with it.
 *
 * Bands move automatically as the measured threshold moves — nothing here
 * is a stored constant about the athlete.
 *
 * DESIGNED RUNS (§8 §3, 2026-10-18): the workout document's run efforts (all
 * eleven of `RUN_EFFORTS`) read through this one function too — the run card,
 * the validator and the watch wire share it, so the three cannot disagree. The
 * coach names the effort; the pace is computed here. Recovery, long and tempo
 * sit between the thread coach's four (whose bands are unchanged): slowest to
 * fastest, recovery · easy · long · steady · tempo · threshold · interval.
 * By feel and strides are efforts, not paces, and get no band; nor do hills —
 * a flat-ground pace on a climb would have the watch calling every rep too
 * slow. Race pace is the threshold scaled to the race's own distance
 * (`racePrediction`), and none without one: the coach writes a race pace the
 * athlete asked for itself.
 */
import type { RUN_EFFORTS } from "./workout-doc.js";

export type PaceIntensity = "easy" | "steady" | "threshold" | "interval" | "rest";
/** A workout document's run effort. */
export type RunEffort = (typeof RUN_EFFORTS)[number];

export interface PaceBand {
  /** Faster edge, seconds per km (the smaller number). */
  fastSecPerKm: number;
  /** Slower edge, seconds per km. */
  slowSecPerKm: number;
}

/** Offsets from threshold pace, in seconds per km: [faster edge, slower edge]. */
const OFFSETS: Partial<Record<Exclude<PaceIntensity | RunEffort, "rest">, [number, number]>> = {
  recovery: [90, 150],
  easy: [60, 120],
  long: [45, 105],
  steady: [25, 45],
  tempo: [10, 25],
  threshold: [0, 24],
  interval: [-20, -5],
};

/** The lowest believable threshold pace (2:00/km ≈ world record territory)
 * and the highest (12:00/km) — a garbage reading must never produce a
 * prescription. */
const MIN_THRESHOLD_SEC_PER_KM = 120;
const MAX_THRESHOLD_SEC_PER_KM = 720;

const plausible = (t: number | null | undefined): t is number =>
  t != null && Number.isFinite(t) && t >= MIN_THRESHOLD_SEC_PER_KM && t <= MAX_THRESHOLD_SEC_PER_KM;

/**
 * The pace band for an intensity or a run effort, or null when no honest band
 * exists: rest blocks, an effort with no pace (by feel, strides, hills), race
 * pace with no distance, an unknown word, or an implausible threshold reading.
 * `distanceM`: the segment's distance — what race pace is scaled to.
 */
export function paceBandFor(
  intensity: PaceIntensity | RunEffort | undefined,
  thresholdSecPerKm: number | null | undefined,
  opts: { distanceM?: number } = {},
): PaceBand | null {
  if (!intensity || intensity === "rest") return null;
  if (!plausible(thresholdSecPerKm)) return null;
  if (intensity === "race") {
    const p = opts.distanceM !== undefined ? racePrediction(thresholdSecPerKm, opts.distanceM / 1000) : null;
    return p ? { fastSecPerKm: p.fastSecPerKm, slowSecPerKm: p.slowSecPerKm } : null;
  }
  const offsets = OFFSETS[intensity];
  if (!offsets) return null;
  return {
    fastSecPerKm: Math.round(thresholdSecPerKm + offsets[0]),
    slowSecPerKm: Math.round(thresholdSecPerKm + offsets[1]),
  };
}

/** The effort whose band an effort with none of its own borrows, for its time only. */
const CONVERSION_EFFORT: Partial<Record<RunEffort, RunEffort>> = {
  strides: "interval",
  hills: "threshold",
  by_feel: "easy",
  race: "threshold",
};

/**
 * The pace a distance is run at, as its time on the watch reads it (phase 1:
 * the wire carries time): the middle of the effort's band — or, for an effort
 * with none, of the nearest effort's (strides at interval pace, hills at
 * threshold, by feel easy, race pace with no distance at threshold), which
 * times the distance without ever becoming its target. Null with no plausible
 * threshold.
 */
export function conversionPaceFor(
  effort: RunEffort,
  thresholdSecPerKm: number | null | undefined,
  opts: { distanceM?: number } = {},
): number | null {
  const band = paceBandFor(effort, thresholdSecPerKm, opts) ?? paceBandFor(CONVERSION_EFFORT[effort], thresholdSecPerKm);
  return band ? (band.fastSecPerKm + band.slowSecPerKm) / 2 : null;
}

export interface RacePrediction {
  distanceKm: number;
  fastSecPerKm: number;
  slowSecPerKm: number;
  fastSeconds: number;
  slowSeconds: number;
}

/** Riegel's endurance exponent — the standard fatigue curve for scaling a
 * known effort to another distance. */
const RIEGEL = 1.06;
/** The slower edge of the goal band: conditions, turns, pacing error. */
const BAND_WIDTH_SEC_PER_KM = 8;

/**
 * A race-distance-aware goal band. Threshold pace is by definition roughly
 * what an athlete holds for an HOUR — using it directly as a marathon target
 * would be 40–60 s/km too fast, so the hour benchmark is scaled to the real
 * distance by Riegel (audit#3-b #1: the strip previously asserted every race
 * was a 10K). Returns null when the distance is unknown — no distance, no
 * time claim.
 */
export function racePrediction(
  thresholdSecPerKm: number | null | undefined,
  distanceKm: number | null | undefined,
): RacePrediction | null {
  if (
    thresholdSecPerKm == null ||
    distanceKm == null ||
    !Number.isFinite(thresholdSecPerKm) ||
    !Number.isFinite(distanceKm) ||
    thresholdSecPerKm < MIN_THRESHOLD_SEC_PER_KM ||
    thresholdSecPerKm > MAX_THRESHOLD_SEC_PER_KM ||
    distanceKm <= 0 ||
    distanceKm > 200
  ) {
    return null;
  }
  // Distance covered in one hour at threshold — the anchor effort.
  const hourDistanceKm = 3600 / thresholdSecPerKm;
  const seconds = 3600 * Math.pow(distanceKm / hourDistanceKm, RIEGEL);
  const paceSecPerKm = seconds / distanceKm;
  const fast = Math.round(paceSecPerKm);
  const slow = Math.round(paceSecPerKm + BAND_WIDTH_SEC_PER_KM);
  return {
    distanceKm,
    fastSecPerKm: fast,
    slowSecPerKm: slow,
    fastSeconds: Math.round(fast * distanceKm),
    slowSeconds: Math.round(slow * distanceKm),
  };
}
