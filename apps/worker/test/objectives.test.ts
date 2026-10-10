/**
 * Objectives and their key results (programme spec §3.6–3.7, Amendment A; principles §5.2): created, listed, changed
 * and measured through `/api/objectives`, every route user-scoped (another account's objective is a 404), every body
 * validated (422 with the issues), every request within the 45-statement budget.
 *
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type ObjectiveDto, type ObjectiveProgressDto, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { objectiveRoutes } from "../src/routes/profile.js";
import { createObjective, listObjectives } from "../src/services/objectives.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { accountState, keyResults, objectives, performedSessions, performedSets } = schema;

const T0 = "2026-06-02T12:00:00.000Z";

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let cookie: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db, { weightUnit: "lb", units: "mi" }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

function makeEnv(): Env {
  return { DB: {} as Env["DB"], ASSETS: {} as Env["ASSETS"], APP_URL: "https://app.test", SESSION_SECRET: "s", AI_DEFAULT_ENABLED: "0" } as Env;
}

const call = (method: string, path: string, body?: unknown, as: string = cookie) =>
  mountRoutes(db, "/api/objectives", objectiveRoutes).request(
    path,
    { method, headers: { Cookie: as, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    makeEnv(),
  );

const SQUAT_KR = { label: "Squat estimated max", measure: { kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm" }, target: 100 };
const WALL_SIT_KR = { label: "Wall sit", measure: { kind: "hold_max", libraryIds: ["wallSit"] }, target: 120 };
const TEN_K_KR = { label: "10K time", measure: { kind: "run_best", distanceM: 10000 }, target: 3000, dueDate: "2026-12-01" };

async function created(body: unknown = { title: "Stronger legs for ski season", keyResults: [SQUAT_KR, WALL_SIT_KR] }): Promise<ObjectiveDto> {
  const res = await call("POST", "/api/objectives", body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { objective: ObjectiveDto }).objective;
}

describe("POST /api/objectives", () => {
  it("creates an objective with its key results: the measure's direction and the athlete's unit filled in", async () => {
    const objective = await created({
      title: "Stronger legs for ski season",
      why: "Ski the whole day",
      goalIds: ["ski", "strength"],
      keyResults: [SQUAT_KR, WALL_SIT_KR, TEN_K_KR, { label: "Easy pace at 140-150", measure: { kind: "pace_at_hr", hrLow: 140, hrHigh: 150 } }],
    });
    expect(objective).toMatchObject({ title: "Stronger legs for ski season", why: "Ski the whole day", status: "active", goalIds: ["ski", "strength"], sort: 0 });
    expect(objective.keyResults.map((k) => [k.label, k.direction, k.unit, k.target])).toEqual([
      ["Squat estimated max", "up", "lb", 100],
      ["Wall sit", "up", "s", 120],
      ["10K time", "down", "s", 3000],
      ["Easy pace at 140-150", "down", "s/mi", null],
    ]);
    // Measures are stored with their defaults, as parsed.
    expect(objective.keyResults[1]!.measure).toEqual({ kind: "hold_max", libraryIds: ["wallSit"], windowDays: 90 });
    expect(objective.keyResults[3]!.measure).toEqual({ kind: "pace_at_hr", hrLow: 140, hrHigh: 150, minDurationSec: 1200, windowDays: 90 });
    expect(await listObjectives(db, userId)).toEqual([objective]);
  });

  it.each([
    ["an empty title", { title: " " }],
    ["an unknown field", { title: "T", owner: "someone" }],
    ["a status outside the list", { title: "T", status: "archived" }],
    ["a goal outside the goal ids", { title: "T", goalIds: ["flying"] }],
    ["a measure kind outside the list", { title: "T", keyResults: [{ label: "x", measure: { kind: "vibes" } }] }],
    ["a hold of no moves", { title: "T", keyResults: [{ label: "x", measure: { kind: "hold_max", libraryIds: [] } }] }],
    ["a window under a week", { title: "T", keyResults: [{ label: "x", measure: { kind: "hold_max", libraryIds: ["wallSit"], windowDays: 3 } }] }],
    ["a load-at-reps with no reps", { title: "T", keyResults: [{ label: "x", measure: { kind: "best_set", libraryIds: ["gobletSquat"], metric: "load_at_reps" } }] }],
    ["a reps-at-load with no load", { title: "T", keyResults: [{ label: "x", measure: { kind: "best_set", libraryIds: ["gobletSquat"], metric: "reps_at_load" } }] }],
    ["an upside-down heart-rate range", { title: "T", keyResults: [{ label: "x", measure: { kind: "pace_at_hr", hrLow: 160, hrHigh: 140 } }] }],
    ["a run shorter than a kilometre", { title: "T", keyResults: [{ label: "x", measure: { kind: "run_best", distanceM: 400 } }] }],
    ["a unit the measure is not kept in", { title: "T", keyResults: [{ ...SQUAT_KR, unit: "s" }] }],
    ["a direction against the measure", { title: "T", keyResults: [{ ...TEN_K_KR, direction: "up" }] }],
    ["a check-in with no direction", { title: "T", keyResults: [{ label: "x", measure: { kind: "checkin", questionId: "energy" } }] }],
    ["a due date that is not a date", { title: "T", keyResults: [{ ...TEN_K_KR, dueDate: "December" }] }],
    ["a key result with an id", { title: "T", keyResults: [{ ...SQUAT_KR, id: "kr-1" }] }],
    ["eleven key results", { title: "T", keyResults: Array.from({ length: 11 }, () => WALL_SIT_KR) }],
  ])("is 422 for %s, writing nothing", async (_what, body) => {
    const res = await call("POST", "/api/objectives", body);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_objective", issues: expect.any(Array) });
    expect(await db.select().from(objectives)).toEqual([]);
    expect(await db.select().from(keyResults)).toEqual([]);
  });

  it("is 422 for a move the library does not hold, naming where", async () => {
    const res = await call("POST", "/api/objectives", { title: "T", keyResults: [{ label: "x", measure: { kind: "hold_max", libraryIds: ["wallSit", "levitation"] } }] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: Array<{ path: Array<string | number> }> };
    expect(body.issues).toContainEqual(expect.objectContaining({ path: ["keyResults", 0, "measure", "libraryIds", 1] }));
  });

  it("is 423 while a restore is replacing the account", async () => {
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    expect((await call("POST", "/api/objectives", { title: "T" })).status).toBe(423);
    await expect(createObjective(db, userId, { title: "T" }, T0)).rejects.toThrow();
  });

  it("stays within 45 statements with ten key results", async () => {
    statements.length = 0;
    await created({ title: "T", keyResults: Array.from({ length: 10 }, (_, i) => ({ ...WALL_SIT_KR, label: `Hold ${i}` })) });
    expect(statements.length).toBeLessThanOrEqual(45);
  });
});

describe("GET /api/objectives", () => {
  it("lists this account's objectives in board order with their key results — never another account's", async () => {
    const second = await created({ title: "Second", sort: 2 });
    const first = await created({ title: "First", sort: 1, keyResults: [WALL_SIT_KR] });
    const { userId: other } = await makeTestUser(db);
    await createObjective(db, other, { title: "Theirs", keyResults: [SQUAT_KR] }, T0);

    statements.length = 0;
    const res = await call("GET", "/api/objectives");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { objectives: ObjectiveDto[] };
    expect(body.objectives.map((o) => o.title)).toEqual(["First", "Second"]);
    expect(body.objectives[0]).toEqual(first);
    expect(body.objectives[1]).toEqual(second);
    expect(statements.length).toBeLessThanOrEqual(45);
    expect(statements.filter(isWrite)).toEqual([]);
  });
});

describe("PUT /api/objectives/:id", () => {
  it("changes only what is sent", async () => {
    const objective = await created();
    const res = await call("PUT", `/api/objectives/${objective.id}`, { status: "paused", sort: 5 });
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { objective: ObjectiveDto }).objective;
    expect(body).toMatchObject({ title: objective.title, status: "paused", sort: 5 });
    expect(body.keyResults).toEqual(objective.keyResults);
  });

  it("replaces the key results whole: one sent with its id changes, one without is new, one left out is deleted", async () => {
    const objective = await created();
    const [squat, wallSit] = objective.keyResults;
    const res = await call("PUT", `/api/objectives/${objective.id}`, {
      keyResults: [{ ...SQUAT_KR, id: squat!.id, target: 110 }, TEN_K_KR],
    });
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { objective: ObjectiveDto }).objective;
    expect(body.keyResults.map((k) => k.label).sort()).toEqual(["10K time", "Squat estimated max"]);
    const kept = body.keyResults.find((k) => k.id === squat!.id)!;
    expect(kept).toMatchObject({ target: 110, createdAt: squat!.createdAt });
    expect(body.keyResults.some((k) => k.id === wallSit!.id)).toBe(false);
    expect(await db.select({ id: keyResults.id }).from(keyResults).where(eq(keyResults.id, wallSit!.id))).toEqual([]);
  });

  it("a kept key result sent without a unit keeps the unit its target is in after the athlete's unit changed; a new one takes the new unit", async () => {
    const objective = await created();
    await savePreferences(db, userId, { ...prefs, weightUnit: "kg" });
    const squat = objective.keyResults[0]!;
    const res = await call("PUT", `/api/objectives/${objective.id}`, {
      keyResults: [{ ...SQUAT_KR, id: squat.id }, { ...SQUAT_KR, label: "Box squat max", measure: { ...SQUAT_KR.measure, libraryIds: ["boxSquat"] } }],
    });
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { objective: ObjectiveDto }).objective;
    expect(body.keyResults.map((k) => [k.label, k.unit, k.target])).toEqual([
      ["Squat estimated max", "lb", 100],
      ["Box squat max", "kg", 100],
    ]);
  });

  it("is 422 for a key-result id that is not one of this objective's, changing nothing", async () => {
    const objective = await created();
    const otherObjective = await created({ title: "Other", keyResults: [TEN_K_KR] });
    const res = await call("PUT", `/api/objectives/${objective.id}`, {
      keyResults: [{ ...TEN_K_KR, id: otherObjective.keyResults[0]!.id }],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_objective" });
    expect((await listObjectives(db, userId)).find((o) => o.id === objective.id)!.keyResults).toEqual(objective.keyResults);
    expect((await listObjectives(db, userId)).find((o) => o.id === otherObjective.id)!.keyResults).toEqual(otherObjective.keyResults);
  });

  it.each([
    ["an empty body", {}],
    ["an empty title", { title: "" }],
    ["a key result with a bad measure", { keyResults: [{ label: "x", measure: { kind: "hold_max" } }] }],
  ])("is 422 for %s", async (_what, body) => {
    const objective = await created();
    const res = await call("PUT", `/api/objectives/${objective.id}`, body);
    expect(res.status).toBe(422);
  });

  it("is 404 for another account's objective (and one that does not exist), leaving it unchanged", async () => {
    const { userId: other } = await makeTestUser(db);
    const theirs = await createObjective(db, other, { title: "Theirs", keyResults: [SQUAT_KR] }, T0);
    for (const id of [theirs.id, "no-such-objective"]) {
      const res = await call("PUT", `/api/objectives/${id}`, { title: "Mine now", keyResults: [] });
      expect(res.status).toBe(404);
    }
    expect(await listObjectives(db, other)).toEqual([theirs]);
  });

  it("stays within 45 statements replacing ten key results", async () => {
    const objective = await created({ title: "T", keyResults: Array.from({ length: 10 }, (_, i) => ({ ...WALL_SIT_KR, label: `Hold ${i}` })) });
    statements.length = 0;
    const res = await call("PUT", `/api/objectives/${objective.id}`, {
      title: "T2",
      keyResults: objective.keyResults.map((k, i) => ({ ...WALL_SIT_KR, id: k.id, label: `Hold ${i}`, target: 60 + i })),
    });
    expect(res.status).toBe(200);
    expect(statements.length).toBeLessThanOrEqual(45);
  });
});

describe("GET /api/objectives/:id/progress", () => {
  async function loggedSquats(days: number, perDay: Array<{ reps: number; value: number; unit: "lb" | "kg" }>): Promise<void> {
    const today = todayInZone(prefs.timezone);
    for (let d = 0; d < days; d += 1) {
      const sessionId = newId();
      await db.insert(performedSessions).values({
        id: sessionId, userId, source: "app", localDate: addDays(today, -d), payloadHash: "h", createdAt: T0, updatedAt: T0,
      });
      await db.insert(performedSets).values(
        perDay.map((s, i) => ({
          id: newId(), performedSessionId: sessionId, entryIndex: 0, exerciseId: "gobletSquat", setIndex: i,
          reps: s.reps, loadValue: s.value, loadUnit: s.unit, loadKg: s.unit === "kg" ? s.value : s.value * 0.45359237,
        })),
      );
    }
  }

  it("measures each key result from logged data, in its own unit", async () => {
    const objective = await created();
    await loggedSquats(1, [{ reps: 5, value: 60, unit: "kg" }]);
    const res = await call("GET", `/api/objectives/${objective.id}/progress`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ObjectiveProgressDto;
    expect(body.objectiveId).toBe(objective.id);
    expect(body.today).toBe(todayInZone(prefs.timezone));
    const squat = body.keyResults.find((k) => k.keyResult.label === "Squat estimated max")!;
    // 60 kg × (1 + 5/30) = 70 kg; no prescription is known, so it is a lower bound.
    expect(squat.progress).toMatchObject({ unit: "kg", current: 70, evidence: "capped", sampleSize: 1, display: { unit: "lb", current: 154.3 } });
    const wallSit = body.keyResults.find((k) => k.keyResult.label === "Wall sit")!;
    expect(wallSit.progress).toMatchObject({ current: null, evidence: "none", missing: expect.any(String), sampleSize: 0 });
  });

  it("a key result whose stored measure can no longer be read answers none, never a 500", async () => {
    const objective = await created();
    await db.update(keyResults).set({ measure: { kind: "retired_measure" } }).where(eq(keyResults.id, objective.keyResults[0]!.id));
    const res = await call("GET", `/api/objectives/${objective.id}/progress`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ObjectiveProgressDto;
    expect(body.keyResults[0]!.keyResult.measure).toBeNull();
    expect(body.keyResults[0]!.progress).toMatchObject({ evidence: "none", missing: expect.any(String) });
  });

  it("is 404 for another account's objective", async () => {
    const { userId: other } = await makeTestUser(db);
    const theirs = await createObjective(db, other, { title: "Theirs", keyResults: [SQUAT_KR] }, T0);
    expect((await call("GET", `/api/objectives/${theirs.id}/progress`)).status).toBe(404);
    expect((await call("GET", "/api/objectives/no-such/progress")).status).toBe(404);
  });

  it("stays within 45 statements with ten key results over 120 logged sessions, under D1's bind cap", async () => {
    const objective = await created({
      title: "Everything",
      keyResults: [
        SQUAT_KR,
        WALL_SIT_KR,
        TEN_K_KR,
        { ...SQUAT_KR, label: "Squat 5RM", measure: { kind: "best_set", libraryIds: ["gobletSquat", "boxSquat"], metric: "load_at_reps", reps: 5 } },
        { ...SQUAT_KR, label: "Squat reps at 40 kg", measure: { kind: "best_set", libraryIds: ["gobletSquat"], metric: "reps_at_load", loadKg: 40 }, unit: "reps" },
        { label: "Pace at 140-150", measure: { kind: "pace_at_hr", hrLow: 140, hrHigh: 150 } },
        { label: "Threshold", measure: { kind: "threshold_pace" } },
        { label: "Half prediction", measure: { kind: "predicted_time", distanceM: 21097.5 } },
        { label: "Energy", measure: { kind: "checkin", questionId: "energy" }, direction: "up" },
        { label: "Split squat hold", measure: { kind: "hold_max", libraryIds: ["splitSquatHold"], windowDays: 365 } },
      ],
    });
    await loggedSquats(120, [{ reps: 5, value: 135, unit: "lb" }, { reps: 8, value: 50, unit: "kg" }]);
    statements.length = 0;
    const res = await call("GET", `/api/objectives/${objective.id}/progress`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ObjectiveProgressDto;
    expect(body.keyResults).toHaveLength(10);
    expect(statements.length).toBeLessThanOrEqual(45);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(statements.some((s) => /select \*/i.test(s))).toBe(false);
  });
});
