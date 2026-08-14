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
  /** How many days of wellness data the baseline was drawn from. */
  sampleDays: number;
}

/** Under three days there is no "usual" to be unusual against. Same floor the
 * Today screen's Readiness card already uses — one number, not two. */
const MIN_SAMPLE_DAYS = 3;

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

/** 0 = fine, 1 = caution, 2 = poor. Worst signal wins the verdict. */
type Rank = 0 | 1 | 2;
const LEVELS: Record<Rank, ReadinessLevel> = { 0: "good", 1: "caution", 2: "poor" };

/**
 * The verdict, or `null` when the evidence is too thin to have one.
 *
 * Null happens three ways: fewer than {@link MIN_SAMPLE_DAYS} days of data,
 * no usable reading at all, or readings with nothing to compare them to (an
 * HRV with no baseline and no COROS recovery score is a number, not a
 * judgement). Callers render nothing in that case — never an empty slot.
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
  // Stable sort (guaranteed since ES2019): worst first, otherwise the order
  // they were gathered in — HRV, RHR, recovery.
  const reasons = [...scored]
    .sort((a, b) => b.rank - a.rank)
    .map((s) => s.reason)
    .concat(context);
  return { level: LEVELS[worst], reasons };
}
