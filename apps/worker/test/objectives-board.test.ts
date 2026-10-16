/**
 * `GET /api/objectives/board` (Stage 3 Task 11; spec §11; principles §2.10, §5.2): the objectives board's one read —
 * every objective the athlete keeps (dropped ones left out) in board order, each key result measured exactly as the
 * progress route measures it, its best ever measurement, the done workouts that served it (newest first, three at
 * most), the streak of weeks one was done in, and the coach's latest line about it.
 *
 * Gated with the coach designer (a 404 with it off, signed in or not), the account's own, and within the free plan's
 * budget: its statements are pinned, and every bound list stays under D1's 100 variables.
 *
 * Synthetic data only. Fixed dates: TODAY is a Wednesday (its week began Monday 2026-10-12).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, OBJECTIVE_STREAK_WEEKS, todayInZone, type ObjectiveBoardDto, type WorkoutDoc, type WorkoutItem } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { objectiveBoardRoutes } from "../src/routes/objectives-board.js";
import { createObjective, objectiveProgress, updateObjective } from "../src/services/objectives.js";
import { objectiveBoard, OBJECTIVE_BOARD_STATEMENTS, weekStreak } from "../src/services/objectives-board.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { activities, dailyHealth, performedSessions, performedSets, plannedWorkouts, sessionBuilds } = schema;

const TODAY = "2026-10-14";
const T0 = "2026-10-14T12:00:00.000Z";
const day = (n: number) => addDays(TODAY, -n);

let db: Db;
let statements = 0;
let userId: string;
let cookie: string;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db, { weightUnit: "kg", units: "km" }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

function makeEnv(extra: Partial<Env> = {}): Env {
  return { DB: {} as Env["DB"], ASSETS: {} as Env["ASSETS"], APP_URL: "https://app.test", SESSION_SECRET: "s", AI_DEFAULT_ENABLED: "0", ...extra } as Env;
}
const ON = makeEnv({ COACH_DESIGNER: "1" });
const OFF = makeEnv();

async function get(env: Env = ON, as: string | null = cookie) {
  const app = mountRoutes(db, "/api/objectives/board", objectiveBoardRoutes);
  statements = 0;
  const res = await app.request("/api/objectives/board", { headers: as ? { Cookie: as } : {} }, env);
  return { status: res.status, body: (await res.json().catch(() => null)) as ObjectiveBoardDto & { error?: string }, cost: statements };
}

// ── Seeding ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const hold = (libraryId: string, holdSec: number, max = false): WorkoutItem => ({
  kind: "exercise", libraryId, dose: { sets: 1, holdSec, ...(max ? { max: true as const } : {}) },
});

function doc(o: { items?: WorkoutItem[]; objectiveIds?: string[]; source?: WorkoutDoc["source"]["kind"]; summary?: string } = {}): WorkoutDoc {
  return {
    version: 1,
    title: "Synthetic session",
    intent: { summary: o.summary ?? "A synthetic session", goals: [], focus: [], effort: "maintain", ...(o.objectiveIds ? { objectiveIds: o.objectiveIds } : {}) },
    parts: [{ purpose: "main", format: "straight", items: o.items ?? [hold("wallSit", 60)] }],
    source: { kind: o.source ?? "studio" },
  };
}

/** A planned workout on `date`, its document naming `objectiveIds`. */
async function workout(
  date: string,
  o: { objectiveIds?: string[]; source?: WorkoutDoc["source"]["kind"]; summary?: string; title?: string; state?: string; archived?: boolean; owner?: string; items?: WorkoutItem[] } = {},
): Promise<string> {
  const id = newId();
  await db.insert(plannedWorkouts).values({
    id, userId: o.owner ?? userId, planId: "plan", sourceWorkoutId: id, title: o.title ?? `Workout ${date}`, category: "strength", sport: "strength",
    originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "12:00", sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 1800, completionState: o.state ?? "scheduled", archivedAt: o.archived ? T0 : null,
    workoutDoc: JSON.stringify(doc(o)), createdAt: T0, updatedAt: T0,
  });
  return id;
}

/** A session logged on `date` (of `workoutId`, when given). */
async function logged(date: string, o: { workoutId?: string | null; buildId?: string | null; owner?: string; hash?: string } = {}): Promise<string> {
  const id = newId();
  await db.insert(performedSessions).values({
    id, userId: o.owner ?? userId, source: "app", localDate: date, payloadHash: o.hash ?? "h", workoutId: o.workoutId ?? null,
    buildId: o.buildId ?? null, createdAt: T0, updatedAt: T0,
  });
  return id;
}

/** A test hold of `libraryId` done on `date`, `seconds` long (capacity: its item was to max). */
async function testHold(date: string, seconds: number, libraryId = "wallSit"): Promise<void> {
  const workoutId = await workout(date, { items: [hold(libraryId, 120, true)] });
  const buildId = newId();
  await db.insert(sessionBuilds).values({
    id: buildId, userId, workoutId, version: 1, engineVersion: "test", inputsHash: "h",
    payload: { build: { steps: [], items: [], mode: "build", theme: null, minutes: 30 }, view: {} },
    workoutDoc: JSON.stringify(doc({ items: [hold(libraryId, 120, true)] })), lockedAt: T0, createdAt: T0,
  });
  const sessionId = await logged(date, { workoutId, buildId });
  await db.insert(performedSets).values({ id: newId(), performedSessionId: sessionId, entryIndex: 0, exerciseId: libraryId, setIndex: 0, seconds, done: true });
}

async function run(date: string, distanceM: number, durationSec: number, hr: number | null = null, owner = userId): Promise<void> {
  await db.insert(activities).values({
    id: newId(), userId: owner, sport: "run", startTime: `${date}T14:00:00.000Z`, startTimeLocal: `${date}T07:00:00`,
    durationSeconds: durationSec, distanceMeters: distanceM, avgHeartRate: hr, avgPaceSecPerKm: durationSec / (distanceM / 1000), createdAt: T0, updatedAt: T0,
  });
}

async function threshold(date: string, secPerKm: number): Promise<void> {
  await db.insert(dailyHealth).values({ id: `${userId}:${date}`, userId, date, thresholdPaceSecPerKm: secPerKm, contentFingerprint: "fp", updatedAt: T0 });
}

const WALL_SIT_30 = { label: "Wall sit", measure: { kind: "hold_max", libraryIds: ["wallSit"], windowDays: 30 }, target: 150 };
const FIVE_K = { label: "5K", measure: { kind: "run_best", distanceM: 5000 }, target: 1440 };
const EASY_PACE = { label: "Easy pace", measure: { kind: "pace_at_hr", hrLow: 130, hrHigh: 145 } };
const THRESHOLD = { label: "Threshold", measure: { kind: "threshold_pace" } };

const board = (today = TODAY) => objectiveBoard(db, userId, { today });

// ── The streak ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("weekStreak", () => {
  const MON = "2026-10-12";
  const week = (n: number, d = 0) => addDays(MON, -7 * n + d);

  it("counts the weeks in a row with a done workout, this week included", () => {
    expect(weekStreak([TODAY, week(1, 3), week(2, 6)], TODAY)).toBe(3);
  });

  it("a week under way never ends a streak: with none yet this week, it counts back from last week", () => {
    expect(weekStreak([week(1), week(2, 4)], TODAY)).toBe(2);
    expect(weekStreak([week(1, 6)], TODAY)).toBe(1);
  });

  it("is 0 when last week had none either, and a gap ends it", () => {
    expect(weekStreak([], TODAY)).toBe(0);
    expect(weekStreak([week(2), week(3)], TODAY)).toBe(0);
    expect(weekStreak([TODAY, week(1), week(3), week(4)], TODAY)).toBe(2);
  });

  it("counts a week once however many it holds, ignores days after today, and stops at the weeks it reads", () => {
    expect(weekStreak([MON, TODAY, TODAY, addDays(TODAY, 1)], TODAY)).toBe(1);
    expect(weekStreak([addDays(TODAY, 2)], TODAY)).toBe(0);
    const every = Array.from({ length: OBJECTIVE_STREAK_WEEKS + 10 }, (_, i) => week(i));
    expect(weekStreak(every, TODAY)).toBe(OBJECTIVE_STREAK_WEEKS);
  });

  it("weeks start on Monday: Sunday and the Monday after are two weeks", () => {
    expect(weekStreak(["2026-10-11", MON], "2026-10-12")).toBe(2);
    expect(weekStreak(["2026-10-11"], "2026-10-12")).toBe(1);
  });
});

// ── The board ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the board", () => {
  it("lists every objective but a dropped one, in board order, each key result measured exactly as the progress route measures it", async () => {
    const second = await createObjective(db, userId, { title: "Second", sort: 2, keyResults: [FIVE_K, EASY_PACE, THRESHOLD] }, T0);
    const first = await createObjective(db, userId, { title: "First", sort: 1, keyResults: [WALL_SIT_30] }, T0);
    const paused = await createObjective(db, userId, { title: "Paused", sort: 3, status: "paused" }, T0);
    const done = await createObjective(db, userId, { title: "Done", sort: 4, status: "done" }, T0);
    await createObjective(db, userId, { title: "Dropped", sort: 0, status: "dropped", keyResults: [WALL_SIT_30] }, T0);
    for (const [n, s] of [[40, 70], [20, 80], [9, 90], [2, 95]] as const) await testHold(day(n), s);
    for (const [n, t] of [[200, 1500], [60, 1560], [10, 1530]] as const) await run(day(n), 5000, t, 140);
    for (const n of [30, 15, 3]) await threshold(day(n), 270 + n);

    const b = await board();
    expect(b.today).toBe(TODAY);
    expect(b.objectives.map((o) => o.objective.title)).toEqual(["First", "Second", "Paused", "Done"]);
    expect(b.objectives.map((o) => o.objective.id)).toEqual([first.id, second.id, paused.id, done.id]);
    for (const card of b.objectives) {
      const alone = await objectiveProgress(db, userId, card.objective.id, { today: TODAY, raceDate: null });
      expect(card.keyResults.map((k) => k.progress)).toEqual(alone.keyResults.map((k) => k.progress));
      expect(card.keyResults.map((k) => k.keyResult)).toEqual(alone.keyResults.map((k) => k.keyResult));
    }
    // The 30-day window holds three of the four holds; the 5K's 180 days, two of the three runs.
    expect(b.objectives[0]!.keyResults[0]!.progress).toMatchObject({ current: 95, sampleSize: 3, evidence: "measured" });
    expect(b.objectives[1]!.keyResults[0]!.progress).toMatchObject({ current: 1530, sampleSize: 2 });
  });

  it("the best ever is read from every logged point, beyond the window: the larger hold, the faster run", async () => {
    const o = await createObjective(db, userId, { title: "O", keyResults: [WALL_SIT_30, FIVE_K] }, T0);
    for (const [n, s] of [[100, 120], [9, 90], [2, 95]] as const) await testHold(day(n), s);
    for (const [n, t] of [[200, 1500], [60, 1560], [10, 1530]] as const) await run(day(n), 5000, t);
    const [card] = (await board()).objectives;
    expect(card!.objective.id).toBe(o.id);
    expect(card!.keyResults.map((k) => k.best)).toEqual([
      { date: day(100), value: 120, display: 120 },
      { date: day(200), value: 1500, display: 1500 },
    ]);
    // Outside the window: no point of the trend is the best.
    expect(card!.keyResults[0]!.progress.series.map((p) => p.date)).not.toContain(day(100));
  });

  it("a best inside the window is one of the trend's points; in the key result's unit too", async () => {
    await createObjective(db, userId, { title: "O", keyResults: [{ ...WALL_SIT_30, unit: "min", target: 2.5 }] }, T0);
    for (const [n, s] of [[50, 60], [9, 90], [2, 84]] as const) await testHold(day(n), s);
    const k = (await board()).objectives[0]!.keyResults[0]!;
    expect(k.best).toEqual({ date: day(9), value: 90, display: 1.5 });
    expect(k.progress.series).toContainEqual(expect.objectContaining({ date: day(9), value: 90, display: 1.5 }));
  });

  it("has no best with fewer than two points ever (nothing to beat yet), nor for a measure that reads nothing", async () => {
    await createObjective(
      db,
      userId,
      { title: "O", keyResults: [WALL_SIT_30, FIVE_K, { label: "Energy", measure: { kind: "checkin", questionId: "energy" }, direction: "up" }] },
      T0,
    );
    await testHold(day(3), 90);
    const ks = (await board()).objectives[0]!.keyResults;
    expect(ks.map((k) => k.best)).toEqual([null, null, null]);
    expect(ks.map((k) => k.progress.evidence)).toEqual(["sparse", "none", "none"]);
  });

  it("served: the done workouts naming it — logged or completed — newest first, three at most; never another's, an archived, skipped or not-yet-done one", async () => {
    const a = await createObjective(db, userId, { title: "A", sort: 1 }, T0);
    const b = await createObjective(db, userId, { title: "B", sort: 2 }, T0);
    const w1 = await workout(day(1), { objectiveIds: [a.id], state: "completed", title: "Hips" });
    const w2 = await workout(day(3), { objectiveIds: [a.id, b.id], source: "coach", title: "Legs" });
    await logged(day(3), { workoutId: w2 });
    const w3 = await workout(day(8), { objectiveIds: [a.id], state: "completed", title: "Core" });
    await workout(day(9), { objectiveIds: [a.id], state: "completed", title: "Older" });
    await workout(TODAY, { objectiveIds: [a.id], title: "Today, not yet" });
    await workout(addDays(TODAY, 1), { objectiveIds: [a.id], source: "coach", title: "Tomorrow" });
    await workout(day(2), { objectiveIds: [b.id], state: "completed", title: "B only" });
    await workout(day(4), { objectiveIds: [a.id], state: "completed", archived: true, title: "Archived" });
    await workout(day(5), { objectiveIds: [a.id], state: "skipped", title: "Skipped" });
    // A session still being written is not there yet.
    const pending = await workout(day(6), { objectiveIds: [a.id], title: "Mid-write" });
    await logged(day(6), { workoutId: pending, hash: "pending" });
    const { userId: other } = await makeTestUser(db);
    await workout(day(1), { objectiveIds: [a.id], state: "completed", owner: other, title: "Theirs" });

    const cards = (await board()).objectives;
    const byTitle = Object.fromEntries(cards.map((c) => [c.objective.title, c]));
    expect(byTitle.A!.served).toEqual([
      { workoutId: w1, date: day(1), title: "Hips", source: "studio" },
      { workoutId: w2, date: day(3), title: "Legs", source: "coach" },
      { workoutId: w3, date: day(8), title: "Core", source: "studio" },
    ]);
    expect(byTitle.B!.served.map((s) => s.title)).toEqual(["B only", "Legs"]);
  });

  it("only the account's own session makes a workout done; a workout naming it twice is listed once", async () => {
    const a = await createObjective(db, userId, { title: "A" }, T0);
    const w = await workout(day(2), { objectiveIds: [a.id] });
    const { userId: other } = await makeTestUser(db);
    await logged(day(2), { workoutId: w, owner: other });
    expect((await board()).objectives[0]!.served).toEqual([]);
    const twice = await workout(day(1), { objectiveIds: [a.id, a.id], state: "completed" });
    expect((await board()).objectives[0]!.served.map((s) => s.workoutId)).toEqual([twice]);
  });

  it("reads the streak's weeks back and two weeks ahead: older done workouts, a later coach line and one not yet due are not on it", async () => {
    const a = await createObjective(db, userId, { title: "A" }, T0);
    // Before this week and the OBJECTIVE_STREAK_WEEKS before it.
    await workout(addDays("2026-10-12", -7 * OBJECTIVE_STREAK_WEEKS - 1), { objectiveIds: [a.id], state: "completed", title: "Long ago" });
    await workout(addDays(TODAY, 15), { objectiveIds: [a.id], source: "coach", summary: "Too far ahead" });
    // Marked done ahead of its day: not served until it is.
    await workout(addDays(TODAY, 1), { objectiveIds: [a.id], state: "completed", title: "Tomorrow" });
    const [card] = (await board()).objectives;
    expect(card!.served).toEqual([]);
    expect(card!.streakWeeks).toBe(0);
    expect(card!.note).toBeNull();
  });

  it("a logged session dates the workout by the day it was done", async () => {
    const a = await createObjective(db, userId, { title: "A" }, T0);
    const w = await workout(day(4), { objectiveIds: [a.id] });
    await logged(day(3), { workoutId: w });
    expect((await board()).objectives[0]!.served).toEqual([{ workoutId: w, date: day(3), title: `Workout ${day(4)}`, source: "studio" }]);
  });

  it("the streak counts the weeks a workout naming it was done; zero when none was", async () => {
    const a = await createObjective(db, userId, { title: "A", sort: 1 }, T0);
    const b = await createObjective(db, userId, { title: "B", sort: 2 }, T0);
    // This week has none yet (a week under way never ends it); the three before it do; then a gap.
    for (const n of [3, 10, 17, 31]) await workout(day(n), { objectiveIds: [a.id], state: "completed" });
    // A skipped one, and one this week not yet done, count for nothing.
    await workout(day(1), { objectiveIds: [b.id], state: "skipped" });
    await workout(TODAY, { objectiveIds: [b.id] });
    const cards = (await board()).objectives;
    expect(cards.map((c) => [c.objective.title, c.streakWeeks])).toEqual([["A", 3], ["B", 0]]);
  });

  it("the note: the latest coach-written workout naming it, its summary — a Studio one is not the coach's; none, null", async () => {
    const a = await createObjective(db, userId, { title: "A", sort: 1 }, T0);
    const b = await createObjective(db, userId, { title: "B", sort: 2 }, T0);
    await workout(day(6), { objectiveIds: [a.id], source: "coach", summary: "Older line" });
    const next = await workout(addDays(TODAY, 2), { objectiveIds: [a.id], source: "coach", summary: "Single-leg strength toward the hold test" });
    await workout(addDays(TODAY, 3), { objectiveIds: [a.id], source: "studio", summary: "Mine" });
    await workout(day(1), { objectiveIds: [b.id], source: "studio", summary: "Mine too" });
    const [ca, cb] = (await board()).objectives;
    expect(ca!.note).toEqual({ text: "Single-leg strength toward the hold test", workoutId: next, date: addDays(TODAY, 2) });
    expect(cb!.note).toBeNull();
  });

  it("follows a status change: a paused objective stays on the board with its facts", async () => {
    const a = await createObjective(db, userId, { title: "A", keyResults: [WALL_SIT_30] }, T0);
    await testHold(day(2), 95);
    await updateObjective(db, userId, a.id, { status: "paused" }, T0);
    const [card] = (await board()).objectives;
    expect(card!.objective.status).toBe("paused");
    expect(card!.keyResults[0]!.progress.current).toBe(95);
  });
});

// ── The route ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("GET /api/objectives/board", () => {
  it("is a plain 404 with the coach designer off, signed in or not", async () => {
    await createObjective(db, userId, { title: "A" }, T0);
    expect(await get(OFF)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await get(OFF, null)).toMatchObject({ status: 404, body: { error: "not_found" } });
    // Staging turns it on, as it does every coach route.
    expect((await get(makeEnv({ STAGING: "1" }))).status).toBe(200);
  });

  it("asks for a session with it on", async () => {
    expect((await get(ON, null)).status).toBe(401);
  });

  it("through the Worker's own entry: the board is a 404 with it off, and /api/objectives' own routes are unchanged", async () => {
    const entry = (await import("../src/index.js")).default;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const off = await entry.fetch(new Request("https://app.test/api/objectives/board"), OFF, ctx);
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: "not_found" });
    // The objectives' own routes still sign in first.
    expect((await entry.fetch(new Request("https://app.test/api/objectives"), OFF, ctx)).status).toBe(401);
    expect((await entry.fetch(new Request("https://app.test/api/objectives/o1/progress"), OFF, ctx)).status).toBe(401);
    // On, the board's own sign-in answers.
    expect((await entry.fetch(new Request("https://app.test/api/objectives/board"), ON, ctx)).status).toBe(401);
  });

  it("is the account's own: another account's objectives and workouts never show", async () => {
    const mine = await createObjective(db, userId, { title: "Mine" }, T0);
    const { userId: other } = await makeTestUser(db);
    const theirs = await createObjective(db, other, { title: "Theirs" }, T0);
    await workout(day(1), { objectiveIds: [mine.id, theirs.id], state: "completed", owner: other });
    const today = todayInZone("UTC");
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.today).toBe(today);
    expect(res.body.objectives.map((o) => o.objective.title)).toEqual(["Mine"]);
    expect(res.body.objectives[0]!.served).toEqual([]);
  });

  it("costs the session and OBJECTIVE_BOARD_STATEMENTS at most, every source read (strength, runs and their labels, threshold days): pinned", async () => {
    const today = todayInZone("UTC");
    await createObjective(db, userId, { title: "A", keyResults: [WALL_SIT_30, FIVE_K, EASY_PACE, THRESHOLD] }, T0);
    await createObjective(db, userId, { title: "B", keyResults: [{ label: "Predicted", measure: { kind: "predicted_time", distanceM: 10000 } }] }, T0);
    for (const n of [9, 2]) {
      const d = addDays(today, -n);
      await testHold(d, 90 + n);
      await run(d, 5000, 1500 + n, 140);
      await threshold(d, 270);
    }
    expect(OBJECTIVE_BOARD_STATEMENTS).toBe(12);
    const res = await get();
    expect(res.status).toBe(200);
    // The session (requireUser), then: the preferences, the objectives and their key results, the strength sets and what
    // prescribed them (four), the runs, the matched runs' documents, the race days, the threshold days, the workouts.
    expect(res.cost).toBe(1 + OBJECTIVE_BOARD_STATEMENTS);
    expect(res.cost).toBeLessThanOrEqual(45);
  });

  it("with no objectives, reads only the preferences and the (empty) objectives", async () => {
    const res = await get();
    expect(res.body).toEqual({ today: todayInZone("UTC"), objectives: [] });
    expect(res.cost).toBe(1 + 3);
  });

  it("keeps every bound list under D1's 100 variables, however many objectives there are", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await createObjective(db, userId, { title: `O${i}`, sort: i, keyResults: [WALL_SIT_30] }, T0)).id);
    await workout(addDays(todayInZone("UTC"), -1), { objectiveIds: ids.slice(0, 10), state: "completed" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.objectives).toHaveLength(40);
    expect(res.body.objectives[0]!.served).toHaveLength(1);
    expect(res.cost).toBeLessThanOrEqual(1 + OBJECTIVE_BOARD_STATEMENTS);
  });
});
