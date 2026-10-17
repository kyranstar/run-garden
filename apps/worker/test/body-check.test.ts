/**
 * THE BODY CHECK (the new shape, 2026-10-17; design §4): "How's your body?" on the Today card — Fresh · A bit heavy ·
 * Sore somewhere (with an area picker). The answer is kept in the athlete's answers store (by area for soreness), and the
 * day adapts with no AI. This suite: the answer, its store, the view the card reads, and the refusals.
 *
 * Synthetic data only; the service tests pass `today` and `now` (a fixed Friday), the route tests use the real today.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { answerBodyCheck, BodyCheckClosedError, BodyCheckInvalidError, BodyCheckNotFoundError, readBodyCheck } from "../src/services/body-check.js";
import { todayBodyRoutes } from "../src/routes/today-body.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { DAY, makeEnv, NOON, rowOf, seedProgram, seedSlot, seedTmj, TOMORROW } from "./watch-push-fixture.js";

const { athleteAnswers, plannedWorkouts, sessionBuilds } = schema;

vi.setConfig({ testTimeout: 30_000 });

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let statements: string[];

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  programId = await seedProgram(db, userId);
});

const ctx = (over: Partial<{ today: string; now: string }> = {}) => ({ today: DAY, now: NOON, prefs, ...over });

async function answersOf(workoutId: string) {
  return (await db.select().from(athleteAnswers).where(and(eq(athleteAnswers.userId, userId), eq(athleteAnswers.workoutId, workoutId)))).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

describe("the answer", () => {
  it("keeps Fresh as today's body answer for the session, and changes nothing", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    const before = await rowOf(db, id);
    const out = await answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx());
    expect(out.view).toMatchObject({ workoutId: id, answer: { feel: "fresh", areas: [] }, change: null, open: true });
    const rows = await answersOf(id);
    expect(rows).toEqual([
      expect.objectContaining({
        questionId: "body_feel",
        valueChoice: "fresh",
        subjectKind: "workout",
        subjectId: id,
        source: "checkin",
        localDate: DAY,
        workoutId: id,
        expiresAt: DAY,
      }),
    ]);
    // Nothing built, nothing written to the session.
    expect(await rowOf(db, id)).toEqual(before);
    expect(await db.select().from(sessionBuilds)).toEqual([]);
  });

  it("keeps Sore somewhere by area: a soreness answer for each region or condition, fresh for soreness's days", async () => {
    await seedTmj(db, userId);
    const id = await seedSlot(db, userId, programId, DAY);
    const out = await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["calves", "tmj"] }, ctx());
    expect(out.view.answer).toEqual({ feel: "sore", areas: ["calves", "tmj"] });
    const rows = await answersOf(id);
    expect(rows.map((r) => [r.questionId, r.valueChoice, r.subjectKind, r.subjectId, r.expiresAt])).toEqual([
      ["body_feel", "sore", "workout", id, DAY],
      ["soreness", null, "region", "calves", addDays(DAY, 2)],
      ["soreness", null, "condition", "tmj", addDays(DAY, 2)],
    ]);
    expect(rows.every((r) => r.source === "checkin" && r.localDate === DAY && r.workoutId === id)).toBe(true);
  });

  it("a changed answer replaces the day's answer; the same answer again writes nothing", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["calves", "hips"] }, ctx());
    await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["neck"] }, ctx());
    expect((await answersOf(id)).map((r) => [r.questionId, r.subjectId])).toEqual([
      ["body_feel", id],
      ["soreness", "neck"],
    ]);
    statements = [];
    const again = await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["neck"] }, ctx());
    expect(again.view.answer).toEqual({ feel: "sore", areas: ["neck"] });
    // One read, and nothing else: the session isn't looked at again.
    expect(statements).toHaveLength(1);
  });

  it("refuses an area it doesn't know, areas without Sore, Sore without an area, and a condition that isn't switched on", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await expect(answerBodyCheck(db, userId, id, { feel: "sore", areas: ["elbows"] }, ctx())).rejects.toBeInstanceOf(BodyCheckInvalidError);
    await expect(answerBodyCheck(db, userId, id, { feel: "fresh", areas: ["calves"] }, ctx())).rejects.toBeInstanceOf(BodyCheckInvalidError);
    await expect(answerBodyCheck(db, userId, id, { feel: "sore", areas: [] }, ctx())).rejects.toBeInstanceOf(BodyCheckInvalidError);
    await expect(answerBodyCheck(db, userId, id, { feel: "sore", areas: ["tmj"] }, ctx())).rejects.toBeInstanceOf(BodyCheckInvalidError);
    expect(await answersOf(id)).toEqual([]);
  });

  it("a session taken off the plan is not found", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await db.update(plannedWorkouts).set({ archivedAt: NOON }).where(eq(plannedWorkouts.id, id));
    await expect(answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx())).rejects.toBeInstanceOf(BodyCheckNotFoundError);
    await expect(readBodyCheck(db, userId, id, ctx())).rejects.toBeInstanceOf(BodyCheckNotFoundError);
  });

  it("refuses a session that isn't the athlete's (not found), and one that isn't today's or has started (closed)", async () => {
    const other = await makeTestUser(db);
    const theirs = await seedSlot(db, other.userId, await seedProgram(db, other.userId), DAY);
    await expect(answerBodyCheck(db, userId, theirs, { feel: "fresh" }, ctx())).rejects.toBeInstanceOf(BodyCheckNotFoundError);
    const ahead = await seedSlot(db, userId, programId, TOMORROW);
    await expect(answerBodyCheck(db, userId, ahead, { feel: "fresh" }, ctx())).rejects.toBeInstanceOf(BodyCheckClosedError);
    const id = await seedSlot(db, userId, programId, DAY);
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, id));
    await expect(answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx())).rejects.toBeInstanceOf(BodyCheckClosedError);
    expect(await db.select().from(athleteAnswers)).toEqual([]);
  });
});

describe("the view", () => {
  it("answers no answer yet, open, and the areas the picker offers — the body's regions, then each condition switched on", async () => {
    await seedTmj(db, userId);
    const id = await seedSlot(db, userId, programId, DAY);
    const view = await readBodyCheck(db, userId, id, ctx());
    expect(view).toMatchObject({ workoutId: id, answer: null, change: null, open: true });
    expect(view.areas.map((a) => a.id)).toEqual([
      "neck", "shoulders", "upper-back", "chest", "arms", "core", "low-back", "hips", "glutes", "quads", "hamstrings", "calves", "ankles", "feet", "tmj",
    ]);
    expect(view.areas.find((a) => a.id === "low-back")?.label).toBe("Low back");
    expect(view.areas.find((a) => a.id === "tmj")?.label).toBe("Jaw / head");
  });

  it("is closed once the session has started, and shows the day's answer", async () => {
    const id = await seedSlot(db, userId, programId, DAY);
    await answerBodyCheck(db, userId, id, { feel: "fresh" }, ctx());
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, id));
    expect(await readBodyCheck(db, userId, id, ctx())).toMatchObject({ answer: { feel: "fresh" }, open: false });
  });

  it("reads in one statement: the session, its lock, the conditions, its modes, the answer and the record", async () => {
    await seedTmj(db, userId);
    const id = await seedSlot(db, userId, programId, DAY);
    await answerBodyCheck(db, userId, id, { feel: "sore", areas: ["calves"] }, ctx());
    statements = [];
    await readBodyCheck(db, userId, id, ctx());
    expect(statements.length).toBe(1);
    expect(statements.filter(isWrite)).toEqual([]);
  });
});

describe("the routes", () => {
  let cookie: string;
  let today: string;
  beforeEach(async () => {
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
    today = todayInZone(prefs.timezone);
  });
  const call = (method: string, path: string, body?: unknown) =>
    mountRoutes(db, "/api/today", todayBodyRoutes).request(
      path,
      { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
      makeEnv(),
    );

  it("GET /body?workout= answers the view; POST /body keeps the answer; 404, 409 and 422 as the service refuses", async () => {
    const id = await seedSlot(db, userId, programId, today);
    const read = await call("GET", `/api/today/body?workout=${id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ workoutId: id, answer: null, open: true });
    const saved = await call("POST", "/api/today/body", { workoutId: id, feel: "sore", areas: ["hips"] });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ workoutId: id, answer: { feel: "sore", areas: ["hips"] } });
    expect((await call("GET", "/api/today/body?workout=nobody")).status).toBe(404);
    expect((await call("POST", "/api/today/body", { workoutId: id, feel: "tired" })).status).toBe(422);
    expect((await call("POST", "/api/today/body", { workoutId: id, feel: "sore", areas: ["elbows"] })).status).toBe(422);
    await db.update(plannedWorkouts).set({ contentState: "done" }).where(eq(plannedWorkouts.id, id));
    const closed = await call("POST", "/api/today/body", { workoutId: id, feel: "fresh" });
    expect([closed.status, await closed.json()]).toEqual([409, { error: "closed" }]);
  });
});
