/**
 * THE WORKOUT DOCUMENT BACKFILL (Stage 1 Task 14; programme spec §3.4, §3.8 "Backfill"; Review Focus 4).
 *
 * The world is made by the real writers (the COROS import, the coach's adds, the session builder), each of which
 * writes its document today; then the clock is turned back — the documents, their counters and their history removed —
 * and the backfill must put back exactly what the writers wrote: the same document, at revision 1, with its revision
 * row. Around it: a rest day, programme slots, an archived row, a resolved row, a row whose history already holds a
 * revision, a row whose structure is unreadable, a row whose converter throws, and another account's row.
 *
 * Gates: a dry run writes nothing and reports what a real run would do; a real run converts N rows; a run killed at
 * ANY write, run again, ends exactly where one uninterrupted run ends; a second full run converts 0; no column but the
 * document's own changes; every call stays inside the 45-statement budget; a revision id can never collide.
 *
 * Synthetic fixtures only.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  adaptiveConfigSchema,
  addDays,
  coachOpSchema,
  coachSessionSchema,
  parseStoredWorkoutDoc,
  sessionSummaryLine,
  todayInZone,
  type CoachOp,
  type PlannedStage,
  type UserPreferences,
  type WorkoutDoc,
} from "@rg/domain";
import type { SourcePlannedWorkout, TrainingPlanInfo } from "@rg/providers";
import type { Env } from "../src/env.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { adminRoutes } from "../src/routes/admin.js";
import type { Db } from "../src/services/db.js";
import { applyOps } from "../src/services/coach-apply.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { buildSession } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import {
  BACKFILL_DEFAULT_LIMIT,
  BACKFILL_MAX_LIMIT,
  backfillWorkoutDocs,
  type BackfillKind,
  type BackfillReport,
} from "../src/services/workout-doc-backfill.js";
import { withStageTargets, type StageRowLike } from "../src/services/workout-doc-store.js";
import { cloneTestDb, isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

/** The stages converter throws for this one title: the row whose conversion fails. */
const BREAKS = "Breaks the converter";
vi.mock("@rg/workout", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rg/workout")>();
  return {
    ...real,
    docFromStages: (...a: Parameters<typeof real.docFromStages>) => {
      if (a[1].title === "Breaks the converter") throw new TypeError("injected");
      return real.docFromStages(...a);
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });

const { plannedWorkouts, plannedWorkoutStages, programs, sessionBuilds, workoutDocRevisions, coachPlans } = schema;

/** The backfill's clock, fixed so two runs of it can be compared row for row. */
const NOW = "2026-10-10T12:00:00.000Z";
/** The session builder's clock (its own fixed day, as the dual-write test's). */
const BUILT_AT = "2026-10-07T19:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
});

const silence = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);
const client = (db: Db) => (db as unknown as { $client: Database.Database }).$client;

// ── The world ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface World {
  base: Db;
  userId: string;
  otherUserId: string;
  prefs: UserPreferences;
  /** What the writers wrote, by row id (planned rows and builds): the documents the backfill must put back. */
  written: Map<string, string>;
  ids: {
    imported: { intervals: string; easy: string; lift: string; rest: string };
    coach: { run: string; lift: string; mobility: string; bodyless: string; rest: string };
    slots: { built: string; outline: string; preview: string };
    builds: string[];
    archived: string;
    unreadable: string;
    breaks: string;
    other: string;
  };
}

const st = (o: Partial<PlannedStage> & Pick<PlannedStage, "id" | "order" | "kind">): PlannedStage => ({ durationType: "none", ...o });
const INTERVALS: PlannedStage[] = [
  st({ id: "1", order: 0, kind: "warmup", durationType: "time", durationSeconds: 600 }),
  st({ id: "2", order: 1, kind: "repeat", repeatCount: 5 }),
  st({ id: "3", parentStageId: "2", order: 0, kind: "work", durationType: "time", durationSeconds: 180, targetType: "pace", targetLow: 250, targetHigh: 260 }),
  st({ id: "4", parentStageId: "2", order: 1, kind: "recovery", durationType: "time", durationSeconds: 120 }),
  st({ id: "5", order: 2, kind: "cooldown", durationType: "time", durationSeconds: 600 }),
];
const EASY: PlannedStage[] = [st({ id: "1", order: 0, kind: "work", durationType: "time", durationSeconds: 1800 })];
const LIFT_STAGES: PlannedStage[] = [
  st({ id: "1", order: 0, kind: "repeat", repeatCount: 3 }),
  st({ id: "2", parentStageId: "1", order: 0, kind: "work", label: "Goblet Squat", reps: 8, loadKg: 16, restSeconds: 90 }),
  st({ id: "3", order: 1, kind: "repeat", repeatCount: 3 }),
  st({ id: "4", parentStageId: "3", order: 0, kind: "work", label: "Jumping Lunges", reps: 10, restSeconds: 60 }),
];

const COACH_RUN = {
  category: "easy",
  title: "Steady 40",
  durationMinutes: 40,
  run: { blocks: [{ kind: "duration", value: 10, intensity: "easy" }, { kind: "duration", value: 25, intensity: "steady" }, { kind: "duration", value: 5, intensity: "easy" }] },
};
const COACH_LIFT = {
  category: "strength",
  title: "Legs",
  durationMinutes: 30,
  lift: {
    exercises: [
      { name: "Goblet squat", sets: 3, reps: 8, weight: { type: "kg", value: 11.3 }, restSeconds: 90 },
      { name: "A move of the coach's own", sets: 2, reps: 10, weight: { type: "bodyweight" }, restSeconds: 60 },
    ],
  },
};
const COACH_MOBILITY = {
  category: "yoga",
  title: "Hips",
  durationMinutes: 20,
  mobility: { exercises: [{ name: "Something gentle", sets: 1, holdSeconds: 60, weight: { type: "bodyweight" }, restSeconds: 0 }] },
};
const COACH_BODYLESS = { category: "easy", title: "Easy by feel", durationMinutes: 30 };
const COACH_REST = { category: "rest", title: "Rest", durationMinutes: 0 };

/** A planned row written directly (the shapes no writer makes on demand: archived, unreadable, another account's). */
async function insertRow(
  db: Db,
  o: { id: string; userId: string; planId: string; title: string; category?: string; sport?: string; archivedAt?: string | null; structuredJson?: unknown },
): Promise<void> {
  await db.insert(plannedWorkouts).values({
    id: o.id, userId: o.userId, planId: o.planId, sourceWorkoutId: o.id, title: o.title, category: o.category ?? "easy", sport: o.sport ?? "run",
    originalPlanDate: "2026-10-12", lastVerifiedCorosDate: "2026-10-12", effectiveDate: "2026-10-12", effectiveTime: "07:00",
    sourceContentFingerprint: `fp-${o.id}`, sourceEstimatedDurationSeconds: 1800, calendarBlockDurationSeconds: 2400,
    completionState: "scheduled", archivedAt: o.archivedAt ?? null, createdAt: BUILT_AT, updatedAt: BUILT_AT,
    ...(o.structuredJson !== undefined ? { structuredJson: o.structuredJson as { exercises: unknown[] } } : {}),
  });
  await db.insert(plannedWorkoutStages).values({ id: `${o.id}:1`, workoutId: o.id, ord: 0, kind: "work", durationType: "time", durationSeconds: 1800 });
}

async function makeWorld(): Promise<World> {
  const base = makeTestDb({ boundVariableCap: 100 });
  const { userId, prefs } = await makeTestUser(base, { weightUnit: "lb" });
  const { userId: otherUserId } = await makeTestUser(base);
  const today = todayInZone(prefs.timezone);

  // The COROS import: an interval run, an easy run, a lift, a rest day.
  const PLAN: TrainingPlanInfo = { sourcePlanId: "plan-1", name: "Test plan" };
  const src = (n: number, o: Partial<SourcePlannedWorkout>): SourcePlannedWorkout => ({
    sourcePlanId: "plan-1", sourceWorkoutId: `plan-1:${n}`, sourceIdInPlan: String(n), sourceProgramId: `prog-${n}`, title: "Workout",
    sport: "run", date: addDays(today, n), stages: EASY, contentFingerprint: `fp-${n}`, isRestDay: false, ...o,
  });
  await importPlanSnapshot(
    base,
    {
      userId, plan: PLAN, rangeStart: today, rangeEnd: addDays(today, 13), source: "fixture",
      workouts: [
        src(1, { title: "Threshold 5x3", stages: INTERVALS }),
        src(2, { title: "Easy 30", stages: EASY }),
        src(3, { title: "Legs", sport: "strength", stages: LIFT_STAGES }),
        src(4, { title: "Rest", stages: [], isRestDay: true }),
      ],
    },
    prefs,
  );
  const bySource = async (n: number) =>
    (await base.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(eq(plannedWorkouts.sourceWorkoutId, `plan-1:${n}`)))[0]!.id;
  const imported = { intervals: await bySource(1), easy: await bySource(2), lift: await bySource(3), rest: await bySource(4) };

  // The coach: a run, a lift, a mobility session, a session with no body, a rest day.
  const add = (n: number, session: unknown): CoachOp => coachOpSchema.parse({ kind: "add", date: addDays(today, n), session });
  const out = await applyOps(base, userId, prefs, "p-add", [
    add(2, COACH_RUN), add(3, COACH_LIFT), add(4, COACH_MOBILITY), add(5, COACH_BODYLESS), add(6, COACH_REST),
  ]);
  const [run, lift, mobility, bodyless, rest] = out.created as [string, string, string, string, string];

  // A programme: a slot built today, an outline slot, and a slot built ahead (a preview: the row stays an outline).
  const programId = "program-backfill";
  await base.insert(programs).values({
    id: programId, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"],
    startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
    createdAt: BUILT_AT, updatedAt: BUILT_AT, archivedAt: null,
  });
  const seedSlot = async (date: string): Promise<string> => {
    const id = slotId(programId, date);
    await base.insert(plannedWorkouts).values({
      id, userId, planId: programId, sourceWorkoutId: id, title: "Mobility", category: "yoga", sport: "yoga",
      originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "program", contentState: "outline", createdAt: BUILT_AT, updatedAt: BUILT_AT,
    });
    return id;
  };
  const slots = { built: await seedSlot("2026-10-07"), outline: await seedSlot("2026-10-08"), preview: await seedSlot("2026-10-09") };
  const ctx = { today: "2026-10-07", now: BUILT_AT, prefs };
  await buildSession(base, userId, slots.built, {}, ctx);
  await buildSession(base, userId, slots.preview, { overrides: { minutes: 20 } }, ctx);
  const builds = (await base.select({ id: sessionBuilds.id }).from(sessionBuilds)).map((b) => b.id);

  // Rows written directly: archived, an unreadable coach structure, a converter that throws, another account's.
  const [coachPlan] = await base.select({ planId: plannedWorkouts.planId }).from(plannedWorkouts).where(eq(plannedWorkouts.id, lift));
  await insertRow(base, { id: "row-archived", userId, planId: "plan-1", title: "Gone", archivedAt: BUILT_AT });
  await insertRow(base, { id: "row-unreadable", userId, planId: coachPlan!.planId, title: "Strength", category: "strength", sport: "strength" });
  client(base).prepare(`update planned_workouts set structured_json = '{not json' where id = 'row-unreadable'`).run();
  await insertRow(base, { id: "row-breaks", userId, planId: "plan-1", title: BREAKS });
  await insertRow(base, { id: "row-other", userId: otherUserId, planId: "plan-other", title: "Theirs" });
  client(base)
    .prepare(`insert into session_builds (id, user_id, workout_id, version, engine_version, inputs_hash, payload, workout_doc, locked_at, created_at) select 'build-other', ?, 'row-other', 1, engine_version, inputs_hash, payload, null, null, created_at from session_builds limit 1`)
    .run(otherUserId);

  // What the writers wrote.
  const written = new Map<string, string>();
  for (const r of client(base).prepare(`select id, workout_doc as doc from planned_workouts where workout_doc is not null`).all() as Array<{ id: string; doc: string }>) written.set(r.id, r.doc);
  for (const r of client(base).prepare(`select id, workout_doc as doc from session_builds where workout_doc is not null and user_id = ?`).all(userId) as Array<{ id: string; doc: string }>) written.set(r.id, r.doc);

  // Back to before Stage 1. The interval run keeps its counter and its first revision, only its document gone (a later
  // conversion that failed): its next revision must be 2. The easy run was done since: a resolved row.
  client(base).prepare(`update planned_workouts set workout_doc = null, workout_doc_rev = null where id != ?`).run(imported.intervals);
  client(base).prepare(`update planned_workouts set workout_doc = null where id = ?`).run(imported.intervals);
  client(base).prepare(`delete from workout_doc_revisions where workout_id != ?`).run(imported.intervals);
  client(base).prepare(`update session_builds set workout_doc = null`).run();
  client(base).prepare(`update planned_workouts set completion_state = 'completed', resolution_date = effective_date where id = ?`).run(imported.easy);

  return {
    base, userId, otherUserId, prefs, written,
    ids: {
      imported, coach: { run, lift, mobility, bodyless, rest }, slots, builds,
      archived: "row-archived", unreadable: "row-unreadable", breaks: "row-breaks", other: "row-other",
    },
  };
}

/** Every row of every table, in rowid order. */
function dump(db: Db): Record<string, Array<Record<string, unknown>>> {
  const c = client(db);
  const tables = c.prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`).all() as Array<{ name: string }>;
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const { name } of tables) out[name] = c.prepare(`select * from "${name}" order by rowid`).all() as Array<Record<string, unknown>>;
  return out;
}

/** Calls until the kind is done; every report, in order. */
async function runAll(db: Db, userId: string, kind: BackfillKind, opts: { dryRun: boolean; limit?: number }): Promise<BackfillReport[]> {
  const reports: BackfillReport[] = [];
  let after: string | undefined;
  for (let i = 0; i < 100; i++) {
    const r = await backfillWorkoutDocs(db, userId, { kind, dryRun: opts.dryRun, limit: opts.limit, now: NOW, ...(after ? { after } : {}) });
    reports.push(r);
    if (r.nextAfter === null) return reports;
    after = r.nextAfter;
  }
  throw new Error("the backfill never finished");
}

const total = (reports: BackfillReport[]) => ({
  scanned: reports.reduce((n, r) => n + r.scanned, 0),
  converted: reports.reduce((n, r) => n + r.converted, 0),
  convertedBy: reports.reduce<Record<string, number>>((acc, r) => {
    for (const [k, v] of Object.entries(r.convertedBy)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {}),
  skipped: reports.reduce((n, r) => n + r.skipped, 0),
  skippedBy: reports.reduce<Record<string, number>>((acc, r) => {
    for (const [k, v] of Object.entries(r.skippedBy)) acc[k] = (acc[k] ?? 0) + (v ?? 0);
    return acc;
  }, {}),
  failed: reports.flatMap((r) => r.failed).sort((a, b) => a.id.localeCompare(b.id)),
});

/** A planned row, its JSON columns as raw text (one of them is deliberately not JSON). */
const rowOf = async (db: Db, id: string) =>
  (
    await db
      .select({ ...getTableColumns(plannedWorkouts), workoutDoc: sql<string | null>`${plannedWorkouts.workoutDoc}`, structuredJson: sql<string | null>`${plannedWorkouts.structuredJson}` })
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.id, id))
  )[0]!;
const revisionsOf = async (db: Db, id: string) =>
  (await db.select({ ...getTableColumns(workoutDocRevisions), doc: sql<string>`${workoutDocRevisions.doc}` }).from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id))).sort((a, b) => a.rev - b.rev);
const buildDocOf = async (db: Db, id: string) =>
  (await db.select({ doc: sql<string | null>`${sessionBuilds.workoutDoc}` }).from(sessionBuilds).where(eq(sessionBuilds.id, id)))[0]!.doc;

let world: World;
beforeAll(async () => {
  world = await makeWorld();
});

// ── The dry run ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("the dry run", () => {
  it("writes nothing, and reports exactly what a real run does", async () => {
    silence();
    const statements: string[] = [];
    const db = cloneTestDb(world.base, { boundVariableCap: 100, onStatement: (q) => statements.push(q) });
    const before = dump(db);
    statements.length = 0;
    const planned = total(await runAll(db, world.userId, "planned", { dryRun: true, limit: 4 }));
    const builds = total(await runAll(db, world.userId, "builds", { dryRun: true, limit: 4 }));
    expect(statements.filter(isWrite)).toEqual([]);
    expect(dump(db)).toEqual(before);

    const { ids } = world;
    // 7 documents (3 imported runs and lift, 4 coach sessions), 5 skipped (2 rest days, 3 programme slots), 2 failed.
    expect(planned).toEqual({
      scanned: 14,
      converted: 7,
      convertedBy: { coachSession: 4, stages: 3, authoredAsStages: 0, build: 0, studio: 0 },
      skipped: 5,
      skippedBy: { rest: 2, outline: 2, app_built: 1 },
      failed: [
        { id: ids.breaks, code: "coros_import/TypeError" },
        { id: ids.unreadable, code: "structure_unreadable" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    });
    expect(builds).toEqual({
      scanned: ids.builds.length,
      converted: ids.builds.length,
      convertedBy: { coachSession: 0, stages: 0, authoredAsStages: 0, build: ids.builds.length, studio: 0 },
      skipped: 0,
      skippedBy: {},
      failed: [],
    });

    // The real run reports the same.
    const real = cloneTestDb(world.base, { boundVariableCap: 100 });
    expect(total(await runAll(real, world.userId, "planned", { dryRun: false, limit: 4 }))).toEqual(planned);
    expect(total(await runAll(real, world.userId, "builds", { dryRun: false, limit: 4 }))).toEqual(builds);
  });

  it("pages by id: each page starts after the last, and the last says so", async () => {
    silence();
    const db = cloneTestDb(world.base, { boundVariableCap: 100 });
    const reports = await runAll(db, world.userId, "planned", { dryRun: true, limit: 4 });
    expect(reports.map((r) => r.scanned)).toEqual([4, 4, 4, 2]);
    expect(reports.map((r) => r.dryRun)).toEqual([true, true, true, true]);
    expect(reports.map((r) => r.kind)).toEqual(["planned", "planned", "planned", "planned"]);
    expect(reports.at(-1)!.nextAfter).toBeNull();
    const cursors = reports.slice(0, -1).map((r) => r.nextAfter!);
    expect([...cursors].sort()).toEqual(cursors);
    // A last page exactly as long as the limit knows it is the last: no empty call after it.
    expect((await runAll(db, world.userId, "planned", { dryRun: true, limit: 7 })).map((r) => [r.scanned, r.nextAfter === null])).toEqual([[7, false], [7, true]]);
  });

  it("codes, never titles: a failure names its id and a code", async () => {
    silence();
    const db = cloneTestDb(world.base, { boundVariableCap: 100 });
    const { failed } = total(await runAll(db, world.userId, "planned", { dryRun: true }));
    for (const f of failed) {
      expect(Object.keys(f).sort()).toEqual(["code", "id"]);
      expect(f.code).toMatch(/^[\w/:@.-]+$/);
      expect(f.code).not.toContain(BREAKS);
    }
  });
});

// ── The real run ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("the real run", () => {
  let db: Db;
  let before: ReturnType<typeof dump>;

  beforeAll(async () => {
    silence();
    db = cloneTestDb(world.base, { boundVariableCap: 100 });
    before = dump(db);
    await runAll(db, world.userId, "planned", { dryRun: false, limit: 4 });
    await runAll(db, world.userId, "builds", { dryRun: false, limit: 4 });
  });

  it("puts back exactly the document each writer wrote, at revision 1, with its revision row", async () => {
    const { ids, written } = world;
    const sources: Array<[string, "coros_import" | "coach", string | null]> = [
      [ids.imported.easy, "coros_import", "fp-2"],
      [ids.imported.lift, "coros_import", "fp-3"],
      [ids.coach.run, "coach", null],
      [ids.coach.lift, "coach", null],
      [ids.coach.mobility, "coach", null],
      [ids.coach.bodyless, "coach", null],
    ];
    for (const [id, sourceKind, sourceRef] of sources) {
      const row = await rowOf(db, id);
      expect(written.get(id), `${row.title}: the writer wrote one`).toBeTruthy();
      expect(parseStoredWorkoutDoc(row.workoutDoc), row.title).toEqual(parseStoredWorkoutDoc(written.get(id)));
      expect(row.workoutDocRev, row.title).toBe(1);
      const revs = await revisionsOf(db, id);
      expect(revs.map((r) => [r.id, r.rev, r.userId, r.sourceKind, r.sourceRef, r.createdAt]), row.title).toEqual([[`${id}:1`, 1, world.userId, sourceKind, sourceRef, NOW]]);
      expect(revs[0]!.doc).toBe(row.workoutDoc);
    }
  });

  it("a resolved row gets its first document: history being recorded, not an edit", async () => {
    const row = await rowOf(db, world.ids.imported.easy);
    expect(row.completionState).toBe("completed");
    expect([row.workoutDocRev, parseStoredWorkoutDoc(row.workoutDoc)?.title]).toEqual([1, "Easy 30"]);
    expect((await revisionsOf(db, row.id)).map((r) => r.id)).toEqual([`${row.id}:1`]);
  });

  it("a row whose history holds revision 1 gets revision 2; the first is untouched", async () => {
    const id = world.ids.imported.intervals;
    const row = await rowOf(db, id);
    expect(row.workoutDocRev).toBe(2);
    expect(parseStoredWorkoutDoc(row.workoutDoc)).toEqual(parseStoredWorkoutDoc(world.written.get(id)));
    const revs = await revisionsOf(db, id);
    expect(revs.map((r) => [r.id, r.rev, r.sourceKind, r.sourceRef])).toEqual([[`${id}:1`, 1, "coros_import", "fp-1"], [`${id}:2`, 2, "coros_import", "fp-1"]]);
    expect(revs[0]).toEqual((before.workout_doc_revisions as Array<Record<string, unknown>>).map((r) => ({
      id: r.id, userId: r.user_id, workoutId: r.workout_id, rev: r.rev, doc: r.doc, sourceKind: r.source_kind, sourceRef: r.source_ref, createdAt: r.created_at,
    }))[0]);
    expect(revs[1]!.doc).toBe(row.workoutDoc);
  });

  it("builds get the document their build wrote (a snapshot: no revisions)", async () => {
    expect(world.ids.builds.length).toBeGreaterThanOrEqual(2);
    for (const id of world.ids.builds) {
      expect(parseStoredWorkoutDoc(await buildDocOf(db, id))).toEqual(parseStoredWorkoutDoc(world.written.get(id)));
    }
  });

  it("leaves alone: rest days, programme slots, archived rows, failures, another account", async () => {
    const { ids } = world;
    for (const id of [ids.imported.rest, ids.coach.rest, ids.slots.built, ids.slots.outline, ids.slots.preview, ids.archived, ids.unreadable, ids.breaks, ids.other]) {
      const row = await rowOf(db, id);
      expect([row.workoutDoc, row.workoutDocRev], id).toEqual([null, null]);
      expect(await revisionsOf(db, id), id).toEqual([]);
    }
    expect(await buildDocOf(db, "build-other")).toBeNull();
  });

  it("changes no other column: every other table identical, the old revision rows untouched", async () => {
    const after = dump(db);
    const without = (rows: Array<Record<string, unknown>>, cols: string[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !cols.includes(k))));
    for (const table of Object.keys(before)) {
      if (table === "workout_doc_revisions") continue;
      const cols = table === "planned_workouts" ? ["workout_doc", "workout_doc_rev"] : table === "session_builds" ? ["workout_doc"] : [];
      expect(without(after[table]!, cols), table).toEqual(without(before[table]!, cols));
    }
    // The history only grew.
    expect(after.workout_doc_revisions!.slice(0, before.workout_doc_revisions!.length)).toEqual(before.workout_doc_revisions);
    expect(after.workout_doc_revisions!.length - before.workout_doc_revisions!.length).toBe(7);
    // No updated_at moved, no document a writer wrote was rewritten.
    const docBefore = new Map(before.planned_workouts!.map((r) => [r.id, r.workout_doc]));
    for (const r of after.planned_workouts!) if (docBefore.get(r.id) !== null) expect(r.workout_doc).toBe(docBefore.get(r.id));
  });

  it("a second full run converts 0 and writes nothing", async () => {
    silence();
    const statements: string[] = [];
    const again = cloneTestDb(db, { boundVariableCap: 100, onStatement: (q) => statements.push(q) });
    const planned = total(await runAll(again, world.userId, "planned", { dryRun: false }));
    const builds = total(await runAll(again, world.userId, "builds", { dryRun: false }));
    expect([planned.converted, builds.converted, builds.scanned]).toEqual([0, 0, 0]);
    // What is left is what is never converted: the skipped rows and the two failures.
    expect([planned.scanned, planned.skipped, planned.failed.length]).toEqual([7, 5, 2]);
    expect(statements.filter(isWrite)).toEqual([]);
  });
});

// ── Killed part-way ───────────────────────────────────────────────────────────────────────────────────────────────

describe("killed at any write, then run again", () => {
  it("ends exactly where one uninterrupted run ends", async () => {
    silence();
    // As the lead drives it: a step that dies is run again; a pass that reports a row that threw (a build's own write
    // fails alone) is followed by another pass.
    const drive = async (db: Db, onKilled?: () => void): Promise<void> => {
      for (let pass = 0; pass < 5; pass++) {
        let threwSome = false;
        for (const kind of ["planned", "builds"] as const) {
          let after: string | undefined;
          for (let i = 0; i < 100; i++) {
            let r: BackfillReport;
            try {
              r = await backfillWorkoutDocs(db, world.userId, { kind, dryRun: false, limit: 4, now: NOW, ...(after ? { after } : {}) });
            } catch (e) {
              if (!(e instanceof Error) || e.message !== "killed") throw e;
              onKilled?.();
              continue; // the same step again, as the lead would
            }
            if (r.failed.some((f) => f.code.startsWith("threw/"))) {
              threwSome = true;
              onKilled?.();
            }
            if (r.nextAfter === null) break;
            after = r.nextAfter;
          }
        }
        if (!threwSome) return;
      }
    };

    const written: string[] = [];
    const whole = cloneTestDb(world.base, { onStatement: (q) => void (isWrite(q) && written.push(q)) });
    await drive(whole);
    const expected = dump(whole);
    // The 7 planned documents, their revisions (a statement per page and source), the builds.
    expect(written.filter((q) => /^update "planned_workouts"/.test(q))).toHaveLength(7);
    expect(written.filter((q) => /^update "session_builds"/.test(q))).toHaveLength(world.ids.builds.length);
    expect(written.filter((q) => /^insert into "workout_doc_revisions"/.test(q)).length).toBeGreaterThan(0);
    const writes = written.length;

    for (let k = 1; k <= writes; k++) {
      let seen = 0;
      let armed = true;
      let kills = 0;
      const db = cloneTestDb(world.base, {
        onStatement: (q) => {
          if (!isWrite(q)) return;
          seen += 1;
          if (armed && seen === k) throw new Error("killed");
        },
      });
      await drive(db, () => {
        kills += 1;
        armed = false;
      });
      expect(kills, `killed at write ${k}`).toBe(1);
      expect(dump(db), `killed at write ${k}`).toEqual(expected);
    }
  });
});

// ── A writer meanwhile ────────────────────────────────────────────────────────────────────────────────────────────

describe("a writer that writes the document between the backfill's read and its write", () => {
  it("wins: its document and revision stand, the backfill's write is a no-op", async () => {
    silence();
    const id = world.ids.coach.run;
    const theirs = JSON.stringify({ ...parseStoredWorkoutDoc(world.written.get(id))!, title: "Written meanwhile" });
    let raced = false;
    const db = cloneTestDb(world.base, {
      onStatement: (q) => {
        // Just before the backfill writes its first planned document: a writer (a coach ease, say) writes the row's.
        if (raced || !/^update "planned_workouts"/.test(q)) return;
        raced = true;
        const c = client(db);
        c.prepare(`update planned_workouts set workout_doc = ?, workout_doc_rev = 1 where id = ?`).run(theirs, id);
        c.prepare(`insert into workout_doc_revisions (id, user_id, workout_id, rev, doc, source_kind, source_ref, created_at) values (?, ?, ?, 1, ?, 'coach', 'p-ease', ?)`)
          .run(`${id}:1`, world.userId, id, theirs, BUILT_AT);
      },
    });
    // The coach run alone on a page: the cursor is the id before it in the scan.
    const scan = (client(world.base).prepare(`select id from planned_workouts where user_id = ? and workout_doc is null and archived_at is null order by id`).all(world.userId) as Array<{ id: string }>).map((r) => r.id);
    const before = scan[scan.indexOf(id) - 1];
    const report = await backfillWorkoutDocs(db, world.userId, { kind: "planned", dryRun: false, now: NOW, limit: 1, ...(before ? { after: before } : {}) });
    expect(raced).toBe(true);
    expect(report.scanned).toBe(1);
    const row = await rowOf(db, id);
    expect([row.workoutDoc, row.workoutDocRev]).toEqual([theirs, 1]);
    expect((await revisionsOf(db, id)).map((r) => [r.id, r.sourceRef, r.doc])).toEqual([[`${id}:1`, "p-ease", theirs]]);
  });

  it("on a resolved row too: its document is never filed under the backfill's label", async () => {
    silence();
    const id = world.ids.imported.easy; // completed
    const theirs = JSON.stringify({ ...parseStoredWorkoutDoc(world.written.get(id))!, title: "Written meanwhile" });
    let raced = false;
    const db = cloneTestDb(world.base, {
      onStatement: (q) => {
        // A writer that leaves no revision of its own (a restore, an outside edit) fills the row first.
        if (raced || !/^update "planned_workouts"/.test(q)) return;
        raced = true;
        client(db).prepare(`update planned_workouts set workout_doc = ?, workout_doc_rev = 1 where id = ?`).run(theirs, id);
      },
    });
    const scan = (client(world.base).prepare(`select id from planned_workouts where user_id = ? and workout_doc is null and archived_at is null order by id`).all(world.userId) as Array<{ id: string }>).map((r) => r.id);
    const before = scan[scan.indexOf(id) - 1];
    await backfillWorkoutDocs(db, world.userId, { kind: "planned", dryRun: false, now: NOW, limit: 1, ...(before ? { after: before } : {}) });
    expect(raced).toBe(true);
    const row = await rowOf(db, id);
    expect([row.workoutDoc, row.workoutDocRev]).toEqual([theirs, 1]);
    expect(await revisionsOf(db, id)).toEqual([]);
  });

  it("a build too: the builder's document stands", async () => {
    silence();
    const id = [...world.ids.builds].sort()[0]!;
    const theirs = JSON.stringify({ ...parseStoredWorkoutDoc(world.written.get(id))!, title: "Built meanwhile" });
    let raced = false;
    const db = cloneTestDb(world.base, {
      onStatement: (q) => {
        if (raced || !/^update "session_builds"/.test(q)) return;
        raced = true;
        client(db).prepare(`update session_builds set workout_doc = ? where id = ?`).run(theirs, id);
      },
    });
    const report = await backfillWorkoutDocs(db, world.userId, { kind: "builds", dryRun: false, now: NOW, limit: 1 });
    expect([raced, report.scanned]).toEqual([true, 1]);
    expect(await buildDocOf(db, id)).toBe(theirs);
  });
});

// ── Coach rows whose stages are not the coach's blocks ────────────────────────────────────────────────────────────

describe("a coach row whose stages the coach's blocks cannot be read back from", () => {
  it("is converted from its stages: the wire's own structure, or blocks that are no coach session", async () => {
    silence();
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await db.insert(coachPlans).values({
      id: "coach-plan", userId, discipline: "run", name: "Plan", status: "active", startDate: "2026-10-01", endDate: "2026-12-01",
      stampPrefix: "RG", createdAt: BUILT_AT, updatedAt: BUILT_AT,
    });
    // The wire's structure: a repeat (the coach writes none).
    await insertRow(db, { id: "c-wire", userId, planId: "coach-plan", title: "Intervals", category: "quality" });
    await db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, "c-wire"));
    await db.insert(plannedWorkoutStages).values([
      { id: "c-wire:1", workoutId: "c-wire", ord: 0, kind: "repeat", repeatCount: 4, durationType: "none" },
      { id: "c-wire:2", workoutId: "c-wire", parentStageId: "c-wire:1", ord: 0, kind: "work", durationType: "time", durationSeconds: 240 },
      { id: "c-wire:3", workoutId: "c-wire", parentStageId: "c-wire:1", ord: 1, kind: "recovery", durationType: "time", durationSeconds: 120 },
    ]);
    // A stage kind the coach never writes (a timed rest step: the coach's rest is a recovery).
    await insertRow(db, { id: "c-rest", userId, planId: "coach-plan", title: "Run, stand, run", category: "easy" });
    await db.insert(plannedWorkoutStages).values([
      { id: "c-rest:2", workoutId: "c-rest", ord: 1, kind: "rest", durationType: "time", durationSeconds: 120 },
      { id: "c-rest:3", workoutId: "c-rest", ord: 2, kind: "work", durationType: "time", durationSeconds: 600 },
    ]);
    // …even under the summary those stages would have as coach blocks: the shape refuses them first.
    const misread = coachSessionSchema.parse({
      category: "easy", title: "Run, stand, run", durationMinutes: 30,
      run: { blocks: [{ kind: "duration", value: 30 }, { kind: "duration", value: 2 }, { kind: "duration", value: 10 }] },
    });
    await db.update(plannedWorkouts).set({ stageSummary: sessionSummaryLine(misread) }).where(eq(plannedWorkouts.id, "c-rest"));
    // Coach-shaped blocks describing six hours inside a ten-minute session: no coach session (the schema refuses it).
    await insertRow(db, { id: "c-odd", userId, planId: "coach-plan", title: "Odd", category: "easy" });
    await db.update(plannedWorkouts).set({ sourceEstimatedDurationSeconds: 600 }).where(eq(plannedWorkouts.id, "c-odd"));
    await db.update(plannedWorkoutStages).set({ durationSeconds: 6 * 3600, label: "easy" }).where(eq(plannedWorkoutStages.workoutId, "c-odd"));

    const report = await backfillWorkoutDocs(db, userId, { kind: "planned", dryRun: false, now: NOW });
    expect([report.converted, report.failed]).toEqual([3, []]);
    const wire = parseStoredWorkoutDoc((await rowOf(db, "c-wire")).workoutDoc)!;
    expect(wire.source.kind).toBe("coros_import");
    expect(wire.parts.some((p) => p.format === "intervals" && p.rounds === 4)).toBe(true);
    for (const id of ["c-rest", "c-odd"]) expect(parseStoredWorkoutDoc((await rowOf(db, id)).workoutDoc)!.source.kind, id).toBe("coros_import");
    // The revisions say what made the documents: the stages, as the import's rule 7 labels them.
    for (const id of ["c-wire", "c-rest", "c-odd"]) expect((await revisionsOf(db, id)).map((r) => [r.rev, r.sourceKind, r.sourceRef]), id).toEqual([[1, "coros_import", `fp-${id}`]]);
    // The coach wrote these rows; their stages say it better now.
    expect(report.convertedBy).toEqual({ coachSession: 0, stages: 0, authoredAsStages: 3, build: 0, studio: 0 });
  });

  it("a coach session states the row's estimate, not its calendar block (which carries buffer)", async () => {
    silence();
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await db.insert(coachPlans).values({
      id: "coach-plan", userId, discipline: "lift", name: "Plan", status: "active", startDate: "2026-10-01", endDate: "2026-12-01",
      stampPrefix: "RG", createdAt: BUILT_AT, updatedAt: BUILT_AT,
    });
    // insertRow: an estimate of 30 minutes in a 40-minute calendar block.
    await insertRow(db, { id: "c-lift", userId, planId: "coach-plan", title: "Legs", category: "strength", sport: "strength", structuredJson: { exercises: COACH_LIFT.lift.exercises } });
    await backfillWorkoutDocs(db, userId, { kind: "planned", dryRun: false, now: NOW });
    expect(parseStoredWorkoutDoc((await rowOf(db, "c-lift")).workoutDoc)!.setting?.targetMinutes).toBe(30);
  });
});

// ── The content's last writer ─────────────────────────────────────────────────────────────────────────────────────

describe("the content's last writer decides the converter, and the revision says which", () => {
  /** An upstream (wire) fingerprint: sixteen hex characters, as COROS's reads and verifies stamp. */
  const WIRE = (n: number) => n.toString(16).padStart(16, "0");

  it("a coach body with stage rows under it and the wire's fingerprint was restaged by the import: its stages", async () => {
    silence();
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await db.insert(coachPlans).values({
      id: "coach-plan", userId, discipline: "lift", name: "Plan", status: "active", startDate: "2026-10-01", endDate: "2026-12-01",
      stampPrefix: "RG", createdAt: BUILT_AT, updatedAt: BUILT_AT,
    });
    const lift = { id: "", userId, planId: "coach-plan", title: "Legs", category: "strength", sport: "strength", structuredJson: { exercises: COACH_LIFT.lift.exercises } };
    for (const id of ["b-restaged", "b-local-stamp", "b-echo"]) await insertRow(db, { ...lift, id });
    // Restaged: the import's strength stage under the body, the wire's fingerprint.
    await db.update(plannedWorkoutStages).set({ durationType: "none", durationSeconds: null, label: "Goblet Squat", reps: 8 }).where(eq(plannedWorkoutStages.workoutId, "b-restaged"));
    await db.update(plannedWorkouts).set({ sourceContentFingerprint: WIRE(1) }).where(eq(plannedWorkouts.id, "b-restaged"));
    // The coach's own stamp (never observed upstream): the coach's content, whatever stage rows are there.
    await db.update(plannedWorkouts).set({ sourceContentFingerprint: "coach-1a2b3c" }).where(eq(plannedWorkouts.id, "b-local-stamp"));
    // The create's verify stamped the wire's echo, and wrote no stages: the coach's content.
    await db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, "b-echo"));
    await db.update(plannedWorkouts).set({ sourceContentFingerprint: WIRE(2) }).where(eq(plannedWorkouts.id, "b-echo"));
    // An imported row eased before content intents existed (a body, no intent), restaged since: still the coach's row.
    await insertRow(db, { ...lift, id: "b-old-ease", planId: "plan-1" });
    await db.update(plannedWorkoutStages).set({ durationType: "none", durationSeconds: null, label: "Goblet Squat", reps: 8 }).where(eq(plannedWorkoutStages.workoutId, "b-old-ease"));
    await db.update(plannedWorkouts).set({ sourceContentFingerprint: WIRE(4) }).where(eq(plannedWorkouts.id, "b-old-ease"));

    const report = await backfillWorkoutDocs(db, userId, { kind: "planned", dryRun: false, now: NOW });
    expect([report.failed, report.convertedBy]).toEqual([[], { coachSession: 2, stages: 0, authoredAsStages: 2, build: 0, studio: 0 }]);
    const sourceOf = async (id: string) => parseStoredWorkoutDoc((await rowOf(db, id)).workoutDoc)!.source.kind;
    const labelOf = async (id: string) => (await revisionsOf(db, id)).map((r) => [r.sourceKind, r.sourceRef]);
    expect([await sourceOf("b-restaged"), await labelOf("b-restaged")]).toEqual(["coros_import", [["coros_import", WIRE(1)]]]);
    for (const id of ["b-local-stamp", "b-echo"]) expect([await sourceOf(id), await labelOf(id)], id).toEqual(["coach", [["coach", null]]]);
  });

  it("coach-shaped stages are the coach's only on a row the coach authored, while its summary is still the coach's", async () => {
    silence();
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    await db.insert(coachPlans).values({
      id: "coach-plan", userId, discipline: "run", name: "Plan", status: "active", startDate: "2026-10-01", endDate: "2026-12-01",
      stampPrefix: "RG", createdAt: BUILT_AT, updatedAt: BUILT_AT,
    });
    // insertRow's one unlabelled 30-minute work stage reads as a coach block. A coach plan's run the import restaged
    // since: the wire's fingerprint, the import's own summary line.
    await insertRow(db, { id: "r-restaged", userId, planId: "coach-plan", title: "Easy 30" });
    await db.update(plannedWorkouts).set({ sourceContentFingerprint: WIRE(3), stageSummary: "30:00 Run" }).where(eq(plannedWorkouts.id, "r-restaged"));
    // A COROS row with a move intent (not a content one) and the summary the coach would have written: not authored.
    await insertRow(db, { id: "r-moved", userId, planId: "plan-1", title: "Easy 30" });
    const asCoach = coachSessionSchema.parse({ category: "easy", title: "Easy 30", durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30 }] } });
    await db.update(plannedWorkouts).set({ stageSummary: sessionSummaryLine(asCoach) }).where(eq(plannedWorkouts.id, "r-moved"));
    client(db)
      .prepare(`insert into sync_intents (id, user_id, target_kind, target_id, kind, payload, source, created_at) values ('i-1', ?, 'workout', 'r-moved', 'move', '{}', 'user_move', ?)`)
      .run(userId, BUILT_AT);
    // A COROS row with no stages and no body, not authored: the import's stand-in, not a coach session.
    await insertRow(db, { id: "r-bare", userId, planId: "plan-1", title: "Easy" });
    await db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, "r-bare"));

    const report = await backfillWorkoutDocs(db, userId, { kind: "planned", dryRun: false, now: NOW });
    // The restaged coach-plan run was the coach's (authored, read from its stages); the other two never were.
    expect([report.failed, report.convertedBy]).toEqual([[], { coachSession: 0, stages: 2, authoredAsStages: 1, build: 0, studio: 0 }]);
    for (const id of ["r-restaged", "r-moved", "r-bare"]) {
      expect(parseStoredWorkoutDoc((await rowOf(db, id)).workoutDoc)!.source.kind, id).toBe("coros_import");
    }
  });

  it("targets ride item for item, on the same seconds or metres — anything else lends nothing", () => {
    const run = (target: Record<string, unknown>) => ({ kind: "run" as const, target, effort: "easy" as const });
    const doc = (items: unknown[]): WorkoutDoc =>
      ({ version: 1, title: "Run", intent: { summary: "Run", goals: [], focus: [], effort: "maintain" }, parts: [{ purpose: "run", format: "steady", items }], source: { kind: "coach" } }) as WorkoutDoc;
    const stage = (ord: number, o: Partial<StageRowLike>): StageRowLike => ({
      id: `s:${ord}`, parentStageId: null, ord, kind: "work", repeatCount: null, durationType: "time", durationSeconds: null, distanceMeters: null,
      targetType: "none", targetLow: null, targetHigh: null, paceZone: null, hrZone: null, label: null, ...o,
    });
    const coach = doc([run({ durationSec: 600 }), run({ distanceM: 1000 }), run({ durationSec: 300 })]);
    const rows = [
      stage(0, { durationSeconds: 600, targetType: "pace", targetLow: 300, targetHigh: 330 }),
      stage(1, { durationType: "distance", distanceMeters: 1000, targetType: "heart_rate", targetLow: 120, targetHigh: 140 }),
      stage(2, { durationSeconds: 300, paceZone: 3 }),
    ];
    expect(withStageTargets(coach, rows)!.parts[0]!.items.map((i) => (i.kind === "run" ? i.target : null))).toEqual([
      { durationSec: 600, pace: { fastSecPerKm: 300, slowSecPerKm: 330 } },
      { distanceM: 1000, hr: { low: 120, high: 140 } },
      { durationSec: 300, zone: { kind: "pace", index: 3 } },
    ]);
    // A stage of another length lends nothing to its item; the others still lend theirs.
    const shifted = [rows[0]!, stage(1, { durationType: "distance", distanceMeters: 1200, targetType: "heart_rate", targetLow: 120, targetHigh: 140 }), rows[2]!];
    expect(withStageTargets(coach, shifted)!.parts[0]!.items.map((i) => (i.kind === "run" ? Object.keys(i.target).sort() : null))).toEqual([
      ["durationSec", "pace"], ["distanceM"], ["durationSec", "zone"],
    ]);
    // A stage list of another length lends nothing at all.
    expect(withStageTargets(coach, rows.slice(0, 2))).toEqual(coach);
    // No stages, no document: as it was.
    expect(withStageTargets(coach, [])).toBe(coach);
    expect(withStageTargets(null, rows)).toBeNull();
  });

  it("with the athlete's threshold, the coach's own write and the backfill's are the same document; the same content again is no new revision", async () => {
    silence();
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId: athlete, prefs: theirPrefs } = await makeTestUser(db, { weightUnit: "lb" });
    const day = todayInZone(theirPrefs.timezone);
    client(db)
      .prepare(`insert into daily_health (id, user_id, date, threshold_pace_sec_per_km, provider, content_fingerprint, updated_at) values (?, ?, ?, 300, 'coros', 'fp', ?)`)
      .run(`${athlete}:${day}`, athlete, day, BUILT_AT);
    const [id] = (await applyOps(db, athlete, theirPrefs, "p-add", [coachOpSchema.parse({ kind: "add", date: addDays(day, 3), session: COACH_RUN })])).created as [string];

    // The coach's own write: the document carries the very bands its stage rows were written with.
    const live = (await rowOf(db, id)).workoutDoc!;
    const stages = await db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, id));
    stages.sort((a, b) => a.ord - b.ord);
    expect(stages.every((s) => s.targetType === "pace")).toBe(true);
    const runs = parseStoredWorkoutDoc(live)!.parts.flatMap((p) => p.items).flatMap((i) => (i.kind === "run" ? [i.target.pace] : []));
    expect(runs).toEqual(stages.map((s) => ({ fastSecPerKm: s.targetLow, slowSecPerKm: s.targetHigh })));

    // The same session again (an ease to identical content): no new revision.
    await applyOps(db, athlete, theirPrefs, "p-same", [coachOpSchema.parse({ kind: "ease", workoutId: id, session: COACH_RUN })]);
    expect((await rowOf(db, id)).workoutDocRev).toBe(1);
    expect((await revisionsOf(db, id)).map((r) => r.rev)).toEqual([1]);
    expect((await rowOf(db, id)).workoutDoc).toBe(live);

    // The backfill, for the same row: the same document, byte for byte.
    client(db).prepare(`update planned_workouts set workout_doc = null, workout_doc_rev = null`).run();
    client(db).prepare(`delete from workout_doc_revisions`).run();
    const report = await backfillWorkoutDocs(db, athlete, { kind: "planned", dryRun: false, now: NOW });
    expect(report.convertedBy.coachSession).toBe(1);
    expect((await rowOf(db, id)).workoutDoc).toBe(live);
    expect(parseStoredWorkoutDoc((await rowOf(db, id)).workoutDoc)).toEqual(parseStoredWorkoutDoc(live));
  });

  it("a build whose own write fails is that build's failure, by its error's name: the others land", async () => {
    silence();
    let failedOnce = false;
    const db = cloneTestDb(world.base, {
      onStatement: (q) => {
        if (failedOnce || !/^update "session_builds"/.test(q)) return;
        failedOnce = true;
        throw new RangeError("the write failed");
      },
    });
    const report = await backfillWorkoutDocs(db, world.userId, { kind: "builds", dryRun: false, now: NOW });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.code).toBe("threw/RangeError");
    expect([report.converted, report.convertedBy.build]).toEqual([world.ids.builds.length - 1, world.ids.builds.length - 1]);
    expect(await buildDocOf(db, report.failed[0]!.id)).toBeNull();
  });

  describe("through the real writers: imported rows the coach eased, a coach run's targets", () => {
    let base: Db;
    let userId: string;
    let prefs: UserPreferences;
    let written: Map<string, string>;
    const ids = { easedRun: "", easedLift: "", coachRun: "" };
    const PLAN: TrainingPlanInfo = { sourcePlanId: "plan-e", name: "Test plan" };
    let today: string;
    const src = (n: number, o: Partial<SourcePlannedWorkout>): SourcePlannedWorkout => ({
      sourcePlanId: "plan-e", sourceWorkoutId: `plan-e:${n}`, sourceIdInPlan: String(n), sourceProgramId: `prog-${n}`, title: "Workout",
      sport: "run", date: addDays(today, n), stages: EASY, contentFingerprint: WIRE(n), isRestDay: false, ...o,
    });
    const snapshot = (db: Db, workouts: SourcePlannedWorkout[]) =>
      importPlanSnapshot(db, { userId, plan: PLAN, workouts, rangeStart: today, rangeEnd: addDays(today, 13), source: "fixture" }, prefs);
    const strip = (db: Db) => {
      client(db).prepare(`update planned_workouts set workout_doc = null, workout_doc_rev = null`).run();
      client(db).prepare(`delete from workout_doc_revisions`).run();
    };

    beforeAll(async () => {
      base = makeTestDb({ boundVariableCap: 100 });
      ({ userId, prefs } = await makeTestUser(base, { weightUnit: "lb" }));
      today = todayInZone(prefs.timezone);
      await snapshot(base, [src(1, { title: "Easy 30" }), src(2, { title: "Legs", sport: "strength", stages: LIFT_STAGES })]);
      const idOf = async (n: number) => (await base.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(eq(plannedWorkouts.sourceWorkoutId, `plan-e:${n}`)))[0]!.id;
      ids.easedRun = await idOf(1);
      ids.easedLift = await idOf(2);
      const ease = (workoutId: string, session: unknown) => coachOpSchema.parse({ kind: "ease", workoutId, session });
      await applyOps(base, userId, prefs, "p-ease", [ease(ids.easedRun, COACH_RUN), ease(ids.easedLift, COACH_LIFT)]);
      [ids.coachRun] = (await applyOps(base, userId, prefs, "p-add", [coachOpSchema.parse({ kind: "add", date: addDays(today, 4), session: COACH_RUN })])).created as [string];
      written = new Map(
        (client(base).prepare(`select id, workout_doc as doc from planned_workouts where workout_doc is not null`).all() as Array<{ id: string; doc: string }>).map((r) => [r.id, r.doc]),
      );
      strip(base);
    });

    it("an imported row the coach eased gets the coach's document — a lift from its body, a run from its blocks", async () => {
      silence();
      const db = cloneTestDb(base, { boundVariableCap: 100 });
      const report = await backfillWorkoutDocs(db, userId, { kind: "planned", dryRun: false, now: NOW });
      expect([report.failed, report.convertedBy]).toEqual([[], { coachSession: 3, stages: 0, authoredAsStages: 0, build: 0, studio: 0 }]);
      for (const id of [ids.easedRun, ids.easedLift, ids.coachRun]) {
        const row = await rowOf(db, id);
        expect(parseStoredWorkoutDoc(row.workoutDoc), row.title).toEqual(parseStoredWorkoutDoc(written.get(id)));
        expect((await revisionsOf(db, id)).map((r) => [r.sourceKind, r.sourceRef]), row.title).toEqual([["coach", null]]);
      }
    });

    it("an eased lift the import restaged since (its intent resolved, the wire changed): the import's stages", async () => {
      silence();
      const db = cloneTestDb(base, { boundVariableCap: 100 });
      client(db).prepare(`update sync_intents set resolved_at = ? where target_id = ?`).run(BUILT_AT, ids.easedLift);
      const changed = LIFT_STAGES.map((s) => (s.reps === 8 ? { ...s, reps: 10 } : s));
      await snapshot(db, [src(1, { title: "Easy 30" }), src(2, { title: "Legs", sport: "strength", stages: changed, contentFingerprint: WIRE(22) })]);
      const restaged = await rowOf(db, ids.easedLift);
      // Rule 7 rewrote the stages and the fingerprint and left the coach's body behind.
      expect([restaged.sourceContentFingerprint, restaged.structuredJson !== null]).toEqual([WIRE(22), true]);
      strip(db);
      await backfillWorkoutDocs(db, userId, { kind: "planned", dryRun: false, now: NOW });
      const doc = parseStoredWorkoutDoc((await rowOf(db, ids.easedLift)).workoutDoc)!;
      expect(doc.source.kind).toBe("coros_import");
      expect(doc.parts.flatMap((p) => p.items).some((i) => i.kind === "exercise" && i.dose.reps === 10)).toBe(true);
      expect((await revisionsOf(db, ids.easedLift)).map((r) => [r.sourceKind, r.sourceRef])).toEqual([["coros_import", WIRE(22)]]);
    });

    it("a coach run carries each stage's pace band, heart-rate band and zone into the coach's document", async () => {
      silence();
      const db = cloneTestDb(base, { boundVariableCap: 100 });
      const stage = (ord: number, set: Record<string, unknown>) =>
        db.update(plannedWorkoutStages).set(set).where(and(eq(plannedWorkoutStages.workoutId, ids.coachRun), eq(plannedWorkoutStages.ord, ord)));
      await stage(0, { targetType: "pace", targetLow: 330, targetHigh: 360 });
      await stage(1, { targetType: "heart_rate", targetLow: 140, targetHigh: 155 });
      await stage(2, { paceZone: 2 });
      await backfillWorkoutDocs(db, userId, { kind: "planned", dryRun: false, now: NOW });
      const doc = parseStoredWorkoutDoc((await rowOf(db, ids.coachRun)).workoutDoc)!;
      expect(doc.source.kind).toBe("coach");
      const runs = doc.parts.flatMap((p) => p.items).flatMap((i) => (i.kind === "run" ? [{ effort: i.effort, target: i.target }] : []));
      expect(runs).toEqual([
        { effort: "easy", target: { durationSec: 600, pace: { fastSecPerKm: 330, slowSecPerKm: 360 } } },
        { effort: "steady", target: { durationSec: 1500, hr: { low: 140, high: 155 } } },
        { effort: "easy", target: { durationSec: 300, zone: { kind: "pace", index: 2 } } },
      ]);
      expect((await revisionsOf(db, ids.coachRun)).map((r) => r.sourceKind)).toEqual(["coach"]);
    });

    it("one row that throws fails alone, by its error's name: the page answers", async () => {
      silence();
      const db = cloneTestDb(base, { boundVariableCap: 100 });
      // The athlete's preferences no longer parse: the lift (which needs the weight unit) throws; the runs do not.
      client(db).prepare(`update user_preferences set prefs = '{"weightUnit":"stone"}' where user_id = ?`).run(userId);
      const report = await backfillWorkoutDocs(db, userId, { kind: "planned", dryRun: false, now: NOW });
      expect(report.failed).toEqual([{ id: ids.easedLift, code: "threw/ZodError" }]);
      expect([report.converted, report.convertedBy.coachSession]).toEqual([2, 2]);
      expect((await rowOf(db, ids.easedLift)).workoutDoc).toBeNull();
    });
  });
});

// ── Revision ids ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("a revision id cannot collide", () => {
  it("a counter lost beside a history: the next revision is past the history's highest", async () => {
    silence();
    const db = cloneTestDb(world.base, { boundVariableCap: 100 });
    const id = world.ids.imported.lift;
    // Revision 1 and 2 in the history, the counter gone (written outside the app).
    const doc = world.written.get(id)!;
    for (const rev of [1, 2]) {
      client(db)
        .prepare(`insert into workout_doc_revisions (id, user_id, workout_id, rev, doc, source_kind, source_ref, created_at) values (?, ?, ?, ?, ?, 'coros_import', 'fp-3', ?)`)
        .run(`${id}:${rev}`, world.userId, id, rev, doc, BUILT_AT);
    }
    await runAll(db, world.userId, "planned", { dryRun: false });
    const row = await rowOf(db, id);
    expect(row.workoutDocRev).toBe(3);
    const revs = await revisionsOf(db, id);
    expect(revs.map((r) => [r.id, r.createdAt])).toEqual([[`${id}:1`, BUILT_AT], [`${id}:2`, BUILT_AT], [`${id}:3`, NOW]]);
    expect(revs[2]!.doc).toBe(row.workoutDoc);
  });
});

// ── The budget ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the budget: every call ≤ 45 statements", () => {
  it(`planned: a full page of ${BACKFILL_MAX_LIMIT} documents, coach sessions among them, is 26`, async () => {
    silence();
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db, { weightUnit: "kg" });
    await db.insert(coachPlans).values({
      id: "coach-plan", userId, discipline: "lift", name: "Plan", status: "active", startDate: "2026-10-01", endDate: "2026-12-01",
      stampPrefix: "RG", createdAt: BUILT_AT, updatedAt: BUILT_AT,
    });
    // Two coach sessions with a body (the weight unit is read once a page), then COROS runs.
    await insertRow(db, { id: "w-00", userId, planId: "coach-plan", title: "Legs", category: "strength", sport: "strength", structuredJson: { exercises: COACH_LIFT.lift.exercises } });
    await insertRow(db, { id: "w-01", userId, planId: "coach-plan", title: "Hips", category: "yoga", sport: "yoga", structuredJson: { exercises: COACH_MOBILITY.mobility.exercises } });
    for (let i = 2; i <= 25; i++) await insertRow(db, { id: `w-${String(i).padStart(2, "0")}`, userId, planId: "plan-1", title: `Run ${i}` });

    const counts: number[] = [];
    let n = 0;
    const counted = cloneTestDb(db, { boundVariableCap: 100, onStatement: () => void n++ });
    let after: string | undefined;
    const reports: BackfillReport[] = [];
    for (;;) {
      n = 0;
      const r = await backfillWorkoutDocs(counted, userId, { kind: "planned", dryRun: false, limit: 1000, now: NOW, ...(after ? { after } : {}) });
      counts.push(n);
      reports.push(r);
      if (r.nextAfter === null) break;
      after = r.nextAfter;
    }
    expect(reports.map((r) => [r.scanned, r.converted])).toEqual([[20, 20], [6, 6]]);
    // The page, its stages, the content intents of its rows outside coach plans, the weight unit (once: coach sessions
    // are on it), a row per document, and one revision statement per label (coach, import); the second page has no
    // coach session, so no weight unit and one label.
    expect(counts).toEqual([1 + 1 + 1 + 1 + 20 + 2, 1 + 1 + 1 + 6 + 1]);
    expect(Math.max(...counts)).toBeLessThanOrEqual(45);
  });

  it(`builds: a full page of ${BACKFILL_MAX_LIMIT} is 21, reading the build and not the view`, async () => {
    silence();
    const db = cloneTestDb(world.base, { boundVariableCap: 100 });
    const [source] = client(db).prepare(`select payload, workout_id as workoutId, user_id as userId from session_builds limit 1`).all() as Array<{ payload: string; workoutId: string; userId: string }>;
    for (let i = 1; i <= 25; i++) {
      client(db)
        .prepare(`insert into session_builds (id, user_id, workout_id, version, engine_version, inputs_hash, payload, workout_doc, locked_at, created_at) values (?, ?, ?, ?, 'e', 'h', ?, null, null, ?)`)
        .run(`b-${String(i).padStart(2, "0")}`, source!.userId, source!.workoutId, 100 + i, source!.payload, BUILT_AT);
    }
    const statements: string[] = [];
    const counted = cloneTestDb(db, { boundVariableCap: 100, onStatement: (q) => statements.push(q) });
    const first = await backfillWorkoutDocs(counted, world.userId, { kind: "builds", dryRun: false, limit: 1000, now: NOW });
    expect([first.scanned, first.converted]).toEqual([20, 20]);
    expect(statements).toHaveLength(1 + 20);
    expect(statements[0]).toContain("json_extract");
  });

  it(`the limit: ${BACKFILL_DEFAULT_LIMIT} by default, at most ${BACKFILL_MAX_LIMIT}, at least 1`, async () => {
    silence();
    const db = cloneTestDb(world.base, { boundVariableCap: 100 });
    for (let i = 1; i <= 30; i++) await insertRow(db, { id: `z-${String(i).padStart(2, "0")}`, userId: world.userId, planId: "plan-1", title: `Run ${i}` });
    const page = (limit?: number) => backfillWorkoutDocs(db, world.userId, { kind: "planned", dryRun: true, now: NOW, ...(limit !== undefined ? { limit } : {}) });
    expect((await page()).scanned).toBe(BACKFILL_DEFAULT_LIMIT);
    expect((await page(1000)).scanned).toBe(BACKFILL_MAX_LIMIT);
    expect((await page(0)).scanned).toBe(1);
    expect((await page(Number.NaN)).scanned).toBe(BACKFILL_DEFAULT_LIMIT);
  });
});

// ── The admin route ───────────────────────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/workout-docs/backfill", () => {
  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "0",
      SESSION_SECRET: "test-session-secret", TOKEN_ENCRYPTION_KEY: "test-token-encryption-key", ALLOWED_GOOGLE_EMAIL: "runner@example.com",
      GOOGLE_CLIENT_ID: "test-client-id", GOOGLE_CLIENT_SECRET: "test-client-secret", ...overrides,
    };
  }
  const post = (db: Db, env: Env, query: string, token?: string) =>
    mountRoutes(db, "/api/admin", adminRoutes(() => new Response(null, { status: 404 }))).request(
      `/api/admin/workout-docs/backfill${query}`,
      { method: "POST", headers: token ? { Cookie: `${SESSION_COOKIE}=${token}` } : {} },
      env,
    );

  it("does not exist unless the parity switch is on (as every admin route), and needs a signed-in user", async () => {
    const db = cloneTestDb(world.base);
    const token = await createSession(db, world.userId, "test");
    expect((await post(db, makeEnv(), "?kind=planned&dryRun=1", token)).status).toBe(404);
    expect((await post(db, makeEnv({ PARITY_ENABLED: "1" }), "?kind=planned&dryRun=1")).status).toBe(401);
  });

  it("refuses a bad kind, dry-run flag, cursor or limit", async () => {
    const db = cloneTestDb(world.base);
    const token = await createSession(db, world.userId, "test");
    const env = makeEnv({ PARITY_ENABLED: "1" });
    for (const [query, error] of [
      ["", "bad_kind"],
      ["?kind=everything", "bad_kind"],
      ["?kind=planned&dryRun=yes", "bad_dry_run"],
      [`?kind=planned&after=${"x".repeat(201)}`, "bad_after"],
      ["?kind=planned&limit=many", "bad_limit"],
    ] as const) {
      const res = await post(db, env, query, token);
      expect(res.status, query).toBe(400);
      expect(await res.json(), query).toEqual({ error });
    }
  });

  it("a dry run unless dryRun=0 says otherwise; answers counts and ids only", async () => {
    silence();
    const statements: string[] = [];
    const db = cloneTestDb(world.base, { onStatement: (q) => statements.push(q) });
    const token = await createSession(db, world.userId, "test");
    const env = makeEnv({ PARITY_ENABLED: "1" });
    statements.length = 0;
    const dry = await post(db, env, "?kind=planned&limit=20", token);
    expect(dry.status).toBe(200);
    const body = (await dry.json()) as BackfillReport;
    expect(Object.keys(body).sort()).toEqual(["converted", "convertedBy", "dryRun", "failed", "kind", "nextAfter", "scanned", "skipped", "skippedBy"]);
    expect(body).toMatchObject({ dryRun: true, kind: "planned", scanned: 14, converted: 7, skipped: 5, nextAfter: null });
    expect(statements.filter(isWrite).filter((q) => !/"sessions"/.test(q))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/Steady|Legs|Hips|Threshold|Breaks/);

    const real = await post(db, env, "?kind=planned&dryRun=0&limit=20", token);
    expect(((await real.json()) as BackfillReport)).toMatchObject({ dryRun: false, converted: 7 });
    expect(parseStoredWorkoutDoc((await rowOf(db, world.ids.coach.run)).workoutDoc)).not.toBeNull();
    const builds = (await (await post(db, env, "?kind=builds&dryRun=0", token)).json()) as BackfillReport;
    expect(builds).toMatchObject({ kind: "builds", converted: world.ids.builds.length, nextAfter: null });
  });
});
