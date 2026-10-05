/**
 * An adaptive program's slots (Phase 2 spec §2a "Slot placement"; programme spec §9.1).
 *
 * Placement fills each week from this one to `placementWeeksAhead` ahead with the weekly goal, preferred days
 * first, and it is idempotent: anything the athlete did to a slot (moved it, skipped it, removed it) counts for
 * the week the slot was planned in, so it is never placed again. An edit re-places only future, unmoved, outline
 * slots; those it no longer wants leave with `archive_reason = 'program_replaced'` and one `user_removed`
 * suppression.
 *
 * `placeSlots` reads no clock (today and now are arguments), so the fixed dates here cannot go stale. The tests
 * that run the cron, an import or a calendar sync use the real today, because those do.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  adaptiveConfigSchema,
  addDays,
  newId,
  nowInstant,
  startOfIsoWeek,
  todayInZone,
  type AdaptiveConfig,
  type UserPreferences,
} from "@rg/domain";
import { FixtureTrainingProvider } from "@rg/providers";
import type { GoogleEventResource } from "@rg/calendar";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { connectTestCoros, isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const google = vi.hoisted(() => ({ fake: null as unknown }));
vi.mock("../src/services/google-calendar.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/google-calendar.js")>()),
  googleCalendarClient: vi.fn(async () => google.fake),
}));

import { placeSlots, placeSlotsForAllPrograms, slotId } from "../src/services/program-slots.js";
import { applyMove } from "../src/services/jobs.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { hourly } from "../src/index.js";

const { plannedWorkouts, programs, calendarEventSuppressions, accountState } = schema;

/** A Monday. */
const MON = "2026-10-05";
const NOW = "2026-10-05T12:00:00.000Z";
/** `weekday` 0 = Monday … 6 = Sunday (the config's numbering), `week` weeks after MON's. */
const day = (week: number, weekday: number): string => addDays(MON, 7 * week + weekday);

const PREFERRED = [0, 2, 4, 5]; // Mon, Wed, Fri, Sat

let db: Db;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db));
  google.fake = null;
});

async function seedProgram(
  d: Db,
  owner: string,
  config: Partial<AdaptiveConfig> = {},
  over: Partial<typeof programs.$inferInsert> = {},
): Promise<string> {
  const id = newId();
  await d.insert(programs).values({
    id,
    userId: owner,
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

async function setConfig(programId: string, patch: Partial<AdaptiveConfig>): Promise<void> {
  const [p] = await db.select().from(programs).where(eq(programs.id, programId));
  await db
    .update(programs)
    .set({ config: adaptiveConfigSchema.parse({ ...p!.config, ...patch }) })
    .where(eq(programs.id, programId));
}

async function rowsOf(programId: string, d: Db = db) {
  return d.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, programId));
}

async function row(id: string) {
  const [r] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
  return r!;
}

async function suppressionsOf(workoutId: string) {
  return db.select().from(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, workoutId));
}

const sorted = (xs: string[]): string[] => [...xs].sort();
const ids = (programId: string, dates: string[]): string[] => sorted(dates.map((d) => slotId(programId, d)));

async function move(workoutId: string, toDate: string): Promise<void> {
  await applyMove(db, { userId, workoutId, toDate, toTime: "07:00", source: "app", corosWritesEnabled: false });
}

describe("placement", () => {
  it("places the weekly goal on the preferred days, this week and placementWeeksAhead weeks ahead", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 4, preferredDays: PREFERRED, placementWeeksAhead: 2 });
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    const dates = [0, 1, 2].flatMap((w) => PREFERRED.map((d) => day(w, d)));
    expect(sorted(res.placed)).toEqual(ids(p, dates));
    expect(res.archived).toEqual([]);
    expect(sorted((await rowsOf(p)).map((r) => r.id))).toEqual(ids(p, dates));

    // The row shape (spec §2a): a calendar_only outline the reconciler books.
    const wed = await row(slotId(p, day(0, 2)));
    expect(wed).toMatchObject({
      userId,
      planId: p,
      sourceWorkoutId: wed.id,
      sourceProgramId: null,
      sourceIdInPlan: null,
      title: "Mobility",
      category: "yoga",
      qualitySubtype: null,
      sport: "yoga",
      originalPlanDate: day(0, 2),
      lastVerifiedCorosDate: "",
      effectiveDate: day(0, 2),
      effectiveTime: prefs.weekdayMorningTime,
      sourceContentFingerprint: "program",
      sourceVersion: null,
      sourceEstimatedDurationSeconds: null,
      fallbackEstimatedDurationSeconds: 30 * 60,
      calendarBlockDurationSeconds: 30 * 60,
      durationEstimate: null,
      expectedDistanceMeters: null,
      stageSummary: null,
      structuredJson: null,
      calendarSyncState: "not_created",
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      missingReads: 0,
      snoozedUntil: null,
      resolutionDate: null,
      sanctionedBy: null,
      archivedAt: null,
      archiveReason: null,
      origin: "program",
      contentState: "outline",
      sessionParams: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // The athlete's own window: Saturday is a weekend morning.
    expect((await row(slotId(p, day(0, 5)))).effectiveTime).toBe(prefs.weekendMorningTime);
  });

  it("fills this week from today, never before it: preferred days first, then the rest Monday → Sunday", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 4, preferredDays: PREFERRED, placementWeeksAhead: 1 });
    const thursday = day(0, 3);
    const res = await placeSlots(db, userId, p, thursday, prefs, NOW);
    // This week: Fri and Sat (preferred, not past), then Thu and Sun (the rest, from today).
    const thisWeek = [day(0, 3), day(0, 4), day(0, 5), day(0, 6)];
    const nextWeek = PREFERRED.map((d) => day(1, d));
    expect(sorted(res.placed)).toEqual(ids(p, [...thisWeek, ...nextWeek]));
    expect((await rowsOf(p)).every((r) => r.effectiveDate >= thursday)).toBe(true);
  });

  it("uses the program's default discipline: strength when the program leads with it", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 1, preferredDays: [2], placementWeeksAhead: 1 }, { disciplines: ["strength"] });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await row(slotId(p, day(0, 2)))).toMatchObject({ category: "strength", sport: "strength" });
  });

  it("is idempotent: a second run places nothing and writes nothing", async () => {
    const writes: string[] = [];
    const recDb = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => isWrite(sql) && writes.push(sql) });
    const { userId: u, prefs: pr } = await makeTestUser(recDb);
    const p = await seedProgram(recDb, u, { weeklyGoal: 4, preferredDays: PREFERRED });
    await placeSlots(recDb, u, p, MON, pr, NOW);
    const before = (await rowsOf(p, recDb)).length;
    writes.length = 0;

    expect(await placeSlots(recDb, u, p, MON, pr, NOW)).toEqual({ placed: [], archived: [] });
    expect(writes).toEqual([]);
    expect((await rowsOf(p, recDb)).length).toBe(before);
  });

  it("goes through day-collision placement: a slot on a run's day moves off the run's time", async () => {
    const runId = newId();
    await db.insert(plannedWorkouts).values({
      id: runId,
      userId,
      planId: "coros-plan",
      sourceWorkoutId: `src-${runId}`,
      title: "Easy run",
      category: "easy",
      sport: "run",
      originalPlanDate: day(0, 2),
      lastVerifiedCorosDate: day(0, 2),
      effectiveDate: day(0, 2),
      effectiveTime: prefs.weekdayMorningTime,
      sourceContentFingerprint: "fp",
      fallbackEstimatedDurationSeconds: 3600,
      calendarBlockDurationSeconds: 3600,
      completionState: "scheduled",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const p = await seedProgram(db, userId, { weeklyGoal: 1, preferredDays: [2], placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await row(runId)).effectiveTime).toBe(prefs.weekdayMorningTime);
    expect((await row(slotId(p, day(0, 2)))).effectiveTime).not.toBe(prefs.weekdayMorningTime);
  });

  it("stays under D1's bound-variable cap for the largest program (7 a week, 4 weeks ahead)", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 7, placementWeeksAhead: 4 });
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(res.placed).toHaveLength(35);
    expect(await rowsOf(p)).toHaveLength(35);
  });
});

describe("what the athlete did to a slot is never undone", () => {
  it("a slot moved to next week is not re-placed this week, and next week gets no extra", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 4, preferredDays: PREFERRED, placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const fri = slotId(p, day(0, 4));
    await move(fri, day(1, 1));

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
    const live = (await rowsOf(p)).filter((r) => !r.archivedAt);
    const inWeek = (w: number) => live.filter((r) => r.effectiveDate >= day(w, 0) && r.effectiveDate <= day(w, 6));
    expect(sorted(inWeek(0).map((r) => r.effectiveDate))).toEqual([day(0, 0), day(0, 2), day(0, 5)]);
    // Next week: its own four, plus the one the athlete brought over.
    expect(sorted(inWeek(1).map((r) => r.id))).toEqual(sorted([...ids(p, PREFERRED.map((d) => day(1, d))), fri]));
    expect(await row(fri)).toMatchObject({ originalPlanDate: day(0, 4), effectiveDate: day(1, 1), archivedAt: null });
  });

  it("a skipped slot and a removed slot are not re-placed", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 4, preferredDays: PREFERRED, placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await db
      .update(plannedWorkouts)
      .set({ completionState: "skipped", resolutionDate: MON })
      .where(eq(plannedWorkouts.id, slotId(p, day(1, 2))));
    await removeFromPlan(db, userId, slotId(p, day(2, 4)), { now: NOW, source: "remove_from_plan", prefs });

    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
    expect(await row(slotId(p, day(2, 4)))).toMatchObject({ archiveReason: "user_removed" });
  });
});

describe("re-placement after an edit", () => {
  it("lowering the goal archives the latest unmoved outline slot in each week — never a moved or built one", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 4, preferredDays: PREFERRED, placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await move(slotId(p, day(1, 5)), day(1, 6)); // the athlete moved next Saturday's to Sunday
    await db
      .update(plannedWorkouts)
      .set({ contentState: "built" })
      .where(eq(plannedWorkouts.id, slotId(p, day(2, 5)))); // and the week after's Saturday is built

    await setConfig(p, { weeklyGoal: 3 });
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    const archived = [day(0, 5), day(1, 4), day(2, 4)];
    expect(res).toEqual({ placed: [], archived: ids(p, archived) });
    for (const id of ids(p, archived)) {
      expect(await row(id)).toMatchObject({ archiveReason: "program_replaced", archivedAt: NOW });
    }
    expect(await row(slotId(p, day(1, 5)))).toMatchObject({ archivedAt: null, effectiveDate: day(1, 6) });
    expect(await row(slotId(p, day(2, 5)))).toMatchObject({ archivedAt: null, contentState: "built" });

    // Settled: nothing more on a second run.
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
  });

  it("dropping a preferred day moves nothing the athlete moved by hand", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 4, preferredDays: PREFERRED, placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await move(slotId(p, day(1, 5)), day(1, 6)); // Saturday → Sunday
    await move(slotId(p, day(2, 4)), day(2, 5)); // Friday → onto Saturday, the day about to be dropped

    await setConfig(p, { preferredDays: [0, 2, 4] });
    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    // Saturday's unmoved slots go; the goal is still 4, so the rest of the week (Tuesday) gets one.
    expect(sorted(res.archived)).toEqual(ids(p, [day(0, 5), day(2, 5)]));
    expect(sorted(res.placed)).toEqual(ids(p, [day(0, 1), day(2, 1)]));
    expect(await row(slotId(p, day(1, 5)))).toMatchObject({ archivedAt: null, effectiveDate: day(1, 6) });
    expect(await row(slotId(p, day(2, 4)))).toMatchObject({ archivedAt: null, effectiveDate: day(2, 5) });
    // Next week already holds four (the moved one counts for the day it was planned on).
    expect((await rowsOf(p)).filter((r) => r.originalPlanDate >= day(1, 0) && r.originalPlanDate <= day(1, 6))).toHaveLength(4);
    // Settled: the retracted Saturdays do not hold their weeks' places, so nothing churns on the next run.
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
  });

  it("a retired program places nothing", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 4, preferredDays: PREFERRED }, { status: "retired" });
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
    expect(await rowsOf(p)).toEqual([]);
  });

  it("retiring archives the future unmoved outline slots and keeps today's and the moved ones", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 4, preferredDays: PREFERRED, placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await move(slotId(p, day(1, 2)), day(1, 3));
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, p));

    const res = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(res.placed).toEqual([]);
    expect(sorted(res.archived)).toEqual(ids(p, [day(0, 2), day(0, 4), day(0, 5), day(1, 0), day(1, 4), day(1, 5)]));
    expect(sorted((await rowsOf(p)).filter((r) => !r.archivedAt).map((r) => r.id))).toEqual(
      ids(p, [day(0, 0), day(1, 2)]),
    );
    expect(await placeSlots(db, userId, p, MON, prefs, NOW)).toEqual({ placed: [], archived: [] });
  });

  it("a program_replaced slot carries exactly one suppression, and a raised goal brings it back", async () => {
    const p = await seedProgram(db, userId, { weeklyGoal: 4, preferredDays: PREFERRED, placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const sat = slotId(p, day(1, 5));

    await setConfig(p, { weeklyGoal: 3 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect((await suppressionsOf(sat)).map((s) => s.reason)).toEqual(["user_removed"]);

    // Raised again: the same id comes back on its day, live and unsuppressed.
    await setConfig(p, { weeklyGoal: 4 });
    const raised = await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(sorted(raised.placed)).toEqual(ids(p, [day(0, 5), day(1, 5)]));
    expect(await row(sat)).toMatchObject({
      archivedAt: null,
      archiveReason: null,
      completionState: "scheduled",
      contentState: "outline",
      effectiveDate: day(1, 5),
    });
    expect(await suppressionsOf(sat)).toEqual([]);

    await setConfig(p, { weeklyGoal: 3 });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await row(sat)).toMatchObject({ archiveReason: "program_replaced" });
    expect((await suppressionsOf(sat)).map((s) => s.reason)).toEqual(["user_removed"]);
  });
});

describe("the restore marker", () => {
  it("placement writes nothing for an account a restore is replacing", async () => {
    const writes: string[] = [];
    const recDb = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => isWrite(sql) && writes.push(sql) });
    const { userId: u, prefs: pr } = await makeTestUser(recDb);
    const p = await seedProgram(recDb, u, { weeklyGoal: 4, preferredDays: PREFERRED });
    await recDb.insert(accountState).values({ userId: u, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });
    writes.length = 0;

    expect(await placeSlots(recDb, u, p, MON, pr, NOW)).toEqual({ placed: [], archived: [] });
    expect(await placeSlotsForAllPrograms(recDb)).toMatchObject({ placed: 0, archived: 0 });
    expect(writes).toEqual([]);

    // The control: unmarked, it writes.
    await recDb.delete(accountState).where(eq(accountState.userId, u));
    expect((await placeSlots(recDb, u, p, MON, pr, NOW)).placed.length).toBeGreaterThan(0);
  });
});

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  } as Env;
}

describe("the hourly job", () => {
  it("places every active adaptive program of every user, and nothing else", async () => {
    const a = await makeTestUser(db);
    const b = await makeTestUser(db);
    const c = await makeTestUser(db);
    const restoring = await makeTestUser(db);
    const pa = await seedProgram(db, a.userId, { weeklyGoal: 3, preferredDays: [1, 3, 5] });
    const pb1 = await seedProgram(db, b.userId, { weeklyGoal: 2, preferredDays: [0, 4] });
    const pb2 = await seedProgram(db, b.userId, { weeklyGoal: 1, preferredDays: [6] }, { name: "Jaw care" });
    const retired = await seedProgram(db, c.userId, { weeklyGoal: 4 }, { status: "retired" });
    const coach = await seedProgram(db, c.userId, {}, { kind: "coach" });
    const marked = await seedProgram(db, restoring.userId, { weeklyGoal: 4 });
    await db.insert(accountState).values({
      userId: restoring.userId,
      restoreId: newId(),
      restoreStartedAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    await hourly(db, makeEnv());

    for (const [owner, p] of [
      [a, pa],
      [b, pb1],
      [b, pb2],
    ] as const) {
      expect((await rowsOf(p)).length).toBeGreaterThan(0);
      // Complete: placing again by hand finds nothing left to do.
      const today = todayInZone(owner.prefs.timezone);
      expect(await placeSlots(db, owner.userId, p, today, owner.prefs, nowInstant())).toEqual({
        placed: [],
        archived: [],
      });
    }
    expect(await rowsOf(retired)).toEqual([]);
    expect(await rowsOf(coach)).toEqual([]);
    expect(await rowsOf(marked)).toEqual([]);
  });
});

describe("other writers leave slots alone", () => {
  it("a COROS import neither archives a live slot as absent nor brings back a program_replaced one", async () => {
    await connectTestCoros(db, userId);
    const today = todayInZone(prefs.timezone);
    const p = await seedProgram(db, userId, { weeklyGoal: 4, placementWeeksAhead: 2 });
    await placeSlots(db, userId, p, today, prefs, nowInstant());
    await setConfig(p, { weeklyGoal: 3 });
    const { archived } = await placeSlots(db, userId, p, today, prefs, nowInstant());
    const before = await rowsOf(p);

    const baseMonday = startOfIsoWeek(today);
    const provider = new FixtureTrainingProvider({ baseMonday });
    const range = { start: baseMonday, end: addDays(baseMonday, 20) };
    for (let i = 0; i < 2; i++) {
      await importPlanSnapshot(
        db,
        {
          userId,
          plan: (await provider.getCurrentPlan())!,
          workouts: await provider.getPlannedWorkouts(range),
          rangeStart: range.start,
          rangeEnd: range.end,
          source: "fixture",
        },
        prefs,
      );
    }

    const after = await rowsOf(p);
    const key = (r: (typeof before)[number]) => [r.id, r.archivedAt, r.archiveReason, r.effectiveDate, r.completionState];
    expect(after.map(key).sort()).toEqual(before.map(key).sort());
    for (const id of archived) expect((await suppressionsOf(id)).map((s) => s.reason)).toEqual(["user_removed"]);
  });

  it("a COROS import never takes two slots on one day (or a retired program's same-named slot) for mirror twins", async () => {
    // Audit 2a-model I1: every slot of a program shares its title and sport, so the import's mirror dedupe read
    // any two on one date as one COROS session served twice and archived the younger — for good, since its week
    // still counted it.
    await connectTestCoros(db, userId);
    const today = todayInZone(prefs.timezone);
    const monday = startOfIsoWeek(today);
    const nextMon = addDays(monday, 7);
    const nextWed = addDays(monday, 9);
    const config = { weeklyGoal: 2, preferredDays: [0, 2], placementWeeksAhead: 2 };

    // A retired "Mobility" whose next-Monday session the athlete had moved to Wednesday (so retiring kept it) …
    const old = await seedProgram(db, userId, config);
    await placeSlots(db, userId, old, today, prefs, nowInstant());
    await applyMove(db, { userId, workoutId: slotId(old, nextMon), toDate: nextWed, toTime: "18:00", source: "app", corosWritesEnabled: false });
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, old));
    await placeSlots(db, userId, old, today, prefs, nowInstant());
    // … and a new "Mobility" with both of next week's sessions on Wednesday ("I'll do both that day").
    const p = await seedProgram(db, userId, config);
    await placeSlots(db, userId, p, today, prefs, nowInstant());
    await applyMove(db, { userId, workoutId: slotId(p, nextMon), toDate: nextWed, toTime: "18:00", source: "app", corosWritesEnabled: false });
    const onWed = [slotId(old, nextMon), slotId(p, nextMon), slotId(p, nextWed)];
    for (const id of onWed) expect(await row(id)).toMatchObject({ archivedAt: null, effectiveDate: nextWed, title: "Mobility" });

    const provider = new FixtureTrainingProvider({ baseMonday: monday });
    const range = { start: monday, end: addDays(monday, 20) };
    let deduped = 0;
    for (let i = 0; i < 2; i++) {
      const stats = await importPlanSnapshot(
        db,
        {
          userId,
          plan: (await provider.getCurrentPlan())!,
          workouts: await provider.getPlannedWorkouts(range),
          rangeStart: range.start,
          rangeEnd: range.end,
          source: "fixture",
        },
        prefs,
      );
      deduped += stats.dedupedMirrors;
    }

    expect(deduped).toBe(0);
    for (const id of onWed) {
      expect(await row(id)).toMatchObject({ archivedAt: null, archiveReason: null, effectiveDate: nextWed });
      expect(await suppressionsOf(id)).toEqual([]);
    }
    expect(await placeSlots(db, userId, p, today, prefs, nowInstant())).toEqual({ placed: [], archived: [] });
  });

  it("rule 8's mirror release never reaches a slot: a COROS row going absent leaves a same-named slot's suppression", async () => {
    await connectTestCoros(db, userId);
    const today = todayInZone(prefs.timezone);
    const monday = startOfIsoWeek(today);
    const nextWed = addDays(monday, 9);
    const p = await seedProgram(db, userId, { weeklyGoal: 1, preferredDays: [2], placementWeeksAhead: 1 });
    await placeSlots(db, userId, p, today, prefs, nowInstant());
    const slot = slotId(p, nextWed);
    // A slot an earlier import's dedupe archived (the I1 defect), carrying its duplicate_mirror suppression …
    await db
      .update(plannedWorkouts)
      .set({ archivedAt: NOW, archiveReason: "duplicate_mirror" })
      .where(eq(plannedWorkouts.id, slot));
    await db.insert(calendarEventSuppressions).values({ id: newId(), workoutId: slot, eventId: null, reason: "duplicate_mirror", createdAt: NOW });
    // … and a verified COROS row with the same name, sport and day, read missing once already.
    const corosId = newId();
    await db.insert(plannedWorkouts).values({
      id: corosId,
      userId,
      planId: "coros-plan",
      sourceWorkoutId: `coros-plan:${corosId}`,
      title: "Mobility",
      category: "yoga",
      sport: "yoga",
      originalPlanDate: nextWed,
      lastVerifiedCorosDate: nextWed,
      effectiveDate: nextWed,
      effectiveTime: "07:00",
      sourceContentFingerprint: "fp",
      fallbackEstimatedDurationSeconds: 1800,
      calendarBlockDurationSeconds: 1800,
      completionState: "scheduled",
      missingReads: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const provider = new FixtureTrainingProvider({ baseMonday: monday });
    const range = { start: monday, end: addDays(monday, 20) };
    const stats = await importPlanSnapshot(
      db,
      {
        userId,
        plan: (await provider.getCurrentPlan())!,
        workouts: await provider.getPlannedWorkouts(range),
        rangeStart: range.start,
        rangeEnd: range.end,
        source: "fixture",
      },
      prefs,
    );
    expect(stats.archivedMissing).toBeGreaterThanOrEqual(1);
    expect(await row(corosId)).toMatchObject({ archiveReason: "absence_confirmed" });
    expect((await suppressionsOf(slot)).map((s) => s.reason)).toEqual(["duplicate_mirror"]);
  });

  it("the calendar books every slot, deletes a program_replaced slot's event and does not bring it back", async () => {
    const fake = new FakeGoogle();
    google.fake = fake.client();
    await savePreferences(db, userId, { ...prefs, calendarId: "cal" });
    const env = { APP_URL: "https://app.test" } as Env;
    const today = todayInZone(prefs.timezone);
    const p = await seedProgram(db, userId, { weeklyGoal: 4, placementWeeksAhead: 1 });
    const { placed } = await placeSlots(db, userId, p, today, prefs, nowInstant());

    await syncCalendar(db, env, userId);
    expect(sorted(fake.inserted())).toEqual(sorted(placed));

    await setConfig(p, { weeklyGoal: 3 });
    const { archived } = await placeSlots(db, userId, p, today, prefs, nowInstant());
    expect(archived.length).toBeGreaterThan(0);
    await syncCalendar(db, env, userId);
    await syncCalendar(db, env, userId, { fullResync: true });
    for (const id of archived) {
      expect(fake.liveFor(id)).toBe(false);
      expect(fake.inserted().filter((x) => x === id)).toHaveLength(1);
    }
  });
});

/** An in-memory Google calendar with the client's shape (after restore-calendar.test.ts). */
class FakeGoogle {
  private events = new Map<
    string,
    { id: string; status: string; start: { dateTime: string }; end: { dateTime: string }; resource: GoogleEventResource }
  >();
  private calls: string[] = [];
  private seq = 0;

  inserted(): string[] {
    return this.calls.filter((c) => c.startsWith("insert:")).map((c) => c.slice("insert:".length));
  }

  liveFor(workoutId: string): boolean {
    return [...this.events.values()].some(
      (e) => e.status === "confirmed" && e.resource.extendedProperties.private.rgWorkoutId === workoutId,
    );
  }

  client() {
    return {
      listCalendars: async () => [],
      createCalendar: async () => ({ id: "cal" }),
      freeBusy: async () => [],
      listEvents: async (_cal: string, opts: { syncToken?: string }) => {
        if (opts.syncToken) return { items: [], nextSyncToken: "tok-next" };
        const items = [...this.events.values()].map((e) => ({
          id: e.id,
          status: e.status,
          start: e.start,
          end: e.end,
          summary: e.resource.summary,
          description: e.resource.description,
          extendedProperties: structuredClone(e.resource.extendedProperties),
        }));
        return { items, nextSyncToken: "tok-full" };
      },
      insertEvent: async (_cal: string, resource: GoogleEventResource) => {
        const id = `ev-${++this.seq}`;
        this.events.set(id, {
          id,
          status: "confirmed",
          start: { dateTime: resource.start.dateTime },
          end: { dateTime: resource.end.dateTime },
          resource: structuredClone(resource),
        });
        this.calls.push(`insert:${resource.extendedProperties.private.rgWorkoutId}`);
        return { id };
      },
      patchEvent: async (_cal: string, eventId: string) => {
        this.calls.push(`patch:${eventId}`);
      },
      deleteEvent: async (_cal: string, eventId: string) => {
        this.calls.push(`delete:${eventId}`);
        const e = this.events.get(eventId);
        if (e) e.status = "cancelled";
      },
    };
  }
}

