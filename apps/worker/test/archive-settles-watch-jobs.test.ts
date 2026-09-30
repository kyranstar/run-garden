/**
 * AN ARCHIVE SETTLES THE ROW'S WATCH JOBS (audit 1, coach finding 1).
 *
 * Removing a session used to leave its COROS jobs that were still in flight
 * running: an approved add of more than three sessions drains three at once and
 * the rest wait for the hourly cron, so a session removed in that window was
 * created on the watch anyway — and nothing ever unpushed an archived row
 * afterwards. The watch kept a session the app no longer showed.
 *
 * Three halves, each pinned here against the real executor and the mock COROS
 * server:
 *  1. every archive path supersedes the row's QUEUED create, move and content
 *     jobs (a create that never ran is not a watch removal);
 *  2. the create executor re-reads the row: archived at claim → superseded and
 *     skipped; archived while the create was in flight → unpushed after verify;
 *  3. the delete executor addresses the session where COROS holds it at
 *     EXECUTION time, not where it stood when the unpush was queued.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, type CoachOp } from "@rg/domain";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { applyOps } from "../src/services/coach-apply.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { applyMove } from "../src/services/jobs.js";
import { enqueueUnpushIfOurs, removeFromPlan } from "../src/services/plan-mutations.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { plannedWorkouts, corosWriteJobs } = schema;

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

async function connect(db: Db, userId: string, server: ReturnType<typeof mockCorosServer>) {
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const res = await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl);
  expect(res.status).toBe("connected");
}

const easy = (m: number) => ({
  category: "easy" as const,
  title: `Easy ${m}`,
  durationMinutes: m,
  run: { blocks: [{ kind: "duration" as const, value: m, intensity: "easy" as const }] },
});

/** Every program name the mock COROS account currently holds. */
const serverNames = (server: ReturnType<typeof mockCorosServer>): string[] =>
  (server.state.schedule.programs ?? []).map((p) => String(p.name));

async function jobsFor(db: Db, workoutId: string) {
  return db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId));
}

async function rowOf(db: Db, id: string) {
  return (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
}

/** A coach row plus one job of each in-flight kind, all queued. */
async function seedRowWithQueuedJobs(db: Db, userId: string, id: string, date: string) {
  const now = nowInstant();
  await db.insert(plannedWorkouts).values({
    id,
    userId,
    planId: "coach-adhoc",
    sourceWorkoutId: id,
    title: "Easy 30",
    category: "easy",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: "",
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "scheduled",
    corosSyncState: "calendar_only",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 1800,
    createdAt: now,
    updatedAt: now,
  });
  const job = (jobId: string, kind: string, status = "queued") => ({
    id: jobId,
    userId,
    workoutId: id,
    kind,
    expectedContentFingerprint: "fp",
    originalDate: date,
    destinationDate: date,
    payload: { workoutId: id, happenDay: date },
    requestedAt: now,
    status,
    updatedAt: now,
  });
  await db.insert(corosWriteJobs).values([
    job(`${id}-push`, "coach_create_workout"),
    job(`${id}-move`, "move_scheduled_workout"),
    job(`${id}-content`, "coach_update_workout"),
    // A removal already on its way is not a competing claim — left alone.
    job(`${id}-unpush-x`, "coach_delete_workout"),
    // Settled history is never rewritten.
    job(`${id}-old`, "move_scheduled_workout", "verified"),
  ]);
}

const statusById = async (db: Db, workoutId: string) =>
  Object.fromEntries((await jobsFor(db, workoutId)).map((j) => [j.id, j.status]));

const SETTLED = (id: string) => ({
  [`${id}-push`]: "superseded",
  [`${id}-move`]: "superseded",
  [`${id}-content`]: "superseded",
  [`${id}-unpush-x`]: "queued",
  [`${id}-old`]: "verified",
});

describe("every archive path supersedes the row's queued watch jobs", () => {
  it("the athlete's own remove", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const date = addDays(todayInZone(prefs.timezone), 4);
    await seedRowWithQueuedJobs(db, userId, "w1", date);
    await removeFromPlan(db, userId, "w1", { now: nowInstant(), source: "remove_from_plan", prefs });
    expect(await statusById(db, "w1")).toEqual(SETTLED("w1"));
  });

  it("the coach's remove", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const date = addDays(todayInZone(prefs.timezone), 4);
    await seedRowWithQueuedJobs(db, userId, "w1", date);
    await applyOps(db, userId, prefs, "p-rm", [{ kind: "remove", workoutId: "w1" }]);
    expect(await statusById(db, "w1")).toEqual(SETTLED("w1"));
  });

  it("a coach retirePlan (the structural archive path)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Block",
      status: "active",
      startDate: today,
      endDate: addDays(today, 30),
      stampPrefix: "Block",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await seedRowWithQueuedJobs(db, userId, "w1", addDays(today, 4));
    await db.update(plannedWorkouts).set({ planId: "cp1" }).where(eq(plannedWorkouts.id, "w1"));
    await applyOps(db, userId, prefs, "p-retire", [{ kind: "retirePlan", planId: "cp1" } as CoachOp]);
    expect(await statusById(db, "w1")).toEqual(SETTLED("w1"));
  });
});

describe("a removed session whose create is still queued never reaches the watch", () => {
  it("approve a six-session add, drain three, remove one still queued: it is never created", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const today = todayInZone(prefs.timezone);
    const dates = [1, 2, 3, 4, 5, 6].map((n) => addDays(today, n));
    await applyOps(db, userId, prefs, "pp", [
      { kind: "add", date: dates[0]!, dates: dates.slice(1), session: easy(30) } as CoachOp,
    ]);
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const stillQueued = (
      await db
        .select()
        .from(corosWriteJobs)
        .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.status, "queued")))
    ).map((j) => j.workoutId);
    expect(stillQueued.length).toBeGreaterThanOrEqual(2);
    const [byHand, byCoach] = stillQueued;
    await removeFromPlan(db, userId, byHand!, { now: nowInstant(), source: "remove_from_plan", prefs });
    await applyOps(db, userId, prefs, "pr", [{ kind: "remove", workoutId: byCoach! }]);

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });

    for (const id of [byHand!, byCoach!]) {
      const row = await rowOf(db, id);
      expect(row.archivedAt).not.toBeNull();
      expect(row.lastVerifiedCorosDate).toBe("");
      expect(row.corosSyncState).not.toBe("synced");
      expect((await jobsFor(db, id)).map((j) => `${j.kind}:${j.status}`)).toEqual([
        "coach_create_workout:superseded",
      ]);
      expect(serverNames(server).filter((n) => n.endsWith(row.effectiveDate))).toEqual([]);
    }
    // The four sessions still on the plan all made it.
    expect(serverNames(server).filter((n) => n.startsWith("Easy 30"))).toHaveLength(4);
  });
});

describe("the create executor re-reads the row it is about to put on the watch", () => {
  async function seedQueuedCreate(db: Db, userId: string, id: string, date: string) {
    const now = nowInstant();
    await db.insert(plannedWorkouts).values({
      id,
      userId,
      planId: "coach-adhoc",
      sourceWorkoutId: id,
      title: "Easy 25",
      category: "easy",
      sport: "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      effectiveTime: "07:00",
      completionState: "scheduled",
      corosSyncState: "calendar_only",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 1500,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(corosWriteJobs).values({
      id: `${id}-push`,
      userId,
      workoutId: id,
      kind: "coach_create_workout",
      expectedContentFingerprint: "fp",
      originalDate: date,
      destinationDate: date,
      payload: { workoutId: id, happenDay: date, name: `Easy 25 — ${date}`, session: easy(25) },
      requestedAt: now,
      status: "queued",
      updatedAt: now,
    });
  }

  it("a row already archived when the job is claimed is skipped and its job superseded", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const date = addDays(todayInZone(prefs.timezone), 3);
    await seedQueuedCreate(db, userId, "wa", date);
    // Archived by a path that did not settle its jobs (legacy rows, or a race
    // with the claim itself).
    await db
      .update(plannedWorkouts)
      .set({ archivedAt: nowInstant(), archiveReason: "user_removed" })
      .where(eq(plannedWorkouts.id, "wa"));

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });

    expect((await jobsFor(db, "wa")).map((j) => j.status)).toEqual(["superseded"]);
    expect(serverNames(server)).not.toContain(`Easy 25 — ${date}`);
    expect((await rowOf(db, "wa")).lastVerifiedCorosDate).toBe("");
  });

  it("a row archived WHILE its create is in flight comes back off the watch", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const date = addDays(todayInZone(prefs.timezone), 3);
    await seedQueuedCreate(db, userId, "wb", date);

    // The athlete removes the session between the claim and the write landing:
    // the remove sees a claimed (not queued) create and no stamp yet.
    let removed = false;
    const racingFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (!removed && url.pathname === "/training/schedule/update") {
        removed = true;
        await removeFromPlan(db, userId, "wb", { now: nowInstant(), source: "remove_from_plan", prefs });
      }
      return server.fetchImpl(input, init);
    };

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: racingFetch, cap: 1 });
    expect(removed).toBe(true);
    const jobs = Object.fromEntries((await jobsFor(db, "wb")).map((j) => [j.id, j.status]));
    expect(jobs).toEqual({ "wb-push": "verified", "wb-unpush": "queued" });
    expect(serverNames(server)).toContain(`Easy 25 — ${date}`);

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(Object.fromEntries((await jobsFor(db, "wb")).map((j) => [j.id, j.status]))).toEqual({
      "wb-push": "verified",
      "wb-unpush": "verified",
    });
    expect(serverNames(server)).not.toContain(`Easy 25 — ${date}`);
  });
});

describe("the unpush addresses the session where COROS holds it when the delete runs", () => {
  it("a move that lands before the unpush does not strand the session on its new day", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const server = mockCorosServer();
    await connect(db, userId, server);
    const d = addDays(todayInZone(prefs.timezone), 3);
    const out = await applyOps(db, userId, prefs, "pp", [{ kind: "add", date: d, session: easy(30) }]);
    const id = out.created[0]!;
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const pushed = await rowOf(db, id);
    expect(pushed.lastVerifiedCorosDate).toBe(d);

    // A move is queued (and, in the race this pins, already claimed when the
    // remove runs — so the remove cannot supersede it), and then the unpush is
    // queued behind it carrying the PRE-move day.
    const moved = await applyMove(db, {
      userId,
      workoutId: id,
      toDate: addDays(d, 2),
      toTime: "07:00",
      source: "app",
      corosWritesEnabled: true,
    });
    expect(moved.jobId).toBeTruthy();
    await enqueueUnpushIfOurs(db, userId, pushed, nowInstant(), prefs);
    const [unpush] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `${id}-unpush`));
    expect((unpush!.payload as { happenDay: string }).happenDay).toBe(d);

    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });

    const [after] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `${id}-unpush`));
    expect(after!.status).toBe("verified");
    const entities = (server.state.schedule.entities ?? []).filter(
      (e) => String(e.idInPlan) === pushed.sourceIdInPlan,
    );
    expect(entities).toEqual([]);
  });
});
