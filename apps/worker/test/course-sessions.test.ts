/**
 * A COURSE'S SESSION WRITTEN ON ITS DAY (plans with a purpose, spec §4.2 and §4.4). An outline holds a title and a booked
 * length and no document. On its day the first of the hourly pass or the session being opened writes it, once, numbered
 * from the sessions actually done, and it goes on as an ordinary document workout. A pause writes nothing, a day ahead
 * previews without storing, and an outline completed without being written takes its number in the completing write.
 *
 * Everything runs on a made-up course (`course-fixture.ts`): worker code reads only the definition. Fixed dates under a
 * faked `Date`, so nothing here goes stale. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ begin: null as null | (() => Promise<void>) }));
const google = vi.hoisted(() => ({ fake: null as unknown, calls: [] as string[] }));
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
vi.mock("../src/services/google-calendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/google-calendar.js")>()),
  googleCalendarClient: vi.fn(async () => google.fake),
}));

import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  adaptiveConfigSchema,
  addDays,
  courseConfigSchema,
  docOriginRow,
  newId,
  parseStoredWorkoutDoc,
  revisability,
  type CourseConfig,
  type SourceActivity,
  type UserPreferences,
  type WorkoutDoc,
} from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { Planner } from "@rg/session-engine";
import { deriveDoc, playerStepsFromDoc } from "@rg/workout";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { hourly } from "../src/index.js";
import { planRoutes } from "../src/routes/plan.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { syncRoutes } from "../src/routes/sync.js";
import { answerBodyCheck } from "../src/services/body-check.js";
import { ingestActivities } from "../src/services/completion.js";
import { courseOf, writeCourseSession, writeCourseSessionsDue } from "../src/services/course-sessions.js";
import { COURSE_WRITE_COST, COURSE_WRITES_PER_PASS } from "../src/services/cron-limits.js";
import type { Db } from "../src/services/db.js";
import { reviseDocWorkout } from "../src/services/doc-workouts.js";
import { loadEngineContext } from "../src/services/engine-inputs.js";
import { applyMove } from "../src/services/jobs.js";
import { rowRefusal } from "../src/services/mirror-rules.js";
import { markMirrorOwed, mirrorIntentId } from "../src/services/mirror-owed.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { queueProvisionalPush } from "../src/services/mirror.js";
import { courseSessionsDone, PAUSE_PASS_COST, placeSlots, placeSlotsForAllPrograms, placeSlotsWithin, RETRACT_COST, RETRACT_WRITTEN_COST, slotId } from "../src/services/program-slots.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { reviewBasis } from "../src/services/session-review-basis.js";
import {
  buildSessionOutcome,
  loadSession,
  lockCurrentBuild,
  NoDocumentError,
  NotBuiltError,
  recordCheck,
  sessionCurrency,
  UnknownProfileError,
  type BuildCtx,
} from "../src/services/session-build.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { activeSyncNotes } from "../src/services/sync-notes.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { INTRO_COURSE, INTRO_FIRST_BOOKED, INTRO_FIRST_SECONDS, INTRO_LATER_BOOKED, INTRO_LATER_SECONDS } from "./course-fixture.js";
import { landingsDoc } from "./doc-workout-fixture.js";
import { connectMock, seedCatalog, switchOn } from "./watch-push-fixture.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeRealisticEnv, seedRealisticAccount } from "./realistic-account.js";

const { accountState, activities, conditionChecks, corosWriteJobs, plannedWorkouts, programs, scheduleOverrides, sessionBuilds, syncIntents, syncNotes, workoutDocRevisions } = schema;

/** A Monday. */
const MON = "2026-10-05";
/** Monday noon in Los Angeles, the test user's zone. */
const NOW = "2026-10-05T19:00:00.000Z";
const AT = new Date(NOW);
/** `weekday` 0 = Monday … 6 = Sunday (the config's numbering), `week` weeks after MON's. */
const day = (week: number, weekday: number): string => addDays(MON, 7 * week + weekday);
const WATCH_ON = { APP_URL: "https://app.test", FIXTURE_MODE: "0", WATCH_PUSH_ENABLED: "1" } as Env;

/** A wire fingerprint: what a verified push leaves on a row. */
const WIRE = "0123456789abcdef";

let db: Db;
let userId: string;
let prefs: UserPreferences;
let ctx: BuildCtx;
let statements: string[];
/** The rows each read handed back. */
let rowsRead: number[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT);
  statements = [];
  rowsRead = [];
  race.begin = null;
  google.fake = null;
  google.calls = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s), onRows: (_, n) => rowsRead.push(n) });
  ({ userId, prefs } = await makeTestUser(db));
  ctx = { today: MON, now: NOW, prefs };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const writes = () => statements.filter(isWrite);

/** A running course on Monday and Wednesday at 18:15, unless a test says otherwise. */
async function seedCourse(config: Partial<CourseConfig> = {}, over: Partial<typeof programs.$inferInsert> = {}, owner = userId): Promise<string> {
  const id = over.id ?? newId();
  await db.insert(programs).values({
    id,
    userId: owner,
    kind: "course",
    name: "Evening practice",
    status: "active",
    disciplines: ["yoga"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    // A stored definition id may be gone, so the config isn't the schema's to refuse here.
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 2], time: "18:15", placementWeeksAhead: 1, ...config }),
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

const row = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const programOf = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!;
const revisionsOf = (id: string) => db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, id));
const buildsOf = (id: string) => db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, id));
const mirrorMark = async (id: string) => (await db.select().from(syncIntents).where(eq(syncIntents.id, mirrorIntentId(id))))[0];
const setPause = (planId: string, pausedUntil: string | null) => db.update(programs).set({ pausedUntil }).where(eq(programs.id, planId));
const stamp = (workoutId: string, fingerprint: string) => db.update(plannedWorkouts).set({ sourceContentFingerprint: fingerprint }).where(eq(plannedWorkouts.id, workoutId));
const docOf = (r: { workoutDoc: string | null }): WorkoutDoc => parseStoredWorkoutDoc(r.workoutDoc)!;
const holdOf = (doc: WorkoutDoc): number | undefined => {
  const item = doc.parts[0]!.items[0]!;
  return item.kind === "exercise" ? item.dose.holdSec : undefined;
};
const titleOf = (n: number): string => `Intro ${n}`;

async function move(workoutId: string, toDate: string, toTime = "18:15"): Promise<void> {
  await applyMove(db, { userId, workoutId, toDate, toTime, source: "app", corosWritesEnabled: false });
}

/** A session of the course already written as `n`, in any state, as a row. */
function sessionRow(planId: string, date: string, n: number, completionState: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}): typeof plannedWorkouts.$inferInsert {
  const id = newId();
  return {
    id, userId, planId, sourceWorkoutId: id, title: titleOf(n), category: "yoga", sport: "yoga", originalPlanDate: date, lastVerifiedCorosDate: "",
    effectiveDate: date, effectiveTime: "18:15", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900,
    origin: "studio", contentState: "outline", completionState, courseSession: n, createdAt: NOW, updatedAt: NOW, workoutDoc: JSON.stringify(realSessionDoc(n, { ease: false })), workoutDocRev: 1,
    ...over,
  };
}

/** The same, stored. */
async function session(planId: string, date: string, n: number, completionState: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<string> {
  const values = sessionRow(planId, date, n, completionState, over);
  await db.insert(plannedWorkouts).values(values);
  return values.id;
}

/** A workout the coach filed under the plan: no number, so not the course's own. */
const filed = (planId: string, date: string, completionState: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}) => session(planId, date, 1, completionState, { courseSession: null, title: "Extra", ...over });

const strengthOnMonday = (id: string, over: Partial<SourceActivity> = {}): SourceActivity => ({
  provider: "coros",
  providerActivityId: id,
  startTime: "2026-10-06T02:30:00Z",
  startTimeLocal: "2026-10-05T18:15:00",
  sport: "strength",
  durationSeconds: INTRO_FIRST_SECONDS,
  contentFingerprint: `fp-${id}`,
  ...over,
});

async function cookieFor(owner = userId): Promise<string> {
  return `${SESSION_COOKIE}=${await createSession(db, owner)}`;
}

/** An activity of the athlete's on `date`, for a manual link. */
async function activityOn(date: string, owner = userId): Promise<string> {
  const id = newId();
  await db.insert(activities).values({
    id, userId: owner, corosActivityId: `c-${id}`, source: "coros", startTime: `${date}T18:15:00Z`, startTimeLocal: `${date}T12:30:00`, timezone: "America/Los_Angeles",
    sport: "yoga", durationSeconds: 600, sourceMergeConfidence: 1, createdAt: NOW, updatedAt: NOW,
  });
  return id;
}

const beginRestore = async () => {
  await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });
};

/** The course's own documents, whatever a test does to its definition. */
const realSessionDoc = INTRO_COURSE.sessionDoc;

/** A session document that names a move the library doesn't hold: the judge refuses it, with one code. */
const unplayable = (n: number, opts: { ease: boolean }): WorkoutDoc => {
  const doc = realSessionDoc(n, opts);
  return { ...doc, parts: [{ ...doc.parts[0]!, items: [{ kind: "exercise", libraryId: "noSuchMove", dose: { sets: 1, holdSec: 60 } }] }] };
};

describe("the number", () => {
  it("numbers from sessions done, not sessions planned", async () => {
    const p = await seedCourse();
    await session(p, addDays(MON, -14), 1, "completed");
    await session(p, addDays(MON, -10), 2, "completed");
    // Written and never done: neither moves the number.
    await session(p, addDays(MON, -7), 3, "missed");
    await session(p, addDays(MON, -3), 3, "skipped");
    // Done, and not the course's own.
    await filed(p, addDays(MON, -5), "completed");
    await placeSlots(db, userId, p, MON, prefs, NOW);

    const id = slotId(p, MON);
    expect(await writeCourseSession(db, userId, await row(id), ctx)).toEqual({ written: true, n: 3 });
    const r = await row(id);
    expect(r.title).toBe(titleOf(3));
    expect(r.courseSession).toBe(3);
    expect(holdOf(docOf(r))).toBe(INTRO_LATER_SECONDS);
  });

  it("the first session is number one", async () => {
    const p = await placed();
    expect(await writeCourseSession(db, userId, await row(slotId(p, MON)), ctx)).toEqual({ written: true, n: 1 });
    expect(holdOf(docOf(await row(slotId(p, MON))))).toBe(INTRO_FIRST_SECONDS);
  });
});

describe("writing once", () => {
  it("writes once, whichever comes first: the hourly pass, then an open", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    const written = await row(id);

    const session1 = await loadSession(db, userId, id, MON);
    expect(session1.origin).toBe("studio");
    const built = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(built.session.build?.fromDoc?.rev).toBe(1);

    const after = await row(id);
    expect(after.workoutDoc).toBe(written.workoutDoc);
    expect(after.workoutDocRev).toBe(1);
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  it("writes once, whichever comes first: an open, then the hourly pass", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const opened = await loadSession(db, userId, id, MON);
    expect(opened.title).toBe(titleOf(1));
    expect(opened.origin).toBe("studio");
    statements.length = 0;
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect(writes()).toEqual([]);
    expect((await row(id)).workoutDocRev).toBe(1);
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  it("a writer that read the outline before another wrote it writes nothing: not the row, the easing or the mark", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const stale = await row(id);
    expect(await writeCourseSession(db, userId, stale, ctx)).toEqual({ written: true, n: 1 });
    const first = await row(id);
    const firstMark = await mirrorMark(id);

    // The athlete asks to ease the next one, and the mirror settles the first.
    await db.update(programs).set({ config: { ...(await programOf(p)).config, easeNext: true } }).where(eq(programs.id, p));
    await db.update(syncIntents).set({ resolvedAt: NOW }).where(eq(syncIntents.id, mirrorIntentId(id)));

    expect(await writeCourseSession(db, userId, stale, ctx)).toEqual({ written: false, n: 1 });
    expect(await row(id)).toEqual(first);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await mirrorMark(id)).toEqual({ ...firstMark, resolvedAt: NOW });
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  it("a stale writer with a different document to write changes nothing: the session already written stays as it is", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const stale = await row(id);
    expect((await writeCourseSession(db, userId, stale, ctx)).written).toBe(true);
    const first = await row(id);
    // The easing asked for since: this writer would make the session eased.
    await db.update(programs).set({ config: { ...(await programOf(p)).config, easeNext: true } }).where(eq(programs.id, p));
    expect((await writeCourseSession(db, userId, stale, { ...ctx, now: "2026-10-05T19:05:00.000Z" })).written).toBe(false);
    expect(await row(id)).toEqual(first);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  it("a number an undone link left on an outline doesn't pass for a flip: a write that doesn't land changes nothing", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    await db.update(plannedWorkouts).set({ completionState: "unresolved", courseSession: 1 }).where(eq(plannedWorkouts.id, id));
    const before = await row(id);
    race.begin = () => setPause(p, MON).then(() => undefined);
    expect((await writeCourseSession(db, userId, before, ctx)).written).toBe(false);
    expect(await row(id)).toEqual(before);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
  });

  it.each([
    ["moved off today", (id: string) => db.update(plannedWorkouts).set({ effectiveDate: day(0, 2) }).where(eq(plannedWorkouts.id, id))],
    ["skipped", (id: string) => db.update(plannedWorkouts).set({ completionState: "skipped" }).where(eq(plannedWorkouts.id, id))],
    ["removed", (id: string) => db.update(plannedWorkouts).set({ archivedAt: NOW }).where(eq(plannedWorkouts.id, id))],
    ["built", (id: string) => db.update(plannedWorkouts).set({ contentState: "built" }).where(eq(plannedWorkouts.id, id))],
  ])("what changed since the read stops all of it: %s", async (_, change) => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const stale = await row(id);
    await change(id);
    const now = await row(id);
    expect((await writeCourseSession(db, userId, stale, ctx)).written).toBe(false);
    expect(await row(id)).toEqual(now);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
    expect(await revisionsOf(id)).toEqual([]);
  });

  it("a row that isn't a course's writes nothing and has no number", async () => {
    const p = await placed();
    const extra = await filed(p, MON, "scheduled");
    statements.length = 0;
    expect(await writeCourseSession(db, userId, await row(extra), ctx)).toEqual({ written: false, n: 0 });
    expect(writes()).toEqual([]);
  });

  it("a written session stays written: a later pass and an open change nothing", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSessionsDue(db, AT);
    const written = await row(id);
    await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, id));
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect((await row(id)).courseSession).toBe(written.courseSession);
  });
});

describe("the day", () => {
  it("isn't due on the wrong day: at 23:30 in the athlete's zone, tomorrow UTC, tomorrow's outline stays one", async () => {
    const p = await seedCourse({ weekdays: [0, 1] });
    await placeSlots(db, userId, p, MON, prefs, "2026-10-05T12:00:00.000Z");
    const late = new Date("2026-10-06T06:30:00.000Z"); // 23:30 on Monday in Los Angeles; Tuesday in UTC.
    vi.setSystemTime(late);
    expect(await writeCourseSessionsDue(db, late)).toEqual({ written: 1, failed: 0 });
    expect((await row(slotId(p, day(0, 0)))).origin).toBe("studio");
    const tomorrow = await row(slotId(p, day(0, 1)));
    expect(tomorrow.origin).toBe("program");
    expect(tomorrow.workoutDoc).toBeNull();

    // An open of tomorrow's says the same: it is a preview, never the day's.
    await loadSession(db, userId, tomorrow.id, MON);
    expect((await row(tomorrow.id)).origin).toBe("program");
  });

  it.each([
    ["ahead of UTC", "Pacific/Auckland", "2026-10-05T12:00:00.000Z", day(0, 1)], // 01:00 Tuesday there, still Monday in UTC.
    ["behind UTC", "Pacific/Pago_Pago", "2026-10-06T05:00:00.000Z", day(0, 0)], // 18:00 Monday there, already Tuesday in UTC.
  ])("is due by the athlete's own today, %s", async (_, timezone, instant, due) => {
    const { userId: owner } = await makeTestUser(db, { timezone });
    const p = await seedCourse({ weekdays: [0, 1] }, {}, owner);
    await db.insert(plannedWorkouts).values(
      [day(0, 0), day(0, 1)].map((date) => ({
        id: slotId(p, date), userId: owner, planId: p, sourceWorkoutId: slotId(p, date), title: "Evening practice", category: "yoga", sport: "yoga", originalPlanDate: date, lastVerifiedCorosDate: "",
        effectiveDate: date, effectiveTime: "18:15", sourceContentFingerprint: "program", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900,
        origin: "program", contentState: "outline", completionState: "scheduled", corosSyncState: "calendar_only", createdAt: NOW, updatedAt: NOW,
      })),
    );
    expect(await writeCourseSessionsDue(db, new Date(instant))).toEqual({ written: 1, failed: 0 });
    expect((await row(slotId(p, due))).origin).toBe("studio");
  });

  it("an outline moved off today stays one, and one moved onto today is written", async () => {
    const p = await placed();
    await move(slotId(p, MON), day(0, 2));
    await move(slotId(p, day(0, 2)), MON);

    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect((await row(slotId(p, MON))).origin).toBe("program");
    const moved = await row(slotId(p, day(0, 2)));
    expect(moved.origin).toBe("studio");
    expect(moved.effectiveDate).toBe(MON);
    expect(moved.title).toBe(titleOf(1));
  });

  /** Neither the call nor the pass tries a write: the pass's one read is all it spends. */
  const triesNothing = async (id: string) => {
    statements.length = 0;
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(false);
    expect(writes()).toEqual([]);
    statements.length = 0;
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect(statements).toHaveLength(1);
  };

  it("a skipped or removed outline isn't written or tried, nor a day gone", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await db.update(plannedWorkouts).set({ completionState: "skipped" }).where(eq(plannedWorkouts.id, id));
    await triesNothing(id);
    await db.update(plannedWorkouts).set({ completionState: "scheduled", archivedAt: NOW }).where(eq(plannedWorkouts.id, id));
    await triesNothing(id);
    await db.update(plannedWorkouts).set({ archivedAt: null }).where(eq(plannedWorkouts.id, id));
    const tomorrow = { ...ctx, today: addDays(MON, 1) };
    statements.length = 0;
    expect((await writeCourseSession(db, userId, await row(id), tomorrow)).written).toBe(false);
    expect(writes()).toEqual([]);
    expect((await row(id)).origin).toBe("program");
  });

  it("a stopped course writes nothing and tries nothing: what it left on today stays an outline", async () => {
    const p = await placed();
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, p));
    const id = slotId(p, MON);
    await triesNothing(id);
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build).toBeNull();
    expect((await row(id)).origin).toBe("program");
  });

  it("a course stopped as the write runs stops it", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const before = await row(id);
    race.begin = async () => {
      await db.update(programs).set({ status: "retired" }).where(eq(programs.id, p));
    };
    expect((await writeCourseSession(db, userId, before, ctx)).written).toBe(false);
    expect(await row(id)).toEqual(before);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
  });
});

describe("easing", () => {
  it("uses and clears the easing in one write", async () => {
    const p = await placed({ easeNext: true });
    const before = (await programOf(p)).config;
    const id = slotId(p, MON);
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(true);

    const r = await row(id);
    expect(holdOf(docOf(r))).toBe(INTRO_FIRST_SECONDS / 2);
    // Half of 660 s, 15 s to get there: 6 minutes, booked as 10.
    expect(r.fallbackEstimatedDurationSeconds).toBe(360);
    expect(r.calendarBlockDurationSeconds).toBe(600);
    expect((await programOf(p)).config).toEqual({ ...before, easeNext: false });

    // The next is not eased.
    const next = await row(slotId(p, day(0, 2)));
    await writeCourseSession(db, userId, next, { ...ctx, today: day(0, 2) });
    expect(holdOf(docOf(await row(next.id)))).toBe(INTRO_FIRST_SECONDS);
  });

  it("all of the write lands or none does: a failure leaves the easing, the mark and the outline", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const before = await row(id);
    (db as unknown as { $client: { exec(sql: string): void } }).$client.exec(
      `create trigger refuse_course_revision before insert on workout_doc_revisions begin select raise(abort, 'refused'); end;`,
    );
    await expect(writeCourseSession(db, userId, before, ctx)).rejects.toThrow();
    expect(await row(id)).toEqual(before);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
  });


  it("a preview shows the session eased, and uses nothing", async () => {
    const p = await placed({ easeNext: true });
    const out = await buildSessionOutcome(db, userId, slotId(p, day(0, 2)), {}, ctx);
    expect(out.session.build?.plannedSeconds).toBeLessThan(INTRO_FIRST_SECONDS);
    expect((await programOf(p)).config.easeNext).toBe(true);
  });
});

describe("a written session", () => {
  it("becomes an ordinary document workout", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    const r = await row(id);
    const doc = INTRO_COURSE.sessionDoc(1, { ease: false });
    const derived = deriveDoc(doc, EXERCISES);

    expect(docOf(r)).toEqual(doc);
    expect(r).toMatchObject({
      origin: "studio",
      contentState: "outline",
      completionState: "scheduled",
      title: titleOf(1),
      category: derived.category,
      sport: derived.discipline,
      fallbackEstimatedDurationSeconds: INTRO_FIRST_SECONDS,
      calendarBlockDurationSeconds: INTRO_FIRST_BOOKED,
      workoutDocRev: 1,
      courseSession: 1,
      planId: p,
      effectiveDate: MON,
      effectiveTime: "18:15",
      sourceContentFingerprint: "studio",
      // A course that says nothing of the watch goes to it, as any session does.
      watchOff: false,
    });
    expect(docOriginRow(r)).toBe(true);
    expect(revisability({ origin: r.origin, category: r.category, sport: r.sport, completionState: r.completionState, contentState: r.contentState, effectiveDate: r.effectiveDate, hasDoc: true, isRun: false }, MON)).toEqual({ ok: true, adopts: false });
    expect(rowRefusal(r, WATCH_ON, { today: MON, prefs: { corosWritesEnabled: true } })).toBeNull();

    expect(await mirrorMark(id)).toMatchObject({ kind: "mirror", targetId: id, userId, resolvedAt: null });
    const [revision] = await revisionsOf(id);
    expect(revision).toMatchObject({ rev: 1, sourceKind: "studio", sourceRef: doc.source.ref, doc: r.workoutDoc });

    const built = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(built.session.build?.fromDoc).toMatchObject({ rev: 1, blocked: [] });
    expect(built.session.build?.engineVersion).toMatch(/^doc-build-/);
  });

  it("a mark the mirror settled earlier is open again", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await markMirrorOwed(db, userId, id, "2026-10-01T00:00:00.000Z");
    await db.update(syncIntents).set({ resolvedAt: "2026-10-02T00:00:00.000Z", payload: { held: true } }).where(eq(syncIntents.id, mirrorIntentId(id)));
    await writeCourseSession(db, userId, await row(id), ctx);
    expect(await mirrorMark(id)).toMatchObject({ resolvedAt: null, createdAt: NOW, payload: {} });
  });

  it("its event is asked to update when the write changes what it shows", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await db.update(plannedWorkouts).set({ calendarSyncState: "synced" }).where(eq(plannedWorkouts.id, id));
    await writeCourseSession(db, userId, await row(id), ctx);
    expect((await row(id)).calendarSyncState).toBe("pending");
  });

  it("a longer session than its outline booked gives way on its day: the collision pass runs", async () => {
    const p = await seedCourse();
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const id = slotId(p, MON);
    // Two done since this outline was booked: it holds 15 minutes, and session 3 takes 25.
    await session(p, addDays(MON, -7), 1, "completed");
    await session(p, addDays(MON, -3), 2, "completed");
    const other = await filed(elsewhere(p), MON, "scheduled", { title: "Other", effectiveTime: "19:50", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800 });
    expect((await row(id)).calendarBlockDurationSeconds).toBe(INTRO_FIRST_BOOKED);

    await writeCourseSession(db, userId, await row(id), ctx);
    const [mine, theirs] = [await row(id), await row(other)];
    expect(mine.calendarBlockDurationSeconds).toBe(INTRO_LATER_BOOKED);
    const start = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const [first, second] = start(mine.effectiveTime) <= start(theirs.effectiveTime) ? [mine, theirs] : [theirs, mine];
    expect(start(first.effectiveTime) + first.calendarBlockDurationSeconds / 60).toBeLessThanOrEqual(start(second.effectiveTime));
  });

  it("an open answers with its build, and leaves its event to the half-hourly sync: no request pays for the calendar", async () => {
    const p = await placed();
    await db.update(plannedWorkouts).set({ calendarSyncState: "synced" }).where(eq(plannedWorkouts.id, slotId(p, MON)));
    const out = await buildSessionOutcome(db, userId, slotId(p, MON), {}, ctx);
    expect(out.calendarChanged).toBe(false);
    expect((await row(slotId(p, MON))).calendarSyncState).toBe("pending");
    expect(out.session.origin).toBe("studio");
    expect(out.session.build?.items[0]?.exerciseId).toBe("legsUp");
  });
});

describe("a session kept off the watch: the row's own state, which a course kept off the watch places", () => {
  // The made-up course, flagged for these tests alone: worker code reads the flag, never which course it is.
  beforeEach(() => {
    INTRO_COURSE.watch = false;
  });
  afterEach(() => {
    delete INTRO_COURSE.watch;
  });

  /** The flip, where it touches `watch_off`: it never does. */
  const flipTouches = (written: readonly string[]) => written.filter((s) => /^update "planned_workouts"/.test(s) && /"watch_off"/.test(s));

  it("its outline was placed kept off, and the write leaves it so: the mark finds nothing owed, in the batch of 4", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const stale = await row(id);
    expect(stale.watchOff).toBe(true);
    statements.length = 0;
    expect(await writeCourseSession(db, userId, stale, ctx)).toEqual({ written: true, n: 1 });
    const spent = [...statements];
    const r = await row(id);
    expect(r).toMatchObject({ origin: "studio", courseSession: 1, title: titleOf(1), watchOff: true });
    expect(docOf(r)).toEqual(INTRO_COURSE.sessionDoc(1, { ease: false }));
    expect(await mirrorMark(id)).toBeUndefined();
    // The mirror would refuse it for the athlete's own reason, so it reads as kept off, never as owed.
    expect(rowRefusal(r, WATCH_ON, { today: MON, prefs: { corosWritesEnabled: true } })).toBe("kept_off");
    // Its plan, the sessions done, the restore's look, the profiles, the library, then the flip, the note, the mark and the
    // revision: what any course's write spends.
    expect(spent).toHaveLength(1 + 1 + 1 + 1 + 1 + 4);
    expect(flipTouches(spent.filter(isWrite))).toEqual([]);
  });

  it("eased, the easing is cleared beside it: still no mark", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(true);
    expect((await row(id)).watchOff).toBe(true);
    expect((await programOf(p)).config.easeNext).toBe(false);
    expect(holdOf(docOf(await row(id)))).toBe(INTRO_FIRST_SECONDS / 2);
    expect(await mirrorMark(id)).toBeUndefined();
  });

  it("the hourly pass writes it kept off too", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect((await row(id)).watchOff).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
  });

  it("so does the session being opened, and its day's build stands as any other's", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const opened = await loadSession(db, userId, id, MON);
    expect(opened.origin).toBe("studio");
    expect((await row(id)).watchOff).toBe(true);
    const built = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(built.session.build?.fromDoc).toMatchObject({ rev: 1, blocked: [] });
    expect((await row(id)).watchOff).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
  });

  it("an outline the athlete put on is written on, and owed its copy", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await db.update(plannedWorkouts).set({ watchOff: false }).where(eq(plannedWorkouts.id, id));
    statements.length = 0;
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(true);
    expect(flipTouches(writes())).toEqual([]);
    expect((await row(id)).watchOff).toBe(false);
    expect(await mirrorMark(id)).toMatchObject({ kind: "mirror", targetId: id, resolvedAt: null, createdAt: NOW });
  });

  it("a course that says nothing of the watch: an outline the athlete kept off is written kept off, and owed nothing", async () => {
    delete INTRO_COURSE.watch;
    const p = await placed();
    const id = slotId(p, MON);
    expect((await row(id)).watchOff).toBe(false);
    await db.update(plannedWorkouts).set({ watchOff: true }).where(eq(plannedWorkouts.id, id));
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(true);
    expect((await row(id)).watchOff).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
  });

  it("a write its guard refuses changes nothing, and marks nothing", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const stale = await row(id);
    await db.update(plannedWorkouts).set({ completionState: "skipped", watchOff: false }).where(eq(plannedWorkouts.id, id));
    const now = await row(id);
    expect((await writeCourseSession(db, userId, stale, ctx)).written).toBe(false);
    expect(await row(id)).toEqual(now);
    expect(await mirrorMark(id)).toBeUndefined();
  });
});

/** A plan id that isn't the course's, for a session of some other plan on its day. */
function elsewhere(planId: string): string {
  return `${planId}-other`;
}

describe("a day ahead", () => {
  it("a day ahead previews without storing", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    const before = await row(id);
    const { session: s, calendarChanged } = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(calendarChanged).toBe(false);
    expect(s.build).toMatchObject({ version: 0, date: day(0, 2), fromDoc: { rev: null, blocked: [] } });
    // The dose shown: the course's first session, as the player would play it.
    expect(s.build?.items[0]?.exerciseId).toBe("legsUp");
    expect(s.build?.steps).toEqual(playerStepsFromDoc(realSessionDoc(1, { ease: false }), EXERCISES));
    expect(s.title).toBe(before.title);
    expect(s.choices).toEqual({ modes: [], themes: [], locations: [] });

    const after = await row(id);
    expect(after).toEqual(before);
    expect(after.workoutDoc).toBeNull();
    expect(after.origin).toBe("program");
    expect(after.courseSession).toBeNull();
    expect(await revisionsOf(id)).toEqual([]);
    expect(await mirrorMark(id)).toBeUndefined();
  });

  it("the preview follows the sessions done: asked again after one is done, it says the next dose", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    const stepsFor = (n: number) => playerStepsFromDoc(realSessionDoc(n, { ease: false }), EXERCISES);
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build?.steps).toEqual(stepsFor(1));
    await session(p, addDays(MON, -7), 1, "completed");
    await session(p, addDays(MON, -3), 2, "completed");
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build?.steps).toEqual(stepsFor(3));
    expect((await buildsOf(id)).filter((b) => b.version === 0)).toHaveLength(1);
  });

  it("asked again with nothing changed writes nothing, and reads as current", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    const first = await buildSessionOutcome(db, userId, id, {}, ctx);
    statements.length = 0;
    const again = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(writes()).toEqual([]);
    expect(again.session.build?.buildId).toBe(first.session.build?.buildId);
    expect(await sessionCurrency(db, userId, id, ctx)).toMatchObject({ buildId: first.session.build?.buildId, current: true });

    // The dose moves on: the preview shown isn't what the day would make now.
    await session(p, addDays(MON, -7), 1, "completed");
    await session(p, addDays(MON, -3), 2, "completed");
    expect(await sessionCurrency(db, userId, id, ctx)).toMatchObject({ current: false });
  });

  it("a preview doesn't touch the outline: a pause still takes it", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    await buildSessionOutcome(db, userId, id, {}, ctx);
    await setPause(p, day(0, 2));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await row(id)).archivedAt).not.toBeNull();
  });

  it("a day gone is refused, as any", async () => {
    const p = await placed();
    await expect(buildSessionOutcome(db, userId, slotId(p, MON), {}, { ...ctx, today: addDays(MON, 1) })).rejects.toThrow("not_today");
  });
});

describe("matching", () => {
  it("an unrelated activity doesn't complete a written session, though it completes a workout the coach filed", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    // A same-day activity that scores well: its stand-in, filed under the plan with no number, shows it would match.
    const control = await filed(p, day(0, 1), "scheduled", { effectiveTime: "18:15", fallbackEstimatedDurationSeconds: INTRO_FIRST_SECONDS });
    await ingestActivities(db, { userId, sources: [strengthOnMonday("a-1")] });
    expect((await row(id)).completionState).toBe("scheduled");
    expect(await courseSessionsDone(db, userId, p)).toBe(0);
    expect((await row(control)).completionState).toBe("completed");
  });

  it("an unrelated activity doesn't complete an outline either", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const stats = await ingestActivities(db, { userId, sources: [strengthOnMonday("a-0", { sport: "yoga" })] });
    expect(stats.completions).toBe(0);
    expect(await row(id)).toMatchObject({ completionState: "scheduled", courseSession: null });
  });

  it("still doesn't with a wire fingerprint on it: the number is the mark, not the fingerprint", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    await stamp(id, WIRE);
    const stats = await ingestActivities(db, { userId, sources: [strengthOnMonday("a-2", { sport: "yoga" })] });
    expect(stats.completions).toBe(0);
    expect((await row(id)).completionState).toBe("scheduled");
    expect((await row(id)).sourceContentFingerprint).toBe(WIRE);
  });

  it("its own copy on the watch does: an activity linked by its COROS program completes it, and the number moves", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    await db.update(plannedWorkouts).set({ sourceProgramId: "program-7" }).where(eq(plannedWorkouts.id, id));
    await ingestActivities(db, { userId, sources: [strengthOnMonday("a-3", { sourcePlannedWorkoutId: "program-7" })] });
    expect(await row(id)).toMatchObject({ completionState: "completed", courseSession: 1 });
    expect(await courseSessionsDone(db, userId, p)).toBe(1);
  });
});

describe("a restore", () => {
  it("a restore in progress writes nothing", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const before = await row(id);
    await beginRestore();
    statements.length = 0;
    expect((await writeCourseSession(db, userId, before, ctx)).written).toBe(false);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    await loadSession(db, userId, id, MON);
    await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(writes()).toEqual([]);
    expect(await row(id)).toEqual(before);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
  });

  it("one beginning as the write runs stops all of it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const before = await row(id);
    // A refusal's note from earlier in the day: the write that doesn't land doesn't take it away.
    const spy = vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(unplayable);
    await writeCourseSession(db, userId, before, ctx);
    spy.mockRestore();
    race.begin = beginRestore;
    expect((await writeCourseSession(db, userId, before, ctx)).written).toBe(false);
    expect(await row(id)).toEqual(before);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
    expect(await revisionsOf(id)).toEqual([]);
    expect(await activeSyncNotes(db, userId)).toHaveLength(1);
  });

  it("one beginning as a refusal is noted leaves no note", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await placed();
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(unplayable);
    race.begin = beginRestore;
    expect((await writeCourseSession(db, userId, await row(slotId(p, MON)), ctx)).written).toBe(false);
    expect(await activeSyncNotes(db, userId)).toEqual([]);
  });
});

describe("a document the day refuses", () => {
  it("a document the day refuses leaves the outline and a note", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const before = await row(id);
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(unplayable);

    expect((await writeCourseSession(db, userId, before, ctx)).written).toBe(false);
    // The hour after, and an open, refuse again: still one note.
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    const { session: s, calendarChanged } = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(s.build).toBeNull();
    expect(calendarChanged).toBe(false);

    expect(await row(id)).toEqual(before);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
    // Each of the three asked once: an opening tries again only for a lost claim, and a refusal isn't one.
    expect(INTRO_COURSE.sessionDoc).toHaveBeenCalledTimes(3);
    const notes = await activeSyncNotes(db, userId);
    expect(notes.map((n) => ({ kind: n.kind, workoutId: n.workoutId }))).toEqual([{ kind: "course_session_refused", workoutId: id }]);
    expect(notes[0]!.payload).toEqual({ sessionTitle: before.title, date: MON });
    // By code alone: no title, no move.
    expect(error).toHaveBeenCalledWith(`course_session_refused: program ${p} unknown_exercise`);
    for (const call of error.mock.calls) expect(String(call[0])).not.toContain("noSuchMove");
  });

  it("the day's own reading refuses it, and once the reading clears it's written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
    const p = await placed();
    const id = slotId(p, MON);
    // A jump with no alternate: a condition's gate keeps it out while the athlete feels off.
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(() => landingsDoc({ alternates: false }));
    const answer = { today: MON, now: NOW };
    await recordCheck(db, userId, { profileId: "tmj", value: 6, feelingOff: true }, answer);
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(false);
    expect((await row(id)).origin).toBe("program");

    await recordCheck(db, userId, { profileId: "tmj", value: 1, feelingOff: false }, answer);
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(true);
    expect((await row(id)).origin).toBe("studio");
  });

  it("a note dismissed stays dismissed while the day keeps refusing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await placed();
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(unplayable);
    await writeCourseSessionsDue(db, AT);
    const [note] = await activeSyncNotes(db, userId);
    await db.update(schema.syncNotes).set({ dismissedAt: NOW }).where(eq(schema.syncNotes.id, note!.id));
    await writeCourseSession(db, userId, await row(slotId(p, MON)), ctx);
    expect(await activeSyncNotes(db, userId)).toEqual([]);
  });

  it("once the day allows it, it's written and the note goes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await placed();
    const spy = vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(unplayable);
    await writeCourseSessionsDue(db, AT);
    expect(await activeSyncNotes(db, userId)).toHaveLength(1);
    spy.mockRestore();
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect((await row(slotId(p, MON))).origin).toBe("studio");
    expect(await activeSyncNotes(db, userId)).toEqual([]);
  });

  it("its note can only be dismissed: there's nothing to undo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await placed();
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(unplayable);
    await writeCourseSessionsDue(db, AT);
    const [note] = await activeSyncNotes(db, userId);
    const res = await mountRoutes(db, "/api/sync", syncRoutes).request(`/api/sync/notes/${note!.id}/undo`, { method: "POST", headers: { Cookie: await cookieFor() } }, WATCH_ON);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_undoable" });
  });
});

describe("a pause", () => {
  /** Today's outline moved in or re-timed, so a pause's retraction leaves it: what's left for the writer to hold back on. */
  const survivors = [
    [
      "moved onto today",
      async (p: string) => {
        const id = slotId(p, day(0, 2));
        await move(id, MON);
        return id;
      },
    ],
    [
      "re-timed on today",
      async (p: string) => {
        const id = slotId(p, MON);
        await db.insert(scheduleOverrides).values({ id: newId(), workoutId: id, kind: "time_change", fromDate: MON, toDate: MON, toTime: "18:00", source: "app", createdAt: NOW });
        return id;
      },
    ],
  ] as const;

  it.each(survivors)("the hourly pass holds while it covers today: %s", async (_, survive) => {
    const p = await placed();
    const id = await survive(p);
    await setPause(p, MON);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const before = await row(id);
    expect(before.archivedAt).toBeNull();
    statements.length = 0;
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect(writes()).toEqual([]);
    expect(await row(id)).toEqual(before);
  });

  it.each(survivors)("an open holds while it covers today: %s", async (_, survive) => {
    const p = await placed();
    const id = await survive(p);
    await setPause(p, addDays(MON, 2));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const before = await row(id);
    expect(before.archivedAt).toBeNull();
    statements.length = 0;
    const read = await loadSession(db, userId, id, MON);
    expect(read).toMatchObject({ origin: "program", build: null });
    const { session: built, calendarChanged } = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(calendarChanged).toBe(false);
    expect(built).toMatchObject({ origin: "program", build: null, choices: { modes: [], themes: [], locations: [] } });
    expect(writes()).toEqual([]);
    expect(await row(id)).toEqual(before);
    expect(await buildsOf(id)).toEqual([]);
  });

  it("a pause that ended yesterday holds nothing", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await setPause(p, addDays(MON, -1));
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(true);
  });

  it("a pause landing as the write runs stops it", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const before = await row(id);
    race.begin = () => setPause(p, MON).then(() => undefined);
    expect((await writeCourseSession(db, userId, before, ctx)).written).toBe(false);
    expect(await row(id)).toEqual(before);
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await mirrorMark(id)).toBeUndefined();
  });
});

describe("never the engine", () => {
  it("a course outline never reaches the engine and gets no default-settings session", async () => {
    const plan = vi.spyOn(Planner, "planToday");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await placed();
    await setPause(p, MON);
    const id = slotId(p, day(0, 2));
    await move(id, MON);
    await db.insert(scheduleOverrides).values({ id: newId(), workoutId: slotId(p, MON), kind: "time_change", fromDate: MON, toDate: MON, toTime: "18:00", source: "app", createdAt: NOW });

    // Held on its day, ahead, read, built, asked whether it's current: the same answer, and no engine.
    for (const workoutId of [id, slotId(p, MON)]) {
      await loadSession(db, userId, workoutId, MON);
      await buildSessionOutcome(db, userId, workoutId, {}, ctx);
      await sessionCurrency(db, userId, workoutId, ctx);
    }
    const ahead = slotId(p, day(1, 0));
    await buildSessionOutcome(db, userId, ahead, {}, ctx);
    await sessionCurrency(db, userId, ahead, ctx);
    expect(plan).not.toHaveBeenCalled();
    // Reading its course's settings as a programme's would log this, and build with the defaults.
    for (const call of error.mock.calls) expect(String(call[0])).not.toContain("does not parse");
    for (const b of [...(await buildsOf(id)), ...(await buildsOf(ahead))]) expect(b.engineVersion).toMatch(/^doc-build-/);
    expect(await buildsOf(id)).toEqual([]);
  });

  it("the engine's context refuses a course's plan: a reader that misses it fails, never builds with the defaults", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await seedCourse();
    await expect(loadEngineContext(db, userId, p, {})).rejects.toThrow("program_is_course");
    expect(error).not.toHaveBeenCalled();
  });

  it("a row of a course that somehow holds a build answers no_document, never the engine", async () => {
    const plan = vi.spyOn(Planner, "planToday");
    const p = await placed();
    const id = slotId(p, MON);
    await db.update(plannedWorkouts).set({ contentState: "built" }).where(eq(plannedWorkouts.id, id));
    expect(await courseOf(db, userId, await row(id))).toBeNull();
    await expect(buildSessionOutcome(db, userId, id, {}, ctx)).rejects.toBeInstanceOf(NoDocumentError);
    expect(plan).not.toHaveBeenCalled();
  });

  it("the hourly pass doesn't try a row of a course that isn't an outline", async () => {
    const p = await placed();
    await db.update(plannedWorkouts).set({ contentState: "built" }).where(eq(plannedWorkouts.id, slotId(p, MON)));
    statements.length = 0;
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect(statements).toHaveLength(1);
  });

  it("the hourly pass doesn't try another day's outline, though its read reaches a day either side: it would take the pass's room", async () => {
    await placed({ weekdays: [1] }); // Tuesday's, and today is Monday in the athlete's zone.
    statements.length = 0;
    rowsRead.length = 0;
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect(rowsRead).toEqual([1]);
    expect(statements).toHaveLength(1);
  });

  it("the hourly pass's read hands back no other kind's slots, due or not", async () => {
    const p = newId();
    await db.insert(programs).values({
      id: p, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 4], defaultMinutes: 30 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    await placeSlots(db, userId, p, MON, prefs, "2026-10-05T12:00:00.000Z");
    expect((await row(slotId(p, MON))).origin).toBe("program");
    rowsRead.length = 0;
    await writeCourseSessionsDue(db, AT);
    expect(rowsRead).toEqual([0]);
  });

  it("the hourly pass doesn't try a workout the coach filed under the plan, or a session already written", async () => {
    const p = await placed();
    await filed(p, MON, "scheduled", { effectiveTime: "07:00" });
    await writeCourseSession(db, userId, await row(slotId(p, MON)), ctx);
    statements.length = 0;
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect(statements).toHaveLength(1);
  });

  it("Start on an outline is not built: nothing to lock", async () => {
    const p = await placed();
    await setPause(p, MON);
    const id = slotId(p, MON);
    await expect(lockCurrentBuild(db, userId, id, "b", NOW, { as: "start", prefs })).rejects.toBeInstanceOf(NotBuiltError);
  });

  it("an adaptive programme's slot is still the engine's", async () => {
    const plan = vi.spyOn(Planner, "planToday");
    const p = newId();
    await db.insert(programs).values({
      id: p, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 4], defaultMinutes: 30 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    await placeSlots(db, userId, p, MON, prefs, "2026-10-05T12:00:00.000Z");
    const id = slotId(p, MON);
    expect(await courseOf(db, userId, await row(id))).toBeNull();
    const { session: s } = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(plan).toHaveBeenCalled();
    expect(s.build?.fromDoc).toBeUndefined();
    expect(s.choices.modes.length).toBeGreaterThan(0);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect((await row(id)).origin).toBe("program");
  });

  describe("a course whose definition is gone", () => {
    it("writes nothing and builds nothing, whichever asks, and says so by code", async () => {
      const plan = vi.spyOn(Planner, "planToday");
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const p = await placed();
      await db.update(programs).set({ config: { ...(await programOf(p)).config, course: "gone" } }).where(eq(programs.id, p));
      const id = slotId(p, MON);
      const ahead = slotId(p, day(0, 2));
      const before = await row(id);

      expect(await writeCourseSession(db, userId, before, ctx)).toMatchObject({ written: false });
      expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
      expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build).toBeNull();
      expect((await buildSessionOutcome(db, userId, ahead, {}, ctx)).session.build).toBeNull();
      expect((await loadSession(db, userId, id, MON)).choices).toEqual({ modes: [], themes: [], locations: [] });
      expect(await sessionCurrency(db, userId, ahead, ctx)).toMatchObject({ current: false });

      expect(await row(id)).toEqual(before);
      expect(plan).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(`course_definition_missing: program ${p}`);
    });

    it("a preview made before it went is no longer current: nothing could make it now", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const p = await placed();
      const ahead = slotId(p, day(0, 2));
      const shown = (await buildSessionOutcome(db, userId, ahead, {}, ctx)).session.build;
      expect(shown?.version).toBe(0);
      await db.update(programs).set({ config: { ...(await programOf(p)).config, course: "gone" } }).where(eq(programs.id, p));
      expect(await sessionCurrency(db, userId, ahead, ctx)).toMatchObject({ buildId: shown?.buildId, current: false });
    });

    it("a stopped one needs no definition, and says nothing", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const p = await placed();
      await db.update(programs).set({ status: "retired", config: { ...(await programOf(p)).config, course: "gone" } }).where(eq(programs.id, p));
      expect(await courseOf(db, userId, await row(slotId(p, MON)))).toMatchObject({ definition: null });
      expect(error).not.toHaveBeenCalled();
    });

    it("a course whose stored settings don't read is treated the same", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const p = await placed();
      await db.update(programs).set({ config: { nothing: true } }).where(eq(programs.id, p));
      const outline = await courseOf(db, userId, await row(slotId(p, MON)));
      expect(outline).toMatchObject({ definition: null, easeNext: false });
      expect((await writeCourseSession(db, userId, await row(slotId(p, MON)), ctx)).written).toBe(false);
    });
  });

  it("courseOf is null for anything but an outline of a course, with no statement for a row that isn't a programme's", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    expect(await courseOf(db, userId, await row(id))).toMatchObject({ program: { id: p }, definition: { id: INTRO_COURSE.id }, easeNext: false });

    const studio = await filed(p, day(0, 1), "scheduled");
    statements.length = 0;
    expect(await courseOf(db, userId, await row(studio))).toBeNull();
    expect(statements.filter((s) => /"programs"/.test(s))).toEqual([]);

    await writeCourseSession(db, userId, await row(id), ctx);
    expect(await courseOf(db, userId, await row(id))).toBeNull();

    // Another account's plan is no plan of this account's.
    const { userId: stranger } = await makeTestUser(db);
    expect(await courseOf(db, stranger, await row(slotId(p, day(0, 2))))).toBeNull();
  });

  it("the review basis reads a course's own week: its days, not a programme's default goal", async () => {
    const p = await placed({ weekdays: [0, 2, 4] });
    const id = slotId(p, MON);
    await buildSessionOutcome(db, userId, id, {}, ctx);
    const basis = await reviewBasis(db, userId, id, { today: MON, unit: "kg" });
    expect(basis.records.weeklyGoal).toBe(3);
  });

  it("the review basis of a course whose settings don't read falls back to the default goal", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await buildSessionOutcome(db, userId, id, {}, ctx);
    await db.update(programs).set({ config: { nothing: true } }).where(eq(programs.id, p));
    expect((await reviewBasis(db, userId, id, { today: MON, unit: "kg" })).records.weeklyGoal).toBe(4);
  });

  it("the review basis of an adaptive programme's session keeps its goal", async () => {
    const p = newId();
    await db.insert(programs).values({
      id: p, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 4], defaultMinutes: 30 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    await placeSlots(db, userId, p, MON, prefs, "2026-10-05T12:00:00.000Z");
    await buildSessionOutcome(db, userId, slotId(p, MON), {}, ctx);
    expect((await reviewBasis(db, userId, slotId(p, MON), { today: MON, unit: "kg" })).records.weeklyGoal).toBe(2);
  });

  it("the body check takes a course's outline as a designed workout: it offers the coach, and builds nothing", async () => {
    const plan = vi.spyOn(Planner, "planToday");
    const p = await placed();
    const id = slotId(p, MON);
    const before = await row(id);
    const out = await answerBodyCheck(db, userId, id, { feel: "heavy", areas: [] }, ctx);
    expect(out.view.change).toEqual({ kind: "ask" });
    expect(await row(id)).toEqual(before);
    expect(await buildsOf(id)).toEqual([]);
    expect(plan).not.toHaveBeenCalled();
  });
});

describe("completing an outline never written", () => {
  async function linkManually(workoutId: string, activityId: string) {
    const res = await mountRoutes(db, "/api/plan", planRoutes).request(
      `/api/plan/workouts/${workoutId}/match`,
      { method: "POST", headers: { Cookie: await cookieFor(), "content-type": "application/json" }, body: JSON.stringify({ activityId }) },
      WATCH_ON,
    );
    expect(res.status, await res.clone().text()).toBe(200);
  }

  it("a manual link gives it its number in the same write, and no document", async () => {
    const p = await placed();
    await session(p, addDays(MON, -14), 1, "completed");
    await session(p, addDays(MON, -10), 2, "completed");
    // None of these moves it: written and missed, filed with no number, and another course's.
    await session(p, addDays(MON, -7), 3, "missed");
    await filed(p, addDays(MON, -5), "completed");
    const other = await seedCourse();
    await session(other, addDays(MON, -3), 1, "completed");
    const id = slotId(p, MON);
    await linkManually(id, await activityOn(MON));

    expect(await row(id)).toMatchObject({ origin: "program", completionState: "completed", courseSession: 3, workoutDoc: null, workoutDocRev: null });
    expect(await revisionsOf(id)).toEqual([]);
    expect(await courseSessionsDone(db, userId, p)).toBe(3);

    // The next session moves on: the number didn't stand still.
    const next = await row(slotId(p, day(0, 2)));
    expect(await writeCourseSession(db, userId, next, { ...ctx, today: day(0, 2) })).toEqual({ written: true, n: 4 });
  });

  it("undone, it stops counting; linked again, it takes the number it has then", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await linkManually(id, await activityOn(MON));
    expect(await courseSessionsDone(db, userId, p)).toBe(1);
    const res = await mountRoutes(db, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}/unmatch`, { method: "POST", headers: { Cookie: await cookieFor() } }, WATCH_ON);
    expect(res.status).toBe(200);
    expect(await courseSessionsDone(db, userId, p)).toBe(0);

    await session(p, addDays(MON, -7), 1, "completed");
    await linkManually(id, await activityOn(addDays(MON, -1)));
    expect((await row(id)).courseSession).toBe(2);
    expect(await courseSessionsDone(db, userId, p)).toBe(2);
  });

  it("an activity linked by its COROS program gives it its number too", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await db.update(plannedWorkouts).set({ sourceProgramId: "program-9" }).where(eq(plannedWorkouts.id, id));
    await ingestActivities(db, { userId, sources: [strengthOnMonday("a-9", { sourcePlannedWorkoutId: "program-9" })] });
    expect(await row(id)).toMatchObject({ origin: "program", completionState: "completed", courseSession: 1, workoutDoc: null });
    expect(await courseSessionsDone(db, userId, p)).toBe(1);
  });

  it("an app save gives it its number too", async () => {
    const p = await placed();
    await session(p, addDays(MON, -7), 1, "completed");
    const id = slotId(p, MON);
    const performedId = "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0d";
    const saved = await savePerformedSession(
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
    expect(saved.status).toBe("saved");
    expect(await row(id)).toMatchObject({ origin: "program", completionState: "completed", contentState: "done", courseSession: 2, workoutDoc: null });
  });

  it("a written session keeps the number it was written as", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    await session(p, addDays(MON, -7), 1, "completed");
    await linkManually(id, await activityOn(MON));
    expect(await row(id)).toMatchObject({ origin: "studio", completionState: "completed", courseSession: 1 });
  });

  it("nothing else takes a number: an adaptive slot, a workout the coach filed", async () => {
    const adaptive = newId();
    await db.insert(programs).values({
      id: adaptive, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 4], defaultMinutes: 30 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    await placeSlots(db, userId, adaptive, MON, prefs, "2026-10-05T12:00:00.000Z");
    await linkManually(slotId(adaptive, MON), await activityOn(MON));
    expect((await row(slotId(adaptive, MON))).courseSession).toBeNull();

    const p = await placed();
    const extra = await filed(p, MON, "scheduled");
    await linkManually(extra, await activityOn(addDays(MON, -1)));
    expect((await row(extra)).courseSession).toBeNull();
    expect(await courseSessionsDone(db, userId, p)).toBe(0);
  });
});

describe("what the document was computed from", () => {
  const HALF = INTRO_FIRST_SECONDS / 2;
  /** Today's outline, and Wednesday's moved onto today, with the next session eased. */
  const twoToday = async () => {
    const p = await placed({ easeNext: true });
    const a = slotId(p, MON);
    const b = slotId(p, day(0, 2));
    await move(b, MON);
    return { p, a, b };
  };
  const holds = (...ids: string[]) => Promise.all(ids.map(async (id) => holdOf(docOf(await row(id)))));
  /** Lands as the first document is made: past every read, before the batch. Synchronous, as `sessionDoc` is. */
  const asTheDocumentIsMade = (land: () => void) => {
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementationOnce((n, opts) => {
      land();
      return realSessionDoc(n, opts);
    });
  };

  it("two outlines on one day: the hourly pass eases one, and the other is written full by the next", async () => {
    const { p, a, b } = await twoToday();
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect(await holds(a)).toEqual([HALF]);
    expect((await row(b)).origin).toBe("program");
    expect((await programOf(p)).config.easeNext).toBe(false);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect(await holds(a, b)).toEqual([HALF, INTRO_FIRST_SECONDS]);
  });

  it.each([
    ["today's first", "a", "b"],
    ["the moved one first", "b", "a"],
  ] as const)("two outlines opened in turn, %s: the first opened is eased", async (_, first, second) => {
    const ids = await twoToday();
    await loadSession(db, userId, ids[first], MON);
    await loadSession(db, userId, ids[second], MON);
    expect(await holds(ids[first], ids[second])).toEqual([HALF, INTRO_FIRST_SECONDS]);
    expect((await programOf(ids.p)).config.easeNext).toBe(false);
  });

  it("the pass, then an open: the one eased, the other full", async () => {
    const { a, b } = await twoToday();
    await writeCourseSessionsDue(db, AT);
    await loadSession(db, userId, b, MON);
    expect(await holds(a, b)).toEqual([HALF, INTRO_FIRST_SECONDS]);
  });

  it("an open, then the pass: the one eased, the other full", async () => {
    const { a, b } = await twoToday();
    await loadSession(db, userId, b, MON);
    await writeCourseSessionsDue(db, AT);
    expect(await holds(a, b)).toEqual([INTRO_FIRST_SECONDS, HALF]);
  });

  it("two writers at once, each having read the easing: only one uses it, and the other writes nothing at all", async () => {
    const { p, a, b } = await twoToday();
    const [ra, rb] = [await row(a), await row(b)];
    race.begin = async () => {
      await writeCourseSession(db, userId, rb, ctx);
    };
    expect(await writeCourseSession(db, userId, ra, ctx)).toEqual({ written: false, n: 1 });
    expect(await row(a)).toMatchObject({ origin: "program", workoutDoc: null, courseSession: null, title: ra.title });
    expect(await mirrorMark(a)).toBeUndefined();
    expect(await revisionsOf(a)).toEqual([]);
    expect(await holds(b)).toEqual([HALF]);
    expect((await programOf(p)).config.easeNext).toBe(false);
  });

  it("two opens at once: the one that lost the easing re-reads and writes the session full, there and then", async () => {
    const { a, b } = await twoToday();
    const rb = await row(b);
    race.begin = async () => {
      await writeCourseSession(db, userId, rb, ctx);
    };
    expect((await loadSession(db, userId, a, MON)).origin).toBe("studio");
    expect(await holds(a, b)).toEqual([INTRO_FIRST_SECONDS, HALF]);
  });

  it("the same through a build: the easing gone as the document is made, it goes on to build what it wrote the second time", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const config = { ...(await programOf(p)).config, easeNext: false };
    asTheDocumentIsMade(() => (db.update(programs).set({ config }).where(eq(programs.id, p)) as unknown as { run(): void }).run());
    const { session: s } = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(s.origin).toBe("studio");
    expect(s.build?.steps).toEqual(playerStepsFromDoc(realSessionDoc(1, { ease: false }), EXERCISES));
    expect(await holds(id)).toEqual([INTRO_FIRST_SECONDS]);
  });

  const withdraw = (p: string) => async () => {
    await db.update(programs).set({ config: { ...(await programOf(p)).config, easeNext: false } }).where(eq(programs.id, p));
  };
  const ask = (p: string) => async () => {
    await db.update(programs).set({ config: { ...(await programOf(p)).config, easeNext: true } }).where(eq(programs.id, p));
  };

  it("an easing withdrawn after the read isn't used: the pass leaves it for the next hour", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const before = await row(id);
    race.begin = withdraw(p);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect(await row(id)).toEqual(before);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect(await holds(id)).toEqual([INTRO_FIRST_SECONDS]);
  });

  it("an easing withdrawn after the read isn't used: an open re-reads and writes it full", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    race.begin = withdraw(p);
    await loadSession(db, userId, id, MON);
    expect(await holds(id)).toEqual([INTRO_FIRST_SECONDS]);
  });

  it("an easing asked for after the read isn't missed: an open re-reads, uses it and clears it", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    race.begin = ask(p);
    await loadSession(db, userId, id, MON);
    expect(await holds(id)).toEqual([HALF]);
    expect((await programOf(p)).config.easeNext).toBe(false);
  });

  it("an easing asked for after the read waits with the pass, and the next pass uses it", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    race.begin = ask(p);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect((await programOf(p)).config.easeNext).toBe(true);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect(await holds(id)).toEqual([HALF]);
  });

  it("a completion between the read and the batch writes no stale number: the pass leaves it, and the next writes the next dose", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const before = await row(id);
    race.begin = async () => {
      await session(p, addDays(MON, -3), 1, "completed");
    };
    expect(await writeCourseSession(db, userId, before, ctx)).toEqual({ written: false, n: 1 });
    expect(await row(id)).toEqual(before);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect(await row(id)).toMatchObject({ courseSession: 2, title: titleOf(2) });
  });

  it("a completion between the read and the batch: an opening re-reads and writes the right number, there and then", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    race.begin = async () => {
      await session(p, addDays(MON, -3), 1, "completed");
    };
    expect((await loadSession(db, userId, id, MON)).title).toBe(titleOf(2));
    expect(await row(id)).toMatchObject({ origin: "studio", courseSession: 2 });
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  /** Each document made finds its guard moved: a session done lands as it's made. */
  const landsADoneSessionEachTime = (p: string) => {
    let calls = 0;
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation((n, opts) => {
      calls += 1;
      (db.insert(plannedWorkouts).values(sessionRow(p, addDays(MON, -30 + calls), calls, "completed")) as unknown as { run(): void }).run();
      return realSessionDoc(n, opts);
    });
    return () => calls;
  };

  it("an opening tries once more and only once: lost again, it answers as it stands", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const before = await row(id);
    const calls = landsADoneSessionEachTime(p);
    expect(await loadSession(db, userId, id, MON)).toMatchObject({ origin: "program", build: null });
    expect(calls()).toBe(2);
    expect(await row(id)).toEqual(before);
    expect(await revisionsOf(id)).toEqual([]);
  });

  it("the hourly pass doesn't try again: one attempt, and the row waits for the next hour", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const calls = landsADoneSessionEachTime(p);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect(calls()).toBe(1);
    expect((await row(id)).origin).toBe("program");
  });

  it("another writer got there first: an opening doesn't try again, it goes on with what's written", async () => {
    const p = await placed({ easeNext: true });
    const id = slotId(p, MON);
    const winner = await row(id);
    race.begin = async () => {
      await writeCourseSession(db, userId, winner, ctx);
    };
    const doc = vi.spyOn(INTRO_COURSE, "sessionDoc");
    expect((await loadSession(db, userId, id, MON)).origin).toBe("studio");
    // The winner's, and the loser's own: no third.
    expect(doc).toHaveBeenCalledTimes(2);
    expect(await revisionsOf(id)).toHaveLength(1);
    expect(await holds(id)).toEqual([HALF]);
  });

  it("a pause landing between the two tries stops the second", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const before = await row(id);
    race.begin = async () => {
      await session(p, addDays(MON, -3), 1, "completed");
      await setPause(p, MON);
    };
    const doc = vi.spyOn(INTRO_COURSE, "sessionDoc");
    await loadSession(db, userId, id, MON);
    expect(doc).toHaveBeenCalledTimes(1);
    expect(await row(id)).toEqual(before);
  });
});

describe("a pause on a session already written", () => {
  /** The removal's first read, which the pass only makes for a session it chose. */
  const removalReads = () => statements.filter((s) => /"origin", "content_state", "completion_state", "archived_at" from "planned_workouts"/.test(s));
  const removalNotTried = () => expect(removalReads()).toEqual([]);

  /** A course with today's session written, as the hourly pass writes it soon after midnight. */
  const written = async (config: Partial<CourseConfig> = {}) => {
    const p = await placed(config);
    const id = slotId(p, MON);
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(true);
    return { p, id };
  };

  it("today's written, untouched session comes off, and the pass then settles", async () => {
    const { p, id } = await written();
    await setPause(p, addDays(MON, 1));
    statements.length = 0;
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(res.archived).toEqual([id]);
    expect(removalReads()).toHaveLength(1);
    expect(await row(id)).toMatchObject({ archivedAt: NOW, archiveReason: "program_replaced", courseSession: 1 });
    expect((await db.select().from(syncIntents).where(eq(syncIntents.targetId, id))).filter((i) => i.kind === "remove_local").map((i) => i.source)).toEqual(["program_replace"]);
    statements.length = 0;
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([]);
    expect(writes()).toEqual([]);
    // A settled course's pass, as ever: nothing tries the row that left.
    expect(statements).toHaveLength(5);
  });

  it("an outline an undone link left a number on isn't a written session: a pause retracts it as any outline", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await db.update(plannedWorkouts).set({ courseSession: 1 }).where(eq(plannedWorkouts.id, id));
    await setPause(p, MON);
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([id]);
    expect((await row(id)).archivedAt).toBe(NOW);
  });

  it("the hourly pass takes it off too", async () => {
    const { p, id } = await written();
    await setPause(p, MON);
    expect((await placeSlotsForAllPrograms(db, AT)).archived).toBe(1);
    expect((await row(id)).archivedAt).toBe(NOW);
  });

  it("a pause that ended yesterday leaves it, and so do a race's quiet days", async () => {
    const { p, id } = await written();
    await setPause(p, addDays(MON, -1));
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([]);
    await setPause(p, null);
    expect((await placeSlots(db, userId, p, MON, { ...prefs, raceDate: addDays(MON, 3) }, NOW)).archived).not.toContain(id);
    expect((await row(id)).archivedAt).toBeNull();
  });

  it("it doesn't read as missed afterwards, and its number isn't counted: the same session comes back after the pause", async () => {
    const { p, id } = await written();
    await setPause(p, MON);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await courseSessionsDone(db, userId, p)).toBe(0);

    // Wednesday, the pause over: the next session is the one that came off.
    const wednesday = day(0, 2);
    const wed = { ...ctx, today: wednesday, now: `${wednesday}T19:00:00.000Z` };
    vi.setSystemTime(new Date(wed.now));
    expect(await writeCourseSession(db, userId, await row(slotId(p, wednesday)), wed)).toEqual({ written: true, n: 1 });
    expect((await row(slotId(p, wednesday))).title).toBe(titleOf(1));

    // A fortnight on, past the days a session is asked about and then missed.
    vi.setSystemTime(new Date("2026-10-20T19:00:00.000Z"));
    await reconcileCompletionStates(db, userId, prefs);
    expect(await row(id)).toMatchObject({ completionState: "scheduled", archivedAt: NOW });
  });

  it("a pause lifted the same day brings it back as an outline, and it's written again as the same session", async () => {
    const { p, id } = await written();
    await setPause(p, MON);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await setPause(p, null);
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(res.placed).toEqual([id]);
    expect(await row(id)).toMatchObject({ archivedAt: null, origin: "program", courseSession: null, workoutDoc: null, contentState: "outline", title: "Evening practice" });
    expect(await writeCourseSession(db, userId, await row(id), ctx)).toEqual({ written: true, n: 1 });
    expect(await row(id)).toMatchObject({ origin: "studio", courseSession: 1, workoutDocRev: 2, title: titleOf(1) });
    expect((await revisionsOf(id)).map((r) => r.rev).sort()).toEqual([1, 2]);
  });

  const stays: Array<[string, (id: string) => Promise<unknown>]> = [
    ["built", (id) => buildSessionOutcome(db, userId, id, {}, ctx)],
    [
      "started",
      async (id) => {
        const { session: s } = await buildSessionOutcome(db, userId, id, {}, ctx);
        await lockCurrentBuild(db, userId, id, s.build!.buildId, NOW, { as: "start", prefs });
      },
    ],
    ["re-timed", (id) => db.insert(scheduleOverrides).values({ id: newId(), workoutId: id, kind: "time_change", fromDate: MON, toDate: MON, toTime: "18:00", source: "app", createdAt: NOW })],
    ["completed", (id) => db.update(plannedWorkouts).set({ completionState: "completed", resolutionDate: MON }).where(eq(plannedWorkouts.id, id))],
    ["skipped", (id) => db.update(plannedWorkouts).set({ completionState: "skipped", resolutionDate: MON }).where(eq(plannedWorkouts.id, id))],
    ["moved away", (id) => move(id, day(0, 2))],
    // No override: a copy moved on the watch moves its row, and only the dates say so.
    ["moved away on the watch", (id) => db.update(plannedWorkouts).set({ effectiveDate: day(0, 2) }).where(eq(plannedWorkouts.id, id))],
    ["removed by the athlete", (id) => db.update(plannedWorkouts).set({ archivedAt: NOW, archiveReason: "user_removed" }).where(eq(plannedWorkouts.id, id))],
  ];

  it.each(stays)("one that's been %s stays, per R13, and the pass doesn't even try", async (_, touch) => {
    const { p, id } = await written();
    await touch(id);
    await setPause(p, MON);
    const before = await row(id);
    statements.length = 0;
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([]);
    expect(await row(id)).toEqual(before);
    removalNotTried();
  });

  describe("revised since it was written", () => {
    const revise = (id: string, source?: { sourceKind: "coach" }) =>
      reviseDocWorkout(db, userId, id, { doc: { ...realSessionDoc(1, { ease: false }), title: "My own version" }, baseRev: 1 }, ctx, source);

    it.each([
      ["the athlete", undefined, "athlete_edit"],
      ["the coach", { sourceKind: "coach" } as const, "coach"],
    ] as const)("by %s, it stays: a pause must never discard an edit", async (_, source, kind) => {
      const { p, id } = await written();
      await revise(id, source);
      expect((await revisionsOf(id)).map((r) => r.sourceKind).sort()).toEqual([kind, "studio"].sort());
      const before = await row(id);
      expect(before).toMatchObject({ workoutDocRev: 2, title: "My own version" });
      await setPause(p, MON);
      statements.length = 0;
      expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([]);
      expect(await row(id)).toEqual(before);
      removalNotTried();

      // Nor does lifting the pause touch it: there's nothing to bring back.
      await setPause(p, null);
      await placeSlots(db, userId, p, MON, prefs, NOW);
      expect(await row(id)).toEqual(before);
    });

    it("revised after the pass read it, it stays: the removal checks again as it archives", async () => {
      const { p, id } = await written();
      await setPause(p, MON);
      race.begin = async () => {
        race.begin = async () => {
          await revise(id);
        };
      };
      expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([]);
      expect(await row(id)).toMatchObject({ archivedAt: null, workoutDocRev: 2, title: "My own version" });
    });

    it("a session written again after a same-day lift is still the course's own, at revision 2: a later pause takes it", async () => {
      const { p, id } = await written();
      await setPause(p, MON);
      await placeSlots(db, userId, p, MON, prefs, NOW);
      await setPause(p, null);
      await placeSlots(db, userId, p, MON, prefs, NOW);
      expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(true);
      expect((await row(id)).workoutDocRev).toBe(2);
      await setPause(p, MON);
      expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([id]);
      expect((await row(id)).archivedAt).toBe(NOW);
    });

    it("it's who made the latest revision that says, not whether anyone ever made one: the history alone keeps nothing", async () => {
      const { p, id } = await written();
      // An older edit in the row's history, and the course's own write on top of it.
      await db.update(workoutDocRevisions).set({ sourceKind: "athlete_edit" }).where(eq(workoutDocRevisions.id, `${id}:1`));
      const doc = (await row(id)).workoutDoc!;
      await db.update(plannedWorkouts).set({ workoutDocRev: 2 }).where(eq(plannedWorkouts.id, id));
      await db.insert(workoutDocRevisions).values({ id: `${id}:2`, userId, workoutId: id, rev: 2, doc, sourceKind: "studio", sourceRef: null, createdAt: NOW });
      await setPause(p, MON);
      expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([id]);
    });

    it("an outline carries no revision to read: a slot is touched as it ever was", async () => {
      const p = await placed();
      await setPause(p, MON);
      expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([slotId(p, MON)]);
    });
  });

  it("one moved onto today on the watch stays too: no override, and only the dates say so", async () => {
    const p = await placed();
    const moved = slotId(p, day(0, 2));
    await db.update(plannedWorkouts).set({ effectiveDate: MON }).where(eq(plannedWorkouts.id, moved));
    expect((await writeCourseSession(db, userId, await row(moved), ctx)).written).toBe(true);
    await setPause(p, MON);
    const before = await row(moved);
    statements.length = 0;
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([slotId(p, MON)]);
    expect(await row(moved)).toEqual(before);
    removalNotTried();
  });

  it("one moved onto today stays, though today's own outline goes", async () => {
    const p = await placed();
    const moved = slotId(p, day(0, 2));
    await move(moved, MON);
    expect((await writeCourseSession(db, userId, await row(moved), ctx)).written).toBe(true);
    await setPause(p, MON);
    const before = await row(moved);
    statements.length = 0;
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([slotId(p, MON)]);
    expect(await row(moved)).toEqual(before);
    removalNotTried();
  });

  it("a session saved in the app stays, whatever the row says", async () => {
    const { p, id } = await written();
    await db.insert(schema.performedSessions).values({
      id: newId(), userId, workoutId: id, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: MON, startedAt: NOW, endedAt: NOW, seconds: 60, plannedSeconds: 60, minutes: 1,
      mode: "recovery", theme: null, locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: 1, stepsDone: 1, movesDone: [], note: null, newMove: null, payloadHash: "h", createdAt: NOW, updatedAt: NOW,
    } as never);
    await setPause(p, MON);
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([]);
    expect((await row(id)).archivedAt).toBeNull();
  });

  // Each lands after the pass read the row and chose it: the removal's own check keeps it.
  const landing: Array<[string, (id: string) => Promise<unknown>]> = [
    ["built", (id) => db.update(plannedWorkouts).set({ contentState: "built" }).where(eq(plannedWorkouts.id, id))],
    ["started", (id) => db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, id))],
    ["completed", (id) => db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, id))],
    ["unresolved", (id) => db.update(plannedWorkouts).set({ completionState: "unresolved" }).where(eq(plannedWorkouts.id, id))],
    ["moved away", (id) => db.update(plannedWorkouts).set({ effectiveDate: day(0, 2) }).where(eq(plannedWorkouts.id, id))],
    ["re-timed", (id) => db.insert(scheduleOverrides).values({ id: newId(), workoutId: id, kind: "time_change", fromDate: MON, toDate: MON, toTime: "18:00", source: "app", createdAt: NOW })],
  ];

  it.each(landing)("%s after the pass read it, it stays: the removal checks again as it archives", async (_, land) => {
    const { p, id } = await written();
    await setPause(p, MON);
    // The pass's first look, then its look before it retracts: this lands at the second.
    race.begin = async () => {
      race.begin = async () => {
        await land(id);
      };
    };
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([]);
    expect((await row(id)).archivedAt).toBeNull();
    // And a day it holds stays held: no suppression, no intent.
    expect(await db.select().from(schema.calendarEventSuppressions).where(eq(schema.calendarEventSuppressions.workoutId, id))).toEqual([]);
  });

  it("a restore beginning as it goes leaves it", async () => {
    const { p, id } = await written();
    await setPause(p, MON);
    // The pass's first look, then its look before it retracts: this lands there, and the removal's own look finds it.
    race.begin = async () => {
      race.begin = beginRestore;
    };
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([]);
    expect((await row(id)).archivedAt).toBeNull();
  });

  describe("its copy on the watch", () => {
    let server: MockCorosServer;

    /** An account with the writes on, the watch connected, and today's session written and its copy queued. */
    const copyQueued = async (writes = true) => {
      ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
      ctx = { today: MON, now: NOW, prefs };
      await seedCatalog(db);
      server = mockCorosServer({ baseMonday: "2026-10-12" });
      await connectMock(db, userId, server);
      const { p, id } = await written();
      expect(await queueProvisionalPush(db, switchOn(), userId, await row(id), ctx)).toBe("queued");
      const [record] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, id));
      return { p, id, recordId: record!.id, prefsNow: writes ? prefs : { ...prefs, corosWritesEnabled: false } };
    };
    const job = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];

    it("a push still queued is superseded: nothing reaches the watch", async () => {
      const { p, id, recordId } = await copyQueued();
      await setPause(p, MON);
      expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([id]);
      expect((await job(`push:${recordId}`))!.status).toBe("superseded");
      expect(await job(`unpush:${recordId}`)).toBeUndefined();
    });

    it("a copy on the watch is owed its removal: its delete is queued", async () => {
      const { p, id, recordId } = await copyQueued();
      await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
      expect((await job(`push:${recordId}`))!.status).toBe("verified");
      await setPause(p, MON);
      expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([id]);
      expect(await job(`unpush:${recordId}`)).toMatchObject({ status: "queued", kind: expect.stringContaining("delete") });
    });

    it("with the athlete's writes off, the delete is owed on the copy's record", async () => {
      const { p, id, recordId, prefsNow } = await copyQueued(false);
      await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
      await setPause(p, MON);
      expect((await placeSlots(db, userId, p, MON, prefsNow, NOW)).archived).toEqual([id]);
      expect(await job(`unpush:${recordId}`)).toBeUndefined();
      const [record] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, recordId));
      expect((record!.payload as { unpushOwedAt?: string }).unpushOwedAt).toBe(NOW);
    });

    it("today's goes first by an explicit order, not by the order the rows happen to be read in", async () => {
      const p = await placed({ weekdays: [1, 2, 3], placementWeeksAhead: 2 });
      // An id that sorts after every slot's, so a read by id, or by the source index, comes to it last.
      const today = await session(p, MON, 1, "scheduled", { id: "z-today", sourceWorkoutId: "z-today" });
      await setPause(p, day(4, 0));
      // Room for the pass's own reads and one removal of a written session, and for no slot beside it.
      const res = await placeSlotsWithin(db, userId, p, MON, prefs, NOW, 6 + RETRACT_WRITTEN_COST);
      expect(res.archived).toEqual([today]);
      expect(res.more).toBe(true);
      expect(RETRACT_WRITTEN_COST).toBeGreaterThan(RETRACT_COST);
    });

    it("the removal is within what a budgeted pass declares, at its dearest: a copy on the watch to take off", async () => {
      const { p, id } = await copyQueued();
      await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
      await setPause(p, MON);
      statements.length = 0;
      const res = await placeSlotsWithin(db, userId, p, MON, prefs, NOW, 45);
      expect(res.archived).toEqual([id]);
      expect(statements.length).toBeLessThanOrEqual(res.spent);
      expect(res.spent).toBeLessThanOrEqual(45);
      // The pass's own 6 and its refresh's read, beside the removal it declares: what a request sets aside for a pause.
      expect(res.spent).toBe(PAUSE_PASS_COST);
      expect(PAUSE_PASS_COST).toBe(6 + RETRACT_WRITTEN_COST + 1);
    });
  });
});

describe("a preview that isn't current", () => {
  it("while the row is an outline of a course, a read serves no preview: the sheet's own build makes a fresh one", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    const first = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(first.session.build?.version).toBe(0);
    expect((await loadSession(db, userId, id, MON)).build).toBeNull();
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build?.buildId).toBe(first.session.build?.buildId);
  });

  it("the old dose isn't served after the sessions done move", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    await buildSessionOutcome(db, userId, id, {}, ctx);
    await session(p, addDays(MON, -7), 1, "completed");
    await session(p, addDays(MON, -3), 2, "completed");
    expect((await loadSession(db, userId, id, MON)).build).toBeNull();
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build?.steps).toEqual(playerStepsFromDoc(realSessionDoc(3, { ease: false }), EXERCISES));
  });

  it("the old dose isn't served after an easing is asked for", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    await buildSessionOutcome(db, userId, id, {}, ctx);
    await db.update(programs).set({ config: { ...(await programOf(p)).config, easeNext: true } }).where(eq(programs.id, p));
    expect((await loadSession(db, userId, id, MON)).build).toBeNull();
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build?.steps).toEqual(playerStepsFromDoc(realSessionDoc(1, { ease: true }), EXERCISES));
  });

  it("a preview, the row moved to today and written, then moved back ahead: its old preview isn't served, and the next is of its document", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    await buildSessionOutcome(db, userId, id, {}, ctx);
    await move(id, MON);
    await writeCourseSession(db, userId, await row(id), ctx);
    await move(id, day(0, 2));
    expect((await row(id)).origin).toBe("studio");
    expect((await loadSession(db, userId, id, MON)).build).toBeNull();
    const fresh = (await buildSessionOutcome(db, userId, id, {}, ctx)).session.build;
    expect(fresh).toMatchObject({ version: 0, fromDoc: { rev: 1 } });
    expect((await loadSession(db, userId, id, MON)).build?.buildId).toBe(fresh?.buildId);
  });

  it("a document workout's preview of its own revision is served, and one of an older revision isn't", async () => {
    const p = await placed();
    const id = await filed(p, day(0, 2), "scheduled");
    const fresh = (await buildSessionOutcome(db, userId, id, {}, ctx)).session.build;
    expect(fresh).toMatchObject({ version: 0, fromDoc: { rev: 1 } });
    expect((await loadSession(db, userId, id, MON)).build?.buildId).toBe(fresh?.buildId);
    await db.update(plannedWorkouts).set({ workoutDocRev: 2 }).where(eq(plannedWorkouts.id, id));
    expect((await loadSession(db, userId, id, MON)).build).toBeNull();
  });

  it("an adaptive programme's preview is served as ever", async () => {
    const p = newId();
    await db.insert(programs).values({
      id: p, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 4], defaultMinutes: 30 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    await placeSlots(db, userId, p, MON, prefs, "2026-10-05T12:00:00.000Z");
    const id = slotId(p, day(0, 4));
    const first = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(first.session.build?.version).toBe(0);
    expect((await loadSession(db, userId, id, MON)).build?.buildId).toBe(first.session.build?.buildId);
  });

  it("a read of an outline ahead costs no more for it: the row, its plan, the profiles, its plan's kind and the set-aside moves", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    await buildSessionOutcome(db, userId, id, {}, ctx);
    statements.length = 0;
    await loadSession(db, userId, id, MON);
    expect(statements).toHaveLength(5);
  });
});

describe("a preview nothing can compute afresh", () => {
  it("under a restore a build answers no preview: stale is worse than none", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build?.version).toBe(0);
    await beginRestore();
    statements.length = 0;
    const { session: s, calendarChanged } = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(s.build).toBeNull();
    expect(calendarChanged).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("under a restore a document workout's preview is still served: it's of its own revision, and the row holds what it's made from", async () => {
    const p = await placed();
    const id = await filed(p, day(0, 2), "scheduled");
    const fresh = (await buildSessionOutcome(db, userId, id, {}, ctx)).session.build;
    await beginRestore();
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build?.buildId).toBe(fresh?.buildId);
  });

  it("with its definition gone a build answers no preview", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await placed();
    const id = slotId(p, day(0, 2));
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build?.version).toBe(0);
    await db.update(programs).set({ config: { ...(await programOf(p)).config, course: "gone" } }).where(eq(programs.id, p));
    expect((await buildSessionOutcome(db, userId, id, {}, ctx)).session.build).toBeNull();
  });
});

describe("the check sent with the opening", () => {
  const tmj = () => db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
  const gated = () => vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(() => landingsDoc({ alternates: false }));
  const stored = () => db.select().from(conditionChecks).where(eq(conditionChecks.userId, userId));
  const CLEAR = { checks: { tmj: { pre: 1, feelingOff: false } } };
  const CLOSES = { checks: { tmj: { pre: 8, feelingOff: true } } };

  it("a re-check that clears the stored reading's refusal writes the session, keeps the check, and takes the note away", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await tmj();
    const p = await placed();
    const id = slotId(p, MON);
    gated();
    await recordCheck(db, userId, { profileId: "tmj", value: 6, feelingOff: true }, { today: MON, now: NOW });
    expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(false);
    expect(await activeSyncNotes(db, userId)).toHaveLength(1);

    const { session: s } = await buildSessionOutcome(db, userId, id, CLEAR, ctx);
    expect((await row(id)).origin).toBe("studio");
    expect(s.build?.fromDoc?.blocked).toEqual([]);
    expect(s.checks).toEqual({ tmj: { pre: 1, feelingOff: false } });
    expect((await stored()).filter((c) => c.kind === "pre").map((c) => [c.workoutId, c.value])).toEqual([[id, 1]]);
    expect(await activeSyncNotes(db, userId)).toEqual([]);
  });

  it("an answer that closes a move isn't written with it blocked: the outline stays, with its note, and the answer is kept", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await tmj();
    const p = await placed();
    const id = slotId(p, MON);
    const before = await row(id);
    gated();
    const { session: s } = await buildSessionOutcome(db, userId, id, CLOSES, ctx);
    expect(s).toMatchObject({ origin: "program", build: null, checks: { tmj: { pre: 8, feelingOff: true } } });
    expect(await row(id)).toEqual(before);
    expect((await activeSyncNotes(db, userId)).map((n) => n.kind)).toEqual(["course_session_refused"]);
    expect((await stored()).map((c) => [c.kind, c.workoutId, c.value, c.feelingOff])).toEqual([["pre", id, 8, true]]);

    // The answer stands for the next pass, and a clearing one replaces it.
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    await buildSessionOutcome(db, userId, id, CLEAR, ctx);
    expect((await row(id)).origin).toBe("studio");
    expect((await stored()).map((c) => [c.kind, c.value])).toEqual([["pre", 1]]);
  });

  it("the same answer with an alternate to stand in is written: it's the build that swaps", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await tmj();
    const p = await placed();
    const id = slotId(p, MON);
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(() => landingsDoc({ alternates: true }));
    const { session: s } = await buildSessionOutcome(db, userId, id, CLOSES, ctx);
    expect((await row(id)).origin).toBe("studio");
    expect(s.build?.fromDoc?.swaps.map((x) => x.to)).toEqual(["tempoSquat"]);
    expect(await activeSyncNotes(db, userId)).toEqual([]);
  });

  it("a check for a profile that isn't on is refused before anything is written", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    const before = await row(id);
    await expect(buildSessionOutcome(db, userId, id, CLEAR, ctx)).rejects.toBeInstanceOf(UnknownProfileError);
    expect(await row(id)).toEqual(before);
    expect(await stored()).toEqual([]);
  });

  it("an outline a pause holds keeps the answer too, and a profile that isn't on is still refused", async () => {
    const p = await placed();
    const id = slotId(p, day(0, 2));
    await move(id, MON);
    await setPause(p, MON);
    await expect(buildSessionOutcome(db, userId, id, CLEAR, ctx)).rejects.toBeInstanceOf(UnknownProfileError);
    await tmj();
    const { session: s } = await buildSessionOutcome(db, userId, id, CLEAR, ctx);
    expect(s).toMatchObject({ origin: "program", build: null, checks: { tmj: { pre: 1, feelingOff: false } } });
    expect((await stored()).map((c) => c.value)).toEqual([1]);
  });

  it("a restore beginning before the answer is kept records nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await tmj();
    const p = await placed();
    const id = slotId(p, day(0, 2));
    await move(id, MON);
    await setPause(p, MON);
    // The build's own look: this lands there, and keeping the answer looks again and finds it.
    race.begin = beginRestore;
    await buildSessionOutcome(db, userId, id, CLEAR, ctx);
    expect(await stored()).toEqual([]);
  });

  it("nor does a day ahead that can't be previewed: its course's definition is gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await tmj();
    const p = await placed();
    await db.update(programs).set({ config: { ...(await programOf(p)).config, course: "gone" } }).where(eq(programs.id, p));
    expect((await buildSessionOutcome(db, userId, slotId(p, day(0, 2)), CLEAR, ctx)).session.build).toBeNull();
    expect(await stored()).toEqual([]);
  });

  it("a preview ahead doesn't record its answer, as ever", async () => {
    await tmj();
    const p = await placed();
    await buildSessionOutcome(db, userId, slotId(p, day(0, 2)), CLEAR, ctx);
    expect(await stored()).toEqual([]);
  });
});

describe("today's outline, linked by hand and the link undone", () => {
  const linkAndUndo = async (id: string) => {
    const app = mountRoutes(db, "/api/plan", planRoutes);
    const cookie = await cookieFor();
    const post = (path: string, body?: unknown) =>
      app.request(`/api/plan/workouts/${id}/${path}`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, WATCH_ON);
    expect((await post("match", { activityId: await activityOn(MON) })).status).toBe(200);
    expect((await post("unmatch")).status).toBe(200);
    expect((await row(id)).completionState).toBe("unresolved");
  };

  it("the hourly pass writes it, as a session to do", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await linkAndUndo(id);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 0 });
    expect(await row(id)).toMatchObject({ origin: "studio", completionState: "scheduled", courseSession: 1, title: titleOf(1) });
    // So the mirror takes it, as it does any session to do.
    expect(rowRefusal(await row(id), WATCH_ON, { today: MON, prefs: { corosWritesEnabled: true } })).toBeNull();
  });

  it("an open writes it and builds it", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await linkAndUndo(id);
    const { session: s } = await buildSessionOutcome(db, userId, id, {}, ctx);
    expect(s.origin).toBe("studio");
    expect(s.build?.fromDoc?.rev).toBe(1);
    expect((await row(id)).completionState).toBe("scheduled");
  });

  it("one from a day gone isn't: its day has passed", async () => {
    const p = await placed();
    const id = slotId(p, MON);
    await linkAndUndo(id);
    const tuesday = addDays(MON, 1);
    statements.length = 0;
    expect((await writeCourseSession(db, userId, await row(id), { ...ctx, today: tuesday })).written).toBe(false);
    expect(writes()).toEqual([]);
    expect((await row(id)).origin).toBe("program");
  });
});

describe("the refusal's note", () => {
  const refuse = async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await placed();
    const spy = vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(unplayable);
    await writeCourseSessionsDue(db, AT);
    return { p, id: slotId(p, MON), spy };
  };

  it("ends with the athlete's day: up until their midnight, gone from it", async () => {
    await refuse();
    expect((await db.select().from(syncNotes))[0]!.expiresAt).toBe("2026-10-06T07:00:00.000Z"); // Midnight in Los Angeles.
    vi.setSystemTime(new Date("2026-10-06T06:59:59.000Z"));
    expect(await activeSyncNotes(db, userId)).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-06T07:00:00.000Z"));
    expect(await activeSyncNotes(db, userId)).toEqual([]);
  });

  it("a successful write clears it, even one on another day: moved, and written there", async () => {
    const { id, spy } = await refuse();
    spy.mockRestore();
    await move(id, day(0, 2));
    expect((await writeCourseSession(db, userId, await row(id), { ...ctx, today: day(0, 2) })).written).toBe(true);
    expect((await db.select().from(syncNotes))[0]!.dismissedAt).toBe(NOW);
  });

  it("another session's write doesn't clear it", async () => {
    const { spy } = await refuse();
    spy.mockRestore();
    const other = await placed({ placementWeeksAhead: 1 });
    await writeCourseSession(db, userId, await row(slotId(other, MON)), ctx);
    expect((await db.select().from(syncNotes))[0]!.dismissedAt).toBeNull();
  });
});

describe("what it costs", () => {
  const studioRow = async (): Promise<string> => {
    const id = newId();
    await db.insert(plannedWorkouts).values({
      id, userId, planId: `studio-${userId}`, sourceWorkoutId: id, title: "A workout", category: "yoga", sport: "yoga", originalPlanDate: MON, lastVerifiedCorosDate: "",
      effectiveDate: MON, effectiveTime: "12:00", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900,
      origin: "studio", contentState: "outline", completionState: "scheduled", createdAt: NOW, updatedAt: NOW, workoutDoc: JSON.stringify(INTRO_COURSE.sessionDoc(1, { ease: false })), workoutDocRev: 1,
    });
    return id;
  };

  it("a row that isn't a programme's reads no programme: its session is the row, its builds, its profiles and the set-aside moves", async () => {
    const id = await studioRow();
    statements.length = 0;
    await loadSession(db, userId, id, MON);
    expect(statements).toHaveLength(4);
    expect(statements.filter((s) => /from "programs"/.test(s))).toEqual([]);
  });

  it("an on-demand session reads its programme once, as ever", async () => {
    const p = newId();
    await db.insert(programs).values({
      id: p, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({}), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    const id = newId();
    await db.insert(plannedWorkouts).values({
      id, userId, planId: p, sourceWorkoutId: id, title: "On demand", category: "yoga", sport: "yoga", originalPlanDate: MON, lastVerifiedCorosDate: "",
      effectiveDate: MON, effectiveTime: "12:00", sourceContentFingerprint: "on_demand", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900,
      origin: "on_demand", contentState: "outline", completionState: "scheduled", createdAt: NOW, updatedAt: NOW,
    });
    statements.length = 0;
    await loadSession(db, userId, id, MON);
    expect(statements.filter((s) => /from "programs"/.test(s))).toHaveLength(1);
  });

  it("an ordinary write: its plan, the sessions done, the restore's look, the profiles, the library, and a batch of 4", async () => {
    const p = await placed();
    const stale = await row(slotId(p, MON));
    statements.length = 0;
    expect((await writeCourseSession(db, userId, stale, ctx)).written).toBe(true);
    expect(statements).toHaveLength(1 + 1 + 1 + 1 + 1 + 4);
    expect(statements.filter((s) => /json_set/.test(s))).toEqual([]);
  });

  it.each([2, 6])("a write costs what it declares, and one more for each session the collision pass re-times: %i others on the day", async (others) => {
    await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2026-09-01", settings: {} });
    await recordCheck(db, userId, { profileId: "tmj", value: 1, feelingOff: false }, { today: MON, now: NOW });
    const p = await placed({ easeNext: true });
    for (let i = 0; i < others; i++) await filed(elsewhere(`${p}-${i}`), MON, "scheduled", { effectiveTime: `19:${35 + i}` });
    const stale = await row(slotId(p, MON));
    statements.length = 0;
    expect((await writeCourseSession(db, userId, stale, ctx)).written).toBe(true);
    const retimes = statements.filter((s) => /^update "planned_workouts" set .*"effective_time"/.test(s)).length;
    // Not a day that happened to stay put.
    expect(retimes).toBeGreaterThanOrEqual(others);
    // The plan's read is this call's; the hourly pass holds its plan already.
    expect(statements.length - 1).toBe(COURSE_WRITE_COST + retimes);
  });

  it("the hourly pass over several accounts and plans stays within its bound, and what doesn't fit waits for the next hour", async () => {
    const due: string[] = [];
    for (let a = 0; a < 3; a++) {
      const { userId: owner, prefs: theirs } = await makeTestUser(db);
      for (let c = 0; c < 2; c++) {
        const p = await seedCourse({}, {}, owner);
        await placeSlots(db, owner, p, MON, theirs, NOW);
        due.push(slotId(p, MON));
      }
    }
    expect(due).toHaveLength(6);

    let hours = 0;
    const left = async () => (await Promise.all(due.map(row))).filter((r) => r.origin === "program").length;
    for (; (await left()) > 0; hours++) {
      expect(hours, "the pass never finished").toBeLessThan(6);
      statements.length = 0;
      const res = await writeCourseSessionsDue(db, AT);
      expect(res).toEqual({ written: COURSE_WRITES_PER_PASS, failed: 0 });
      // Its one read, then each write's own: nothing per account, or per plan, that it doesn't write.
      expect(statements.length).toBeLessThanOrEqual(1 + COURSE_WRITES_PER_PASS * COURSE_WRITE_COST);
    }
    expect(hours).toBe(Math.ceil(6 / COURSE_WRITES_PER_PASS));

    // Settled: one read, whatever the plans.
    statements.length = 0;
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 0, failed: 0 });
    expect(statements).toHaveLength(1);
  });

  it("the hourly cron runs it, after placing: a session due today is written by the same run that places it", async () => {
    const p = await seedCourse();
    await hourly(db, WATCH_ON);
    const r = await row(slotId(p, MON));
    expect(r).toMatchObject({ origin: "studio", courseSession: 1, title: titleOf(1) });
    // The later outline is still one.
    expect((await row(slotId(p, day(0, 2)))).origin).toBe("program");
  });

  it("a session the day refuses goes last, so it can't hold up the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spy = vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation(unplayable);
    // Enough refused to fill a pass, each noted, and each read first but for what the day did.
    for (let i = 0; i < COURSE_WRITES_PER_PASS; i++) await placed({}, { id: `a-${i}` });
    await writeCourseSessionsDue(db, AT);
    expect(await activeSyncNotes(db, userId)).toHaveLength(COURSE_WRITES_PER_PASS);

    // A session with no refusal comes due, later by id: the pass reaches it first.
    const fine = slotId(await placed({}, { id: "z-0" }), MON);
    spy.mockImplementation(realSessionDoc);
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: COURSE_WRITES_PER_PASS, failed: 0 });
    expect((await row(fine)).origin).toBe("studio");
  });

  it("one that fails doesn't stop the others, and the pass says so by name of the error alone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await placed();
    const q = await placed();
    let first = true;
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementation((n, opts) => {
      if (first) {
        first = false;
        throw new RangeError("private words");
      }
      return realSessionDoc(n, opts);
    });
    expect(await writeCourseSessionsDue(db, AT)).toEqual({ written: 1, failed: 1 });
    expect([(await row(slotId(p, MON))).origin, (await row(slotId(q, MON))).origin].sort()).toEqual(["program", "studio"]);
    for (const call of error.mock.calls) expect(String(call[0])).not.toContain("private words");
    expect(error.mock.calls.some((c) => /course session write failed.*RangeError/.test(String(c[0])))).toBe(true);
  });

  /** Each statement and each fetch of one request, its waitUntil work included: the way programs-budget.test.ts counts. */
  async function request(path: string, init: RequestInit, env: Env) {
    const app = mountRoutes(db, "/api/sessions", sessionRoutes);
    const pending: Promise<unknown>[] = [];
    const executionCtx = { waitUntil: (w: Promise<unknown>) => pending.push(w), passThroughOnException: () => undefined, props: {} };
    statements.length = 0;
    let fetches = 0;
    vi.stubGlobal("fetch", (async () => {
      fetches += 1;
      return new Response("{}", { status: 404 });
    }) as typeof fetch);
    const res = await app.request(path, init, env, executionCtx as never);
    await Promise.all(pending);
    return { status: res.status, body: (await res.json()) as Record<string, any>, total: statements.length + fetches + google.calls.length };
  }

  /** A Google calendar that takes every insert (and counts each call as a fetch). */
  function connectCalendar() {
    let seq = 0;
    const call = (what: string) => google.calls.push(what);
    google.fake = {
      listCalendars: async () => [],
      createCalendar: async () => ({ id: "cal" }),
      freeBusy: async () => [],
      listEvents: async () => {
        call("list");
        return { items: [], nextSyncToken: "tok" };
      },
      insertEvent: async () => {
        call("insert");
        return { id: `ev-${++seq}` };
      },
      patchEvent: async () => call("patch"),
      deleteEvent: async () => call("delete"),
    };
  }

  /** A course on a realistic account, a calendar connected, with its session due today: the dear read of it all. */
  async function dueOnARealAccount(): Promise<{ id: string; cookie: string; env: Env }> {
    const env = { ...makeRealisticEnv(), WATCH_PUSH_ENABLED: "1" } as Env;
    const account = await seedRealisticAccount(db);
    userId = account.userId;
    prefs = await loadPreferences(db, userId);
    connectCalendar();
    const p = await seedCourse({ weekdays: [0], easeNext: true }, {}, userId);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    return { id: slotId(p, MON), cookie: await cookieFor(), env };
  }

  it("opening today's outline writes it and builds it within a request's budget, on a realistic account", async () => {
    const { id, cookie, env } = await dueOnARealAccount();
    const res = await request(`/api/sessions/${id}/build`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: "{}" }, env);
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe("studio");
    expect(res.body.build.fromDoc.rev).toBe(1);
    expect(res.total).toBeLessThanOrEqual(45);
    // The calendar is the half-hourly sync's.
    expect(google.calls).toEqual([]);
  });

  it("reading today's outline writes it within a request's budget, on a realistic account", async () => {
    const { id, cookie, env } = await dueOnARealAccount();
    const res = await request(`/api/sessions/${id}`, { headers: { Cookie: cookie } }, env);
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe("studio");
    expect(res.total).toBeLessThanOrEqual(45);
  });

  it("a lost claim's retry stays within a request's budget, on a realistic account", async () => {
    const { id, cookie, env } = await dueOnARealAccount();
    const { planId } = await row(id);
    // A session done lands as the first document is made, past every read, so the first try is lost at its batch.
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementationOnce((n, opts) => {
      (db.insert(plannedWorkouts).values(sessionRow(planId, addDays(MON, -3), 1, "completed", { userId })) as unknown as { run(): void }).run();
      return realSessionDoc(n, opts);
    });
    const res = await request(`/api/sessions/${id}/build`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: "{}" }, env);
    expect(res.status).toBe(200);
    expect(await row(id)).toMatchObject({ origin: "studio", courseSession: 2 });
    expect(res.total).toBe(45);
  });

  it("a lost claim's retry with an answer sent is the build's real worst case: 47, a little past the budget on a rare race", async () => {
    const { id, cookie, env } = await dueOnARealAccount();
    const { planId } = await row(id);
    vi.spyOn(INTRO_COURSE, "sessionDoc").mockImplementationOnce((n, opts) => {
      (db.insert(plannedWorkouts).values(sessionRow(planId, addDays(MON, -3), 1, "completed", { userId })) as unknown as { run(): void }).run();
      return realSessionDoc(n, opts);
    });
    const body = JSON.stringify({ checks: { tmj: { pre: 1, feelingOff: false } } });
    const res = await request(`/api/sessions/${id}/build`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body }, env);
    expect(res.status).toBe(200);
    expect(await row(id)).toMatchObject({ origin: "studio", courseSession: 2 });
    expect(res.body.checks).toEqual({ tmj: { pre: 1, feelingOff: false } });
    expect(res.total).toBe(47);
  });

  it("a preview ahead stays within a request's budget, on a realistic account", async () => {
    const { id, cookie, env } = await dueOnARealAccount();
    const ahead = id.replace(MON, day(1, 0));
    const res = await request(`/api/sessions/${ahead}/build`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: "{}" }, env);
    expect(res.status).toBe(200);
    expect(res.body.build.version).toBe(0);
    expect(res.total).toBeLessThanOrEqual(45);
  });
});
