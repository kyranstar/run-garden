import {
  addDays,
  hasUsableReading,
  nightState,
  readinessVerdict,
  type NightState,
  type ReadinessVerdict,
} from "@rg/domain";

/**
 * The ONE construction of "readiness" the server hands out.
 *
 * `/api/plan/today` has always sent `{ latest, baseline, sampleDays }` — one
 * morning's reading against the median of the days behind it. The verdict
 * (domain/readiness.ts) is computed from exactly those same three things
 * here, so the dock's judgement, the Today card's numbers, and the coach
 * dossier's line can never quietly disagree about what "your baseline" means.
 * That disagreement is a bug this codebase has already paid for once (audit
 * 2026-08-14 finding 2: Garden said "7 bpm above", Insights said "3 below",
 * because each had built its own window).
 */

/** The columns this needs — `dailyHealth` rows satisfy it structurally. */
export interface ReadinessHealthRow {
  date: string;
  restingHeartRate: number | null;
  hrv: number | null;
  recoveryScore: number | null;
  /** COROS's own sleep-HRV baseline, when the feed carries it (0018). */
  sleepHrvBase?: number | null;
  /** COROS's own sleep-HRV spread — base ± sd is the athlete's band (0020). */
  sleepHrvSd?: number | null;
}

export interface ReadinessView<T> {
  latest: T | null;
  baseline: { restingHeartRate: number | null; hrv: number | null } | null;
  /** Days in the window that actually MEASURED something — not rows returned.
   * COROS writes a row daily whether the watch read anything or not, so a row
   * count is a count of sync days (2026-08-16 input audit). */
  sampleDays: number;
  /** Null whenever the evidence is too thin to judge — surfaces render
   * nothing rather than an empty slot. */
  verdict: ReadinessVerdict | null;
  /** The athlete's own sleep-HRV band (COROS base ± sd), when the feed
   * carries one — what "usually" means, said precisely (0020). */
  band: { lo: number; hi: number } | null;
  /** The last 7 nights ending today, oldest first. A date without a usable
   * reading is a "gap" — rendered as a gap, never guessed at. */
  nights: Array<{ date: string; state: NightState }>;
}

function nonNull<T>(v: T | null | undefined): v is T {
  return v != null;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

/** Seven days is the floor for calling a median a "baseline" — unchanged
 * from the original /today handler this was lifted out of. */
const MIN_BASELINE_DAYS = 7;

/**
 * @param recent wellness rows for the readiness window, NEWEST FIRST
 *   (`order by date desc limit 14`), already clipped to dates ≤ today.
 */
export function buildReadiness<T extends ReadinessHealthRow>(
  recent: T[],
  today?: string,
): ReadinessView<T> {
  const latest = recent[0] ?? null;
  // The HRV baseline prefers COROS's OWN per-day baseline when the feed
  // carries one (0018): it is the number the watch face compares against, so
  // "usually N" here matches what the athlete already sees on their wrist.
  // The 14-day median stays the fallback — and stays the only source for RHR,
  // which COROS ships no baseline for.
  const corosHrvBase = recent.find((h) => h.sleepHrvBase != null)?.sleepHrvBase ?? null;
  const baseline =
    recent.length >= MIN_BASELINE_DAYS
      ? {
          restingHeartRate: median(recent.map((h) => h.restingHeartRate).filter(nonNull)),
          hrv: corosHrvBase ?? median(recent.map((h) => h.hrv).filter(nonNull)),
        }
      : null;
  // Days that measured something, not rows that exist — see ReadinessView.
  const sampleDays = recent.filter(hasUsableReading).length;
  // The band comes from the newest row that carries COROS's own base; its sd
  // (or the classifier's 10% floor) sets the width. Rounded here so every
  // surface prints the same two integers.
  // Only a REAL spread makes a printable band (sd = 0 or absent → null, and
  // the sheet falls back to "usually N"): every surface that says "your
  // band" must mean the same two integers — base ± sd, never a clamp, never
  // our 10% stand-in dressed up as the watch's (verify round 1, findings
  // 3/6/7). nightState keeps its silent 10% floor for CLASSIFICATION only.
  const bandRow = recent.find((h) => h.sleepHrvBase != null && h.sleepHrvBase > 0);
  const band =
    bandRow?.sleepHrvBase != null && bandRow.sleepHrvSd != null && bandRow.sleepHrvSd > 0
      ? {
          lo: Math.round(bandRow.sleepHrvBase - bandRow.sleepHrvSd),
          hi: Math.round(bandRow.sleepHrvBase + bandRow.sleepHrvSd),
        }
      : null;
  // Last 7 nights ending today (falling back to the newest row's date when
  // the caller has no clock). daily_health is wake-date keyed, so each date's
  // row describes the night that ended that morning.
  const byDate = new Map(recent.map((h) => [h.date, h]));
  const anchor = today ?? latest?.date ?? null;
  const nights = anchor
    ? Array.from({ length: 7 }, (_, i) => {
        const date = addDays(anchor, i - 6);
        const row = byDate.get(date);
        return { date, state: row ? nightState(row) : ("gap" as NightState) };
      })
    : [];
  return {
    latest,
    baseline,
    sampleDays,
    verdict: latest
      ? readinessVerdict({
          recoveryScore: latest.recoveryScore,
          hrv: latest.hrv,
          hrvBaseline: baseline?.hrv,
          restingHeartRate: latest.restingHeartRate,
          rhrBaseline: baseline?.restingHeartRate,
          sampleDays,
        })
      : null,
    band,
    nights,
  };
}
