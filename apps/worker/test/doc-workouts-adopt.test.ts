/**
 * ADOPTION (workout-editability spec §3, §4; M2, M7): a revise of a revisable row whose origin is not app-authored — a
 * coach session (`cw-…`, origin NULL, stage rows, a copy on the watch) or a COROS-plan import (origin NULL, stage rows,
 * a backfilled document) — makes it a Studio document workout in the revise's own atomic write. A row that cannot be
 * revised is refused with its reason, why, and what to do instead. Invented ids and titles only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { repairPlannedWorkoutFidelity } from "../src/services/plan-repair.js";
import { makeTestDb, makeTestUser, pinMiddayToday } from "./helpers.js";
import { activateTmj, calmDoc, clientFor, landingsDoc, type Reply } from "./doc-workout-fixture.js";

const { plannedWorkouts, plannedWorkoutStages, workoutDocRevisions, corosWriteJobs } = schema;

// The route hands the calendar one bounded sync step through waitUntil: not under test here.
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let statements: string[];
let userId: string;
let today: string;
let tomorrow: string;
let call: (method: string, path: string, body?: unknown) => Promise<Reply>;
/** Runs just before each statement the application executes (a test arms it to land a concurrent write there). */
let beforeStatement: ((sql: string) => void) | null;

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  today = pinMiddayToday();
  tomorrow = addDays(today, 1);
  statements = [];
  beforeStatement = null;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (s) => {
      statements.push(s);
      beforeStatement?.(s);
    },
  });
  ({ userId } = await makeTestUser(db));
  call = await clientFor(db, userId);
});

const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const stagesOf = (id: string) => db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, id));
const revisionsOf = async (id: string) =>
  (await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id))).sort((a, b) => a.rev - b.rev);
const sqlite = () => (db as unknown as { $client: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).$client;

/** The COROS address a synced copy sits at (invented numbers). */
const address = (planId: string, idInPlan: string, programId: string, day: string) => ({
  sourceWorkoutId: `${planId}:${idInPlan}`,
  sourceIdInPlan: idInPlan,
  sourceProgramId: programId,
  lastVerifiedCorosDate: day,
});

/**
 * A NULL-origin row as the coach's own plan or the COROS import writes it: stage rows' summary, structure, COROS's
 * estimates and version, its fingerprint, and (when given) a document at revision 1 with its revision row.
 */
async function seedWatchShaped(
  id: string,
  over: Partial<typeof plannedWorkouts.$inferInsert> & { doc?: WorkoutDoc | null; stages?: number } = {},
): Promise<void> {
  const { doc = calmDoc({ title: "Legs, invented" }), stages = 2, ...cols } = over;
  const date = cols.effectiveDate ?? tomorrow;
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId: "coach-plan-invented",
    sourceWorkoutId: id,
    title: "Legs, invented",
    category: "strength",
    sport: "strength",
    qualitySubtype: "invented-subtype",
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "coach-invented-fp",
    sourceVersion: "v-invented",
    sourceEstimatedDurationSeconds: 2400,
    fallbackEstimatedDurationSeconds: 2400,
    calendarBlockDurationSeconds: 2400,
    durationEstimate: { seconds: 2400, source: "invented" },
    expectedDistanceMeters: 0,
    stageSummary: "Bridge 2×12 · Dead bug 2×8",
    structuredJson: { exercises: [{ name: "Bridge", sets: 2, reps: 12 }] },
    calendarSyncState: "synced",
    corosSyncState: "synced",
    origin: null,
    workoutDoc: doc ? JSON.stringify(doc) : null,
    workoutDocRev: doc ? 1 : null,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
    ...cols,
  });
  if (doc) {
    await db.insert(workoutDocRevisions).values({
      id: `${id}:1`, userId, workoutId: id, rev: 1, doc: JSON.stringify(doc), sourceKind: "coach", sourceRef: null, createdAt: nowInstant(),
    });
  }
  for (let ord = 0; ord < stages; ord++) {
    await db.insert(plannedWorkoutStages).values({
      id: `${id}:${ord}`, workoutId: id, parentStageId: null, ord, kind: "work", repeatCount: 2, durationType: "none",
      label: ord === 0 ? "Bridge" : "Dead Bug", reps: ord === 0 ? 12 : 8,
    });
  }
}

/** A settled coach create for the row: the program name the app put the copy on the watch under. */
async function seedCoachCreate(workoutId: string, name: string, status = "verified", id = `${workoutId}-push`): Promise<void> {
  await db.insert(corosWriteJobs).values({
    id, userId, workoutId, kind: "coach_create_workout", expectedContentFingerprint: "coach-invented-fp",
    originalDate: tomorrow, destinationDate: tomorrow,
    payload: { workoutId, happenDay: tomorrow, name, session: { category: "strength", title: "Legs, invented", durationMinutes: 40 } },
    requestedAt: nowInstant(), status, ...(status === "verified" ? { verifiedAt: nowInstant() } : {}), updatedAt: nowInstant(),
  });
}

/** The spec's words (§3's table), pinned here verbatim. */
const WORDS = {
  programme: {
    why: "It's a programme's session: the programme builds it on the day.",
    instead:
      "Put moves in its pool with pin_moves, change the programme with change_programme, or propose a new workout for that day and skip the slot with adjust_plan.",
  },
  run: {
    why: "It's a run: runs are re-planned, not revised.",
    instead: "adjust_plan changes its length or eases it; propose a new run to replace it.",
  },
  rest: { why: "It's a rest day.", instead: "Propose a new workout for that day." },
  race: { why: "It's race day.", instead: "Leave it; design around it." },
  past: { why: "Its day has passed.", instead: "Propose for today or later." },
} as const;

describe("a revise adopts a watch-shaped row", () => {
  it("a coach session with stages and a synced copy is adopted", async () => {
    const id = "cw-test-1-0";
    await seedWatchShaped(id, { ...address("4242", "7", "880001", tomorrow) });
    await seedCoachCreate(id, `Legs, invented — ${tomorrow}`);
    const next = calmDoc({ title: "Legs, revised" });

    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: next, baseRev: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rev: 2, watchHasOlder: true, warnings: [] });
    expect(res.body.workout).toMatchObject({ id, title: "Legs, revised", origin: "studio", docRev: 2 });

    const row = await rowOf(id);
    expect(row).toMatchObject({
      origin: "studio",
      title: "Legs, revised",
      workoutDocRev: 2,
      // The content columns a fresh Studio row carries (createDocWorkout's): the stage rows' world is gone.
      structuredJson: null,
      stageSummary: null,
      expectedDistanceMeters: null,
      qualitySubtype: null,
      sourceEstimatedDurationSeconds: null,
      durationEstimate: null,
      sourceVersion: null,
      sourceContentFingerprint: "studio",
      // The copy on the watch now belongs to this row: its address kept, the name it is held under recorded.
      watchCopyName: `Legs, invented — ${tomorrow}`,
      sourceWorkoutId: "4242:7",
      sourceIdInPlan: "7",
      sourceProgramId: "880001",
      lastVerifiedCorosDate: tomorrow,
      // It stays in its plan (Stop this plan and a week re-plan still reach it).
      planId: "coach-plan-invented",
    });
    expect(JSON.parse(row.workoutDoc!)).toEqual(next);
    expect(await stagesOf(id)).toEqual([]);
    expect((await revisionsOf(id)).map((r) => [r.id, r.rev, r.sourceKind])).toEqual([
      [`${id}:1`, 1, "coach"],
      [`${id}:2`, 2, "athlete_edit"],
    ]);
  });

  it("an imported watch-plan session is adopted with its wire title as the copy's name", async () => {
    const id = "imp-test-2";
    await seedWatchShaped(id, {
      planId: "coros-plan-invented",
      title: "STRENGTH B INVENTED",
      sourceContentFingerprint: "wire-invented-fp",
      ...address("5150", "3", "990002", tomorrow),
    });
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Strength B, mine" }), baseRev: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rev: 2, watchHasOlder: true });
    expect(await rowOf(id)).toMatchObject({
      origin: "studio",
      title: "Strength B, mine",
      watchCopyName: "STRENGTH B INVENTED",
      sourceWorkoutId: "5150:3",
      planId: "coros-plan-invented",
      structuredJson: null,
      stageSummary: null,
    });
    expect(await stagesOf(id)).toEqual([]);
  });

  it("a NULL-origin row with no document revises from rev 0", async () => {
    const id = "cw-test-3-0";
    await seedWatchShaped(id, { doc: null, stages: 0 });
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "First words" }), baseRev: 0 });
    expect(res.status).toBe(200);
    // No address: nothing of it is on the watch.
    expect(res.body).toMatchObject({ rev: 1, watchHasOlder: false });
    expect(await rowOf(id)).toMatchObject({ origin: "studio", workoutDocRev: 1, title: "First words", watchCopyName: null });
    expect((await revisionsOf(id)).map((r) => [r.rev, r.sourceKind])).toEqual([[1, "athlete_edit"]]);
  });

  it("the same document again adopts the row too, with no new revision (the revise is a taking-over)", async () => {
    const id = "cw-test-12-0";
    await seedWatchShaped(id);
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Legs, invented" }), baseRev: 1 });
    expect(res.status).toBe(200);
    expect(res.body.rev).toBe(1);
    expect(await rowOf(id)).toMatchObject({ origin: "studio", workoutDocRev: 1, structuredJson: null });
    expect(await stagesOf(id)).toEqual([]);
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  it("a watch copy name already recorded is never overwritten", async () => {
    const id = "cw-test-4-0";
    await seedWatchShaped(id, { ...address("4242", "8", "880003", tomorrow), watchCopyName: "Held, invented" });
    await seedCoachCreate(id, `Legs, invented — ${tomorrow}`);
    expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Again" }), baseRev: 1 })).status).toBe(200);
    expect((await rowOf(id)).watchCopyName).toBe("Held, invented");
  });

  it("a coach create the lane has claimed counts as being sent; a queued one does not (the lane supersedes it)", async () => {
    await seedWatchShaped("cw-test-5-0", { stages: 0 });
    await seedCoachCreate("cw-test-5-0", `Legs, invented — ${tomorrow}`, "claimed");
    const claimed = await call("PUT", "/api/workouts/cw-test-5-0/doc", { doc: calmDoc({ title: "Mid-send" }), baseRev: 1 });
    expect(claimed.body).toMatchObject({ rev: 2, watchHasOlder: true });
    expect((await rowOf("cw-test-5-0")).watchCopyName).toBeNull();

    await seedWatchShaped("cw-test-6-0", { stages: 0 });
    await seedCoachCreate("cw-test-6-0", `Legs, invented — ${tomorrow}`, "queued");
    const queued = await call("PUT", "/api/workouts/cw-test-6-0/doc", { doc: calmDoc({ title: "Not yet sent" }), baseRev: 1 });
    expect(queued.body).toMatchObject({ rev: 2, watchHasOlder: false });
  });

  it("the NULL guard (M2): a NULL-origin row passes the update's guard; one made a programme's between the read and the write does not", async () => {
    await seedWatchShaped("cw-test-7-0");
    const ok = await call("PUT", "/api/workouts/cw-test-7-0/doc", { doc: calmDoc({ title: "Through the guard" }), baseRev: 1 });
    expect(ok.status).toBe(200);
    expect(await rowOf("cw-test-7-0")).toMatchObject({ origin: "studio", title: "Through the guard", workoutDocRev: 2 });

    await seedWatchShaped("cw-test-8-0");
    beforeStatement = (s) => {
      if (!/^update "planned_workouts" set "title"/.test(s)) return;
      beforeStatement = null;
      sqlite().prepare("update planned_workouts set origin = 'on_demand' where id = ?").run("cw-test-8-0");
    };
    const raced = await call("PUT", "/api/workouts/cw-test-8-0/doc", { doc: calmDoc({ title: "Too late" }), baseRev: 1 });
    expect(raced).toEqual({ status: 409, body: { error: "not_editable", cause: "programme", ...WORDS.programme } });
    // Nothing of the adoption landed: its stages, its content and its document are as they were.
    expect(await rowOf("cw-test-8-0")).toMatchObject({ origin: "on_demand", title: "Legs, invented", workoutDocRev: 1, stageSummary: "Bridge 2×12 · Dead bug 2×8" });
    expect(await stagesOf("cw-test-8-0")).toHaveLength(2);
  });

  it("a revise that loses its race adopts nothing: the stage rows stay with the row they describe", async () => {
    await seedWatchShaped("cw-test-9-0");
    beforeStatement = (s) => {
      if (!/^update "planned_workouts" set "title"/.test(s)) return;
      beforeStatement = null;
      sqlite().prepare("update planned_workouts set completion_state = 'completed' where id = ?").run("cw-test-9-0");
    };
    const res = await call("PUT", "/api/workouts/cw-test-9-0/doc", { doc: calmDoc({ title: "Too late" }), baseRev: 1 });
    expect(res).toEqual({ status: 409, body: { error: "not_editable", cause: "resolved", why: "It's already done.", instead: "Propose a new workout." } });
    expect(await rowOf("cw-test-9-0")).toMatchObject({ origin: null, workoutDocRev: 1, structuredJson: { exercises: [{ name: "Bridge", sets: 2, reps: 12 }] } });
    expect(await stagesOf("cw-test-9-0")).toHaveLength(2);
  });

  it("a rename after adoption keeps the document", async () => {
    const id = "cw-test-10-0";
    const stamp = `Legs, invented — ${tomorrow}`;
    await seedWatchShaped(id, { doc: calmDoc({ title: "Legs, before" }), ...address("4242", "9", "880004", tomorrow) });
    await seedCoachCreate(id, stamp);
    const mine = calmDoc({ title: "Legs, invented" });
    expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: mine, baseRev: 1 })).status).toBe(200);
    // The stamp comes back as the row's title (as a read of the wire would put it): plan-repair renames it to the title meant.
    await db.update(plannedWorkouts).set({ title: stamp }).where(eq(plannedWorkouts.id, id));
    const report = await repairPlannedWorkoutFidelity(db, userId, { dryRun: false });
    expect(report.totals.titlesRepaired).toBe(1);
    const row = await rowOf(id);
    expect(row).toMatchObject({ title: "Legs, invented", origin: "studio", workoutDocRev: 2 });
    // A document workout's document is its content: the rename leaves it.
    expect(JSON.parse(row.workoutDoc!)).toEqual(mine);
  });

  it("adopting a row on the watch stays within the statement budget (≤ 45), with history on the account", async () => {
    await activateTmj(db, userId);
    const id = "cw-test-11-0";
    await seedWatchShaped(id, { doc: landingsDoc(), ...address("4242", "10", "880005", tomorrow) });
    await seedCoachCreate(id, `Legs and landings — ${tomorrow}`);
    statements.length = 0;
    const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: landingsDoc({ reps: 10 }), baseRev: 1 });
    expect(res.status).toBe(200);
    expect(res.body.watchHasOlder).toBe(true);
    expect(statements.length).toBeLessThanOrEqual(45);
  });
});

describe("a row that cannot be revised says why, and what to do instead (409 not_editable)", () => {
  it("a programme session: 409 not_editable cause programme with the spec's why and instead", async () => {
    await seedWatchShaped("slot-test-1", { origin: "program", planId: "prog-invented", stages: 0 });
    const res = await call("PUT", "/api/workouts/slot-test-1/doc", { doc: calmDoc({ title: "Mine now" }), baseRev: 1 });
    expect(res).toEqual({ status: 409, body: { error: "not_editable", cause: "programme", ...WORDS.programme } });
    expect(await rowOf("slot-test-1")).toMatchObject({ origin: "program", title: "Legs, invented", workoutDocRev: 1 });
  });

  it("rest / race / a run with no document: 409 with their reasons", async () => {
    await seedWatchShaped("cw-rest-1", { category: "rest", sport: "rest", doc: null, stages: 0 });
    await seedWatchShaped("cw-race-1", { category: "race", sport: "run", doc: null, stages: 0 });
    await seedWatchShaped("cw-run-1", { category: "easy", sport: "run", doc: null, stages: 2 });
    for (const [id, cause] of [["cw-rest-1", "rest"], ["cw-race-1", "race"], ["cw-run-1", "run"]] as const) {
      const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Not this one" }), baseRev: 0 });
      expect(res).toEqual({ status: 409, body: { error: "not_editable", cause, ...WORDS[cause] } });
      expect(await rowOf(id)).toMatchObject({ origin: null, workoutDoc: null, workoutDocRev: null });
    }
    expect(await stagesOf("cw-run-1")).toHaveLength(2);
  });

  it("a day gone: 409 not_editable cause past, before the document is judged", async () => {
    await seedWatchShaped("cw-past-1", { effectiveDate: addDays(today, -1) });
    const res = await call("PUT", "/api/workouts/cw-past-1/doc", { doc: { not: "a document" }, baseRev: 1 });
    expect(res).toEqual({ status: 409, body: { error: "not_editable", cause: "past", ...WORDS.past } });
  });
});
