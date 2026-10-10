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
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { buildSession } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

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

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => statements.push(q) });
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
/** The row's stored document, parsed as every reader parses it. */
const docOf = (row: { workoutDoc: unknown }): WorkoutDoc => {
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
    const tally = { builds: 0, sameCategory: 0, strengthByLiftYogaBySeconds: 0, minutesNearPlanned: 0, minutesNearBooked: 0 };
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
        expect(doc.setting?.targetMinutes, label).toBe(res.build!.minutes);
        const d = derived(doc);
        const row = await rowOf(id);
        tally.builds += 1;
        // Discipline. The row says strength when the build holds a core lift, else yoga (programme spec §9.2); the
        // document derives the dominant axis by seconds (derive.ts). They agree, except that a build with one core
        // lift among more minutes of mobility derives yoga — strength is then still one of its disciplines.
        if (d.category === row.category) tally.sameCategory += 1;
        else {
          expect([row.category, d.category], label).toEqual(["strength", "yoga"]);
          expect(d.disciplines, label).toContain("strength");
          tally.strengthByLiftYogaBySeconds += 1;
        }
        // Minutes: the document counts work and rests, not the player's lead-ins and chimes (derive.ts), so it reads a
        // little under the engine's planned time — within the parity diagnostic's tolerance, max(3 min, 20 %). The
        // row's booked length rounds that planned time up, and can fall outside it (counted, not asserted: see the
        // task report).
        const near = (m: number) => Math.abs(d.estimatedMinutes - m) <= Math.max(3, 0.2 * m);
        expect(near(Math.round(res.build!.plannedSeconds / 60)), `${label}: ${d.estimatedMinutes} vs planned ${res.build!.plannedSeconds}s`).toBe(true);
        tally.minutesNearPlanned += 1;
        if (near(rowMinutes(row))) tally.minutesNearBooked += 1;
        expect(await revisionsOf(id)).toEqual([]);
        // The planned row's document is not the build's: a programme row's content is its build (a snapshot).
        expect(row.workoutDoc).toBeNull();
      }
    }
    console.log("build documents vs their rows:", JSON.stringify(tally));
    expect(tally.sameCategory).toBeGreaterThan(0);
  });

  it("a preview (a day ahead) carries one too, rewritten when the preview is", async () => {
    const id = await seedSlot("2026-10-09");
    await buildSession(db, userId, id, { overrides: { minutes: 20 } }, ctx());
    const [first] = await buildsOf(id);
    expect(first!.version).toBe(0);
    expect(docOf(first!).setting?.targetMinutes).toBe(20);
    await buildSession(db, userId, id, { overrides: { minutes: 45 } }, ctx("2026-10-07T19:05:00.000Z"));
    const [again] = await buildsOf(id);
    expect(again!.id).toBe(first!.id);
    expect(docOf(again!).setting?.targetMinutes).toBe(45);
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

  it("the cost: one statement more per session written with a document (the revision), none without one", async () => {
    statements.length = 0;
    const out = await applyOps(db, userId, prefs, "p-cost", [add(addDays(today, 2), RUN), add(addDays(today, 3), { category: "rest", title: "Rest", durationMinutes: 0 })]);
    expect(out.created).toHaveLength(2);
    expect(revisionStatements()).toHaveLength(1);
    statements.length = 0;
    await applyOps(db, userId, prefs, "p-cost-ease", [coachOpSchema.parse({ kind: "ease", workoutId: out.created[0], session: LIFT })]);
    expect(revisionStatements()).toHaveLength(1);
    // The document rides the write's own statement: one write of the row, as before.
    expect(statements.filter((q) => /^update "planned_workouts" set "title"/.test(q))).toHaveLength(1);
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

  it("the cost: one statement more per workout written with a document, none for a rest day or an unchanged read", async () => {
    statements.length = 0;
    await snapshot(base());
    // Three workouts and a rest day: three revisions; the rows' inserts carry their documents themselves.
    expect(revisionStatements()).toHaveLength(3);
    expect(statements.filter((q) => /^insert into "planned_workouts"/.test(q))).toHaveLength(4);
    statements.length = 0;
    await snapshot(base());
    expect(revisionStatements()).toHaveLength(0);
    statements.length = 0;
    await snapshot(changed(src(2, { title: "Easy 45", contentFingerprint: "fp-2b", stages: easy })));
    expect(revisionStatements()).toHaveLength(1);
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
