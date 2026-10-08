import type { LocalDate } from "@rg/domain";
import { addDays, startOfIsoWeek } from "@rg/domain";
import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { mean } from "./stats.js";
import { PROGRESS_WEEKS } from "./strength.js";

/**
 * The condition trend (Phase 2d Task 3; spec §2d "Progress"): one condition profile's check before and after each
 * session over the last eight weeks, and its flare days. A before/after mean is only a trend with enough pairs
 * behind it — below MIN_CONDITION_PAIRS the result says how many more sessions it needs and nothing else (Review
 * Focus 4). Nothing here names a condition: the flare rule is the profile's own, passed in, and the words are the
 * profile's (the caller labels the result).
 */

/** Sessions with both a before and an after check needed before the means are shown. */
export const MIN_CONDITION_PAIRS = 4;

/** One performed session's check for the profile. */
export interface ConditionSession {
  date: LocalDate;
  pre: number | null;
  post: number | null;
}

/** One reading of the day for the profile — a daily check, or a session's pre-check. */
export interface ConditionReading {
  date: LocalDate;
  value: number | null;
  feelingOff: boolean;
}

export interface ConditionTrendValue {
  /** The means over the paired sessions, to one decimal. */
  preMean: number;
  postMean: number;
  pairs: number;
  /** Every week of the window, oldest first: the mean before and after of its pairs (null without one). */
  weeks: Array<{ weekStart: LocalDate; pre: number | null; post: number | null }>;
  /** Days in the window with a reading the profile calls a flare. */
  flareDays: number;
}

const oneDecimal = (n: number): number => Math.round(n * 10) / 10;

export function conditionTrend(
  input: {
    sessions: readonly ConditionSession[];
    readings: readonly ConditionReading[];
    /** The profile's flare rule over a day's reading (`ConditionProfile.flare`). */
    isFlare: (reading: { pre: number | null; post: number | null; feelingOff: boolean }) => boolean;
  },
  today: LocalDate,
  weeks: number = PROGRESS_WEEKS,
): MetricResult<ConditionTrendValue> {
  const last = startOfIsoWeek(today);
  const mondays = Array.from({ length: weeks }, (_, i) => addDays(last, -7 * (weeks - 1 - i)));
  const first = mondays[0]!;
  const inWindow = (d: LocalDate) => d >= first && d <= today;

  const pairs = input.sessions.filter(
    (s): s is ConditionSession & { pre: number; post: number } => inWindow(s.date) && s.pre !== null && s.post !== null,
  );
  if (pairs.length < MIN_CONDITION_PAIRS) {
    const more = MIN_CONDITION_PAIRS - pairs.length;
    return insufficient(
      MIN_CONDITION_PAIRS,
      pairs.length,
      `Before and after needs ${MIN_CONDITION_PAIRS} sessions with both checks in the last ${weeks} weeks; ${more} more to go.`,
    );
  }
  const byWeek = new Map<LocalDate, Array<{ pre: number; post: number }>>();
  for (const p of pairs) {
    const week = startOfIsoWeek(p.date);
    byWeek.set(week, [...(byWeek.get(week) ?? []), p]);
  }
  const flareDates = new Set(
    input.readings
      .filter((r) => inWindow(r.date) && input.isFlare({ pre: r.value, post: null, feelingOff: r.feelingOff }))
      .map((r) => r.date),
  );
  return ok(
    {
      preMean: oneDecimal(mean(pairs.map((p) => p.pre))),
      postMean: oneDecimal(mean(pairs.map((p) => p.post))),
      pairs: pairs.length,
      weeks: mondays.map((weekStart) => {
        const w = byWeek.get(weekStart);
        return w
          ? { weekStart, pre: oneDecimal(mean(w.map((p) => p.pre))), post: oneDecimal(mean(w.map((p) => p.post))) }
          : { weekStart, pre: null, post: null };
      }),
      flareDays: flareDates.size,
    },
    pairs.length,
    `The check before and after each session with both, over the last ${weeks} weeks.`,
  );
}
