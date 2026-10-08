/**
 * THE STANDALONE TOOL'S PROGRESS NUMBERS, PORTED (Phase 2c plan Task 4: the import's oracle; Audit 2c-A MINOR-1). The
 * owner compares what the import reports with the tool's Progress tab, so these are the tool's own `Stats` (its
 * js/stats.js) run over the sessions IN THE TOOL'S OWN SHAPE, as the backup holds them — not over Run Garden's
 * normalised sessions, which no longer carry what the tool's rules read:
 *
 *  - a session's volume counts only entries the tool logs as `load` × `reps`, and every set with a weight and reps
 *    in them (the tool has no "done" rule), twice for a lift done per side (`perSide`, or pass 1's `bilateral`);
 *  - weeks start on Monday, oldest first; a week's volume is WHOLE kilos, as the tool keeps it;
 *  - the Progress tab shows a week's volume as `Math.round(unitVolume(volumeKg))` — whole, in the tool's unit, from
 *    the whole kilos (`volumeInUnit`);
 *  - a lift's tile shows the last session's top set (`lifts`: the heaviest weight, the best reps at it; a bodyweight
 *    move's best reps; the longest hold), leaving ladders and circuits out.
 *
 * Their expectations are the standalone `tests/stats.test.js`, ported in standalone-stats.test.ts; one oracle case's
 * expectations were printed by the tool's own js/stats.js (test/fixtures/standalone-oracle-case.ts).
 *
 * A weight the tool kept as a bare number is in the tool's unit (its settings), as the import reads it.
 */
import { addDays as addLocalDays, KG_TO_LB, startOfIsoWeek, toKg, type Weight, type WeightUnit } from "@rg/domain";

/** A logged set as the tool keeps it. */
export interface ToolSet {
  w?: unknown;
  reps?: number | null;
  secs?: number | null;
  done?: boolean;
}

/** An entry as the tool keeps it: `log` and `metric` say how it was logged ("load" × "reps" is a lift). */
export interface ToolEntry {
  id: string;
  log?: unknown;
  metric?: unknown;
  perSide?: boolean;
  bilateral?: boolean;
  format?: string | null;
  sets: ReadonlyArray<ToolSet | null>;
}

/** A session as the tool keeps it (the backup's own shape, checked by the import's session schema). */
export interface ToolSession {
  id?: string;
  date: string;
  seconds?: number | null;
  pre?: number | null;
  post?: number | null;
  entries: ReadonlyArray<ToolEntry>;
}

export interface WeekBucket {
  /** The week's Monday. */
  week: string;
  sessions: number;
  minutes: number;
  /** Kilos lifted that week, whole, as the tool keeps them. */
  volumeKg: number;
}

/** One point of a lift's series: the session's top set. */
export interface LiftPoint {
  date: string;
  /** The heaviest weight, as typed; null for a bodyweight move or a hold. */
  top: Weight | null;
  topKg: number | null;
  reps: number | null;
  secs: number | null;
}

const weekStart = (date: string): string => startOfIsoWeek(date);
const addDays = (date: string, days: number): string => addLocalDays(date, days);

/** A set's weight: `{v, u}` as typed, or a bare number in the tool's unit; anything else is no weight. */
function weightOf(w: unknown, unit: WeightUnit): Weight | null {
  if (typeof w === "number") return Number.isFinite(w) && w !== 0 ? { v: w, u: unit } : null;
  if (w && typeof w === "object") {
    const { v, u } = w as { v?: unknown; u?: unknown };
    if (typeof v === "number" && Number.isFinite(v) && v !== 0 && (u === "lb" || u === "kg")) return { v, u };
  }
  return null;
}

const perSide = (e: ToolEntry): boolean => Boolean(e.perSide ?? e.bilateral);

/** The tool's `sessionVolumeKg`: every set with a weight and reps of an entry logged as load × reps, per side ×2. */
function sessionVolumeKg(s: Pick<ToolSession, "entries">, unit: WeightUnit): number {
  let total = 0;
  for (const entry of s.entries ?? []) {
    if (entry.log !== "load" || entry.metric !== "reps") continue;
    for (const set of entry.sets ?? []) {
      const w = set ? weightOf(set.w, unit) : null;
      if (set && w && set.reps) total += toKg(w) * set.reps * (perSide(entry) ? 2 : 1);
    }
  }
  return total;
}

/** The tool's `weekly`: the `n` weeks ending with `today`'s, oldest first — sessions, minutes, whole kilos. */
function weekly(sessions: readonly ToolSession[], n: number, today: string, unit: WeightUnit): WeekBucket[] {
  const current = weekStart(today);
  const buckets = Array.from({ length: n }, (_, i) => ({ week: addDays(current, -7 * (n - 1 - i)), sessions: 0, minutes: 0, volumeKg: 0 }));
  const index = new Map(buckets.map((b, i) => [b.week, i]));
  for (const s of sessions) {
    const i = index.get(weekStart(s.date));
    if (i === undefined) continue;
    buckets[i]!.sessions += 1;
    buckets[i]!.minutes += (s.seconds || 0) / 60;
    buckets[i]!.volumeKg += sessionVolumeKg(s, unit);
  }
  return buckets.map((b) => ({ ...b, minutes: Math.round(b.minutes), volumeKg: Math.round(b.volumeKg) }));
}

/** A week's volume as the Progress tab shows it: whole, in the tool's unit, from the whole kilos. */
function volumeInUnit(volumeKg: number, unit: WeightUnit): number {
  return Math.round(unit === "kg" ? volumeKg : volumeKg * KG_TO_LB);
}

/**
 * The tool's `lifts`: per move, one point per session — the heaviest set (and the best reps at it), else the best
 * reps, with the longest hold. Ladders and circuits are left out (their sets are deliberately light). Moves in the
 * order first seen; points in session order.
 */
function lifts(sessions: readonly ToolSession[], unit: WeightUnit): Array<{ id: string; points: LiftPoint[] }> {
  const out = new Map<string, { id: string; points: LiftPoint[] }>();
  for (const s of sessions) {
    for (const entry of s.entries ?? []) {
      if (!entry || !entry.id || entry.format === "ladder" || entry.format === "circuit") continue;
      const sets = (entry.sets ?? []).flatMap((set) => {
        if (!set) return [];
        const w = weightOf(set.w, unit);
        return w || set.reps != null || set.secs ? [{ w, reps: set.reps ?? null, secs: set.secs ?? null }] : [];
      });
      if (sets.length === 0) continue;
      const bestSecs = Math.max(0, ...sets.map((set) => set.secs || 0)) || null;
      const loaded = sets.filter((set) => set.w);
      let point: LiftPoint;
      if (loaded.length) {
        const topKg = Math.max(...loaded.map((set) => toKg(set.w!)));
        const atTop = loaded.filter((set) => Math.abs(toKg(set.w!) - topKg) < 0.05);
        const reps = atTop.some((set) => set.reps != null) ? Math.max(...atTop.map((set) => set.reps ?? 0)) : null;
        point = { date: s.date, top: atTop[0]!.w, topKg, reps, secs: bestSecs };
      } else {
        const reps = sets.some((set) => set.reps != null) ? Math.max(...sets.map((set) => set.reps ?? 0)) : null;
        point = { date: s.date, top: null, topKg: null, reps, secs: bestSecs };
      }
      if (!out.has(entry.id)) out.set(entry.id, { id: entry.id, points: [] });
      out.get(entry.id)!.points.push(point);
    }
  }
  return [...out.values()];
}

export const Stats = { weekStart, addDays, sessionVolumeKg, weekly, volumeInUnit, lifts };
