/**
 * MARK DONE (plans with a purpose, spec §4.2 and §5.1; rulings R40, R41): the athlete says a course's session happened, since
 * following its video records nothing. It never writes a document, it works on a course's own sessions only, today or up to a
 * week back, and it only reverses itself. The garden reads it as a session done, once.
 *
 * Everything runs on a made-up course (`course-fixture.ts`): worker code reads only the definition. Fixed dates under a faked
 * `Date`, so nothing here goes stale. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ begin: null as null | (() => Promise<unknown>) }));
vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});
vi.mock("../src/services/account-state.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/account-state.js")>();
  return {
    ...real,
    restoreInProgress: vi.fn(async (db: Db, userId: string) => {
      const marked = await real.restoreInProgress(db, userId);
      // `begin` lands right after this check said "no restore".
      if (!marked && race.begin) {
        const begin = race.begin;
        race.begin = null;
        await begin();
      }
      return marked;
    }),
  };
});

import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, courseConfigSchema, newId, todayInZone, type CourseConfig, type SourceActivity, type UserPreferences } from "@rg/domain";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { homeConsistency, planRoutes } from "../src/routes/plan.js";
import { planRoutes as plansRoutes } from "../src/routes/plans.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { ingestActivities } from "../src/services/completion.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { finishCoursesPartWay } from "../src/services/course-plans.js";
import { writeCourseSession, writeCourseSessionsDue } from "../src/services/course-sessions.js";
import { MARK_DONE_REPLAY_MAX_DAYS } from "../src/services/cron-limits.js";
import type { Db } from "../src/services/db.js";
import { advanceGarden, buildDayInput, ensureGarden, REQUEST_GARDEN_STEP } from "../src/services/garden-sync.js";
import { mirrorSweep, queueProvisionalPush } from "../src/services/mirror.js";
import { mirrorIntentId } from "../src/services/mirror-owed.js";
import { listPlans } from "../src/services/plan-registry.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { courseSessionsDone, placeSlots, slotId } from "../src/services/program-slots.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { reviewBasis } from "../src/services/session-review-basis.js";
import { buildSessionOutcome, type BuildCtx } from "../src/services/session-build.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { cloneTestDb, isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { makeRealisticEnv, seedRealisticAccount } from "./realistic-account.js";
import { connectMock, seedCatalog, switchOn } from "./watch-push-fixture.js";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";

const { accountState, activities, corosWriteJobs, gardenDayInputs, performedSessions, plannedWorkouts, programs, sessionBuilds, syncIntents, workoutCompletionMatches, workoutDocRevisions } = schema;

/** A Monday. */
const MON = "2026-10-05";
/** Monday noon in Los Angeles, the test user's zone. */
const NOW = "2026-10-05T19:00:00.000Z";
const AT = new Date(NOW);
const ENV = { APP_URL: "https://app.test", FIXTURE_MODE: "0" } as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let ctx: BuildCtx;
let statements: string[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT);
  statements = [];
  race.begin = null;
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db));
  ctx = { today: MON, now: NOW, prefs };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const writes = () => statements.filter(isWrite);
/** The clone's own SQLite, to land a change at a chosen moment. */
const sqliteOf = (d: Db) => (d as unknown as { $client: { prepare(q: string): { run(...a: unknown[]): void } } }).$client;
const row = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const revisionsOf = (id: string) => db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id));
const cookieFor = async (owner = userId): Promise<string> => `${SESSION_COOKIE}=${await createSession(db, owner)}`;

/** A running course on Monday and Friday at 18:15, unless a test says otherwise. */
async function seedCourse(config: Partial<CourseConfig> = {}, over: Partial<typeof programs.$inferInsert> = {}): Promise<string> {
  const id = over.id ?? newId();
  await db.insert(programs).values({
    id,
    userId,
    kind: "course",
    name: "Evening practice",
    status: "active",
    disciplines: ["yoga"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "18:15", placementWeeksAhead: 1, ...config }),
    onEnd: "continue",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...over,
  });
  return id;
}

/** A course with its outlines placed, as the hourly pass places them. */
async function placed(config: Partial<CourseConfig> = {}, over: Partial<typeof programs.$inferInsert> = {}): Promise<string> {
  const p = await seedCourse(config, over);
  await placeSlots(db, userId, p, MON, prefs, NOW);
  return p;
}

/** An outline of the plan on any day, in any state: what placement leaves behind it. */
async function outline(planId: string, date: string, completionState = "scheduled", over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<string> {
  const id = over.id ?? slotId(planId, date);
  await db.insert(plannedWorkouts).values({
    id, userId, planId, sourceWorkoutId: id, title: "Evening practice", category: "yoga", sport: "yoga", originalPlanDate: date, lastVerifiedCorosDate: "",
    effectiveDate: date, effectiveTime: "18:15", sourceContentFingerprint: "program", calendarBlockDurationSeconds: 900, origin: "program", contentState: "outline",
    completionState, createdAt: NOW, updatedAt: NOW, ...over,
  });
  return id;
}

/** A session of the course already written as `n`. */
async function written(planId: string, date: string, n: number, completionState = "scheduled", over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<string> {
  const id = over.id ?? newId();
  await db.insert(plannedWorkouts).values({
    id, userId, planId, sourceWorkoutId: id, title: `Intro ${n}`, category: "yoga", sport: "yoga", originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date,
    effectiveTime: "18:15", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900, origin: "studio", contentState: "outline",
    completionState, courseSession: n, createdAt: NOW, updatedAt: NOW, workoutDoc: JSON.stringify(INTRO_COURSE.sessionDoc(n, { ease: false })), workoutDocRev: 1, ...over,
  });
  return id;
}

/** A workout the coach filed under the plan: a document, no number, so not the course's own. */
const filed = (planId: string, date: string, completionState = "scheduled") => written(planId, date, 1, completionState, { courseSession: null, title: "Extra" });

/** What the route answers, and the statements it spent. */
async function mark(id: string, done: boolean, cookie?: string): Promise<{ status: number; body: { error?: string; why?: string; ok?: boolean }; spent: number }> {
  const headers = { Cookie: cookie ?? (await cookieFor()), "content-type": "application/json" };
  statements.length = 0;
  const res = await mountRoutes(db, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}/mark-done`, { method: "POST", headers, body: JSON.stringify({ done }) }, ENV);
  const spent = statements.length;
  const text = await res.text();
  let body: { error?: string; why?: string; ok?: boolean } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = { error: text };
  }
  return { status: res.status, body, spent };
}

const refused = async (id: string, done: boolean, error: string) => {
  const res = await mark(id, done);
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.error).toBe(error);
  // Words the sheet can say as they are.
  expect(res.body.why).toEqual(expect.any(String));
  expect(writes().filter((s) => !/"sessions"/.test(s))).toEqual([]);
};

const asDone = { completionState: "completed", sanctionedBy: "athlete_said_done" };

describe("marking a session done", () => {
  it("completes today's outline in one write, with its number and no document, and the next session's n is one higher", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const res = await mark(id, true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await row(id)).toMatchObject({ ...asDone, resolutionDate: MON, origin: "program", contentState: "outline", courseSession: 1, workoutDoc: null, workoutDocRev: null });
    expect(await revisionsOf(id)).toEqual([]);
    expect(await courseSessionsDone(db, userId, p)).toBe(1);

    const friday = addDays(MON, 4);
    expect(await writeCourseSession(db, userId, await row(slotId(p, friday)), { ...ctx, today: friday })).toEqual({ written: true, n: 2 });
  });

  it("a written session keeps its document, its revision and the number it was written as", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    const before = await row(id);
    expect(before).toMatchObject({ origin: "studio", courseSession: 1 });
    await mark(id, true);
    expect(await row(id)).toMatchObject({ ...asDone, origin: "studio", courseSession: 1, workoutDoc: before.workoutDoc, workoutDocRev: before.workoutDocRev });
    expect(await revisionsOf(id)).toHaveLength(1);
    expect(await courseSessionsDone(db, userId, p)).toBe(1);
  });

  describe("an outline, whatever holds it (R40): one rule, and nothing written or judged", () => {
    const cases: Array<[string, Partial<CourseConfig>, Partial<typeof programs.$inferInsert>, string, string]> = [
      ["due today", {}, {}, MON, "scheduled"],
      ["held by a pause", {}, { pausedUntil: addDays(MON, 3) }, MON, "scheduled"],
      ["held by a start part way", { finishing: "start" }, {}, MON, "scheduled"],
      ["held by a stop part way", { finishing: "stop" }, { status: "retired" }, MON, "scheduled"],
      ["yesterday's", {}, {}, addDays(MON, -1), "scheduled"],
      ["last week's, unresolved", {}, {}, addDays(MON, -4), "unresolved"],
      ["a week back, missed", {}, {}, addDays(MON, -7), "missed"],
      ["a paused plan's past session", {}, { pausedUntil: addDays(MON, 3) }, addDays(MON, -2), "unresolved"],
      ["a stopped plan's past session (R41)", {}, { status: "retired" }, addDays(MON, -3), "unresolved"],
    ];
    it.each(cases)("%s", async (_, config, over, date, state) => {
      const sessionDoc = vi.spyOn(INTRO_COURSE, "sessionDoc");
      const p = await seedCourse(config, over);
      const id = await outline(p, date, state, state === "missed" ? { resolutionDate: MON } : {});
      expect((await mark(id, true)).status).toBe(200);
      expect(await row(id)).toMatchObject({ ...asDone, resolutionDate: date, origin: "program", courseSession: 1, workoutDoc: null, workoutDocRev: null });
      expect(await revisionsOf(id)).toEqual([]);
      expect(sessionDoc).not.toHaveBeenCalled();
    });

    it("one whose definition has gone can still say it happened", async () => {
      const p = await seedCourse({ course: "gone" });
      const id = await outline(p, MON);
      expect((await mark(id, true)).status).toBe(200);
      expect(await row(id)).toMatchObject({ ...asDone, courseSession: 1 });
    });
  });

  describe("today, or up to a week back, never ahead", () => {
    it.each([
      [0, 200],
      [1, 200],
      [7, 200],
      [8, 409],
      [30, 409],
    ])("%i days back: %i", async (back, status) => {
      const p = await seedCourse();
      const id = await outline(p, addDays(MON, -back), "unresolved");
      const res = await mark(id, true);
      expect(res.status).toBe(status);
      if (status === 409) {
        expect(res.body.error).toBe("too_long_ago");
        expect((await row(id)).completionState).toBe("unresolved");
      }
    });

    it("a session ahead is refused, and stays as it was", async () => {
      const p = await placed();
      const id = slotId(p, addDays(MON, 4));
      const before = await row(id);
      await refused(id, true, "ahead");
      expect(await row(id)).toEqual(before);
    });

    it("by the athlete's own day, not UTC's: late on Monday in their zone, Tuesday's is still ahead", async () => {
      vi.setSystemTime(new Date("2026-10-06T02:00:00.000Z"));
      const p = await seedCourse();
      const tuesday = await outline(p, addDays(MON, 1));
      const monday = await outline(p, MON);
      await refused(tuesday, true, "ahead");
      expect((await mark(monday, true)).status).toBe(200);
    });

    it("by the account's own day at the far end too: 8 days back in UTC's reckoning is 7 in theirs", async () => {
      vi.setSystemTime(new Date("2026-10-06T02:00:00.000Z"));
      const p = await seedCourse();
      expect((await mark(await outline(p, addDays(MON, -7), "missed"), true)).status).toBe(200);
    });
  });

  describe("a course's own sessions only (R41)", () => {
    it("a workout the coach filed under the plan is refused: it doesn't count, and completes the normal way", async () => {
      const p = await seedCourse();
      const id = await filed(p, MON);
      await refused(id, true, "not_a_course_session");
      expect((await row(id)).completionState).toBe("scheduled");
    });

    it("a session of another plan is refused, a programme's slot or a Studio workout", async () => {
      const adaptive = await seedCourse({}, { kind: "adaptive" });
      await refused(await outline(adaptive, MON), true, "not_a_course_session");
      const plain = await seedCourse({}, { kind: "studio" });
      await refused(await filed(plain, MON), true, "not_a_course_session");
    });

    it("another account's session, a removed one and none at all are not found", async () => {
      const p = await seedCourse();
      const removed = await outline(p, MON, "scheduled", { archivedAt: NOW, archiveReason: "user_removed" });
      expect((await mark(removed, true)).status).toBe(404);
      expect((await mark("no-such-row", true)).status).toBe(404);

      const theirs = await outline(p, addDays(MON, -1));
      const { userId: stranger } = await makeTestUser(db);
      const res = await mark(theirs, true, await cookieFor(stranger));
      expect(res.status).toBe(404);
      expect((await row(theirs)).completionState).toBe("scheduled");
    });
  });

  describe("refused for a session under way, or done another way", () => {
    it("started: the player has it", async () => {
      const p = await seedCourse();
      await refused(await written(p, MON, 1, "scheduled", { contentState: "started" }), true, "under_way");
    });

    it("played through, though its row says nothing yet", async () => {
      const p = await seedCourse();
      await refused(await written(p, MON, 1, "scheduled", { contentState: "done" }), true, "saved");
    });

    it("a performed session saved against it", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      await db.insert(performedSessions).values({ id: newId(), userId, workoutId: id, source: "app", localDate: MON, movesDone: [], payloadHash: "h", createdAt: NOW, updatedAt: NOW });
      await refused(id, true, "saved");
    });

    it("built isn't under way", async () => {
      const p = await seedCourse();
      expect((await mark(await written(p, MON, 1, "scheduled", { contentState: "built" }), true)).status).toBe(200);
    });

    it("matched to an activity", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      await linkOpen(id);
      await refused(id, true, "matched");
    });

    it("a match undone doesn't count", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      await linkOpen(id, NOW);
      expect((await mark(id, true)).status).toBe(200);
    });

    it("a match on some other session isn't this one's", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      await linkOpen(await outline(p, addDays(MON, -1)));
      expect((await mark(id, true)).status).toBe(200);
    });

    it("completed another way", async () => {
      const p = await seedCourse();
      await refused(await outline(p, MON, "completed", { courseSession: 1 }), true, "completed_another_way");
    });

    it("skipped: the athlete said otherwise, and un-skipping comes first", async () => {
      const p = await seedCourse();
      await refused(await outline(p, MON, "skipped", { resolutionDate: MON }), true, "skipped");
    });

  });

  describe("the write holds to what the read saw: anything landing between them writes nothing, and the answer is the row as it now stands", () => {
    /** The route's write, with `land` landing just before it. */
    async function racing(id: string, done: boolean, land: (d: Db) => void) {
      const { markSessionDone } = await import("../src/services/mark-done.js");
      let landed = false;
      const clone: Db = cloneTestDb(db, {
        onStatement: (s) => {
          if (landed || !isWrite(s)) return;
          landed = true;
          land(clone);
        },
      });
      const out = await markSessionDone(clone, userId, id, done, { today: MON, now: NOW, prefs });
      const [after] = await clone.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
      return { out, after: after! };
    }
    const run = (statement: unknown) => (statement as { run(): void }).run();
    const setRow = (id: string, values: Partial<typeof plannedWorkouts.$inferInsert>) => (d: Db) => run(d.update(plannedWorkouts).set(values).where(eq(plannedWorkouts.id, id)));
    const matchIt = (id: string) => (d: Db) => {
      const activityId = newId();
      run(d.insert(activities).values({ id: activityId, userId, corosActivityId: `c-${activityId}`, source: "coros", startTime: `${MON}T18:15:00Z`, startTimeLocal: `${MON}T12:30:00`, timezone: "America/Los_Angeles", sport: "yoga", durationSeconds: 600, sourceMergeConfidence: 1, createdAt: NOW, updatedAt: NOW }));
      run(d.insert(workoutCompletionMatches).values({ id: newId(), workoutId: id, activityId, confidence: 1, method: "manual", matchedAt: NOW }));
    };
    const saveIt = (id: string) => (d: Db) => run(d.insert(performedSessions).values({ id: newId(), userId, workoutId: id, source: "app", localDate: MON, movesDone: [], payloadHash: "h", createdAt: NOW, updatedAt: NOW }));
    const restoreIt = (d: Db) => run(d.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW }));

    describe("a mark", () => {
      const cases: Array<[string, (id: string) => (d: Db) => void, Record<string, unknown>]> = [
        ["started", (id) => setRow(id, { contentState: "started" }), { status: 409, error: "under_way" }],
        ["matched", matchIt, { status: 409, error: "matched" }],
        ["saved", saveIt, { status: 409, error: "saved" }],
        ["a restore begun", () => restoreIt, { status: 423 }],
        ["removed", (id) => setRow(id, { archivedAt: NOW, archiveReason: "user_removed" }), { status: 404 }],
        ["moved ahead", (id) => setRow(id, { effectiveDate: addDays(MON, 3) }), { status: 409, error: "ahead" }],
        ["moved within the week", (id) => setRow(id, { effectiveDate: addDays(MON, -1) }), { status: 409, error: "changed" }],
        ["skipped", (id) => setRow(id, { completionState: "skipped" }), { status: 409, error: "skipped" }],
        ["no longer the course's", (id) => setRow(id, { origin: "studio" }), { status: 409, error: "not_a_course_session" }],
      ];
      it.each(cases)("%s", async (_, land, answer) => {
        const p = await seedCourse();
        const id = await outline(p, MON);
        const { out, after } = await racing(id, true, land(id));
        expect(out).toMatchObject({ ok: false, ...answer });
        expect(after.sanctionedBy).toBeNull();
        expect(after.courseSession).toBeNull();
        expect(after.completionState).not.toBe("completed");
      });
    });

    describe("an undo", () => {
      const cases: Array<[string, (id: string) => (d: Db) => void, Record<string, unknown>]> = [
        ["matched since", matchIt, { ok: false, status: 409, error: "matched" }],
        ["saved since", saveIt, { ok: false, status: 409, error: "saved" }],
        ["started since", (id) => setRow(id, { contentState: "started" }), { ok: false, status: 409, error: "under_way" }],
        ["a restore begun", () => restoreIt, { ok: false, status: 423 }],
        ["removed", (id) => setRow(id, { archivedAt: NOW, archiveReason: "user_removed" }), { ok: false, status: 404 }],
        ["moved", (id) => setRow(id, { effectiveDate: addDays(MON, -2) }), { ok: false, status: 409, error: "changed" }],
        ["taken over by evidence", (id) => setRow(id, { sanctionedBy: null }), { ok: false, status: 409, error: "completed_another_way" }],
      ];
      it.each(cases)("%s", async (_, land, answer) => {
        const p = await seedCourse();
        const id = await outline(p, MON, "completed", { ...asDone, courseSession: 1, resolutionDate: MON });
        const { out, after } = await racing(id, false, land(id));
        expect(out).toMatchObject(answer);
        expect(after.completionState).toBe("completed");
        expect(after.courseSession).toBe(1);
      });

      it("already reopened by another request: nothing to reverse, and nothing written over it", async () => {
        const p = await seedCourse();
        const id = await outline(p, addDays(MON, -3), "completed", { ...asDone, courseSession: 1, resolutionDate: addDays(MON, -3) });
        const { out, after } = await racing(id, false, setRow(id, { completionState: "scheduled", snoozedUntil: addDays(MON, 1) }));
        expect(out).toEqual({ ok: true, from: null });
        // A pass of the undo's would have left it `scheduled` too: what it would have cleared says it didn't run.
        expect(after).toMatchObject({ completionState: "scheduled", sanctionedBy: "athlete_said_done", courseSession: 1 });
      });
    });

    it("no longer the course's by the plan's own kind", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      const { out, after } = await racing(id, true, (d) => run(d.update(programs).set({ kind: "adaptive" }).where(eq(programs.id, p))));
      expect(out).toMatchObject({ ok: false, status: 409, error: "not_a_course_session" });
      expect(after.completionState).toBe("scheduled");
    });
  });

  it("the session guard takes Mark done as done, and its undo as open: a move is refused, then allowed; the mark and its undo aren't blocked", async () => {
    const plan = await seedCourse();
    const id = await outline(plan, MON);
    const move = async () => {
      const res = await mountRoutes(db, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}/move`, { method: "POST", headers: { Cookie: await cookieFor(), "content-type": "application/json" }, body: JSON.stringify({ toDate: addDays(MON, 1), toTime: "18:15" }) }, ENV);
      return { status: res.status, body: (await res.json()) as { error?: string } };
    };
    expect((await mark(id, true)).status).toBe(200);
    expect(await move()).toMatchObject({ status: 409, body: { error: "session_completed" } });
    expect((await mark(id, false)).status).toBe(200);
    expect((await move()).status).toBe(200);
  });

  it("only that session, though another shares its day and its plan", async () => {
    const p = await seedCourse();
    const id = await outline(p, MON);
    const other = await outline(p, MON, "scheduled", { id: "same-day" });
    await mark(id, true);
    expect((await row(other)).completionState).toBe("scheduled");
    expect(await row(id)).toMatchObject(asDone);
    await mark(other, true);
    expect(await row(other)).toMatchObject({ ...asDone, courseSession: 2 });
    await mark(id, false);
    expect((await row(other)).completionState).toBe("completed");
    expect((await row(id)).completionState).toBe("scheduled");
  });

  it("a plan of another account's isn't this row's course, whatever it's called", async () => {
    const { userId: stranger } = await makeTestUser(db);
    const theirs = await seedCourse({}, { userId: stranger });
    await refused(await outline(theirs, MON), true, "not_a_course_session");
  });

  it("said twice, it writes once and replays nothing", async () => {
    const p = await seedCourse();
    const id = await outline(p, MON);
    await mark(id, true);
    const before = await row(id);
    const again = await mark(id, true);
    expect(again.status).toBe(200);
    expect(writes().filter((s) => !/"sessions"/.test(s))).toEqual([]);
    expect(await row(id)).toEqual(before);
    expect(await courseSessionsDone(db, userId, p)).toBe(1);
  });

  it("a body that isn't `{done: boolean}` is refused", async () => {
    const p = await seedCourse();
    const id = await outline(p, MON);
    for (const body of ["{}", '{"done":"yes"}', "not json", '{"done":true,"extra":1}']) {
      const res = await mountRoutes(db, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}/mark-done`, { method: "POST", headers: { Cookie: await cookieFor(), "content-type": "application/json" }, body }, ENV);
      expect(res.status, body).toBe(400);
    }
    expect((await row(id)).completionState).toBe("scheduled");
  });

  describe("a restore in progress", () => {
    const beginRestore = () => db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });

    it("refuses the route, as every write route is refused", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      await beginRestore();
      expect((await mark(id, true)).status).toBe(423);
      expect((await row(id)).completionState).toBe("scheduled");
    });

    it("one begun just after the middleware looked is refused the same", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      const cookie = await cookieFor();
      race.begin = () => beginRestore();
      const res = await mark(id, true, cookie);
      expect(res.status).toBe(423);
      expect(res.body.error).toBe("restore_in_progress");
      expect((await row(id)).completionState).toBe("scheduled");
    });

    it("one begun since the middleware looked holds the write, either way", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      const marked = await outline(p, addDays(MON, -1), "completed", { sanctionedBy: "athlete_said_done", courseSession: 1, resolutionDate: addDays(MON, -1) });
      await beginRestore();
      const { markSessionDone } = await import("../src/services/mark-done.js");
      expect(await markSessionDone(db, userId, id, true, { today: MON, now: NOW, prefs })).toMatchObject({ ok: false, status: 423 });
      expect(await markSessionDone(db, userId, marked, false, { today: MON, now: NOW, prefs })).toMatchObject({ ok: false, status: 423 });
      expect((await row(id)).completionState).toBe("scheduled");
      expect((await row(marked)).completionState).toBe("completed");
    });
  });
});

/** An open match of this row to an activity of the athlete's, or a match undone at `undoneAt`. */
async function linkOpen(workoutId: string, undoneAt: string | null = null): Promise<string> {
  const activityId = newId();
  await db.insert(activities).values({
    id: activityId, userId, corosActivityId: `c-${activityId}`, source: "coros", startTime: `${MON}T18:15:00Z`, startTimeLocal: `${MON}T12:30:00`, timezone: "America/Los_Angeles",
    sport: "yoga", durationSeconds: 600, sourceMergeConfidence: 1, createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(workoutCompletionMatches).values({ id: newId(), workoutId, activityId, confidence: 1, method: "manual", matchedAt: NOW, undoneAt });
  return activityId;
}

describe("undoing it", () => {
  it("reverses it: today's outline is a plain outline again, its number gone", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const before = await row(id);
    await mark(id, true);
    const res = await mark(id, false);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await row(id)).toEqual({ ...before, updatedAt: expect.any(String) });
    expect(await courseSessionsDone(db, userId, p)).toBe(0);
  });

  it("then the next write uses the right n", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await mark(id, true);
    await mark(id, false);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect(await row(id)).toMatchObject({ origin: "studio", courseSession: 1, title: "Intro 1", completionState: "scheduled" });
  });

  it("with sessions done either side, the next write counts what's still done", async () => {
    const p = await placed();
    const a = await outline(p, addDays(MON, -3));
    const b = await outline(p, addDays(MON, -2));
    await mark(a, true);
    await mark(b, true);
    expect(await courseSessionsDone(db, userId, p)).toBe(2);
    await mark(a, false);
    expect(await courseSessionsDone(db, userId, p)).toBe(1);
    expect(await writeCourseSession(db, userId, await row(slotId(p, MON)), ctx)).toEqual({ written: true, n: 2 });
  });

  it("a written session keeps its document and the number it was written as", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    const before = await row(id);
    await mark(id, true);
    await mark(id, false);
    expect(await row(id)).toEqual({ ...before, updatedAt: expect.any(String) });
    expect(await courseSessionsDone(db, userId, p)).toBe(0);
    // Marked again, it counts again, as the same number.
    await mark(id, true);
    expect(await row(id)).toMatchObject({ ...asDone, courseSession: 1, workoutDoc: before.workoutDoc });
    expect(await courseSessionsDone(db, userId, p)).toBe(1);
  });

  describe("the watch", () => {
    const owed = async (id: string) => (await db.select().from(syncIntents).where(eq(syncIntents.id, mirrorIntentId(id))))[0];
    const settle = (id: string) => db.update(syncIntents).set({ resolvedAt: NOW }).where(eq(syncIntents.id, mirrorIntentId(id)));

    it("a written session undone on its own day is owed its copy again, as an un-skip's is", async () => {
      const p = await placed();
      const id = slotId(p, MON);
      await writeCourseSession(db, userId, await row(id), ctx);
      await settle(id);
      await mark(id, true);
      expect((await owed(id))?.resolvedAt).toBe(NOW);
      await mark(id, false);
      expect((await owed(id))?.resolvedAt).toBeNull();
    });

    it("a day gone owes nothing, and nor does an outline, which has no copy", async () => {
      const p = await seedCourse();
      const past = await written(p, addDays(MON, -1), 1);
      await mark(past, true);
      await mark(past, false);
      expect(await owed(past)).toBeUndefined();
      const today = await outline(p, MON);
      await mark(today, true);
      await mark(today, false);
      expect(await owed(today)).toBeUndefined();
    });
  });

  describe("back to the state reconcile would give it for its date", () => {
    /** A twin never marked, on the same day, after reconcile's passes: what reconcile gives that date. */
    async function reconciledTwin(p: string, date: string) {
      const twin = await outline(p, date, "scheduled", { id: `twin-${date}` });
      await reconcileCompletionStates(db, userId, await loadPreferences(db, userId), AT);
      await reconcileCompletionStates(db, userId, await loadPreferences(db, userId), AT);
      return row(twin);
    }

    it.each([
      [0, "scheduled", null],
      [1, "scheduled", null],
      [2, "unresolved", null],
      [6, "unresolved", null],
      [7, "missed", MON],
    ])("%i days back: %s", async (back, state, resolved) => {
      const p = await seedCourse();
      const date = addDays(MON, -back);
      const id = await outline(p, date, "scheduled");
      await mark(id, true);
      await mark(id, false);
      expect(await row(id)).toMatchObject({ completionState: state, resolutionDate: resolved, sanctionedBy: null, courseSession: null });
      const twin = await reconciledTwin(p, date);
      expect([twin.completionState, twin.resolutionDate]).toEqual([state, resolved]);
      // Reconcile finds nothing to do to it.
      const after = await row(id);
      expect([after.completionState, after.resolutionDate]).toEqual([state, resolved]);
    });

    it("a row marked long ago can still be undone: it's missed, resolved today", async () => {
      const p = await seedCourse();
      const date = addDays(MON, -20);
      const id = await outline(p, date, "completed", { ...asDone, courseSession: 1, resolutionDate: date });
      expect((await mark(id, false)).status).toBe(200);
      expect(await row(id)).toMatchObject({ completionState: "missed", resolutionDate: MON, sanctionedBy: null, courseSession: null });
    });

    it("under rest mode reconcile leaves it alone, and nothing is asked or missed", async () => {
      await savePreferences(db, userId, { ...prefs, gardenRestMode: true, gardenRestModeUntil: addDays(MON, 3) });
      const p = await seedCourse();
      const id = await outline(p, addDays(MON, -7));
      await mark(id, true);
      await mark(id, false);
      expect(await row(id)).toMatchObject({ completionState: "scheduled", resolutionDate: null });
    });

    it("rest mode that has ended asks again", async () => {
      await savePreferences(db, userId, { ...prefs, gardenRestMode: true, gardenRestModeUntil: addDays(MON, -1) });
      const p = await seedCourse();
      const id = await outline(p, addDays(MON, -3));
      await mark(id, true);
      await mark(id, false);
      expect((await row(id)).completionState).toBe("unresolved");
    });

    it("a \"not yet\" still running holds until it lapses", async () => {
      const p = await seedCourse();
      const id = await outline(p, addDays(MON, -3), "scheduled", { snoozedUntil: addDays(MON, 1) });
      await mark(id, true);
      await mark(id, false);
      expect((await row(id)).completionState).toBe("scheduled");
    });

    it("a \"not yet\" that has lapsed doesn't", async () => {
      const p = await seedCourse();
      const id = await outline(p, addDays(MON, -3), "scheduled", { snoozedUntil: MON });
      await mark(id, true);
      await mark(id, false);
      expect((await row(id)).completionState).toBe("unresolved");
    });
  });

  describe("a plain outline again, and a number left behind reads as nothing", () => {
    it("a pause takes today's undone outline as it takes any (`flexible`, `TOUCHED`)", async () => {
      const p = await placed();
      const id = slotId(p, MON);
      await mark(id, true);
      await mark(id, false);
      await db.update(programs).set({ pausedUntil: addDays(MON, 1) }).where(eq(programs.id, p));
      await placeSlots(db, userId, p, MON, prefs, NOW);
      expect(await row(id)).toMatchObject({ archiveReason: "program_replaced" });
    });

    it("placement doesn't count the row twice or place another on its day", async () => {
      const p = await placed();
      const id = slotId(p, MON);
      const rows = () => db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, p), eq(plannedWorkouts.effectiveDate, MON)));
      await mark(id, true);
      await placeSlots(db, userId, p, MON, prefs, NOW);
      expect(await rows()).toHaveLength(1);
      await mark(id, false);
      await placeSlots(db, userId, p, MON, prefs, NOW);
      expect(await rows()).toHaveLength(1);
      expect((await row(id)).archivedAt).toBeNull();
    });

    it("a number on a row that isn't completed counts for nothing: not done, nor on the list", async () => {
      const p = await seedCourse();
      await outline(p, addDays(MON, -1), "scheduled", { courseSession: 5 });
      await outline(p, addDays(MON, -2), "unresolved", { courseSession: 6, id: "two" });
      expect(await courseSessionsDone(db, userId, p)).toBe(0);
      expect((await listPlans(db, userId, MON)).find((x) => x.id === p)!.course).toEqual({ session: 1, of: 4 });
    });
  });

  describe("only this kind", () => {
    it("a session completed by a match is 409, and nothing moves", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON, "completed", { courseSession: 1, resolutionDate: MON });
      await linkOpen(id);
      await refused(id, false, "matched");
      expect(await row(id)).toMatchObject({ completionState: "completed", courseSession: 1 });
    });

    it("a session completed by an app save is 409", async () => {
      const p = await seedCourse();
      await refused(await written(p, MON, 1, "completed", { contentState: "done", resolutionDate: MON }), false, "completed_another_way");
    });

    it("a completion with no evidence but not this mark is 409", async () => {
      const p = await seedCourse();
      await refused(await outline(p, MON, "completed", { courseSession: 1 }), false, "completed_another_way");
      await refused(await outline(p, addDays(MON, -1), "completed", { sanctionedBy: "coach", courseSession: 2 }), false, "completed_another_way");
    });

    it("marked, then matched: the match is what stands", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON, "completed", { ...asDone, courseSession: 1, resolutionDate: MON });
      await linkOpen(id);
      await refused(id, false, "matched");
      expect((await row(id)).completionState).toBe("completed");
    });

    it("marked, then played: a saved session is what stands", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON, "completed", { ...asDone, courseSession: 1, resolutionDate: MON });
      await db.insert(performedSessions).values({ id: newId(), userId, workoutId: id, source: "app", localDate: MON, movesDone: [], payloadHash: "h", createdAt: NOW, updatedAt: NOW });
      await refused(id, false, "saved");
      const started = await outline(p, addDays(MON, -1), "completed", { ...asDone, courseSession: 2, resolutionDate: addDays(MON, -1), contentState: "started" });
      await refused(started, false, "under_way");
    });

    it("a workout the coach filed is 409 either way", async () => {
      const p = await seedCourse();
      await refused(await filed(p, MON, "completed"), false, "not_a_course_session");
    });

    it("a skipped session has no mark to undo", async () => {
      const p = await seedCourse();
      await refused(await outline(p, MON, "skipped", { resolutionDate: MON }), false, "skipped");
    });

    it("undone twice, the second changes nothing: a retry after a lost answer", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      await mark(id, true);
      await mark(id, false);
      const before = await row(id);
      const again = await mark(id, false);
      expect(again.status).toBe(200);
      expect(writes().filter((s) => !/"sessions"/.test(s))).toEqual([]);
      expect(await row(id)).toEqual(before);
    });
  });
});

describe("an undo after a stop (R42): what the stop said goes on being true", () => {
  const plansReq = async (path: string) => {
    const headers = { Cookie: await cookieFor(), "content-type": "application/json" };
    const res = await mountRoutes(db, "/api/plans", plansRoutes).request(`/api/plans${path}`, { method: "POST", headers }, ENV);
    return (await res.json()) as { more?: boolean; waiting?: boolean };
  };
  const stopAll = async (p: string) => {
    for (let i = 0; i < 40; i += 1) {
      const step = await plansReq(`/${p}/stop`);
      if (!step.more || step.waiting) return;
    }
    throw new Error("the stop never ended");
  };
  const planOf = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!;
  const finishing = async (id: string) => ((await planOf(id)).config as { finishing?: string }).finishing;
  const pushesOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id))).filter((j) => j.kind === "program_session_push");
  const owed = async (id: string) => {
    const [mark] = await db.select().from(syncIntents).where(eq(syncIntents.id, mirrorIntentId(id)));
    return mark !== undefined && mark.resolvedAt === null;
  };

  /** The watch on: writes on, connected, its catalog there. */
  async function watchOn() {
    ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
    ctx = { today: MON, now: NOW, prefs };
    await seedCatalog(db);
    const server = mockCorosServer({ baseMonday: "2026-10-12" });
    await connectMock(db, userId, server);
    return {
      server,
      sweep: () => mirrorSweep(db, switchOn(), userId, prefs, ctx, { cap: 1 }),
      lane: () => executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl }),
    };
  }

  it("an outline marked today, the stop run to its end, then undone: the marker's back, the hour takes it, and it never reads as missed", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await mark(id, true);
    await stopAll(p);
    expect(await finishing(p)).toBeUndefined();
    expect((await row(id)).archivedAt).toBeNull();

    expect((await mark(id, false)).status).toBe(200);
    expect(await finishing(p)).toBe("stop");
    expect((await planOf(p)).status).toBe("retired");
    expect(await row(id)).toMatchObject({ completionState: "unresolved", archivedAt: null, sanctionedBy: null, courseSession: null, resolutionDate: null });
    expect(await owed(id)).toBe(false);

    expect(await finishCoursesPartWay(db, AT)).toEqual({ finished: 1, failed: 0 });
    expect(await row(id)).toMatchObject({ archiveReason: "program_replaced" });
    expect(await finishing(p)).toBeUndefined();

    // Eight days on, reconcile has nothing to miss, and the garden nothing to debit.
    const later = new Date("2026-10-13T19:00:00.000Z");
    vi.setSystemTime(later);
    await reconcileCompletionStates(db, userId, prefs, later);
    await reconcileCompletionStates(db, userId, prefs, later);
    expect((await row(id)).completionState).not.toBe("missed");
    expect((await buildDayInput(db, userId, "2026-10-13", prefs)).missedRuns).toEqual([]);
  });

  it("a written one: nothing owed, and no push queued by the sweep, the lane or a day's build, before the hour takes it", async () => {
    const { sweep, lane, server } = await watchOn();
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    await mark(id, true);
    await stopAll(p);
    expect((await row(id)).origin).toBe("studio");
    await db.update(syncIntents).set({ resolvedAt: NOW }).where(eq(syncIntents.id, mirrorIntentId(id)));

    expect((await mark(id, false)).status).toBe(200);
    expect(await finishing(p)).toBe("stop");
    expect(await owed(id)).toBe(false);

    // The window's read finds a document workout with no mark at all, and the sheet's own build hands the day's to the mirror.
    await sweep();
    await lane();
    await buildSessionOutcome(db, userId, id, {}, { ...ctx, env: switchOn() });
    await lane();
    expect(await pushesOf(id)).toEqual([]);
    expect((server.state.schedule.programs ?? []).filter((x) => String(x.name).startsWith("Intro"))).toEqual([]);

    expect(await finishCoursesPartWay(db, AT)).toEqual({ finished: 1, failed: 0 });
    expect(await row(id)).toMatchObject({ archiveReason: "program_replaced" });
    expect(await finishing(p)).toBeUndefined();
    await sweep();
    expect(await pushesOf(id)).toEqual([]);
  });

  it("an owed mark left open from before gives nothing either: the sweep settles it", async () => {
    const { sweep } = await watchOn();
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    expect(await owed(id)).toBe(true);
    await mark(id, true);
    await stopAll(p);
    await mark(id, false);
    await sweep();
    expect(await pushesOf(id)).toEqual([]);
    expect(await owed(id)).toBe(false);
  });

  it("a copy already on the watch comes off with it, as the confirm said", async () => {
    const { lane } = await watchOn();
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    expect(await queueProvisionalPush(db, switchOn(), userId, await row(id), ctx)).toBe("queued");
    await lane();
    const [record] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, id));
    await mark(id, true);
    await stopAll(p);
    await mark(id, false);
    await finishCoursesPartWay(db, AT);
    expect(await row(id)).toMatchObject({ archiveReason: "program_replaced" });
    const [unpush] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `unpush:${record!.id}`));
    expect(unpush).toMatchObject({ status: "queued" });
    expect(await finishing(p)).toBeUndefined();
  });

  it("marked again before the hour, it stays: the step finds nothing and the marker clears", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await mark(id, true);
    await stopAll(p);
    await mark(id, false);
    await mark(id, true);
    await finishCoursesPartWay(db, AT);
    expect(await row(id)).toMatchObject({ ...asDone, archivedAt: null });
    expect(await finishing(p)).toBeUndefined();
  });

  describe("a day gone stays as it was: that row was open at the stop", () => {
    it.each([
      ["an outline", (p: string, date: string) => outline(p, date, "completed", { ...asDone, courseSession: 1, resolutionDate: date })],
      ["a written one", (p: string, date: string) => written(p, date, 1, "completed", { ...asDone, resolutionDate: date })],
    ])("%s", async (_, seed) => {
      const p = await seedCourse({}, { status: "retired" });
      const date = addDays(MON, -3);
      const id = await seed(p, date);
      expect((await mark(id, false)).status).toBe(200);
      expect(await finishing(p)).toBeUndefined();
      expect(await owed(id)).toBe(false);
      expect(await row(id)).toMatchObject({ completionState: "unresolved", archivedAt: null });
      expect(await finishCoursesPartWay(db, AT)).toEqual({ finished: 0, failed: 0 });
      expect((await row(id)).archivedAt).toBeNull();
    });
  });

  it("a plan still running arms nothing, and its session goes back as it did", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await mark(id, true);
    await mark(id, false);
    expect(await finishing(p)).toBeUndefined();
    expect((await row(id)).completionState).toBe("scheduled");
    expect((await finishCoursesPartWay(db, AT)).finished).toBe(0);
  });

  it("a paused one neither: a pause isn't a stop", async () => {
    const p = await placed({}, { pausedUntil: addDays(MON, 2) });
    const id = await outline(p, MON, "completed", { ...asDone, courseSession: 1, resolutionDate: MON, id: "paused-row" });
    await mark(id, false);
    expect(await finishing(p)).toBeUndefined();
    expect((await row(id)).completionState).toBe("scheduled");
  });

  it("the marker goes on another account's plan never, and only on this row's plan", async () => {
    const p = await seedCourse({}, { status: "retired" });
    const other = await seedCourse({}, { status: "retired" });
    const id = await outline(p, MON, "completed", { ...asDone, courseSession: 1, resolutionDate: MON });
    await mark(id, false);
    expect(await finishing(p)).toBe("stop");
    expect(await finishing(other)).toBeUndefined();
  });

  describe("all of it lands or none: in the write's own batch", () => {
    /** The undo, with `land` landing just before the batch's first write. */
    async function racing(id: string, land: (d: Db) => void) {
      const { markSessionDone } = await import("../src/services/mark-done.js");
      let landed = false;
      const clone: Db = cloneTestDb(db, {
        onStatement: (s) => {
          if (landed || !isWrite(s)) return;
          landed = true;
          land(clone);
        },
      });
      const out = await markSessionDone(clone, userId, id, false, { today: MON, now: NOW, prefs });
      return { out, clone };
    }
    const configOn = async (d: Db, p: string) => (await d.select().from(programs).where(eq(programs.id, p)))[0]!.config as { finishing?: string };
    const started = (id: string) => (d: Db) => (d.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, id)) as unknown as { run(): void }).run();

    it("the guard refusing the row arms nothing", async () => {
      const p = await seedCourse({}, { status: "retired" });
      const id = await outline(p, MON, "completed", { ...asDone, courseSession: 1, resolutionDate: MON });
      const { out, clone } = await racing(id, started(id));
      expect(out).toMatchObject({ ok: false, status: 409, error: "under_way" });
      expect((await configOn(clone, p)).finishing).toBeUndefined();
    });

    it("nor marks anything owed", async () => {
      const p = await seedCourse();
      const id = await written(p, MON, 1, "completed", { ...asDone, resolutionDate: MON });
      const { out, clone } = await racing(id, started(id));
      expect(out).toMatchObject({ ok: false, status: 409, error: "under_way" });
      expect(await clone.select().from(syncIntents).where(eq(syncIntents.id, mirrorIntentId(id)))).toEqual([]);
    });

    it("a stop landing just before the batch is read as the batch runs: armed, nothing owed", async () => {
      const p = await seedCourse();
      const id = await written(p, MON, 1, "completed", { ...asDone, resolutionDate: MON });
      const stop = (d: Db) => (d.update(programs).set({ status: "retired" }).where(eq(programs.id, p)) as unknown as { run(): void }).run();
      const { out, clone } = await racing(id, stop);
      expect(out).toMatchObject({ ok: true });
      expect((await configOn(clone, p)).finishing).toBe("stop");
      expect(await clone.select().from(syncIntents).where(eq(syncIntents.id, mirrorIntentId(id)))).toEqual([]);
    });

    it("a write that fails takes the marker with it", async () => {
      const p = await seedCourse({}, { status: "retired" });
      const id = await outline(p, MON, "completed", { ...asDone, courseSession: 1, resolutionDate: MON });
      const { markSessionDone } = await import("../src/services/mark-done.js");
      const clone: Db = cloneTestDb(db, {
        onStatement: (s) => {
          if (/^update "planned_workouts"/.test(s)) throw new Error("the row's write failed");
        },
      });
      await expect(markSessionDone(clone, userId, id, false, { today: MON, now: NOW, prefs })).rejects.toThrow("the row's write failed");
      expect((await configOn(clone, p)).finishing).toBeUndefined();
    });
  });
});

describe("the garden", () => {
  const input = (date: string) => buildDayInput(db, userId, date, prefs);

  it("credits it once: `athlete_said_done` isn't read as the coach's skip", async () => {
    const p = await seedCourse();
    const date = addDays(MON, -2);
    const id = await outline(p, date, "unresolved");
    await mark(id, true);
    const day = await input(date);
    expect(day.completedRuns).toEqual([expect.objectContaining({ workoutId: id, discipline: "yoga" })]);
    expect(day.completedRuns[0]!.activityId).toBeUndefined();
    expect(day.missedRuns).toEqual([]);
    // No mercy day: that's the coach's sanctioned skip.
    expect(day.restObserved).toBe(false);
  });

  it("said twice, undone and said again: still once", async () => {
    const p = await seedCourse();
    const date = addDays(MON, -2);
    const id = await outline(p, date, "unresolved");
    await mark(id, true);
    await mark(id, true);
    await mark(id, false);
    expect((await input(date)).completedRuns).toEqual([]);
    await mark(id, true);
    expect((await input(date)).completedRuns).toHaveLength(1);
  });

  it("a miss marked done is no miss any more, and undone it's a miss again, landing on today", async () => {
    const p = await seedCourse();
    const date = addDays(MON, -7);
    const id = await outline(p, date, "missed", { resolutionDate: addDays(MON, -1) });
    expect((await input(addDays(MON, -1))).missedRuns).toEqual([{ workoutId: id }]);
    await mark(id, true);
    expect((await input(addDays(MON, -1))).missedRuns).toEqual([]);
    expect((await input(date)).completedRuns).toHaveLength(1);
    await mark(id, false);
    expect((await input(date)).completedRuns).toEqual([]);
    expect((await input(MON)).missedRuns).toEqual([{ workoutId: id }]);
  });

  it("the week's adherence reads it as done", async () => {
    const p = await seedCourse();
    await mark(await outline(p, addDays(MON, -3)), true);
    await outline(p, addDays(MON, -2), "missed", { resolutionDate: addDays(MON, -1) });
    expect((await input(MON)).weekAdherence).toBe(0.5);
  });

  it("the streak's band reads it as done", async () => {
    const p = await seedCourse();
    const id = await outline(p, addDays(MON, -3));
    await mark(id, true);
    const shown = homeConsistency([await row(id)] as never, MON, 0);
    expect(shown.weeks.find((w) => w.weekStart === addDays(MON, -7))?.band).toBe("full");
    expect(shown.adherencePct).toBe(100);
  });

  it("reconcile leaves it alone, however old", async () => {
    const p = await seedCourse();
    const id = await outline(p, addDays(MON, -7), "unresolved");
    await mark(id, true);
    const before = await row(id);
    expect(await reconcileCompletionStates(db, userId, prefs, AT)).toMatchObject({ markedUnresolved: 0, autoMissed: 0 });
    expect(await row(id)).toEqual(before);
  });

  it("the review's records count sessions played: a mark logs no moves, so it adds nothing to them, nor breaks their read", async () => {
    const p = await placed({ weekdays: [0, 2, 4] });
    await mark(await outline(p, addDays(MON, -2)), true);
    const today = slotId(p, MON);
    await buildSessionOutcome(db, userId, today, {}, ctx);
    const { records } = await reviewBasis(db, userId, today, { today: MON, unit: "kg" });
    expect(records.count).toBe(0);
    expect(records.weekCounts).toEqual({});
    expect(records.weeklyGoal).toBe(3);
  });

  it("a replay lands it once on its own day, and an undo takes it back off", async () => {
    await ensureGarden(db, userId, prefs, addDays(MON, -21));
    const p = await seedCourse();
    const date = addDays(MON, -3);
    const id = await outline(p, date, "unresolved");
    await advanceGarden(db, userId, prefs, AT);
    const walked = async () => {
      // What a garden read does after the request's own step.
      for (let i = 0; i < 6; i += 1) await advanceGarden(db, userId, prefs, AT, REQUEST_GARDEN_STEP);
      const [stored] = await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.id, `${userId}:${date}`));
      return (stored!.input as { completedRuns: Array<{ workoutId: string }> }).completedRuns.map((r) => r.workoutId);
    };
    expect(await walked()).toEqual([]);
    await mark(id, true);
    expect(await walked()).toEqual([id]);
    await mark(id, false);
    expect(await walked()).toEqual([]);
  });

  describe("an activity that is the session's own, arriving after the mark", () => {
    const linked = (id: string, over: Partial<SourceActivity> = {}): SourceActivity => ({
      provider: "coros",
      providerActivityId: id,
      startTime: "2026-10-06T02:30:00Z",
      startTimeLocal: "2026-10-05T18:15:00",
      sport: "yoga",
      durationSeconds: 660,
      contentFingerprint: `fp-${id}`,
      sourcePlannedWorkoutId: "program-9",
      ...over,
    });

    it("takes over from the athlete's word: credited once, as the activity, and no longer theirs to undo", async () => {
      const p = await seedCourse();
      const id = await written(p, MON, 1, "scheduled", { sourceProgramId: "program-9" });
      await mark(id, true);
      await ingestActivities(db, { userId, sources: [linked("a-9")] });

      expect(await row(id)).toMatchObject({ completionState: "completed", sanctionedBy: null, courseSession: 1 });
      const day = await input(MON);
      expect(day.completedRuns).toHaveLength(1);
      expect(day.completedRuns[0]).toMatchObject({ workoutId: id, activityId: expect.any(String) });
      expect(await courseSessionsDone(db, userId, p)).toBe(1);
      await refused(id, false, "matched");
    });

    it("an unrelated activity is still no guess at it: it counts as extra training, and the mark stands", async () => {
      const p = await seedCourse();
      const id = await written(p, MON, 1, "scheduled", { sourceProgramId: "program-9" });
      await mark(id, true);
      await ingestActivities(db, { userId, sources: [linked("a-10", { sourcePlannedWorkoutId: "other" })] });
      expect(await row(id)).toMatchObject(asDone);
      expect(await db.select().from(workoutCompletionMatches).where(eq(workoutCompletionMatches.workoutId, id))).toEqual([]);
    });

    it("a manual link does the same", async () => {
      const p = await seedCourse();
      const id = await outline(p, MON);
      await mark(id, true);
      const activityId = newId();
      await db.insert(activities).values({
        id: activityId, userId, corosActivityId: `c-${activityId}`, source: "coros", startTime: `${MON}T18:15:00Z`, startTimeLocal: `${MON}T12:30:00`, timezone: "America/Los_Angeles",
        sport: "yoga", durationSeconds: 600, sourceMergeConfidence: 1, createdAt: NOW, updatedAt: NOW,
      });
      const res = await mountRoutes(db, "/api/plan", planRoutes).request(
        `/api/plan/workouts/${id}/match`,
        { method: "POST", headers: { Cookie: await cookieFor(), "content-type": "application/json" }, body: JSON.stringify({ activityId }) },
        ENV,
      );
      expect(res.status).toBe(200);
      expect(await row(id)).toMatchObject({ completionState: "completed", sanctionedBy: null, courseSession: 1 });
      expect((await input(MON)).completedRuns).toHaveLength(1);
      await refused(id, false, "matched");
    });

    describe("a marked outline keeps the number it took, whatever completes it again", () => {
      const linkManually = async (id: string) => {
        const activityId = newId();
        await db.insert(activities).values({
          id: activityId, userId, corosActivityId: `c-${activityId}`, source: "coros", startTime: `${MON}T18:15:00Z`, startTimeLocal: `${MON}T12:30:00`, timezone: "America/Los_Angeles",
          sport: "yoga", durationSeconds: 600, sourceMergeConfidence: 1, createdAt: NOW, updatedAt: NOW,
        });
        const res = await mountRoutes(db, "/api/plan", planRoutes).request(
          `/api/plan/workouts/${id}/match`,
          { method: "POST", headers: { Cookie: await cookieFor(), "content-type": "application/json" }, body: JSON.stringify({ activityId }) },
          ENV,
        );
        expect(res.status).toBe(200);
      };

      it("a manual link, with n past it: it doesn't take the next number, which counts itself", async () => {
        const p = await seedCourse();
        const first = await outline(p, addDays(MON, -3));
        const second = await outline(p, addDays(MON, -2));
        await mark(first, true);
        await mark(second, true);
        expect([(await row(first)).courseSession, (await row(second)).courseSession]).toEqual([1, 2]);
        await linkManually(first);
        expect((await row(first)).courseSession).toBe(1);
        expect(await courseSessionsDone(db, userId, p)).toBe(2);
      });

      it("its own activity arriving by the sync", async () => {
        const p = await seedCourse();
        const earlier = await outline(p, addDays(MON, -2));
        const id = await outline(p, MON, "scheduled", { sourceProgramId: "program-9" });
        await mark(earlier, true);
        await mark(id, true);
        expect((await row(id)).courseSession).toBe(2);
        await ingestActivities(db, { userId, sources: [linked("a-13")] });
        expect(await row(id)).toMatchObject({ sanctionedBy: null, courseSession: 2 });
        expect(await courseSessionsDone(db, userId, p)).toBe(2);
      });

      it("one reopened and completed again takes the number it has then: that isn't this", async () => {
        const p = await seedCourse();
        const first = await outline(p, addDays(MON, -3));
        const second = await outline(p, addDays(MON, -2));
        await mark(first, true);
        await mark(second, true);
        await mark(first, false);
        await linkManually(first);
        expect((await row(first)).courseSession).toBe(2);
      });
    });

    describe("a save takes over from the mark too", () => {
      const performedId = "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0d";
      const save = (id: string) =>
        savePerformedSession(
          db,
          userId,
          performedId,
          {
            id: performedId, source: "app", sourceRef: null, workoutId: id, buildId: null, localDate: MON,
            startedAt: NOW, endedAt: NOW, seconds: 600, plannedSeconds: 660, minutes: 11, mode: "recovery",
            theme: null, locationId: null, blockRef: null, blockNumber: null, completed: true,
            stepsTotal: 1, stepsDone: 1,
            movesDone: [{ exerciseId: "legsUp", seconds: 600 }], note: null, newMove: null,
            entries: [{ exerciseId: "legsUp", implement: null, format: "holds", perSide: false, sets: [{ setIndex: 0, reps: null, seconds: 600, load: null }] }],
            checks: [], review: {},
          },
          { now: NOW, prefs },
        );
      const openMatches = async (id: string) =>
        (await db.select().from(workoutCompletionMatches).where(and(eq(workoutCompletionMatches.workoutId, id), isNull(workoutCompletionMatches.undoneAt)))).map((m) => m.method);

      it("the mark goes in the save's write, and a linked activity after it finds nothing open: one live match", async () => {
        const p = await seedCourse();
        const id = await written(p, MON, 1, "scheduled", { sourceProgramId: "program-9" });
        await mark(id, true);
        expect((await save(id)).status).toBe("saved");
        expect(await row(id)).toMatchObject({ completionState: "completed", contentState: "done", sanctionedBy: null, courseSession: 1 });
        expect(await openMatches(id)).toEqual(["app_session"]);
        await ingestActivities(db, { userId, sources: [linked("a-14")] });
        expect(await openMatches(id)).toEqual(["app_session"]);
        await refused(id, false, "matched");
      });

      it("a save that couldn't take the slot's match still played it: the mark goes all the same", async () => {
        const p = await seedCourse();
        const id = await written(p, MON, 1, "completed", { ...asDone, resolutionDate: MON });
        await linkOpen(id);
        const saved = await save(id);
        expect(saved.status).toBe("saved");
        expect(saved).toMatchObject({ matched: false });
        expect(await row(id)).toMatchObject({ contentState: "done", sanctionedBy: null });
      });
    });

    it("a session completed any other way isn't open to it: the activity stays extra training", async () => {
      const p = await seedCourse();
      const before = addDays(MON, -1);
      const id = await written(p, MON, 1, "completed", { sourceProgramId: "program-9", resolutionDate: before });
      await ingestActivities(db, { userId, sources: [linked("a-12")] });
      expect(await db.select().from(workoutCompletionMatches).where(eq(workoutCompletionMatches.workoutId, id))).toEqual([]);
      expect((await row(id)).resolutionDate).toBe(before);
    });

    it("a session the coach sanctioned keeps what the coach said", async () => {
      const p = await seedCourse();
      const id = await written(p, MON, 1, "scheduled", { sourceProgramId: "program-9", sanctionedBy: "coach" });
      await ingestActivities(db, { userId, sources: [linked("a-11")] });
      expect(await row(id)).toMatchObject({ completionState: "completed", sanctionedBy: "coach" });
    });
  });
});

describe("what the session read says (no statement of its own)", () => {
  const read = async (id: string) => {
    const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(`/api/sessions/${id}`, { headers: { Cookie: await cookieFor() } }, ENV);
    expect(res.status).toBe(200);
    return (await res.json()) as { course?: { markDone: string | null; held: string | null }; origin: string; build: unknown; completionState?: string };
  };

  it("the read says the row's completion, which a sheet can't take from a row the page read before", async () => {
    const p = await seedCourse();
    const id = await outline(p, addDays(MON, -2), "unresolved");
    expect((await read(id)).completionState).toBe("unresolved");
    await mark(id, true);
    expect((await read(id)).completionState).toBe("completed");
    await mark(id, false);
    expect((await read(id)).completionState).toBe("unresolved");
  });

  it("an outline of today that a pause holds offers it, and says why", async () => {
    const p = await seedCourse({}, { pausedUntil: addDays(MON, 2) });
    expect((await read(await outline(p, MON))).course).toEqual({ markDone: "offer", held: "paused" });
  });

  it("one a start or a stop is part way through holds too, and a stopped plan's", async () => {
    const starting = await seedCourse({ finishing: "start" });
    expect((await read(await outline(starting, MON))).course).toEqual({ markDone: "offer", held: "starting" });
    const stopping = await seedCourse({ finishing: "stop" }, { status: "retired" });
    expect((await read(await outline(stopping, MON))).course).toEqual({ markDone: "offer", held: "stopped" });
    const stopped = await seedCourse({}, { status: "retired" });
    expect((await read(await outline(stopped, MON))).course).toEqual({ markDone: "offer", held: "stopped" });
  });

  it("a hold is today's to say: a pause says nothing on a session behind or ahead of it", async () => {
    const p = await seedCourse({}, { pausedUntil: addDays(MON, 9) });
    expect((await read(await outline(p, addDays(MON, -1)))).course).toEqual({ markDone: "offer", held: null });
    expect((await read(await outline(p, addDays(MON, 2)))).course).toEqual({ markDone: null, held: null });
  });

  it("nor on one that's over: a session marked done today isn't held by anything", async () => {
    const p = await seedCourse({}, { pausedUntil: addDays(MON, 2) });
    const id = await outline(p, MON);
    await mark(id, true);
    expect((await read(id)).course).toEqual({ markDone: "marked", held: null });
  });

  it("a pause that ended yesterday holds nothing: it's written, and offered", async () => {
    const p = await seedCourse({}, { pausedUntil: addDays(MON, -1) });
    const out = await read(await outline(p, MON));
    expect(out.origin).toBe("studio");
    expect(out.course).toEqual({ markDone: "offer", held: null });
  });

  it("a written session offers it by its number alone", async () => {
    const p = await seedCourse();
    expect((await read(await written(p, addDays(MON, -1), 1))).course).toEqual({ markDone: "offer", held: null });
  });

  it("marked, it offers the undo", async () => {
    const p = await seedCourse();
    const id = await outline(p, addDays(MON, -1));
    await mark(id, true);
    expect((await read(id)).course).toEqual({ markDone: "marked", held: null });
  });

  it.each([
    ["a week back", 7, "unresolved", {}, "offer"],
    ["missed", 7, "missed", {}, "offer"],
    ["8 days back", 8, "unresolved", {}, null],
    ["skipped", 1, "skipped", {}, null],
    ["completed another way", 1, "completed", {}, null],
    ["started", 1, "scheduled", { contentState: "started" }, null],
    ["played", 1, "scheduled", { contentState: "done" }, null],
    ["marked, then played", 1, "completed", { contentState: "done", sanctionedBy: "athlete_said_done" }, null],
  ])("past: %s", async (_, back, state, over, expected) => {
    const p = await seedCourse();
    expect((await read(await outline(p, addDays(MON, -back), state, over))).course?.markDone).toBe(expected);
  });

  it("a day ahead is never offered", async () => {
    const p = await placed();
    expect((await read(slotId(p, addDays(MON, 4)))).course).toEqual({ markDone: null, held: null });
  });

  it("anything else isn't a course's, and says nothing of it: a filed workout, a programme's slot", async () => {
    const p = await seedCourse();
    expect((await read(await filed(p, MON))).course).toBeUndefined();
    await db.insert(programs).values({
      id: "ad-1", userId, kind: "adaptive", name: "Program", status: "active", disciplines: ["strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: {}, onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    expect((await read(await outline("ad-1", addDays(MON, -1)))).course).toBeUndefined();
  });
});

describe("within a request's budget, on a realistic account", () => {
  /** Mark and undo at each distance back: the replay costs most when its day is furthest from the garden's last checkpoint. */
  async function sweep(): Promise<number[]> {
    const account = await seedRealisticAccount(db);
    userId = account.userId;
    prefs = await loadPreferences(db, userId);
    await advanceGarden(db, userId, prefs, new Date(), { maxResimDays: 200, maxWalkDays: 200 });
    const today = todayInZone(prefs.timezone);
    const env = { ...makeRealisticEnv(), WATCH_PUSH_ENABLED: "1" } as Env;
    const p = await seedCourse();
    const cookie = await cookieFor();
    const costs: number[] = [];
    for (let back = 0; back <= 7; back += 1) {
      const date = addDays(today, -back);
      const id = await outline(p, date, back > 1 ? "unresolved" : "scheduled", { id: `row-${back}` });
      for (const done of [true, false]) {
        const run = cloneTestDb(db, { boundVariableCap: 100, onStatement: () => (costs[costs.length - 1]! += 1) });
        if (!done) sqliteOf(run).prepare(`update planned_workouts set completion_state = 'completed', sanctioned_by = 'athlete_said_done', course_session = 1, resolution_date = ? where id = ?`).run(date, id);
        costs.push(0);
        const res = await mountRoutes(run, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}/mark-done`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ done }) }, env);
        expect(res.status, `${back} back, done ${String(done)}`).toBe(200);
      }
    }
    return costs;
  }

  it("on a Monday, a mark and an undo at every distance back", { timeout: 120_000 }, async () => {
    const costs = await sweep();
    console.log(`mark-done, Monday, mark and undo at 0..7 days back: ${costs.join(", ")}`);
    expect(Math.max(...costs), costs.join(",")).toBeLessThanOrEqual(45);
    // Two of the garden's days fit, and three don't: measured 52.
    expect(MARK_DONE_REPLAY_MAX_DAYS).toBe(2);
  });

  it("an undo on a stopped plan's own day, an outline and a written session", { timeout: 120_000 }, async () => {
    const account = await seedRealisticAccount(db);
    userId = account.userId;
    prefs = await loadPreferences(db, userId);
    await advanceGarden(db, userId, prefs, new Date(), { maxResimDays: 200, maxWalkDays: 200 });
    const env = { ...makeRealisticEnv(), WATCH_PUSH_ENABLED: "1" } as Env;
    const today = todayInZone(prefs.timezone);
    const p = await seedCourse({}, { status: "retired" });
    const marked = { ...asDone, courseSession: 1, resolutionDate: today };
    const ids = [await outline(p, today, "completed", { ...marked, id: "stopped-outline" }), await written(p, today, 1, "completed", marked)];
    const cookie = await cookieFor();
    const costs: number[] = [];
    for (const id of ids) {
      let spent = 0;
      const run = cloneTestDb(db, { boundVariableCap: 100, onStatement: () => (spent += 1) });
      const res = await mountRoutes(run, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}/mark-done`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ done: false }) }, env);
      expect(res.status).toBe(200);
      costs.push(spent);
    }
    console.log(`mark-done, undo on a stopped plan's own day (outline, written): ${costs.join(", ")}`);
    expect(Math.max(...costs), costs.join(",")).toBeLessThanOrEqual(45);
  });

  it("on a Sunday, when the last checkpoint is furthest", { timeout: 120_000 }, async () => {
    vi.setSystemTime(new Date("2026-10-11T19:00:00.000Z"));
    const costs = await sweep();
    console.log(`mark-done, Sunday, mark and undo at 0..7 days back: ${costs.join(", ")}`);
    expect(Math.max(...costs), costs.join(",")).toBeLessThanOrEqual(45);
  });
});

describe("what it costs of its own, by equality", () => {
  it("a refusal or a retry: the session, the middleware's look for a restore, the preferences and the read", async () => {
    const p = await seedCourse();
    const skipped = await outline(p, MON, "skipped", { resolutionDate: MON });
    expect((await mark(skipped, true)).spent).toBe(4);
    const open = await outline(p, addDays(MON, -1));
    expect((await mark(open, false)).spent).toBe(4);
  });

  it("the write's guard refusing it: one write and the read again", async () => {
    const p = await seedCourse();
    const id = await outline(p, MON);
    const { markSessionDone } = await import("../src/services/mark-done.js");
    let spent = 0;
    let landed = false;
    const racing = cloneTestDb(db, {
      onStatement: (s) => {
        spent += 1;
        if (landed || !isWrite(s)) return;
        landed = true;
        spent -= 1; // Its own statement, below, isn't the request's.
        sqliteOf(racing).prepare(`update planned_workouts set content_state = 'started' where id = ?`).run(id);
      },
    });
    await markSessionDone(racing, userId, id, true, { today: MON, now: NOW, prefs });
    expect(spent).toBe(3);
  });

  describe("the service's own statements", () => {
    const counted = async (id: string, done: boolean) => {
      const { markSessionDone } = await import("../src/services/mark-done.js");
      let spent = 0;
      const clone = cloneTestDb(db, { onStatement: () => (spent += 1) });
      const out = await markSessionDone(clone, userId, id, done, { today: MON, now: NOW, prefs });
      expect(out).toMatchObject({ ok: true });
      return spent;
    };
    const asMarked = (date: string) => ({ ...asDone, courseSession: 1, resolutionDate: date });

    it("a mark: the read and the write", async () => {
      const p = await seedCourse();
      expect(await counted(await outline(p, MON), true)).toBe(2);
    });

    it("an undo of a day gone: the read and the write", async () => {
      const p = await seedCourse({}, { status: "retired" });
      const date = addDays(MON, -2);
      expect(await counted(await outline(p, date, "completed", asMarked(date)), false)).toBe(2);
    });

    it("an undo of today's outline: the read, the marker's write and the row's, whether the plan runs or not", async () => {
      const running = await seedCourse();
      expect(await counted(await outline(running, MON, "completed", asMarked(MON)), false)).toBe(3);
      const stopped = await seedCourse({}, { status: "retired" });
      expect(await counted(await outline(stopped, MON, "completed", asMarked(MON)), false)).toBe(3);
    });

    it("an undo of today's written session: the owed mark's write as well", async () => {
      const running = await seedCourse();
      expect(await counted(await written(running, MON, 1, "completed", asMarked(MON)), false)).toBe(4);
      const stopped = await seedCourse({}, { status: "retired" });
      expect(await counted(await written(stopped, MON, 1, "completed", asMarked(MON)), false)).toBe(4);
    });
  });
});

describe("a refusal says what's true", () => {
  it("a session already saved isn't under way", async () => {
    const p = await seedCourse();
    const done = await written(p, MON, 1, "scheduled", { contentState: "done" });
    const res = await mark(done, true);
    expect(res.body.error).toBe("saved");
    expect(res.body.why).toBe("It's been played and saved, so it stays as it is.");
  });

  it("one started is", async () => {
    const p = await seedCourse();
    const res = await mark(await written(p, MON, 1, "scheduled", { contentState: "started" }), true);
    expect(res.body.error).toBe("under_way");
    expect(res.body.why).toBe("It's under way. Finish it or discard it first.");
  });

  it("saved beats started: a save is the later word", async () => {
    const p = await seedCourse();
    const id = await outline(p, MON, "scheduled", { contentState: "started" });
    await db.insert(performedSessions).values({ id: newId(), userId, workoutId: id, source: "app", localDate: MON, movesDone: [], payloadHash: "h", createdAt: NOW, updatedAt: NOW });
    expect((await mark(id, true)).body.error).toBe("saved");
  });
});
