/**
 * What a save costs in D1 statements (plan 2b Task 6; ruling 2a-R8's budget habit): the save's own statements, and
 * the garden's replay after it, for a typical session (three logged moves, a post check, a rating) on a garden with
 * ten days of history. Logged for the report; the save's own part is held to a ceiling so a per-set or per-row loop
 * creeping in shows up here.
 */
import { describe, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId } from "@rg/domain";
import { buildSession, startSession } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import { advanceGarden, ensureGarden } from "../src/services/garden-sync.js";
import * as garden from "../src/services/garden-sync.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

// A build, a start, a garden and a save: seconds on a loaded runner, never a cost question.
vi.setConfig({ testTimeout: 30_000 });

const PLAYED = "2026-10-06";
const PLAYED_NOON = "2026-10-06T19:00:00.000Z";
const SAVED = "2026-10-07T16:00:00.000Z";

describe("a save's D1 statements", () => {
  it("a typical session: the save's own statements stay under 40, and its garden replay of one day under 50", async () => {
    const statements: string[] = [];
    const db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
    const { userId, prefs } = await makeTestUser(db);
    const programId = newId();
    await db.insert(schema.programs).values({
      id: programId, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"],
      startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
      createdAt: PLAYED_NOON, updatedAt: PLAYED_NOON, archivedAt: null,
    });
    await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
    const workoutId = slotId(programId, PLAYED);
    await db.insert(schema.plannedWorkouts).values({
      id: workoutId, userId, planId: programId, sourceWorkoutId: workoutId, title: "Mobility", category: "yoga", sport: "yoga",
      originalPlanDate: PLAYED, lastVerifiedCorosDate: "", effectiveDate: PLAYED, effectiveTime: "18:00", sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "program", contentState: "outline", createdAt: PLAYED_NOON, updatedAt: PLAYED_NOON,
    });
    await ensureGarden(db, userId, prefs, "2026-09-27");
    const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } }, overrides: { mode: "build" } }, { today: PLAYED, now: PLAYED_NOON, prefs });
    const build = (await startSession(db, userId, workoutId, built.build!.buildId, PLAYED_NOON)).build!;
    await advanceGarden(db, userId, prefs, new Date(SAVED));
    const moves = build.items.slice(0, 3);
    const body = {
      id: newId(), source: "app", sourceRef: null, workoutId, buildId: build.buildId, localDate: PLAYED,
      startedAt: "2026-10-06T19:05:00.000Z", endedAt: "2026-10-06T19:36:00.000Z", seconds: 1860, plannedSeconds: build.plannedSeconds,
      minutes: 30, mode: build.mode, theme: build.theme, locationId: build.locationId, blockRef: build.blockRef, blockNumber: 1,
      completed: true, stepsTotal: build.steps.length, stepsDone: build.steps.length,
      movesDone: build.items.map((i) => ({ exerciseId: i.exerciseId, seconds: 120 })), note: null, newMove: build.newMove,
      entries: moves.map((m) => ({
        exerciseId: m.exerciseId, implement: null, format: m.format, perSide: false,
        sets: [0, 1, 2].map((i) => ({ setIndex: i, reps: 8, seconds: null, load: { v: 25, u: "lb" } })),
      })),
      checks: [
        { profileId: "tmj", kind: "pre", value: 2, feelingOff: false, at: "2026-10-06T19:05:00.000Z" },
        { profileId: "tmj", kind: "post", value: 1, feelingOff: false, at: "2026-10-06T19:36:00.000Z" },
      ],
      review: { ratings: { [moves[0]!.exerciseId]: 1 } },
    };

    // The garden's replay is the save's last step: count the statements before it and after it.
    let atReplay = -1;
    const original = garden.resimulateFrom;
    vi.spyOn(garden, "resimulateFrom").mockImplementation(async (...args) => {
      atReplay = statements.length;
      return original(...args);
    });
    statements.length = 0;
    expect(await savePerformedSession(db, userId, body.id, body, { now: SAVED, prefs })).toMatchObject({ status: "saved", matched: true });
    expect(atReplay).toBeGreaterThan(0);
    const own = atReplay;
    const replay = statements.length - own;
    console.log(`[save] typical session: ${own} statements for the save itself, ${replay} for the garden replay of 1 day`);
    expect(own).toBeLessThan(40);
    // The replay is a capped catch-up step (ruling 2b-R7): one day's walk plus the step's bookkeeping (audit 2b-A M-10).
    expect(replay).toBeLessThan(50);
    expect(own + replay).toBeLessThan(90);
  });

  it("the largest save the schema takes is ONE batch of at most 100 statements, each under D1's 100 bound variables (for the staging check)", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs } = await makeTestUser(db);
    const programId = newId();
    await db.insert(schema.programs).values({
      id: programId, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"],
      startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
      createdAt: PLAYED_NOON, updatedAt: PLAYED_NOON, archivedAt: null,
    });
    const workoutId = slotId(programId, PLAYED);
    await db.insert(schema.plannedWorkouts).values({
      id: workoutId, userId, planId: programId, sourceWorkoutId: workoutId, title: "Mobility", category: "yoga", sport: "yoga",
      originalPlanDate: PLAYED, lastVerifiedCorosDate: "", effectiveDate: PLAYED, effectiveTime: "18:00", sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "program", contentState: "outline", createdAt: PLAYED_NOON, updatedAt: PLAYED_NOON,
    });
    const built = await buildSession(db, userId, workoutId, { overrides: { mode: "build" } }, { today: PLAYED, now: PLAYED_NOON, prefs });
    const build = (await startSession(db, userId, workoutId, built.build!.buildId, PLAYED_NOON)).build!;
    const { EXERCISES } = await import("@rg/exercise-library");
    const library = EXERCISES.map((e) => e.id);
    // Every limit at once: 300 sets (6 × 50), 20 checks, 200 moves reached, a rating and a "not for me" for every
    // exercise the library has.
    const body = {
      id: newId(), source: "app", sourceRef: null, workoutId, buildId: build.buildId, localDate: PLAYED,
      startedAt: "2026-10-06T19:05:00.000Z", endedAt: "2026-10-06T19:36:00.000Z", seconds: 1860, plannedSeconds: build.plannedSeconds,
      minutes: 30, mode: build.mode, theme: build.theme, locationId: build.locationId, blockRef: build.blockRef, blockNumber: 1,
      completed: true, stepsTotal: build.steps.length, stepsDone: build.steps.length,
      movesDone: Array.from({ length: 200 }, (_, i) => ({ exerciseId: library[i % library.length]!, seconds: 60 })), note: "n".repeat(2000), newMove: null,
      entries: Array.from({ length: 6 }, (_, e) => ({
        exerciseId: library[e]!, implement: "kettlebell", format: "straight", perSide: false,
        sets: Array.from({ length: 50 }, (_, i) => ({ setIndex: i, reps: 8, seconds: null, load: { v: 25, u: "lb" }, flags: ["a", "b"] })),
      })),
      checks: Array.from({ length: 10 }, (_, p) => (["pre", "post"] as const).map((kind) => ({ profileId: `profile-${p}`, kind, value: 2, feelingOff: false, at: "2026-10-06T19:05:00.000Z" }))).flat(),
      review: {
        ratings: Object.fromEntries(library.map((id) => [id, 1])),
        excluded: Object.fromEntries(library.map((id) => [id, false])),
      },
    };
    const dbModule = await import("../src/services/db.js");
    const atomic = dbModule.runAtomically;
    let batch = -1;
    vi.spyOn(dbModule, "runAtomically").mockImplementation(async (d, statements) => {
      batch = statements.length;
      return atomic(d, statements);
    });
    try {
      expect(await savePerformedSession(db, userId, body.id, body, { now: SAVED, prefs })).toMatchObject({ status: "saved" });
    } finally {
      vi.restoreAllMocks();
    }
    console.log(`[save] the largest save: one batch of ${batch} statements (${library.length} library exercises rated)`);
    expect(batch).toBeGreaterThan(50);
    expect(batch).toBeLessThanOrEqual(100);
    expect((await db.select().from(schema.performedSets)).length).toBe(300);
  });
});
