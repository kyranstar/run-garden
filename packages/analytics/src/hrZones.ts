/**
 * Heart-rate zones — the watch's own record first, estimation last (audit#2
 * resolved question (a)).
 *
 * The PRIMARY source for "where is this runner's easy boundary" is the
 * device's own per-activity time-in-zone record (`telemetry.hrZones`): the
 * watch already knows its configured zones, and `watchEasyCeiling` below
 * simply reads the Z2 upper bound off the most recent activity that carries
 * one. Estimation from observed max-HR readings is the LAST-RESORT fallback,
 * for histories with no zone records at all.
 *
 * The fallback estimate: the TOP recorded max-heart-rate reading, accepted
 * only when the second-highest corroborates it (within
 * `HRMAX_CORROBORATION_BPM`) — real device glitches sit 30+ bpm off, so a
 * lone spike far above the pack falls back to the runner-up instead of
 * setting the ceiling. Readings ≤120bpm are ignored as implausible "max"
 * values (e.g. a walk's peak). Fewer than `MIN_HRMAX_READINGS` qualifying
 * readings yields no estimate at all (audit#2: the old second-highest-of-7
 * rule built a 144bpm ceiling under a runner whose watch draws it at 155,
 * turning a truthful ~66% low-intensity share into a red 3%). Even a
 * qualifying estimate stays thin evidence, which is why `misc.ts` counts the
 * readings and captions every card built on the ceiling when fewer than 10
 * backed it. Zones are %HRmax: Z1 <68, Z2 68–79, Z3 80–87, Z4 88–94, Z5 95%+.
 */

/**
 * Only the one field the estimate reads. Deliberately narrower than
 * `NormalizedActivity` (which still satisfies it) so a caller can pass a
 * column projection: estimating the ceiling over a 26-week history has no
 * business loading 26 weeks of full activity rows to look at one number.
 * `null` is accepted alongside `undefined` because that is what a SQL row
 * carries.
 */
export interface HrMaxSample {
  maxHeartRate?: number | null;
}

/** A "max" at or below this is implausible (a walk's peak, a dropped strap). */
export const MIN_PLAUSIBLE_HR_MAX = 120;

/**
 * The readings `estimateHrMax` actually consumes, highest first. Exported so a
 * caller that wants to say how much evidence the estimate rests on counts the
 * same readings the estimate used — counting "runs with any heart rate" instead
 * would let a pile of average-only runs suppress the caveat while the ceiling
 * still balanced on two max readings, which overstates confidence in one
 * direction only.
 */
export function usableHrMaxReadings(activities: readonly HrMaxSample[]): number[] {
  return activities
    .map((a) => a.maxHeartRate)
    .filter((h): h is number => h != null && h > MIN_PLAUSIBLE_HR_MAX)
    .sort((a, b) => b - a);
}

/** Below this many qualifying readings the estimator emits no ceiling at all. */
export const MIN_HRMAX_READINGS = 5;
/**
 * The top reading is trusted when the second-highest sits within this many
 * bpm of it. Real glitches (strap dropouts, cadence lock) read 30+ bpm off;
 * two readings 12 bpm apart are two hard days, not a spike and its shadow.
 */
export const HRMAX_CORROBORATION_BPM = 12;

export function estimateHrMax(activities: readonly HrMaxSample[]): number | null {
  const maxes = usableHrMaxReadings(activities);
  // audit#2 (a3): no ceiling from thin air — under 5 readings the honest
  // answer is "unknown", not a number that happens to have units.
  if (maxes.length < MIN_HRMAX_READINGS) return null;
  const [top, second] = [maxes[0]!, maxes[1]!];
  // The TOP reading when the second corroborates it; the old
  // second-highest-always rule systematically underestimated the ceiling
  // (a real max is by definition the highest thing observed).
  return top - second <= HRMAX_CORROBORATION_BPM ? top : second;
}

// ── The watch's own ceiling (audit#2 (a2)) ───────────────────────────────────

/** One bucket of a per-activity time-in-zone record (`telemetry.hrZones`). */
export interface HrZoneBucket {
  /** Zone lower bound, bpm. */
  lo: number;
  /** Zone upper bound, bpm. */
  hi: number;
  seconds: number;
}

/** The narrow projection `watchEasyCeiling` reads — an activity's start
 * instant (to pick the most recent) and its zone record, both shaped exactly
 * like an `activities` row so a caller can pass rows straight through. */
export interface WatchCeilingSample {
  startTime: string;
  telemetry?: { hrZones?: readonly HrZoneBucket[] | null } | null;
}

/**
 * The easy ceiling as the WATCH draws it: the Z2 upper bound from the most
 * recent activity carrying a time-in-zone record. This is the device's own
 * configured boundary — no estimation involved — so when it exists it
 * outranks `estimateHrMax`/`easyCeiling` entirely; the estimator is a last
 * resort for zone-less histories. Most-recent wins so a re-configured watch
 * takes effect on the next run. `null` when no activity carries a usable
 * record (at least Z1+Z2 buckets, with a positive Z2 bound).
 */
export function watchEasyCeiling(activities: readonly WatchCeilingSample[]): number | null {
  let latestStart = "";
  let ceiling: number | null = null;
  for (const a of activities) {
    const z2hi = a.telemetry?.hrZones?.[1]?.hi;
    if (z2hi == null || z2hi <= 0) continue;
    if (a.startTime > latestStart) {
      latestStart = a.startTime;
      ceiling = Math.round(z2hi);
    }
  }
  return ceiling;
}

const UPPER = [0.68, 0.8, 0.88, 0.95]; // upper bounds of Z1..Z4 as fraction of HRmax

/** The bpm ceiling of Zone 2 — an easy run's average HR should stay under it. */
export function easyCeiling(hrMax: number): number {
  return Math.round(UPPER[1]! * hrMax);
}

export function zoneOf(hr: number, hrMax: number): 1 | 2 | 3 | 4 | 5 {
  if (hrMax <= 0) return 1;
  const frac = hr / hrMax;
  if (frac < UPPER[0]!) return 1;
  if (frac < UPPER[1]!) return 2;
  if (frac < UPPER[2]!) return 3;
  if (frac < UPPER[3]!) return 4;
  return 5;
}

/**
 * Shared "was this easy?" predicate: at or under the Zone-2 ceiling. Defined
 * against `easyCeiling`'s rounded integer bpm value (not `zoneOf`'s raw
 * fraction) so it always agrees with the ceiling the drill-down UI displays
 * ("under your N bpm ceiling") — `zoneOf(easyCeiling(hrMax), hrMax) <= 2`
 * disagrees with the rounded ceiling for most hrMax values, since rounding
 * can push the integer ceiling to the far side of the 0.8 fraction boundary.
 */
export function isEasyHr(avgHr: number, hrMax: number): boolean {
  return avgHr <= easyCeiling(hrMax);
}
