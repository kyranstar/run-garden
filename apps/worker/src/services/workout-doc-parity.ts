/**
 * THE PARITY DIAGNOSTIC (programme spec §3, Task 12): read-only. For each planned workout of the signed-in account it
 * asks whether the stored workout document and the old formats still agree: the row's own minutes, discipline and
 * title, and the steps of its latest build. Counts and ids only; no title or personal text leaves this module.
 *
 * Rules: a null column is `missing`, an unparsable one `invalid` (never thrown). Rest-day rows carry no document by
 * design and are exempt. Minutes differ only past max(3 min, 20 % of the row's minutes). Steps are compared as
 * multisets of library ids, canonicalised through `legacyIds` on both sides, so a renamed move is not a mismatch.
 */
import { and, asc, eq, getTableColumns, gt, inArray, isNull, sql } from "drizzle-orm";
import { plannedWorkouts, sessionBuilds } from "@rg/database";
import { parseStoredWorkoutDoc, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { deriveDoc, makeLibraryIndex, playerStepsFromDoc } from "@rg/workout";
import { chunkIds, type Db } from "./db.js";

export type ParityField = "minutes" | "discipline" | "title" | "steps";

export interface ParityReport {
  checked: number;
  withDoc: number;
  missing: number;
  invalid: number;
  exempt: number;
  /** Rows with a document but no source or fallback estimate: minutes not compared. */
  unestimated: number;
  /** Rows whose chosen build predates the current document: steps not compared. */
  stale: number;
  mismatched: Array<{ id: string; field: ParityField }>;
  /** Ids of rows with no usable document (missing or invalid), capped. */
  sample: string[];
  /** Pass as `after` for the next page; null when this was the last. */
  next: string | null;
}

const SAMPLE_CAP = 10;
export const PARITY_DEFAULT_LIMIT = 100;
export const PARITY_MAX_LIMIT = 200;

/** Minutes differ only past the larger of 3 minutes and 20 % of the row's minutes. */
export function minutesDiffer(docMinutes: number, rowMinutes: number): boolean {
  return Math.abs(docMinutes - rowMinutes) > Math.max(3, 0.2 * rowMinutes);
}

/** The garden's axis a planned row's category stands for. */
function axisOfCategory(category: string): "run" | "strength" | "yoga" | null {
  if (category === "strength") return "strength";
  if (category === "yoga") return "yoga";
  if (["easy", "long", "quality", "recovery", "race"].includes(category)) return "run";
  return null;
}

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * planned_workouts' columns with the document read as RAW text. Drizzle's json mode parses on read and throws on a
 * malformed column, which would fail a whole page; `parseStoredWorkoutDoc` takes the string and never throws.
 */
export function plannedWorkoutColumns() {
  const { workoutDoc: _decoded, ...rest } = getTableColumns(plannedWorkouts);
  return { ...rest, workoutDoc: sql<string | null>`${plannedWorkouts.workoutDoc}` };
}

interface DurationColumns {
  sourceEstimatedDurationSeconds: number | null;
  fallbackEstimatedDurationSeconds: number | null;
  calendarBlockDurationSeconds: number;
}

/** The row's own estimate in minutes, or null when it has none (the calendar slot is not an estimate). */
export function estimatedRowMinutes(row: DurationColumns): number | null {
  const sec = row.sourceEstimatedDurationSeconds ?? row.fallbackEstimatedDurationSeconds;
  return sec === null ? null : Math.round(sec / 60);
}

/**
 * Minutes to SHOW for a row: the estimate, else the calendar slot. Display only (the list route); the parity check
 * never compares against the slot, which carries buffer and is not what the row claims the session lasts.
 */
export function rowMinutes(row: DurationColumns): number {
  return estimatedRowMinutes(row) ?? Math.round(row.calendarBlockDurationSeconds / 60);
}

export async function checkWorkoutDocParity(
  db: Db,
  userId: string,
  opts: { after?: string; limit?: number } = {},
  library: readonly ExerciseRecord[] = EXERCISES,
): Promise<ParityReport> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? PARITY_DEFAULT_LIMIT) || PARITY_DEFAULT_LIMIT, 1), PARITY_MAX_LIMIT);
  const rows = await db
    .select(plannedWorkoutColumns())
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        isNull(plannedWorkouts.archivedAt),
        ...(opts.after ? [gt(plannedWorkouts.id, opts.after)] : []),
      ),
    )
    .orderBy(asc(plannedWorkouts.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? page[page.length - 1]!.id : null;

  const report: ParityReport = { checked: 0, withDoc: 0, missing: 0, invalid: 0, exempt: 0, unestimated: 0, stale: 0, mismatched: [], sample: [], next };
  const parsed = new Map<string, WorkoutDoc>();
  for (const row of page) {
    if (row.category === "rest") {
      report.exempt++;
      continue;
    }
    report.checked++;
    const doc = parseStoredWorkoutDoc(row.workoutDoc);
    if (doc) {
      parsed.set(row.id, doc);
      report.withDoc++;
      continue;
    }
    // null / undefined column = missing; anything stored that does not parse = invalid.
    if (row.workoutDoc === null || row.workoutDoc === undefined) report.missing++;
    else report.invalid++;
    if (report.sample.length < SAMPLE_CAP) report.sample.push(row.id);
  }

  // The build that was played (the locked one, highest version) if any, else the latest: one statement per chunk of ids.
  // The version is tracked before the steps are read, so an older build's steps never stand in for a newer one's.
  interface Chosen { locked: boolean; version: number; createdAt: string; buildDoc: unknown; steps: unknown }
  const chosen = new Map<string, Chosen>();
  for (const ids of chunkIds([...parsed.keys()], 90)) {
    const builds = await db
      .select({
        workoutId: sessionBuilds.workoutId,
        version: sessionBuilds.version,
        payload: sessionBuilds.payload,
        workoutDoc: sql<string | null>`${sessionBuilds.workoutDoc}`,
        lockedAt: sessionBuilds.lockedAt,
        createdAt: sessionBuilds.createdAt,
      })
      .from(sessionBuilds)
      .where(and(eq(sessionBuilds.userId, userId), inArray(sessionBuilds.workoutId, ids)));
    for (const b of builds) {
      const locked = b.lockedAt !== null;
      const seen = chosen.get(b.workoutId);
      if (seen && (seen.locked !== locked ? seen.locked : seen.version >= b.version)) continue;
      chosen.set(b.workoutId, {
        locked,
        version: b.version,
        createdAt: b.createdAt,
        buildDoc: b.workoutDoc,
        steps: (b.payload as { steps?: unknown } | null)?.steps,
      });
    }
  }

  const find = makeLibraryIndex(library);
  const canon = (id: string): string => find(id)?.id ?? id;
  for (const row of page) {
    const doc = parsed.get(row.id);
    if (!doc) continue;
    const derived = deriveDoc(doc, library);
    const rowMin = estimatedRowMinutes(row);
    if (rowMin === null) report.unestimated++;
    else if (minutesDiffer(derived.estimatedMinutes, rowMin)) report.mismatched.push({ id: row.id, field: "minutes" });
    const axis = axisOfCategory(row.category);
    if (axis !== null && axis !== derived.discipline) report.mismatched.push({ id: row.id, field: "discipline" });
    if (norm(doc.title) !== norm(row.title)) report.mismatched.push({ id: row.id, field: "title" });
    const build = chosen.get(row.id);
    if (build && Array.isArray(build.steps)) {
      // A build made before the document last changed says nothing about it: counted, not compared. A build that
      // stored the document it was made from is stale when that differs; one that did not, when it predates the row.
      const builtFrom = parseStoredWorkoutDoc(build.buildDoc);
      const stale = builtFrom ? JSON.stringify(builtFrom) !== JSON.stringify(doc) : build.createdAt < row.updatedAt;
      if (stale) {
        report.stale++;
        continue;
      }
      const stepIds = build.steps.flatMap((s) => {
        const id = (s as { exerciseId?: unknown } | null)?.exerciseId;
        return typeof id === "string" ? [id] : [];
      });
      const mine = playerStepsFromDoc(doc, library).flatMap((s) => (s.exerciseId ? [canon(s.exerciseId)] : [])).sort();
      const old = stepIds.map(canon).sort();
      if (mine.length !== old.length || mine.some((id, i) => id !== old[i])) report.mismatched.push({ id: row.id, field: "steps" });
    }
  }
  return report;
}
