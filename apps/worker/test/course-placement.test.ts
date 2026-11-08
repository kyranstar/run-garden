/**
 * A COURSE'S SESSIONS PLACED AHEAD AS OUTLINES (plans with a purpose, spec §4.2 and §4.4). A course works as a programme's
 * slots do: rows on its days and at its time, counted by the day they were planned on, so what the athlete moved or
 * removed is never undone. An outline holds a title and a booked length and no document, so nothing reaches the watch
 * until its day. A pause (either kind) and a course's quiet days before the race hold days back, and take flexible slots
 * off them, and a pause takes today's untouched outline too. A session written on its day (`origin` flipped to `studio`,
 * `course_session` set to its number) holds its day and is never rewritten, whatever a push does to its fingerprint.
 *
 * Nearly every test runs on a made-up course (`course-fixture.ts`): worker code reads only the definition. `placeSlots`
 * reads no clock, so the fixed dates here can't go stale. Synthetic data only.
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

import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, addDays, courseConfigSchema, newId, type AdaptiveConfig, type CourseConfig, type UserPreferences } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { COURSES, deriveDoc } from "@rg/workout";
import type { Db } from "../src/services/db.js";
import { applyMove } from "../src/services/jobs.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { previewPlacement, placeSlots, placeSlotsForAllPrograms, placeSlotsWithin, retractSlot, slotId } from "../src/services/program-slots.js";
import { bookedSeconds } from "../src/services/session-build.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";
import { INTRO_COURSE, INTRO_FIRST_BOOKED, INTRO_FIRST_SECONDS, INTRO_LATER_BOOKED, INTRO_LATER_SECONDS } from "./course-fixture.js";

const { plannedWorkouts, programs, accountState, calendarEventSuppressions, sessionBuilds } = schema;

/** A Monday. */
const MON = "2026-10-05";
/** Monday 05:00 in Los Angeles, the test user's zone. */
const NOW = "2026-10-05T12:00:00.000Z";
/** `weekday` 0 = Monday … 6 = Sunday (the config's numbering), `week` weeks after MON's. */
const day = (week: number, weekday: number): string => addDays(MON, 7 * week + weekday);

const NOTHING = { placed: [], archived: [] };

let db: Db;
let userId: string;
let prefs: UserPreferences;
let statements: string[];

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db));
  race.begin = null;
});

const writes = () => statements.filter(isWrite);

/** A running course, on Monday and Friday at 18:15, unless a test says otherwise. */
async function seedCourse(config: Partial<CourseConfig> = {}, over: Partial<typeof programs.$inferInsert> = {}, owner = userId): Promise<string> {
  const id = newId();
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
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "18:15", ...config }),
    onEnd: "continue",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...over,
  });
  return id;
}

async function seedProgramme(config: Partial<AdaptiveConfig>, over: Partial<typeof programs.$inferInsert> = {}): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id,
    userId,
    kind: "adaptive",
    name: "Mobility",
    status: "active",
    disciplines: ["yoga", "strength"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config: adaptiveConfigSchema.parse(config),
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...over,
  });
  return id;
}

const rowsOf = (planId: string) => db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, planId));
const row = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const liveOn = async (planId: string, date: string) =>
  (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, planId), eq(plannedWorkouts.effectiveDate, date), isNull(plannedWorkouts.archivedAt)))).map((r) => r.id);
const liveDates = async (planId: string): Promise<string[]> =>
  (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, planId), isNull(plannedWorkouts.archivedAt)))).map((r) => r.effectiveDate).sort();
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const ids = (planId: string, dates: string[]): string[] => sorted(dates.map((d) => slotId(planId, d)));
const setPause = (planId: string, pausedUntil: string | null) => db.update(programs).set({ pausedUntil }).where(eq(programs.id, planId));

async function move(workoutId: string, toDate: string): Promise<void> {
  await applyMove(db, { userId, workoutId, toDate, toTime: "18:15", source: "app", corosWritesEnabled: false });
}

/** What the day's write does (Task 10's flip, in the shape a document workout has): the row keeps its id and takes its number. */
async function writeSession(workoutId: string, title: string, n = 1): Promise<void> {
  await db
    .update(plannedWorkouts)
    .set({ origin: "studio", title, courseSession: n, workoutDoc: JSON.stringify(INTRO_COURSE.sessionDoc(n, { ease: false })), workoutDocRev: 1 })
    .where(eq(plannedWorkouts.id, workoutId));
}

/** A sent copy's fingerprint: what a verified push, or Keep the watch's version, leaves on a row. */
const WIRE = "0123456789abcdef";
const stamp = (workoutId: string, fingerprint: string) => db.update(plannedWorkouts).set({ sourceContentFingerprint: fingerprint }).where(eq(plannedWorkouts.id, workoutId));

/** A workout the coach made for the plan (Task 8's `planId`): filed under it, and not one of the course's own sessions. */
async function fileWorkout(planId: string, date: string): Promise<string> {
  const id = newId();
  await db.insert(plannedWorkouts).values({
    id, userId, planId, sourceWorkoutId: id, title: "Extra", category: "yoga", sport: "yoga", originalPlanDate: date, lastVerifiedCorosDate: "",
    effectiveDate: date, effectiveTime: "12:00", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 600, calendarBlockDurationSeconds: 600,
    origin: "studio", contentState: "outline", completionState: "scheduled", createdAt: NOW, updatedAt: NOW,
  });
  return id;
}

/** A course's session done: written as its number, then completed. */
const complete = (workoutId: string, n: number) =>
  db.update(plannedWorkouts).set({ origin: "studio", courseSession: n, completionState: "completed", resolutionDate: MON }).where(eq(plannedWorkouts.id, workoutId));

describe("placing a course ahead", () => {
  it("places a course's days ahead, at its time, as outlines with no document", async () => {
    const p = await seedCourse({ placementWeeksAhead: 2 });
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    const dates = [day(0, 0), day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 4)];
    expect(sorted(res.placed)).toEqual(ids(p, dates));
    expect(res.archived).toEqual([]);
    expect(await liveDates(p)).toEqual(dates);
    for (const r of await rowsOf(p)) {
      expect(r).toMatchObject({
        origin: "program",
        contentState: "outline",
        workoutDoc: null,
        workoutDocRev: null,
        sessionParams: null,
        title: "Evening practice",
        category: "yoga",
        sport: "yoga",
        effectiveTime: "18:15",
        fallbackEstimatedDurationSeconds: INTRO_FIRST_SECONDS,
        calendarBlockDurationSeconds: INTRO_FIRST_BOOKED,
        corosSyncState: "calendar_only",
        calendarSyncState: "not_created",
        completionState: "scheduled",
        archivedAt: null,
      });
    }
  });

  it("goes by its own time on any day, not the athlete's window", async () => {
    const p = await seedCourse({ weekdays: [5], time: "06:15", placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await row(slotId(p, day(0, 5)))).effectiveTime).toBe("06:15");
    expect(prefs.weekendMorningTime).not.toBe("06:15");
  });

  it("today's session is placed until the course's own time has passed, not the athlete's window", async () => {
    const monday1730 = "2026-10-06T00:30:00.000Z"; // the athlete's window (07:00) long gone, 18:15 still ahead
    const a = await seedCourse({ placementWeeksAhead: 1 });
    expect((await placeSlots(db, userId, a, MON, prefs, monday1730)).placed).toContain(slotId(a, MON));

    const monday2000 = "2026-10-06T03:00:00.000Z"; // 18:15 gone too
    const b = await seedCourse({ placementWeeksAhead: 1 });
    expect((await placeSlots(db, userId, b, MON, prefs, monday2000)).placed).not.toContain(slotId(b, MON));
  });

  it("a mid-week start fills only the course's days still ahead", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    const wed = day(0, 2);
    expect(sorted((await placeSlots(db, userId, p, wed, prefs, NOW)).placed)).toEqual(ids(p, [day(0, 4), day(1, 0), day(1, 4)]));
  });

  it("a second pass writes nothing", async () => {
    const p = await seedCourse({ placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const before = await rowsOf(p);
    expect(before).toHaveLength(6);
    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);
    expect(await rowsOf(p)).toEqual(before);
  });

  it("takes its discipline from the plan, as a programme does", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 }, { disciplines: ["strength"] });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await row(slotId(p, MON))).toMatchObject({ category: "strength", sport: "strength" });
  });

  // Every other test runs on the made-up course, so the real one's definition is held to the same path here.
  it.each(Object.keys(COURSES))("the %s course places by the same path", async (course) => {
    const p = await seedCourse({ course, placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const seconds = deriveDoc(COURSES[course]!.sessionDoc(1, { ease: false }), EXERCISES).estimatedMinutes * 60;
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4)]);
    expect(await row(slotId(p, MON))).toMatchObject({ workoutDoc: null, fallbackEstimatedDurationSeconds: seconds, calendarBlockDurationSeconds: bookedSeconds(seconds), effectiveTime: "18:15" });
  });

  it("only a course reads a numbered row: an adaptive programme's week counts its slots alone", async () => {
    // No such row exists under a programme today. This holds the read's branch, so a programme's placement can't move with a course's.
    const p = await seedProgramme({ weeklyGoal: 1, preferredDays: [2], placementWeeksAhead: 1 });
    const numbered = await fileWorkout(p, day(0, 1));
    await db.update(plannedWorkouts).set({ courseSession: 1 }).where(eq(plannedWorkouts.id, numbered));
    expect(sorted((await placeSlots(db, userId, p, MON, prefs, NOW)).placed)).toEqual(ids(p, [day(0, 2), day(1, 2)]));
  });

  it("only a course books the rounded block: an adaptive programme's slot keeps its raw length", async () => {
    const p = await seedProgramme({ weeklyGoal: 1, preferredDays: [2], defaultMinutes: 32, placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await row(slotId(p, day(0, 2)))).toMatchObject({ fallbackEstimatedDurationSeconds: 1920, calendarBlockDurationSeconds: 1920 });
  });
});

describe("an outline's length comes from the sessions actually done", () => {
  it("counts only what was completed, as the next session's number", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);

    // Skipped and missed change nothing: still session 1, 660 s. Completed in another plan changes nothing either.
    await db.update(plannedWorkouts).set({ courseSession: 1, completionState: "skipped" }).where(eq(plannedWorkouts.id, slotId(p, day(0, 0))));
    await db.update(plannedWorkouts).set({ courseSession: 1, completionState: "missed" }).where(eq(plannedWorkouts.id, slotId(p, day(0, 4))));
    const other = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, other, MON, prefs, NOW);
    await complete(slotId(other, day(0, 0)), 1);
    await complete(slotId(other, day(0, 4)), 2);
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect((await row(slotId(p, day(1, 0)))).fallbackEstimatedDurationSeconds).toBe(INTRO_FIRST_SECONDS);

    // One done: session 2, still 660 s. Two done: session 3, 1,320 s, on every outline from today on.
    await complete(slotId(p, day(0, 0)), 1);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await row(slotId(p, day(1, 0)))).fallbackEstimatedDurationSeconds).toBe(INTRO_FIRST_SECONDS);
    await complete(slotId(p, day(0, 4)), 2);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    for (const date of [day(1, 0), day(1, 4)]) {
      expect(await row(slotId(p, date))).toMatchObject({ fallbackEstimatedDurationSeconds: INTRO_LATER_SECONDS, calendarBlockDurationSeconds: INTRO_LATER_BOOKED });
    }
  });

  it("a workout the coach filed under the plan and completed doesn't advance the number", async () => {
    // Two of them would make the next session 3, at 1,320 s, if they counted.
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    for (const date of [day(0, 1), day(0, 2)]) {
      const filed = await fileWorkout(p, date);
      await db.update(plannedWorkouts).set({ completionState: "completed", resolutionDate: date }).where(eq(plannedWorkouts.id, filed));
    }
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect((await row(slotId(p, day(1, 0)))).fallbackEstimatedDurationSeconds).toBe(INTRO_FIRST_SECONDS);
  });

  it("an eased next session changes no booking: only the day's write uses it, and only that clears it", async () => {
    const p = await seedCourse({ easeNext: true, placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await row(slotId(p, MON))).fallbackEstimatedDurationSeconds).toBe(INTRO_FIRST_SECONDS);
    expect((await db.select().from(programs).where(eq(programs.id, p)))[0]!.config).toMatchObject({ easeNext: true });
  });

  it("a rename reaches the outlines, as a programme's do", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await db.update(programs).set({ name: "Night practice" }).where(eq(programs.id, p));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await rowsOf(p)).map((r) => r.title)).toEqual(["Night practice", "Night practice", "Night practice", "Night practice"]);
  });
});

describe("what the athlete did", () => {
  it("what the athlete moved or removed is never undone, and the day it left isn't refilled", async () => {
    const p = await seedCourse({ placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const moved = slotId(p, day(1, 4));
    const removed = slotId(p, day(2, 0));
    await move(moved, day(1, 5));
    await removeFromPlan(db, userId, removed, { now: NOW, source: "remove_from_plan", prefs });

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(await row(moved)).toMatchObject({ originalPlanDate: day(1, 4), effectiveDate: day(1, 5), archivedAt: null });
    expect(await row(removed)).toMatchObject({ archiveReason: "user_removed" });
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 5), day(2, 4)]);
  });

  it("a session moved onto a course day leaves the week's other day alone: a course has no other days to fall back on", async () => {
    // Friday of week 1 goes to Monday of week 2, before week 2 has any slot. Week 2 wants two sessions; Monday is taken.
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await move(slotId(p, day(1, 4)), day(2, 0));

    const res = await placeSlots(db, userId, p, day(1, 0), prefs, NOW);
    expect(res.placed).toEqual([slotId(p, day(2, 4))]);
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(2, 0), day(2, 4)]);
  });
});

describe("a written session", () => {
  it("a written session holds its day", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const written = slotId(p, day(1, 0));
    await writeSession(written, "Intro 1");
    const before = await rowsOf(p);
    expect(before).toHaveLength(4);
    expect(before.find((r) => r.id === written)).toMatchObject({ origin: "studio", title: "Intro 1" });
    statements.length = 0;

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);
    expect(await rowsOf(p)).toEqual(before);
  });

  it("isn't placed over, even once a pass has to fill the rest of its week", async () => {
    // Its neighbour was never placed: the pass reads the written row, and fills only the free day.
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const written = slotId(p, day(1, 0));
    await writeSession(written, "Intro 1");
    await db.delete(plannedWorkouts).where(eq(plannedWorkouts.id, slotId(p, day(1, 4))));

    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).placed).toEqual([slotId(p, day(1, 4))]);
    expect(await row(written)).toMatchObject({ origin: "studio", title: "Intro 1", archivedAt: null });
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4)]);
  });

  it("keeps its title and length when a later pass renames and resizes the outlines", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const written = slotId(p, day(1, 0));
    await writeSession(written, "Intro 1");
    await complete(slotId(p, day(0, 0)), 1);
    await complete(slotId(p, day(0, 4)), 2);
    await db.update(programs).set({ name: "Night practice" }).where(eq(programs.id, p));

    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await row(written)).toMatchObject({ title: "Intro 1", fallbackEstimatedDurationSeconds: INTRO_FIRST_SECONDS });
    expect(await row(slotId(p, day(1, 4)))).toMatchObject({ title: "Night practice", fallbackEstimatedDurationSeconds: INTRO_LATER_SECONDS });
  });

  // A document workout's `content_state` is "outline" too (doc-workouts.ts), so only its origin says it was written.
  it("a pause and a retirement leave it alone: only an outline with no document is flexible", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const written = slotId(p, day(1, 0));
    await writeSession(written, "Intro 1");

    await setPause(p, day(1, 4));
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).not.toContain(written);
    expect((await row(written)).archivedAt).toBeNull();
    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);

    await db.update(programs).set({ status: "retired", pausedUntil: null }).where(eq(programs.id, p));
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).not.toContain(written);
    expect((await row(written)).archivedAt).toBeNull();
  });

  // A push rewrites `source_content_fingerprint` with what it sent, and Keep the watch's version with its own mark, so
  // that column can't say a row is the course's. Without `course_session` the pass loses this row: it inserts over it.
  it("a verified push stamping its fingerprint changes nothing: the pass writes nothing and there's still one row on the day", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const today = slotId(p, MON);
    await writeSession(today, "Intro 1");
    await stamp(today, WIRE);
    const before = await rowsOf(p);
    statements.length = 0;

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);
    expect(await liveOn(p, MON)).toEqual([today]);
    expect(await rowsOf(p)).toEqual(before);
  });

  it.each([WIRE, `take-watch-copy:${WIRE}`])("a session moved onto a course day, written there and stamped %s, still holds that day", async (fingerprint) => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const moved = slotId(p, day(1, 4));
    await move(moved, day(2, 0));
    const today = day(2, 0);
    // The pass of the day it's written on, settled: Friday and the next week are placed around it.
    await placeSlots(db, userId, p, today, prefs, NOW);
    await writeSession(moved, "Intro 1");
    await stamp(moved, fingerprint);
    statements.length = 0;

    expect(await placeSlots(db, userId, p, today, prefs, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);
    expect(await liveOn(p, today)).toEqual([moved]);
  });

  it("a write landing after placement read the row keeps it: the retraction re-checks as it archives", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const id = slotId(p, day(1, 0));
    const snapshot = await row(id);
    await writeSession(id, "Intro 1");

    expect(await retractSlot(db, userId, snapshot, MON, prefs, NOW)).toBe(false);
    expect((await row(id)).archivedAt).toBeNull();
    expect(await db.select().from(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, id))).toEqual([]);
  });

  it("a session started before the course existed and re-pointed to it holds its day too, and counts toward its week", async () => {
    // Not a slot's id, and the course's by its number (Task 11 sets it): week 1's Monday is taken, so only Friday is placed.
    const p = await seedCourse({ placementWeeksAhead: 1 });
    const repointed = await fileWorkout(p, day(1, 0));
    await db.update(plannedWorkouts).set({ courseSession: 3 }).where(eq(plannedWorkouts.id, repointed));

    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(sorted(res.placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 4)]));
    expect((await row(repointed)).archivedAt).toBeNull();
  });
});

describe("a workout the coach filed under the plan", () => {
  it("retracts nothing and counts toward no week", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const filed = await fileWorkout(p, day(1, 2));
    statements.length = 0;

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);
    expect(await row(filed)).toMatchObject({ archivedAt: null, title: "Extra", effectiveDate: day(1, 2) });
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 2), day(1, 4)]);
  });

  it("doesn't hold a course's own day: the session is still placed beside it", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    const filed = await fileWorkout(p, day(1, 0));
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(sorted(res.placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0), day(1, 4)]));
    expect(await row(filed)).toMatchObject({ archivedAt: null, effectiveTime: "12:00" });
  });

  it("a pause or a stop leaves it alone", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const filed = await fileWorkout(p, day(1, 2));

    await setPause(p, day(1, 4));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await row(filed)).archivedAt).toBeNull();

    await db.update(programs).set({ status: "retired", pausedUntil: null }).where(eq(programs.id, p));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await row(filed)).archivedAt).toBeNull();
  });
});

describe("a pause", () => {
  it("a pause retracts flexible slots inside it, keeps moved ones, and ends by itself", async () => {
    const p = await seedCourse({ placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const moved = slotId(p, day(1, 0));
    await move(moved, day(1, 1));

    await setPause(p, day(1, 4));
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    // The moved one stays; today's untouched outline, Friday and next Friday (its last day: `date <= pausedUntil`) come off.
    expect(sorted(res.archived)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 4)]));
    expect(res.placed).toEqual([]);
    expect(await row(moved)).toMatchObject({ effectiveDate: day(1, 1), archivedAt: null });
    expect(await row(slotId(p, day(1, 4)))).toMatchObject({ archiveReason: "program_replaced" });
    expect(await liveDates(p)).toEqual([day(1, 1), day(2, 0), day(2, 4)]);
    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);

    // Its date passes and nothing has to happen: the Saturday after it, the window reaches a new week, placed as usual.
    const saturday = day(1, 5);
    expect(sorted((await placeSlots(db, userId, p, saturday, prefs, NOW)).placed)).toEqual(ids(p, [day(3, 0), day(3, 4)]));
    expect((await db.select().from(programs).where(eq(programs.id, p)))[0]!.pausedUntil).toBe(day(1, 4));
  });

  it("lifted early, what it retracted comes back as the same row, at the course's time", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await setPause(p, day(1, 4));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const friday = slotId(p, day(1, 4));
    expect(await row(friday)).toMatchObject({ archiveReason: "program_replaced" });

    await setPause(p, null);
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(sorted(res.placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0), day(1, 4)]));
    expect(await row(friday)).toMatchObject({ archivedAt: null, archiveReason: null, effectiveTime: "18:15", calendarBlockDurationSeconds: INTRO_FIRST_BOOKED });
    expect(await db.select().from(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, friday))).toEqual([]);
  });

  it("a session written today and left untouched comes off too, or it would read as missed: its number isn't counted", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const today = slotId(p, MON);
    await writeSession(today, "Intro 1");
    await setPause(p, MON);
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([today]);
    expect(await row(today)).toMatchObject({ archivedAt: NOW, archiveReason: "program_replaced" });
  });

  it("a session written on a day ahead, moved there, stays: it's the athlete's, and a pause isn't its day", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const friday = slotId(p, day(0, 4));
    await writeSession(friday, "Intro 1");
    await setPause(p, day(0, 4));
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).not.toContain(friday);
    expect((await row(friday)).archivedAt).toBeNull();
  });

  it("places nothing inside it on a first pass, and no session spills onto the course's other days", async () => {
    const p = await seedCourse({ placementWeeksAhead: 2 }, { pausedUntil: day(1, 0) });
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(sorted(res.placed)).toEqual(ids(p, [day(1, 4), day(2, 0), day(2, 4)]));
  });

  it("a pause already over holds nothing back", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 }, { pausedUntil: addDays(MON, -1) });
    expect(sorted((await placeSlots(db, userId, p, MON, prefs, NOW)).placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0), day(1, 4)]));
  });

  describe("on an adaptive programme, through the same check", () => {
    it("retracts flexible slots inside it, and the week it ends in isn't crammed", async () => {
      const p = await seedProgramme({ weeklyGoal: 2, preferredDays: [0, 2], placementWeeksAhead: 1 });
      await placeSlots(db, userId, p, MON, prefs, NOW);
      expect(await liveDates(p)).toEqual([day(0, 0), day(0, 2), day(1, 0), day(1, 2)]);

      await setPause(p, day(1, 0));
      const res = await placeSlots(db, userId, p, MON, prefs, NOW);
      // Next Monday comes off, and the goal doesn't reach for a day a full week wouldn't use: nothing piles up.
      expect(sorted(res.archived)).toEqual(ids(p, [day(0, 0), day(0, 2), day(1, 0)]));
      expect(res.placed).toEqual([]);
      expect(await liveDates(p)).toEqual([day(1, 2)]);
    });

    it("change_programme's preview says what a pass would do", async () => {
      const p = await seedProgramme({ weeklyGoal: 2, preferredDays: [0, 2], placementWeeksAhead: 1 }, { pausedUntil: day(1, 0) });
      await placeSlots(db, userId, p, MON, prefs, NOW);
      const config = adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [1, 2], placementWeeksAhead: 1 });
      const preview = await previewPlacement(db, userId, { id: p, status: "active", disciplines: ["yoga"], pausedUntil: day(1, 0) }, config, MON, prefs, NOW);
      expect(preview.before).toEqual([day(1, 2)]);
      // Tuesday and Wednesday on, past the pause.
      expect(preview.after).toEqual([day(1, 1), day(1, 2)]);
    });
  });
});

// The same days on either kind: Monday and Friday, this week and next.
describe.each([
  ["a course", () => seedCourse({ placementWeeksAhead: 1 })],
  ["an adaptive programme", () => seedProgramme({ weeklyGoal: 2, preferredDays: [0, 4], placementWeeksAhead: 1 })],
] as Array<[string, () => Promise<string>]>)("under a pause, on %s", (_kind, seed) => {
  const placed = async (): Promise<string> => {
    const p = await seed();
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4)]);
    return p;
  };
  const setContent = (id: string, contentState: string) => db.update(plannedWorkouts).set({ contentState }).where(eq(plannedWorkouts.id, id));

  it("today's untouched outline comes off, with its calendar event", async () => {
    const p = await placed();
    await setPause(p, MON);
    const today = slotId(p, MON);

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [today] });
    expect(await row(today)).toMatchObject({ archiveReason: "program_replaced" });
    expect((await db.select().from(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, today))).map((s) => s.reason)).toEqual(["user_removed"]);
    expect(await liveDates(p)).toEqual([day(0, 4), day(1, 0), day(1, 4)]);

    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);
  });

  it("a pause that ended yesterday leaves today's outline, as any other day does", async () => {
    const p = await placed();
    await setPause(p, addDays(MON, -1));
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(await liveOn(p, MON)).toEqual([slotId(p, MON)]);
  });

  it.each(["built", "started"])("a session %s today stays", async (contentState) => {
    const p = await placed();
    const today = slotId(p, MON);
    await setContent(today, contentState);
    await setPause(p, MON);
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(await row(today)).toMatchObject({ archivedAt: null, contentState });
  });

  it("an outline re-timed today stays: the athlete touched it", async () => {
    const p = await placed();
    const today = slotId(p, MON);
    await applyMove(db, { userId, workoutId: today, toDate: MON, toTime: "18:00", source: "calendar_edit", corosWritesEnabled: false });
    await setPause(p, MON);
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(await row(today)).toMatchObject({ archivedAt: null, effectiveTime: "18:00" });
  });

  it("an outline customised today stays: the athlete touched that too", async () => {
    const p = await placed();
    const today = slotId(p, MON);
    await db.insert(sessionBuilds).values({
      id: newId(), userId, workoutId: today, version: 0, engineVersion: "test", inputsHash: `h-${today}`,
      payload: { build: { params: { checks: {}, overrides: { mode: "build" }, swaps: {} } }, view: { mode: "consistent" } }, lockedAt: null, createdAt: NOW,
    });
    await setPause(p, MON);
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect((await row(today)).archivedAt).toBeNull();
  });

  it("a session moved onto today stays, and today's own outline goes", async () => {
    const p = await placed();
    const moved = slotId(p, day(0, 4));
    await move(moved, MON);
    await setPause(p, MON);
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [slotId(p, MON)] });
    expect(await liveOn(p, MON)).toEqual([moved]);
  });

  it("a built slot inside it, ahead, stays and still counts for its week", async () => {
    const p = await placed();
    const built = slotId(p, day(1, 0));
    await setContent(built, "built");
    await setPause(p, day(1, 0));

    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(sorted(res.archived)).toEqual(ids(p, [day(0, 0), day(0, 4)]));
    expect(res.placed).toEqual([]);
    expect(await row(built)).toMatchObject({ archivedAt: null, contentState: "built" });
    expect(await liveDates(p)).toEqual([day(1, 0), day(1, 4)]);
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
  });

  it("the retraction re-checks today's as it archives: only a pass under a pause may take it, and a build landing first keeps it", async () => {
    const p = await placed();
    const today = slotId(p, MON);
    const snapshot = await row(today);
    expect(await retractSlot(db, userId, snapshot, MON, prefs, NOW)).toBe(false);

    await setContent(today, "built");
    expect(await retractSlot(db, userId, snapshot, MON, prefs, NOW, { todayToo: true })).toBe(false);
    expect((await row(today)).archivedAt).toBeNull();

    await setContent(today, "outline");
    expect(await retractSlot(db, userId, snapshot, MON, prefs, NOW, { todayToo: true })).toBe(true);
    expect(await row(today)).toMatchObject({ archiveReason: "program_replaced" });
  });
});

describe("a course kept off the watch (`watch: false`)", () => {
  // The made-up course, flagged for these tests alone: worker code reads the flag, never which course it is.
  beforeEach(() => {
    INTRO_COURSE.watch = false;
  });
  afterEach(() => {
    delete INTRO_COURSE.watch;
  });

  const keptOff = async (planId: string) =>
    (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, planId), isNull(plannedWorkouts.archivedAt)))).map((r) => [r.effectiveDate, r.watchOff]).sort();

  it("places every outline kept off, in the insert itself", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    statements.length = 0;
    expect(sorted((await placeSlots(db, userId, p, MON, prefs, NOW)).placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0), day(1, 4)]));
    expect(await keptOff(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4)].map((d) => [d, true]));
    // No statement of its own: the rows are kept off from the moment they exist.
    const touching = writes().filter((s) => /"watch_off"/.test(s));
    expect(touching.length).toBeGreaterThan(0);
    expect(touching.every((s) => /^insert into "planned_workouts"/.test(s))).toBe(true);
  });

  it("a budgeted pass places them kept off too", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlotsWithin(db, userId, p, MON, prefs, NOW, 45);
    expect(await keptOff(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4)].map((d) => [d, true]));
  });

  it("a course without the flag places them on, and so does an adaptive programme", async () => {
    delete INTRO_COURSE.watch;
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await keptOff(p)).every(([, off]) => off === false)).toBe(true);
    const q = await seedProgramme({ weeklyGoal: 2, preferredDays: [0, 2], placementWeeksAhead: 1 });
    await placeSlots(db, userId, q, MON, prefs, NOW);
    expect((await keptOff(q)).length).toBeGreaterThan(0);
    expect((await keptOff(q)).every(([, off]) => off === false)).toBe(true);
  });

  it("an outline brought back by a pause lifted keeps what it had: the course's own, or the athlete's Put on", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const [friday, nextFriday] = [slotId(p, day(0, 4)), slotId(p, day(1, 4))];
    // The athlete put one on.
    await db.update(plannedWorkouts).set({ watchOff: false }).where(eq(plannedWorkouts.id, friday));
    await setPause(p, day(1, 4));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await row(friday)).archivedAt).not.toBeNull();
    await setPause(p, null);
    expect(sorted((await placeSlots(db, userId, p, MON, prefs, NOW)).placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0), day(1, 4)]));
    expect(await row(friday)).toMatchObject({ archivedAt: null, watchOff: false });
    expect(await row(nextFriday)).toMatchObject({ archivedAt: null, watchOff: true });
  });

  it("outlines placed before the flag keep what they were placed with: only a placing reads it", async () => {
    delete INTRO_COURSE.watch;
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    INTRO_COURSE.watch = false;
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await keptOff(p)).every(([, off]) => off === false)).toBe(true);
  });
});

describe("the quiet days before a race", () => {
  // Quiet from a week before the race (Friday of week 1) through race day (Friday of week 2), each end included.
  const RACE = day(2, 4);

  it("nothing's placed in the quiet days before the race; an adaptive programme isn't quieted", async () => {
    const raced = { ...prefs, raceDate: RACE };
    const p = await seedCourse({ placementWeeksAhead: 3, quietDaysBeforeRace: 7 });
    const res = await placeSlots(db, userId, p, MON, raced, NOW);
    expect(sorted(res.placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0), day(3, 0), day(3, 4)]));

    // The same days on an adaptive programme: everything but race day itself, which moves to the week's next day.
    const a = await seedProgramme({ weeklyGoal: 2, preferredDays: [0, 4], placementWeeksAhead: 3 });
    await placeSlots(db, userId, a, MON, raced, NOW);
    expect(await liveDates(a)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 1), day(3, 0), day(3, 4)]);
  });

  it("a race set later takes flexible slots off those days, and keeps a moved one", async () => {
    const p = await seedCourse({ placementWeeksAhead: 2, quietDaysBeforeRace: 7 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const moved = slotId(p, day(2, 0));
    await move(moved, day(2, 1));

    const res = await placeSlots(db, userId, p, MON, { ...prefs, raceDate: RACE }, NOW);
    expect(sorted(res.archived)).toEqual(ids(p, [day(1, 4), day(2, 4)]));
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(2, 1)]);
  });

  it("today's outline stays through them: only a pause takes today's", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1, quietDaysBeforeRace: 7 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const raced = { ...prefs, raceDate: day(0, 4) };
    const res = await placeSlots(db, userId, p, MON, raced, NOW);
    expect(res.archived).toEqual([slotId(p, day(0, 4))]);
    expect(await liveOn(p, MON)).toEqual([slotId(p, MON)]);
    // Not tried and refused by the re-check either: a settled pass doesn't attempt a write every hour.
    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, raced, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);
  });

  it("a pause overlapping them holds back both, retracts each slot once, and each ends on its own", async () => {
    // Paused through Monday of week 2; quiet from Friday of week 1 through Friday of week 2. Week 3 is clear of both.
    const raced = { ...prefs, raceDate: RACE };
    const p = await seedCourse({ placementWeeksAhead: 3, quietDaysBeforeRace: 7 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await setPause(p, day(2, 0));

    const res = await placeSlots(db, userId, p, MON, raced, NOW);
    expect(sorted(res.archived)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 4)]));
    expect(res.placed).toEqual([]);
    expect(await liveDates(p)).toEqual([day(3, 0), day(3, 4)]);
    expect(await placeSlots(db, userId, p, MON, raced, NOW)).toEqual(NOTHING);

    // The pause lifted: what it alone held comes back, and the quiet days still hold the rest.
    await setPause(p, null);
    const back = await placeSlots(db, userId, p, MON, raced, NOW);
    expect(sorted(back.placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0)]));
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(3, 0), day(3, 4)]);

    // Past the race, with no pause, a new week is placed as usual.
    const after = day(2, 5);
    expect(sorted((await placeSlots(db, userId, p, after, raced, NOW)).placed)).toEqual(ids(p, [day(4, 0), day(4, 4), day(5, 0), day(5, 4)]));
  });

  it("a race already run quiets nothing", async () => {
    const yesterday = addDays(MON, -1);
    const p = await seedCourse({ placementWeeksAhead: 1, quietDaysBeforeRace: 7 });
    expect(sorted((await placeSlots(db, userId, p, MON, { ...prefs, raceDate: yesterday }, NOW)).placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0), day(1, 4)]));
  });

  it("with no quiet days it keeps only race day clear", async () => {
    const p = await seedCourse({ placementWeeksAhead: 2, quietDaysBeforeRace: 0 });
    expect(sorted((await placeSlots(db, userId, p, MON, { ...prefs, raceDate: RACE }, NOW)).placed)).toEqual(ids(p, [day(0, 0), day(0, 4), day(1, 0), day(1, 4), day(2, 0)]));
  });
});

describe("a session completed today under a pause", () => {
  // Only `completionState` tells a session that's done from a slot a pause may take: it can still be an untouched outline
  // on its own day, as one linked by hand is (it takes its number and holds no document).
  const completedToday = async (seed: () => Promise<string>) => {
    const p = await seed();
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const id = slotId(p, MON);
    await db.update(plannedWorkouts).set({ completionState: "completed", resolutionDate: MON, courseSession: null }).where(eq(plannedWorkouts.id, id));
    await setPause(p, MON);
    return { p, id, before: await row(id) };
  };
  const kinds = [
    ["a course", () => seedCourse({ placementWeeksAhead: 1 })],
    ["an adaptive programme", () => seedProgramme({ weeklyGoal: 2, preferredDays: [0, 4], placementWeeksAhead: 1 })],
  ] as const;

  it.each(kinds)("survives a slot pass, and the pass never tries to take it: %s", async (_, seed) => {
    const { p, id, before } = await completedToday(seed);
    statements.length = 0;
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(res.archived).toEqual([]);
    expect(writes()).toEqual([]);
    expect(await row(id)).toEqual(before);
  });

  it.each(kinds)("the retraction's own check refuses it too: %s", async (_, seed) => {
    const { id, before } = await completedToday(seed);
    expect(await retractSlot(db, userId, { id }, MON, prefs, NOW, { todayToo: true })).toBe(false);
    expect(await row(id)).toEqual(before);
  });
});

describe("a restore", () => {
  const beginRestore = async () => {
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });
  };

  it("a restore in progress writes nothing", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await beginRestore();
    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(writes()).toEqual([]);
    expect(await rowsOf(p)).toEqual([]);
  });

  it("one beginning mid-pass stops it before it inserts a slot", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    race.begin = beginRestore;
    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(await rowsOf(p)).toEqual([]);
    expect(writes().filter((s) => !/account_state/.test(s))).toEqual([]);
  });

  it("one beginning mid-pass stops it before it retracts a slot", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await setPause(p, day(1, 4));
    const before = await rowsOf(p);
    expect(before).toHaveLength(4);
    race.begin = beginRestore;
    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect(await rowsOf(p)).toEqual(before);
    expect(writes().filter((s) => !/account_state/.test(s))).toEqual([]);
  });
});

describe("a retired course", () => {
  it("a retired course's flexible slots come off", async () => {
    const p = await seedCourse({ placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const moved = slotId(p, day(1, 0));
    await move(moved, day(1, 1));
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, p));

    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    // Today's and the moved one stay, as a programme's do; nothing new is placed.
    expect(sorted(res.archived)).toEqual(ids(p, [day(0, 4), day(1, 4), day(2, 0), day(2, 4)]));
    expect(res.placed).toEqual([]);
    expect(await liveDates(p)).toEqual([day(0, 0), day(1, 1)]);
    expect(await row(slotId(p, day(2, 4)))).toMatchObject({ archiveReason: "program_replaced" });
  });

  it("past the window too, wherever a wider window put them", async () => {
    const p = await seedCourse({ placementWeeksAhead: 4 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const [row0] = await db.select().from(programs).where(eq(programs.id, p));
    await db
      .update(programs)
      .set({ status: "retired", config: courseConfigSchema.parse({ ...row0!.config, placementWeeksAhead: 1 }) })
      .where(eq(programs.id, p));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await liveDates(p)).toEqual([day(0, 0)]);
  });
});

describe("a course whose definition is gone", () => {
  it("logs by code only, places nothing and doesn't throw the pass", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await seedCourse({ course: "an-old-course" }, { name: "A private name" });
    statements.length = 0;
    // The restore check and the plan: no count of sessions for a course it can't read.
    const res = await placeSlotsWithin(db, userId, p, MON, prefs, NOW, 45);
    expect(res).toEqual({ placed: [], archived: [], more: false, spent: 2 });
    expect(statements).toHaveLength(2);
    expect(await rowsOf(p)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    const said = String(log.mock.calls[0]![0]);
    expect(said).toContain("course_definition_missing");
    expect(said).not.toContain("A private name");
    expect(said).not.toContain("an-old-course");
    log.mockRestore();
  });

  it("retired, it needs no definition: its flexible outlines come off through goal 0, and it stops logging", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const today = await row(slotId(p, MON));
    const [stored] = await db.select().from(programs).where(eq(programs.id, p));
    await db
      .update(programs)
      .set({ status: "retired", config: courseConfigSchema.parse({ ...stored!.config, course: "an-old-course" }) })
      .where(eq(programs.id, p));

    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(sorted(res.archived)).toEqual(ids(p, [day(0, 4), day(1, 0), day(1, 4)]));
    expect(res.placed).toEqual([]);
    expect(await row(slotId(p, day(1, 4)))).toMatchObject({ archiveReason: "program_replaced" });
    // Today's outline is fixed, and says what it said: there's no definition to say anything else.
    expect(await row(slotId(p, MON))).toEqual(today);

    // Settled: the restore check, the plan and its rows. No count of sessions, and the hourly pass no longer visits.
    statements.length = 0;
    expect(await placeSlotsWithin(db, userId, p, MON, prefs, NOW, 45)).toEqual({ placed: [], archived: [], more: false, spent: 3 });
    expect(statements).toHaveLength(3);
    expect(await placeSlotsForAllPrograms(db, new Date(NOW))).toEqual({ programs: 0, placed: 0, archived: 0, failed: 0 });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("retired, the hourly pass visits it, retracts its outlines and counts no failure", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const [stored] = await db.select().from(programs).where(eq(programs.id, p));
    await db
      .update(programs)
      .set({ status: "retired", config: courseConfigSchema.parse({ ...stored!.config, course: "an-old-course" }) })
      .where(eq(programs.id, p));
    expect(await placeSlotsForAllPrograms(db, new Date(NOW))).toEqual({ programs: 1, placed: 0, archived: 3, failed: 0 });
    expect(await liveDates(p)).toEqual([MON]);
  });
});

describe("the hourly pass", () => {
  const AT = new Date(NOW);

  it("places active courses, retracts lingering ones, and one gone definition stops nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const active = await seedCourse({ placementWeeksAhead: 1 });
    const gone = await seedCourse({ course: "an-old-course" });
    const stopped = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, stopped, MON, prefs, NOW);
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, stopped));
    const other = await makeTestUser(db);
    const theirs = await seedCourse({ weekdays: [2], placementWeeksAhead: 1 }, {}, other.userId);

    const stats = await placeSlotsForAllPrograms(db, AT);
    // Four programmes visited; 4 + 2 slots placed; Friday, next Monday and next Friday retracted from the stopped one.
    expect(stats).toEqual({ programs: 4, placed: 6, archived: 3, failed: 0 });
    expect(await liveDates(active)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4)]);
    expect(await liveDates(theirs)).toEqual([day(0, 2), day(1, 2)]);
    expect(await liveDates(stopped)).toEqual([day(0, 0)]);
    expect(await rowsOf(gone)).toEqual([]);
    log.mockRestore();
  });

  it("settled, a stopped course is no longer visited; a written session doesn't make it linger", async () => {
    const stopped = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, stopped, MON, prefs, NOW);
    await writeSession(slotId(stopped, day(1, 4)), "Intro 1");
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, stopped));
    expect(await placeSlotsForAllPrograms(db, AT)).toMatchObject({ programs: 1, archived: 2, failed: 0 });
    expect(await placeSlotsForAllPrograms(db, AT)).toEqual({ programs: 0, placed: 0, archived: 0, failed: 0 });
    expect(await liveDates(stopped)).toEqual([day(0, 0), day(1, 4)]);
  });
});

describe("the pass's budget", () => {
  it("a settled course's pass is five statements, all declared: restore, plan, sessions done, rows, refresh", async () => {
    const p = await seedCourse({ placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    statements.length = 0;
    expect(await placeSlotsWithin(db, userId, p, MON, prefs, NOW, 45)).toEqual({ placed: [], archived: [], more: false, spent: 5 });
    expect(statements).toHaveLength(5);
  });

  // A retraction's room: six fixed statements (restore, plan, sessions done, rows, touched, restore again) and its 10.
  for (const budget of [36, 22, 16, 1]) {
    it(`a budget of ${budget}: each pass runs at most what it declares, and ends where one pass would`, async () => {
      const p = await seedCourse({ weekdays: [0, 1, 2, 3, 4, 5, 6], placementWeeksAhead: 2 });
      const passes: Array<{ ran: number; spent: number }> = [];
      const place = async () => {
        for (let i = 0; ; i++) {
          if (i > 40) throw new Error("placement never finished");
          statements.length = 0;
          const res = await placeSlotsWithin(db, userId, p, MON, prefs, NOW, budget);
          passes.push({ ran: statements.length, spent: res.spent });
          if (!res.more) return;
        }
      };
      await place();
      expect(await liveDates(p)).toHaveLength(21);

      // The same course retired: the retractions, at about eight statements each.
      await db.update(programs).set({ status: "retired" }).where(eq(programs.id, p));
      await place();
      expect(await liveDates(p)).toEqual([MON]);

      for (const pass of passes) expect(pass.ran, JSON.stringify(passes)).toBeLessThanOrEqual(pass.spent);
      if (budget >= 16) for (const pass of passes) expect(pass.spent, JSON.stringify(passes)).toBeLessThanOrEqual(budget);
    });
  }
});
