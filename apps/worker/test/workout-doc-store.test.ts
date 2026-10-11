/**
 * THE WORKOUT DOCUMENT AS EACH SOURCE STORES IT (Stage 1 Task 11, Amendment A): one helper per source converts and
 * answers the document to write, never throwing; one helper writes a planned workout's revision — never for a
 * completed, skipped or missed row. Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { coachSessionSchema, nowInstant, parseStoredWorkoutDoc, studioSessionSchema, type PlannedStage, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import type { Db } from "../src/services/db.js";
import { runAtomically } from "../src/services/db.js";
import {
  docForCoachSession,
  docForStages,
  docForStudioSession,
  FROZEN_STATES,
  libraryIdOfCorosName,
  newRowDocColumns,
  resolveLibraryName,
  revisionInsert,
  revisionInserts,
  updateDocColumns,
} from "../src/services/workout-doc-store.js";
import { corosKeyOfName } from "../src/services/coros-exercise-map.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

/** Converters throw (or answer a document the schema refuses) while `boom` says so: the failures a writer survives. */
const boom = vi.hoisted(() => ({ on: false, invalid: false }));
vi.mock("@rg/workout", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rg/workout")>();
  const failing = <A extends unknown[], R extends { doc: { title: string } } | null>(f: (...a: A) => R) => (...a: A): R => {
    if (boom.on) throw new TypeError("a message that could hold a title: Morning Tempo");
    const out = f(...a);
    return boom.invalid && out ? ({ ...out, doc: { ...out.doc, title: "" } } as R) : out;
  };
  return {
    ...real,
    docFromStages: failing(real.docFromStages),
    docFromCoachSession: failing(real.docFromCoachSession),
    docFromBuildWithKept: failing(real.docFromBuildWithKept),
    docFromStudioSession: failing(real.docFromStudioSession),
  };
});

const { plannedWorkouts, workoutDocRevisions } = schema;
const GOBLET = EXERCISES.find((e) => e.name === "Goblet squat")!.id;

const stage = (o: Partial<PlannedStage> & Pick<PlannedStage, "id" | "order" | "kind">): PlannedStage => ({ durationType: "none", ...o });

afterEach(() => {
  boom.on = false;
  boom.invalid = false;
  vi.restoreAllMocks();
});

describe("the frozen rule", () => {
  it("completed, skipped and missed are frozen (the SQL guards read this one list)", () => {
    expect([...FROZEN_STATES].sort()).toEqual(["completed", "missed", "skipped"]);
  });
});

describe("names → library moves", () => {
  it("a stage label is COROS's English name: through its unique T-code to the library", () => {
    expect(corosKeyOfName("Goblet Squat")).toBe("T1301");
    expect(libraryIdOfCorosName("Goblet Squat")).toBe(GOBLET);
    expect(libraryIdOfCorosName("goblet squats")).toBe(GOBLET);
    expect(libraryIdOfCorosName("A custom move")).toBeNull();
  });

  it("a name two COROS codes share resolves to nothing, even when the library maps one of them", () => {
    // "Jumping Lunges" is T1012 and T1136; "Forward Jumping Lunges" is T1139 alone.
    expect(corosKeyOfName("Jumping Lunges")).toBeNull();
    expect(corosKeyOfName("Plank Jacks")).toBeNull();
    expect(corosKeyOfName("Forward Jumping Lunges")).toBe("T1139");
    const base = EXERCISES.find((e) => e.id === GOBLET)!;
    const mapped = (id: string, key: string): ExerciseRecord => ({ ...base, id, name: id, legacyIds: [], providers: { coros: { key, confidence: "exact", method: "curated" } } });
    const library = [...EXERCISES.filter((e) => e.id !== GOBLET), mapped("jumpLungeA", "T1012"), mapped("fwdJumpLunge", "T1139")];
    expect(libraryIdOfCorosName("Jumping Lunges", library)).toBeNull();
    expect(libraryIdOfCorosName("Forward Jumping Lunges", library)).toBe("fwdJumpLunge");
  });

  it("a coach's name: the library's own name first, then COROS's", () => {
    expect(resolveLibraryName("Goblet squat")).toBe(GOBLET);
    expect(resolveLibraryName("Goblet Squats")).toBe(GOBLET);
    expect(resolveLibraryName("Lie on Your Back Glute Bridge")).toBe(libraryIdOfCorosName("Lie on Your Back Glute Bridge"));
    expect(resolveLibraryName("Jumping Lunges")).toBeNull();
    expect(resolveLibraryName("Something the coach made up")).toBeNull();
  });

  it("a name two library moves share is no library name, and never falls through to COROS's", () => {
    const goblet = EXERCISES.find((e) => e.id === GOBLET)!;
    // Two moves named "Goblet squat"; COROS's T1301 is mapped (exactly) by the first only.
    const library = [
      ...EXERCISES.filter((e) => e.id !== GOBLET),
      { ...goblet, id: "gobletA", legacyIds: [] },
      { ...goblet, id: "gobletB", legacyIds: [], providers: { coros: { key: "T1301", confidence: "close" as const, method: "curated" as const } } },
    ];
    expect(libraryIdOfCorosName("Goblet Squat", library)).toBe("gobletA");
    expect(resolveLibraryName("Goblet squat", library)).toBeNull();
  });
});

describe("one helper per source", () => {
  it("a coach rest day has no document; a stored load is typed in the athlete's unit", () => {
    expect(docForCoachSession(coachSessionSchema.parse({ category: "rest", title: "Rest", durationMinutes: 0 }), {})).toBeNull();
    const lift = coachSessionSchema.parse({
      category: "strength",
      title: "Legs",
      durationMinutes: 30,
      lift: { exercises: [{ name: "Goblet squat", sets: 3, reps: 8, weight: { type: "kg", value: 11.3 }, restSeconds: 90 }] },
    });
    const doc = docForCoachSession(lift, { weightUnit: "lb" })!;
    expect(doc.parts[0]!.items[0]).toMatchObject({ kind: "exercise", libraryId: GOBLET, dose: { load: { typed: "25 lb", kg: 11.3 } } });
  });

  it("COROS stages: a rest day has no document; a mapped label is a library move, a shared name free text", () => {
    expect(docForStages([], { title: "Rest", sport: "run", category: "rest" })).toBeNull();
    const doc = docForStages(
      [
        stage({ id: "1", order: 0, kind: "work", label: "Goblet Squat", reps: 8, loadKg: 16 }),
        stage({ id: "2", order: 1, kind: "work", label: "Jumping Lunges", reps: 10 }),
      ],
      { title: "Legs", sport: "strength", category: "strength", durationSeconds: 1800 },
    )!;
    expect(doc.parts[0]!.items.map((i) => i.kind)).toEqual(["exercise", "free_exercise"]);
    expect(doc.parts[0]!.items[0]).toMatchObject({ libraryId: GOBLET });
  });

  it("an old Studio session: the athlete's catalog id through its T-code to the library", () => {
    const session = studioSessionSchema.parse({
      title: "Lower",
      weekday: 1,
      exercises: [
        { originId: "c-1", name: "Goblet Squat", sets: 3, reps: 8, weight: { type: "kg", value: 16 }, restSeconds: 90 },
        { originId: "c-2", name: "Mine", sets: 2, reps: 5, weight: { type: "bodyweight" }, restSeconds: 60 },
      ],
    });
    const doc = docForStudioSession(session, { corosKeyOfOrigin: (id) => (id === "c-1" ? "T1301" : null) })!;
    expect(doc.parts[0]!.items.map((i) => (i.kind === "exercise" ? i.libraryId : i.kind))).toEqual([GOBLET, "free_exercise"]);
  });

  it("a converter that throws answers null and logs only its code — never the message, never a title", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    boom.on = true;
    const session = coachSessionSchema.parse({ category: "easy", title: "Morning Tempo", durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] } });
    expect(docForCoachSession(session, {})).toBeNull();
    expect(docForStages([], { title: "Morning Tempo", sport: "run", category: "easy" })).toBeNull();
    expect(warn.mock.calls.map((c) => c.join(" "))).toEqual([
      "workout doc conversion failed: coach/TypeError",
      "workout doc conversion failed: coros_import/TypeError",
    ]);
  });

  it("a document the schema refuses is not written: null, logged by its code and path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    boom.invalid = true;
    expect(docForStages([], { title: "Morning Tempo", sport: "run", category: "easy" })).toBeNull();
    expect(warn.mock.calls.map((c) => c.join(" "))).toEqual(["workout doc conversion failed: coros_import/invalid:too_small@title"]);
  });
});

// ── The revision helper ─────────────────────────────────────────────────────────────────────────────────────────

describe("revisions of a planned workout's document", () => {
  let db: Db;
  let userId: string;
  const NOW = "2026-10-10T12:00:00.000Z";
  const doc = (title: string): WorkoutDoc => docForStages([], { title, sport: "run", category: "easy", durationSeconds: 1800 })!;

  beforeEach(async () => {
    db = makeTestDb({ boundVariableCap: 100 });
    ({ userId } = await makeTestUser(db));
  });

  async function insert(id: string, d: WorkoutDoc | null, completionState = "scheduled") {
    await runAtomically(db, [
      db.insert(plannedWorkouts).values({
        id, userId, planId: "p", sourceWorkoutId: id, title: "Run", category: "easy", sport: "run",
        originalPlanDate: "2026-10-12", lastVerifiedCorosDate: "", effectiveDate: "2026-10-12", effectiveTime: "07:00",
        completionState, sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, createdAt: nowInstant(), updatedAt: nowInstant(),
        ...newRowDocColumns(d),
      }),
      revisionInsert(db, { userId, workoutId: id, sourceKind: "coros_import", sourceRef: "fp", now: NOW }),
    ]);
  }
  async function update(id: string, d: WorkoutDoc | null, sourceRef = "fp2") {
    await runAtomically(db, [
      db.update(plannedWorkouts).set({ title: "Changed", ...updateDocColumns(d) }).where(eq(plannedWorkouts.id, id)),
      revisionInsert(db, { userId, workoutId: id, sourceKind: "coach", sourceRef, now: NOW }),
    ]);
  }
  // Documents read as raw text, as every reader of the columns must (Drizzle's JSON mode throws on bad JSON).
  const rowOf = async (id: string) =>
    (await db.select({ ...getTableColumns(plannedWorkouts), workoutDoc: sql<string | null>`${plannedWorkouts.workoutDoc}` }).from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
  const revisionsOf = async (id: string) =>
    (
      await db
        .select({ ...getTableColumns(workoutDocRevisions), doc: sql<string>`${workoutDocRevisions.doc}` })
        .from(workoutDocRevisions)
        .where(and(eq(workoutDocRevisions.workoutId, id), eq(workoutDocRevisions.userId, userId)))
    ).sort((a, b) => a.rev - b.rev);

  it("a new row: its document at revision 1, and the revision row holds the same document", async () => {
    await insert("w1", doc("Easy"));
    const row = await rowOf("w1");
    expect(row.workoutDocRev).toBe(1);
    expect(parseStoredWorkoutDoc(row.workoutDoc)).toEqual(doc("Easy"));
    expect(await revisionsOf("w1")).toEqual([
      { id: "w1:1", userId, workoutId: "w1", rev: 1, doc: row.workoutDoc, sourceKind: "coros_import", sourceRef: "fp", createdAt: NOW },
    ]);
  });

  it("a changed document bumps the revision; the same document again does not (a re-apply is idempotent)", async () => {
    await insert("w1", doc("Easy"));
    await update("w1", doc("Easier"));
    await update("w1", doc("Easier"), "again");
    expect((await rowOf("w1")).workoutDocRev).toBe(2);
    const revs = await revisionsOf("w1");
    expect(revs.map((r) => [r.rev, r.sourceKind, r.sourceRef, parseStoredWorkoutDoc(r.doc)!.title])).toEqual([
      [1, "coros_import", "fp", "Easy"],
      [2, "coach", "fp2", "Easier"],
    ]);
  });

  it("a completed, skipped or missed row keeps its document and revision: no new revision", async () => {
    for (const state of FROZEN_STATES) {
      const id = `w-${state}`;
      await insert(id, doc("Easy"));
      await db.update(plannedWorkouts).set({ completionState: state }).where(eq(plannedWorkouts.id, id));
      await update(id, doc("Rewritten after the fact"));
      const row = await rowOf(id);
      expect(row.title).toBe("Changed");
      expect(row.workoutDocRev).toBe(1);
      expect(parseStoredWorkoutDoc(row.workoutDoc)!.title).toBe("Easy");
      expect((await revisionsOf(id)).map((r) => r.rev)).toEqual([1]);
    }
  });

  it("the revision helper never writes one for a frozen row, even one whose history lacks its revision", async () => {
    // A document at revision 1 with no revision row (written before revisions, say), then the workout is done.
    await db.insert(plannedWorkouts).values({
      id: "w1", userId, planId: "p", sourceWorkoutId: "w1", title: "Run", category: "easy", sport: "run",
      originalPlanDate: "2026-10-12", lastVerifiedCorosDate: "", effectiveDate: "2026-10-12", effectiveTime: "07:00",
      completionState: "completed", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800,
      createdAt: nowInstant(), updatedAt: nowInstant(), ...newRowDocColumns(doc("Easy")),
    });
    await update("w1", doc("Easy"));
    expect(await revisionsOf("w1")).toEqual([]);
  });

  it("a frozen row with no document yet stays without one (the backfill's to fill)", async () => {
    await insert("w1", null, "completed");
    await update("w1", doc("Late"));
    const row = await rowOf("w1");
    expect([row.workoutDoc, row.workoutDocRev]).toEqual([null, null]);
    expect(await revisionsOf("w1")).toEqual([]);
  });

  it("no document (a rest day, or a conversion that failed): the column is cleared, the counter kept, no revision", async () => {
    await insert("w1", doc("Easy"));
    await update("w1", null);
    const row = await rowOf("w1");
    expect([row.workoutDoc, row.workoutDocRev]).toEqual([null, 1]);
    // The next document is revision 2: the history's ids never collide.
    await update("w1", doc("Back"));
    expect((await rowOf("w1")).workoutDocRev).toBe(2);
    expect((await revisionsOf("w1")).map((r) => r.id)).toEqual(["w1:1", "w1:2"]);
    await insert("w2", null);
    expect([(await rowOf("w2")).workoutDocRev, (await revisionsOf("w2")).length]).toEqual([null, 0]);
  });

  it("another account's row is never revised by this account's helper", async () => {
    const other = await makeTestUser(db);
    await insert("w1", doc("Easy"));
    await runAtomically(db, [revisionInsert(db, { userId: other.userId, workoutId: "w1", sourceKind: "coach", sourceRef: null, now: NOW })]);
    expect((await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.userId, other.userId))).length).toBe(0);
  });

  it("many rows' revisions: one statement per 80 rows, the same rules, each row's own column as its source_ref", async () => {
    const ids = Array.from({ length: 83 }, (_, i) => `m${String(i).padStart(2, "0")}`);
    // Rows written without their revisions (the helper's test): 83 with documents, one of them done, one with none.
    for (const id of ids) {
      await db.insert(plannedWorkouts).values({
        id, userId, planId: "p", sourceWorkoutId: id, title: "Run", category: "easy", sport: "run",
        originalPlanDate: "2026-10-12", lastVerifiedCorosDate: "", effectiveDate: "2026-10-12", effectiveTime: "07:00",
        completionState: id === "m01" ? "completed" : "scheduled", sourceContentFingerprint: `fp-${id}`, calendarBlockDurationSeconds: 1800,
        createdAt: nowInstant(), updatedAt: nowInstant(), ...newRowDocColumns(id === "m02" ? null : doc("Easy")),
      });
    }
    const statements = revisionInserts(db, { userId, workoutIds: [...ids, "m00"], sourceKind: "coros_import", sourceRef: sql`${plannedWorkouts.sourceContentFingerprint}`, now: NOW });
    expect(statements).toHaveLength(2);
    await runAtomically(db, statements);
    const revs = await db.select({ workoutId: workoutDocRevisions.workoutId, sourceRef: workoutDocRevisions.sourceRef }).from(workoutDocRevisions).where(eq(workoutDocRevisions.userId, userId));
    expect(revs).toHaveLength(81);
    expect(revs.map((r) => r.workoutId)).not.toContain("m01");
    expect(revs.map((r) => r.workoutId)).not.toContain("m02");
    expect(revs.find((r) => r.workoutId === "m10")!.sourceRef).toBe("fp-m10");
    // Idempotent; another account's ids revise nothing; no ids, no statement.
    await runAtomically(db, revisionInserts(db, { userId, workoutIds: ids, sourceKind: "coros_import", sourceRef: null, now: NOW }));
    expect(await db.select({ id: workoutDocRevisions.id }).from(workoutDocRevisions)).toHaveLength(81);
    const other = await makeTestUser(db);
    await runAtomically(db, revisionInserts(db, { userId: other.userId, workoutIds: ids, sourceKind: "coach", sourceRef: null, now: NOW }));
    expect(await db.select({ id: workoutDocRevisions.id }).from(workoutDocRevisions)).toHaveLength(81);
    expect(revisionInserts(db, { userId, workoutIds: [], sourceKind: "coach", sourceRef: null, now: NOW })).toEqual([]);
  });
});
