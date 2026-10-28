/**
 * ADOPTION (workout-editability spec §3, §4; M2, M7): a revise of a revisable row whose origin is not app-authored — a
 * coach session (`cw-…`, origin NULL, stage rows, a copy on the watch) or a COROS-plan import (origin NULL, stage rows,
 * a backfilled document) — makes it a Studio document workout in the revise's own atomic write. A row that cannot be
 * revised is refused with its reason, why, and what to do instead. Invented ids and titles only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { planRoutes } from "../src/routes/plan.js";
import { repairPlannedWorkoutFidelity } from "../src/services/plan-repair.js";
import { makeTestDb, makeTestUser, mountRoutes, pinMiddayToday } from "./helpers.js";
import { activateTmj, calmDoc, clientFor, landingsDoc, makeEnv, type Reply } from "./doc-workout-fixture.js";

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
/** The route's own line for a run, kept beside the why and instead. */
const RUN_MESSAGE = "Runs can't be planned in the Studio yet.";

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

  it("a Studio or template revise is no adoption: no stage delete, and its content columns are left as they are", async () => {
    const sentinel = {
      structuredJson: { exercises: [{ name: "Sentinel", sets: 1, reps: 1 }] },
      stageSummary: "sentinel summary",
      expectedDistanceMeters: 1234,
      qualitySubtype: "sentinel-subtype",
      sourceEstimatedDurationSeconds: 999,
      durationEstimate: { seconds: 999, source: "sentinel" },
      sourceVersion: "sentinel-version",
      sourceContentFingerprint: "sentinel-fp",
      watchCopyName: "Sentinel copy",
    };
    const docs: Array<[string, WorkoutDoc]> = [
      ["studio", calmDoc()],
      ["template", { ...calmDoc(), basedOn: { kind: "template", id: "tpl-invented" } }],
    ];
    for (const [origin, doc] of docs) {
      const made = await call("POST", "/api/workouts", { date: tomorrow, doc });
      expect(made.body.workout.origin).toBe(origin);
      const id = made.body.workout.id as string;
      // Columns no Studio write sets, and a stage row no document workout has: a revise must leave every one of them.
      await db.update(plannedWorkouts).set(sentinel).where(eq(plannedWorkouts.id, id));
      await db.insert(plannedWorkoutStages).values({ id: `${id}:0`, workoutId: id, parentStageId: null, ord: 0, kind: "work", durationType: "none" });
      statements.length = 0;
      const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: { ...doc, title: "Revised, invented" }, baseRev: 1 });
      expect(res.status).toBe(200);
      expect(statements.some((s) => /^delete from "planned_workout_stages"/.test(s))).toBe(false);
      expect(await rowOf(id)).toMatchObject({ ...sentinel, origin, title: "Revised, invented", workoutDocRev: 2 });
      expect(await stagesOf(id)).toHaveLength(1);
    }
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

describe("an adopted row's old copy reaches the owner (spec §4): the Plan and the session sheet say the watch holds it", () => {
  /** The Plan's reads, as the app asks them. */
  async function planGet<T>(path: string): Promise<T> {
    const app = mountRoutes(db, "/api/plan", planRoutes);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    const res = await app.request(path, { headers: { Cookie: cookie } }, makeEnv());
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  }
  type Row = { id: string; corosSyncView?: string };

  it("says 'older on watch' (content_stale) while the copy's name is held — on Today's list and the sheet's read, with no Send or Keep from here — and not once it clears", async () => {
    // Adopted by a revise (the Studio's here; a coach approve's is the same write): its address kept, the name recorded.
    const id = "cw-test-20-0";
    await seedWatchShaped(id, { ...address("4242", "20", "880020", tomorrow) });
    await seedCoachCreate(id, `Legs, invented — ${tomorrow}`);
    expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Legs, revised" }), baseRev: 1 })).status).toBe(200);
    expect(await rowOf(id)).toMatchObject({ origin: "studio", watchCopyName: `Legs, invented — ${tomorrow}`, lastVerifiedCorosDate: tomorrow });

    const sheet = await planGet<{ workout: Row; watchVersion?: unknown }>(`/api/plan/workouts/${id}`);
    expect(sheet.workout.corosSyncView).toBe("content_stale");
    // An app-built row: no rewrite or keep from here (the Studio's Send replaces the copy).
    expect(sheet.watchVersion).toEqual({ send: false, why: "cant_rewrite" });
    const today = await planGet<{ upcoming: Row[] }>("/api/plan/today");
    expect(today.upcoming.find((w) => w.id === id)?.corosSyncView).toBe("content_stale");

    // The copy's delete verified (or a read no longer finds it): the name clears, and the row is what it is.
    await db.update(plannedWorkouts).set({ watchCopyName: null }).where(eq(plannedWorkouts.id, id));
    const after = await planGet<{ workout: Row; watchVersion?: unknown }>(`/api/plan/workouts/${id}`);
    expect(after.workout.corosSyncView).toBe("synced");
    expect(after.watchVersion).toBeUndefined();
    expect((await planGet<{ upcoming: Row[] }>("/api/plan/today")).upcoming.find((w) => w.id === id)?.corosSyncView).toBe("synced");
  });

  it("a held name says it only for a session still to run, and only for an app-authored row", async () => {
    // Its day gone: the copy is a record. A NULL-origin row with a name (none is written for one) says nothing either.
    const past = "cw-test-21-0";
    await seedWatchShaped(past, { origin: "studio", watchCopyName: "Legs, invented", ...address("4242", "21", "880021", today), effectiveDate: today, completionState: "completed" });
    const notOurs = "cw-test-22-0";
    await seedWatchShaped(notOurs, { watchCopyName: "Legs, invented", ...address("4242", "22", "880022", tomorrow) });
    expect((await planGet<{ workout: Row }>(`/api/plan/workouts/${past}`)).workout.corosSyncView).toBe("synced");
    expect((await planGet<{ workout: Row }>(`/api/plan/workouts/${notOurs}`)).workout.corosSyncView).toBe("synced");
  });
});

describe("a row that cannot be revised says why, and what to do instead", () => {
  it("a programme session: 409 not_editable cause programme with the spec's why and instead", async () => {
    await seedWatchShaped("slot-test-1", { origin: "program", planId: "prog-invented", stages: 0 });
    const res = await call("PUT", "/api/workouts/slot-test-1/doc", { doc: calmDoc({ title: "Mine now" }), baseRev: 1 });
    expect(res).toEqual({ status: 409, body: { error: "not_editable", cause: "programme", ...WORDS.programme } });
    expect(await rowOf("slot-test-1")).toMatchObject({ origin: "program", title: "Legs, invented", workoutDocRev: 1 });
  });

  it("rest / race: 409 not_editable with their reasons", async () => {
    await seedWatchShaped("cw-rest-1", { category: "rest", sport: "rest", doc: null, stages: 0 });
    await seedWatchShaped("cw-race-1", { category: "race", sport: "run", doc: null, stages: 0 });
    for (const [id, cause] of [["cw-rest-1", "rest"], ["cw-race-1", "race"]] as const) {
      const res = await call("PUT", `/api/workouts/${id}/doc`, { doc: calmDoc({ title: "Not this one" }), baseRev: 0 });
      expect(res).toEqual({ status: 409, body: { error: "not_editable", cause, ...WORDS[cause] } });
      expect(await rowOf(id)).toMatchObject({ origin: null, workoutDoc: null, workoutDocRev: null });
    }
  });

  it("a run with no document (its sport and category say run): 422 run_unsupported, with why and instead", async () => {
    await seedWatchShaped("cw-run-1", { category: "easy", sport: "run", doc: null, stages: 2 });
    const res = await call("PUT", "/api/workouts/cw-run-1/doc", { doc: calmDoc({ title: "Not this one" }), baseRev: 0 });
    expect(res).toEqual({ status: 422, body: { error: "run_unsupported", message: RUN_MESSAGE, ...WORDS.run } });
    expect(await rowOf("cw-run-1")).toMatchObject({ origin: null, workoutDoc: null, workoutDocRev: null });
    expect(await stagesOf("cw-run-1")).toHaveLength(2);
  });

  it("a run by its stored document (its sport and category say otherwise): 422 run_unsupported, before the draft is judged", async () => {
    const run = workoutDocSchema.parse({
      version: 1,
      title: "Tempo, invented",
      intent: { summary: "Steady tempo.", goals: [], focus: [], effort: "develop" },
      source: { kind: "coach" },
      parts: [{ purpose: "run", format: "intervals", items: [{ kind: "run", target: { durationSec: 1800 }, effort: "threshold" }] }],
    });
    await seedWatchShaped("cw-run-2", { category: "strength", sport: "strength", doc: run });
    const res = await call("PUT", "/api/workouts/cw-run-2/doc", { doc: { not: "a document" }, baseRev: 1 });
    expect(res).toEqual({ status: 422, body: { error: "run_unsupported", message: RUN_MESSAGE, ...WORDS.run } });
    expect(await rowOf("cw-run-2")).toMatchObject({ origin: null, workoutDocRev: 1, title: "Legs, invented" });
    expect(await stagesOf("cw-run-2")).toHaveLength(2);
  });

  it("a day gone: 422 past_date, with why and instead, before the document is judged", async () => {
    await seedWatchShaped("cw-past-1", { effectiveDate: addDays(today, -1) });
    const res = await call("PUT", "/api/workouts/cw-past-1/doc", { doc: { not: "a document" }, baseRev: 1 });
    expect(res).toEqual({ status: 422, body: { error: "past_date", ...WORDS.past } });
    expect(await rowOf("cw-past-1")).toMatchObject({ origin: null, workoutDocRev: 1 });
  });
});
