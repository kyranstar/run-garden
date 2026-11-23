/**
 * A PLAN WITH A RHYTHM LONGER THAN A WEEK (R1.6; the root cause of "change TRE to every two weeks", DEBUG-tre-cadence §4): a
 * course or a programme on its days every 2 to 4 weeks, from an anchor Monday. Placement gives a week the rhythm skips a goal
 * of 0, so off weeks hold none of its sessions by the rules every week already follows: flexible outlines there are
 * retracted, and what the athlete skipped, moved or had written stays. The window reaches far enough that the next session
 * is always on the plan. Every week places exactly what it always has.
 *
 * On the made-up course (`course-fixture.ts`): worker code reads only the definition. `placeSlots` reads no clock, so the
 * fixed dates can't go stale. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});

import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, addDays, courseConfigSchema, newId, type AdaptiveConfig, type CourseConfig, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyMove } from "../src/services/jobs.js";
import { placeSlots, previewPlacement, slotId } from "../src/services/program-slots.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";
import { INTRO_COURSE } from "./course-fixture.js";

const { plannedWorkouts, programs } = schema;

/** Monday 23 November 2026: the week the owner's rhythm starts. */
const MON = "2026-11-23";
/** Monday 04:00 in Los Angeles, the test user's zone. */
const NOW = "2026-11-23T12:00:00.000Z";
/** `weekday` 0 = Monday … 6 = Sunday, `week` weeks after MON's. */
const day = (week: number, weekday: number): string => addDays(MON, 7 * week + weekday);
const EVERY_2 = { everyWeeks: 2, cadenceFrom: MON } as const;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let statements: string[];

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db));
});

const writes = () => statements.filter(isWrite);

async function seedCourse(config: Partial<CourseConfig> = {}): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id, userId, kind: "course", name: "TRE", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "19:30", ...config }),
    onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null,
  });
  return id;
}

async function seedProgramme(config: Partial<AdaptiveConfig>): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id, userId, kind: "adaptive", name: "Jaw care", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
    config: adaptiveConfigSchema.parse(config), createdAt: NOW, updatedAt: NOW, archivedAt: null,
  });
  return id;
}

const setConfig = (planId: string, config: Record<string, unknown>) => db.update(programs).set({ config }).where(eq(programs.id, planId));
const configOf = async (planId: string) => (await db.select().from(programs).where(eq(programs.id, planId)))[0]!.config as Record<string, unknown>;
const row = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const liveDates = async (planId: string): Promise<string[]> =>
  (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, planId), isNull(plannedWorkouts.archivedAt)))).map((r) => r.effectiveDate).sort();
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const ids = (planId: string, dates: string[]): string[] => sorted(dates.map((d) => slotId(planId, d)));

describe("a course every 2 weeks", () => {
  it("Monday every 2 weeks from 23 Nov places 23 Nov and 7 Dec only", async () => {
    const p = await seedCourse({ weekdays: [0], ...EVERY_2 });
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(sorted(res.placed)).toEqual(ids(p, [day(0, 0), day(2, 0)]));
    expect(await liveDates(p)).toEqual([day(0, 0), day(2, 0)]);
  });

  it("a second pass writes nothing", async () => {
    const p = await seedCourse({ weekdays: [0], ...EVERY_2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
    expect(writes()).toEqual([]);
  });

  it("with the clock two weeks on, 21 Dec is placed and 14 Dec isn't", async () => {
    const p = await seedCourse({ weekdays: [0], ...EVERY_2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const later = day(2, 0);
    const res = await placeSlots(db, userId, p, later, prefs, "2026-12-07T12:00:00.000Z");
    expect(res.placed).toEqual([slotId(p, day(4, 0))]);
    expect(await liveDates(p)).toEqual([day(0, 0), day(2, 0), day(4, 0)]);
    expect(res.placed).not.toContain(slotId(p, day(3, 0)));
  });

  it("an off week this week holds nothing, and the next on week is placed", async () => {
    // Anchored a week on: this week is off.
    const p = await seedCourse({ weekdays: [0, 4], everyWeeks: 2, cadenceFrom: day(1, 0) });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await liveDates(p)).toEqual([day(1, 0), day(1, 4)]);
  });

  it("every week places exactly what it always has", async () => {
    const p = await seedCourse({ weekdays: [0, 4] });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 4)]);
    expect(Object.keys(await configOf(p))).not.toContain("everyWeeks");
  });
});

describe("going from every week to every 2 weeks", () => {
  it("retracts the off weeks' flexible outlines and the dropped day's; what the athlete did stays", async () => {
    const p = await seedCourse({ weekdays: [0, 4] });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    // Monday's is written today and the athlete skips Friday's; in two weeks' time they move the Monday to the Tuesday.
    await db
      .update(plannedWorkouts)
      .set({ origin: "studio", courseSession: 1, workoutDoc: JSON.stringify(INTRO_COURSE.sessionDoc(1, { ease: false })), workoutDocRev: 1 })
      .where(eq(plannedWorkouts.id, slotId(p, day(0, 0))));
    await db.update(plannedWorkouts).set({ completionState: "skipped", sanctionedBy: "coach", resolutionDate: MON }).where(eq(plannedWorkouts.id, slotId(p, day(0, 4))));
    await applyMove(db, { userId, workoutId: slotId(p, day(2, 0)), toDate: day(2, 1), toTime: "19:30", source: "app", corosWritesEnabled: false });

    await setConfig(p, courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0], time: "19:30", ...EVERY_2 }));
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    // The off week's two (next week) and the dropped Friday in two weeks go; a Monday-only course every week would keep 30 Nov.
    expect(sorted(res.archived)).toEqual(ids(p, [day(1, 0), day(1, 4), day(2, 4)]));
    expect(res.placed).toEqual([]);
    expect((await row(slotId(p, day(1, 0)))).archiveReason).toBe("program_replaced");
    // Written, skipped and moved stay.
    expect(await row(slotId(p, day(0, 0)))).toMatchObject({ archivedAt: null, origin: "studio" });
    expect(await row(slotId(p, day(0, 4)))).toMatchObject({ archivedAt: null, completionState: "skipped" });
    expect(await row(slotId(p, day(2, 0)))).toMatchObject({ archivedAt: null, effectiveDate: day(2, 1) });
    expect(await liveDates(p)).toEqual([day(0, 0), day(0, 4), day(2, 1)]);

    statements.length = 0;
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
    expect(writes()).toEqual([]);
  });

  it("and back to every week brings the same retracted outline back", async () => {
    const weekly = courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0], time: "19:30" });
    const p = await seedCourse({ weekdays: [0] });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await setConfig(p, { ...weekly, ...EVERY_2 });
    expect((await placeSlots(db, userId, p, MON, prefs, NOW)).archived).toEqual([slotId(p, day(1, 0))]);
    await setConfig(p, weekly);
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(res.placed).toEqual([slotId(p, day(1, 0))]);
    expect(await row(slotId(p, day(1, 0)))).toMatchObject({ archivedAt: null, archiveReason: null, contentState: "outline" });
    expect(await liveDates(p)).toEqual([day(0, 0), day(1, 0), day(2, 0)]);
  });
});

describe("the window reaches the next session", () => {
  it("every 4 weeks, in an off week, still has the next one on the plan", async () => {
    // Anchored 23 Nov: 30 Nov is off, and the next on week (21 Dec) is three weeks ahead, past a 2-week window.
    const p = await seedCourse({ weekdays: [0], everyWeeks: 4, cadenceFrom: MON });
    const today = day(1, 0);
    await placeSlots(db, userId, p, today, prefs, "2026-11-30T12:00:00.000Z");
    expect(await liveDates(p)).toEqual([day(4, 0)]);
  });

  it("every 3 weeks, the window is the course's own when that is longer", async () => {
    const p = await seedCourse({ weekdays: [0], everyWeeks: 3, cadenceFrom: MON, placementWeeksAhead: 4 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await liveDates(p)).toEqual([day(0, 0), day(3, 0)]);
  });
});

describe("what holds days back still holds", () => {
  it("a pause takes an on week's session; the next on week comes after it", async () => {
    const p = await seedCourse({ weekdays: [0], ...EVERY_2 });
    await db.update(programs).set({ pausedUntil: day(2, 2) }).where(eq(programs.id, p));
    await placeSlots(db, userId, p, day(0, 1), prefs, "2026-11-24T12:00:00.000Z");
    expect(await liveDates(p)).toEqual([]);
    await placeSlots(db, userId, p, day(2, 3), prefs, "2026-12-10T12:00:00.000Z");
    expect(await liveDates(p)).toEqual([day(4, 0)]);
  });

  it("a race's quiet days keep an on week's session off", async () => {
    const p = await seedCourse({ weekdays: [0], ...EVERY_2, quietDaysBeforeRace: 7 });
    await placeSlots(db, userId, p, MON, { ...prefs, raceDate: day(2, 3) }, NOW);
    expect(await liveDates(p)).toEqual([day(0, 0)]);
  });
});

describe("a programme every 2 weeks (the twin)", () => {
  it("places its goal on its days in the weeks the rhythm uses, and none between", async () => {
    const p = await seedProgramme({ weeklyGoal: 2, preferredDays: [1, 3], ...EVERY_2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await liveDates(p)).toEqual([day(0, 1), day(0, 3), day(2, 1), day(2, 3)]);
  });
});

describe("previewPlacement, for a course too", () => {
  it("says where a course's sessions would go with another rhythm, written nowhere", async () => {
    const p = await seedCourse({ weekdays: [0, 4] });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const program = { id: p, kind: "course" as const, status: "active", disciplines: ["yoga"], pausedUntil: null };
    const config = courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0], time: "19:30", ...EVERY_2 });
    statements.length = 0;
    const preview = await previewPlacement(db, userId, program, config, MON, prefs, NOW);
    expect(writes()).toEqual([]);
    expect(preview.before).toEqual([day(0, 0), day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 4)]);
    expect(preview.after).toEqual([day(0, 0), day(2, 0)]);
  });
});
