/**
 * THE WORKOUT DOCUMENT BACKFILL (Stage 1 Task 14; programme spec §3.4 "Backfill", §3.9 step 5; Amendment A).
 *
 * Gives every existing planned workout and session build of the signed-in account the document its writer writes today
 * (Task 11's dual-write, `workout-doc-store.ts`: the same converters, library index, weight unit and COROS name rule),
 * one bounded step per call — `POST /api/admin/workout-docs/backfill` (routes/admin.ts), driven by hand:
 *  - `planned`: `planned_workouts` rows with no document, not archived;
 *  - `builds`: `session_builds` rows with no document: `payload.build` → `docForBuild` (a snapshot: no revisions).
 *
 * WHICH PLANNED ROWS, FROM WHAT
 *  - a rest day (category rest) → skipped `rest`: a rest day has no document, by design;
 *  - an app-authored row (origin program / on_demand) → skipped: its content is its build, and the build carries the
 *    document (the `builds` kind fills it; the dual-write leaves these rows' own column NULL too) — `outline` while it
 *    has none, else `app_built`;
 *  - a coach row (its plan is a coach plan) → the coach session it holds, read back from what `sessionColumns` and
 *    `writeStages` stored (`coachSessionOfRow`), through `docForCoachSession` — the document the coach's add wrote;
 *    stages the coach did not write (the wire's own) → `docForStages`;
 *  - every other row — the COROS import's; the old Studio's sessions arrive this way (no planned row names a Studio
 *    plan: only the import, the coach and the programme slots insert planned rows) → its stages through
 *    `docForStages` with the row's own title, sport, category, subtype and length — the document the import wrote.
 *  - a conversion that fails → `failed`, with its code: the store's `<source>/<code>`, or the backfill's own
 *    (`structure_unreadable`, `coach_session_invalid`, `payload_unreadable`); never a title or text. Its document stays
 *    NULL, and it is scanned again on the next run.
 *
 * WHAT IT WRITES — nothing else: no other column (not even `updated_at`), no other table.
 *  - A planned row: `workout_doc`; `workout_doc_rev` = the higher of its counter and its history's highest revision,
 *    plus one — `coalesce(rev, 0) + 1` in every state the writers leave, and never an id the history already holds —
 *    only while the column is still NULL (a writer that got there first wins); and its revision row through
 *    `revisionInserts` (source_kind `coach` or `coros_import`, from the row's origin; source_ref the import's content
 *    fingerprint, as the import's own revisions). A page's documents and revisions are ONE batch: all land or none.
 *  - A completed, skipped or missed row gets its first document too, with its revision: history being recorded, not
 *    an edit (`recordsHistory`). A row that has a document is never touched.
 *  - A build: `workout_doc`, only while still NULL; one statement.
 *
 * RESUMABLE, IDEMPOTENT. Keyset by id (`after` → `nextAfter`). A row leaves the scan when it gets its document, so a
 * step killed part-way is finished by running it again, and a run after a full run converts nothing.
 *
 * BOUNDED (Workers Free, principles §8): ≤ `BACKFILL_MAX_LIMIT` rows per call. planned: the page, its stages (one
 * read), the weight unit (one read, only when a coach session with a body is on the page), one statement per document
 * and one per source of revisions (coach, import): ≤ 25. builds: the page — `payload.build` only, never the view — and
 * one statement per document: ≤ 21. The page stays at 20 for the CPU (each document is converted and schema-checked),
 * not the statements. No column is read that the conversion does not need. A dry run reads and converts exactly as a
 * real one, and writes nothing.
 */
import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { coachPlans, plannedWorkouts, plannedWorkoutStages, sessionBuilds } from "@rg/database";
import { appAuthoredRow, coachSessionSchema, nowInstant, type CoachSession, type PlannedStage, type WeightUnit, type WorkoutDoc } from "@rg/domain";
import type { BuildPayload } from "@rg/workout";
import { chunkIds, runAtomically, type AtomicStatement, type Db } from "./db.js";
import { loadPreferences } from "./calendar-sync.js";
import {
  docForBuild,
  docForCoachSession,
  docForStages,
  revisionInserts,
  storedDocText,
  type ConversionFailed,
  type DocSourceKind,
} from "./workout-doc-store.js";

export type BackfillKind = "planned" | "builds";
export const BACKFILL_KINDS: readonly BackfillKind[] = ["planned", "builds"];

/**
 * Rows per call: the default, and the most. The statements would allow more (3 reads + 20 updates + 2 revision
 * statements = 25 of 45); the cap is for the CPU of converting and schema-checking each document on Workers Free.
 */
export const BACKFILL_DEFAULT_LIMIT = 15;
export const BACKFILL_MAX_LIMIT = 20;

/** Why a row was left without a document (by design, not a failure). */
export type SkipReason = "rest" | "outline" | "app_built";

export interface BackfillReport {
  dryRun: boolean;
  kind: BackfillKind;
  /** Rows read on this page. */
  scanned: number;
  /** Documents written (a dry run: that would be written). */
  converted: number;
  skipped: number;
  skippedBy: Partial<Record<SkipReason, number>>;
  /** Ids and codes only. */
  failed: Array<{ id: string; code: string }>;
  /** Pass as `after` for the next page; null when this was the last. */
  nextAfter: string | null;
}

export interface BackfillOptions {
  kind: BackfillKind;
  dryRun: boolean;
  /** The last id of the previous page (exclusive). */
  after?: string;
  limit?: number;
  /** The revisions' timestamp (tests fix it). */
  now?: string;
}

function backfillLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return BACKFILL_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), BACKFILL_MAX_LIMIT);
}

export async function backfillWorkoutDocs(db: Db, userId: string, opts: BackfillOptions): Promise<BackfillReport> {
  const limit = backfillLimit(opts.limit);
  const now = opts.now ?? nowInstant();
  return opts.kind === "planned" ? backfillPlanned(db, userId, opts, limit, now) : backfillBuilds(db, userId, opts, limit);
}

class Tally {
  readonly report: BackfillReport;
  constructor(opts: BackfillOptions, scanned: number, nextAfter: string | null) {
    this.report = { dryRun: opts.dryRun, kind: opts.kind, scanned, converted: 0, skipped: 0, skippedBy: {}, failed: [], nextAfter };
  }
  skip(reason: SkipReason): void {
    this.report.skipped += 1;
    this.report.skippedBy[reason] = (this.report.skippedBy[reason] ?? 0) + 1;
  }
  fail(id: string, code: string): void {
    this.report.failed.push({ id, code });
  }
}

/** The page and the cursor past it: `limit + 1` rows read, so the last page knows it is the last. */
function paged<T extends { id: string }>(rows: T[], limit: number): { page: T[]; nextAfter: string | null } {
  const page = rows.slice(0, limit);
  return { page, nextAfter: rows.length > limit ? page[page.length - 1]!.id : null };
}

// ── Planned workouts ─────────────────────────────────────────────────────────────────────────────────────────────────

const RUN_INTENSITIES = new Set(["easy", "steady", "threshold", "interval", "rest"]);
/** The stage kinds `writeStages` writes (`runBlockRoles`). */
const COACH_STAGE_KINDS = new Set(["warmup", "work", "recovery", "cooldown"]);

type StageRow = Awaited<ReturnType<typeof readStages>>[number];

async function readStages(db: Db, ids: string[]) {
  const s = plannedWorkoutStages;
  const out = [];
  for (const chunk of chunkIds(ids)) {
    out.push(
      ...(await db
        .select({
          id: s.id, workoutId: s.workoutId, parentStageId: s.parentStageId, ord: s.ord, kind: s.kind, repeatCount: s.repeatCount,
          durationType: s.durationType, durationSeconds: s.durationSeconds, distanceMeters: s.distanceMeters,
          targetType: s.targetType, targetLow: s.targetLow, targetHigh: s.targetHigh, paceZone: s.paceZone, hrZone: s.hrZone,
          label: s.label, reps: s.reps, loadKg: s.loadKg, loadBodyweight: s.loadBodyweight, restSeconds: s.restSeconds, note: s.note,
        })
        .from(s)
        .where(inArray(s.workoutId, chunk))
        .orderBy(asc(s.workoutId), asc(s.ord), asc(s.id))),
    );
  }
  return out;
}

/** A stored stage as the import handed it to the converter: a NULL column is absent (the converter reads presence). */
function plannedStageOfRow(r: StageRow): PlannedStage {
  const opt = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } => (value === null ? {} : ({ [key]: value } as { [P in K]: V }));
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

/**
 * The coach's run blocks back from the stages `writeStages` wrote for them — top-level, timed or measured, labelled with
 * the block's intensity (or nothing), no strength fields — or null when the stages are not that (the wire's own).
 */
function coachBlocksOf(stages: StageRow[]): Array<{ kind: "duration" | "distance"; value: number; intensity?: string }> | null {
  const blocks: Array<{ kind: "duration" | "distance"; value: number; intensity?: string }> = [];
  for (const s of stages) {
    if (s.parentStageId !== null || s.repeatCount !== null || !COACH_STAGE_KINDS.has(s.kind)) return null;
    if (s.label !== null && !RUN_INTENSITIES.has(s.label)) return null;
    if (s.reps !== null || s.loadKg !== null || s.loadBodyweight !== null || s.restSeconds !== null || s.note !== null) return null;
    const intensity = s.label === null ? {} : { intensity: s.label };
    // A duration block's value is MINUTES (writeStages stored `round(value × 60)` seconds).
    if (s.durationType === "time" && s.durationSeconds !== null) blocks.push({ kind: "duration", value: s.durationSeconds / 60, ...intensity });
    else if (s.durationType === "distance" && s.distanceMeters !== null) blocks.push({ kind: "distance", value: s.distanceMeters, ...intensity });
    else return null;
  }
  return blocks;
}

/** `planned_workouts.structured_json` as the coach writes it (`sessionColumns`), read back unchecked. */
interface StructuredBody {
  exercises?: unknown;
  rounds?: unknown;
}

interface CoachRowFacts {
  title: string;
  category: string;
  sport: string;
  /** The session's stated minutes, in seconds (`sessionColumns`: the fallback estimate and the calendar block). */
  seconds: number;
}

/**
 * The coach session a coach row holds — the inverse of `sessionColumns` + `writeStages` (as content-converge's
 * `sessionFromRow`, keeping the row's own category and stated minutes): `structured_json` is a lift (a mobility session
 * when the row's sport is yoga); else the stages, when they are the coach's own blocks, are a run; else, with no stages,
 * a session with no body. `stages` when the stages are not the coach's (convert them as stages); `invalid` when what
 * was read back is no coach session.
 */
function coachSessionOfRow(
  row: CoachRowFacts,
  structured: StructuredBody | null,
  stages: StageRow[],
): CoachSession | "stages" | "invalid" {
  const base = { category: row.category, title: row.title, durationMinutes: Math.round(row.seconds / 60) };
  let candidate: Record<string, unknown> = base;
  if (structured && Array.isArray(structured.exercises) && structured.exercises.length > 0) {
    const body = { ...(structured.rounds ? { rounds: structured.rounds } : {}), exercises: structured.exercises };
    candidate = { ...base, ...(row.sport === "yoga" ? { mobility: body } : { lift: body }) };
  } else if (stages.length > 0) {
    const blocks = coachBlocksOf(stages);
    if (!blocks) return "stages";
    candidate = { ...base, run: { blocks } };
  }
  const parsed = coachSessionSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return candidate.run ? "stages" : "invalid";
}

async function backfillPlanned(db: Db, userId: string, opts: BackfillOptions, limit: number, now: string): Promise<BackfillReport> {
  const pw = plannedWorkouts;
  const rows = await db
    .select({
      id: pw.id,
      title: pw.title,
      category: pw.category,
      qualitySubtype: pw.qualitySubtype,
      sport: pw.sport,
      origin: pw.origin,
      contentState: pw.contentState,
      // Raw text: Drizzle's json mode would throw on a malformed column and fail the whole page.
      structured: sql<string | null>`${pw.structuredJson}`,
      sourceSeconds: pw.sourceEstimatedDurationSeconds,
      fallbackSeconds: pw.fallbackEstimatedDurationSeconds,
      calendarSeconds: pw.calendarBlockDurationSeconds,
      coachPlanId: coachPlans.id,
    })
    .from(pw)
    .leftJoin(coachPlans, and(eq(coachPlans.id, pw.planId), eq(coachPlans.userId, pw.userId)))
    .where(and(eq(pw.userId, userId), isNull(pw.workoutDoc), isNull(pw.archivedAt), ...(opts.after ? [gt(pw.id, opts.after)] : [])))
    .orderBy(asc(pw.id))
    .limit(limit + 1);
  const { page, nextAfter } = paged(rows, limit);
  const tally = new Tally(opts, page.length, nextAfter);

  const convertible = page.filter((r) => r.category !== "rest" && !appAuthoredRow(r));
  const stagesOf = new Map<string, StageRow[]>();
  if (convertible.length > 0) {
    for (const s of await readStages(db, convertible.map((r) => r.id))) {
      const list = stagesOf.get(s.workoutId) ?? [];
      list.push(s);
      stagesOf.set(s.workoutId, list);
    }
  }
  const updates: AtomicStatement[] = [];
  const coachIds: string[] = [];
  const importIds: string[] = [];
  let weightUnit: WeightUnit | undefined;
  let unitRead = false;
  const unit = async (): Promise<WeightUnit | undefined> => {
    if (!unitRead) {
      weightUnit = (await loadPreferences(db, userId)).weightUnit;
      unitRead = true;
    }
    return weightUnit;
  };

  for (const row of page) {
    if (row.category === "rest") {
      tally.skip("rest");
      continue;
    }
    if (appAuthoredRow(row)) {
      tally.skip(row.contentState === "outline" || row.contentState === null ? "outline" : "app_built");
      continue;
    }
    const stages = stagesOf.get(row.id) ?? [];
    let code: string | null = null;
    const onFailed: ConversionFailed = (c) => (code = c);
    const asStages = (): WorkoutDoc | null =>
      docForStages(
        stages.map(plannedStageOfRow),
        { title: row.title, sport: row.sport, category: row.category, qualitySubtype: row.qualitySubtype, durationSeconds: row.sourceSeconds ?? row.fallbackSeconds },
        onFailed,
      );

    const fromCoach = row.coachPlanId !== null;
    let doc: WorkoutDoc | null;
    if (fromCoach) {
      let structured: StructuredBody | null = null;
      if (row.structured !== null) {
        try {
          const value: unknown = JSON.parse(row.structured);
          structured = value !== null && typeof value === "object" ? (value as StructuredBody) : null;
        } catch {
          tally.fail(row.id, "structure_unreadable");
          continue;
        }
      }
      const seconds = row.sourceSeconds ?? row.fallbackSeconds ?? row.calendarSeconds;
      const session = coachSessionOfRow({ title: row.title, category: row.category, sport: row.sport, seconds }, structured, stages);
      if (session === "invalid") {
        tally.fail(row.id, "coach_session_invalid");
        continue;
      }
      // Loads are typed in the athlete's unit, as the coach's add types them; only a body has loads (one read a page).
      doc = session === "stages" ? asStages() : docForCoachSession(session, { weightUnit: session.lift || session.mobility ? await unit() : undefined }, onFailed);
    } else {
      doc = asStages();
    }
    if (!doc) {
      tally.fail(row.id, code ?? "no_document");
      continue;
    }

    tally.report.converted += 1;
    if (opts.dryRun) continue;
    (fromCoach ? coachIds : importIds).push(row.id);
    updates.push(
      db
        .update(pw)
        .set({
          workoutDoc: storedDocText(doc),
          // Past the counter and past the history: `coalesce(rev, 0) + 1` wherever the writers kept them in step.
          workoutDocRev: sql`max(coalesce(${pw.workoutDocRev}, 0), coalesce((select max(r.rev) from workout_doc_revisions r where r.workout_id = planned_workouts.id), 0)) + 1`,
        })
        .where(and(eq(pw.id, row.id), eq(pw.userId, userId), isNull(pw.workoutDoc))),
    );
  }

  // The page's documents and their revisions as ONE batch: all land, or none and the step runs again.
  const revisions = (ids: string[], sourceKind: DocSourceKind, sourceRef: SQL | null) =>
    revisionInserts(db, { userId, workoutIds: ids, sourceKind, sourceRef, now, recordsHistory: true });
  const [first, ...rest] = updates;
  if (first) {
    await runAtomically(db, [
      first,
      ...rest,
      ...revisions(coachIds, "coach", null),
      // The import's revisions carry the row's own upstream version, as the import's do.
      ...revisions(importIds, "coros_import", sql`${pw.sourceContentFingerprint}`),
    ]);
  }
  return tally.report;
}

// ── Builds ───────────────────────────────────────────────────────────────────────────────────────────────────────────

async function backfillBuilds(db: Db, userId: string, opts: BackfillOptions, limit: number): Promise<BackfillReport> {
  const sb = sessionBuilds;
  const rows = await db
    .select({
      id: sb.id,
      // The build only — the payload's view (labels and choices) is most of its bytes and none of the document. A payload
      // that is not JSON reads as NULL rather than failing the page.
      build: sql<string | null>`case when json_valid(${sb.payload}) then json_extract(${sb.payload}, '$.build') end`,
    })
    .from(sb)
    .where(and(eq(sb.userId, userId), isNull(sb.workoutDoc), ...(opts.after ? [gt(sb.id, opts.after)] : [])))
    .orderBy(asc(sb.id))
    .limit(limit + 1);
  const { page, nextAfter } = paged(rows, limit);
  const tally = new Tally(opts, page.length, nextAfter);

  for (const row of page) {
    let build: unknown = null;
    try {
      build = row.build === null ? null : JSON.parse(row.build);
    } catch {
      build = null;
    }
    if (build === null || typeof build !== "object" || Array.isArray(build)) {
      tally.fail(row.id, "payload_unreadable");
      continue;
    }
    let code: string | null = null;
    const doc = docForBuild(build as BuildPayload, (c) => (code = c));
    if (!doc) {
      tally.fail(row.id, code ?? "no_document");
      continue;
    }
    tally.report.converted += 1;
    if (opts.dryRun) continue;
    await db
      .update(sb)
      .set({ workoutDoc: storedDocText(doc) })
      .where(and(eq(sb.id, row.id), eq(sb.userId, userId), isNull(sb.workoutDoc)));
  }
  return tally.report;
}
