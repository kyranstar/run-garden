/**
 * Intensity → pace bands, anchored on the athlete's COROS-measured lactate
 * threshold (2026-08-14). The offsets are chosen so the threshold band
 * reproduces what COROS itself prescribes for threshold work on this
 * account (thr 289 → 289–313 s/km, live-verified against the imported
 * plan's own targets) rather than competing with it.
 *
 * Bands move automatically as the measured threshold moves — nothing here
 * is a stored constant about the athlete.
 */

export type PaceIntensity = "easy" | "steady" | "threshold" | "interval" | "rest";

export interface PaceBand {
  /** Faster edge, seconds per km (the smaller number). */
  fastSecPerKm: number;
  /** Slower edge, seconds per km. */
  slowSecPerKm: number;
}

/** Offsets from threshold pace, in seconds per km: [faster edge, slower edge]. */
const OFFSETS: Record<Exclude<PaceIntensity, "rest">, [number, number]> = {
  easy: [60, 120],
  steady: [25, 45],
  threshold: [0, 24],
  interval: [-20, -5],
};

/** The lowest believable threshold pace (2:00/km ≈ world record territory)
 * and the highest (12:00/km) — a garbage reading must never produce a
 * prescription. */
const MIN_THRESHOLD_SEC_PER_KM = 120;
const MAX_THRESHOLD_SEC_PER_KM = 720;

/**
 * The pace band for an intensity, or null when no honest band exists:
 * rest blocks, an unknown intensity, or an implausible threshold reading.
 */
export function paceBandFor(
  intensity: PaceIntensity | undefined,
  thresholdSecPerKm: number | null | undefined,
): PaceBand | null {
  if (!intensity || intensity === "rest") return null;
  if (
    thresholdSecPerKm == null ||
    !Number.isFinite(thresholdSecPerKm) ||
    thresholdSecPerKm < MIN_THRESHOLD_SEC_PER_KM ||
    thresholdSecPerKm > MAX_THRESHOLD_SEC_PER_KM
  ) {
    return null;
  }
  const offsets = OFFSETS[intensity];
  if (!offsets) return null;
  return {
    fastSecPerKm: Math.round(thresholdSecPerKm + offsets[0]),
    slowSecPerKm: Math.round(thresholdSecPerKm + offsets[1]),
  };
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
