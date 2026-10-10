/**
 * THE WORKOUT DOCUMENT, AS EVERY SOURCE STORES IT (Stage 1 Task 11; programme spec §3.4 dual-write; Amendment A).
 *
 * Every writer of a workout writes its document beside its existing format, in the same statement where the row can
 * carry it. One helper per source converts and answers the document to write:
 *  - `docForBuild` — an engine build (`session_builds.payload.build`) → `session_builds.workout_doc`, a snapshot;
 *  - `docForCoachSession` — a coach session → `planned_workouts.workout_doc` (a rest day has none);
 *  - `docForStages` — COROS stages → `planned_workouts.workout_doc` (a rest day has none);
 *  - `docForStudioSession` — an old Studio session (no writer stores one today; the backfill may).
 * Each passes the library (`makeLibraryIndex`), so a legacy id is stored as the move it now is and an id the library
 * no longer has as free text.
 *
 * NEVER FAILS THE WRITE. A converter that throws, or a document the schema refuses, is logged by its code only —
 * `workout doc conversion failed: <source>/<code>`, never a message, a title or anything the athlete wrote — and the
 * answer is null: the row is written with no document, and the backfill and the parity diagnostic find it.
 *
 * REVISIONS (Amendment A). A planned workout's document has a revision counter (`workout_doc_rev`) and a history
 * (`workout_doc_revisions`, id `<workout_id>:<rev>`). A writer of `planned_workouts.workout_doc` writes its row with
 * `newRowDocColumns` (an insert) or `updateDocColumns` (an update) and runs `revisionInsert` right after it, in the
 * same batch (`runAtomically`) — one statement more than the write, and none when it has no document to revise. The
 * rules, in SQL so a state that changes under the write still holds:
 *  - a completed, skipped or missed row (`FROZEN_STATES`) keeps its document and its counter, and gets no revision;
 *  - the same document again is no new revision (a re-applied proposal, a re-read import);
 *  - no document (a rest day, a conversion that failed) clears the column and keeps the counter, so the next
 *    revision's id never collides with the history; no revision is written for it;
 *  - the revision row copies the row's own stored document and counter (INSERT … SELECT), so the two cannot differ.
 * `session_builds.workout_doc` is a snapshot of one build: no revisions.
 */
import { and, eq, inArray, isNotNull, notInArray, sql, type SQL } from "drizzle-orm";
import { plannedWorkouts, workoutDocRevisions } from "@rg/database";
import {
  workoutDocSchema,
  type CoachSession,
  type DOC_SOURCES,
  type PlannedStage,
  type StudioSession,
  type WeightUnit,
  type WorkoutDoc,
} from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import {
  docFromBuildWithKept,
  docFromCoachSession,
  docFromStages,
  docFromStudioSession,
  makeLibraryIndex,
  type BuildPayload,
  type LibraryIndex,
  type StagesMeta,
} from "@rg/workout";
import type { Db } from "./db.js";
import { corosKeyOfName, libraryIdsByKey } from "./coros-exercise-map.js";
import { strictExerciseKey } from "./exercise-catalog.js";

/** Who wrote a revision: a document source, or the athlete's own edit (Stage 2). */
export type DocSourceKind = (typeof DOC_SOURCES)[number] | "athlete_edit";

/** The completion states whose document never changes again: the workout has had its day. */
export const FROZEN_STATES = ["completed", "skipped", "missed"] as const;

export function isFrozen(state: string | null | undefined): boolean {
  return (FROZEN_STATES as readonly string[]).includes(state ?? "");
}

let shippedIndex: LibraryIndex | null = null;
/** The shipped library, by any id it has held. */
const library = (): LibraryIndex => (shippedIndex ??= makeLibraryIndex(EXERCISES));

let byName: Map<string, string | null> | null = null;
/** A library move's own name (strict key) → its id; a name two moves share → null. */
function libraryNames(): Map<string, string | null> {
  if (byName) return byName;
  const out = new Map<string, string | null>();
  for (const e of EXERCISES) {
    const key = strictExerciseKey(e.name);
    if (key) out.set(key, out.has(key) ? null : e.id);
  }
  return (byName = out);
}

/**
 * A stored stage's label — COROS's English name for the step — → the library move: through the name's unique T-code
 * (a name two T-codes share resolves to nothing) and the library's mapping of that T-code.
 */
export function libraryIdOfCorosName(label: string, lib?: readonly ExerciseRecord[]): string | null {
  const key = corosKeyOfName(label);
  return key ? (libraryIdsByKey(lib).get(key) ?? null) : null;
}

/** What the coach called a move → the library move: the library's own name first, then COROS's name for it. */
export function resolveLibraryName(name: string): string | null {
  const own = libraryNames().get(strictExerciseKey(name));
  return own ?? libraryIdOfCorosName(name);
}

/** The source as the log names it. */
type LogSource = "engine" | "coach" | "coros_import" | "studio";

/** A conversion that cannot fail the write: the schema-valid document, or null (logged by code). */
function converted(source: LogSource, convert: () => WorkoutDoc | null): WorkoutDoc | null {
  let doc: WorkoutDoc | null;
  try {
    doc = convert();
  } catch (e) {
    failed(source, e instanceof Error && /^\w{1,40}$/.test(e.name) ? e.name : "unknown");
    return null;
  }
  if (doc === null) return null;
  const parsed = workoutDocSchema.safeParse(doc);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  failed(source, `invalid:${issue?.code ?? "unknown"}@${issue?.path.join(".") ?? ""}`);
  return null;
}

function failed(source: LogSource, code: string): void {
  console.warn(`workout doc conversion failed: ${source}/${code}`);
}

/** An engine build (`session_builds.payload.build`) → its document. */
export function docForBuild(build: BuildPayload): WorkoutDoc | null {
  return converted("engine", () => docFromBuildWithKept(build, { library: library() }).doc);
}

/** A coach session → its document; a rest day has none. Stored loads are typed in the athlete's weight unit. */
export function docForCoachSession(session: CoachSession, ctx: { weightUnit?: WeightUnit }): WorkoutDoc | null {
  return converted(
    "coach",
    () => docFromCoachSession(session, { resolveName: resolveLibraryName, weightUnit: ctx.weightUnit, library: library() })?.doc ?? null,
  );
}

/** What the planned row says about its stages (the converter reads the effort and the stand-in's length from it). */
export type StagesRowMeta = Pick<StagesMeta, "title" | "sport" | "category" | "qualitySubtype" | "durationSeconds">;

/** COROS stages → their document; a rest day (the row's category) has none. */
export function docForStages(stages: PlannedStage[], meta: StagesRowMeta): WorkoutDoc | null {
  if (meta.category === "rest") return null;
  return converted(
    "coros_import",
    () => docFromStages(stages, { ...meta, corosKeyToLibraryId: (label) => libraryIdOfCorosName(label), library: library() }).doc,
  );
}

/** An old Studio session → its document; `corosKeyOfOrigin` reads the athlete's catalog id as its T-code. */
export function docForStudioSession(session: StudioSession, ctx: { corosKeyOfOrigin: (originId: string) => string | null }): WorkoutDoc | null {
  const originIdToLibraryId = (id: string): string | null => {
    const key = ctx.corosKeyOfOrigin(id);
    return key ? (libraryIdsByKey().get(key) ?? null) : null;
  };
  return converted("studio", () => docFromStudioSession(session, { originIdToLibraryId, library: library() }).doc);
}

// ── Storage ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const frozen = (): SQL => inArray(plannedWorkouts.completionState, [...FROZEN_STATES]);

/** A document as its column stores it: JSON text (the columns are plain text; readers use `parseStoredWorkoutDoc`). */
export function storedDocText(doc: WorkoutDoc | null): string | null {
  return doc ? JSON.stringify(doc) : null;
}

/** A new planned row's document columns: the document at revision 1, or neither. */
export function newRowDocColumns(doc: WorkoutDoc | null): { workoutDoc: string | null; workoutDocRev: number | null } {
  return { workoutDoc: storedDocText(doc), workoutDocRev: doc ? 1 : null };
}

/**
 * An update's document columns (module rules): a frozen row keeps both; else the document (or NULL), and the counter
 * moves on only when the document changed. SQLite reads every SET expression against the row as it was.
 *
 * `reopens`: the same update sets the row back to scheduled as another workout (the import's recycled slot, which
 * never reuses a completed row): it is no longer the workout that had its day, so its document follows it.
 */
export function updateDocColumns(doc: WorkoutDoc | null, opts: { reopens?: boolean } = {}): { workoutDoc: SQL; workoutDocRev?: SQL } {
  const text = storedDocText(doc);
  const kept = opts.reopens ? sql`0` : frozen();
  const workoutDoc = sql`case when ${kept} then ${plannedWorkouts.workoutDoc} else ${text} end`;
  if (text === null) return { workoutDoc };
  return {
    workoutDoc,
    workoutDocRev: sql`case when ${kept} or ${plannedWorkouts.workoutDoc} is ${text} then ${plannedWorkouts.workoutDocRev} else coalesce(${plannedWorkouts.workoutDocRev}, 0) + 1 end`,
  };
}

/**
 * The revision of the row's current document, for the same batch as the write: copied from the row itself, for this
 * account's row only, never for a frozen row or a row with no document; idempotent by its id (`<workout_id>:<rev>`).
 */
export function revisionInsert(
  db: Db,
  r: { userId: string; workoutId: string; sourceKind: DocSourceKind; sourceRef: string | null; now: string },
) {
  const pw = plannedWorkouts;
  return db
    .insert(workoutDocRevisions)
    .select(
      sql`select ${pw.id} || ':' || ${pw.workoutDocRev}, ${pw.userId}, ${pw.id}, ${pw.workoutDocRev}, ${pw.workoutDoc}, ${r.sourceKind}, ${r.sourceRef}, ${r.now} from ${pw} where ${and(
        eq(pw.id, r.workoutId),
        eq(pw.userId, r.userId),
        isNotNull(pw.workoutDoc),
        isNotNull(pw.workoutDocRev),
        notInArray(pw.completionState, [...FROZEN_STATES]),
      )}`,
    )
    .onConflictDoNothing();
}
