/**
 * THE GARDEN GATES (Phase 2d Task 1; spec §2d "Garden"; rulings 2d-R1, 2d-R2, 2d-R3; Review Focus 1 and 2).
 *
 *  - App sessions (`activities.source = 'app'`) grow the garden from APP_SESSION_EPOCH, 2026-10-07 — the day the
 *    player went live, on the athlete's clock (ruling 2d-R1; Audit 2d I-1). One dated earlier on the athlete's own clock (only a clock-skewed device can
 *    save one) credits nothing, at any read.
 *  - Imported history (`activities.source = 'import'`) never reaches the garden, at ANY read (ruling 2d-R3): a year of
 *    it leaves every day's inputs, the garden state and the event stream byte-identical.
 *  - With neither kind of row — the live account today — every read answers exactly what it did before 2d: a
 *    realistic history hashes to the values recorded on the code before the gates (`BEFORE_2D`).
 *  - A missed program slot changes the garden exactly as a missed planned yoga row does (ruling 2d-R2).
 *
 * Every history here is SYNTHETIC and deterministic; every clock is pinned (`now` passed in, `Date` faked where a read
 * takes the real one).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { schema } from "@rg/database";
import {
  adaptiveConfigSchema,
  addDays,
  DEFAULT_USER_PREFERENCES,
  isoWeekday,
  type PerformedSessionWireInput,
  type SourceActivity,
  type UserPreferences,
} from "@rg/domain";
import type { GardenDayInput } from "@rg/garden-engine";
import type { Db } from "../src/services/db.js";
import { hashTable } from "../src/services/account-tables.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import {
  advanceGarden,
  APP_SESSION_EPOCH,
  buildDayInput,
  buildGardenView,
  ensureGarden,
  loadGarden,
  resimulateFrom,
} from "../src/services/garden-sync.js";
import { gardenHash } from "../src/services/parity.js";
import { importStandalone } from "../src/services/standalone-import.js";
import { buildSession, startSession, type BuildPayload } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { ingestActivities } from "../src/services/completion.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { backup, entry, lb, v2Session } from "./fixtures/standalone-backup.js";

vi.setConfig({ testTimeout: 60_000 });

// The calendar is not this suite's business.
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

afterEach(() => {
  vi.useRealTimers();
});

const { activities, dailyHealth, gardenDayInputs, plannedWorkouts, programs, trainingPlans, workoutCompletionMatches } =
  schema;

// ── A realistic, synthetic COROS history ────────────────────────────────────────────────────────────────────────

/** One fixed account id, so the parity helpers' hashes (which cover row ids) are comparable across runs. */
const USER = "u-garden-gates";
const TZ = "America/Los_Angeles";
const STAMP = "2026-03-01T00:00:00.000Z";
const GENESIS = "2026-03-02"; // a Monday
const TODAY = "2026-10-21";
const NOW = new Date("2026-10-21T19:00:00.000Z");
const PLAN = "plan-a";
const PLAN_START = "2026-03-16";
const PLAN_END = "2026-09-27";

/** The week the plan repeats, Monday first. COROS has no yoga sport in plans: a planned yoga row is sport `run`. */
const WEEK: ReadonlyArray<{ category: string; sport: string } | null> = [
  { category: "rest", sport: "run" },
  { category: "quality", sport: "run" },
  { category: "strength", sport: "strength" },
  { category: "easy", sport: "run" },
  { category: "yoga", sport: "run" },
  { category: "long", sport: "run" },
  null,
];

/** A user with a fixed id (makeTestUser's is random). */
async function fixedUser(db: Db, userId = USER): Promise<UserPreferences> {
  await db.insert(schema.users).values({ id: userId, email: `${userId}@example.com`, googleSub: `sub-${userId}`, createdAt: STAMP });
  const prefs: UserPreferences = { ...DEFAULT_USER_PREFERENCES, timezone: TZ };
  await savePreferences(db, userId, prefs);
  return prefs;
}

/** A small deterministic generator, seeded per day. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A local wall-clock time in the athlete's zone, as UTC the way activities keep it. */
const utc = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toFormat("yyyy-LL-dd'T'HH:mm:ss'Z'");

interface ActivitySeed {
  id: string;
  date: string;
  time: string;
  sport: string;
  source?: string;
  seconds?: number;
  meters?: number;
  load?: number;
  userId?: string;
}

async function activity(db: Db, a: ActivitySeed): Promise<void> {
  const local = `${a.date}T${a.time}:00`;
  const source = a.source ?? "coros";
  await db.insert(activities).values({
    id: a.id,
    userId: a.userId ?? USER,
    source,
    corosActivityId: source === "coros" ? `lbl-${a.id}` : null,
    startTime: utc(local),
    startTimeLocal: local,
    timezone: TZ,
    sport: a.sport,
    durationSeconds: a.seconds ?? 2400,
    distanceMeters: a.meters ?? null,
    trainingLoad: a.load ?? null,
    sourceMergeConfidence: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
}

interface WorkoutSeed {
  id: string;
  date: string;
  category: string;
  sport: string;
  state: string;
  planId?: string;
  resolution?: string;
  sanctioned?: boolean;
  origin?: string;
  userId?: string;
}

async function workout(db: Db, w: WorkoutSeed): Promise<void> {
  await db.insert(plannedWorkouts).values({
    id: w.id,
    userId: w.userId ?? USER,
    planId: w.planId ?? PLAN,
    sourceWorkoutId: `src-${w.id}`,
    title: "Session",
    category: w.category,
    sport: w.sport,
    originalPlanDate: w.date,
    lastVerifiedCorosDate: w.date,
    effectiveDate: w.date,
    effectiveTime: "07:00",
    completionState: w.state,
    resolutionDate: w.state === "scheduled" ? null : (w.resolution ?? w.date),
    sanctionedBy: w.sanctioned ? "coach" : null,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    origin: w.origin ?? null,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
}

/** `activityId` completes `workoutId`, as the matcher (or the app's save, `app_session`) leaves it. */
async function match(db: Db, workoutId: string, activityId: string, method = "coros_plan_link"): Promise<void> {
  const id = `m-${activityId}`;
  await db.insert(workoutCompletionMatches).values({ id, workoutId, activityId, confidence: 1, method, matchedAt: STAMP });
  await db.update(activities).set({ completionMatchId: id }).where(eq(activities.id, activityId));
}

async function health(db: Db, date: string, hrv: number, recoveryScore: number, userId = USER): Promise<void> {
  await db.insert(dailyHealth).values({
    id: `${userId}:${date}`,
    userId,
    date,
    hrv,
    sleepHrvBase: 60,
    sleepHrvSd: 6,
    recoveryScore,
    fatigueScore: 100 - recoveryScore,
    contentFingerprint: "fp",
    updatedAt: STAMP,
  });
}

/**
 * Seven months of a COROS athlete's life, from GENESIS to yesterday: a dated plan (with gaps before and after it) of
 * runs, a lift and a planned yoga row each week, mostly done — at dawn or in the evening, the odd one past local
 * midnight in UTC — some missed or skipped (late, early, coach-sanctioned), a few left open; unplanned lifts, yoga
 * and runs; adventures of every size; and most nights' HRV and recovery (dew from DEW_EPOCH on).
 */
async function seedHistory(db: Db): Promise<void> {
  await db.insert(trainingPlans).values({
    id: PLAN,
    userId: USER,
    provider: "coros",
    sourcePlanId: "src-plan-a",
    name: "Plan",
    status: "active",
    startDate: PLAN_START,
    endDate: PLAN_END,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  for (let date = GENESIS; date < TODAY; date = addDays(date, 1)) {
    const r = rng(`day|${date}`);
    const slot = WEEK[isoWeekday(date) - 1];
    if (slot && date >= PLAN_START && date <= PLAN_END) {
      const id = `w-${date}`;
      if (slot.category === "rest") await workout(db, { id, date, ...slot, state: "scheduled" });
      else {
        const roll = r();
        if (roll < 0.76) {
          await workout(db, { id, date, ...slot, state: "completed" });
          const time = r() < 0.3 ? `${18 + Math.floor(r() * 4)}:15` : "06:40";
          const sport = slot.category === "yoga" ? "yoga" : slot.sport;
          const meters = sport === "run" ? Math.round(5000 + r() * 16000) : undefined;
          await activity(db, { id: `a-${date}`, date, time, sport, meters, load: Math.round(30 + r() * 120) });
          await match(db, id, `a-${date}`, r() < 0.5 ? "coros_plan_link" : "scored_auto");
        } else if (roll < 0.86) {
          await workout(db, { id, date, ...slot, state: "missed", resolution: r() < 0.3 ? addDays(date, 2) : date });
        } else if (roll < 0.95) {
          await workout(db, { id, date, ...slot, state: "skipped", sanctioned: r() < 0.5, resolution: r() < 0.2 ? addDays(date, -1) : date });
        } else {
          await workout(db, { id, date, ...slot, state: "scheduled" });
        }
      }
    }
    const extra = r();
    if (extra < 0.08) await activity(db, { id: `x-${date}`, date, time: "12:10", sport: extra < 0.04 ? "strength" : "yoga", seconds: 1800 });
    else if (extra < 0.12) await activity(db, { id: `x-${date}`, date, time: "17:30", sport: "run", meters: 6000 });
    if (r() < 0.1) {
      const sport = ["hike", "bike", "swim", "ski"][Math.floor(r() * 4)]!;
      await activity(db, { id: `h-${date}`, date, time: "09:00", sport, seconds: Math.round(1800 + r() * 9000), load: Math.round(10 + r() * 150) });
    }
    if (r() < 0.88) await health(db, date, Math.round(48 + r() * 24), Math.round(30 + r() * 65));
  }
}

/** The seeded account's garden, walked through yesterday. */
async function seededGarden(db: Db): Promise<UserPreferences> {
  const prefs = await fixedUser(db);
  await seedHistory(db);
  await ensureGarden(db, USER, prefs, GENESIS);
  await advanceGarden(db, USER, prefs, NOW);
  return prefs;
}

/** Every stored day input, by date. */
async function storedInputs(db: Db, userId = USER): Promise<Map<string, GardenDayInput>> {
  const rows = await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.userId, userId));
  return new Map(rows.map((r) => [r.date, r.input as unknown as GardenDayInput]));
}

/**
 * The seeded garden as the code BEFORE 2d left it (recorded on main ea258ec by this very test, before the gates
 * existed): the stored snapshot, the event stream and every day input, through the parity helpers.
 */
const BEFORE_2D = {
  snapshot: "f9f0976547081f2936a211df87c00bfbe821a8a00886f2be4168d3e36a91d957",
  events: "28092a232d6af1afde660aab9709bcaacdb746bb6d96a9eb70a3836da4508e90",
  eventRows: 593,
  dayInputs: "c4bc6551d8c6205695c7a001978b13904010f5e1fbcf607fe742e321f11a5293",
  dayInputRows: 233,
  lastSimulatedDate: "2026-10-20",
};

describe("with no app or import rows the gates are inert: the live account's past garden cannot move", () => {
  it("a realistic history walks and replays to exactly the garden the code before 2d made (state, events, every day input)", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await seededGarden(db);
    const walked = await gardenHash(db, USER, prefs, { resim: false, now: NOW });
    const replayed = await gardenHash(db, USER, prefs, { resim: true, now: NOW });
    expect(replayed).toEqual(walked);
    const inputs = await hashTable(db, gardenDayInputs, { userId: USER, mask: ["updated_at"] });

    // Not a vacuous history: it exercises every read the gates touch.
    const days = [...(await storedInputs(db)).values()];
    const count = (f: (d: GardenDayInput) => boolean) => days.filter(f).length;
    expect(count((d) => d.completedRuns.some((r) => !r.unplanned))).toBeGreaterThan(80);
    expect(count((d) => d.completedRuns.some((r) => r.unplanned))).toBeGreaterThan(10);
    expect(count((d) => (d.adventures ?? []).length > 0)).toBeGreaterThan(10);
    expect(count((d) => d.dew === true)).toBeGreaterThan(5);
    expect(count((d) => d.missedRuns.length > 0)).toBeGreaterThan(5);
    expect(count((d) => d.weekAdherence !== undefined)).toBeGreaterThan(20);
    expect(count((d) => d.planGap)).toBeGreaterThan(10);

    expect({
      snapshot: walked.snapshot,
      events: walked.events,
      eventRows: walked.eventRows,
      dayInputs: inputs.sha256,
      dayInputRows: inputs.rows,
      lastSimulatedDate: walked.lastSimulatedDate,
    }).toEqual(BEFORE_2D);
  });
});

// ── Review Focus 1: imported history never changes the garden ───────────────────────────────────────────────────

/** A year of the standalone tool's sessions — three a week, lifts and mobility in turn, the odd one late at night. */
function yearOfSessions(): unknown[] {
  const out: unknown[] = [];
  for (let date = "2025-10-20"; date <= "2026-10-19"; date = addDays(date, 1)) {
    const wd = isoWeekday(date);
    if (wd !== 1 && wd !== 3 && wd !== 6) continue;
    const i = out.length;
    const strength = i % 2 === 0;
    const late = i % 7 === 3; // 05:30Z is the evening before in Los Angeles
    out.push(
      v2Session(date, {
        mode: strength ? "build" : "recovery",
        blockNumber: 1 + Math.floor(i / 15),
        pre: i % 4,
        post: Math.max(0, (i % 4) - 1),
        ...(late ? { startedAt: `${date}T05:30:00.000Z`, endedAt: `${date}T06:00:00.000Z` } : {}),
        done: [{ id: "chinTuck", secs: 60 }],
        entries: strength
          ? [entry("gobletSquat", [{ w: lb(20 + (i % 10)), reps: 8 }, { w: lb(20 + (i % 10)), reps: 7 }], { implement: "kettlebell" })]
          : [entry("chinTuck", [{ secs: 30 }], { log: "time", metric: "time", format: "holds" })],
      }),
    );
  }
  return out;
}

describe("Review Focus 1: imported history never changes a past garden (ruling 2d-R3)", () => {
  it("a full-history resim after importing a year of standalone history: garden state, event stream and every day input byte-identical", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await seededGarden(db);
    const before = await gardenHash(db, USER, prefs, { resim: false, now: NOW });
    const inputsBefore = await hashTable(db, gardenDayInputs, { userId: USER, mask: ["updated_at"] });
    const perDayBefore = await storedInputs(db);

    const sessions = yearOfSessions();
    const summary = await importStandalone(db, USER, backup(sessions), { today: TODAY, now: NOW.toISOString(), timezone: TZ, dryRun: false });
    expect(summary.written.activities).toBe(sessions.length);
    const imported = await db.select().from(activities).where(and(eq(activities.userId, USER), eq(activities.source, "import")));
    expect(imported).toHaveLength(sessions.length);
    // Both disciplines, and many inside the garden's walked range.
    expect(new Set(imported.map((a) => a.sport))).toEqual(new Set(["strength", "yoga"]));
    expect(imported.filter((a) => a.startTimeLocal! >= GENESIS).length).toBeGreaterThan(80);

    const after = await gardenHash(db, USER, prefs, { resim: true, now: NOW });
    expect(after.resimPending).toBe(false);
    expect(after).toEqual(before);
    expect(await hashTable(db, gardenDayInputs, { userId: USER, mask: ["updated_at"] })).toEqual(inputsBefore);
    expect(await storedInputs(db)).toEqual(perDayBefore);
  });

  it("an imported session on a day with no other activity leaves that day's inputs unchanged", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await fixedUser(db);
    const day = "2026-09-09";
    // A plan covers the day, nothing is planned on it, nothing else was done.
    await db.insert(trainingPlans).values({ id: PLAN, userId: USER, provider: "coros", sourcePlanId: "s", name: "Plan", status: "active", startDate: "2026-09-01", endDate: "2026-09-30", createdAt: STAMP, updatedAt: STAMP });
    const before = await buildDayInput(db, USER, day, prefs);

    await importStandalone(
      db,
      USER,
      backup([v2Session(day, { entries: [entry("gobletSquat", [{ w: lb(25), reps: 8 }], { implement: "kettlebell" })] }), v2Session(day, { idSuffix: "-b", entries: [entry("chinTuck", [{ secs: 30 }], { log: "time", metric: "time", format: "holds" })] })]),
      { today: TODAY, now: NOW.toISOString(), timezone: TZ, dryRun: false },
    );
    expect((await db.select().from(activities)).map((a) => [a.source, a.sport]).sort()).toEqual([["import", "strength"], ["import", "yoga"]]);

    expect(await buildDayInput(db, USER, day, prefs)).toEqual(before);
    expect(before.completedRuns).toEqual([]);
  });

  it("every garden read leaves import rows out: unplanned sessions, adventures, dew, a completed slot's lookup, week adherence, the last run and the adventure caption", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await fixedUser(db);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const yesterday = addDays(TODAY, -1);
    await db.insert(trainingPlans).values({ id: PLAN, userId: USER, provider: "coros", sourcePlanId: "s", name: "Plan", status: "active", startDate: "2026-10-01", endDate: addDays(TODAY, 1), createdAt: STAMP, updatedAt: STAMP });
    await ensureGarden(db, USER, prefs, "2026-10-01");

    // The athlete's own: a run eight days ago, then a big hike yesterday — whose planned run is still open, so the
    // durable sim stops before it and today is the hike's grace day (the caption names it).
    const ranOn = addDays(TODAY, -8);
    await workout(db, { id: "w-ran", date: ranOn, category: "easy", sport: "run", state: "completed" });
    await activity(db, { id: "a-ran", date: ranOn, time: "07:00", sport: "run", meters: 8000 });
    await match(db, "w-ran", "a-ran");
    await workout(db, { id: "w-open", date: yesterday, category: "easy", sport: "run", state: "scheduled" });
    await activity(db, { id: "b-hike", date: yesterday, time: "09:00", sport: "hike", seconds: 200 * 60, load: 90 });

    // A settled night four days ago: dew only if a run is within reach, and the athlete's own is eight days back.
    const dewDay = addDays(TODAY, -4);
    await health(db, dewDay, 66, 80);
    // Two completed slots in the week Monday 2026-10-19 reads, done by the athlete's own sessions.
    const lifted = addDays(TODAY, -6);
    await workout(db, { id: "w-lift", date: lifted, category: "strength", sport: "strength", state: "completed" });
    await activity(db, { id: "a-lift", date: lifted, time: "18:00", sport: "strength" });
    await match(db, "w-lift", "a-lift");
    await workout(db, { id: "w-week", date: "2026-10-14", category: "yoga", sport: "run", state: "completed" });
    await activity(db, { id: "a-week", date: "2026-10-14", time: "18:00", sport: "yoga" });
    await match(db, "w-week", "a-week");

    const readAll = async () => ({
      unplanned: await buildDayInput(db, USER, addDays(TODAY, -3), prefs),
      dew: await buildDayInput(db, USER, dewDay, prefs),
      adventure: await buildDayInput(db, USER, addDays(TODAY, -5), prefs),
      monday: await buildDayInput(db, USER, "2026-10-19", prefs),
    });
    const view = async () => {
      const v = await buildGardenView(db, USER, prefs);
      return { lastRunDate: v.lastRunDate, adventure: v.adventure };
    };
    expect((await buildDayInput(db, USER, lifted, prefs)).completedRuns.map((r) => [r.workoutId, r.discipline])).toEqual([["w-lift", "strength"]]);
    const before = await readAll();
    const viewBefore = await view();
    expect(viewBefore).toMatchObject({ lastRunDate: ranOn, adventure: { graceDay: true, lastSport: "hike", lastDate: yesterday } });
    expect(before.unplanned.completedRuns).toEqual([]);
    expect(before.dew.settledNight).toBe(true);
    expect(before.dew.dew).toBeUndefined();
    expect(before.adventure.adventures).toBeUndefined();
    expect(before.monday.weekAdherence).toBe(1);

    // Now the imports: one of every kind, on the very days those reads look at.
    await activity(db, { id: "i-run", date: addDays(TODAY, -2), time: "07:00", sport: "run", source: "import", meters: 9000 });
    await activity(db, { id: "i-run-dew", date: addDays(dewDay, -1), time: "07:00", sport: "run", source: "import", meters: 5000 });
    await activity(db, { id: "i-lift", date: addDays(TODAY, -3), time: "12:00", sport: "strength", source: "import" });
    await activity(db, { id: "i-yoga", date: addDays(TODAY, -3), time: "13:00", sport: "yoga", source: "import" });
    await activity(db, { id: "i-hike", date: addDays(TODAY, -5), time: "09:00", sport: "hike", source: "import", seconds: 300 * 60, load: 140 });
    // Sorts before the athlete's hike: the caption's lookup would name it first.
    await activity(db, { id: "a-bike", date: yesterday, time: "08:00", sport: "bike", source: "import", seconds: 300 * 60, load: 140 });
    // And the two slots' completions re-pointed at imports (no importer writes one; the reads must hold regardless).
    await db.delete(workoutCompletionMatches).where(inArray(workoutCompletionMatches.activityId, ["a-lift", "a-week"]));
    await db.delete(activities).where(inArray(activities.id, ["a-lift", "a-week"]));
    await activity(db, { id: "i-slot", date: lifted, time: "18:30", sport: "strength", source: "import" });
    await match(db, "w-lift", "i-slot");
    await activity(db, { id: "i-week", date: "2026-10-14", time: "18:30", sport: "yoga", source: "import" });
    await match(db, "w-week", "i-week");

    const after = await readAll();
    expect(after.unplanned).toEqual(before.unplanned);
    expect(after.dew).toEqual(before.dew);
    expect(after.adventure).toEqual(before.adventure);
    expect(await view()).toEqual(viewBefore);
    // A slot an import "completed" credits nothing — not the day, not the week: imported history is not the garden's.
    expect((await buildDayInput(db, USER, lifted, prefs)).completedRuns).toEqual([]);
    expect(after.monday.weekAdherence).toBeCloseTo(1 / 3, 10);
  });
});

// ── Review Focus 2: app sessions grow the garden from the epoch ─────────────────────────────────────────────────

describe("Review Focus 2: app sessions grow the garden from APP_SESSION_EPOCH (ruling 2d-R1)", () => {
  /** An app session as the save writes it: id = the performed session's, no COROS id, the athlete's clock. */
  const appSession = (db: Db, id: string, date: string, time: string, sport = "strength") =>
    activity(db, { id, date, time, sport, source: "app", seconds: 1860 });

  it("is the day the player went live in production", () => {
    expect(APP_SESSION_EPOCH).toBe("2026-10-07");
  });

  it("an unplanned app session on the epoch day credits; one the day before (a clock-skewed device) does not", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await fixedUser(db);
    const eve = addDays(APP_SESSION_EPOCH, -1);
    await appSession(db, "app-eve", eve, "18:00", "yoga");
    await appSession(db, "app-epoch", APP_SESSION_EPOCH, "18:00", "yoga");
    expect((await buildDayInput(db, USER, eve, prefs)).completedRuns).toEqual([]);
    const credited = (await buildDayInput(db, USER, APP_SESSION_EPOCH, prefs)).completedRuns;
    expect(credited.map((r) => [r.workoutId, r.discipline, r.unplanned])).toEqual([["unplanned-app-epoch", "yoga", true]]);
  });

  it("the day is the athlete's own clock: 20:30 on Oct 6 in Los Angeles (03:30Z on the 7th) is before the epoch", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await fixedUser(db);
    await appSession(db, "app-late", "2026-10-06", "20:30");
    const [row] = await db.select().from(activities);
    expect(row!.startTime.slice(0, 10)).toBe(APP_SESSION_EPOCH);
    expect((await buildDayInput(db, USER, "2026-10-06", prefs)).completedRuns).toEqual([]);
    expect((await buildDayInput(db, USER, APP_SESSION_EPOCH, prefs)).completedRuns).toEqual([]);
  });

  it("the evening the player went live (Oct 7, 19:25 in Los Angeles = 02:25Z on the 8th) credits (Audit 2d I-1)", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await fixedUser(db);
    await appSession(db, "app-launch-evening", "2026-10-07", "20:30", "yoga");
    expect((await buildDayInput(db, USER, "2026-10-07", prefs)).completedRuns.length).toBe(1);
  });

  it("a slot an app session completed: on the epoch day it credits, the day before it does not — and the week's adherence counts only the one that credits", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await fixedUser(db);
    const eve = addDays(APP_SESSION_EPOCH, -1);
    for (const date of [eve, APP_SESSION_EPOCH]) {
      await workout(db, { id: `slot-${date}`, date, category: "strength", sport: "strength", state: "completed", planId: "prog", origin: "program" });
      await appSession(db, `app-${date}`, date, "18:00");
      await match(db, `slot-${date}`, `app-${date}`, "app_session");
    }
    expect((await buildDayInput(db, USER, eve, prefs)).completedRuns).toEqual([]);
    const credited = (await buildDayInput(db, USER, APP_SESSION_EPOCH, prefs)).completedRuns;
    expect(credited.map((r) => [r.workoutId, r.activityId, r.discipline, r.unplanned])).toEqual([
      [`slot-${APP_SESSION_EPOCH}`, `app-${APP_SESSION_EPOCH}`, "strength", undefined],
    ]);
    // Monday 2026-10-12 reads the week of Oct 5–11: two slots planned, one credited.
    expect((await buildDayInput(db, USER, "2026-10-12", prefs)).weekAdherence).toBe(0.5);
  });

  it("the gate reads app rows only: the watch's own session the day before the epoch credits as it always did", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await fixedUser(db);
    const eve = addDays(APP_SESSION_EPOCH, -1);
    await activity(db, { id: "watch-eve", date: eve, time: "18:00", sport: "strength" });
    await workout(db, { id: "slot-eve", date: eve, category: "yoga", sport: "yoga", state: "completed", planId: "prog", origin: "program" });
    await activity(db, { id: "watch-slot", date: eve, time: "07:00", sport: "yoga" });
    await match(db, "slot-eve", "watch-slot", "app_session");
    const credited = (await buildDayInput(db, USER, eve, prefs)).completedRuns;
    expect(credited.map((r) => [r.workoutId, r.discipline])).toEqual([
      ["slot-eve", "yoga"],
      ["unplanned-watch-eve", "strength"],
    ]);
  });
});

// ── Through the real save: the right axis, once ─────────────────────────────────────────────────────────────────

/** A slot played after the epoch (Tuesday, noon in Los Angeles); the save lands the next morning. */
const PLAYED = "2026-10-13";
const PLAYED_NOON = "2026-10-13T19:00:00.000Z";
const SAVED = "2026-10-14T16:00:00.000Z";
const PERFORMED = "7c1e2a4b-5d6f-4a8b-9c0d-1e2f3a4b5c6d";

describe("a post-epoch app session grows its own axis, once (spec §2d; programme spec §10.6)", () => {
  async function setup() {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs } = await makeTestUser(db);
    const programId = "prog-jaw";
    await db.insert(programs).values({
      id: programId,
      userId,
      kind: "adaptive",
      name: "Mobility",
      status: "active",
      disciplines: ["yoga", "strength"],
      startDate: null,
      endDate: null,
      raceDate: null,
      source: null,
      config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }),
      createdAt: PLAYED_NOON,
      updatedAt: PLAYED_NOON,
      archivedAt: null,
    });
    const workoutId = slotId(programId, PLAYED);
    await db.insert(plannedWorkouts).values({
      id: workoutId,
      userId,
      planId: programId,
      sourceWorkoutId: workoutId,
      title: "Mobility",
      category: "yoga",
      sport: "yoga",
      originalPlanDate: PLAYED,
      lastVerifiedCorosDate: "",
      effectiveDate: PLAYED,
      effectiveTime: "18:00",
      sourceContentFingerprint: "program",
      calendarBlockDurationSeconds: 1800,
      fallbackEstimatedDurationSeconds: 1800,
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      origin: "program",
      contentState: "outline",
      createdAt: PLAYED_NOON,
      updatedAt: PLAYED_NOON,
    });
    await ensureGarden(db, userId, prefs, "2026-10-05");
    // The garden walked up to the session's day, as the crons and garden reads keep it: the save's own replay is then
    // that day, inside the one step a request walks (REQUEST_REPLAY_MAX_DAYS; cron reliability, part 4).
    await advanceGarden(db, userId, prefs, new Date(PLAYED_NOON));
    return { db, userId, prefs, workoutId };
  }

  /** Built and started on PLAYED: `recovery` holds no core lift (yoga, §9.2), `build` holds one (strength). */
  async function started(ctx: Awaited<ReturnType<typeof setup>>, mode: "recovery" | "build") {
    const built = await buildSession(ctx.db, ctx.userId, ctx.workoutId, { overrides: { mode } }, { today: PLAYED, now: PLAYED_NOON, prefs: ctx.prefs });
    return (await startSession(ctx.db, ctx.userId, ctx.workoutId, built.build!.buildId, PLAYED_NOON)).build!;
  }

  function payload(workoutId: string, build: BuildPayload): PerformedSessionWireInput {
    const [first] = build.items;
    return {
      id: PERFORMED,
      source: "app",
      sourceRef: null,
      workoutId,
      buildId: build.buildId,
      localDate: PLAYED,
      startedAt: "2026-10-13T19:05:00.000Z",
      endedAt: "2026-10-13T19:36:00.000Z",
      seconds: 1860,
      plannedSeconds: build.plannedSeconds,
      minutes: build.minutes,
      mode: build.mode,
      theme: build.theme,
      locationId: build.locationId,
      blockRef: build.blockRef,
      blockNumber: 1,
      completed: true,
      stepsTotal: build.steps.length,
      stepsDone: build.steps.length,
      movesDone: build.items.map((i) => ({ exerciseId: i.exerciseId, seconds: 120 })),
      note: null,
      newMove: build.newMove,
      entries: [{ exerciseId: first!.exerciseId, implement: null, format: null, perSide: false, sets: [{ setIndex: 0, reps: 8, seconds: null, load: { v: 30, u: "lb" } }] }],
      checks: [],
      review: {},
    };
  }

  const watch = (sport: string): SourceActivity => ({
    provider: "coros",
    providerActivityId: "lbl-strength-9001",
    startTime: "2026-10-13T19:06:00Z",
    startTimeLocal: "2026-10-13T12:06:00",
    sport,
    durationSeconds: 1850,
    avgHeartRate: 104,
    title: "Strength",
    contentFingerprint: "fp-1",
  });

  const dayInput = async (db: Db, userId: string, date: string) =>
    (await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.id, `${userId}:${date}`)))[0]?.input as unknown as
      | GardenDayInput
      | undefined;

  for (const [mode, axis, counter, other] of [
    ["build", "strength", "strengthSessionCount", "yogaSessionCount"],
    ["recovery", "yoga", "yogaSessionCount", "strengthSessionCount"],
  ] as const) {
    it(`a ${axis === "strength" ? "strength session credits Lift" : "mobility session credits the third axis (yoga & mobility)"}`, async () => {
      const ctx = await setup();
      const build = await started(ctx, mode);
      expect(await savePerformedSession(ctx.db, ctx.userId, PERFORMED, payload(ctx.workoutId, build), { now: SAVED, prefs: ctx.prefs })).toMatchObject({
        status: "saved",
        matched: true,
      });
      const credited = (await dayInput(ctx.db, ctx.userId, PLAYED))!.completedRuns;
      expect(credited.map((r) => [r.workoutId, r.activityId, r.discipline, r.unplanned])).toEqual([[ctx.workoutId, PERFORMED, axis, undefined]]);
      const garden = (await loadGarden(ctx.db, ctx.userId))!;
      expect(garden.state.lastSimulatedDate >= PLAYED).toBe(true);
      expect(garden.state[counter]).toBe(1);
      expect(garden.state[other]).toBe(0);
    });
  }

  it("merged, the watch's copy first: one physical session counts once", async () => {
    const ctx = await setup();
    const build = await started(ctx, "build");
    await ingestActivities(ctx.db, { userId: ctx.userId, sources: [watch("strength")] });
    const [corosRow] = await ctx.db.select().from(activities);
    const outcome = await savePerformedSession(ctx.db, ctx.userId, PERFORMED, payload(ctx.workoutId, build), { now: SAVED, prefs: ctx.prefs });
    expect(outcome).toMatchObject({ status: "saved", activityId: corosRow!.id, matched: true });
    await resimulateFrom(ctx.db, ctx.userId, PLAYED, ctx.prefs, new Date(SAVED));

    expect(await ctx.db.select().from(activities)).toHaveLength(1);
    const credited = (await dayInput(ctx.db, ctx.userId, PLAYED))!.completedRuns;
    expect(credited.map((r) => [r.workoutId, r.activityId, r.discipline])).toEqual([[ctx.workoutId, corosRow!.id, "strength"]]);
    const { state } = (await loadGarden(ctx.db, ctx.userId))!;
    expect(state.strengthSessionCount + state.yogaSessionCount).toBe(1);
  });

  it("merged, the app's save first and COROS adopting it: one physical session counts once", async () => {
    const ctx = await setup();
    const build = await started(ctx, "build");
    await savePerformedSession(ctx.db, ctx.userId, PERFORMED, payload(ctx.workoutId, build), { now: SAVED, prefs: ctx.prefs });
    await ingestActivities(ctx.db, { userId: ctx.userId, sources: [watch("strength")] });
    await resimulateFrom(ctx.db, ctx.userId, PLAYED, ctx.prefs, new Date(SAVED));

    const rows = await ctx.db.select().from(activities);
    expect(rows.map((r) => [r.id, r.corosActivityId])).toEqual([[PERFORMED, "lbl-strength-9001"]]);
    const credited = (await dayInput(ctx.db, ctx.userId, PLAYED))!.completedRuns;
    expect(credited.map((r) => [r.workoutId, r.activityId, r.discipline])).toEqual([[ctx.workoutId, PERFORMED, "strength"]]);
    const { state } = (await loadGarden(ctx.db, ctx.userId))!;
    expect(state.strengthSessionCount + state.yogaSessionCount).toBe(1);
  });
});

// ── Ruling 2d-R2: a missed program session counts gently ─────────────────────────────────────────────────────────

describe("ruling 2d-R2: a missed program slot changes the garden exactly as a missed planned yoga row does", () => {
  const MISSED = "2026-10-14";

  /** A small garden, plus one missed row on MISSED (or none) — in a database of its own, so the ids can be the same. */
  async function gardenWith(row: Partial<WorkoutSeed> | null) {
    const db = makeTestDb({ boundVariableCap: 100 });
    const prefs = await fixedUser(db);
    await db.insert(trainingPlans).values({ id: PLAN, userId: USER, provider: "coros", sourcePlanId: "s", name: "Plan", status: "active", startDate: "2026-10-05", endDate: "2026-10-25", createdAt: STAMP, updatedAt: STAMP });
    for (const date of ["2026-10-06", "2026-10-09", "2026-10-13", "2026-10-16"]) {
      await workout(db, { id: `w-${date}`, date, category: "easy", sport: "run", state: "completed" });
      await activity(db, { id: `a-${date}`, date, time: "07:00", sport: "run", meters: 7000 });
      await match(db, `w-${date}`, `a-${date}`);
    }
    await activity(db, { id: "x-yoga", date: "2026-10-10", time: "12:00", sport: "yoga" });
    if (row) await workout(db, { id: "w-missed", date: MISSED, category: "yoga", sport: "run", state: "missed", ...row });
    await ensureGarden(db, USER, prefs, "2026-10-05");
    await advanceGarden(db, USER, prefs, NOW);
    return {
      hash: await gardenHash(db, USER, prefs, { resim: false, now: NOW }),
      input: (await storedInputs(db)).get(MISSED)!,
    };
  }

  it("the same day input, the same garden — and it does change the garden (gently, like any missed session)", async () => {
    const slot = await gardenWith({ planId: "prog-jaw", origin: "program", category: "yoga", sport: "yoga" });
    const planned = await gardenWith({ planId: PLAN, category: "yoga", sport: "run" });
    const none = await gardenWith(null);
    expect(slot.input.missedRuns).toEqual([{ workoutId: "w-missed" }]);
    expect(slot).toEqual(planned);
    expect(slot.hash.snapshot).not.toBe(none.hash.snapshot);
  });
});
