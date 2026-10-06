/**
 * What an activity row shows of its logged sets (Phase 2a+ Task 3, mocks §8):
 * the performed session linked to the activity, its done sets grouped by
 * exercise in the order done. Every source counts; when more than one session
 * names the activity, the athlete's own record (the app's save, then a watch
 * review, then an import) wins over the watch copy the ingest derived.
 *
 * This is the DTO boundary: exercise ids become words here and nowhere else
 * (`exerciseDisplayName`), and weights are put in the athlete's unit — a
 * weight already in that unit stays exactly as typed; a converted one is
 * rounded to the half unit (`weightInUnit`).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { performedSessions, performedSets } from "@rg/database";
import { weightInUnit, type Weight, type WeightUnit } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { chunkIds, type Db } from "./db.js";
import { COROS_EXERCISE_PREFIX, WATCH_SOURCE } from "./watch-sets.js";

export interface LoggedSetDto {
  reps: number | null;
  seconds: number | null;
  /** In the athlete's weight unit; null for a bodyweight or timed set. */
  load: { v: number; u: WeightUnit } | null;
  side: "left" | "right" | null;
}

export interface LoggedExerciseDto {
  exerciseId: string;
  name: string;
  sets: LoggedSetDto[];
}

let libraryNames: Map<string, string> | null = null;

/** An exercise id as the athlete reads it: the library's name, COROS's English name for its key, or the key as sent. */
export function exerciseDisplayName(id: string): string {
  if (libraryNames === null) {
    libraryNames = new Map();
    for (const e of EXERCISES) {
      libraryNames.set(e.id, e.name);
      for (const legacy of e.legacyIds) if (!libraryNames.has(legacy)) libraryNames.set(legacy, e.name);
    }
  }
  const library = libraryNames.get(id);
  if (library) return library;
  if (id.startsWith(COROS_EXERCISE_PREFIX)) {
    const key = id.slice(COROS_EXERCISE_PREFIX.length);
    return COROS_EXERCISE_NAMES[key] ?? key;
  }
  return id;
}

/** Lower wins: the athlete's own record before the derived watch copy. */
const SOURCE_RANK: Record<string, number> = { app: 0, watch_review: 1, import: 2, [WATCH_SOURCE]: 3 };
const rank = (source: string): number => SOURCE_RANK[source] ?? 4;

export async function loggedSetsByActivity(
  db: Db,
  userId: string,
  activityIds: readonly string[],
  unit: WeightUnit,
): Promise<Map<string, LoggedExerciseDto[]>> {
  const sessions = (
    await Promise.all(
      chunkIds([...new Set(activityIds)]).map((ids) =>
        db
          .select({
            id: performedSessions.id,
            activityId: performedSessions.activityId,
            source: performedSessions.source,
            createdAt: performedSessions.createdAt,
          })
          .from(performedSessions)
          .where(and(eq(performedSessions.userId, userId), inArray(performedSessions.activityId, ids))),
      ),
    )
  ).flat();
  const chosen = new Map<string, (typeof sessions)[number]>();
  for (const s of sessions) {
    if (!s.activityId) continue;
    const held = chosen.get(s.activityId);
    if (!held || rank(s.source) < rank(held.source) || (rank(s.source) === rank(held.source) && s.createdAt < held.createdAt)) {
      chosen.set(s.activityId, s);
    }
  }
  const activityBySession = new Map([...chosen.values()].map((s) => [s.id, s.activityId!]));
  const sets = (
    await Promise.all(
      chunkIds([...activityBySession.keys()]).map((ids) =>
        db
          .select()
          .from(performedSets)
          .where(and(inArray(performedSets.performedSessionId, ids), eq(performedSets.done, true)))
          .orderBy(asc(performedSets.performedSessionId), asc(performedSets.entryIndex), asc(performedSets.setIndex)),
      ),
    )
  ).flat();

  const out = new Map<string, LoggedExerciseDto[]>();
  const current = new Map<string, { entryIndex: number; exercise: LoggedExerciseDto }>();
  for (const r of sets) {
    const activityId = activityBySession.get(r.performedSessionId)!;
    const list = out.get(activityId) ?? [];
    let at = current.get(activityId);
    if (!at || at.entryIndex !== r.entryIndex) {
      at = { entryIndex: r.entryIndex, exercise: { exerciseId: r.exerciseId, name: exerciseDisplayName(r.exerciseId), sets: [] } };
      current.set(activityId, at);
      list.push(at.exercise);
    }
    const typed: Weight | null =
      r.loadValue !== null && r.loadValue > 0 && (r.loadUnit === "lb" || r.loadUnit === "kg")
        ? { v: r.loadValue, u: r.loadUnit }
        : null;
    at.exercise.sets.push({
      reps: r.reps,
      seconds: r.seconds,
      load: typed ? { v: weightInUnit(typed, unit), u: unit } : null,
      side: r.side === "left" || r.side === "right" ? r.side : null,
    });
    out.set(activityId, list);
  }
  return out;
}
