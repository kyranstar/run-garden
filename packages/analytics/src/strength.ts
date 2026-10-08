import type { LocalDate, Weight, WeightUnit } from "@rg/domain";
import { addDays, startOfIsoWeek } from "@rg/domain";
import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";

/**
 * Strength progress from logged sets (Phase 2d Task 3; one-workout-system spec §12.2): weekly volume and a lift's
 * top sets. Kilograms inside, always — a set typed in pounds and one typed in kilograms are the same scale here — and
 * a weight is shown as it was typed: the best set keeps its typed weight, and a lift's line is labelled in the unit
 * the athlete used last (Review Focus 5).
 *
 * Both read a window of whole ISO weeks ending with today's (eight by default): what the Progress tiles draw. The
 * caller passes that window's sessions only, so the cost follows the window, never the history.
 */

/** The window the Progress tiles draw: this week and the seven before it. */
export const PROGRESS_WEEKS = 8;

/** One done, loaded set. */
export interface LoggedLoadSet {
  exerciseId: string;
  reps: number | null;
  /** The weight as typed. */
  load: Weight;
  /** The same weight in kilograms (what the save stored beside it). */
  kg: number;
  /** A one-sided move: a set logged with no side covered both sides. */
  perSide: boolean;
  /** The side a set logged one side at a time was. */
  side: "left" | "right" | null;
}

/** One performed session's loaded sets, in the order done. */
export interface StrengthSession {
  date: LocalDate;
  /** Orders sessions on one day (none first): the later one is the one used last. */
  startedAt: string | null;
  sets: readonly LoggedLoadSet[];
}

export interface WeeklyVolumeValue {
  /** Oldest first, every week of the window (a week with nothing is 0). */
  weeks: Array<{ weekStart: LocalDate; kg: number; sessions: number }>;
  /** This week's volume so far, in kilograms. */
  thisWeekKg: number;
}

export interface LiftTopSetsValue {
  /** Each week the lift was loaded, oldest first: its heaviest set, in kilograms. */
  series: Array<{ weekStart: LocalDate; kg: number }>;
  /** The heaviest set in the window, as typed (a tie goes to more reps, then the later). */
  best: { w: Weight; reps: number | null; date: LocalDate };
  /** The unit of the lift's most recent set: what its line is labelled in. */
  unit: WeightUnit;
}

const oneDecimal = (n: number): number => Math.round(n * 10) / 10;

/** The window's Mondays, oldest first, and its first day. */
function windowOf(today: LocalDate, weeks: number): { mondays: LocalDate[]; first: LocalDate } {
  const last = startOfIsoWeek(today);
  const mondays = Array.from({ length: weeks }, (_, i) => addDays(last, -7 * (weeks - 1 - i)));
  return { mondays, first: mondays[0]! };
}

const loaded = (s: LoggedLoadSet): boolean => Number.isFinite(s.kg) && s.kg > 0;

/** One set's volume: kilograms × reps, twice for a one-sided move's set that covered both sides. */
export function setVolumeKg(s: LoggedLoadSet): number {
  if (!loaded(s) || s.reps === null || !(s.reps > 0)) return 0;
  return s.kg * s.reps * (s.perSide && s.side === null ? 2 : 1);
}

/** Weight × reps of every logged set, per ISO week, both sides of a one-sided move. */
export function weeklyStrengthVolume(
  sessions: readonly StrengthSession[],
  today: LocalDate,
  weeks: number = PROGRESS_WEEKS,
): MetricResult<WeeklyVolumeValue> {
  const { mondays, first } = windowOf(today, weeks);
  const acc = new Map(mondays.map((m) => [m, { kg: 0, sessions: 0 }]));
  let counted = 0;
  for (const s of sessions) {
    if (s.date < first || s.date > today) continue;
    const kg = s.sets.reduce((n, x) => n + setVolumeKg(x), 0);
    if (kg <= 0) continue;
    const bucket = acc.get(startOfIsoWeek(s.date))!;
    bucket.kg += kg;
    bucket.sessions += 1;
    counted += 1;
  }
  if (counted === 0) {
    return insufficient(1, 0, `Weekly volume needs a set logged with a weight and reps in the last ${weeks} weeks.`);
  }
  const out = mondays.map((weekStart) => ({ weekStart, kg: oneDecimal(acc.get(weekStart)!.kg), sessions: acc.get(weekStart)!.sessions }));
  return ok(
    { weeks: out, thisWeekKg: out[out.length - 1]!.kg },
    counted,
    "Weight × reps of every logged set, both sides of a one-sided move, per week from Monday; kilograms whatever was typed.",
  );
}

/** Sessions oldest first: by day, then start (none first), then as given. */
function chronological(sessions: readonly StrengthSession[]): StrengthSession[] {
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (a.s.date !== b.s.date) return a.s.date < b.s.date ? -1 : 1;
      const x = a.s.startedAt;
      const y = b.s.startedAt;
      if (x !== y) return x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
      return a.i - b.i;
    })
    .map((e) => e.s);
}

/** A lift's heaviest set each week it was loaded, in kilograms, labelled in the unit it was last logged in. */
export function liftTopSets(
  sessions: readonly StrengthSession[],
  exerciseId: string,
  today: LocalDate,
  weeks: number = PROGRESS_WEEKS,
): MetricResult<LiftTopSetsValue> {
  const { first } = windowOf(today, weeks);
  const top = new Map<LocalDate, number>();
  let best: { set: LoggedLoadSet; date: LocalDate } | null = null;
  let unit: WeightUnit | null = null;
  let logged = 0;
  for (const s of chronological(sessions)) {
    if (s.date < first || s.date > today) continue;
    const sets = s.sets.filter((x) => x.exerciseId === exerciseId && loaded(x));
    if (sets.length === 0) continue;
    logged += 1;
    const week = startOfIsoWeek(s.date);
    for (const x of sets) {
      top.set(week, Math.max(top.get(week) ?? 0, x.kg));
      const reps = x.reps ?? 0;
      // Later sessions come later: `>=` on a full tie keeps the later set.
      if (!best || x.kg > best.set.kg || (x.kg === best.set.kg && reps >= (best.set.reps ?? 0))) best = { set: x, date: s.date };
      unit = x.load.u;
    }
  }
  if (top.size < 2 || !best || !unit) {
    return insufficient(2, top.size, "A lift's line needs top sets from two different weeks.");
  }
  const series = [...top.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([weekStart, kg]) => ({ weekStart, kg }));
  return ok(
    { series, best: { w: { v: best.set.load.v, u: best.set.load.u }, reps: best.set.reps, date: best.date }, unit },
    logged,
    "Each week's heaviest logged set of this lift, compared in kilograms; labelled in the unit last used.",
  );
}
