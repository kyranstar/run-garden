import type { ActivityLap, LocalDate, NormalizedActivity, WorkoutCategory } from "@rg/domain";
import { addDays, daysBetween } from "@rg/domain";
import { computeAerobicEfficiency } from "./aerobicEfficiency.js";
import { sessionNoun, type Discipline } from "./discipline.js";

/**
 * "Invisible personal records": achievements a watch never surfaces, each with
 * a deterministic comparison rule. Records lacking data are simply omitted —
 * no fake records, no extrapolation.
 */

export interface RunSample {
  activity: NormalizedActivity;
  laps: ActivityLap[];
  category: WorkoutCategory;
}

export interface PersonalRecord {
  id: string;
  title: string;
  /** Human-formatted value, e.g. "1.29 m/beat". */
  value: string;
  achievedOn: LocalDate;
  /** One-sentence deterministic definition of the comparison. */
  rule: string;
}

export interface RecordsInput {
  /** Full session history for this discipline, in the module 3/4 input shape. */
  runs: RunSample[];
  /** Weekly adherence series, e.g. from computeConsistency().weeklyBreakdown. */
  weeklyAdherence: Array<{ weekStart: LocalDate; adherence: number }>;
  /** LocalDates of every completed session in this discipline's history. */
  completedRunDates: LocalDate[];
  /**
   * Which discipline these records describe. Ids are namespaced by it so one
   * discipline's never-regress merge can never suppress another's.
   */
  discipline: Discipline;
}

/** A personal record with the raw comparison value used for never-regress merges. Higher `numeric` is always better. */
export type ScoredRecord = PersonalRecord & { numeric: number };

/** Persisted shape of a record, carrying the `numeric` value that survives across regenerations. */
export interface StoredRecord {
  id: string;
  title: string;
  value: string;
  achievedOn: LocalDate;
  rule: string;
  numeric: number;
}

const MIN_EFFICIENCY_RUNS = 5;
const MIN_ADHERENCE_WEEKS = 8;
/**
 * History needed before "longest" or "most" means anything. Naming a longest
 * session out of three is not a record, it is just the biggest of three — and
 * this module does not produce records it cannot stand behind.
 */
const MIN_SESSIONS_FOR_RECORD = 5;
/** A week or a streak below this is ordinary, not an achievement. */
const MIN_NOTABLE_COUNT = 3;
const BREAK_DAYS = 7;
const STREAK_LENGTH = 3;
const STREAK_MAX_GAP_DAYS = 3;

function bestAerobicEfficiency(runs: RunSample[]): ScoredRecord | null {
  const result = computeAerobicEfficiency(runs);
  if (result.status !== "ok" || result.sampleSize < MIN_EFFICIENCY_RUNS) return null;
  let best = result.value.perRun[0]!;
  for (const p of result.value.perRun) {
    if (p.efficiency > best.efficiency) best = p;
  }
  return {
    id: "best_aerobic_efficiency",
    title: "Best aerobic efficiency",
    value: `${best.efficiency.toFixed(2)} m/beat`,
    achievedOn: best.date,
    rule: "Highest meters travelled per heart beat on any eligible easy or recovery run of 25+ minutes with heart rate.",
    numeric: best.efficiency,
  };
}

function mostConsistentFourWeeks(
  weeks: Array<{ weekStart: LocalDate; adherence: number }>,
): ScoredRecord | null {
  const sorted = [...weeks].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  if (sorted.length < MIN_ADHERENCE_WEEKS) return null;
  let best: { start: LocalDate; minAdherence: number } | null = null;
  for (let i = 0; i + 3 < sorted.length; i++) {
    const window = sorted.slice(i, i + 4);
    const consecutive = window.every(
      (w, j) => j === 0 || daysBetween(window[j - 1]!.weekStart, w.weekStart) === 7,
    );
    if (!consecutive) continue;
    const minAdherence = Math.min(...window.map((w) => w.adherence));
    if (best == null || minAdherence > best.minAdherence) {
      best = { start: window[0]!.weekStart, minAdherence };
    }
  }
  if (best == null) return null;
  return {
    id: "most_consistent_four_weeks",
    title: "Most consistent four weeks",
    value: `${Math.round(best.minAdherence * 100)}% adherence in the weakest week`,
    achievedOn: addDays(best.start, 27),
    rule: "Across every stretch of 4 consecutive weeks, the highest value of the lowest weekly adherence.",
    numeric: best.minAdherence,
  };
}

function fastestComebackDays(completedRunDates: LocalDate[]): ScoredRecord | null {
  const dates = [...new Set(completedRunDates)].sort();
  let best: { days: number; achievedOn: LocalDate } | null = null;
  for (let i = 0; i + 1 < dates.length; i++) {
    if (daysBetween(dates[i]!, dates[i + 1]!) < BREAK_DAYS) continue;
    // A break ends at dates[i+1]; look for the first 3-run streak after it,
    // stopping if another break begins first.
    for (let j = i + 1; j + STREAK_LENGTH - 1 < dates.length; j++) {
      if (j > i + 1 && daysBetween(dates[j - 1]!, dates[j]!) >= BREAK_DAYS) break;
      const gapsOk =
        daysBetween(dates[j]!, dates[j + 1]!) <= STREAK_MAX_GAP_DAYS &&
        daysBetween(dates[j + 1]!, dates[j + 2]!) <= STREAK_MAX_GAP_DAYS;
      if (!gapsOk) continue;
      const days = daysBetween(dates[i + 1]!, dates[j + 2]!);
      if (best == null || days < best.days) best = { days, achievedOn: dates[j + 2]! };
      break;
    }
  }
  if (best == null) return null;
  return {
    id: "fastest_comeback_days",
    title: "Fastest comeback",
    value: `${best.days} days`,
    achievedOn: best.achievedOn,
    rule: "Fewest days from the first run after a break of 7+ days until three runs each within 3 days of the previous.",
    // Faster comebacks (fewer days) must score higher, so negate.
    numeric: -best.days,
  };
}

/** Longest single session by moving time. Real for every discipline. */
function longestSession(runs: RunSample[], discipline: Discipline): ScoredRecord | null {
  if (runs.length < MIN_SESSIONS_FOR_RECORD) return null;
  let best = runs[0]!;
  for (const r of runs) {
    if (r.activity.durationSeconds > best.activity.durationSeconds) best = r;
  }
  const secs = best.activity.durationSeconds;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return {
    id: "longest_session",
    title: `Longest ${sessionNoun(discipline)}`,
    value: h > 0 ? `${h}h ${m}m` : `${m}m`,
    achievedOn: (best.activity.startTimeLocal ?? best.activity.startTime).slice(0, 10),
    rule: `Longest single ${sessionNoun(discipline)} by moving time.`,
    numeric: secs,
  };
}

/** Busiest rolling 7-day window. Two sessions is not a record worth naming. */
function mostSessionsInAWeek(dates: LocalDate[], discipline: Discipline): ScoredRecord | null {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length < MIN_SESSIONS_FOR_RECORD) return null;
  let best: { count: number; endedOn: LocalDate } | null = null;
  for (const windowEnd of sorted) {
    const count = sorted.filter((d) => d <= windowEnd && daysBetween(d, windowEnd) < 7).length;
    if (best == null || count > best.count) best = { count, endedOn: windowEnd };
  }
  if (best == null || best.count < MIN_NOTABLE_COUNT) return null;
  return {
    id: "most_sessions_in_a_week",
    title: `Most ${sessionNoun(discipline, true)} in a week`,
    value: `${best.count}`,
    achievedOn: best.endedOn,
    rule: `Highest count of ${sessionNoun(discipline, true)} in any rolling 7-day window.`,
    numeric: best.count,
  };
}

/** Longest unbroken run of sessions, each within a week of the last. */
function longestStreak(dates: LocalDate[], discipline: Discipline): ScoredRecord | null {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length < MIN_SESSIONS_FOR_RECORD) return null;
  let best: { length: number; endedOn: LocalDate } | null = null;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (daysBetween(sorted[i - 1]!, sorted[i]!) <= 7) {
      current += 1;
      if (best == null || current > best.length) best = { length: current, endedOn: sorted[i]! };
    } else {
      current = 1;
    }
  }
  if (best == null || best.length < MIN_NOTABLE_COUNT) return null;
  return {
    id: "longest_streak",
    title: `Longest ${sessionNoun(discipline)} streak`,
    value: `${best.length} sessions`,
    achievedOn: best.endedOn,
    rule: `Most consecutive ${sessionNoun(discipline, true)} each within 7 days of the previous.`,
    numeric: best.length,
  };
}

export function computeRecords(input: RecordsInput): ScoredRecord[] {
  const records: ScoredRecord[] = [];
  const push = (r: ScoredRecord | null) => {
    // Namespaced by discipline: mergeRecords keys on id, so a shared id would
    // let a run's longest session outrank — and hide — a yoga one.
    if (r != null) records.push({ ...r, id: `${input.discipline}:${r.id}` });
  };
  // Pace-based: meaningless without distance, so runs only.
  if (input.discipline === "run") push(bestAerobicEfficiency(input.runs));
  push(mostConsistentFourWeeks(input.weeklyAdherence));
  push(fastestComebackDays(input.completedRunDates));
  push(longestSession(input.runs, input.discipline));
  push(mostSessionsInAWeek(input.completedRunDates, input.discipline));
  push(longestStreak(input.completedRunDates, input.discipline));
  return records;
}

/**
 * Merge freshly computed records into the persisted set without ever
 * regressing: per id, keep whichever record has the better (higher)
 * `numeric` value; ties favor the stored record. A stored record with no
 * fresh counterpart survives unchanged, and a fresh record with no stored
 * counterpart is added. The result is sorted by id for determinism.
 */
export function mergeRecords(fresh: ScoredRecord[], stored: StoredRecord[]): StoredRecord[] {
  const byId = new Map<string, StoredRecord>();
  for (const s of stored) byId.set(s.id, s);
  for (const f of fresh) {
    const existing = byId.get(f.id);
    if (existing == null || f.numeric > existing.numeric) {
      byId.set(f.id, {
        id: f.id,
        title: f.title,
        value: f.value,
        achievedOn: f.achievedOn,
        rule: f.rule,
        numeric: f.numeric,
      });
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
