import { hasUsableReading, readinessVerdict, type ReadinessVerdict } from "@rg/domain";

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
export function buildReadiness<T extends ReadinessHealthRow>(recent: T[]): ReadinessView<T> {
  const latest = recent[0] ?? null;
  const baseline =
    recent.length >= MIN_BASELINE_DAYS
      ? {
          restingHeartRate: median(recent.map((h) => h.restingHeartRate).filter(nonNull)),
          hrv: median(recent.map((h) => h.hrv).filter(nonNull)),
        }
      : null;
  // Days that measured something, not rows that exist — see ReadinessView.
  const sampleDays = recent.filter(hasUsableReading).length;
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
  };
}
