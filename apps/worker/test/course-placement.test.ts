/**
 * A COURSE'S SESSIONS PLACED AHEAD AS OUTLINES (plans with a purpose, spec §4.2 and §4.4). A course works as a programme's
 * slots do: rows on its days and at its time, counted by the day they were planned on, so what the athlete moved or
 * removed is never undone. An outline holds a title and a booked length and no document, so nothing reaches the watch
 * until its day. A pause (either kind) and a course's quiet days before the race hold days back, and take flexible slots
 * off them. A session written on its day (`origin` flipped to `studio`) holds its day and is never rewritten.
 *
 * Nearly every test runs on a made-up course (`course-fixture.ts`): worker code reads only the definition. `placeSlots`
 * reads no clock, so the fixed dates here can't go stale. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";
import { INTRO_COURSE, INTRO_FIRST_SECONDS, INTRO_LATER_SECONDS } from "./course-fixture.js";

const { plannedWorkouts, programs, accountState, calendarEventSuppressions } = schema;

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

/** A running course, on Monday and Friday at 19:30, unless a test says otherwise. */
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
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "19:30", ...config }),
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
const liveDates = async (planId: string): Promise<string[]> =>
  (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, planId), isNull(plannedWorkouts.archivedAt)))).map((r) => r.effectiveDate).sort();
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const ids = (planId: string, dates: string[]): string[] => sorted(dates.map((d) => slotId(planId, d)));
const setPause = (planId: string, pausedUntil: string | null) => db.update(programs).set({ pausedUntil }).where(eq(programs.id, planId));

async function move(workoutId: string, toDate: string): Promise<void> {
  await applyMove(db, { userId, workoutId, toDate, toTime: "19:30", source: "app", corosWritesEnabled: false });
}

/** What the day's write does (Task 10's flip, in the shape a document workout has): the row keeps its id. */
async function writeSession(workoutId: string, title: string): Promise<void> {
  await db
    .update(plannedWorkouts)
    .set({ origin: "studio", title, sourceContentFingerprint: "course", workoutDoc: JSON.stringify(INTRO_COURSE.sessionDoc(1, { ease: false })), workoutDocRev: 1 })
    .where(eq(plannedWorkouts.id, workoutId));
}

const complete = (workoutId: string) => db.update(plannedWorkouts).set({ completionState: "completed", resolutionDate: MON }).where(eq(plannedWorkouts.id, workoutId));

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
        effectiveTime: "19:30",
        fallbackEstimatedDurationSeconds: INTRO_FIRST_SECONDS,
        calendarBlockDurationSeconds: INTRO_FIRST_SECONDS,
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
    const monday1830 = "2026-10-06T01:30:00.000Z"; // the athlete's window (07:00) long gone, 19:30 still ahead
    const a = await seedCourse({ placementWeeksAhead: 1 });
    expect((await placeSlots(db, userId, a, MON, prefs, monday1830)).placed).toContain(slotId(a, MON));

    const monday2000 = "2026-10-06T03:00:00.000Z"; // 19:30 gone too
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
    expect(await row(slotId(p, MON))).toMatchObject({ workoutDoc: null, fallbackEstimatedDurationSeconds: seconds, effectiveTime: "19:30" });
  });
});

describe("an outline's length comes from the sessions actually done", () => {
  it("counts only what was completed, as the next session's number", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);

    // Skipped and missed change nothing: still session 1, 600 s. Completed in another plan changes nothing either.
    await db.update(plannedWorkouts).set({ completionState: "skipped" }).where(eq(plannedWorkouts.id, slotId(p, day(0, 0))));
    await db.update(plannedWorkouts).set({ completionState: "missed" }).where(eq(plannedWorkouts.id, slotId(p, day(0, 4))));
    const other = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, other, MON, prefs, NOW);
    await complete(slotId(other, day(0, 0)));
    await complete(slotId(other, day(0, 4)));
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual(NOTHING);
    expect((await row(slotId(p, day(1, 0)))).fallbackEstimatedDurationSeconds).toBe(INTRO_FIRST_SECONDS);

    // One done: session 2, still 600 s. Two done: session 3, 1,200 s, on every outline from today on.
    await complete(slotId(p, day(0, 0)));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await row(slotId(p, day(1, 0)))).fallbackEstimatedDurationSeconds).toBe(INTRO_FIRST_SECONDS);
    await complete(slotId(p, day(0, 4)));
    await placeSlots(db, userId, p, MON, prefs, NOW);
    for (const date of [day(1, 0), day(1, 4)]) {
      expect(await row(slotId(p, date))).toMatchObject({ fallbackEstimatedDurationSeconds: INTRO_LATER_SECONDS, calendarBlockDurationSeconds: INTRO_LATER_SECONDS });
    }
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
    await complete(slotId(p, day(0, 0)));
    await complete(slotId(p, day(0, 4)));
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

    await db.update(programs).set({ status: "retired", pausedUntil: null }).where(eq(programs.id, p));
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).not.toContain(written);
    expect((await row(written)).archivedAt).toBeNull();
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

  it("a workout the coach filed under the plan on another day isn't taken as a slot", async () => {
    const p = await seedCourse({ placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const filed = newId();
    await db.insert(plannedWorkouts).values({
      id: filed, userId, planId: p, sourceWorkoutId: filed, title: "Extra", category: "yoga", sport: "yoga", originalPlanDate: day(1, 2), lastVerifiedCorosDate: "",
      effectiveDate: day(1, 2), effectiveTime: "12:00", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 600, calendarBlockDurationSeconds: 600,
      origin: "studio", contentState: "outline", completionState: "scheduled", createdAt: NOW, updatedAt: NOW,
    });
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await row(filed)).toMatchObject({ archivedAt: null, title: "Extra", effectiveDate: day(1, 2) });
    // It's one of the plan's sessions that week, so by rule 1 it counts toward the week's two: the last outline makes way.
    expect(res.archived).toEqual([slotId(p, day(1, 4))]);
    expect(res.placed).toEqual([]);
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
    // Today's slot is fixed; the moved one stays; Friday and next Friday (its last day: `date <= pausedUntil`) come off.
    expect(sorted(res.archived)).toEqual(ids(p, [day(0, 4), day(1, 4)]));
    expect(res.placed).toEqual([]);
    expect(await row(moved)).toMatchObject({ effectiveDate: day(1, 1), archivedAt: null });
    expect(await row(slotId(p, day(1, 4)))).toMatchObject({ archiveReason: "program_replaced" });
    expect(await liveDates(p)).toEqual([day(0, 0), day(1, 1), day(2, 0), day(2, 4)]);
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
    expect(sorted(res.placed)).toEqual(ids(p, [day(0, 4), day(1, 0), day(1, 4)]));
    expect(await row(friday)).toMatchObject({ archivedAt: null, archiveReason: null, effectiveTime: "19:30" });
    expect(await db.select().from(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, friday))).toEqual([]);
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
      expect(sorted(res.archived)).toEqual(ids(p, [day(0, 2), day(1, 0)]));
      expect(res.placed).toEqual([]);
      expect(await liveDates(p)).toEqual([day(0, 0), day(1, 2)]);
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
