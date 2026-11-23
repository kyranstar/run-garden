/**
 * A CALM COURSE ISN'T HELD BACK BY A RACE, AND A PREVIEW SAYS WHY A DATE IS (R1.7; r1-7/BRIEF.md, r1-6/FOLLOWUPS.md "Found live").
 *
 * On 23 Nov the owner's TRE, every two weeks on Mondays from 23 Nov, read "Next TRE Mon 23 Nov, then Mon 21 Dec": their race
 * (a 10K time trial, Sat 12 Dec) held 5–12 Dec quiet, so Mon 7 Dec was passed over, and nothing said so. Quiet days protect a
 * taper from training load, and a calming practice carries none: a course whose definition says `holdForRace: false` places
 * on its days through them (race day itself stays clear). A course a race does hold back keeps R1.6's rule, and the preview
 * now names each date of its rhythm a rule holds back, with the rule (`heldBack`), so the card can say it.
 *
 * The real TRE (calm) beside the made-up course of `course-fixture.ts` (which a race holds back, as R1.6 read every course).
 * Fixed dates; `placeSlots` reads no clock. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});

import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { courseConfigSchema, newId, type CourseConfig, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { previewPlacement, placeSlots, quietDaysOf, slotId } from "../src/services/program-slots.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { INTRO_COURSE } from "./course-fixture.js";

const { plannedWorkouts, programs } = schema;

let db: Db;
let userId: string;
let prefs: UserPreferences;

/** The owner's race: a Saturday, so 5–12 Dec are its quiet days at 7. */
const RACE = "2026-12-12";
/** Mon 23 Nov 2026, 09:00 in Los Angeles. */
const MON23 = "2026-11-23";
const MON23_NOW = "2026-11-23T17:00:00.000Z";
/** Mon 30 Nov, 00:30 in Los Angeles: the day's first hourly pass. */
const MON30 = "2026-11-30";
const MON30_FIRST_PASS = "2026-11-30T08:30:00.000Z";

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { raceDate: RACE }));
});

async function seedCourse(course: string, config: Partial<CourseConfig>, over: Partial<typeof programs.$inferInsert> = {}): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id, userId, kind: "course", name: "TRE", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
    config: courseConfigSchema.parse({ course, weekdays: [0, 4], time: "19:30", ...config }), onEnd: "continue", createdAt: MON23_NOW, updatedAt: MON23_NOW,
    archivedAt: null, ...over,
  });
  return id;
}

const liveDates = async (planId: string): Promise<string[]> =>
  (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, planId), isNull(plannedWorkouts.archivedAt)))).map((r) => r.effectiveDate).sort();
const rowOf = (planId: string) => db.select().from(programs).where(eq(programs.id, planId)).then((r) => r[0]!);

describe("which course a race holds back", () => {
  it("TRE (calm) is placed through the week before the race: no quiet days, only race day kept clear", async () => {
    const p = await seedCourse("tre", { weekdays: [0, 4], placementWeeksAhead: 3, quietDaysBeforeRace: 7 });
    await placeSlots(db, userId, p, MON23, prefs, MON23_NOW);
    expect(await liveDates(p)).toEqual(["2026-11-23", "2026-11-27", "2026-11-30", "2026-12-04", "2026-12-07", "2026-12-11", "2026-12-14", "2026-12-18"]);
  });

  it("a course a race holds back keeps its quiet days, 5–12 Dec: R1.6's rule, unchanged", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0, 4], placementWeeksAhead: 3, quietDaysBeforeRace: 7 });
    await placeSlots(db, userId, p, MON23, prefs, MON23_NOW);
    expect(await liveDates(p)).toEqual(["2026-11-23", "2026-11-27", "2026-11-30", "2026-12-04", "2026-12-14", "2026-12-18"]);
  });

  it("race day stays clear even for TRE", async () => {
    const p = await seedCourse("tre", { weekdays: [5], placementWeeksAhead: 3 });
    await placeSlots(db, userId, p, MON23, prefs, MON23_NOW);
    expect(await liveDates(p)).toEqual(["2026-11-28", "2026-12-05", "2026-12-19"]);
  });

  it("quietDaysOf: none for a calm course whatever it stores; a course a race holds back, its own; a course gone, its own", () => {
    const parse = (course: string, q: number) => courseConfigSchema.parse({ course, weekdays: [0], time: "19:30", quietDaysBeforeRace: q });
    expect(quietDaysOf(parse("tre", 7))).toBeNull();
    expect(quietDaysOf(parse("posture-neck", 10))).toBeNull();
    expect(quietDaysOf(parse(INTRO_COURSE.id, 7))).toBe(7);
    expect(quietDaysOf(parse(INTRO_COURSE.id, 0))).toBe(0);
    expect(quietDaysOf(parse("gone", 5))).toBe(5);
  });
});

// ── The owner's exact case (BRIEF "Timing") ────────────────────────────────────────────────────────────────────────────

/** TRE as it stands on the owner's account now: Mondays, every 2 weeks from 23 Nov, at 19:30, quiet days stored at 7 (the
 * default every course was written with); Mon 16 Nov done, Mon 23 Nov placed. `course` picks the definition. */
async function ownerTre(course: string): Promise<string> {
  const p = await seedCourse(course, { weekdays: [0], everyWeeks: 2, cadenceFrom: MON23, quietDaysBeforeRace: 7, placementWeeksAhead: 2 });
  const done = `done-${p}`;
  await db.insert(plannedWorkouts).values({
    id: done, userId, planId: p, sourceWorkoutId: done, title: "TRE", category: "yoga", sport: "yoga", originalPlanDate: "2026-11-16", lastVerifiedCorosDate: "",
    effectiveDate: "2026-11-16", effectiveTime: "19:30", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 1200, calendarBlockDurationSeconds: 1200,
    origin: "studio", contentState: "outline", completionState: "completed", courseSession: 1, createdAt: MON23_NOW, updatedAt: MON23_NOW,
  });
  // Placed as R1.6 placed it on 23 Nov: 23 Nov alone (7 Dec held back by the race).
  await db.insert(plannedWorkouts).values({
    id: slotId(p, MON23), userId, planId: p, sourceWorkoutId: slotId(p, MON23), title: "TRE", category: "yoga", sport: "yoga", originalPlanDate: MON23, lastVerifiedCorosDate: "",
    effectiveDate: MON23, effectiveTime: "19:30", sourceContentFingerprint: "program", fallbackEstimatedDurationSeconds: 1200, calendarBlockDurationSeconds: 1200,
    origin: "program", contentState: "outline", completionState: "scheduled", createdAt: MON23_NOW, updatedAt: MON23_NOW,
  });
  return p;
}

describe("the owner's TRE: Mondays every 2 weeks from 23 Nov at 19:30, race Sat 12 Dec", () => {
  it("on Mon 30 Nov the first pass places Mon 7 Dec", async () => {
    const p = await ownerTre("tre");
    const res = await placeSlots(db, userId, p, MON30, prefs, MON30_FIRST_PASS);
    expect(res.placed).toEqual([slotId(p, "2026-12-07")]);
    expect((await liveDates(p)).filter((d) => d >= MON30)).toEqual(["2026-12-07"]);
    // At 19:30, as its time says.
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, slotId(p, "2026-12-07")));
    expect(row!.effectiveTime).toBe("19:30");
    // And a second pass writes nothing more.
    expect(await placeSlots(db, userId, p, MON30, prefs, MON30_FIRST_PASS)).toEqual({ placed: [], archived: [] });
  });

  it("with R1.6's rule (a course a race holds back, as every course was) the same pass leaves 7 Dec off", async () => {
    const p = await ownerTre(INTRO_COURSE.id);
    const res = await placeSlots(db, userId, p, MON30, prefs, MON30_FIRST_PASS);
    expect(res.placed).toEqual([]);
    expect((await liveDates(p)).filter((d) => d >= MON30)).toEqual([]);
  });

  it("7 Dec is in the window from Mon 23 Nov already: any pass after the release places it", async () => {
    const p = await ownerTre("tre");
    expect((await placeSlots(db, userId, p, MON23, prefs, MON23_NOW)).placed).toEqual([slotId(p, "2026-12-07")]);
  });

  it("the stored 7 isn't rewritten: the calm rule is the definition's, so a rollback reads the row as it was", async () => {
    const p = await ownerTre("tre");
    await placeSlots(db, userId, p, MON30, prefs, MON30_FIRST_PASS);
    expect((await rowOf(p)).config).toMatchObject({ quietDaysBeforeRace: 7 });
  });
});

// ── What the preview says is held back, and why (`heldBack`) ─────────────────────────────────────────────────────────────

const preview = async (p: string, today = MON23, now = MON23_NOW, raced: UserPreferences = prefs) => {
  const row = await rowOf(p);
  return previewPlacement(db, userId, { ...row, kind: "course" }, courseConfigSchema.parse(row.config), today, raced, now);
};

describe("the preview's held-back dates", () => {
  it("a course a race holds back: Mon 7 Dec, for the race's quiet days; Next stays the next real sessions", async () => {
    const p = await ownerTre(INTRO_COURSE.id);
    const out = await preview(p);
    expect(out.after).toEqual([MON23]);
    expect(out.beyond).toEqual(["2026-12-21", "2027-01-04", "2027-01-18"]);
    expect(out.heldBack).toEqual([{ date: "2026-12-07", reason: "race_quiet" }]);
  });

  it("TRE: nothing held back, and 7 Dec is next", async () => {
    const p = await ownerTre("tre");
    const out = await preview(p);
    expect(out.after).toEqual([MON23, "2026-12-07"]);
    expect(out.heldBack).toEqual([]);
  });

  it("a pause: each date of the rhythm it covers, today's untouched outline included", async () => {
    const p = await ownerTre("tre");
    await db.update(programs).set({ pausedUntil: "2026-12-10" }).where(eq(programs.id, p));
    const out = await preview(p);
    expect(out.heldBack).toEqual([
      { date: MON23, reason: "paused" },
      { date: "2026-12-07", reason: "paused" },
    ]);
    expect([...out.after, ...out.beyond].sort().slice(0, 2)).toEqual(["2026-12-21", "2027-01-04"]);
  });

  it("race day, for a course on Saturdays: race_day, calm or not", async () => {
    const p = await seedCourse("tre", { weekdays: [5], placementWeeksAhead: 3 });
    const out = await preview(p);
    expect(out.heldBack).toEqual([{ date: RACE, reason: "race_day" }]);
  });

  it("a date past the window is named too, as the beyond scan passes it", async () => {
    // Mondays every week, one week ahead: the window ends Sun 6 Dec; the race on Sat 19 Dec holds Mon 14 Dec.
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], placementWeeksAhead: 1 });
    const out = await preview(p, MON23, MON23_NOW, { ...prefs, raceDate: "2026-12-19" });
    expect(out.beyond).toEqual(["2026-12-07", "2026-12-21", "2026-12-28"]);
    expect(out.heldBack).toEqual([{ date: "2026-12-14", reason: "race_quiet" }]);
  });

  // Added for the mutation run's survivor (M4): a session that stays there by the athlete's move holds no slot of that date.
  it("a session the athlete moved onto a quiet day isn't named: it stays, and is Next", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON23, prefs, MON23_NOW);
    // Mon 30 Nov's session moved by the athlete to Mon 7 Dec, a quiet day before the race of Sat 12 Dec.
    await db.update(plannedWorkouts).set({ effectiveDate: "2026-12-07" }).where(eq(plannedWorkouts.id, slotId(p, "2026-11-30")));
    const out = await preview(p);
    expect(out.after).toContain("2026-12-07");
    expect(out.heldBack).toEqual([]);
  });

  it("a session that stays on a quiet day isn't named: today's outline stays through them", async () => {
    const p = await seedCourse(INTRO_COURSE.id, { weekdays: [0], placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON23, { ...prefs, raceDate: null }, MON23_NOW);
    const out = await preview(p, MON23, MON23_NOW, { ...prefs, raceDate: "2026-11-28" });
    expect(out.after).toContain(MON23);
    expect(out.heldBack).toEqual([]);
  });

  it("a day the athlete skipped ahead isn't named: it's theirs, not the rule's", async () => {
    const p = await ownerTre(INTRO_COURSE.id);
    // 7 Dec placed before the race was set, then skipped by the athlete.
    await placeSlots(db, userId, p, MON23, { ...prefs, raceDate: null }, MON23_NOW);
    await db.update(plannedWorkouts).set({ completionState: "skipped", resolutionDate: MON23 }).where(eq(plannedWorkouts.id, slotId(p, "2026-12-07")));
    const out = await preview(p);
    expect(out.heldBack).toEqual([]);
  });

  it("a stopped course names nothing", async () => {
    const p = await ownerTre(INTRO_COURSE.id);
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, p));
    expect((await preview(p)).heldBack).toEqual([]);
  });
});
