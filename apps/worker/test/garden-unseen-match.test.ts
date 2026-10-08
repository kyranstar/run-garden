/**
 * A MATCH THE GARDEN DOES NOT SEE NEVER MOVES A PAST GARDEN (Audit 2d I-2; rulings 2d-R1, 2d-R3).
 *
 * The scenario is the audit's "manual-match path": a coach lift block with two MISSED rows (6 of 8 done, so no
 * Keystone), a walked garden, and imported sessions (the standalone tool's history) on the days before the misses.
 *
 *  - `POST /api/plan/workouts/:id/match` refuses (422, nothing written) an activity the garden does not see — an
 *    import, or an app session dated before APP_SESSION_EPOCH — and `/api/activities/unmatched` never offers one.
 *  - Defence in depth, for a completion that reaches a row some other way (a write that bypasses the route): a slot
 *    completed only by an unseen activity is, to the garden, still OPEN — it credits nothing, and it misses as an
 *    open row does, AUTO_MISS_DAYS after its day; `coachBlockAdherence` counts it not done. So the block's misses keep
 *    their debit and the Keystone stays unearned: the garden's state and events are byte-identical.
 *
 * Every history is SYNTHETIC; every clock is pinned. The epoch is read from its constant, never written here.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { schema } from "@rg/database";
import { addDays, DEFAULT_USER_PREFERENCES, isoWeekday, type UserPreferences } from "@rg/domain";
import type { GardenDayInput } from "@rg/garden-engine";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { advanceGarden, APP_SESSION_EPOCH, buildDayInput, ensureGarden, resimulateFrom, unseenCompletions } from "../src/services/garden-sync.js";
import { coachBlockAdherence } from "../src/services/coach-plans.js";
import { AUTO_MISS_DAYS } from "../src/services/reconcile-daily.js";
import { gardenHash } from "../src/services/parity.js";
import { importStandalone } from "../src/services/standalone-import.js";
import { planRoutes } from "../src/routes/plan.js";
import { activityRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, mountRoutes } from "./helpers.js";
import { backup, entry, lb, v2Session } from "./fixtures/standalone-backup.js";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));
afterEach(() => vi.useRealTimers());

const { activities, coachPlans, gardenDayInputs, gardenEvents, plannedWorkouts, workoutCompletionMatches } = schema;

const USER = "u-unseen-match";
const TZ = "America/Los_Angeles";
const STAMP = "2026-03-01T00:00:00.000Z";
const GENESIS = "2026-03-30"; // a Monday
const TODAY = "2026-05-20";
const NOW = new Date("2026-05-20T19:00:00.000Z");
const BLOCK = { start: "2026-04-06", end: "2026-05-03" };
const MISSED = ["2026-04-15", "2026-04-27"];
/** Imported sessions the day before each miss: what the owner did in the standalone tool instead. */
const IMPORTED_ON = MISSED.map((d) => addDays(d, -1));
/** An app session from a clock-skewed device, dated before the epoch. */
const PRE_EPOCH_APP_DAY = "2026-04-28";

const utc = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toFormat("yyyy-LL-dd'T'HH:mm:ss'Z'");

async function activity(db: Db, a: { id: string; date: string; source: string; sport?: string }) {
  const local = `${a.date}T18:20:00`;
  await db.insert(activities).values({
    id: a.id, userId: USER, source: a.source, corosActivityId: a.source === "coros" ? `lbl-${a.id}` : null,
    startTime: utc(local), startTimeLocal: local, timezone: TZ, sport: a.sport ?? "strength", durationSeconds: 2400,
    trainingLoad: 40, sourceMergeConfidence: 1, createdAt: STAMP, updatedAt: STAMP,
  });
}

/** The coach lift block (Mon + Wed), two rows auto-missed as the daily reconcile misses them, the rest done. */
async function seed(db: Db): Promise<UserPreferences> {
  await db.insert(schema.users).values({ id: USER, email: `${USER}@example.com`, googleSub: `sub-${USER}`, createdAt: STAMP });
  const prefs: UserPreferences = { ...DEFAULT_USER_PREFERENCES, timezone: TZ };
  await savePreferences(db, USER, prefs);
  await db.insert(coachPlans).values({
    id: "cp-lift", userId: USER, discipline: "lift", name: "Lift block", status: "completed", startDate: BLOCK.start, endDate: BLOCK.end,
    raceDate: null, stampPrefix: "cl", createdAt: STAMP, updatedAt: STAMP,
  });
  for (let date = BLOCK.start; date <= BLOCK.end; date = addDays(date, 1)) {
    if (isoWeekday(date) !== 1 && isoWeekday(date) !== 3) continue;
    const missed = MISSED.includes(date);
    await db.insert(plannedWorkouts).values({
      id: `cl-${date}`, userId: USER, planId: "cp-lift", sourceWorkoutId: `s-cl-${date}`, title: "Lift", category: "strength", sport: "strength",
      originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "18:00",
      completionState: missed ? "missed" : "completed", resolutionDate: missed ? addDays(date, AUTO_MISS_DAYS) : date,
      sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, createdAt: STAMP, updatedAt: STAMP,
    });
    if (!missed) {
      await activity(db, { id: `cla-${date}`, date, source: "coros" });
      await db.insert(workoutCompletionMatches).values({ id: `m-${date}`, workoutId: `cl-${date}`, activityId: `cla-${date}`, confidence: 0.9, method: "scored_auto", matchedAt: STAMP });
      await db.update(activities).set({ completionMatchId: `m-${date}` }).where(eq(activities.id, `cla-${date}`));
    }
  }
  const sessions = IMPORTED_ON.map((date) => v2Session(date, { entries: [entry("gobletSquat", [{ w: lb(30), reps: 8 }], { implement: "kettlebell" })] }));
  await importStandalone(db, USER, backup(sessions), { today: TODAY, now: NOW.toISOString(), timezone: TZ, dryRun: false });
  expect(PRE_EPOCH_APP_DAY < APP_SESSION_EPOCH).toBe(true);
  await activity(db, { id: "app-skewed", date: PRE_EPOCH_APP_DAY, source: "app" });
  await activity(db, { id: "coros-loose", date: "2026-05-12", source: "coros" });
  await ensureGarden(db, USER, prefs, GENESIS);
  await advanceGarden(db, USER, prefs, NOW);
  return prefs;
}

const importedOn = async (db: Db, date: string): Promise<string> =>
  (await db.select().from(activities).where(and(eq(activities.userId, USER), eq(activities.source, "import")))).find((a) => a.startTimeLocal!.startsWith(date))!.id;

const keystoneDays = async (db: Db): Promise<string[]> =>
  (await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.userId, USER)))
    .filter((r) => (r.input as unknown as GardenDayInput).coachedBlockCompleted === true)
    .map((r) => r.date);

const missedEvents = async (db: Db) =>
  (await db.select().from(gardenEvents).where(and(eq(gardenEvents.userId, USER), eq(gardenEvents.kind, "missed_run"))))
    .map((e) => [e.date, e.workoutId])
    .sort();

function makeEnv(): Env {
  return { DB: {} as Env["DB"], ASSETS: {} as Env["ASSETS"], APP_URL: "https://app.test", SESSION_SECRET: "s", AI_DEFAULT_ENABLED: "0" } as Env;
}

describe("the scenario", () => {
  it("as seeded: the misses debit, 6 of 8 done, no Keystone", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    await seed(db);
    expect(await coachBlockAdherence(db, USER, "cp-lift", BLOCK.start, BLOCK.end, unseenCompletions)).toBe(0.75);
    expect(await missedEvents(db)).toEqual(MISSED.map((d) => [addDays(d, AUTO_MISS_DAYS), `cl-${d}`]));
    expect(await keystoneDays(db)).toEqual([]);
  });
});

describe("POST /api/plan/workouts/:id/match", () => {
  let db: Db;
  let prefs: UserPreferences;
  let cookie: string;
  beforeAll(async () => {
    db = makeTestDb({ boundVariableCap: 100 });
    prefs = await seed(db);
    cookie = `${SESSION_COOKIE}=${await createSession(db, USER, "test")}`;
  });
  const post = (workoutId: string, activityId: string) =>
    mountRoutes(db, "/api/plan", planRoutes).request(
      `/api/plan/workouts/${workoutId}/match`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ activityId }) },
      makeEnv(),
    );

  it("refuses an activity the garden does not see — an import, an app session before the epoch: 422, nothing written, the garden as it was", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const before = await gardenHash(db, USER, prefs, { resim: false, now: NOW });
    const rowsBefore = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, USER));
    const matchesBefore = await db.$count(workoutCompletionMatches);
    for (const [workoutId, activityId] of [
      [`cl-${MISSED[0]}`, await importedOn(db, IMPORTED_ON[0]!)],
      [`cl-${MISSED[1]}`, await importedOn(db, IMPORTED_ON[1]!)],
      [`cl-${MISSED[1]}`, "app-skewed"],
    ] as const) {
      const res = await post(workoutId, activityId);
      expect(res.status, activityId).toBe(422);
      expect(await res.json()).toEqual({ error: "not_in_garden" });
      expect((await db.select().from(activities).where(eq(activities.id, activityId)))[0]!.completionMatchId).toBeNull();
    }
    expect(await db.$count(workoutCompletionMatches)).toBe(matchesBefore);
    expect(await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, USER))).toEqual(rowsBefore);
    expect(await gardenHash(db, USER, prefs, { resim: false, now: NOW })).toEqual(before);
    expect(await keystoneDays(db)).toEqual([]);
  });

  it("an activity the garden sees is still matched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const res = await post(`cl-${MISSED[1]}`, "coros-loose");
    expect(res.status).toBe(200);
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, `cl-${MISSED[1]}`)))[0]!.completionState).toBe("completed");
  });
});

describe("GET /api/activities/unmatched", () => {
  it("never offers what the garden does not see", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    await seed(db);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, USER, "test")}`;
    const res = await mountRoutes(db, "/api/activities", activityRoutes).request("/api/activities/unmatched", { headers: { Cookie: cookie } }, makeEnv());
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { activities: Array<{ id: string; source: string }> }).activities.map((a) => a.id);
    expect(ids).toContain("coros-loose");
    expect(ids).not.toContain("app-skewed");
    for (const date of IMPORTED_ON) expect(ids).not.toContain(await importedOn(db, date));
  });
});

describe("defence in depth: an import matched onto the missed rows by a write that bypasses the route", () => {
  /** The match route's own writes, as they were before it refused (the audit's replica). */
  async function bypassMatch(db: Db, prefs: UserPreferences, workoutId: string, activityId: string) {
    const a = (await db.select().from(activities).where(eq(activities.id, activityId)))[0]!;
    const matchId = `mm-${activityId}`;
    await db.insert(workoutCompletionMatches).values({ id: matchId, workoutId, activityId, confidence: 1, method: "manual", matchedAt: NOW.toISOString() });
    await db.update(activities).set({ completionMatchId: matchId }).where(eq(activities.id, activityId));
    const day = (a.startTimeLocal ?? a.startTime).slice(0, 10);
    await db.update(plannedWorkouts).set({ completionState: "completed", resolutionDate: day }).where(eq(plannedWorkouts.id, workoutId));
    await resimulateFrom(db, USER, day, prefs, NOW);
  }

  it("the garden's state, events and the Keystone are unchanged: the rows still miss, and are not done", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await seed(db);
    const before = await gardenHash(db, USER, prefs, { resim: false, now: NOW });
    const missedBefore = await missedEvents(db);
    for (const [i, day] of MISSED.entries()) await bypassMatch(db, prefs, `cl-${day}`, await importedOn(db, IMPORTED_ON[i]!));

    expect(await gardenHash(db, USER, prefs, { resim: false, now: NOW })).toEqual(before);
    expect(await missedEvents(db)).toEqual(missedBefore);
    expect(await keystoneDays(db)).toEqual([]);
    expect(await coachBlockAdherence(db, USER, "cp-lift", BLOCK.start, BLOCK.end, unseenCompletions)).toBe(0.75);
    // And a full replay agrees.
    expect(await gardenHash(db, USER, prefs, { resim: true, now: NOW })).toEqual({ ...before, resimPending: false });
  });

  it("to the garden the slot is still open: no credit on its day, a miss AUTO_MISS_DAYS later", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await seed(db);
    const day = MISSED[0]!;
    await bypassMatch(db, prefs, `cl-${day}`, await importedOn(db, IMPORTED_ON[0]!));
    const onDay = await buildDayInput(db, USER, day, prefs);
    expect(onDay.completedRuns.map((r) => r.workoutId)).not.toContain(`cl-${day}`);
    expect(onDay.missedRuns).toEqual([]);
    expect((await buildDayInput(db, USER, addDays(day, AUTO_MISS_DAYS), prefs)).missedRuns).toEqual([{ workoutId: `cl-${day}` }]);
  });
});
