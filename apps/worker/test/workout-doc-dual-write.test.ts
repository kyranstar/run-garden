/**
 * EVERY SOURCE WRITES THE WORKOUT DOCUMENT BESIDE ITS EXISTING FORMAT (Stage 1 Task 11, Amendment A).
 *
 * For each writer — the session build (engine), the coach's add and ease, the COROS import (new row, an upstream
 * content change, a recycled slot) — the row's `workout_doc` parses, and what the document derives agrees with the
 * columns the writer already wrote; a planned workout's document carries its revision (a `workout_doc_revisions` row
 * in the same batch), never a new one on a completed, skipped or missed row; `session_builds.workout_doc` is a
 * snapshot. A converter that throws never fails the write: the row lands, its document NULL.
 *
 * The old Studio push and the standalone import write no planned workout and no build (the Studio's sessions reach
 * `planned_workouts` through the COROS import; the standalone import writes performed sessions only), so they have
 * no document to write — see the task report.
 *
 * Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  adaptiveConfigSchema,
  addDays,
  coachOpSchema,
  newId,
  parseStoredWorkoutDoc,
  todayInZone,
  type CoachOp,
  type PlannedStage,
  type UserPreferences,
  type WorkoutDoc,
} from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import type { SourcePlannedWorkout, TrainingPlanInfo } from "@rg/providers";
import { deriveDoc } from "@rg/workout";
import type { Db } from "../src/services/db.js";
import { applyOps } from "../src/services/coach-apply.js";
import { checkWorkoutDocParity } from "../src/services/workout-doc-parity.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { buildSession } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

/** Converters throw while `boom.on`: the failure every writer must survive. */
const boom = vi.hoisted(() => ({ on: false }));
vi.mock("@rg/workout", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rg/workout")>();
  const failing = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => {
    if (boom.on) throw new TypeError("injected");
    return f(...a);
  };
  return {
    ...real,
    docFromStages: failing(real.docFromStages),
    docFromCoachSession: failing(real.docFromCoachSession),
    docFromBuildWithKept: failing(real.docFromBuildWithKept),
    docFromStudioSession: failing(real.docFromStudioSession),
  };
});

vi.setConfig({ testTimeout: 30_000 });

const { plannedWorkouts, programs, sessionBuilds, workoutDocRevisions } = schema;
const GOBLET = EXERCISES.find((e) => e.name === "Goblet squat")!.id;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;

/** Every statement the application runs (the counting tests' view: the budget is statements). */
let statements: string[] = [];
const revisionStatements = () => statements.filter((q) => /^insert into "workout_doc_revisions"/.test(q));

/**
 * An invocation that dies: armed with `after`, the `after`-th write throws and so does every statement after it (a
 * Worker killed mid-request runs nothing more); inside an atomic batch the throw rolls the batch back, as D1 does.
 */
let dying: { after: number; writes: number; dead: boolean } | null = null;
/** While set, every stage insert throws this (a failure every row of a batch hits). */
let stageFailure: (() => Error) | null = null;
const hook = (q: string): void => {
  statements.push(q);
  if (stageFailure && /^insert into "planned_workout_stages"/.test(q)) throw stageFailure();
  if (!dying) return;
  if (!dying.dead && isWrite(q) && ++dying.writes >= dying.after) dying.dead = true;
  if (dying.dead) throw new Error("the invocation died");
};

beforeEach(async () => {
  statements = [];
  dying = null;
  stageFailure = null;
  db = makeTestDb({ boundVariableCap: 100, onStatement: hook });
  ({ userId, prefs } = await makeTestUser(db, { weightUnit: "lb" }));
  today = todayInZone(prefs.timezone);
});

afterEach(() => {
  boom.on = false;
  vi.restoreAllMocks();
});

const derived = (doc: WorkoutDoc) => deriveDoc(doc, EXERCISES);
/** A planned row, its document read as raw text (as every reader of the column must: Drizzle's JSON mode throws on bad JSON). */
const rowOf = async (id: string) =>
  (await db.select({ ...getTableColumns(plannedWorkouts), workoutDoc: sql<string | null>`${plannedWorkouts.workoutDoc}` }).from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const revisionsOf = async (id: string) =>
  (await db.select({ ...getTableColumns(workoutDocRevisions), doc: sql<string>`${workoutDocRevisions.doc}` }).from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id))).sort(
    (a, b) => a.rev - b.rev,
  );
const titleOf = (raw: string) => parseStoredWorkoutDoc(raw)!.title;
/**
 * The row's stored document, parsed as every reader parses it. The column holds the document's JSON once: its text
 * parses to an object, never to a string of JSON (double-encoding, which `parseStoredWorkoutDoc` would quietly undo).
 */
const docOf = (row: { workoutDoc: unknown }): WorkoutDoc => {
  expect(typeof row.workoutDoc).toBe("string");
  expect(typeof JSON.parse(row.workoutDoc as string)).toBe("object");
  const doc = parseStoredWorkoutDoc(row.workoutDoc);
  expect(doc, "the stored document parses").not.toBeNull();
  return doc!;
};
/** The row's minutes as the app reads them. */
const rowMinutes = (row: { sourceEstimatedDurationSeconds: number | null; fallbackEstimatedDurationSeconds: number | null }) =>
  Math.round((row.sourceEstimatedDurationSeconds ?? row.fallbackEstimatedDurationSeconds!) / 60);
const silence = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

// ── The session build (engine) ───────────────────────────────────────────────────────────────────────────────────

describe("session builds: the build insert carries the document (a snapshot, no revision)", () => {
  const NOW = "2026-10-07T19:00:00.000Z";
  let programId: string;

  beforeEach(async () => {
    // A fixed id: the engine seeds its choices from the inputs, so the builds below are the same on every run.
    programId = "program-workout-doc";
    await db.insert(programs).values({
      id: programId, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"],
      startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
      createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
  });

  async function seedSlot(date: string): Promise<string> {
    const id = slotId(programId, date);
    await db.insert(plannedWorkouts).values({
      id, userId, planId: programId, sourceWorkoutId: id, title: "Mobility", category: "yoga", sport: "yoga",
      originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "program", contentState: "outline", createdAt: NOW, updatedAt: NOW,
    });
    return id;
  }
  const ctx = (now = NOW) => ({ today: "2026-10-07", now, prefs });
  const buildsOf = async (id: string) =>
    (await db.select({ ...getTableColumns(sessionBuilds), workoutDoc: sql<string | null>`${sessionBuilds.workoutDoc}` }).from(sessionBuilds).where(eq(sessionBuilds.workoutId, id))).sort(
      (a, b) => a.version - b.version,
    );

  it("today's build: the document of exactly the stored build, agreeing with the row the build wrote", async () => {
    const id = await seedSlot("2026-10-07");
    let n = 0;
    for (const mode of ["recovery", "consistent", "build"] as const) {
      for (const minutes of [15, 30, 45, 60]) {
        n += 1;
        const at = `2026-10-07T19:${String(n).padStart(2, "0")}:00.000Z`;
        const res = await buildSession(db, userId, id, { overrides: { mode, minutes } }, ctx(at));
        const build = (await buildsOf(id)).find((b) => b.id === res.build!.buildId)!;
        const doc = docOf(build);
        const label = `${mode} ${minutes} min`;
        expect(doc.source.kind).toBe("engine");
        expect(doc.intent.effort).toBe(mode === "recovery" ? "recover" : mode === "consistent" ? "maintain" : "develop");
        // Its stated length is the build's planned time.
        expect(doc.setting?.targetMinutes, label).toBe(Math.round(res.build!.plannedSeconds / 60));
        const d = derived(doc);
        const row = await rowOf(id);
        // Discipline. The row says strength when the build holds a core lift, else yoga (programme spec §9.2); the
        // document says strength when its main part holds a lift (derive.ts, ruling 2026-10-10): they agree.
        expect(d.category, `${label}: ${row.category}`).toBe(row.category);
        // Minutes: the document's own estimate (derive.ts: work, rests, assumed rests and transitions — not the
        // player's lead-ins and chimes) stays within the parity diagnostic's tolerance, max(3 min, 20 %), of the
        // engine's planned time.
        const near = (m: number) => Math.abs(d.estimatedMinutes - m) <= Math.max(3, 0.2 * m);
        expect(near(Math.round(res.build!.plannedSeconds / 60)), `${label}: ${d.estimatedMinutes} vs planned ${res.build!.plannedSeconds}s`).toBe(true);
        expect(await revisionsOf(id)).toEqual([]);
        // The planned row's document is not the build's: a programme row's content is its build (a snapshot).
        expect(row.workoutDoc).toBeNull();
      }
    }
  });

  it("a preview (a day ahead) carries one too, rewritten when the preview is", async () => {
    const id = await seedSlot("2026-10-09");
    await buildSession(db, userId, id, { overrides: { minutes: 20 } }, ctx());
    const [first] = await buildsOf(id);
    expect(first!.version).toBe(0);
    const planned = (b: { payload: unknown }) => Math.round((b.payload as { build: { plannedSeconds: number } }).build.plannedSeconds / 60);
    expect(docOf(first!).setting?.targetMinutes).toBe(planned(first!));
    await buildSession(db, userId, id, { overrides: { minutes: 45 } }, ctx("2026-10-07T19:05:00.000Z"));
    const [again] = await buildsOf(id);
    expect(again!.id).toBe(first!.id);
    expect(planned(again!)).toBeGreaterThan(planned(first!));
    expect(docOf(again!).setting?.targetMinutes).toBe(planned(again!));
  });

  it("the cost: none — the document rides the build's own insert", async () => {
    const id = await seedSlot("2026-10-07");
    statements.length = 0;
    await buildSession(db, userId, id, {}, ctx());
    const inserts = statements.filter((q) => /^insert into "session_builds"/.test(q));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain('"workout_doc"');
    expect(revisionStatements()).toHaveLength(0);
  });

  it("a converter that throws: the build is stored and answered, its document NULL", async () => {
    const warn = silence();
    boom.on = true;
    const id = await seedSlot("2026-10-07");
    const res = await buildSession(db, userId, id, {}, ctx());
    expect(res.build).not.toBeNull();
    const [build] = await buildsOf(id);
    expect(build!.payload).toBeTruthy();
    expect(build!.workoutDoc).toBeNull();
    expect((await rowOf(id)).contentState).toBe("built");
    expect(warn).toHaveBeenCalledWith("workout doc conversion failed: engine/TypeError");
  });
});

// ── The coach (add, ease) ─────────────────────────────────────────────────────────────────────────────────────────

describe("the coach: an add and an ease write the document and its revision", () => {
  const RUN = {
    category: "easy",
    title: "Steady 40",
    durationMinutes: 40,
    run: { blocks: [{ kind: "duration", value: 10, intensity: "easy" }, { kind: "duration", value: 25, intensity: "steady" }, { kind: "duration", value: 5, intensity: "easy" }] },
  };
  const LIFT = {
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
  const MOBILITY = {
    category: "yoga",
    title: "Hips",
    durationMinutes: 20,
    mobility: { exercises: [{ name: "Something gentle", sets: 1, holdSeconds: 60, weight: { type: "bodyweight" }, restSeconds: 0 }] },
  };
  const add = (date: string, session: unknown): CoachOp => coachOpSchema.parse({ kind: "add", date, session });

  it("an add: the document at revision 1, its revision row the same document, agreeing with the row", async () => {
    const date = addDays(today, 2);
    const out = await applyOps(db, userId, prefs, "p-add", [add(date, RUN), add(addDays(date, 1), LIFT), add(addDays(date, 2), MOBILITY)]);
    expect(out.created).toHaveLength(3);
    for (const id of out.created) {
      const row = await rowOf(id);
      const doc = docOf(row);
      expect(doc.source.kind).toBe("coach");
      expect(derived(doc).category).toBe(row.category);
      expect(doc.setting?.targetMinutes).toBe(rowMinutes(row));
      expect(row.workoutDocRev).toBe(1);
      const revs = await revisionsOf(id);
      expect(revs.map((r) => [r.id, r.rev, r.sourceKind, r.sourceRef, r.userId])).toEqual([[`${id}:1`, 1, "coach", "p-add", userId]]);
      expect(revs[0]!.doc).toEqual(row.workoutDoc);
    }
    // A run's minutes are its blocks: the document's derived minutes are the row's.
    const run = await rowOf(out.created[0]!);
    expect(derived(docOf(run)).estimatedMinutes).toBe(rowMinutes(run));
    // The lift states 30 minutes and derives far fewer: the parity diagnostic compares the stated length, so none of the
    // three rows is a minutes mismatch.
    const liftRow = await rowOf(out.created[1]!);
    expect(docOf(liftRow).setting?.targetMinutes).toBe(30);
    expect(derived(docOf(liftRow)).estimatedMinutes).toBeLessThan(15);
    expect((await checkWorkoutDocParity(db, userId)).mismatched.filter((m) => m.field === "minutes")).toEqual([]);
    // A stored load in the athlete's unit; a name the library lacks is free text.
    const lift = docOf(await rowOf(out.created[1]!));
    expect(lift.parts[0]!.items.map((i) => i.kind)).toEqual(["exercise", "free_exercise"]);
    expect(lift.parts[0]!.items[0]).toMatchObject({ libraryId: GOBLET, dose: { load: { typed: "25 lb", kg: 11.3 } } });
  });

  it("re-applying the same proposal writes no second revision", async () => {
    const ops = [add(addDays(today, 2), RUN)];
    const [id] = (await applyOps(db, userId, prefs, "p-add", ops)).created;
    await applyOps(db, userId, prefs, "p-add", ops);
    expect((await rowOf(id!)).workoutDocRev).toBe(1);
    expect((await revisionsOf(id!)).map((r) => r.rev)).toEqual([1]);
  });

  it("an ease: the eased session's document at the next revision; the first kept in the history", async () => {
    const [id] = (await applyOps(db, userId, prefs, "p-add", [add(addDays(today, 2), RUN)])).created;
    await applyOps(db, userId, prefs, "p-ease", [coachOpSchema.parse({ kind: "ease", workoutId: id, session: LIFT })]);
    const row = await rowOf(id!);
    expect(row.workoutDocRev).toBe(2);
    expect(derived(docOf(row)).category).toBe("strength");
    expect(row.category).toBe("strength");
    const revs = await revisionsOf(id!);
    expect(revs.map((r) => [r.rev, r.sourceRef, titleOf(r.doc)])).toEqual([[1, "p-add", "Steady 40"], [2, "p-ease", "Legs"]]);
  });

  it("an ease into a rest day: no document (the counter kept, no revision)", async () => {
    const [id] = (await applyOps(db, userId, prefs, "p-add", [add(addDays(today, 2), RUN)])).created;
    await applyOps(db, userId, prefs, "p-rest", [coachOpSchema.parse({ kind: "ease", workoutId: id, session: { category: "rest", title: "Rest", durationMinutes: 0 } })]);
    const row = await rowOf(id!);
    expect([row.category, row.workoutDoc, row.workoutDocRev]).toEqual(["rest", null, 1]);
    expect((await revisionsOf(id!)).map((r) => r.rev)).toEqual([1]);
  });

  it("the cost: one statement more per op that writes documents (the revisions of all its sessions), none without one", async () => {
    statements.length = 0;
    const out = await applyOps(db, userId, prefs, "p-cost", [add(addDays(today, 2), RUN), add(addDays(today, 3), { category: "rest", title: "Rest", durationMinutes: 0 })]);
    expect(out.created).toHaveLength(2);
    expect(revisionStatements()).toHaveLength(1);
    statements.length = 0;
    await applyOps(db, userId, prefs, "p-cost-ease", [coachOpSchema.parse({ kind: "ease", workoutId: out.created[0], session: LIFT })]);
    expect(revisionStatements()).toHaveLength(1);
    // The document rides the write's own statement: one write of the row, as before.
    expect(statements.filter((q) => /^update "planned_workouts" set "title"/.test(q))).toHaveLength(1);
    // One op of five sessions (a recurring add): five rows, their five revisions in one statement.
    statements.length = 0;
    const five = await applyOps(db, userId, prefs, "p-cost-five", [
      coachOpSchema.parse({ kind: "add", date: addDays(today, 5), dates: [6, 7, 8, 9].map((d) => addDays(today, d)), session: RUN }),
    ]);
    expect(five.created).toHaveLength(5);
    expect(statements.filter((q) => /^insert into "planned_workouts"/.test(q))).toHaveLength(5);
    expect(revisionStatements()).toHaveLength(1);
    for (const id of five.created) expect((await revisionsOf(id)).map((r) => [r.rev, r.sourceRef])).toEqual([[1, "p-cost-five"]]);
  });

  it("a converter that throws: the add and the ease still land, the document NULL, no revision", async () => {
    const warn = silence();
    boom.on = true;
    const [id] = (await applyOps(db, userId, prefs, "p-add", [add(addDays(today, 2), RUN)])).created;
    let row = await rowOf(id!);
    expect([row.title, row.stageSummary, row.workoutDoc, row.workoutDocRev]).toEqual(["Steady 40", "10 min easy · 25 min steady · 5 min easy", null, null]);
    boom.on = false;
    await applyOps(db, userId, prefs, "p-ease-1", [coachOpSchema.parse({ kind: "ease", workoutId: id, session: MOBILITY })]);
    expect((await rowOf(id!)).workoutDocRev).toBe(1);
    boom.on = true;
    await applyOps(db, userId, prefs, "p-ease-2", [coachOpSchema.parse({ kind: "ease", workoutId: id, session: LIFT })]);
    row = await rowOf(id!);
    expect([row.title, row.category, row.workoutDoc, row.workoutDocRev]).toEqual(["Legs", "strength", null, 1]);
    expect((await revisionsOf(id!)).map((r) => r.rev)).toEqual([1]);
    expect(warn).toHaveBeenCalledWith("workout doc conversion failed: coach/TypeError");
  });
});

// ── The COROS import ──────────────────────────────────────────────────────────────────────────────────────────────

describe("the COROS import: where stages are written, the document is too", () => {
  const PLAN: TrainingPlanInfo = { sourcePlanId: "plan-1", name: "Test plan" };
  const st = (o: Partial<PlannedStage> & Pick<PlannedStage, "id" | "order" | "kind">): PlannedStage => ({ durationType: "none", ...o });
  const intervals: PlannedStage[] = [
    st({ id: "1", order: 0, kind: "warmup", durationType: "time", durationSeconds: 600 }),
    st({ id: "2", order: 1, kind: "repeat", repeatCount: 5 }),
    st({ id: "3", parentStageId: "2", order: 0, kind: "work", durationType: "time", durationSeconds: 180, targetType: "pace", targetLow: 250, targetHigh: 260 }),
    st({ id: "4", parentStageId: "2", order: 1, kind: "recovery", durationType: "time", durationSeconds: 120 }),
    st({ id: "5", order: 2, kind: "cooldown", durationType: "time", durationSeconds: 600 }),
  ];
  const easy: PlannedStage[] = [st({ id: "1", order: 0, kind: "work", durationType: "time", durationSeconds: 1800 })];
  const lift: PlannedStage[] = [
    st({ id: "1", order: 0, kind: "repeat", repeatCount: 3 }),
    st({ id: "2", parentStageId: "1", order: 0, kind: "work", label: "Goblet Squat", reps: 8, loadKg: 16, restSeconds: 90 }),
    st({ id: "3", order: 1, kind: "repeat", repeatCount: 3 }),
    st({ id: "4", parentStageId: "3", order: 0, kind: "work", label: "Jumping Lunges", reps: 10, restSeconds: 60 }),
  ];
  const src = (n: number, o: Partial<SourcePlannedWorkout>): SourcePlannedWorkout => ({
    sourcePlanId: "plan-1",
    sourceWorkoutId: `plan-1:${n}`,
    sourceIdInPlan: String(n),
    sourceProgramId: `prog-${n}`,
    title: "Workout",
    sport: "run",
    date: addDays(today, n),
    stages: easy,
    contentFingerprint: `fp-${n}`,
    isRestDay: false,
    ...o,
  });
  const snapshot = (workouts: SourcePlannedWorkout[]) =>
    importPlanSnapshot(db, { userId, plan: PLAN, workouts, rangeStart: today, rangeEnd: addDays(today, 13), source: "fixture" }, prefs);
  const bySource = async (n: number) =>
    (await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(eq(plannedWorkouts.sourceWorkoutId, `plan-1:${n}`)).then((r) => rowOf(r[0]!.id)));
  const base = (): SourcePlannedWorkout[] => [
    src(1, { title: "Threshold 5x3", stages: intervals }),
    src(2, { title: "Easy 30", stages: easy }),
    src(3, { title: "Legs", sport: "strength", stages: lift }),
    src(4, { title: "Rest", stages: [], isRestDay: true }),
  ];
  /** The base snapshot with its second workout replaced. */
  const changed = (second: SourcePlannedWorkout): SourcePlannedWorkout[] => base().map((w, i) => (i === 1 ? second : w));

  it("a new workout: the document at revision 1 with its revision, agreeing with the row's category and minutes", async () => {
    const stats = await snapshot(base());
    expect(stats.created).toBe(4);
    for (const n of [1, 2, 3]) {
      const row = await bySource(n);
      const doc = docOf(row);
      expect(doc.source.kind).toBe("coros_import");
      expect(derived(doc).category, row.title).toBe(row.category);
      if (row.sport === "run") expect(derived(doc).estimatedMinutes, row.title).toBe(rowMinutes(row));
      // Its stated length is the planned row's own (COROS's estimate, else the app's).
      expect(doc.setting?.targetMinutes, row.title).toBe(rowMinutes(row));
      expect(row.workoutDocRev).toBe(1);
      const revs = await revisionsOf(row.id);
      expect(revs.map((r) => [r.rev, r.sourceKind, r.sourceRef])).toEqual([[1, "coros_import", `fp-${n}`]]);
      expect(revs[0]!.doc).toEqual(row.workoutDoc);
    }
    // COROS's name for a library move is the library move; a name two COROS codes share stays free text.
    const legs = docOf(await bySource(3));
    expect(legs.parts.flatMap((p) => p.items).map((i) => (i.kind === "exercise" ? i.libraryId : i.kind))).toEqual([GOBLET, "free_exercise"]);
    // A rest day carries no document.
    const rest = await bySource(4);
    expect([rest.category, rest.workoutDoc, rest.workoutDocRev]).toEqual(["rest", null, null]);
    expect(await revisionsOf(rest.id)).toEqual([]);
    expect((await checkWorkoutDocParity(db, userId)).mismatched).toEqual([]);
  });

  it("an unchanged re-read writes nothing new; an upstream content change is the next revision", async () => {
    await snapshot(base());
    await snapshot(base());
    const before = await bySource(2);
    expect(before.workoutDocRev).toBe(1);
    const stats = await snapshot(changed(src(2, { title: "Easy 45", contentFingerprint: "fp-2b", stages: [st({ id: "1", order: 0, kind: "work", durationType: "time", durationSeconds: 2700 })] })));
    expect(stats.updatedContent).toBe(1);
    const row = await bySource(2);
    expect(row.title).toBe("Easy 45");
    expect(row.workoutDocRev).toBe(2);
    expect(derived(docOf(row)).estimatedMinutes).toBe(45);
    expect(derived(docOf(row)).estimatedMinutes).toBe(rowMinutes(row));
    expect((await revisionsOf(row.id)).map((r) => [r.rev, r.sourceRef])).toEqual([[1, "fp-2"], [2, "fp-2b"]]);
  });

  it("a completed workout's content change upstream: the row follows, its document and revision do not", async () => {
    await snapshot(base());
    const done = await bySource(2);
    await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, done.id));
    await snapshot(changed(src(2, { title: "Easy 45", contentFingerprint: "fp-2b", stages: [st({ id: "1", order: 0, kind: "work", durationType: "time", durationSeconds: 2700 })] })));
    const row = await bySource(2);
    expect(row.title).toBe("Easy 45");
    expect(row.workoutDocRev).toBe(1);
    expect(docOf(row).title).toBe("Easy 30");
    expect((await revisionsOf(row.id)).map((r) => r.rev)).toEqual([1]);
  });

  it("a recycled slot (another kind of workout at the address) is rewritten with its document", async () => {
    await snapshot(base());
    await snapshot(changed(src(2, { title: "Upper", sport: "strength", contentFingerprint: "fp-2c", stages: lift })));
    const row = await bySource(2);
    expect(row.sport).toBe("strength");
    expect(row.workoutDocRev).toBe(2);
    expect(derived(docOf(row)).category).toBe(row.category);
    expect((await revisionsOf(row.id)).map((r) => r.rev)).toEqual([1, 2]);
  });

  it("a skipped slot recycled as another workout is that workout now: scheduled, its document and revision follow", async () => {
    await snapshot(base());
    const skipped = await bySource(2);
    await db.update(plannedWorkouts).set({ completionState: "skipped" }).where(eq(plannedWorkouts.id, skipped.id));
    await snapshot(changed(src(2, { title: "Upper", sport: "strength", contentFingerprint: "fp-2c", stages: lift })));
    const row = await bySource(2);
    expect([row.completionState, row.sport, row.workoutDocRev]).toEqual(["scheduled", "strength", 2]);
    expect(docOf(row).title).toBe("Upper");
    expect((await revisionsOf(row.id)).map((r) => [r.rev, titleOf(r.doc)])).toEqual([[1, "Easy 30"], [2, "Upper"]]);
  });

  it("the cost: one statement more per read that writes documents, none for an unchanged read", async () => {
    statements.length = 0;
    await snapshot(base());
    // Three workouts and a rest day: their three revisions in ONE statement (one per 80 rows); the rows' inserts
    // carry their documents themselves.
    expect(revisionStatements()).toHaveLength(1);
    expect(statements.filter((q) => /^insert into "planned_workouts"/.test(q))).toHaveLength(4);
    statements.length = 0;
    await snapshot(base());
    expect(revisionStatements()).toHaveLength(0);
    statements.length = 0;
    await snapshot(changed(src(2, { title: "Easy 45", contentFingerprint: "fp-2b", stages: easy })));
    expect(revisionStatements()).toHaveLength(1);
  });

  describe("the content batches: a row, its stages and its document land together", () => {
    /** `n` runs (twelve: two batches, ten and two), each `minutes` long, fingerprints tagged `tag`. */
    const twelve = (tag: string, minutes: number, n = 12) =>
      Array.from({ length: n }, (_, i) =>
        src(i + 1, { title: `Run ${i + 1}`, contentFingerprint: `${tag}-${i + 1}`, stages: [st({ id: "1", order: 0, kind: "work", durationType: "time", durationSeconds: minutes * 60 })] }),
      );
    /** Each row: its fingerprint's tag, its stages' seconds, its document's stated minutes and its revisions. */
    const state = async () => {
      const rows = await db
        .select({ id: plannedWorkouts.id, fp: plannedWorkouts.sourceContentFingerprint, doc: plannedWorkouts.workoutDoc, rev: plannedWorkouts.workoutDocRev })
        .from(plannedWorkouts)
        .where(eq(plannedWorkouts.userId, userId));
      return Promise.all(
        rows.map(async (r) => {
          const stages = await db.select({ sec: schema.plannedWorkoutStages.durationSeconds }).from(schema.plannedWorkoutStages).where(eq(schema.plannedWorkoutStages.workoutId, r.id));
          const revs = await revisionsOf(r.id);
          return { tag: r.fp.split("-")[0], stages: stages.map((x) => x.sec), minutes: parseStoredWorkoutDoc(r.doc)?.setting?.targetMinutes, rev: r.rev, revs: revs.map((x) => x.rev) };
        }),
      );
    };

    it("an invocation that dies at any write of the read leaves no row half-written, and the next read heals every row", { timeout: 120_000 }, async () => {
      silence();
      // How many writes a whole read of twelve changed runs makes.
      await snapshot(twelve("old", 30));
      dying = { after: Number.POSITIVE_INFINITY, writes: 0, dead: false };
      await snapshot(twelve("new", 45));
      const writes = dying.writes;
      dying = null;
      expect(writes).toBeGreaterThan(36);

      for (let k = 1; k <= writes; k++) {
        db = makeTestDb({ boundVariableCap: 100, onStatement: hook });
        ({ userId, prefs } = await makeTestUser(db, { weightUnit: "lb" }));
        await snapshot(twelve("old", 30));
        dying = { after: k, writes: 0, dead: false };
        await snapshot(twelve("new", 45)).catch(() => undefined);
        dying = null;
        for (const row of await state()) {
          // Every row is wholly the old workout or wholly the new: never a new fingerprint over old or missing stages.
          const whole =
            (row.tag === "old" && row.stages.join() === "1800" && row.minutes === 30 && row.rev === 1 && row.revs.join() === "1") ||
            (row.tag === "new" && row.stages.join() === "2700" && row.minutes === 45 && row.rev === 2 && row.revs.join() === "1,2");
          expect(whole, `killed at write ${k}: ${JSON.stringify(row)}`).toBe(true);
        }
        // The next read heals: every row the new workout, its stages and its document at revision 2.
        await snapshot(twelve("new", 45));
        const healed = await state();
        expect(healed).toHaveLength(12);
        for (const row of healed) expect(row, `healed after a death at write ${k}`).toEqual({ tag: "new", stages: [2700], minutes: 45, rev: 2, revs: [1, 2] });
      }
    });

    it("a row that cannot be written blocks only itself: the batch is retried row by row, the failure counted and logged by code", async () => {
      const warn = silence();
      await snapshot(twelve("old", 30));
      // The fifth run comes back with two stages under one id (the stage table's key refuses the second): its batch fails.
      const changed = twelve("new", 45).map((w, i) => (i === 4 ? { ...w, title: "Poison pill", stages: [w.stages[0]!, { ...w.stages[0]!, order: 1 }] } : w));
      statements.length = 0;
      const stats = await snapshot(changed);
      expect(stats.failedWrites).toBe(1);
      // Counted once each, and only once written: eleven content changes, not twelve.
      expect(stats.updatedContent).toBe(11);
      const rows = await state();
      expect(rows.filter((r) => r.tag === "new")).toHaveLength(11);
      // The failed row is still wholly its old self, and the next read will try it again.
      expect(rows.filter((r) => r.tag === "old")).toEqual([{ tag: "old", stages: [1800], minutes: 30, rev: 1, revs: [1] }]);
      const logged = warn.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith("import row write failed"));
      expect(logged).toEqual(["import row write failed: SqliteError:UNIQUE"]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("Poison");
      // Two batches of ten and two. The first failed at the bad row, before its revision statement ran, and was
      // retried row by row: nine rows landed, each with its own revision statement, and the bad row failed again
      // before its own. The second batch landed with one.
      expect(revisionStatements()).toHaveLength(9 + 1);
    });

    const checkOnEveryRow = () => Object.assign(new Error("CHECK constraint failed: stage_kind"), { name: "SqliteError", code: "SQLITE_CONSTRAINT_CHECK" });
    const rowFailuresLogged = (warn: ReturnType<typeof silence>) => warn.mock.calls.filter((c) => String(c[0]).startsWith("import row write failed"));

    it("an error that is no constraint fails the read even when every row hits it — a schema drift, a runtime ceiling — never retried, nothing written", async () => {
      const warn = silence();
      const failures: Array<[string, () => Error]> = [
        ["no constraint", () => new Error("D1_ERROR: table planned_workout_stages has no column named note: SQLITE_ERROR")],
        ["a runtime ceiling", () => new Error("Too many API requests by single worker invocation.")],
      ];
      for (const [label, failure] of failures) {
        db = makeTestDb({ boundVariableCap: 100, onStatement: hook });
        ({ userId, prefs } = await makeTestUser(db, { weightUnit: "lb" }));
        await snapshot(twelve("old", 30, 5));
        stageFailure = failure;
        await expect(snapshot(twelve("new", 45, 5)), label).rejects.toThrow();
        stageFailure = null;
        // Nothing of the read landed: every row wholly its old self.
        for (const row of await state()) expect(row, label).toEqual({ tag: "old", stages: [1800], minutes: 30, rev: 1, revs: [1] });
      }
      expect(rowFailuresLogged(warn)).toEqual([]);
    });

    it("a row's own constraint is isolated however many rows of the batch meet one: five bad rows of five, the read still resolves", async () => {
      const warn = silence();
      await snapshot(twelve("old", 30, 5));
      // Five runs: ONE batch, inside the retry cap. Decided on the error, not the outcome: every row refused is
      // still five rows' own constraints, never the read failing.
      stageFailure = checkOnEveryRow;
      const stats = await snapshot(twelve("new", 45, 5));
      stageFailure = null;
      expect([stats.failedWrites, stats.updatedContent]).toEqual([5, 0]);
      for (const row of await state()) expect(row).toEqual({ tag: "old", stages: [1800], minutes: 30, rev: 1, revs: [1] });
      expect(rowFailuresLogged(warn)).toHaveLength(5);
      // The next read writes them.
      expect((await snapshot(twelve("new", 45, 5))).updatedContent).toBe(5);
    });

    it("more than ten bad rows fail the read at the retry cap: a constraint on every row of twelve", async () => {
      const warn = silence();
      await snapshot(twelve("old", 30));
      stageFailure = checkOnEveryRow;
      await expect(snapshot(twelve("new", 45))).rejects.toThrow(/CHECK constraint failed/);
      stageFailure = null;
      for (const row of await state()) expect(row).toEqual({ tag: "old", stages: [1800], minutes: 30, rev: 1, revs: [1] });
      // The first batch's ten were retried one by one; the second batch would pass the cap, and failed the read.
      expect(rowFailuresLogged(warn)).toHaveLength(10);
    });

    it("past ten rows retried one by one, the read fails: a bad row in each of two batches", async () => {
      silence();
      await snapshot(twelve("old", 30));
      // Rows 5 (first batch) and 11 (second batch) come back with two stages under one id.
      const changed = twelve("new", 45).map((w, i) => (i === 4 || i === 10 ? { ...w, stages: [w.stages[0]!, { ...w.stages[0]!, order: 1 }] } : w));
      await expect(snapshot(changed)).rejects.toThrow(/UNIQUE constraint failed/);
      // The first batch's retry wrote its nine good rows (they stay written); the second batch was not retried.
      const rows = await state();
      expect(rows.filter((r) => r.tag === "new")).toHaveLength(9);
      for (const row of rows.filter((r) => r.tag === "old")) expect(row).toEqual({ tag: "old", stages: [1800], minutes: 30, rev: 1, revs: [1] });
    });

    it("a clean read: one revision statement per batch of ten rows, each batch holding its rows' stages", async () => {
      expect((await snapshot(twelve("old", 30))).created).toBe(12);
      statements.length = 0;
      const stats = await snapshot(twelve("new", 45));
      expect([stats.updatedContent, stats.failedWrites]).toEqual([12, 0]);
      expect(revisionStatements()).toHaveLength(2);
      for (const row of await state()) expect(row).toEqual({ tag: "new", stages: [2700], minutes: 45, rev: 2, revs: [1, 2] });
    });
  });

  it("a converter that throws: every workout still lands, its document NULL, no revision", async () => {
    const warn = silence();
    boom.on = true;
    expect((await snapshot(base())).created).toBe(4);
    for (const n of [1, 2, 3]) {
      const row = await bySource(n);
      expect([row.workoutDoc, row.workoutDocRev], row.title).toEqual([null, null]);
      expect(row.stageSummary).toBeTruthy();
    }
    expect(await db.select().from(workoutDocRevisions)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("workout doc conversion failed: coros_import/TypeError");
  });
});
