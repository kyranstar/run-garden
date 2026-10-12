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
 * same batch (`runAtomically`) — `revisionInserts` for many rows at once: one statement more per batch of writes
 * (per 80 rows), and none when there is no document to revise. The
 * rules, in SQL so a state that changes under the write still holds:
 *  - a completed, skipped or missed row (`FROZEN_STATES`) keeps its document and its counter, and gets no revision;
 *  - the same document again is no new revision (a re-applied proposal, a re-read import);
 *  - no document (a rest day, a conversion that failed) clears the column and keeps the counter, so the next
 *    revision's id never collides with the history; no revision is written for it;
 *  - the revision row copies the row's own stored document and counter (INSERT … SELECT), so the two cannot differ.
 * `session_builds.workout_doc` is a snapshot of one build: no revisions.
 */
import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { plannedWorkoutStages, plannedWorkouts, workoutDocRevisions } from "@rg/database";
import {
  DOC_ORIGINS,
  parseStoredWorkoutDoc,
  workoutDocSchema,
  type CoachSession,
  type DOC_SOURCES,
  type PlannedStage,
  type StudioSession,
  type WeightUnit,
  type WorkoutDoc,
  type WorkoutItem,
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
import { chunkIds, type Db } from "./db.js";
import { corosKeyOfName, libraryIdsByKey } from "./coros-exercise-map.js";
import { strictExerciseKey } from "./exercise-catalog.js";

/** Who wrote a revision: a document source, or the athlete's own edit (Stage 2). */
export type DocSourceKind = (typeof DOC_SOURCES)[number] | "athlete_edit";

/** The completion states whose document never changes again: the workout has had its day. */
export const FROZEN_STATES = ["completed", "skipped", "missed"] as const;

let shippedIndex: LibraryIndex | null = null;
/** The shipped library, by any id it has held. */
const library = (): LibraryIndex => (shippedIndex ??= makeLibraryIndex(EXERCISES));

let byName: Map<string, string | null> | null = null;
/** A library move's own name (strict key) → its id; a name two moves share → null. The shipped library's is kept. */
function libraryNames(lib?: readonly ExerciseRecord[]): Map<string, string | null> {
  if (!lib && byName) return byName;
  const out = new Map<string, string | null>();
  for (const e of lib ?? EXERCISES) {
    const key = strictExerciseKey(e.name);
    if (key) out.set(key, out.has(key) ? null : e.id);
  }
  if (!lib) byName = out;
  return out;
}

/**
 * A stored stage's label — COROS's English name for the step — → the library move: through the name's unique T-code
 * (a name two T-codes share resolves to nothing) and the library's mapping of that T-code.
 */
export function libraryIdOfCorosName(label: string, lib?: readonly ExerciseRecord[]): string | null {
  const key = corosKeyOfName(label);
  return key ? (libraryIdsByKey(lib).get(key) ?? null) : null;
}

/**
 * What the coach called a move → the library move: the library's own name first, then COROS's name for it. A name the
 * library holds decides, even one two moves share (then nothing): COROS's name for it is no tie-break.
 */
export function resolveLibraryName(name: string, lib?: readonly ExerciseRecord[]): string | null {
  const key = strictExerciseKey(name);
  const names = libraryNames(lib);
  return names.has(key) ? (names.get(key) ?? null) : libraryIdOfCorosName(name, lib);
}

/** The source as the log names it. */
type LogSource = "engine" | "coach" | "coros_import" | "studio";

/** A conversion that cannot fail the write: the schema-valid document, or null (logged by code). */
function converted(source: LogSource, convert: () => WorkoutDoc | null, onFailed?: ConversionFailed): WorkoutDoc | null {
  try {
    const doc = convert();
    if (doc === null) return null;
    const parsed = workoutDocSchema.safeParse(doc);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    failed(source, `invalid:${issue?.code ?? "unknown"}@${issue?.path.join(".") ?? ""}`, onFailed);
    return null;
  } catch (e) {
    failed(source, e instanceof Error && /^\w{1,40}$/.test(e.name) ? e.name : "unknown", onFailed);
    return null;
  }
}

/**
 * Told what the log says of a conversion that failed — `<source>/<code>`, never a message or a title — for a caller
 * that reports it (the backfill's `failed`).
 */
export type ConversionFailed = (code: string) => void;

function failed(source: LogSource, code: string, onFailed?: ConversionFailed): void {
  console.warn(`workout doc conversion failed: ${source}/${code}`);
  onFailed?.(`${source}/${code}`);
}

/** An engine build (`session_builds.payload.build`) → its document. */
export function docForBuild(build: BuildPayload, onFailed?: ConversionFailed): WorkoutDoc | null {
  return converted("engine", () => docFromBuildWithKept(build, { library: library() }).doc, onFailed);
}

/** A coach session → its document; a rest day has none. Stored loads are typed in the athlete's weight unit. */
export function docForCoachSession(session: CoachSession, ctx: { weightUnit?: WeightUnit }, onFailed?: ConversionFailed): WorkoutDoc | null {
  return converted(
    "coach",
    () => docFromCoachSession(session, { resolveName: resolveLibraryName, weightUnit: ctx.weightUnit, library: library() })?.doc ?? null,
    onFailed,
  );
}

/** What the planned row says about its stages (the converter reads the effort and the stand-in's length from it). */
export type StagesRowMeta = Pick<StagesMeta, "title" | "sport" | "category" | "qualitySubtype" | "durationSeconds">;

/** COROS stages → their document; a rest day (the row's category) has none. */
export function docForStages(stages: PlannedStage[], meta: StagesRowMeta, onFailed?: ConversionFailed): WorkoutDoc | null {
  if (meta.category === "rest") return null;
  return converted(
    "coros_import",
    () => docFromStages(stages, { ...meta, corosKeyToLibraryId: (label) => libraryIdOfCorosName(label), library: library() }).doc,
    onFailed,
  );
}

type StageColumns = typeof plannedWorkoutStages.$inferSelect;
/** A stage row as stored, or as `coachStageRows` is about to store it (a coach run's rows have no strength columns). */
export type StageRowLike = Pick<
  StageColumns,
  | "id" | "parentStageId" | "ord" | "kind" | "repeatCount" | "durationType" | "durationSeconds" | "distanceMeters"
  | "targetType" | "targetLow" | "targetHigh" | "paceZone" | "hrZone" | "label"
> &
  Partial<Pick<StageColumns, "reps" | "loadKg" | "loadBodyweight" | "restSeconds" | "note">>;

/** A stage row → the converter's stage, as the import hands it over: a NULL (or missing) column is absent. */
export function plannedStageOfRow(r: StageRowLike): PlannedStage {
  const opt = <K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } =>
    value === null || value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
  return {
    id: r.id,
    ...opt("parentStageId", r.parentStageId),
    order: r.ord,
    kind: r.kind as PlannedStage["kind"],
    ...opt("repeatCount", r.repeatCount),
    durationType: r.durationType as PlannedStage["durationType"],
    ...opt("durationSeconds", r.durationSeconds),
    ...opt("distanceMeters", r.distanceMeters),
    ...opt("targetType", r.targetType as PlannedStage["targetType"] | null),
    ...opt("targetLow", r.targetLow),
    ...opt("targetHigh", r.targetHigh),
    ...opt("paceZone", r.paceZone),
    ...opt("hrZone", r.hrZone),
    ...opt("label", r.label),
    ...opt("reps", r.reps),
    ...opt("loadKg", r.loadKg),
    ...opt("loadBodyweight", r.loadBodyweight),
    ...opt("restSeconds", r.restSeconds),
    ...opt("note", r.note),
  };
}

type RunTarget = Extract<WorkoutItem, { kind: "run" }>["target"];
/** The same segment: the same seconds, or the same metres. */
const sameMeasure = (a: RunTarget, b: RunTarget): boolean =>
  (a.durationSec !== undefined && a.durationSec === b.durationSec) || (a.distanceM !== undefined && a.distanceM === b.distanceM);

/**
 * A COACH RUN'S DOCUMENT, WITH ITS STAGES' TARGETS — the one helper both the coach's own write (`coach-apply.ts`) and
 * the backfill use, so a coach run's document is the same whichever wrote it.
 *
 * The coach's blocks have no place for a target; the stage rows written for them do (`writeStages`: a pace band from
 * the athlete's threshold). The stage converter's own reading of those rows — its bounds, one item per stage, as the
 * coach's converter makes one item per block — lends each coach run item its `pace`, `hr` and `zone`. Only where the
 * two line up: the same number of items, and at each place a run item of the same seconds or metres. Anything else
 * lends nothing. A document the schema would refuse is left as it was.
 */
export function withStageTargets(doc: WorkoutDoc | null, stages: readonly StageRowLike[]): WorkoutDoc | null {
  if (!doc || stages.length === 0) return doc;
  let fromStages: WorkoutDoc;
  try {
    // Only the targets are read, and a target depends on the stage alone, not on the workout's title or category. The
    // converter puts the stages in their own order.
    fromStages = docFromStages(stages.map(plannedStageOfRow), { title: doc.title, sport: "run", corosKeyToLibraryId: () => null }).doc;
  } catch {
    return doc;
  }
  const theirs = fromStages.parts.flatMap((p) => p.items);
  if (doc.parts.reduce((n, p) => n + p.items.length, 0) !== theirs.length) return doc;
  let i = 0;
  let lent = false;
  const parts = doc.parts.map((p) => ({
    ...p,
    items: p.items.map((item): WorkoutItem => {
      const stage = theirs[i++]!;
      if (item.kind !== "run" || stage.kind !== "run" || !sameMeasure(item.target, stage.target)) return item;
      const { pace, hr, zone } = stage.target;
      if (!pace && !hr && !zone) return item;
      lent = true;
      return { ...item, target: { ...item.target, ...(pace ? { pace } : {}), ...(hr ? { hr } : {}), ...(zone ? { zone } : {}) } };
    }),
  }));
  if (!lent) return doc;
  const parsed = workoutDocSchema.safeParse({ ...doc, parts });
  return parsed.success ? parsed.data : doc;
}

/**
 * A stored document with its stated length changed (the coach's `adjust`: how long a session lasts, never what it is):
 * `setting.targetMinutes` and nothing else. A length the schema cannot hold is no longer stated (stating the old one
 * would be wrong). No usable stored document → null: the caller leaves the columns as they are.
 */
export function docWithStatedLength(stored: unknown, minutes: number): WorkoutDoc | null {
  const doc = parseStoredWorkoutDoc(stored);
  if (!doc) return null;
  const { setting: was, ...rest } = doc;
  const { targetMinutes: _old, ...setting } = was ?? {};
  const next = workoutDocSchema.safeParse({ ...rest, setting: { ...setting, targetMinutes: minutes } });
  if (next.success) return next.data;
  const unstated = workoutDocSchema.safeParse(Object.keys(setting).length > 0 ? { ...rest, setting } : rest);
  return unstated.success ? unstated.data : null;
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
 * A row that LEAVES a completed, skipped or missed state (an unskip, the coach's restore, a "not yet", an unmatch). While
 * frozen its document was kept as it was, and its content may have moved on meanwhile (the import still rewrites a
 * skipped row's content; a write keeps a frozen row's document): the document is set NULL, its counter kept, so the
 * backfill or the next writer derives it again from the row's content as it now is — and so the next revision's id
 * never collides with the history. Never a document workout's (`DOC_ORIGINS`): its document IS its content, and it can
 * never have been revised while frozen. In SQL, against the row as it was, so a state that changed under the write
 * still holds; a row that was not frozen keeps its document.
 */
export function reopenedDocColumns(): { workoutDoc: SQL } {
  const pw = plannedWorkouts;
  const stale = and(frozen(), or(isNull(pw.origin), notInArray(pw.origin, [...DOC_ORIGINS])));
  return { workoutDoc: sql`case when ${stale} then null else ${pw.workoutDoc} end` };
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

/** How many rows one revision statement covers (the ids are bound: 80 plus the statement's own stay under D1's 100). */
export const REVISION_CHUNK = 80;
/** The same with each row's written document bound beside its id (two values a row). */
const WRITTEN_DOCS_CHUNK = 40;

/**
 * The revisions of several rows' current documents, for the same batch as their writes — ONE statement per
 * `REVISION_CHUNK` rows, so a writer of many rows (an op's sessions, an import's workouts) adds one statement, not one
 * per row. The rules are `revisionInsert`'s. `sourceRef` may be a column of the row itself (the import's
 * `source_content_fingerprint`: each row's own upstream version). No ids, no statement.
 *
 * `recordsHistory` (the backfill only): the rows' FIRST documents, filled in where no writer ever wrote one. On a
 * completed, skipped or missed row that is history being recorded, not an edit, so the frozen rule does not apply.
 *
 * `writtenDocs` (the backfill only): a row is recorded only while its document is exactly the text the caller wrote
 * (id → text), so a document another writer put there first is never filed under this caller's source. Two bound
 * values a row: `WRITTEN_DOCS_CHUNK` rows a statement.
 */
export function revisionInserts(
  db: Db,
  r: {
    userId: string;
    workoutIds: readonly string[];
    sourceKind: DocSourceKind;
    sourceRef: string | null | SQL;
    now: string;
    recordsHistory?: boolean;
    writtenDocs?: ReadonlyMap<string, string>;
  },
) {
  const pw = plannedWorkouts;
  const written = r.writtenDocs;
  return chunkIds([...new Set(r.workoutIds)], written ? WRITTEN_DOCS_CHUNK : REVISION_CHUNK).map((ids) =>
    db
      .insert(workoutDocRevisions)
      .select(
        sql`select ${pw.id} || ':' || ${pw.workoutDocRev}, ${pw.userId}, ${pw.id}, ${pw.workoutDocRev}, ${pw.workoutDoc}, ${r.sourceKind}, ${r.sourceRef}, ${r.now} from ${pw} where ${and(
          written ? or(...ids.map((id) => and(eq(pw.id, id), eq(pw.workoutDoc, written.get(id) ?? "")))) : inArray(pw.id, ids),
          eq(pw.userId, r.userId),
          isNotNull(pw.workoutDoc),
          isNotNull(pw.workoutDocRev),
          ...(r.recordsHistory ? [] : [notInArray(pw.completionState, [...FROZEN_STATES])]),
        )}`,
      )
      .onConflictDoNothing(),
  );
}
