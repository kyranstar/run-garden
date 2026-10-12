/**
 * THE WORKOUT DOCUMENT BACKFILL (Stage 1 Task 14; programme spec §3.4 "Backfill", §3.9 step 5; Amendment A).
 *
 * Gives every existing planned workout and session build of the signed-in account the document its writer writes today
 * (Task 11's dual-write, `workout-doc-store.ts`: the same converters, library index, weight unit and COROS name rule),
 * one bounded step per call — `POST /api/admin/workout-docs/backfill` (routes/admin.ts), driven by hand:
 *  - `planned`: `planned_workouts` rows with no document, not archived;
 *  - `builds`: `session_builds` rows with no document: `payload.build` → `docForBuild` (a snapshot: no revisions).
 *
 * WHICH PLANNED ROWS, FROM WHAT — the content's LAST writer, read from the row itself:
 *  - a rest day (category rest) → skipped `rest`: a rest day has no document, by design;
 *  - an app-authored row (origin program / on_demand) → skipped: its content is its build, and the build carries the
 *    document (the `builds` kind fills it; the dual-write leaves these rows' own column NULL too) — `outline` while it
 *    has none, else `app_built`;
 *  - a coach body (`structured_json` with exercises — only the coach writes it: an add, an ease of any row, a restore)
 *    → the coach session (`docForCoachSession`) — UNLESS the import restaged the row after the coach: every coach write
 *    of a body deletes the row's stage rows (`writeStages` writes none for a lift or mobility), and only the import
 *    writes stage rows under one (rule 7, the recycled slot), stamping the wire's fingerprint. Stage rows under a body
 *    with an upstream fingerprint → the stages (`authoredAsStages`: a body is the coach's row even with no content
 *    intent, as a lift eased before intents existed has none);
 *  - a row the coach AUTHORED — a coach plan's row, or one an ease rewrote (its content intent: `ease` records one for
 *    every row it rewrites, the app's own mark of "the app wrote this content") — with stages that read back as the
 *    coach's run blocks (`coachBlocksOf`) and a summary that is still the coach's own line for them
 *    (`sessionSummaryLine`; the import's restage writes its own) → the coach session, carrying each stage's pace band,
 *    heart-rate band or zone through the store's `withStageTargets` — the very helper the coach's own write uses, so a
 *    coach run's document is the same whichever wrote it (item for item, on the same seconds or metres; anything else
 *    lends nothing). Shape alone is no proof: a plain unlabelled COROS run reads as coach blocks too, and its summary can
 *    coincide. Any other stages → `docForStages` (`authoredAsStages` when the coach wrote the row at some point);
 *  - no stages: a row the coach authored → the coach session with no body (its category, title and minutes); any other
 *    row → `docForStages` (the stand-in of the row's length, as the import writes it).
 *  - The rows the import wrote — the old Studio's sessions arrive this way; no planned row names a Studio plan (only
 *    the import, the coach and the programme slots insert planned rows) — take the import's own meta: the row's title,
 *    sport, category, subtype and length.
 *  - A conversion that fails → `failed`, with its code: the store's `<source>/<code>`, the backfill's own
 *    (`structure_unreadable`, `coach_session_invalid`, `payload_unreadable`), or `threw/<ErrorName>` for anything else
 *    one row throws — never a title or text, never the whole page. Its document stays NULL; the next run sees it again.
 *
 * WHAT IT WRITES — nothing else: no other column (not even `updated_at`), no other table.
 *  - A planned row: `workout_doc`; `workout_doc_rev` = the higher of its counter and its history's highest revision,
 *    plus one — `coalesce(rev, 0) + 1` in every state the writers leave, and never an id the history already holds —
 *    only while the column is still NULL (a writer that got there first wins); and its revision row through
 *    `revisionInserts`, labelled by the converter that made the document: the coach's session → `coach` (no ref: the
 *    proposal is not known); stages → `coros_import` with the row's content fingerprint, as the import's rule 7 labels
 *    its own. The revision is recorded only while the row's document is the text written here (`writtenDocs`), so
 *    another writer's document is never filed as the backfill's. A page's documents and revisions are ONE batch: all
 *    land or none, and the step runs again (`limit=1` isolates a page that keeps failing).
 *  - A completed, skipped or missed row gets its first document too, with its revision: history being recorded, not
 *    an edit (`recordsHistory`). A row that has a document is never touched.
 *  - A build: `workout_doc`, only while still NULL; one statement.
 *
 * RESUMABLE, IDEMPOTENT. Keyset by id (`after` → `nextAfter`). A row leaves the scan when it gets its document, so a
 * step killed part-way is finished by running it again, and a run after a full run converts nothing.
 *
 * BOUNDED (Workers Free, principles §8): ≤ `BACKFILL_MAX_LIMIT` rows per call. planned: the page, its stages and the
 * content intents of its rows outside coach plans (a read each), the weight unit (one read, only when a coach body is on
 * the page), one statement per document and one per label of revisions (coach, import): ≤ 26. builds: the page —
 * `payload.build` only, never the view — and one statement
 * per document: ≤ 21. The page stays at 20 for the CPU (each document is converted and schema-checked), not the
 * statements. No column is read that the conversion does not need. A dry run reads and converts exactly as a real one,
 * and writes nothing; `convertedBy` says which converter each document came from.
 */
import { and, asc, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { coachPlans, plannedWorkouts, plannedWorkoutStages, sessionBuilds, syncIntents } from "@rg/database";
import { APP_AUTHORED_ORIGINS, appAuthoredRow, coachSessionSchema, nowInstant, sessionSummaryLine, type CoachSession, type WeightUnit, type WorkoutDoc } from "@rg/domain";
import type { BuildPayload } from "@rg/workout";
import { chunkIds, runAtomically, type AtomicStatement, type Db } from "./db.js";
import { CRON_DOC_BACKFILL_MAX } from "./cron-limits.js";
import { loadPreferences } from "./calendar-sync.js";
import { isUpstreamFingerprint } from "./coach-apply.js";
import {
  docForBuild,
  docForCoachSession,
  docForStages,
  FROZEN_STATES,
  plannedStageOfRow,
  revisionInserts,
  storedDocText,
  withStageTargets,
  type ConversionFailed,
  type DocSourceKind,
  type StagesRowMeta,
} from "./workout-doc-store.js";

export type BackfillKind = "planned" | "builds";
export const BACKFILL_KINDS: readonly BackfillKind[] = ["planned", "builds"];

/**
 * Rows per call: the default, and the most. The statements would allow more (4 reads + 20 updates + 2 revision
 * statements = 26 of 45); the cap is for the CPU of converting and schema-checking each document on Workers Free.
 */
export const BACKFILL_DEFAULT_LIMIT = 15;
export const BACKFILL_MAX_LIMIT = 20;

/** Why a row was left without a document (by design, not a failure). */
export type SkipReason = "rest" | "outline" | "app_built";

/**
 * The converter a document came from: the coach's session; the stages of a row the import wrote (`stages`) or of one
 * the coach wrote at some point and the stages now say better (`authoredAsStages`: a body the import restaged since, a
 * coach run whose stages are the wire's or no longer the coach's blocks); a build. `studio`: no stored row holds an old
 * Studio session (always 0). The buckets partition `converted`.
 */
export type ConvertedBy = "coachSession" | "stages" | "authoredAsStages" | "build" | "studio";

export interface BackfillReport {
  dryRun: boolean;
  kind: BackfillKind;
  /** Rows read on this page. */
  scanned: number;
  /** Documents written (a dry run: that would be written). */
  converted: number;
  convertedBy: Record<ConvertedBy, number>;
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

/**
 * THE HOURLY'S SMALL BACKFILL (Stage 2 batch end; `CRON_DOC_BACKFILL_MAX`): a live row that lost its document since the
 * last manual backfill — reopened from completed, skipped or missed (`reopenedDocColumns`), repaired — gets it again,
 * a few a run, the most recently changed first, through `backfillPlanned`'s own converters, writes and revisions. Only
 * rows a writer would derive: never a frozen row (completed, skipped, missed: what it had is history), never an
 * app-authored row (a programme's slot or an on-demand session — its build carries the document — nor a Studio or
 * template row, whose document is its content and is never derived), never a rest day or an archived row. A row whose
 * conversion fails stays as it is; one that converts leaves the scan. No cursor: the manual backfill's keyset still
 * reaches whatever is older than a run's page.
 */
export async function backfillLiveDocs(db: Db, userId: string, opts: { limit?: number; now?: string }): Promise<BackfillReport> {
  return backfillPlanned(db, userId, { kind: "planned", dryRun: false }, Math.min(opts.limit ?? CRON_DOC_BACKFILL_MAX, BACKFILL_MAX_LIMIT), opts.now ?? nowInstant(), {
    live: true,
  });
}

class Tally {
  readonly report: BackfillReport;
  constructor(opts: BackfillOptions, scanned: number, nextAfter: string | null) {
    this.report = {
      dryRun: opts.dryRun,
      kind: opts.kind,
      scanned,
      converted: 0,
      convertedBy: { coachSession: 0, stages: 0, authoredAsStages: 0, build: 0, studio: 0 },
      skipped: 0,
      skippedBy: {},
      failed: [],
      nextAfter,
    };
  }
  convert(by: ConvertedBy): void {
    this.report.converted += 1;
    this.report.convertedBy[by] += 1;
  }
  skip(reason: SkipReason): void {
    this.report.skipped += 1;
    this.report.skippedBy[reason] = (this.report.skippedBy[reason] ?? 0) + 1;
  }
  fail(id: string, code: string): void {
    this.report.failed.push({ id, code });
  }
}

/** What one row threw, as a code: the error's class name only (its message can quote the data it failed on). */
const threw = (e: unknown): string => `threw/${e instanceof Error && /^\w{1,40}$/.test(e.name) ? e.name : "unknown"}`;

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

/**
 * The coach's run blocks back from the stages `writeStages` wrote for them — top-level, timed or measured, labelled with
 * the block's intensity (or nothing), no strength fields — or null when the stages are not that (the wire's own). The
 * blocks hold no target: a stage's pace band, heart-rate band or zone rides into the document item by item
 * (`withStageTargets`, the store's helper the coach's own write uses too).
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

interface PlannedFacts {
  id: string;
  title: string;
  category: string;
  qualitySubtype: string | null;
  sport: string;
  /** Raw text (Drizzle's json mode would throw on a malformed column and fail the whole page). */
  structured: string | null;
  stageSummary: string | null;
  sourceSeconds: number | null;
  fallbackSeconds: number | null;
  calendarSeconds: number;
  fingerprint: string;
  coachPlanId: string | null;
}

type Conversion = { doc: WorkoutDoc; by: "coachSession" | "stages" | "authoredAsStages" } | { code: string };

class Unreadable extends Error {}

/** A coach session, or null when what was read back is none. */
function coachSession(candidate: Record<string, unknown>): CoachSession | null {
  const parsed = coachSessionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * One planned row's document, from its content's last writer (module rules). `authored`: the coach wrote this row's
 * content at some point — it is a coach plan's row, or an ease rewrote it (its content intent, `sync_intents`).
 */
async function convertPlanned(
  row: PlannedFacts,
  stages: StageRow[],
  authored: boolean,
  weightUnit: () => Promise<WeightUnit | undefined>,
): Promise<Conversion> {
  let code: string | null = null;
  const onFailed: ConversionFailed = (c) => (code = c);
  const meta: StagesRowMeta = {
    title: row.title,
    sport: row.sport,
    category: row.category,
    qualitySubtype: row.qualitySubtype,
    durationSeconds: row.sourceSeconds ?? row.fallbackSeconds,
  };
  let structured: StructuredBody | null = null;
  if (row.structured !== null) {
    try {
      const value: unknown = JSON.parse(row.structured);
      structured = value !== null && typeof value === "object" ? (value as StructuredBody) : null;
    } catch {
      throw new Unreadable();
    }
  }
  const base = { category: row.category, title: row.title, durationMinutes: Math.round((row.sourceSeconds ?? row.fallbackSeconds ?? row.calendarSeconds) / 60) };
  const hasBody = structured !== null && Array.isArray(structured.exercises) && structured.exercises.length > 0;

  const asStages = (): Conversion => {
    const doc = docForStages(stages.map(plannedStageOfRow), meta, onFailed);
    // A row the coach wrote (a coach plan's, an eased one, a body) whose current content is read from its stages.
    return doc ? { doc, by: authored || hasBody ? "authoredAsStages" : "stages" } : { code: code ?? "no_document" };
  };
  const asSession = async (session: CoachSession): Promise<Conversion> => {
    // Loads are typed in the athlete's unit, as the coach's add types them; only a body has loads. A run carries its
    // stages' targets, exactly as the coach's own write does (the store's `withStageTargets`).
    const doc = withStageTargets(
      docForCoachSession(session, { weightUnit: session.lift || session.mobility ? await weightUnit() : undefined }, onFailed),
      stages,
    );
    return doc ? { doc, by: "coachSession" } : { code: code ?? "no_document" };
  };

  if (structured && hasBody) {
    // The import restaged it after the coach: stage rows under a body, and the wire's fingerprint.
    if (stages.length > 0 && isUpstreamFingerprint(row.fingerprint)) return asStages();
    const body = { ...(structured.rounds ? { rounds: structured.rounds } : {}), exercises: structured.exercises };
    const session = coachSession({ ...base, ...(row.sport === "yoga" ? { mobility: body } : { lift: body }) });
    return session ? asSession(session) : { code: "coach_session_invalid" };
  }
  if (stages.length > 0) {
    const blocks = authored ? coachBlocksOf(stages) : null;
    const session = blocks ? coachSession({ ...base, run: { blocks } }) : null;
    // The coach's blocks while the row still reads as the coach wrote them; the import's restage writes its own line.
    return session && row.stageSummary === sessionSummaryLine(session) ? asSession(session) : asStages();
  }
  if (authored) {
    const session = coachSession(base);
    return session ? asSession(session) : { code: "coach_session_invalid" };
  }
  return asStages();
}

async function backfillPlanned(
  db: Db,
  userId: string,
  opts: BackfillOptions,
  limit: number,
  now: string,
  scope: { live: boolean } = { live: false },
): Promise<BackfillReport> {
  const pw = plannedWorkouts;
  // The hourly's live rows (`backfillLiveDocs`): only what a writer would derive, the most recently changed first.
  const live = scope.live
    ? [
        ne(pw.category, "rest"),
        or(isNull(pw.completionState), notInArray(pw.completionState, [...FROZEN_STATES])),
        or(isNull(pw.origin), notInArray(pw.origin, [...APP_AUTHORED_ORIGINS])),
      ]
    : [];
  const rows = await db
    .select({
      id: pw.id,
      title: pw.title,
      category: pw.category,
      qualitySubtype: pw.qualitySubtype,
      sport: pw.sport,
      origin: pw.origin,
      contentState: pw.contentState,
      structured: sql<string | null>`${pw.structuredJson}`,
      stageSummary: pw.stageSummary,
      sourceSeconds: pw.sourceEstimatedDurationSeconds,
      fallbackSeconds: pw.fallbackEstimatedDurationSeconds,
      calendarSeconds: pw.calendarBlockDurationSeconds,
      fingerprint: pw.sourceContentFingerprint,
      coachPlanId: coachPlans.id,
    })
    .from(pw)
    .leftJoin(coachPlans, and(eq(coachPlans.id, pw.planId), eq(coachPlans.userId, pw.userId)))
    .where(and(eq(pw.userId, userId), isNull(pw.workoutDoc), isNull(pw.archivedAt), ...live, ...(opts.after ? [gt(pw.id, opts.after)] : [])))
    .orderBy(...(scope.live ? [desc(pw.updatedAt), asc(pw.id)] : [asc(pw.id)]))
    .limit(limit + 1);
  const paging = paged(rows, limit);
  const { page } = paging;
  const nextAfter = scope.live ? null : paging.nextAfter;
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
  // The rows an ease rewrote (outside a coach plan): their content is the coach's too. One read a page.
  const eased = new Set<string>();
  const outsideCoachPlans = convertible.filter((r) => r.coachPlanId === null).map((r) => r.id);
  if (outsideCoachPlans.length > 0) {
    for (const ids of chunkIds(outsideCoachPlans)) {
      const claims = await db
        .select({ id: syncIntents.targetId })
        .from(syncIntents)
        .where(and(eq(syncIntents.userId, userId), eq(syncIntents.kind, "content"), inArray(syncIntents.targetId, ids)));
      for (const c of claims) eased.add(c.id);
    }
  }
  // Read once a page, and only when a coach body needs it (a failed read fails those rows, not the page).
  let unit: Promise<WeightUnit | undefined> | null = null;
  const weightUnit = () => (unit ??= loadPreferences(db, userId).then((p) => p.weightUnit));

  const updates: AtomicStatement[] = [];
  const written = new Map<string, string>();
  const byLabel: Record<"coach" | "coros_import", string[]> = { coach: [], coros_import: [] };
  for (const row of page) {
    if (row.category === "rest") {
      tally.skip("rest");
      continue;
    }
    if (appAuthoredRow(row)) {
      tally.skip(row.contentState === "outline" || row.contentState === null ? "outline" : "app_built");
      continue;
    }
    let result: Conversion;
    try {
      result = await convertPlanned(row, stagesOf.get(row.id) ?? [], row.coachPlanId !== null || eased.has(row.id), weightUnit);
    } catch (e) {
      tally.fail(row.id, e instanceof Unreadable ? "structure_unreadable" : threw(e));
      continue;
    }
    if ("code" in result) {
      tally.fail(row.id, result.code);
      continue;
    }
    tally.convert(result.by);
    if (opts.dryRun) continue;
    const text = storedDocText(result.doc)!;
    written.set(row.id, text);
    // Labelled by the converter that made the document: the coach's session, or the stages as the import reads them.
    byLabel[result.by === "coachSession" ? "coach" : "coros_import"].push(row.id);
    updates.push(
      db
        .update(pw)
        .set({
          workoutDoc: text,
          // Past the counter and past the history: `coalesce(rev, 0) + 1` wherever the writers kept them in step.
          workoutDocRev: sql`max(coalesce(${pw.workoutDocRev}, 0), coalesce((select max(r.rev) from workout_doc_revisions r where r.workout_id = planned_workouts.id), 0)) + 1`,
        })
        .where(and(eq(pw.id, row.id), eq(pw.userId, userId), isNull(pw.workoutDoc))),
    );
  }

  // The page's documents and their revisions as ONE batch: all land, or none and the step runs again.
  const revisions = (ids: string[], sourceKind: DocSourceKind, sourceRef: SQL | null) =>
    revisionInserts(db, { userId, workoutIds: ids, sourceKind, sourceRef, now, recordsHistory: true, writtenDocs: written });
  const [first, ...rest] = updates;
  if (first) {
    await runAtomically(db, [
      first,
      ...rest,
      ...revisions(byLabel.coach, "coach", null),
      // The import's label carries the row's own upstream version, as the import's rule 7 writes it.
      ...revisions(byLabel.coros_import, "coros_import", sql`${pw.sourceContentFingerprint}`),
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
    try {
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
      if (!opts.dryRun) {
        // One statement a build: one row's failure is its own.
        await db
          .update(sb)
          .set({ workoutDoc: storedDocText(doc) })
          .where(and(eq(sb.id, row.id), eq(sb.userId, userId), isNull(sb.workoutDoc)));
      }
      tally.convert("build");
    } catch (e) {
      tally.fail(row.id, threw(e));
    }
  }
  return tally.report;
}
