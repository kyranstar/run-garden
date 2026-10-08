/**
 * THE STANDALONE TOOL'S PROGRESS NUMBERS, PORTED (Phase 2c plan Task 4: the import's oracle). The owner compares what
 * the import reports with the tool's Progress tab, so these are the tool's own `Stats` — week starts on Monday,
 * session volume as the kilos of every loaded rep (both sides of a per-side lift), weekly buckets oldest first — run
 * over sessions in Run Garden's shape (the import's normaliser, so a pass-1 `bilateral` and a version-2 `perSide`
 * both count twice). Their expectations are the standalone `tests/stats.test.js`, ported in standalone-stats.test.ts.
 */
import { addDays as addLocalDays, startOfIsoWeek, toKg, type Weight } from "@rg/domain";

/** What the numbers read of a session. */
export interface StatsSession {
  localDate: string;
  seconds: number;
  entries: ReadonlyArray<{ perSide: boolean; sets: ReadonlyArray<{ load: Weight | null; reps: number | null; done?: boolean }> }>;
}

export interface WeekBucket {
  /** The week's Monday. */
  week: string;
  sessions: number;
  minutes: number;
  /** Kilos lifted that week, to one decimal. */
  volumeKg: number;
}

const weekStart = (date: string): string => startOfIsoWeek(date);
const addDays = (date: string, days: number): string => addLocalDays(date, days);

/** Every loaded set with reps: its kilos × reps, twice for a lift done per side. */
function sessionVolumeKg(s: StatsSession): number {
  let total = 0;
  for (const e of s.entries) {
    const sides = e.perSide ? 2 : 1;
    for (const set of e.sets) {
      if (set.done === false || !set.load || !(set.load.v > 0) || set.reps == null || !(set.reps > 0)) continue;
      total += toKg(set.load) * set.reps * sides;
    }
  }
  return total;
}

const oneDecimal = (n: number): number => Math.round(n * 10) / 10;

/** The `n` weeks ending with `today`'s, oldest first: sessions, minutes and volume in each. */
function weekly(sessions: readonly StatsSession[], n: number, today: string): WeekBucket[] {
  const last = weekStart(today);
  const weeks = Array.from({ length: n }, (_, i) => addDays(last, -7 * (n - 1 - i)));
  const acc = new Map(weeks.map((w) => [w, { sessions: 0, seconds: 0, volume: 0 }]));
  for (const s of sessions) {
    const bucket = acc.get(weekStart(s.localDate));
    if (!bucket) continue;
    bucket.sessions += 1;
    bucket.seconds += s.seconds;
    bucket.volume += sessionVolumeKg(s);
  }
  return weeks.map((week) => {
    const b = acc.get(week)!;
    return { week, sessions: b.sessions, minutes: Math.round(b.seconds / 60), volumeKg: oneDecimal(b.volume) };
  });
}

export const Stats = { weekStart, addDays, sessionVolumeKg, weekly };
