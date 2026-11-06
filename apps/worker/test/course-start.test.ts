/**
 * STARTING AND STOPPING A COURSE (plans with a purpose, spec §4.2, rulings R28 and R29). A start makes the one plan a course
 * has, or revives it, takes in the sessions planned before courses existed, and places what's ahead. A stop ends it: every
 * session today or ahead comes off, its own or filed under it, unless it has started, and what's behind stays.
 *
 * Everything runs on a made-up course (`course-fixture.ts`): worker code reads only the definition. Fixed dates under a
 * faked `Date`, so nothing here goes stale. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ begin: null as null | (() => Promise<void>) }));
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

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, courseConfigSchema, newId, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { hourly } from "../src/index.js";
import { COURSE_START_FIXED, planRoutes, PLAN_STOP_FIXED } from "../src/routes/plans.js";
import { coachRoutes } from "../src/routes/coach.js";
import { programRoutes } from "../src/routes/programs.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { stopBlocks } from "../src/routes/thread-structural.js";
import { STRUCTURAL_MIN_BUDGET } from "../src/services/coach-apply.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { finishCoursesPartWay, startCourse, stopCourse } from "../src/services/course-plans.js";
import { COURSE_FINISH_BUDGET, COURSE_FINISHES_PER_PASS } from "../src/services/cron-limits.js";
import { writeCourseSessionsDue } from "../src/services/course-sessions.js";
import type { Db } from "../src/services/db.js";
import { createDocWorkout, reviseDocWorkout, studioProgramId } from "../src/services/doc-workouts.js";
import { applyMove } from "../src/services/jobs.js";
import { queueProvisionalPush } from "../src/services/mirror.js";
import { mirrorIntentId } from "../src/services/mirror-owed.js";
import { applyPlanPatch } from "../src/services/plan-registry.js";
import { courseSessionsDone, placeSlots, placeSlotsForAllPrograms, placeSlotsWithin, RETRACT_COST, RETRACT_WRITTEN_COST, REVIVE_COST, RUNNING_PASS_MIN, slotId, STOPPED_PASS_MIN } from "../src/services/program-slots.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { connectMock, seedCatalog, switchOn } from "./watch-push-fixture.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeRealisticEnv, seedRealisticAccount } from "./realistic-account.js";

const { accountState, calendarEventSuppressions, coachMessages, coachPlans, corosWriteJobs, performedSessions, plannedWorkouts, programs, programVersions, scheduleOverrides, sessionBuilds, syncIntents, workoutDocRevisions } = schema;

/** A Monday. */
const MON = "2026-10-05";
/** Monday noon in Los Angeles, the test user's zone. */
const NOW = "2026-10-05T19:00:00.000Z";
const AT = new Date(NOW);
/** `weekday` 0 = Monday … 6 = Sunday (the config's numbering), `week` weeks after MON's. */
const day = (week: number, weekday: number): string => addDays(MON, 7 * week + weekday);
const COURSE = INTRO_COURSE.id;
const BODY = { course: COURSE, weekdays: [0, 4], time: "19:30" };

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let statements: string[];
/** What each read of the sessions a course's plan might take in handed back. */
let refRows: number[];
/** Something landing just before a statement matching `at` runs: between what a request read and what it writes. */
let landing: { at: RegExp; then: () => void } | null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT);
  statements = [];
  refRows = [];
  landing = null;
  race.begin = null;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (s) => {
      statements.push(s);
      if (landing?.at.test(s)) {
        const { then } = landing;
        landing = null;
        then();
      }
    },
    onRows: (s, n) => {
      if (s.includes("$.source.ref") && s.startsWith("select")) refRows.push(n);
    },
  });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ENV = { APP_URL: "https://app.test", FIXTURE_MODE: "0", WATCH_PUSH_ENABLED: "1" } as Env;
const ctx = () => ({ today: MON, now: NOW, prefs });
const writes = () => statements.filter(isWrite);
/** The read `removeDocWorkout` starts with, the one `removeFromPlan` archives with, and what a start moves a session with. */
const REMOVAL_READ = /^select "id", "origin", "content_state", "completion_state", "archived_at" from "planned_workouts"/;
const ARCHIVE = /^update "planned_workouts" set "archived_at"/;
const MOVE = /^update "planned_workouts" set "plan_id"/;
/** Change a row now, inside a statement's hook, where nothing can be awaited. */
const setRow = (id: string, set: Partial<typeof plannedWorkouts.$inferInsert>) => (db.update(plannedWorkouts).set(set).where(eq(plannedWorkouts.id, id)) as unknown as { run(): void }).run();
const removeByHand = (id: string) => setRow(id, { archivedAt: NOW, archiveReason: "user_removed" });

/** One request, with everything it spends counted, its waitUntil work included: the way programs-budget.test.ts counts. */
async function send(method: string, path: string, body?: unknown, env: Env = ENV, as = cookie) {
  const app = mountRoutes(db, "/api/plans", planRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (w: Promise<unknown>) => pending.push(w), passThroughOnException: () => undefined, props: {} };
  statements.length = 0;
  let fetches = 0;
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  const res = await app.request(path, { method, headers: { Cookie: as, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env, executionCtx as never);
  await Promise.all(pending);
  return { status: res.status, body: (await res.json()) as Record<string, any>, total: statements.length + fetches };
}

const start = (body: unknown = BODY, env?: Env) => send("POST", "/api/plans/courses", body, env);
const stop = (id: string, env?: Env) => send("POST", `/api/plans/${id}/stop`, undefined, env);

/** Send it until nothing is left; each request's cost, and how many it took. */
async function until(request: () => ReturnType<typeof send>, most = 40) {
  const costs: number[] = [];
  for (let i = 0; i < most; i++) {
    const res = await request();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    costs.push(res.total);
    if (!res.body.more) return { costs, last: res.body };
  }
  throw new Error(`still "more" after ${most} requests`);
}

/** Send it until there's nothing a resend can do: `waiting`, or nothing left. */
async function untilWaiting(request: () => ReturnType<typeof send>, most = 40) {
  for (let i = 0; i < most; i++) {
    const res = await request();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (!res.body.more || res.body.waiting) return { last: res.body };
  }
  throw new Error(`still "more" after ${most} requests`);
}

/** Started to the end: the plan's id. */
async function started(body: unknown = BODY): Promise<string> {
  const { last } = await until(() => start(body));
  return last.plan.id as string;
}

const row = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const rowsOf = (planId: string) => db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, planId));
const liveOf = async (planId: string) => (await rowsOf(planId)).filter((r) => r.archivedAt === null);
const coursePlans = (owner = userId) => db.select().from(programs).where(and(eq(programs.userId, owner), eq(programs.kind, "course")));
const planOf = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!;
const revisionsOf = (id: string) => db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id));
const suppressionsOf = (id: string) => db.select().from(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, id));
const mirrorMark = async (id: string) => (await db.select().from(syncIntents).where(eq(syncIntents.id, mirrorIntentId(id))))[0];
const jobsOf = (id: string) => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id));
const listed = async () => (await send("GET", "/api/plans")).body.plans as Array<Record<string, any>>;

/** The session's document: the course's own, or as it was revised. */
const docOfSession = (n: number): WorkoutDoc => INTRO_COURSE.sessionDoc(n, { ease: false });

/** A session planned before courses existed, as the Studio writes one: today or ahead, through the real path. */
async function planned(date: string, n: number): Promise<string> {
  const { workout } = await createDocWorkout(db, userId, { date, time: "07:00", doc: docOfSession(n) }, ctx());
  return workout.id;
}

/** The same, in any state and on any day: stored directly, a past one's write being gone. */
async function earlier(date: string, n: number, completionState: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<string> {
  const id = over.id ?? newId();
  await db.insert(plannedWorkouts).values({
    id, userId, planId: studioProgramId(userId), sourceWorkoutId: id, title: `Intro ${n}`, category: "yoga", sport: "yoga", originalPlanDate: date, lastVerifiedCorosDate: "",
    effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900,
    origin: "studio", contentState: "outline", completionState, createdAt: NOW, updatedAt: NOW, workoutDoc: JSON.stringify(docOfSession(n)), workoutDocRev: 1,
    ...over,
  });
  return id;
}

/** A workout filed under a plan by the coach: a document workout with no number. */
const filed = (planId: string, date: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}) =>
  earlier(date, 1, "scheduled", { planId, title: "Extra", workoutDoc: JSON.stringify({ ...docOfSession(1), source: { kind: "coach" } }), ...over });

/** A session of the course written as `n`, on the plan. */
const ownSession = (planId: string, date: string, n: number, completionState: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}) =>
  earlier(date, n, completionState, { planId, courseSession: n, ...over });

const beginRestore = async () => {
  await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });
};

/** A session saved against the row, whatever its state says. */
const saveSession = (workoutId: string, localDate: string) =>
  db.insert(performedSessions).values({ id: newId(), userId, workoutId, source: "app", localDate, movesDone: [], payloadHash: "h", createdAt: NOW, updatedAt: NOW });

/** What a course's rows come to, whatever the requests it took: everything a run must end on the same. */
async function finalState() {
  const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
  const state = await Promise.all(
    rows.map(async (r) => ({
      id: r.id.startsWith("slot-") ? `slot-${r.originalPlanDate}` : `${r.title} ${r.originalPlanDate}`,
      plan: r.planId === studioProgramId(userId) ? "studio" : "course",
      n: r.courseSession,
      date: r.effectiveDate,
      time: r.effectiveTime,
      origin: r.origin,
      completion: r.completionState,
      content: r.contentState,
      rev: r.workoutDocRev,
      archived: r.archivedAt !== null,
      reason: r.archiveReason,
      suppressions: (await suppressionsOf(r.id)).length,
    })),
  );
  return state.sort((a, b) => a.id.localeCompare(b.id));
}

describe("POST /api/plans/courses: a new plan", () => {
  it("makes the plan from the definition, with the days and the time asked for", async () => {
    const res = await start();
    expect(res.status).toBe(200);
    const [plan] = await coursePlans();
    expect(plan).toMatchObject({
      name: INTRO_COURSE.name,
      purpose: INTRO_COURSE.purpose,
      brief: INTRO_COURSE.brief,
      disciplines: [...INTRO_COURSE.disciplines],
      kind: "course",
      status: "active",
      onEnd: "continue",
      pausedUntil: null,
    });
    expect(courseConfigSchema.parse(plan!.config)).toEqual({ course: COURSE, weekdays: [0, 4], time: "19:30", quietDaysBeforeRace: 7, placementWeeksAhead: 2, easeNext: false });
    expect(res.body.plan).toMatchObject({ id: plan!.id, kind: "course", status: "active", course: { session: 1, of: 4 }, onEnd: "continue" });
  });

  it("places what's ahead, on those days at that time, to more: false", async () => {
    const id = await started();
    const live = await liveOf(id);
    // Today's window hasn't gone (noon, and the course's time is 19:30), and two weeks ahead of this one.
    expect(live.map((r) => r.effectiveDate).sort()).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 4)].sort());
    expect(new Set(live.map((r) => r.effectiveTime))).toEqual(new Set(["19:30"]));
    expect(live.every((r) => r.origin === "program" && r.workoutDoc === null)).toBe(true);
  });

  it("a retry makes no second plan, and writes nothing", async () => {
    const id = await started();
    const res = await start();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ more: false, plan: { id } });
    expect(writes()).toEqual([]);
    expect(await coursePlans()).toHaveLength(1);
  });

  it.each([
    ["fewer days", { weekdays: [2] }],
    ["as many other days", { weekdays: [1, 3] }],
    ["one day more", { weekdays: [0, 4, 6] }],
    ["another time", { time: "06:00" }],
  ])("a start naming %s on a running course is refused, and nothing changes: a silent success would be false", async (_, change) => {
    const id = await started();
    const res = await start({ ...BODY, ...change });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "course_running",
      why: "This course is already running on other days or at another time. Stop it and start it again with the new ones: it carries on from the sessions done.",
    });
    expect(writes()).toEqual([]);
    expect(courseConfigSchema.parse((await planOf(id)).config)).toMatchObject({ weekdays: [0, 4], time: "19:30" });
    expect(await coursePlans()).toHaveLength(1);
  });

  it("what the words say is so: stop it, start it with the new days, and it carries on from the sessions done", async () => {
    const id = await started();
    await ownSession(id, day(-1, 0), 1, "completed");
    expect((await start({ ...BODY, weekdays: [1, 3] })).status).toBe(409);
    await until(() => stop(id));
    const { last } = await until(() => start({ ...BODY, weekdays: [1, 3] }));
    expect(last.plan).toMatchObject({ id, course: { session: 2, of: 4 } });
    expect(courseConfigSchema.parse((await planOf(id)).config).weekdays).toEqual([1, 3]);
  });

  it("a retry with the same days stays 200, whatever order it names them in", async () => {
    const id = await started();
    expect((await start()).status).toBe(200);
    const res = await start({ ...BODY, weekdays: [4, 0] });
    expect(res.status).toBe(200);
    expect(res.body.plan.id).toBe(id);
  });

  it("other days are refused part way through a start too", async () => {
    await planned(day(0, 1), 1);
    await planned(day(0, 2), 2);
    expect((await start()).body.more).toBe(true);
    expect((await start({ ...BODY, weekdays: [3] })).status).toBe(409);
  });

  it("takes no client's key: a start is idempotent per course, and nothing would read one", async () => {
    expect((await start({ ...BODY, clientId: "tap-1" })).status).toBe(422);
  });

  it("another course's plan isn't this one's: it stays stopped, and this course gets its own", async () => {
    await db.insert(programs).values({ id: "another-course", userId, kind: "course", name: "Another", status: "retired", disciplines: ["yoga"], config: courseConfigSchema.parse({ ...BODY, course: "an-old-course" }), createdAt: NOW, updatedAt: NOW });
    expect(await started()).not.toBe("another-course");
    expect((await planOf("another-course")).status).toBe("retired");
    expect(await coursePlans()).toHaveLength(2);
  });

  it("only a course's plan is the course's: another kind that happens to name it in its settings isn't taken", async () => {
    await db.insert(programs).values({ id: "other-kind", userId, kind: "coach", name: "Coach", status: "retired", disciplines: [], config: { course: COURSE }, createdAt: NOW, updatedAt: NOW });
    expect(await started()).not.toBe("other-kind");
    expect((await planOf("other-kind")).status).toBe("retired");
  });

  it("two racing first starts make one row: its id is the account's and the course's", async () => {
    const [a, b] = await Promise.all([startCourse(db, userId, BODY, ctx(), 40), startCourse(db, userId, BODY, ctx(), 40)]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(await coursePlans()).toHaveLength(1);
  });

  it("one account's course isn't another's", async () => {
    const mine = await started();
    const other = await makeTestUser(db);
    const theirs = await startCourse(db, other.userId, BODY, { ...ctx(), prefs: other.prefs }, 40);
    expect(theirs).toMatchObject({ ok: true });
    expect(theirs.ok && theirs.planId).not.toBe(mine);
    expect(await coursePlans(other.userId)).toHaveLength(1);
    expect(await coursePlans()).toHaveLength(1);
  });

  it.each([["an unknown id", "no-such-course"], ["a name every object has", "constructor"]])("%s is 422, and nothing is written", async (_, course) => {
    const res = await start({ ...BODY, course });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: "invalid_plan", issues: [{ path: ["course"] }] });
    expect(writes()).toEqual([]);
    expect(await coursePlans()).toEqual([]);
  });

  it.each([
    ["no days", { weekdays: [] }],
    ["a day past Sunday", { weekdays: [7] }],
    ["a day twice", { weekdays: [1, 1] }],
    ["half a day", { weekdays: [1.5] }],
    ["no time", { time: undefined }],
    ["a time that isn't one", { time: "25:00" }],
    ["a time without its zero", { time: "7:30" }],
    ["a field that isn't asked for", { easeNext: true }],
  ])("%s is 422, and nothing is written", async (_, change) => {
    const res = await start({ ...BODY, ...change });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_plan");
    expect(writes()).toEqual([]);
    expect(await coursePlans()).toEqual([]);
  });

  it("a body that isn't one is 422", async () => {
    expect((await start(null)).status).toBe(422);
  });

  it("holds no limit on sessions a week, since a definition holds none: seven days is allowed", async () => {
    expect(Object.keys(INTRO_COURSE)).not.toContain("maxPerWeek");
    expect((await start({ ...BODY, weekdays: [0, 1, 2, 3, 4, 5, 6] })).status).toBe(200);
  });

  it("a restore in progress is 423, and nothing is written", async () => {
    await beginRestore();
    const res = await start();
    expect(res.status).toBe(423);
    expect(res.body).toEqual({ error: "restore_in_progress" });
    expect(await coursePlans()).toEqual([]);
  });

  it("a restore beginning just after the request's own look is 423 too", async () => {
    race.begin = beginRestore;
    const res = await start();
    expect(res.status).toBe(423);
    expect(await coursePlans()).toEqual([]);
  });

  it("a restore beginning as a row ahead comes off: 423, and that row stays", async () => {
    const ahead = await planned(day(0, 1), 1);
    // The middleware's look, the service's, then the removal's own finds it.
    race.begin = async () => {
      race.begin = beginRestore;
    };
    const res = await start();
    expect(res.status).toBe(423);
    expect((await row(ahead)).archivedAt).toBeNull();
  });

  it("is unauthenticated without a session", async () => {
    expect((await send("POST", "/api/plans/courses", BODY, ENV, "")).status).toBe(401);
  });
});

describe("starting from sessions already planned", () => {
  it("done: moves to the plan with its number and its document, no new revision, counted toward n", async () => {
    const one = await earlier(day(-1, 0), 1, "completed");
    const two = await earlier(day(-1, 2), 2, "completed", { contentState: "done" });
    const before = await row(one);
    const id = await started();
    expect(await row(one)).toMatchObject({ planId: id, courseSession: 1, workoutDoc: before.workoutDoc, workoutDocRev: 1, origin: "studio", completionState: "completed", archivedAt: null });
    expect(await row(two)).toMatchObject({ planId: id, courseSession: 2, workoutDocRev: 1 });
    expect(await revisionsOf(one)).toEqual([]);
    expect(await courseSessionsDone(db, userId, id)).toBe(2);
    expect((await start()).body.plan.course).toEqual({ session: 3, of: 4 });
  });

  it("the number comes from the ref, not the order: a session done twice counts twice and a late one keeps its own", async () => {
    const a = await earlier(day(-2, 0), 3, "completed");
    const b = await earlier(day(-1, 0), 3, "completed");
    const id = await started();
    expect((await row(a)).courseSession).toBe(3);
    expect((await row(b)).courseSession).toBe(3);
    expect(await courseSessionsDone(db, userId, id)).toBe(2);
  });

  it("a row done or under way queues nothing for the watch and owes it nothing", async () => {
    const done = await earlier(day(-1, 0), 1, "completed");
    const today = await earlier(MON, 2, "scheduled", { contentState: "started" });
    await started();
    expect(await jobsOf(done)).toEqual([]);
    expect(await jobsOf(today)).toEqual([]);
    expect(await mirrorMark(done)).toBeUndefined();
    expect(await mirrorMark(today)).toBeUndefined();
  });

  it("started today: under way, so it moves with its number, stays as it was, and isn't a session done until it is", async () => {
    const id0 = await earlier(MON, 2, "scheduled", { contentState: "started" });
    const id = await started();
    expect(await row(id0)).toMatchObject({ planId: id, courseSession: 2, contentState: "started", completionState: "scheduled", archivedAt: null });
    expect(await courseSessionsDone(db, userId, id)).toBe(0);
    // It holds its day: no outline beside it.
    expect(await row(slotId(id, MON)).catch(() => undefined)).toBeUndefined();
  });

  it("saved but not yet resolved (a performed session on a scheduled row): under way, not ahead", async () => {
    const saved = await earlier(day(0, 1), 1, "scheduled");
    await saveSession(saved, day(0, 1));
    const id = await started();
    expect(await row(saved)).toMatchObject({ planId: id, courseSession: 1, archivedAt: null });
  });

  it("ahead: comes off through the document removal path, for the day it held", async () => {
    const ahead = await planned(day(0, 1), 3);
    const id = await started();
    expect(await row(ahead)).toMatchObject({ archiveReason: "program_replaced", planId: studioProgramId(userId), courseSession: null });
    expect((await row(ahead)).archivedAt).not.toBeNull();
    expect((await suppressionsOf(ahead)).map((s) => s.reason)).toEqual(["user_removed"]);
    expect((await liveOf(id)).some((r) => r.id === ahead)).toBe(false);
  });

  it("today's, not started, is ahead", async () => {
    const today = await planned(MON, 1);
    const id = await started();
    expect((await row(today)).archivedAt).not.toBeNull();
    // The course's own outline takes the day, at its own time.
    expect(await row(slotId(id, MON))).toMatchObject({ archivedAt: null, effectiveTime: "19:30", origin: "program" });
  });

  it("today's built and not started is ahead too: only started is under way", async () => {
    const today = await earlier(MON, 1, "scheduled", { contentState: "built" });
    await started();
    expect((await row(today)).archivedAt).not.toBeNull();
  });

  it("one that's already been moved comes off too: a move is no edit to the session", async () => {
    const ahead = await planned(day(0, 1), 2);
    await applyMove(db, { userId, workoutId: ahead, toDate: day(0, 2), toTime: "08:00", source: "app", corosWritesEnabled: false });
    await started();
    expect((await row(ahead)).archivedAt).not.toBeNull();
  });

  it("revised ahead: stays with the athlete's edit, filed under the plan with its number, no new revision", async () => {
    const edited = await planned(day(0, 4), 2);
    const { rev } = await reviseDocWorkout(db, userId, edited, { doc: { ...docOfSession(2), title: "Mine now" }, baseRev: 1 }, ctx());
    expect(rev).toBe(2);
    const before = await row(edited);
    const revisions = (await revisionsOf(edited)).length;
    const id = await started();
    expect(await row(edited)).toMatchObject({ planId: id, courseSession: 2, workoutDocRev: 2, workoutDoc: before.workoutDoc, title: "Mine now", archivedAt: null });
    expect(await revisionsOf(edited)).toHaveLength(revisions);
    // It holds its day and counts toward its week: Friday takes no outline beside it.
    expect((await liveOf(id)).filter((r) => r.effectiveDate === day(0, 4)).map((r) => r.id)).toEqual([edited]);
  });

  it("a revision whose ref has gone isn't a session of the course any more: it stays where it was", async () => {
    const mine = await planned(day(0, 1), 2);
    await reviseDocWorkout(db, userId, mine, { doc: { ...docOfSession(2), title: "Something else", source: { kind: "studio" } }, baseRev: 1 }, ctx());
    await started();
    expect(await row(mine)).toMatchObject({ planId: studioProgramId(userId), courseSession: null, archivedAt: null });
  });

  it("skipped ahead: the athlete's say about that day stands, so it moves and holds it, and isn't done", async () => {
    const skipped = await earlier(day(0, 4), 2, "skipped");
    const id = await started();
    expect(await row(skipped)).toMatchObject({ planId: id, courseSession: 2, completionState: "skipped", archivedAt: null });
    expect((await liveOf(id)).filter((r) => r.effectiveDate === day(0, 4)).map((r) => r.id)).toEqual([skipped]);
    expect(await courseSessionsDone(db, userId, id)).toBe(0);
  });

  it("behind, whatever its state, joins the plan with its number, and only a session done counts", async () => {
    const missed = await earlier(day(-1, 0), 1, "missed");
    const skipped = await earlier(day(-1, 1), 2, "skipped");
    const open = await earlier(day(-1, 2), 3, "scheduled");
    const unresolved = await earlier(day(-1, 3), 4, "unresolved");
    const id = await started();
    expect(await row(missed)).toMatchObject({ planId: id, courseSession: 1, completionState: "missed", archivedAt: null, workoutDocRev: 1 });
    expect(await row(skipped)).toMatchObject({ planId: id, courseSession: 2, completionState: "skipped" });
    expect(await row(open)).toMatchObject({ planId: id, courseSession: 3, completionState: "scheduled" });
    expect(await row(unresolved)).toMatchObject({ planId: id, courseSession: 4, completionState: "unresolved" });
    expect(await courseSessionsDone(db, userId, id)).toBe(0);
    for (const r of [missed, skipped, open, unresolved]) {
      expect(await revisionsOf(r)).toEqual([]);
      expect(await jobsOf(r)).toEqual([]);
      expect(await mirrorMark(r)).toBeUndefined();
    }
  });

  it("one behind and unresolved at the start, finished afterwards, counts: that session doesn't repeat", async () => {
    const later = await earlier(day(-1, 3), 1, "unresolved");
    const id = await started();
    expect((await start()).body.plan.course).toEqual({ session: 1, of: 4 });
    await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, later));
    expect(await courseSessionsDone(db, userId, id)).toBe(1);
    expect((await listed()).find((p) => p.id === id)!.course).toEqual({ session: 2, of: 4 });
  });

  it.each([
    ["another course's", "other-course:1"],
    ["a near miss in front", "not-intro-course:1"],
    ["a near miss behind", "intro-courses:1"],
    ["another case", "INTRO-course:1"],
    ["no number", "intro-course:"],
    ["session 0", "intro-course:0"],
    ["a number with more after it", "intro-course:1x"],
    ["no ref's shape at all", "quick_start:hip_opener"],
  ])("a ref that doesn't match is left alone: %s", async (_, ref) => {
    const doc = { ...docOfSession(1), source: { kind: "studio", ref } };
    const done = await earlier(day(-1, 0), 1, "completed", { workoutDoc: JSON.stringify(doc) });
    const ahead = await earlier(day(0, 1), 1, "scheduled", { workoutDoc: JSON.stringify(doc) });
    await started();
    for (const r of [done, ahead]) expect(await row(r)).toMatchObject({ planId: studioProgramId(userId), courseSession: null, archivedAt: null });
  });

  it("a document that doesn't read, or none, doesn't throw and is left alone", async () => {
    const broken = await earlier(day(0, 1), 1, "scheduled", { workoutDoc: "{not json" });
    const none = await earlier(day(0, 2), 1, "scheduled", { workoutDoc: null });
    await started();
    for (const r of [broken, none]) expect((await row(r)).archivedAt).toBeNull();
  });

  it("only document workouts: a row of another origin holding that ref isn't taken", async () => {
    const coach = await earlier(day(0, 1), 1, "scheduled", { origin: null, planId: "coach-block" });
    const coachDone = await earlier(day(-1, 1), 1, "completed", { origin: "coach", planId: "coach-block" });
    await started();
    expect(await row(coach)).toMatchObject({ planId: "coach-block", courseSession: null, archivedAt: null });
    expect(await row(coachDone)).toMatchObject({ planId: "coach-block", courseSession: null });
  });

  it("another account's sessions are never touched", async () => {
    const other = await makeTestUser(db);
    const theirs = newId();
    await earlier(day(0, 1), 1, "scheduled", { id: theirs, userId: other.userId, planId: studioProgramId(other.userId) });
    const theirsDone = await earlier(day(-1, 1), 1, "completed", { userId: other.userId, planId: studioProgramId(other.userId) });
    await started();
    // Not even read: the removal and the move would each refuse it, but this account's request has no business with it.
    expect(refRows).toEqual([0]);
    expect(await row(theirs)).toMatchObject({ archivedAt: null, courseSession: null });
    expect(await row(theirsDone)).toMatchObject({ planId: studioProgramId(other.userId), courseSession: null });
  });

  it("a removed row stays removed", async () => {
    const gone = await earlier(day(-1, 1), 1, "completed", { archivedAt: NOW, archiveReason: "user_removed" });
    const id = await started();
    expect(await row(gone)).toMatchObject({ planId: studioProgramId(userId), courseSession: null });
    expect(await courseSessionsDone(db, userId, id)).toBe(0);
  });

  it("a session the course wrote itself stays through a retry: it's the plan's already", async () => {
    const id = await started();
    const own = await ownSession(id, day(0, 2), 1, "scheduled");
    await start();
    expect((await row(own)).archivedAt).toBeNull();
  });

  it("and through a start part way, or a revival: what's already the plan's isn't what's planned from before", async () => {
    const id = await started();
    const own = await ownSession(id, day(0, 2), 1, "scheduled");
    const plan = await planOf(id);
    await db.update(programs).set({ config: { ...plan.config, finishing: "start" } }).where(eq(programs.id, id));
    await until(() => start());
    expect((await row(own)).archivedAt).toBeNull();
  });

  it("with nothing to do and the pass's room to the statement, the same send clears the marker and runs the pass", async () => {
    const res = await startCourse(db, userId, BODY, ctx(), 3 + RUNNING_PASS_MIN);
    expect(res).toMatchObject({ ok: true });
    const id = (await coursePlans())[0]!.id;
    expect((await rowsOf(id)).filter((r) => r.origin === "program").length).toBeGreaterThan(0);
  });

  it("done this week counts toward this week's days (rule 1), so the week isn't filled again", async () => {
    await earlier(MON, 1, "completed", { effectiveTime: "07:00" });
    const id = await started({ ...BODY, weekdays: [0, 4] });
    // Monday's done and counted: Friday alone is left of this week, as a full week holds two.
    const thisWeek = (await liveOf(id)).filter((r) => r.effectiveDate <= day(0, 6));
    expect(thisWeek.map((r) => r.effectiveDate).sort()).toEqual([MON, day(0, 4)]);
  });

  it("while rows ahead are left: more says so, and nothing is placed until none is", async () => {
    const ahead = await Promise.all([planned(day(0, 1), 1), planned(day(0, 2), 2), planned(day(0, 3), 3)]);
    const first = await start();
    expect(first.body.more).toBe(true);
    const id = first.body.plan.id as string;
    expect((await liveOf(id)).filter((r) => r.origin === "program")).toEqual([]);
    expect((await Promise.all(ahead.map(row))).filter((r) => r.archivedAt === null).length).toBeGreaterThan(0);
    await until(() => start());
    expect((await Promise.all(ahead.map(row))).every((r) => r.archivedAt !== null)).toBe(true);
    expect((await liveOf(id)).filter((r) => r.origin === "program").length).toBe(6);
  });

  it("a row removed by hand between the read and its removal is simply gone, and the start goes on", async () => {
    const ahead = await planned(day(0, 1), 1);
    landing = { at: REMOVAL_READ, then: () => removeByHand(ahead) };
    const res = await start();
    expect(res.status).toBe(200);
    expect(await row(ahead)).toMatchObject({ archiveReason: "user_removed" });
    expect(await suppressionsOf(ahead)).toEqual([]);
    await until(() => start());
  });

  it("a row begun between the read and its removal isn't taken: more, and the next send takes it in", async () => {
    const ahead = await planned(day(0, 1), 1);
    landing = { at: REMOVAL_READ, then: () => setRow(ahead, { contentState: "started" }) };
    const first = await start();
    expect(first.body.more).toBe(true);
    expect((await row(ahead)).archivedAt).toBeNull();
    const { last } = await until(() => start());
    expect(await row(ahead)).toMatchObject({ planId: last.plan.id, courseSession: 1, archivedAt: null });
  });

  it("a row removed by hand as it moves stays out: it isn't the plan's, and isn't counted", async () => {
    const done = await earlier(day(-1, 0), 1, "completed");
    landing = { at: MOVE, then: () => removeByHand(done) };
    const id = await started();
    expect(await row(done)).toMatchObject({ planId: studioProgramId(userId), courseSession: null });
    expect(await courseSessionsDone(db, userId, id)).toBe(0);
  });

  it("the read of what's planned hands back this course's sessions, not every document", async () => {
    await earlier(day(-1, 0), 1, "completed");
    await earlier(day(-1, 1), 1, "completed", { workoutDoc: JSON.stringify({ ...docOfSession(1), source: { kind: "studio" } }) });
    await earlier(day(-1, 2), 1, "completed", { workoutDoc: JSON.stringify({ ...docOfSession(1), source: { kind: "studio", ref: "other-course:1" } }) });
    await start();
    expect(refRows).toEqual([1]);
  });

  it("the pass runs only with room for its first step, and a second statement of moves takes from that room", async () => {
    // Its read, one statement of moves and the marker's clear are its own; the pass wants the rest.
    expect(await startCourse(db, userId, BODY, ctx(), 3 + RUNNING_PASS_MIN - 1)).toMatchObject({ ok: true, more: true });
    const id = (await coursePlans())[0]!.id;
    expect(await rowsOf(id)).toEqual([]);
    expect(await startCourse(db, userId, BODY, ctx(), RUNNING_PASS_MIN)).toMatchObject({ ok: true, more: true });
    const placed = (await rowsOf(id)).filter((r) => r.origin === "program").length;
    expect(placed).toBeGreaterThan(0);
    expect(placed).toBeLessThan(6);
  });

  it("a second statement of moves takes from the pass's room", async () => {
    for (let i = 0; i < 91; i++) await earlier(addDays(MON, -30 - i), 1, "completed");
    expect(await startCourse(db, userId, BODY, ctx(), 3 + RUNNING_PASS_MIN)).toMatchObject({ ok: true, more: true });
    const id = (await coursePlans())[0]!.id;
    expect((await rowsOf(id)).filter((r) => r.origin === "program")).toEqual([]);
    expect(courseConfigSchema.parse((await planOf(id)).config).finishing).toBeUndefined();
  });

  it("every send gets somewhere: the first row ahead comes off with no room for it", async () => {
    const ahead = await planned(day(0, 1), 1);
    expect(await startCourse(db, userId, BODY, ctx(), 1)).toMatchObject({ ok: true, more: true });
    expect((await row(ahead)).archivedAt).not.toBeNull();
  });

  it("a row ahead left for lack of room holds the pass back, whatever room is left for it", async () => {
    const first = await planned(day(0, 1), 1);
    const second = await planned(day(0, 2), 2);
    // Its read of those on the wire too, then room for one removal and for the pass, and none for the second removal.
    const res = await startCourse(db, userId, BODY, ctx(), 4 + RETRACT_WRITTEN_COST + RUNNING_PASS_MIN);
    expect(res).toMatchObject({ ok: true, more: true });
    expect((await row(first)).archivedAt).not.toBeNull();
    expect((await row(second)).archivedAt).toBeNull();
    expect((await coursePlans())[0]!.id).toBeTruthy();
    expect((await rowsOf((await coursePlans())[0]!.id)).filter((r) => r.origin === "program")).toEqual([]);
  });

  it("the read of what's on the wire comes out of the room: one statement short of the pass, it waits for the next send", async () => {
    const ahead = await planned(day(0, 1), 1);
    // Its read, one statement of moves, the clear and the wire's read; one removal; and the pass's room, less one.
    const res = await startCourse(db, userId, BODY, ctx(), 4 + RETRACT_WRITTEN_COST + RUNNING_PASS_MIN - 1);
    expect(res).toMatchObject({ ok: true, more: true });
    expect((await row(ahead)).archivedAt).not.toBeNull();
    expect((await rowsOf((await coursePlans())[0]!.id)).filter((r) => r.origin === "program")).toEqual([]);
  });

  it("with the pass's room to the statement, the same send takes the last row off and runs the pass", async () => {
    const ahead = await planned(day(0, 1), 1);
    await startCourse(db, userId, BODY, ctx(), 4 + RETRACT_WRITTEN_COST + RUNNING_PASS_MIN);
    expect((await row(ahead)).archivedAt).not.toBeNull();
    expect((await rowsOf((await coursePlans())[0]!.id)).filter((r) => r.origin === "program").length).toBeGreaterThan(0);
  });

  it("a row refused as it came off holds the pass back too, however much room there is", async () => {
    const ahead = await planned(day(0, 1), 1);
    landing = { at: REMOVAL_READ, then: () => setRow(ahead, { contentState: "started" }) };
    const res = await startCourse(db, userId, BODY, ctx(), Number.POSITIVE_INFINITY);
    expect(res).toMatchObject({ ok: true, more: true });
    expect((await rowsOf((await coursePlans())[0]!.id)).filter((r) => r.origin === "program")).toEqual([]);
  });

  it("each send takes the soonest first", async () => {
    const later = await planned(day(1, 1), 1);
    const sooner = await planned(day(0, 1), 2);
    await start();
    expect((await row(sooner)).archivedAt).not.toBeNull();
    expect((await row(later)).archivedAt).toBeNull();
  });

  it("every send gets somewhere, and the count of what's left only falls", async () => {
    const ahead = await Promise.all([1, 2, 3, 4, 5].map((n, i) => planned(day(0, i), n)));
    const left: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await start();
      left.push((await Promise.all(ahead.map(row))).filter((r) => r.archivedAt === null).length);
      if (!res.body.more) break;
    }
    expect(left.at(-1)).toBe(0);
    for (let i = 1; i < left.length; i++) expect(left[i]!).toBeLessThanOrEqual(left[i - 1]!);
    expect(new Set(left).size).toBeGreaterThan(2);
  });

  it("a run to more: false ends just where one request with all the room would have", async () => {
    const seed = async () => {
      await earlier(day(-1, 0), 1, "completed");
      await earlier(day(-1, 2), 2, "completed");
      await earlier(MON, 3, "scheduled", { contentState: "started", effectiveTime: "06:00" });
      await earlier(day(-1, 3), 1, "missed");
      await planned(day(0, 1), 3);
      await planned(day(0, 2), 4);
      await planned(day(1, 0), 5);
      const edited = await planned(day(1, 4), 6);
      await reviseDocWorkout(db, userId, edited, { doc: { ...docOfSession(6), title: "Mine now" }, baseRev: 1 }, ctx());
    };
    await seed();
    const { costs } = await until(() => start());
    expect(costs.length).toBeGreaterThan(1);
    const byRequests = await finalState();

    db = makeTestDb({ boundVariableCap: 100 });
    ({ userId, prefs } = await makeTestUser(db));
    await seed();
    const whole = await startCourse(db, userId, BODY, ctx(), Number.POSITIVE_INFINITY);
    expect(whole).toMatchObject({ ok: true, more: false });
    expect(await finalState()).toEqual(byRequests);
  });

  it("a request that dies part way, between taking in what's done and the rows ahead: the next send finishes the same", async () => {
    await earlier(day(-1, 0), 1, "completed");
    const ahead = await planned(day(0, 1), 2);
    const real = db.select.bind(db);
    let armed = true;
    // The removal's first read of the row dies once.
    vi.spyOn(db, "select").mockImplementation(((fields?: Record<string, unknown>) => {
      if (armed && fields && "archivedAt" in fields && "contentState" in fields && "completionState" in fields && Object.keys(fields).length === 5) {
        armed = false;
        throw new Error("the invocation died");
      }
      return fields ? real(fields as never) : real();
    }) as never);
    const app = mountRoutes(db, "/api/plans", planRoutes);
    const dead = await app.request("/api/plans/courses", { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(BODY) }, ENV);
    expect(dead.status).toBe(500);
    expect(armed).toBe(false);
    const id = (await coursePlans())[0]!.id;
    expect((await row(ahead)).archivedAt).toBeNull();
    expect(await courseSessionsDone(db, userId, id)).toBe(1);
    vi.restoreAllMocks();
    await until(() => start());
    expect((await row(ahead)).archivedAt).not.toBeNull();
    expect(await courseSessionsDone(db, userId, id)).toBe(1);
    expect(await coursePlans()).toHaveLength(1);
  });
});

describe("the watch", () => {
  let server: MockCorosServer;

  /** The account with its writes on and the watch connected. */
  const connected = async () => {
    ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    await seedCatalog(db);
    server = mockCorosServer({ baseMonday: "2026-10-12" });
    await connectMock(db, userId, server);
  };

  /** Its copy pushed, and verified on the watch. The job's id is the record's. */
  const onTheWatch = async (id: string): Promise<string> => {
    expect(await queueProvisionalPush(db, switchOn(), userId, await row(id), ctx())).toBe("queued");
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [record] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, id));
    const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${record!.id}`));
    expect(push!.status).toBe("verified");
    return record!.id;
  };
  const job = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];

  it("a start takes a copy ahead off: its delete is queued", async () => {
    await connected();
    const ahead = await planned(MON, 1);
    const recordId = await onTheWatch(ahead);
    await until(() => start());
    expect((await row(ahead)).archivedAt).not.toBeNull();
    expect(await job(`unpush:${recordId}`)).toMatchObject({ status: "queued", kind: expect.stringContaining("delete") });
  });

  it("a start leaves a done row's copy alone and sends nothing new: no job, no mark, no revision", async () => {
    await connected();
    const today = await planned(MON, 1);
    const recordId = await onTheWatch(today);
    const before = (await jobsOf(today)).map((j) => [j.id, j.status]);
    await db.update(plannedWorkouts).set({ completionState: "completed", contentState: "done" }).where(eq(plannedWorkouts.id, today));
    const mark = await mirrorMark(today);
    const revisions = (await revisionsOf(today)).length;
    await until(() => start());
    expect(await row(today)).toMatchObject({ courseSession: 1, archivedAt: null });
    expect(await job(`unpush:${recordId}`)).toBeUndefined();
    expect((await jobsOf(today)).map((j) => [j.id, j.status])).toEqual(before);
    expect(await mirrorMark(today)).toEqual(mark);
    expect(await revisionsOf(today)).toHaveLength(revisions);
  });

  it("a stop takes today's written session and its copy off", async () => {
    await connected();
    const id = await started();
    const today = await planned(MON, 1);
    await db.update(plannedWorkouts).set({ planId: id, courseSession: 1 }).where(eq(plannedWorkouts.id, today));
    const recordId = await onTheWatch(today);
    await until(() => stop(id));
    expect((await row(today)).archivedAt).not.toBeNull();
    expect(await job(`unpush:${recordId}`)).toMatchObject({ status: "queued", kind: expect.stringContaining("delete") });
  });

  it("a stop takes a coach-filed session and its copy off", async () => {
    await connected();
    const id = await started();
    const extra = await planned(day(0, 1), 1);
    await db.update(plannedWorkouts).set({ planId: id }).where(eq(plannedWorkouts.id, extra));
    const recordId = await onTheWatch(extra);
    await until(() => stop(id));
    expect((await row(extra)).archivedAt).not.toBeNull();
    expect(await job(`unpush:${recordId}`)).toMatchObject({ status: "queued" });
  });

  it("a started session survives a stop, its copy with it", async () => {
    await connected();
    const id = await started();
    const today = await planned(MON, 1);
    await db.update(plannedWorkouts).set({ planId: id, courseSession: 1 }).where(eq(plannedWorkouts.id, today));
    const recordId = await onTheWatch(today);
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, today));
    await until(() => stop(id));
    expect(await row(today)).toMatchObject({ archivedAt: null, contentState: "started" });
    expect(await job(`unpush:${recordId}`)).toBeUndefined();
  });

  it.each([
    ["alone on the plan", (_: string) => [MON, day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 4)]],
    ["beside an outline the pass takes", (_: string) => [MON, day(1, 0), day(1, 4), day(2, 0), day(2, 4)]],
    ["beside an outline the pass leaves", (_: string) => [day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 4)]],
  ])("a day's build on the wire can't come off this moment, %s: more stays true, and once it has landed it goes", async (_, gone) => {
    await connected();
    const id = await started();
    await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "program_replaced" }).where(and(eq(plannedWorkouts.planId, id), inArray(plannedWorkouts.effectiveDate, gone(id))));
    const today = await planned(MON, 1);
    await db.update(plannedWorkouts).set({ planId: id, courseSession: 1 }).where(eq(plannedWorkouts.id, today));
    const recordId = await onTheWatch(today);
    const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${recordId}`));
    await db.update(corosWriteJobs).set({ status: "in_progress", payload: { ...(push!.payload as object), provisional: false } }).where(eq(corosWriteJobs.id, `push:${recordId}`));
    expect((await stop(id)).body).toEqual({ more: true, waiting: true });
    expect((await row(today)).archivedAt).toBeNull();
    await db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, `push:${recordId}`));
    expect((await until(() => stop(id))).last).toEqual({ more: false });
    expect((await row(today)).archivedAt).not.toBeNull();
  });

  /** A session of `planId`'s or the bucket's, on the watch, with its push in this status and no longer a provisional one. */
  const onTheWire = async (id: string, status: string) => {
    const recordId = await onTheWatch(id);
    const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${recordId}`));
    await db.update(corosWriteJobs).set({ status, payload: { ...(push!.payload as object), provisional: false } }).where(eq(corosWriteJobs.id, `push:${recordId}`));
    return recordId;
  };

  it.each(["claimed", "in_progress", "verifying"])("a start with a push %s: a resend can't help, so it says so, every time, and places nothing", async (status) => {
    await connected();
    const today = await planned(MON, 1);
    await onTheWire(today, status);
    for (let i = 0; i < 3; i++) {
      const res = await start();
      expect(res.body).toMatchObject({ more: true, waiting: true });
      expect((await liveOf(res.body.plan.id)).filter((r) => r.origin === "program")).toEqual([]);
    }
    expect((await row(today)).archivedAt).toBeNull();
    expect(courseConfigSchema.parse((await planOf((await coursePlans())[0]!.id)).config).finishing).toBe("start");
  });

  it.each(["claimed", "in_progress", "verifying"])("a stop with a push %s: the same, and the rest of the plan still goes", async (status) => {
    await connected();
    const id = await started();
    const today = await planned(MON, 1);
    await db.update(plannedWorkouts).set({ planId: id, courseSession: 1 }).where(eq(plannedWorkouts.id, today));
    await onTheWire(today, status);
    const { last } = await untilWaiting(() => stop(id));
    expect(last).toEqual({ more: true, waiting: true });
    expect((await liveOf(id)).map((r) => r.id)).toEqual([today]);
    expect(courseConfigSchema.parse((await planOf(id)).config).finishing).toBe("stop");
  });

  it("a failed push holds nothing: it comes off, and nobody is told to wait", async () => {
    await connected();
    const today = await planned(MON, 1);
    await onTheWire(today, "failed");
    const first = await start();
    expect(first.body.waiting).toBeUndefined();
    expect((await row(today)).archivedAt).not.toBeNull();
    const id = await started();
    const again = await planned(day(0, 1), 2);
    await db.update(plannedWorkouts).set({ planId: id, courseSession: 2 }).where(eq(plannedWorkouts.id, again));
    await onTheWire(again, "failed");
    const stopped = await stop(id);
    expect(stopped.body.waiting).toBeUndefined();
    expect((await row(again)).archivedAt).not.toBeNull();
  });

  describe("the limit counts free rows only: however many are on the wire, a free one comes off and `waiting` is honest (R38)", () => {
    /** Today's and the next days' sessions from before the course, the first `wire` of them mid-send. */
    const planted = async (wire: number, free: number) => {
      await connected();
      const rows: string[] = [];
      for (let i = 0; i < wire + free; i++) rows.push(await planned(day(0, i), i + 1));
      const records: string[] = [];
      for (const r of rows.slice(0, wire)) records.push(await onTheWire(r, "in_progress"));
      return { onWire: rows.slice(0, wire), free: rows.slice(wire), records };
    };
    const land = (records: readonly string[]) => db.update(corosWriteJobs).set({ status: "verified" }).where(inArray(corosWriteJobs.id, records.map((r) => `push:${r}`)));
    const outlinesOf = async (id: string) => (await liveOf(id)).filter((r) => r.origin === "program");

    it("two on the wire and one free: the free one comes off in the first send, and now it's waiting", async () => {
      const { onWire, free, records } = await planted(2, 1);
      const first = await start();
      expect((await row(free[0]!)).archivedAt).not.toBeNull();
      expect(first.body).toMatchObject({ more: true, waiting: true });
      for (const r of onWire) expect((await row(r)).archivedAt, r).toBeNull();
      const id = first.body.plan.id as string;
      expect(await outlinesOf(id)).toEqual([]);
      await land(records);
      const { last } = await until(() => start());
      expect(last.waiting).toBeUndefined();
      for (const r of onWire) expect((await row(r)).archivedAt, r).not.toBeNull();
      expect(courseConfigSchema.parse((await planOf(id)).config).finishing).toBeUndefined();
      expect((await outlinesOf(id)).length).toBe(6);
    });

    it("three on the wire and none free: waiting from the first send", async () => {
      const { onWire } = await planted(3, 0);
      for (let i = 0; i < 3; i++) expect((await start()).body).toMatchObject({ more: true, waiting: true });
      for (const r of onWire) expect((await row(r)).archivedAt, r).toBeNull();
    });

    it("two on the wire and two free: not waiting while a free one is left, for a resend can still do something", async () => {
      const { free } = await planted(2, 2);
      const first = await start();
      expect(first.body.more).toBe(true);
      expect(first.body.waiting).toBeUndefined();
      expect((await row(free[0]!)).archivedAt).not.toBeNull();
      expect((await row(free[1]!)).archivedAt).toBeNull();
      expect((await start()).body).toMatchObject({ more: true, waiting: true });
      expect((await row(free[1]!)).archivedAt).not.toBeNull();
    });

    it("the hourly pass takes the free one too, by the same step", async () => {
      const { free } = await planted(2, 2);
      await start();
      await finishCoursesPartWay(db, AT);
      expect((await row(free[1]!)).archivedAt).not.toBeNull();
    });

    it("however many are on the wire, a send stays within a request", async () => {
      const { free } = await planted(3, 1);
      const first = await start();
      expect(first.total).toBeLessThanOrEqual(45);
      expect((await row(free[0]!)).archivedAt).not.toBeNull();
    });

    it("a stop with three on the wire and outlines: the outlines go, and only then is it waiting; once they land it finishes", async () => {
      await connected();
      const id = await started();
      const rows = [await planned(day(0, 1), 1), await planned(day(0, 2), 2), await planned(day(0, 3), 3)];
      await db.update(plannedWorkouts).set({ planId: id }).where(inArray(plannedWorkouts.id, rows));
      const records: string[] = [];
      for (const r of rows) records.push(await onTheWire(r, "in_progress"));
      const replies: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 12; i++) {
        const res = await stop(id);
        replies.push(res.body);
        expect(res.total).toBeLessThanOrEqual(45);
        if (res.body.waiting) break;
      }
      expect(replies.at(-1)).toEqual({ more: true, waiting: true });
      // Not before: every earlier answer had outlines a resend could still take.
      for (const r of replies.slice(0, -1)) expect(r).toEqual({ more: true });
      expect(await outlinesOf(id)).toEqual([]);
      expect((await liveOf(id)).map((r) => r.id).sort()).toEqual([...rows].sort());
      await land(records);
      expect((await until(() => stop(id))).last).toEqual({ more: false });
      expect(await liveOf(id)).toEqual([]);
    });

    it("a stop with one on the wire and a free one: the free one goes", async () => {
      await connected();
      const id = await started();
      const wire = await planned(day(0, 1), 1);
      const free = await planned(day(0, 2), 2);
      await db.update(plannedWorkouts).set({ planId: id }).where(inArray(plannedWorkouts.id, [wire, free]));
      await onTheWire(wire, "claimed");
      await stop(id);
      expect((await row(free)).archivedAt).not.toBeNull();
      expect((await row(wire)).archivedAt).toBeNull();
    });

    describe("what counts as on the wire is what a removal refuses", () => {
      it("a provisional copy's push, even claimed, doesn't: its copy comes off", async () => {
        await connected();
        const r = await planned(MON, 1);
        const record = await onTheWatch(r);
        await db.update(corosWriteJobs).set({ status: "claimed" }).where(eq(corosWriteJobs.id, `push:${record}`));
        const res = await start();
        expect(res.body.waiting).toBeUndefined();
        expect((await row(r)).archivedAt).not.toBeNull();
      });

      it("another kind of job under way on the row doesn't", async () => {
        await connected();
        const r = await planned(MON, 1);
        const record = await onTheWatch(r);
        const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${record}`));
        await db.insert(corosWriteJobs).values({ ...push!, id: `${r}-other`, kind: "coach_delete_workout", status: "in_progress", payload: { provisional: false } });
        const res = await start();
        expect(res.body.waiting).toBeUndefined();
        expect((await row(r)).archivedAt).not.toBeNull();
      });

      it("a push that has settled doesn't", async () => {
        await connected();
        const r = await planned(MON, 1);
        await onTheWire(r, "verified");
        const res = await start();
        expect(res.body.waiting).toBeUndefined();
        expect((await row(r)).archivedAt).not.toBeNull();
      });

      it("another account's job naming the row doesn't", async () => {
        await connected();
        const r = await planned(MON, 1);
        const record = await onTheWatch(r);
        const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${record}`));
        const other = await makeTestUser(db);
        await db.insert(corosWriteJobs).values({ ...push!, id: "push:someone-elses", userId: other.userId, status: "in_progress", payload: { provisional: false } });
        expect((await start()).body.waiting).toBeUndefined();
        expect((await row(r)).archivedAt).not.toBeNull();
      });

      it("one that goes on the wire between the read and its removal is still refused, and still says waiting", async () => {
        await connected();
        const r = await planned(MON, 1);
        const record = await onTheWatch(r);
        const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${record}`));
        landing = {
          at: REMOVAL_READ,
          then: () => (db.update(corosWriteJobs).set({ status: "in_progress", payload: { ...(push!.payload as object), provisional: false } }).where(eq(corosWriteJobs.id, `push:${record}`)) as unknown as { run(): void }).run(),
        };
        const res = await start();
        expect(res.body).toMatchObject({ more: true, waiting: true });
        expect((await row(r)).archivedAt).toBeNull();
      });

      it("another workout on the wire, nothing to do with the course, isn't waited for", async () => {
        await connected();
        const { workout } = await createDocWorkout(db, userId, { date: day(0, 1), time: "07:00", doc: { ...docOfSession(1), source: { kind: "studio" } } }, ctx());
        await onTheWire(workout.id, "in_progress");
        const ahead = await planned(day(0, 2), 1);
        const first = await start();
        expect((await row(ahead)).archivedAt).not.toBeNull();
        expect(first.body.waiting).toBeUndefined();
        expect((await row(workout.id)).archivedAt).toBeNull();
        expect(courseConfigSchema.parse((await planOf(first.body.plan.id)).config).finishing).toBeUndefined();
      });

      it("nothing to take off, nothing to look for: no read of the watch's jobs", async () => {
        await connected();
        await start();
        expect(statements.filter((s) => /from "coros_write_jobs"/.test(s))).toEqual([]);
      });
    });
  });

  it("a row on the wire doesn't hold up what's behind it: those go first, and only then is it waiting", async () => {
    await connected();
    const wire = await planned(MON, 1);
    await onTheWire(wire, "in_progress");
    const second = await planned(day(0, 1), 2);
    const third = await planned(day(0, 2), 3);
    const first = await start();
    expect((await row(second)).archivedAt).not.toBeNull();
    expect((await row(third)).archivedAt).toBeNull();
    // Something a resend can do is still left.
    expect(first.body.more).toBe(true);
    expect(first.body.waiting).toBeUndefined();
    const next = await start();
    expect((await row(third)).archivedAt).not.toBeNull();
    expect(next.body).toMatchObject({ more: true, waiting: true });
    expect((await row(wire)).archivedAt).toBeNull();
  });

  it("the same in a stop", async () => {
    await connected();
    const id = await started();
    await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "program_replaced" }).where(eq(plannedWorkouts.planId, id));
    const wire = await planned(MON, 1);
    const second = await planned(day(0, 1), 2);
    const third = await planned(day(0, 2), 3);
    await db.update(plannedWorkouts).set({ planId: id }).where(inArray(plannedWorkouts.id, [wire, second, third]));
    await onTheWire(wire, "in_progress");
    const first = await stop(id);
    expect((await row(second)).archivedAt).not.toBeNull();
    expect((await row(third)).archivedAt).toBeNull();
    expect(first.body).toEqual({ more: true });
    expect((await stop(id)).body).toEqual({ more: true, waiting: true });
    expect((await row(third)).archivedAt).not.toBeNull();
  });

  it("the hourly pass finishes one that was waiting, once it has landed", async () => {
    await connected();
    const today = await planned(MON, 1);
    const recordId = await onTheWire(today, "in_progress");
    const first = await start();
    const id = first.body.plan.id as string;
    expect(await finishCoursesPartWay(db, AT)).toEqual({ finished: 1, failed: 0 });
    expect((await row(today)).archivedAt).toBeNull();
    expect(courseConfigSchema.parse((await planOf(id)).config).finishing).toBe("start");
    await db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, `push:${recordId}`));
    await finishCoursesPartWay(db, AT);
    expect((await row(today)).archivedAt).not.toBeNull();
    expect(courseConfigSchema.parse((await planOf(id)).config).finishing).toBeUndefined();
  });

  it("a start waits for one on the wire the same way, placing nothing until it's gone", async () => {
    await connected();
    const today = await planned(MON, 1);
    const recordId = await onTheWatch(today);
    const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${recordId}`));
    await db.update(corosWriteJobs).set({ status: "in_progress", payload: { ...(push!.payload as object), provisional: false } }).where(eq(corosWriteJobs.id, `push:${recordId}`));
    const first = await start();
    expect(first.body).toMatchObject({ more: true, waiting: true });
    expect((await liveOf(first.body.plan.id)).filter((r) => r.origin === "program")).toEqual([]);
    await db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, `push:${recordId}`));
    await until(() => start());
    expect((await row(today)).archivedAt).not.toBeNull();
    expect((await liveOf(first.body.plan.id)).filter((r) => r.origin === "program").length).toBe(6);
  });
});

describe("POST /api/plans/:id/stop: a course", () => {
  it("retires the plan, and its outlines leave the calendar: archived through placement's retraction, each with its suppression", async () => {
    const id = await started();
    const before = await liveOf(id);
    expect(before.length).toBe(6);
    const { last } = await until(() => stop(id));
    expect(last).toEqual({ more: false });
    expect((await planOf(id)).status).toBe("retired");
    expect(await liveOf(id)).toEqual([]);
    for (const r of before) {
      expect((await row(r.id)).archiveReason).toBe("program_replaced");
      expect((await suppressionsOf(r.id)).map((s) => s.reason)).toEqual(["user_removed"]);
    }
  });

  it("moves to Past plans: the list says retired, with its number still", async () => {
    const id = await started();
    await ownSession(id, day(-1, 0), 1, "completed");
    await until(() => stop(id));
    expect((await listed()).find((p) => p.id === id)).toMatchObject({ status: "retired", course: { session: 2, of: 4 } });
  });

  it("takes today's written session, a session ahead moved or written, today's outline, and a re-timed outline", async () => {
    const id = await started();
    const written = await ownSession(id, MON, 1, "scheduled", { id: "written-today" });
    const moved = slotId(id, day(0, 4));
    await applyMove(db, { userId, workoutId: moved, toDate: day(0, 5), toTime: "19:30", source: "app", corosWritesEnabled: false });
    const retimed = slotId(id, day(1, 0));
    await applyMove(db, { userId, workoutId: retimed, toDate: day(1, 0), toTime: "20:30", source: "app", corosWritesEnabled: false });
    expect(await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, retimed))).not.toEqual([]);
    const today = slotId(id, MON);
    await until(() => stop(id));
    for (const r of [written, moved, retimed, today]) expect((await row(r)).archivedAt, r).not.toBeNull();
    expect(await liveOf(id)).toEqual([]);
  });

  it("takes a session filed by the coach, today or ahead", async () => {
    const id = await started();
    const today = await filed(id, MON);
    const ahead = await filed(id, day(1, 1));
    await until(() => stop(id));
    for (const r of [today, ahead]) expect((await row(r)).archivedAt, r).not.toBeNull();
  });

  it("a revised session comes off too: unlike a pause, nothing comes back to overwrite the edit", async () => {
    const id = await started();
    const edited = await planned(MON, 1);
    await reviseDocWorkout(db, userId, edited, { doc: { ...docOfSession(1), title: "Mine now" }, baseRev: 1 }, ctx());
    await db.update(plannedWorkouts).set({ planId: id, courseSession: 1 }).where(eq(plannedWorkouts.id, edited));
    await until(() => stop(id));
    expect((await row(edited)).archivedAt).not.toBeNull();
  });

  it("one still unresolved today comes off too", async () => {
    const id = await started();
    const open = await ownSession(id, MON, 1, "unresolved");
    await until(() => stop(id));
    expect((await row(open)).archivedAt).not.toBeNull();
  });

  it("a started session survives, its own or filed, and a saved one", async () => {
    const id = await started();
    const own = await ownSession(id, MON, 1, "scheduled", { contentState: "started" });
    const extra = await filed(id, MON, { contentState: "started" });
    const saved = await ownSession(id, MON, 2, "scheduled");
    await saveSession(saved, MON);
    const { last } = await until(() => stop(id));
    expect(last).toEqual({ more: false });
    for (const r of [own, extra, saved]) expect((await row(r)).archivedAt, r).toBeNull();
    // Once it's stopped, nothing is read again: its fixed six, less the status.
    expect((await stop(id)).total).toBe(PLAN_STOP_FIXED - 1);
  });

  it("what can't come off isn't even tried: no removal is started for a session begun, saved, resolved, behind or another's", async () => {
    const id = await started();
    await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "program_replaced" }).where(eq(plannedWorkouts.planId, id));
    await ownSession(id, MON, 1, "scheduled", { contentState: "started" });
    await saveSession(await ownSession(id, MON, 2, "scheduled"), MON);
    await ownSession(id, MON, 2, "completed");
    await ownSession(id, day(1, 2), 3, "skipped");
    await ownSession(id, day(-1, 2), 2, "scheduled");
    const other = await makeTestUser(db);
    await earlier(day(0, 1), 1, "scheduled", { userId: other.userId, planId: id });
    expect((await stop(id)).body).toEqual({ more: false });
    expect(statements.filter((s) => REMOVAL_READ.test(s))).toEqual([]);
  });

  it("a started outline survives too", async () => {
    const id = await started();
    const today = slotId(id, MON);
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, today));
    await until(() => stop(id));
    expect((await row(today)).archivedAt).toBeNull();
  });

  it("what's behind stays, in every state, and what's already resolved today or ahead stays", async () => {
    const id = await started();
    const behind = await Promise.all([
      ownSession(id, day(-1, 0), 1, "completed"),
      ownSession(id, day(-1, 1), 2, "missed"),
      ownSession(id, day(-1, 2), 2, "scheduled"),
      filed(id, day(-1, 3)),
    ]);
    const doneToday = await ownSession(id, MON, 2, "completed");
    const skippedAhead = await ownSession(id, day(1, 2), 3, "skipped");
    await until(() => stop(id));
    for (const r of [...behind, doneToday, skippedAhead]) expect((await row(r)).archivedAt, r).toBeNull();
    expect(await courseSessionsDone(db, userId, id)).toBe(2);
  });

  it("one removed by hand between the read and its removal is simply gone", async () => {
    const id = await started();
    const written = await ownSession(id, MON, 1, "scheduled", { id: "written-today" });
    landing = { at: REMOVAL_READ, then: () => removeByHand(written) };
    expect((await stop(id)).status).toBe(200);
    expect(await row(written)).toMatchObject({ archiveReason: "user_removed" });
  });

  it("one begun between the read and its removal stays, and nothing is left to send again for", async () => {
    const id = await started();
    await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "program_replaced" }).where(eq(plannedWorkouts.planId, id));
    const written = await ownSession(id, MON, 1, "scheduled", { id: "written-today" });
    landing = { at: REMOVAL_READ, then: () => setRow(written, { contentState: "started" }) };
    const res = await stop(id);
    expect(res.body).toEqual({ more: false });
    expect(await row(written)).toMatchObject({ archivedAt: null, contentState: "started" });
  });

  describe("an outline placement leaves, begun just as it would come off", () => {
    const fixedToday = async () => {
      const id = await started();
      // Only today's left: not the pass's to retract, so it goes in the last step.
      await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "program_replaced" }).where(and(eq(plannedWorkouts.planId, id), ne(plannedWorkouts.effectiveDate, MON)));
      return { id, today: slotId(id, MON) };
    };

    it.each([
      ["started", (today: string) => setRow(today, { contentState: "started" })],
      ["completed", (today: string) => setRow(today, { completionState: "completed" })],
      ["saved", (today: string) => (db.insert(performedSessions).values({ id: newId(), userId, workoutId: today, source: "app", localDate: MON, movesDone: [], payloadHash: "h", createdAt: NOW, updatedAt: NOW }) as unknown as { run(): void }).run()],
    ])("%s: it stays", async (_, land) => {
      const { id, today } = await fixedToday();
      landing = { at: ARCHIVE, then: () => land(today) };
      expect((await stop(id)).body).toEqual({ more: false });
      expect(statements.some((s) => ARCHIVE.test(s))).toBe(true);
      expect((await row(today)).archivedAt).toBeNull();
    });

    it("left alone, it goes", async () => {
      const { id, today } = await fixedToday();
      expect((await stop(id)).body).toEqual({ more: false });
      expect((await row(today)).archivedAt).not.toBeNull();
      expect((await row(today)).archiveReason).toBe("program_replaced");
    });
  });

  it("the outlines placement leaves go as many as fit, and more says so", async () => {
    const id = await started();
    for (const date of [day(0, 4), day(1, 0), day(1, 4)]) await applyMove(db, { userId, workoutId: slotId(id, date), toDate: date, toTime: "20:30", source: "app", corosWritesEnabled: false });
    await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "program_replaced" }).where(and(eq(plannedWorkouts.planId, id), inArray(plannedWorkouts.effectiveDate, [MON, day(2, 0), day(2, 4)])));
    // Its read and the marker's clear, the pass's four reads, the look again, one removal, and just too little for a second.
    const first = await stopCourse(db, userId, await planOf(id), ctx(), 2 + 4 + 1 + RETRACT_COST + RETRACT_COST - 1);
    expect(first.more).toBe(true);
    expect((await liveOf(id)).length).toBe(2);
    const { costs } = await until(() => stop(id));
    for (const c of costs) expect(c).toBeLessThanOrEqual(45);
    expect(await liveOf(id)).toEqual([]);
  });

  it("the pass runs only with room for its first step: short of it, more says so and no outline goes", async () => {
    const id = await started();
    expect(await stopCourse(db, userId, await planOf(id), ctx(), 2 + STOPPED_PASS_MIN - 1)).toEqual({ more: true });
    expect((await liveOf(id)).length).toBe(6);
    expect(await stopCourse(db, userId, await planOf(id), ctx(), 2 + STOPPED_PASS_MIN)).toEqual({ more: true });
    expect((await liveOf(id)).length).toBe(5);
  });

  it("a row another account filed under that id isn't touched", async () => {
    const id = await started();
    const other = await makeTestUser(db);
    const theirs = await earlier(day(0, 1), 1, "scheduled", { userId: other.userId, planId: id });
    await until(() => stop(id));
    expect((await row(theirs)).archivedAt).toBeNull();
  });

  it("takes only this plan's: a Studio workout and another plan's sessions stay, today and ahead", async () => {
    const id = await started();
    const plain = { workoutDoc: JSON.stringify({ ...docOfSession(1), source: { kind: "studio" } }) };
    const studio = await earlier(MON, 1, "scheduled", plain);
    const studioAhead = await earlier(day(1, 1), 1, "scheduled", plain);
    const coachSession = await earlier(day(0, 1), 1, "scheduled", { ...plain, planId: "another-plan", origin: null });
    const otherSlot = await earlier(day(0, 2), 1, "scheduled", { planId: "another-programme", origin: "program", workoutDoc: null, workoutDocRev: null });
    await until(() => stop(id));
    for (const r of [studio, studioAhead, coachSession, otherSlot]) expect((await row(r)).archivedAt, r).toBeNull();
  });

  it("a session with no content state at all comes off like any other", async () => {
    const id = await started();
    const bare = await filed(id, MON, { contentState: null });
    await until(() => stop(id));
    expect((await row(bare)).archivedAt).not.toBeNull();
  });

  it("the request that takes the last outline says nothing is left, and spends no more than it took", async () => {
    const id = await started();
    await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "program_replaced" }).where(and(eq(plannedWorkouts.planId, id), inArray(plannedWorkouts.effectiveDate, [MON, day(0, 4), day(1, 0)])));
    const res = await stop(id);
    expect(res.body).toEqual({ more: false });
    expect(await liveOf(id)).toEqual([]);
    // Its fixed six, its read and the marker's clear, the pass's five reads and looks, and three retractions at their measured eight.
    expect(res.total).toBe(PLAN_STOP_FIXED + 2 + 5 + 3 * 8);
  });

  it("once stopped, the day's pass writes nothing for it", async () => {
    const id = await started();
    await stop(id);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect((await row(slotId(id, MON))).origin).toBe("program");
  });

  it("a stop on a stopped plan writes nothing and says nothing is left", async () => {
    const id = await started();
    await until(() => stop(id));
    const res = await stop(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ more: false });
    expect(writes()).toEqual([]);
  });

  it("one left part way is taken up by the next send, on the plan as it stands", async () => {
    const id = await started();
    const first = await stop(id);
    expect(first.body.more).toBe(true);
    expect((await planOf(id)).status).toBe("retired");
    expect((await liveOf(id)).length).toBeGreaterThan(0);
    await until(() => stop(id));
    expect(await liveOf(id)).toEqual([]);
  });

  it("every send gets somewhere, and the count of what's left only falls", async () => {
    const id = await started();
    await ownSession(id, MON, 1, "scheduled", { id: "written-today" });
    await filed(id, day(1, 1));
    await filed(id, day(1, 2));
    const left: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await stop(id);
      left.push((await liveOf(id)).length);
      if (!res.body.more) break;
    }
    expect(left.at(-1)).toBe(0);
    for (let i = 1; i < left.length; i++) expect(left[i]!).toBeLessThan(left[i - 1]!);
  });

  it("the written and filed go first, soonest first: an outline has the hourly pass to fall back on", async () => {
    const id = await started();
    const later = await filed(id, day(1, 1));
    const sooner = await ownSession(id, MON, 1, "scheduled", { id: "z-written" });
    await stop(id);
    expect((await row(sooner)).archivedAt).not.toBeNull();
    expect((await row(later)).archivedAt).toBeNull();
    // By an explicit order, not by whichever index the read happens to use.
    expect(statements.find((s) => s.startsWith('select "id", "origin" from "planned_workouts"'))).toMatch(/order by .*"effective_date".*"id"/);
  });

  it("a run to more: false ends just where one request with all the room would have", async () => {
    const seed = async () => {
      const id = await startCourseWhole();
      await ownSession(id, day(-1, 0), 1, "completed");
      await ownSession(id, MON, 2, "scheduled", { id: "written-today", title: "written" });
      await filed(id, day(1, 1), { id: "filed-ahead", title: "filed" });
      await ownSession(id, MON, 2, "scheduled", { id: "started-today", title: "started", contentState: "started" });
      await applyMove(db, { userId, workoutId: slotId(id, day(0, 4)), toDate: day(0, 5), toTime: "19:30", source: "app", corosWritesEnabled: false });
      return id;
    };
    const startCourseWhole = async () => {
      const res = await startCourse(db, userId, BODY, ctx(), Number.POSITIVE_INFINITY);
      if (!res.ok) throw new Error(res.error);
      return res.planId;
    };
    const id = await seed();
    const { costs } = await until(() => stop(id));
    expect(costs.length).toBeGreaterThan(1);
    const byRequests = await finalState();

    db = makeTestDb({ boundVariableCap: 100 });
    ({ userId, prefs } = await makeTestUser(db));
    const again = await seed();
    expect(await stopCourse(db, userId, await planOf(again), ctx(), Number.POSITIVE_INFINITY)).toEqual({ more: false });
    expect(await finalState()).toEqual(byRequests);
  });

  it("another account's plan is 404, and nothing changes", async () => {
    const other = await makeTestUser(db);
    const theirs = await startCourse(db, other.userId, BODY, { ...ctx(), prefs: other.prefs }, 40);
    const id = theirs.ok ? theirs.planId : "";
    expect((await stop(id)).status).toBe(404);
    expect((await planOf(id)).status).toBe("active");
  });

  it("no such plan is 404; an archived row and the one-off bucket are no plans", async () => {
    expect((await stop("nope")).status).toBe(404);
    const id = await started();
    await db.update(programs).set({ archivedAt: NOW }).where(eq(programs.id, id));
    expect((await stop(id)).status).toBe(404);
    expect((await planOf(id)).status).toBe("active");
    await db.insert(programs).values({ id: "bucket", userId, kind: "studio", name: "Bucket", status: "active", disciplines: [], config: {}, createdAt: NOW, updatedAt: NOW });
    expect((await stop("bucket")).status).toBe(404);
    expect((await planOf("bucket")).status).toBe("active");
  });

  it("a stopped plan whose definition is gone still stops", async () => {
    const id = await started();
    const plan = await planOf(id);
    await db.update(programs).set({ config: { ...plan.config, course: "an-old-course" } }).where(eq(programs.id, id));
    const { last } = await until(() => stop(id));
    expect(last).toEqual({ more: false });
    expect(await liveOf(id)).toEqual([]);
  });

  it("a restore in progress is 423, and nothing changes", async () => {
    const id = await started();
    await beginRestore();
    const res = await stop(id);
    expect(res.status).toBe(423);
    expect(res.body).toEqual({ error: "restore_in_progress" });
    expect((await planOf(id)).status).toBe("active");
    expect((await liveOf(id)).length).toBe(6);
  });

  it("a restore beginning just after the request's own look is 423 too", async () => {
    const id = await started();
    race.begin = beginRestore;
    expect((await stop(id)).status).toBe(423);
    expect((await planOf(id)).status).toBe("active");
  });

  it("a restore beginning as a written session comes off: 423, and that session stays", async () => {
    const id = await started();
    const written = await ownSession(id, MON, 1, "scheduled", { id: "written-today" });
    race.begin = async () => {
      race.begin = beginRestore;
    };
    expect((await stop(id)).status).toBe(423);
    expect((await row(written)).archivedAt).toBeNull();
  });

  it("a restore beginning between the retraction and the sessions it left: nothing more goes", async () => {
    const id = await started();
    const today = slotId(id, MON);
    // The pass's first look, then its look before it retracts: a restore lands there, and only the look after finds it.
    race.begin = async () => {
      race.begin = beginRestore;
    };
    const out = await stopCourse(db, userId, await planOf(id), ctx(), Number.POSITIVE_INFINITY);
    expect(out.more).toBe(true);
    expect((await row(slotId(id, day(0, 4)))).archivedAt).not.toBeNull();
    expect((await row(today)).archivedAt).toBeNull();
  });
});

describe("an abandoned start or stop: the hourly pass finishes it (R33)", () => {
  const finishing = async (id: string) => courseConfigSchema.parse((await planOf(id)).config).finishing;
  /** One hour of the cron's course work, in the order the cron runs it. */
  const anHour = async () => {
    await finishCoursesPartWay(db, AT);
    await placeSlotsForAllPrograms(db, AT);
  };
  const twoOnADay = async () => {
    const live = (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), isNull(plannedWorkouts.archivedAt)))).filter((r) => r.effectiveDate >= MON);
    const days = live.map((r) => r.effectiveDate);
    return days.filter((d, i) => days.indexOf(d) !== i);
  };
  /** Sessions already planned on the very days the course will use. */
  const seedAhead = async () => {
    const dates = [MON, day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 4)];
    const ids: string[] = [];
    for (const [i, date] of dates.entries()) ids.push(await planned(date, i + 1));
    return ids;
  };

  describe("a start", () => {
    it("abandoned after one send, the fill holds: nothing lands beside the old sessions, hour after hour", async () => {
      await seedAhead();
      const first = await start();
      expect(first.body.more).toBe(true);
      const id = first.body.plan.id as string;
      expect(await finishing(id)).toBe("start");
      await placeSlotsForAllPrograms(db, AT);
      expect((await rowsOf(id)).filter((r) => r.origin === "program")).toEqual([]);
      await anHour();
      expect(await twoOnADay()).toEqual([]);
      // A written session has nothing to be written from: no outline, no write beside the old one.
      expect(await writeCourseSessionsDue(db, new Date("2026-10-09T19:00:00.000Z"))).toEqual({ written: 0, failed: 0 });
    });

    it("the hourly pass carries on to the same end as a client's run, one step at a time, nothing on one day twice", async () => {
      await seedAhead();
      await until(() => start());
      const byClient = await finalState();

      db = makeTestDb({ boundVariableCap: 100 });
      ({ userId, prefs } = await makeTestUser(db));
      cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
      await seedAhead();
      const first = await start();
      const id = first.body.plan.id as string;
      let hours = 0;
      while ((await finishing(id)) !== undefined && hours < 20) {
        await anHour();
        hours += 1;
        expect(await twoOnADay()).toEqual([]);
      }
      expect(hours).toBeGreaterThan(1);
      await anHour();
      expect(await finishing(id)).toBeUndefined();
      expect(await finalState()).toEqual(byClient);
      expect(await twoOnADay()).toEqual([]);
    });

    it("a client coming back part way finishes it from where the pass left it", async () => {
      await seedAhead();
      const first = await start();
      await anHour();
      await until(() => start());
      expect(await finishing(first.body.plan.id)).toBeUndefined();
      expect(await twoOnADay()).toEqual([]);
    });

    it("the cron runs it, before placement, so the hour that clears the marker fills the weeks", async () => {
      const ids = [await planned(day(0, 1), 1), await planned(day(0, 2), 2)];
      const first = await start();
      const id = first.body.plan.id as string;
      expect((await Promise.all(ids.map(row))).filter((r) => r.archivedAt === null)).toHaveLength(1);
      await hourly(db, ENV);
      expect((await Promise.all(ids.map(row))).filter((r) => r.archivedAt === null)).toEqual([]);
      expect(await finishing(id)).toBeUndefined();
      // Today's among them, written by the same hour.
      expect((await liveOf(id)).length).toBe(6);
    });

    it("today is the athlete's: at 23:30 where they are, a session on their today is still today's, though it's tomorrow in UTC", async () => {
      const both = [await planned(MON, 1), await planned(MON, 2)];
      const first = await start();
      expect(first.body.more).toBe(true);
      const [left] = (await Promise.all(both.map(row))).filter((r) => r.archivedAt === null);
      await finishCoursesPartWay(db, new Date("2026-10-06T06:30:00.000Z"));
      expect(await row(left!.id)).toMatchObject({ planId: studioProgramId(userId), courseSession: null });
      expect((await row(left!.id)).archivedAt).not.toBeNull();
    });

    it("a session that passes its day while it waits isn't removed: it joins, as one behind", async () => {
      const wed = await planned(day(0, 2), 2);
      const thu = await planned(day(0, 3), 3);
      await planned(day(0, 1), 1);
      const first = await start();
      const id = first.body.plan.id as string;
      // Friday, in the athlete's zone.
      await finishCoursesPartWay(db, new Date("2026-10-09T19:00:00.000Z"));
      expect(await row(wed)).toMatchObject({ planId: id, courseSession: 2, archivedAt: null });
      expect(await row(thu)).toMatchObject({ planId: id, courseSession: 3, archivedAt: null });
    });

    it("the marker clears with nothing to move, in the send that finds that", async () => {
      const first = await start();
      expect(first.body.more).toBe(false);
      expect((await planOf(first.body.plan.id)).config).not.toHaveProperty("finishing");
    });

    it("once cleared, a retry and the pass change nothing: a Studio copy added since stays where it was put", async () => {
      const id = await started();
      const copy = await planned(day(1, 1), 1);
      const before = await row(copy);
      expect((await start()).body.more).toBe(false);
      expect(refRows).toEqual([0]);
      await anHour();
      expect(await row(copy)).toEqual(before);
      expect(await finishing(id)).toBeUndefined();
    });

    it("the marker doesn't stop the plan being edited, or the edit stop the marker", async () => {
      await seedAhead();
      const first = await start();
      const id = first.body.plan.id as string;
      expect(await applyPlanPatch(db, userId, id, { easeNext: true }, NOW, MON)).toMatchObject({ ok: true });
      expect(courseConfigSchema.parse((await planOf(id)).config)).toMatchObject({ easeNext: true, finishing: "start" });
    });

    it("held, a pass does nothing at all: it retracts nothing either", async () => {
      const id = await started();
      await planned(day(0, 1), 1);
      await planned(day(0, 2), 2);
      const plan = await planOf(id);
      await db.update(programs).set({ config: { ...plan.config, finishing: "start" } }).where(eq(programs.id, id));
      expect(await placeSlots(db, userId, id, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
      await db.update(programs).set({ pausedUntil: day(4, 0) }).where(eq(programs.id, id));
      expect(await placeSlots(db, userId, id, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
    });

    it("a revival sets it, so what was planned while it was stopped is taken in", async () => {
      const id = await started();
      await until(() => stop(id));
      await planned(day(0, 1), 1);
      await planned(day(0, 2), 2);
      const first = await start();
      expect(first.body.more).toBe(true);
      expect(await finishing(id)).toBe("start");
    });
  });

  describe("a stop", () => {
    const seedRunning = async () => {
      const id = await startedWhole();
      await writeCourseSessionsDue(db, AT);
      await filed(id, day(0, 1), { id: "filed-1", title: "filed one" });
      await filed(id, day(0, 3), { id: "filed-2", title: "filed two" });
      await filed(id, day(1, 1), { id: "filed-3", title: "filed three" });
      return id;
    };
    const startedWhole = async () => {
      const res = await startCourse(db, userId, BODY, ctx(), Number.POSITIVE_INFINITY);
      if (!res.ok) throw new Error(res.error);
      return res.planId;
    };

    it("abandoned after one send, the hourly pass takes what's left, so nothing stays live under a stopped plan to read as missed", async () => {
      const id = await seedRunning();
      const first = await stop(id);
      expect(first.body).toEqual({ more: true });
      expect(await finishing(id)).toBe("stop");
      let hours = 0;
      while ((await finishing(id)) !== undefined && hours < 20) {
        await anHour();
        hours += 1;
      }
      expect(await finishing(id)).toBeUndefined();
      expect((await liveOf(id)).filter((r) => r.effectiveDate >= MON && r.completionState === "scheduled")).toEqual([]);
      for (const r of ["filed-1", "filed-2", "filed-3"]) expect((await row(r)).archivedAt, r).not.toBeNull();
      await reconcileCompletionStates(db, userId, prefs, new Date("2026-10-20T19:00:00.000Z"));
      expect((await liveOf(id)).filter((r) => r.completionState === "missed")).toEqual([]);
    });

    it("ends where a client's run ends", async () => {
      const id = await seedRunning();
      await until(() => stop(id));
      const byClient = await finalState();

      db = makeTestDb({ boundVariableCap: 100 });
      ({ userId, prefs } = await makeTestUser(db));
      cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
      const again = await seedRunning();
      await stop(again);
      let hours = 0;
      while ((await finishing(again)) !== undefined && hours < 20) {
        await anHour();
        hours += 1;
      }
      expect(await finalState()).toEqual(byClient);
    });

    it("an hour's step keeps to its budget: one session with a copy's cost an hour, not the lot", async () => {
      const id = await seedRunning();
      await stop(id);
      const left = async () => (await Promise.all(["filed-1", "filed-2", "filed-3"].map(row))).filter((r) => r.archivedAt === null).length;
      const before = await left();
      expect(before).toBeGreaterThan(1);
      await finishCoursesPartWay(db, AT);
      expect(await left()).toBe(before - 1);
    });

    it("the marker clears with nothing to take off, in the send that finds that, and a retry reads nothing", async () => {
      await db.insert(programs).values({ id: "empty", userId, kind: "course", name: "Empty", status: "active", disciplines: ["yoga"], config: courseConfigSchema.parse(BODY), createdAt: NOW, updatedAt: NOW });
      expect((await stop("empty")).body).toEqual({ more: false });
      expect((await planOf("empty")).status).toBe("retired");
      expect((await planOf("empty")).config).not.toHaveProperty("finishing");
      const late = await filed("empty", day(1, 1));
      const res = await stop("empty");
      expect(res.body).toEqual({ more: false });
      expect(res.total).toBe(PLAN_STOP_FIXED - 1);
      expect((await row(late)).archivedAt).toBeNull();
    });

    it("stopping a start part way: the fill stays held, it's stopped, and what never joined the plan stays in the bucket", async () => {
      const ids = await seedAhead();
      const first = await start();
      const id = first.body.plan.id as string;
      const { last } = await until(() => stop(id));
      expect(last).toEqual({ more: false });
      expect((await planOf(id)).status).toBe("retired");
      expect(await finishing(id)).toBeUndefined();
      await anHour();
      expect((await rowsOf(id)).filter((r) => r.origin === "program")).toEqual([]);
      expect((await Promise.all(ids.map(row))).filter((r) => r.archivedAt === null).length).toBeGreaterThan(0);
    });

    it("a plan's clear is its own: another course's marker stands", async () => {
      await db.insert(programs).values({ id: "other", userId, kind: "course", name: "Other", status: "active", disciplines: ["yoga"], config: { ...courseConfigSchema.parse({ ...BODY, course: "an-old-course" }), finishing: "start" }, createdAt: NOW, updatedAt: NOW });
      await started();
      expect(await finishing("other")).toBe("start");
      await db.insert(programs).values({ id: "empty", userId, kind: "course", name: "Empty", status: "active", disciplines: ["yoga"], config: courseConfigSchema.parse({ ...BODY, course: "another-old-course" }), createdAt: NOW, updatedAt: NOW });
      await db.update(programs).set({ config: { ...courseConfigSchema.parse({ ...BODY, course: "an-old-course" }), finishing: "stop" } }).where(eq(programs.id, "other"));
      await stop("empty");
      expect(await finishing("other")).toBe("stop");
    });

    it("a start landing as a stop clears its marker keeps its own: each clears only its own kind", async () => {
      await db.insert(programs).values({ id: "empty", userId, kind: "course", name: "Empty", status: "active", disciplines: ["yoga"], config: courseConfigSchema.parse(BODY), createdAt: NOW, updatedAt: NOW });
      landing = {
        at: /^update "programs" set "config" = json_remove/,
        then: () => (db.update(programs).set({ config: { ...courseConfigSchema.parse(BODY), finishing: "start" } }).where(eq(programs.id, "empty")) as unknown as { run(): void }).run(),
      };
      await stop("empty");
      expect(landing).toBeNull();
      expect(await finishing("empty")).toBe("start");
    });

    it("a stop part way changes its status once, and doesn't write it again for each send", async () => {
      const id = await seedRunning();
      await stop(id);
      await stop(id);
      expect(writes().filter((s) => s.startsWith('update "programs"'))).toEqual([]);
    });

    it("starting a stop part way: the start takes over the marker", async () => {
      const id = await seedRunning();
      await stop(id);
      const res = await start();
      expect(res.status).toBe(200);
      expect((await planOf(id)).status).toBe("active");
      await until(() => start());
      expect(await finishing(id)).toBeUndefined();
    });
  });

  it("a restore in progress holds the step: nothing is written, and the marker stays", async () => {
    await seedAhead();
    const first = await start();
    const id = first.body.plan.id as string;
    const before = await finalState();
    await beginRestore();
    expect(await finishCoursesPartWay(db, AT)).toEqual({ finished: 0, failed: 0 });
    expect(await finalState()).toEqual(before);
    expect(await finishing(id)).toBe("start");
  });

  it("a restore beginning as the step runs isn't a failure, and that session stays", async () => {
    const ids = await seedAhead();
    const first = await start();
    expect(first.body.more).toBe(true);
    const left = (await Promise.all(ids.map(row))).filter((r) => r.archivedAt === null).map((r) => r.id);
    race.begin = beginRestore;
    expect(await finishCoursesPartWay(db, AT)).toEqual({ finished: 0, failed: 0 });
    expect((await Promise.all(left.map(row))).filter((r) => r.archivedAt === null).map((r) => r.id)).toEqual(left);
  });

  describe("the on-day writer and the opening hold while it's set (R38)", () => {
    const read = async (id: string) => {
      const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(`/api/sessions/${id}`, { headers: { Cookie: cookie } }, ENV);
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const build = async (id: string) => {
      const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(`/api/sessions/${id}/build`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: "{}" }, ENV);
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    /** Today's outline, its plan marked as a start part way. */
    const held = async () => {
      const id = await started();
      const plan = await planOf(id);
      await db.update(programs).set({ config: { ...plan.config, finishing: "start" } }).where(eq(programs.id, id));
      return { id, today: slotId(id, MON) };
    };

    it("a stop part way, a copy on that day, a start: nothing is written beside the copy, and once it's finished there's one session on the day", async () => {
      const id = await started();
      await planned(MON, 1);
      await planned(MON, 2);
      for (const [i, date] of [day(0, 1), day(0, 2), day(0, 3)].entries()) await filed(id, date, { id: `filed-${i}`, title: `filed ${i}` });
      expect((await stop(id)).body.more).toBe(true);
      const first = await start();
      expect(first.body.more).toBe(true);
      expect(await finishing(id)).toBe("start");
      expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
      expect(await row(slotId(id, MON))).toMatchObject({ origin: "program", workoutDoc: null, courseSession: null });
      await until(() => start());
      expect(await finishing(id)).toBeUndefined();
      expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
      const onMonday = (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.effectiveDate, MON), isNull(plannedWorkouts.archivedAt))));
      expect(onMonday.map((r) => r.id)).toEqual([slotId(id, MON)]);
    });

    it("the hourly writer doesn't even spend a turn on it: its read leaves the plan out", async () => {
      await held();
      statements.length = 0;
      expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
      expect(statements).toHaveLength(1);
    });

    it("a marker landing while the document is made: the write's own guard refuses it", async () => {
      const id = await started();
      const today = slotId(id, MON);
      const real = INTRO_COURSE.sessionDoc;
      vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementationOnce((n, opts) => {
        (db.update(programs).set({ config: { ...courseConfigSchema.parse(BODY), finishing: "start" } }).where(eq(programs.id, id)) as unknown as { run(): void }).run();
        return real(n, opts);
      });
      expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
      expect(await row(today)).toMatchObject({ origin: "program", workoutDoc: null, courseSession: null });
      expect(await revisionsOf(today)).toEqual([]);
    });

    it("opening it: the read writes nothing and answers as any held outline does, with no build", async () => {
      const { id, today } = await held();
      statements.length = 0;
      const body = await read(today);
      // Held, not lost at the write: nothing is even tried.
      expect(writes()).toEqual([]);
      expect(body).toMatchObject({ origin: "program", contentState: "outline", build: null, videos: INTRO_COURSE.videos });
      expect(await row(today)).toMatchObject({ origin: "program", workoutDoc: null });
      expect(await revisionsOf(today)).toEqual([]);
      void id;
    });

    it("building it: the same, with no build rather than an engine's, and nothing written", async () => {
      const { today } = await held();
      statements.length = 0;
      const body = await build(today);
      expect(writes()).toEqual([]);
      expect(body).toMatchObject({ origin: "program", contentState: "outline", build: null });
      expect(await row(today)).toMatchObject({ origin: "program", workoutDoc: null });
      expect(await revisionsOf(today)).toEqual([]);
    });

    it("answers just as a pause does: one held outline reads like another", async () => {
      const { id, today } = await held();
      const heldRead = await read(today);
      const heldBuild = await build(today);
      await db.update(programs).set({ config: courseConfigSchema.parse(BODY), pausedUntil: MON }).where(eq(programs.id, id));
      expect(await read(today)).toEqual(heldRead);
      expect(await build(today)).toEqual(heldBuild);
    });

    it("a day ahead still previews: only today's is the writer's", async () => {
      const { id } = await held();
      const body = await build(slotId(id, day(0, 4)));
      expect(body.build).not.toBeNull();
      expect(await row(slotId(id, day(0, 4)))).toMatchObject({ origin: "program", workoutDoc: null });
    });

    it("once it's cleared, opening today's writes it", async () => {
      const { id, today } = await held();
      await until(() => start());
      expect(await finishing(id)).toBeUndefined();
      expect(await read(today)).toMatchObject({ origin: "studio" });
    });
  });

  describe("its statement bound", () => {
    it("nothing part way is one read, whatever the accounts", async () => {
      await started();
      statements.length = 0;
      expect(await finishCoursesPartWay(db, AT)).toEqual({ finished: 0, failed: 0 });
      expect(statements).toHaveLength(1);
    });

    it("one step spends its read, its look and its budget at most, on a realistic account with a copy to take off", async () => {
      const account = await seedRealisticAccount(db);
      userId = account.userId;
      prefs = await loadPreferences(db, userId);
      cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
      for (let n = 1; n <= 6; n++) await planned(addDays(MON, n), n);
      await start(BODY, { ...makeRealisticEnv(), WATCH_PUSH_ENABLED: "1" } as Env);
      statements.length = 0;
      await finishCoursesPartWay(db, AT);
      expect(statements.length).toBeLessThanOrEqual(1 + 1 + COURSE_FINISH_BUDGET);
      expect(COURSE_FINISH_BUDGET).toBeLessThanOrEqual(45);
    });

    it("however many are part way, it takes on so many an hour, and the others wait for theirs", async () => {
      const owners: Array<{ userId: string; prefs: UserPreferences }> = [];
      for (let i = 0; i < COURSE_FINISHES_PER_PASS + 1; i++) {
        ({ userId, prefs } = await makeTestUser(db));
        owners.push({ userId, prefs });
        await startCourse(db, userId, BODY, ctx(), 40);
        await db.update(programs).set({ config: { ...courseConfigSchema.parse(BODY), finishing: "start" } }).where(eq(programs.userId, userId));
      }
      statements.length = 0;
      const stats = await finishCoursesPartWay(db, AT);
      expect(stats.finished).toBe(COURSE_FINISHES_PER_PASS);
      expect(statements.length).toBeLessThanOrEqual(1 + COURSE_FINISHES_PER_PASS * (1 + COURSE_FINISH_BUDGET));
      const left = await db.select().from(programs).where(sql`json_extract(${programs.config}, '$.finishing') is not null`);
      expect(left).toHaveLength(1);
    });

    it("one that fails doesn't stop the other, and the log says so by the error's name alone", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await db.insert(programs).values({ id: "broken", userId, kind: "course", name: "private words", status: "active", disciplines: [], config: { finishing: "start", course: 1 }, createdAt: NOW, updatedAt: NOW });
      await seedAhead();
      const first = await start();
      expect(await finishCoursesPartWay(db, AT)).toEqual({ finished: 1, failed: 1 });
      expect(await finishing(first.body.plan.id)).toBe("start");
      for (const call of error.mock.calls) expect(String(call[0])).not.toContain("private words");
      expect(error.mock.calls.some((c) => /course finish failed.*broken.*ZodError/.test(String(c[0])))).toBe(true);
    });

    it("the marker isn't a course's alone to read: another kind naming it is passed over", async () => {
      await db.insert(programs).values({ id: "other-kind", userId, kind: "coach", name: "C", status: "active", disciplines: [], config: { finishing: "start", course: COURSE }, createdAt: NOW, updatedAt: NOW });
      statements.length = 0;
      expect(await finishCoursesPartWay(db, AT)).toEqual({ finished: 0, failed: 0 });
      expect(statements).toHaveLength(1);
    });
  });
});

describe("stopping another kind of plan: the path it has always had", () => {
  it("a programme goes as its settings sheet stops it: retired, its slots retracted, and the same as PATCH /api/programs", async () => {
    const make = async () => {
      const app = mountRoutes(db, "/api/programs", programRoutes);
      const res = await app.request("/api/programs", { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Mobility", config: { weeklyGoal: 2, preferredDays: [1, 3] } }) }, ENV);
      expect(res.status).toBe(201);
      return ((await res.json()) as { program: { id: string } }).program.id;
    };
    const viaStop = await make();
    const viaPatch = await make();
    const { costs } = await until(() => stop(viaStop));
    for (const c of costs) expect(c).toBeLessThanOrEqual(45);
    let placing = true;
    while (placing) {
      const res = await mountRoutes(db, "/api/programs", programRoutes).request(`/api/programs/${viaPatch}`, { method: "PATCH", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ status: "retired" }) }, ENV);
      placing = ((await res.json()) as { placing?: boolean }).placing === true;
    }
    const shape = async (id: string) => (await rowsOf(id)).map((r) => [r.originalPlanDate, r.archiveReason, r.archivedAt !== null]).sort();
    expect((await planOf(viaStop)).status).toBe("retired");
    expect(await shape(viaStop)).toEqual(await shape(viaPatch));
    expect(await liveOf(viaStop)).toEqual([]);
  });

  describe("a coach plan: its blocks, through the coach's own retire", () => {
    const block = async (id: string, programId: string, startDate: string, endDate: string, status = "active") =>
      db.insert(coachPlans).values({ id, userId, discipline: "run", name: `Block ${id}`, status, startDate, endDate, raceDate: null, stampPrefix: id, programId, createdAt: NOW, updatedAt: NOW });
    const coachRow = (planId: string, date: string, id = newId()) =>
      earlier(date, 1, "scheduled", { id, planId, origin: null, workoutDoc: null, workoutDocRev: null });
    const coachPlan = async () => {
      await db.insert(programs).values({ id: "line", userId, kind: "coach", name: "Line", status: "active", disciplines: ["run"], config: {}, createdAt: NOW, updatedAt: NOW });
      await block("ended", "line", day(-3, 0), day(-1, 6), "completed");
      await block("now", "line", day(0, 0), day(0, 6));
      await block("next", "line", day(1, 0), day(1, 6));
    };

    it("retires each block that hasn't ended and takes their sessions off, as a line's Stop does; one receipt; and the plan's own row says it stopped", async () => {
      await coachPlan();
      const past = await coachRow("ended", day(-1, 0));
      const today = await coachRow("now", MON);
      const ahead = await coachRow("next", day(1, 1));
      // Another plan of the athlete's, with a block and a session that must not feel it.
      await db.insert(programs).values({ id: "other-line", userId, kind: "coach", name: "Other", status: "active", disciplines: ["strength"], config: {}, createdAt: NOW, updatedAt: NOW });
      await block("other-block", "other-line", day(0, 0), day(3, 6));
      const otherSession = await coachRow("other-block", day(1, 2));
      const { last } = await until(() => stop("line"));
      expect(last).toEqual({ more: false });
      const status = async (id: string) => (await db.select().from(coachPlans).where(eq(coachPlans.id, id)))[0]!.status;
      expect(await status("ended")).toBe("completed");
      expect(await status("now")).toBe("retired");
      expect(await status("next")).toBe("retired");
      expect(await status("other-block")).toBe("active");
      expect((await row(otherSession)).archivedAt).toBeNull();
      expect((await row(past)).archivedAt).toBeNull();
      expect((await row(today)).archiveReason).toBe("user_removed");
      expect((await row(ahead)).archiveReason).toBe("user_removed");
      const receipts = async () => (await db.select().from(coachMessages).where(eq(coachMessages.userId, userId))).map((m) => m.body);
      expect(await receipts()).toEqual(["Plan stopped — completed history stays."]);
      expect((await planOf("line")).status).toBe("retired");
      expect((await planOf("other-line")).status).toBe("active");
      // Sent again, nothing is left to stop and nothing is said twice.
      expect((await stop("line")).body).toEqual({ more: false });
      expect(await receipts()).toEqual(["Plan stopped — completed history stays."]);
    });

    it("short of a chunk's room, or part way through a block: more, and no receipt until the last has gone", async () => {
      await coachPlan();
      for (let i = 0; i < 30; i++) await coachRow("now", day(0, i % 7), `s-${i}`);
      const said: string[] = [];
      const receipt = async (body: string) => void said.push(body);
      expect(await stopBlocks(db, userId, ["now", "next"], prefs, STRUCTURAL_MIN_BUDGET - 1, receipt)).toEqual({ more: true });
      expect((await rowsOf("now")).filter((r) => r.archivedAt === null).length).toBe(30);
      // Its only block, part way: more, though no block is left to go to.
      expect(await stopBlocks(db, userId, ["now"], prefs, STRUCTURAL_MIN_BUDGET, receipt)).toEqual({ more: true });
      expect((await rowsOf("now")).filter((r) => r.archivedAt === null).length).toBeLessThan(30);
      expect(said).toEqual([]);
      expect(await stopBlocks(db, userId, ["now", "next"], prefs, 400, receipt)).toEqual({ more: false });
      expect(said).toEqual(["Plan stopped — completed history stays."]);
    });

    it("what one block spends comes out of what the next may: no room for a chunk's own reads, and it waits", async () => {
      await coachPlan();
      const receipt = async () => undefined;
      // An empty block's chunk costs four: its plan read, its sessions read, its status and the plan's.
      expect(await stopBlocks(db, userId, ["now", "next"], prefs, STRUCTURAL_MIN_BUDGET + 2, receipt)).toEqual({ more: true });
      const status = async (id: string) => (await db.select().from(coachPlans).where(eq(coachPlans.id, id)))[0]!.status;
      expect(await status("now")).toBe("retired");
      expect(await status("next")).toBe("active");
    });

    it("a block over by the account's today is left as it is, as a line's Stop leaves it, even if it's asked for", async () => {
      await coachPlan();
      await block("over", "line", day(-2, 0), day(-1, 0));
      await stopBlocks(db, userId, ["over"], prefs, 400, async () => undefined);
      expect((await db.select().from(coachPlans).where(eq(coachPlans.id, "over")))[0]!.status).toBe("active");
    });

    it("ends as the coach's route ends, phase by phase", async () => {
      await coachPlan();
      const today = await coachRow("now", MON);
      const app = mountRoutes(db, "/api/coach", coachRoutes);
      const res = await app.request("/api/coach/plans/now/retire?stop=last", { method: "POST", headers: { Cookie: cookie } }, ENV);
      expect(res.status).toBe(200);
      const viaRoute = await row(today);
      expect(viaRoute.archiveReason).toBe("user_removed");
      // The block the old route retired isn't asked again: the new route goes on with the other.
      await until(() => stop("line"));
      expect((await db.select().from(coachPlans).where(eq(coachPlans.id, "next")))[0]!.status).toBe("retired");
    });

    it("a line of many sessions goes a slice a request, each within the budget", async () => {
      await coachPlan();
      for (let i = 0; i < 60; i++) await coachRow("now", day(0, i % 7), `s-${i}`);
      const { costs } = await until(() => stop("line"));
      for (const c of costs) expect(c).toBeLessThanOrEqual(45);
      expect((await rowsOf("now")).every((r) => r.archivedAt !== null)).toBe(true);
    });
  });

  it("a plan with no stop of its own to reach here is refused, and nothing changes", async () => {
    const coros = { id: "watch-plan", userId, kind: "coros_import", name: "Watch", status: "active", disciplines: ["run"], config: {}, createdAt: NOW, updatedAt: NOW };
    const studio = { ...coros, id: "studio-held", kind: "coach", name: "Studio", disciplines: ["strength"], source: { studioPlanId: "sp-1" } };
    await db.insert(programs).values([coros, studio]);
    const blockOf = (id: string, owner: string, programId: string) => ({ id, userId: owner, discipline: "run", name: id, status: "active", startDate: day(0, 0), endDate: day(1, 0), raceDate: null, stampPrefix: id, programId, createdAt: NOW, updatedAt: NOW });
    // Neither a block that names a watch plan, nor another account's block naming the Studio's, makes either one stoppable here.
    const other = await makeTestUser(db);
    await db.insert(coachPlans).values([blockOf("names-watch", userId, "watch-plan"), blockOf("theirs", other.userId, "studio-held")]);
    for (const id of ["watch-plan", "studio-held"]) {
      const res = await stop(id);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "not_stoppable" });
      expect((await planOf(id)).status).toBe("active");
    }
  });
});

describe("restarting: the same plan comes back (R28)", () => {
  it("stop then start revives that row, with the days and the time asked for now, and n continues", async () => {
    const id = await started();
    await ownSession(id, day(-1, 0), 1, "completed");
    await until(() => stop(id));
    const { last } = await until(() => start({ ...BODY, weekdays: [1, 3], time: "06:30" }));
    expect(last.plan).toMatchObject({ id, status: "active", course: { session: 2, of: 4 } });
    expect(await coursePlans()).toHaveLength(1);
    expect(courseConfigSchema.parse((await planOf(id)).config)).toMatchObject({ weekdays: [1, 3], time: "06:30" });
    expect(await courseSessionsDone(db, userId, id)).toBe(1);
    expect(new Set((await liveOf(id)).filter((r) => r.origin === "program").map((r) => r.effectiveTime))).toEqual(new Set(["06:30"]));
    expect(await writeCourseSessionsDue(db, new Date("2026-10-06T19:00:00.000Z"))).toEqual({ written: 1, failed: 0 });
    expect(await row(slotId(id, day(0, 1)))).toMatchObject({ origin: "studio", courseSession: 2 });
  });

  it("a session completed without being written counts through a restart: it has a number and no document", async () => {
    const id = await started();
    const docless = await db
      .update(plannedWorkouts)
      .set({ completionState: "completed", courseSession: 1 })
      .where(eq(plannedWorkouts.id, slotId(id, MON)))
      .returning({ id: plannedWorkouts.id });
    expect(docless).toHaveLength(1);
    expect((await row(slotId(id, MON))).workoutDoc).toBeNull();
    await until(() => stop(id));
    expect(await courseSessionsDone(db, userId, id)).toBe(1);
    const { last } = await until(() => start());
    expect(last.plan).toMatchObject({ id, course: { session: 2, of: 4 } });
    expect(await row(slotId(id, MON))).toMatchObject({ completionState: "completed", courseSession: 1, archivedAt: null });
  });

  it("a revival writes a version saying what changed; a retry and a new plan write none", async () => {
    const id = await started();
    await start();
    expect(await db.select().from(programVersions).where(eq(programVersions.programId, id))).toEqual([]);
    await db.update(programs).set({ pausedUntil: day(4, 0) }).where(eq(programs.id, id));
    await until(() => stop(id));
    await until(() => start({ ...BODY, weekdays: [1, 3], time: "06:30" }));
    const [first, ...rest] = await db.select().from(programVersions).where(eq(programVersions.programId, id));
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ versionNum: 1, capturedAt: NOW });
    expect(first!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((first!.summary as { changed: string[] }).changed.sort()).toEqual(["pausedUntil", "status", "time", "weekdays"]);
    await start({ ...BODY, weekdays: [1, 3], time: "06:30" });
    expect(await db.select().from(programVersions).where(eq(programVersions.programId, id))).toHaveLength(1);
    await until(() => stop(id));
    await until(() => start({ ...BODY, weekdays: [1, 3], time: "06:30" }));
    const after = await db.select().from(programVersions).where(eq(programVersions.programId, id));
    expect(after.map((v) => v.versionNum).sort()).toEqual([1, 2]);
    expect((after.find((v) => v.versionNum === 2)!.summary as { changed: string[] }).changed).toEqual(["status"]);
  });

  it("a moved outline comes back with no mark of the move: a pause takes it like any other, and nothing reads it as the athlete's", async () => {
    const id = await started();
    const fri = slotId(id, day(0, 4));
    await applyMove(db, { userId, workoutId: fri, toDate: day(0, 5), toTime: "08:00", source: "app", corosWritesEnabled: false });
    expect(await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, fri))).not.toEqual([]);
    // Another workout's time, pinned: nothing to do with this.
    const { workout: other } = await createDocWorkout(db, userId, { date: day(3, 1), time: "07:00", doc: { ...docOfSession(1), source: { kind: "studio" } } }, ctx());
    await until(() => stop(id));
    await until(() => start());
    expect(await row(fri)).toMatchObject({ effectiveDate: day(0, 4), archivedAt: null });
    expect(await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, fri))).toEqual([]);
    expect(await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, other.id))).toHaveLength(1);
    await db.update(programs).set({ pausedUntil: day(1, 0) }).where(eq(programs.id, id));
    await placeSlots(db, userId, id, MON, prefs, NOW);
    expect((await row(fri)).archivedAt).not.toBeNull();
  });

  it.each([
    ["the athlete", (doc: WorkoutDoc) => doc],
    ["the coach", (doc: WorkoutDoc) => ({ ...doc, source: { ...doc.source, kind: "coach" as const } })],
  ])("a session %s revised comes back as a clean outline: its last revision isn't a touch, with no document to be touching", async (_, change) => {
    const id = await started();
    await writeCourseSessionsDue(db, AT);
    const today = slotId(id, MON);
    await reviseDocWorkout(db, userId, today, { doc: change({ ...docOfSession(1), title: "Mine now" }), baseRev: (await row(today)).workoutDocRev! }, ctx());
    expect((await row(today)).workoutDocRev).toBe(2);
    await until(() => stop(id));
    await until(() => start());
    expect(await row(today)).toMatchObject({ archivedAt: null, origin: "program", workoutDoc: null, workoutDocRev: 2 });
    await db.update(programs).set({ pausedUntil: day(1, 0) }).where(eq(programs.id, id));
    await placeSlots(db, userId, id, MON, prefs, NOW);
    expect((await row(today)).archivedAt).not.toBeNull();
  });

  it("a revived slot's statements are within what the pass declares", async () => {
    const id = await started();
    await applyMove(db, { userId, workoutId: slotId(id, day(1, 0)), toDate: day(1, 1), toTime: "08:00", source: "app", corosWritesEnabled: false });
    await until(() => stop(id));
    await until(() => start({ ...BODY, weekdays: [0] }));
    await db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "program_replaced" }).where(and(eq(plannedWorkouts.planId, id), eq(plannedWorkouts.originalPlanDate, day(1, 0))));
    statements.length = 0;
    const res = await placeSlotsWithin(db, userId, id, MON, prefs, NOW, 45);
    expect(res.placed).toEqual([slotId(id, day(1, 0))]);
    expect(statements.length).toBeLessThanOrEqual(res.spent);
    // The row, its suppression and its overrides.
    expect(REVIVE_COST).toBe(3);
    expect(statements.filter((s) => /^delete from "(calendar_event_suppressions|schedule_overrides)"/.test(s))).toHaveLength(2);
  });

  it("the outlines it took come back on the same rows, each suppression gone: its days weren't the athlete's to lose", async () => {
    const id = await started();
    const ids = (await liveOf(id)).map((r) => r.id).sort();
    await until(() => stop(id));
    await until(() => start());
    expect((await liveOf(id)).map((r) => r.id).sort()).toEqual(ids);
    for (const r of ids) expect(await suppressionsOf(r)).toEqual([]);
  });

  it("a written session it took comes back as an outline on its day, its number gone and its document's history kept", async () => {
    const id = await started();
    await writeCourseSessionsDue(db, AT);
    const today = slotId(id, MON);
    expect((await row(today)).origin).toBe("studio");
    await until(() => stop(id));
    expect((await row(today)).archivedAt).not.toBeNull();
    await until(() => start());
    expect(await row(today)).toMatchObject({ archivedAt: null, origin: "program", courseSession: null, workoutDoc: null });
    expect(await revisionsOf(today)).toHaveLength(1);
  });

  it("keeps the athlete's own words and an easing asked for; a pause from before the stop doesn't outlive the new start", async () => {
    const id = await started();
    const plan = await planOf(id);
    await db.update(programs).set({ purpose: "My own words", brief: "My own brief", pausedUntil: day(4, 0), config: { ...plan.config, easeNext: true } }).where(eq(programs.id, id));
    await until(() => stop(id));
    await until(() => start());
    const after = await planOf(id);
    expect(after).toMatchObject({ purpose: "My own words", brief: "My own brief", pausedUntil: null, status: "active" });
    expect(courseConfigSchema.parse(after.config).easeNext).toBe(true);
  });

  it("a row archived by hand at the plan's level comes back with it: the course has one plan, always", async () => {
    const id = await started();
    await until(() => stop(id));
    await db.update(programs).set({ archivedAt: NOW }).where(eq(programs.id, id));
    const { last } = await until(() => start());
    expect(last.plan?.id).toBe(id);
    expect((await planOf(id)).archivedAt).toBeNull();
    expect(await coursePlans()).toHaveLength(1);
  });

  it("an archived row of the plan comes back though its status never changed", async () => {
    const id = await started();
    await db.update(programs).set({ archivedAt: NOW }).where(eq(programs.id, id));
    expect((await planOf(id)).status).toBe("active");
    await until(() => start());
    expect((await planOf(id)).archivedAt).toBeNull();
    expect(await coursePlans()).toHaveLength(1);
    const [version] = await db.select().from(programVersions).where(eq(programVersions.programId, id));
    expect((version!.summary as { changed: string[] }).changed).toEqual(["archivedAt"]);
  });

  it("a plan stored by another id is still the course's plan: it's found by its config, not its id", async () => {
    await db.insert(programs).values({ id: "some-other-id", userId, kind: "course", name: "Intro", status: "retired", disciplines: ["yoga"], config: courseConfigSchema.parse(BODY), createdAt: NOW, updatedAt: NOW });
    expect(await started()).toBe("some-other-id");
    expect(await coursePlans()).toHaveLength(1);
  });

  it("a running plan whose settings no longer read is put right the same way, not left to throw", async () => {
    await db.insert(programs).values({ id: "old", userId, kind: "course", name: "Intro", status: "active", disciplines: ["yoga"], config: { course: COURSE, someOldKey: 1 }, createdAt: NOW, updatedAt: NOW });
    expect(await started()).toBe("old");
    expect(courseConfigSchema.parse((await planOf("old")).config)).toMatchObject({ course: COURSE, weekdays: [0, 4], time: "19:30" });
  });

  it("a stored config that no longer reads is replaced by what's asked for", async () => {
    await db.insert(programs).values({ id: "old", userId, kind: "course", name: "Intro", status: "retired", disciplines: ["yoga"], config: { course: COURSE, someOldKey: 1 }, createdAt: NOW, updatedAt: NOW });
    expect(await started()).toBe("old");
    expect(courseConfigSchema.parse((await planOf("old")).config)).toMatchObject({ course: COURSE, weekdays: [0, 4], time: "19:30" });
  });

  it("the list moves it back out of Past plans, and its sessions planned since are taken in", async () => {
    const id = await started();
    await until(() => stop(id));
    expect((await listed()).find((p) => p.id === id)!.status).toBe("retired");
    const sinceDone = await earlier(MON, 1, "completed");
    await until(() => start());
    expect((await listed()).find((p) => p.id === id)).toMatchObject({ status: "active", course: { session: 2, of: 4 } });
    expect(await row(sinceDone)).toMatchObject({ planId: id, courseSession: 1 });
  });
});

describe("the session read: videos", () => {
  const read = async (id: string) => {
    const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(`/api/sessions/${id}`, { headers: { Cookie: cookie } }, ENV);
    expect(res.status).toBe(200);
    return (await res.json()) as { videos?: unknown; build: unknown; origin: string | null };
  };
  const build = async (id: string) => {
    const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(`/api/sessions/${id}/build`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: "{}" }, ENV);
    expect(res.status).toBe(200);
    return (await res.json()) as { videos?: unknown; build: unknown };
  };
  const goneDefinition = async (id: string) => {
    const plan = await planOf(id);
    await db.update(programs).set({ config: { ...plan.config, course: "an-old-course" } }).where(eq(programs.id, id));
  };

  it("an outline ahead reads its definition's videos, as does its preview", async () => {
    const id = await started();
    const ahead = slotId(id, day(0, 4));
    expect((await read(ahead)).videos).toEqual(INTRO_COURSE.videos);
    const preview = await build(ahead);
    expect(preview.build).not.toBeNull();
    expect(preview.videos).toEqual(INTRO_COURSE.videos);
    // A second build answers from what it stored.
    expect((await build(ahead)).videos).toEqual(INTRO_COURSE.videos);
  });

  it("a written session reads them by its source.ref, under its plan or not", async () => {
    const id = await started();
    const today = slotId(id, MON);
    await read(today);
    expect(await row(today)).toMatchObject({ origin: "studio", courseSession: 1 });
    expect((await read(today)).videos).toEqual(INTRO_COURSE.videos);
    const studio = await planned(day(1, 1), 1);
    expect((await read(studio)).videos).toEqual(INTRO_COURSE.videos);
  });

  it("a stopped course's outline still reads them while its definition stands", async () => {
    const id = await started();
    const behind = slotId(id, MON);
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, id));
    expect((await read(behind)).videos).toEqual(INTRO_COURSE.videos);
  });

  it("a stopped course whose definition is gone reads none, and doesn't throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = await started();
    const outline = slotId(id, day(0, 4));
    const written = await ownSession(id, day(0, 2), 1, "scheduled", { workoutDoc: JSON.stringify({ ...docOfSession(1), source: { kind: "studio", ref: "an-old-course-course:1" } }) });
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, id));
    await goneDefinition(id);
    expect((await read(outline)).videos).toBeUndefined();
    expect((await read(written)).videos).toBeUndefined();
    error.mockRestore();
  });

  it("settings that don't read give none, and don't throw", async () => {
    const id = await started();
    await db.update(programs).set({ status: "retired", config: { nothing: true } }).where(eq(programs.id, id));
    expect((await read(slotId(id, day(0, 4)))).videos).toBeUndefined();
  });

  it("a session of no course has none, and an adaptive slot none", async () => {
    const mine = await createDocWorkout(db, userId, { date: day(0, 1), time: "07:00", doc: { ...docOfSession(1), source: { kind: "studio" } } }, ctx());
    expect((await read(mine.workout.id)).videos).toBeUndefined();
    await db.insert(programs).values({ id: "prog", userId, kind: "adaptive", name: "P", status: "active", disciplines: ["yoga"], config: { weeklyGoal: 1, preferredDays: [3] }, createdAt: NOW, updatedAt: NOW });
    await placeSlots(db, userId, "prog", MON, prefs, NOW);
    expect((await read(slotId("prog", day(0, 3)))).videos).toBeUndefined();
  });

  it("the outline's videos cost the read no statement beyond what it read already", async () => {
    const id = await started();
    const ahead = slotId(id, day(0, 4));
    statements.length = 0;
    await read(ahead);
    const without = statements.length;
    const plan = await planOf(id);
    await db.update(programs).set({ config: { ...plan.config, course: "an-old-course" } }).where(eq(programs.id, id));
    statements.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await read(ahead);
    expect(statements.length).toBe(without);
  });
});

describe("the list: where a course has got to", () => {
  it("fills course from sessionLabel(done), and past the last it says nothing", async () => {
    const id = await started();
    expect((await listed()).find((p) => p.id === id)!.course).toEqual({ session: 1, of: 4 });
    await ownSession(id, day(-3, 0), 1, "completed");
    await ownSession(id, day(-2, 0), 2, "completed");
    expect((await listed()).find((p) => p.id === id)!.course).toEqual({ session: 3, of: 4 });
    await ownSession(id, day(-2, 1), 3, "completed");
    await ownSession(id, day(-2, 2), 4, "completed");
    expect((await listed()).find((p) => p.id === id)!.course).toBeNull();
  });

  it("counts only the course's own sessions done", async () => {
    const id = await started();
    await filed(id, day(-1, 0), { completionState: "completed" });
    await ownSession(id, day(-1, 1), 1, "skipped");
    await ownSession(id, day(-1, 2), 1, "missed");
    expect((await listed()).find((p) => p.id === id)!.course).toEqual({ session: 1, of: 4 });
  });

  it("another account's sessions aren't counted, though they name this plan", async () => {
    const id = await started();
    const other = await makeTestUser(db);
    await earlier(day(-1, 0), 1, "completed", { userId: other.userId, planId: id, courseSession: 1 });
    expect((await listed()).find((p) => p.id === id)!.course).toEqual({ session: 1, of: 4 });
  });

  it("no definition, or settings that don't read: null, and the list still answers", async () => {
    await db.insert(programs).values({ id: "gone", userId, kind: "course", name: "Gone", status: "retired", disciplines: [], config: courseConfigSchema.parse({ ...BODY, course: "an-old-course" }), createdAt: NOW, updatedAt: NOW });
    await db.insert(programs).values({ id: "broken", userId, kind: "course", name: "Broken", status: "active", disciplines: [], config: {}, createdAt: NOW, updatedAt: NOW });
    const plans = await listed();
    expect(plans.find((p) => p.id === "gone")!.course).toBeNull();
    expect(plans.find((p) => p.id === "broken")!.course).toBeNull();
  });

  it("another kind of plan has none, though its settings read as a course's", async () => {
    await db.insert(programs).values({ id: "prog", userId, kind: "adaptive", name: "P", status: "active", disciplines: ["yoga"], config: { weeklyGoal: 1 }, createdAt: NOW, updatedAt: NOW });
    await db.insert(programs).values({ id: "coach-plan", userId, kind: "coach", name: "C", status: "active", disciplines: ["yoga"], config: courseConfigSchema.parse(BODY), createdAt: NOW, updatedAt: NOW });
    const plans = await listed();
    expect(plans.find((p) => p.id === "prog")!.course).toBeNull();
    expect(plans.find((p) => p.id === "coach-plan")!.course).toBeNull();
  });

  it("costs the list no statement: still the plans and the phases, once each", async () => {
    await started();
    const res = await send("GET", "/api/plans");
    expect(res.status).toBe(200);
    expect(statements.filter((s) => /from "(programs|coach_plans)"/i.test(s)).length).toBe(2);
    expect(statements.length).toBeLessThanOrEqual(6);
  });
});

describe("within a request's budget, on a realistic account", () => {
  /** A realistic account with a run of the course behind it, and its sessions ahead on the plan. */
  async function realistic(): Promise<Env> {
    const env = { ...makeRealisticEnv(), WATCH_PUSH_ENABLED: "1" } as Env;
    const account = await seedRealisticAccount(db);
    userId = account.userId;
    prefs = await loadPreferences(db, userId);
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    for (let n = 1; n <= 12; n++) await earlier(addDays(MON, -7 * n), n, "completed");
    for (let n = 13; n <= 18; n++) await planned(addDays(MON, n - 13), n);
    return env;
  }

  it("a start takes it all in, every request within 45, and a retry is cheap", async () => {
    const env = await realistic();
    const { costs } = await until(() => start(BODY, env));
    expect(costs.length).toBeGreaterThan(1);
    for (const c of costs) expect(c, JSON.stringify(costs)).toBeLessThanOrEqual(45);
    const [plan] = await coursePlans();
    expect(await courseSessionsDone(db, userId, plan!.id)).toBe(12);
    // Its fixed ten, less the plan's write and a revival's version, and a settled pass's five reads: the restore, the plan, the
    // sessions done, its rows and rule 5's. No read of what's planned: the marker's gone, so a retry takes nothing in.
    const retry = await start(BODY, env);
    expect(retry.total).toBe(COURSE_START_FIXED - 3 + 5);
    expect(COURSE_START_FIXED).toBe(10);
  });

  it("the first request of a start: its fixed statements and one removal, and no pass in what's left", async () => {
    const env = await realistic();
    const res = await start(BODY, env);
    expect(res.body.more).toBe(true);
    expect(res.total).toBeLessThanOrEqual(COURSE_START_FIXED + 3 + RETRACT_WRITTEN_COST);
    expect(COURSE_START_FIXED + 3 + RETRACT_WRITTEN_COST).toBeLessThanOrEqual(45);
  });

  it("many sessions behind move in one statement: 12 done on a realistic account", async () => {
    await realistic();
    statements.length = 0;
    await startCourse(db, userId, BODY, ctx(), 45);
    expect(statements.filter((s) => /^update "planned_workouts" set "plan_id"/i.test(s))).toHaveLength(1);
  });

  it("more than one statement's worth of sessions behind: the moves are counted, and a request stays within 45", async () => {
    const env = await realistic();
    for (let i = 0; i < 95; i++) await earlier(addDays(MON, -200 - i), 1, "completed");
    const { costs } = await until(() => start(BODY, env));
    for (const c of costs) expect(c, JSON.stringify(costs)).toBeLessThanOrEqual(45);
    expect(await courseSessionsDone(db, userId, (await coursePlans())[0]!.id)).toBe(107);
  });

  it("a stop takes it all off, every request within 45", async () => {
    const env = await realistic();
    const { last } = await until(() => start(BODY, env));
    const id = last.plan.id as string;
    await ownSession(id, MON, 13, "scheduled", { id: "written-today" });
    await filed(id, addDays(MON, 1));
    await filed(id, addDays(MON, 2));
    const { costs } = await until(() => stop(id, env));
    for (const c of costs) expect(c, JSON.stringify(costs)).toBeLessThanOrEqual(45);
    expect((await liveOf(id)).filter((r) => r.effectiveDate >= MON && r.completionState === "scheduled")).toEqual([]);
    expect(PLAN_STOP_FIXED).toBe(6);
    expect(PLAN_STOP_FIXED + 2 + RETRACT_WRITTEN_COST).toBeLessThanOrEqual(45);
    // Stopped already: its fixed six, less the status.
    expect((await stop(id, env)).total).toBe(PLAN_STOP_FIXED - 1);
  });

  it("the dearest removal, a copy on the watch to take off, is inside a request too", async () => {
    ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    await seedCatalog(db);
    const server = mockCorosServer({ baseMonday: "2026-10-12" });
    await connectMock(db, userId, server);
    const today = await planned(MON, 1);
    await queueProvisionalPush(db, switchOn(), userId, await row(today), ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    const first = await start();
    expect((await row(today)).archivedAt).not.toBeNull();
    expect(first.total).toBeLessThanOrEqual(COURSE_START_FIXED + 3 + RETRACT_WRITTEN_COST);
    await until(() => start());
    const id = (await coursePlans())[0]!.id;
    const again = await planned(MON, 2);
    await db.update(plannedWorkouts).set({ planId: id, courseSession: 2 }).where(eq(plannedWorkouts.id, again));
    await queueProvisionalPush(db, switchOn(), userId, await row(again), ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    const stopped = await stop(id);
    expect((await row(again)).archivedAt).not.toBeNull();
    expect(stopped.total).toBeLessThanOrEqual(45);
  });
});
