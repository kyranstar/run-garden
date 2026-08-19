/**
 * One readiness verdict from the morning's COROS wellness signals.
 *
 * This is the "should I do today's session as written?" question answered
 * ONCE, in one place, so the garden dock, the coach dossier, and anything
 * that follows all read the same judgement from the same evidence. The
 * function is pure: no dates, no fetching, no copy decisions (the display
 * phrase for a level lives in the UI, the way `deriveHeadline`'s copy does).
 *
 * Two rules shape everything below:
 *
 *  1. WITHHOLD RATHER THAN GUESS. With no reading, too few days behind the
 *     reading, or nothing the numbers can actually be judged against, the
 *     answer is `null` — no card at all. A verdict the athlete can't trust
 *     is worse than silence, and this codebase already withholds on the same
 *     principle (`Readiness` on Today renders nothing under 3 sample days;
 *     `paceBandFor` returns null rather than prescribe off a junk reading).
 *
 *  2. THE EVIDENCE TRAVELS WITH THE VERDICT. `reasons` names the numbers in
 *     plain words, worst signal first, so no surface has to invent a
 *     justification for a level it was handed.
 *
 * The thresholds are conventional wellness-tracking heuristics — the same
 * shape every HRV app uses — not laws of physiology. They are stated as
 * constants with their reasoning so they can be argued with and moved.
 */

export type ReadinessLevel = "good" | "caution" | "poor";

export interface ReadinessVerdict {
  level: ReadinessLevel;
  /** Plain-words evidence, worst signal first. Never empty. */
  reasons: string[];
}

export interface ReadinessSignals {
  /** COROS recovery, 0–100. COROS sends 0 for "not computed" — see below. */
  recoveryScore?: number | null;
  /** This morning's HRV (ms) and the median of the recent window. */
  hrv?: number | null;
  hrvBaseline?: number | null;
  /** This morning's resting HR (bpm) and the median of the recent window. */
  restingHeartRate?: number | null;
  rhrBaseline?: number | null;
  /**
   * How many days in the window carried AT LEAST ONE USABLE READING — not how
   * many rows exist. COROS writes a `daily_health` row every day whether or
   * not the watch measured anything (live: 77 rows, 73 of them with a null
   * recovery score), so a row count is a count of days the sync ran, and
   * gating on it let a fortnight of empty rows read as a fortnight of
   * evidence. Callers count with {@link hasUsableReading}.
   */
  sampleDays: number;
}

/** Under three days there is no "usual" to be unusual against. Same floor the
 * Today screen's Readiness card already uses — one number, not two. */
const MIN_SAMPLE_DAYS = 3;

/**
 * The caveat a thin verdict carries with it, so no surface can print the state
 * word alone. The product rule is that a state word always travels with its
 * explainer, and `reasons` is the channel every surface already renders.
 */
const SOLE_SIGNAL_NOTE =
  "thin evidence: one reading and nothing to corroborate it";

/**
 * HRV suppression, as a percentage below the athlete's own median. Day-to-day
 * HRV noise on a healthy athlete routinely runs a few percent, so 5% is about
 * where a reading stops being weather; a 10% drop is the level most protocols
 * treat as "your body is dealing with something".
 */
const HRV_CAUTION_DROP_PCT = 5;
const HRV_POOR_DROP_PCT = 10;

/**
 * Resting HR elevation, in absolute bpm over the median — absolute rather
 * than proportional because the same +5 means the same thing at 40 bpm and
 * at 60. 4 bpm is the classic "watch it" line, 7 the classic "something is
 * going on" line (illness, heat, alcohol, deep fatigue).
 */
const RHR_CAUTION_DELTA_BPM = 4;
const RHR_POOR_DELTA_BPM = 7;

/** COROS's own recovery percentage. Its guidance treats the bottom third as
 * "recover", and anything under ~60 as not-yet-restored. */
const RECOVERY_CAUTION_BELOW = 60;
const RECOVERY_POOR_BELOW = 33;

/**
 * Plausibility windows. A 0 from COROS means "I did not compute this", never
 * "your HRV is zero" — the same trap `paceBandFor` guards, and the reason
 * every reading here goes through one gate that rejects 0, NaN, Infinity,
 * negatives, and physiologically impossible values.
 */
const HRV_RANGE: [number, number] = [5, 300];
const RHR_RANGE: [number, number] = [25, 120];
const RECOVERY_RANGE: [number, number] = [1, 100];

function reading(v: number | null | undefined, [min, max]: [number, number]): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  if (v < min || v > max) return null;
  return v;
}

/**
 * Did this day's wellness row measure anything at all? Exported so the count
 * that feeds {@link ReadinessSignals.sampleDays} uses the same plausibility
 * gate as the verdict — a row whose only value is a COROS 0 is a row with no
 * reading, and must not inflate the sample.
 */
export function hasUsableReading(row: {
  hrv?: number | null;
  restingHeartRate?: number | null;
  recoveryScore?: number | null;
}): boolean {
  return (
    reading(row.hrv, HRV_RANGE) != null ||
    reading(row.restingHeartRate, RHR_RANGE) != null ||
    reading(row.recoveryScore, RECOVERY_RANGE) != null
  );
}

/** 0 = fine, 1 = caution, 2 = poor. Worst signal wins the verdict. */
type Rank = 0 | 1 | 2;
const LEVELS: Record<Rank, ReadinessLevel> = { 0: "good", 1: "caution", 2: "poor" };

/**
 * The verdict, or `null` when the evidence is too thin to have one.
 *
 * Null happens four ways: fewer than {@link MIN_SAMPLE_DAYS} days that
 * carried a reading, no usable reading at all, readings with nothing to
 * compare them to (an HRV with no baseline and no COROS recovery score is a
 * number, not a judgement), or — added 2026-08-16 — a lone all-clear with
 * nothing beside it. Callers render nothing in that case, never an empty slot.
 *
 * That last case is the audit's: on 2026-08-16 HRV and RHR were both null and
 * the only surviving signal was a recovery score that had read exactly 100 for
 * four days running. This function returned a confident `good — recovery 100%`
 * off it, the dock showed it, and the coach wrote "recovery reads 100%" to an
 * athlete five days off running. One unaccompanied normal number is not
 * evidence that you are fine. A lone WARNING still speaks — the asymmetry is
 * deliberate, since the cost of a missed warning is not the cost of a missed
 * reassurance — but it carries {@link SOLE_SIGNAL_NOTE} so no surface can
 * state the level without saying how thin it is.
 */
export function readinessVerdict(signals: ReadinessSignals): ReadinessVerdict | null {
  if (!Number.isFinite(signals.sampleDays) || signals.sampleDays < MIN_SAMPLE_DAYS) return null;

  const hrv = reading(signals.hrv, HRV_RANGE);
  const hrvBase = reading(signals.hrvBaseline, HRV_RANGE);
  const rhr = reading(signals.restingHeartRate, RHR_RANGE);
  const rhrBase = reading(signals.rhrBaseline, RHR_RANGE);
  const recovery = reading(signals.recoveryScore, RECOVERY_RANGE);

  // Signals that can be JUDGED (they have something to be measured against).
  const scored: Array<{ rank: Rank; reason: string }> = [];
  // Readings worth showing that carry no judgement — never enough on their
  // own to produce a verdict, but honest context once one exists.
  const context: string[] = [];

  if (hrv != null && hrvBase != null) {
    const dropPct = ((hrvBase - hrv) / hrvBase) * 100;
    const rank: Rank =
      dropPct >= HRV_POOR_DROP_PCT ? 2 : dropPct >= HRV_CAUTION_DROP_PCT ? 1 : 0;
    scored.push({
      rank,
      reason:
        rank > 0
          ? `HRV ${Math.round(dropPct)}% below your baseline`
          : `HRV ${Math.round(hrv)} (base ${Math.round(hrvBase)})`,
    });
  } else if (hrv != null) {
    context.push(`HRV ${Math.round(hrv)}`);
  }

  if (rhr != null && rhrBase != null) {
    const delta = rhr - rhrBase;
    const rank: Rank =
      delta >= RHR_POOR_DELTA_BPM ? 2 : delta >= RHR_CAUTION_DELTA_BPM ? 1 : 0;
    scored.push({
      rank,
      reason:
        rank > 0
          ? `RHR ${Math.round(delta)} bpm above your baseline`
          : `RHR ${Math.round(rhr)} (base ${Math.round(rhrBase)})`,
    });
  } else if (rhr != null) {
    context.push(`RHR ${Math.round(rhr)}`);
  }

  if (recovery != null) {
    const rank: Rank =
      recovery < RECOVERY_POOR_BELOW ? 2 : recovery < RECOVERY_CAUTION_BELOW ? 1 : 0;
    scored.push({ rank, reason: `recovery ${Math.round(recovery)}%` });
  }

  if (scored.length === 0) return null;

  const worst = scored.reduce<Rank>((w, s) => (s.rank > w ? s.rank : w), 0);
  // ONE judgeable signal and no other reading in sight. Withhold an all-clear
  // outright; let a warning through, labelled.
  const soleSignal = scored.length === 1 && context.length === 0;
  if (soleSignal && worst === 0) return null;

  // Stable sort (guaranteed since ES2019): worst first, otherwise the order
  // they were gathered in — HRV, RHR, recovery.
  const reasons = [...scored]
    .sort((a, b) => b.rank - a.rank)
    .map((s) => s.reason)
    .concat(context);
  if (soleSignal) reasons.push(SOLE_SIGNAL_NOTE);
  return { level: LEVELS[worst], reasons };
}

// ── Night classification (sleep/recovery 0020) ─────────────────────────────

export type NightState = "settled" | "low" | "gap";

export interface NightSignals {
  /** Overnight sleep HRV (ms) — daily_health.hrv IS avgSleepHrv. */
  hrv?: number | null;
  /** COROS's own band for that athlete: base ± sd. */
  sleepHrvBase?: number | null;
  sleepHrvSd?: number | null;
  /** COROS recovery 0–100 — the fallback when no band exists. */
  recoveryScore?: number | null;
}

/**
 * Did the night settle the body? One classifier shared by the garden's dew
 * input, the readiness sheet's night row, and the dashboard's night tile, so
 * every surface calls the same night by the same name.
 *
 * One-sided on purpose: only a LOW night is "low" — sleep HRV above the band
 * is not a problem to report. The sd fallback (10% of base) mirrors the
 * verdict's own noise floor. With neither a band nor a recovery score there
 * is no reading, and no reading is a "gap", never a guess — the same
 * withhold-rather-than-guess rule as the verdict above.
 */
export function nightState(signals: NightSignals): NightState {
  const { hrv, sleepHrvBase: base, recoveryScore } = signals;
  if (hrv != null && hrv > 0 && base != null && base > 0) {
    const sd = signals.sleepHrvSd != null && signals.sleepHrvSd > 0
      ? signals.sleepHrvSd
      : base * 0.1;
    return hrv >= base - sd ? "settled" : "low";
  }
  if (recoveryScore != null && recoveryScore >= 1 && recoveryScore <= 100) {
    return recoveryScore >= 60 ? "settled" : "low";
  }
  return "gap";
}
