/**
 * A MOVE COROS MADE AS REMOVE-AND-ADD IS A NEW PLACEMENT (review A5, seen in prod). When COROS refuses the in-place
 * date change, the executor clones the session onto its new day at a NEW idInPlan and deletes the original. The one
 * remove_and_add prod ever ran (a coach long run, 10-13 → 10-15) verified — and the planned row kept the old address,
 * so the next read found an unclaimed workout with the session's own fingerprint, minted a NEW row for it inside a
 * stale COROS-import plan, and archived the coach row as its `duplicate_mirror`.
 *
 * Driven against the mock COROS account, end to end: the create, the move with the in-place write refused, and the
 * reads after it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { normalizeCorosSchedule } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { applyOps } from "../src/services/coach-apply.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { applyMove } from "../src/services/jobs.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Account {
  db: Db;
  userId: string;
  prefs: UserPreferences;
  server: ReturnType<typeof mockCorosServer>;
  today: string;
}

async function account(): Promise<Account> {
  const db = makeTestDb({ boundVariableCap: 100 });
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
  const server = mockCorosServer();
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
  return { db, userId, prefs, server, today: todayInZone(prefs.timezone) };
}

async function readAndImport(a: Account): Promise<void> {
  const normalized = normalizeCorosSchedule(a.server.state.schedule);
  await importPlanSnapshot(
    a.db,
    {
      userId: a.userId,
      plan: {
        sourcePlanId: normalized.planId,
        name: normalized.planName,
        ...(normalized.planStart ? { startDate: normalized.planStart } : {}),
        ...(normalized.planEnd ? { endDate: normalized.planEnd } : {}),
      },
      workouts: normalized.workouts,
      rangeStart: addDays(a.today, -40),
      rangeEnd: addDays(a.today, 80),
      source: "fixture",
    },
    a.prefs,
  );
}

const rowOf = async (a: Account, id: string) =>
  (await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, id)))[0]!;

const liveOn = async (a: Account, date: string) =>
  (
    await a.db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, a.userId), eq(schema.plannedWorkouts.effectiveDate, date), isNull(schema.plannedWorkouts.archivedAt)))
  ).filter((w) => w.category !== "rest");

/** The coach's long run, created on the watch: the prod shape. */
async function coachLongRun(a: Account): Promise<{ id: string; date: string }> {
  const date = addDays(a.today, 3);
  const added = await applyOps(a.db, a.userId, a.prefs, "p-long", [
    coachOpSchema.parse({
      kind: "add",
      date,
      session: { category: "long", title: "Long run", durationMinutes: 80, run: { blocks: [{ kind: "duration", value: 80, intensity: "easy" }] } },
    }),
  ]);
  const id = added.created[0]!;
  await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
  const row = await rowOf(a, id);
  expect(row.corosSyncState).toBe("synced");
  expect(row.sourceIdInPlan).not.toBeNull();
  await readAndImport(a);
  return { id, date };
}

/** Move it two days on, with COROS refusing the in-place date change — the executor's remove-and-add path. */
async function moveByRemoveAndAdd(a: Account, workoutId: string, toDate: string): Promise<void> {
  a.server.updateRejectResult = "1001";
  await applyMove(a.db, { userId: a.userId, workoutId, toDate, toTime: "07:00", source: "app", corosWritesEnabled: true });
  await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: a.server.fetchImpl });
  a.server.updateRejectResult = null;
  const [move] = await a.db
    .select()
    .from(schema.corosWriteJobs)
    .where(and(eq(schema.corosWriteJobs.workoutId, workoutId), eq(schema.corosWriteJobs.kind, "move_scheduled_workout")));
  expect(move!.status).toBe("verified");
  expect(move!.pathUsed).toBe("remove_and_add");
}

describe("a remove-and-add move re-keys the planned row (review A5)", () => {
  it("the coach's session keeps its row: the new address recorded, and the reads after it find it there — no orphan copy, no duplicate_mirror", async () => {
    const a = await account();
    const { id, date } = await coachLongRun(a);
    const before = await rowOf(a, id);
    const toDate = addDays(date, 2);
    const rowsBefore = (await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, a.userId))).length;

    await moveByRemoveAndAdd(a, id, toDate);
    const onWire = normalizeCorosSchedule(a.server.state.schedule).workouts.filter((w) => w.date === toDate && w.title.startsWith("Long run"));
    expect(onWire).toHaveLength(1);
    const moved = await rowOf(a, id);
    expect(moved.sourceIdInPlan, "the clone's slot, not the deleted original's").toBe(onWire[0]!.sourceIdInPlan);
    expect(moved.sourceIdInPlan).not.toBe(before.sourceIdInPlan);
    expect(moved.sourceWorkoutId).toBe(onWire[0]!.sourceWorkoutId);
    // A coach-created row's program id is the placement's (`planProgramId`): its later moves and removals address it.
    expect(moved.sourceProgramId).toBe(onWire[0]!.planProgramId);
    expect(moved.lastVerifiedCorosDate).toBe(toDate);

    await readAndImport(a);
    await readAndImport(a);
    const after = await rowOf(a, id);
    expect(after.archivedAt, "the coach row is not anyone's mirror").toBeNull();
    expect(after.archiveReason).toBeNull();
    expect(after.completionState).toBe("scheduled");
    expect(after.effectiveDate).toBe(toDate);
    expect((await liveOn(a, toDate)).filter((w) => w.title === "Long run").map((w) => w.id), "one long run on its new day: the coach's").toEqual([id]);
    const rowsAfter = (await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, a.userId))).length;
    expect(rowsAfter, "no row minted for the clone").toBe(rowsBefore);
  });

  it("an imported session takes the clone's own program id: COROS issues a new one, and the second ownership proof reads it", async () => {
    const a = await account();
    await readAndImport(a);
    const [row] = await a.db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, a.userId), eq(schema.plannedWorkouts.title, "Threshold 5x5")));
    const original = a.server.programByIdInPlan(row!.sourceIdInPlan!)!;
    expect(row!.sourceProgramId, "an imported row holds COROS's program id").toBe(String(original.id));
    // A free day two on: the fixture's Tuesday threshold, onto Thursday's strides day + 1 (Friday's rest).
    const toDate = addDays(row!.effectiveDate, 3);

    await moveByRemoveAndAdd(a, row!.id, toDate);
    const clone = normalizeCorosSchedule(a.server.state.schedule).workouts.find((w) => w.title === "Threshold 5x5" && w.date === toDate)!;
    expect(clone).toBeDefined();
    const moved = await rowOf(a, row!.id);
    expect(moved.sourceWorkoutId).toBe(clone.sourceWorkoutId);
    expect(moved.sourceIdInPlan).toBe(clone.sourceIdInPlan);
    expect(moved.sourceProgramId).toBe(clone.sourceProgramId);
    expect(moved.sourceProgramId).not.toBe(String(original.id));

    await readAndImport(a);
    await readAndImport(a);
    const after = await rowOf(a, row!.id);
    expect(after.archivedAt).toBeNull();
    expect((await liveOn(a, toDate)).filter((w) => w.title === "Threshold 5x5").map((w) => w.id)).toEqual([row!.id]);
  });

  it("another row's stale claim on the new address never blocks the re-key: an archived one is released, the move still applies", async () => {
    const a = await account();
    const { id, date } = await coachLongRun(a);
    const coach = await rowOf(a, id);
    const toDate = addDays(date, 2);
    // The slot the clone will take, claimed in the coach's own plan by a session that left it (COROS recycles slots).
    const plan = coach.sourceWorkoutId.split(":")[0]!;
    const next = String(Number(a.server.state.schedule.maxIdInPlan) + 1);
    await a.db.insert(schema.plannedWorkouts).values({
      id: "gone",
      userId: a.userId,
      planId: coach.planId,
      sourceWorkoutId: `${plan}:${next}`,
      sourceIdInPlan: next,
      sourceProgramId: next,
      title: "An old session",
      category: "easy",
      sport: "run",
      originalPlanDate: addDays(a.today, -20),
      lastVerifiedCorosDate: addDays(a.today, -20),
      effectiveDate: addDays(a.today, -20),
      effectiveTime: "07:00",
      sourceContentFingerprint: "old",
      calendarBlockDurationSeconds: 1800,
      archivedAt: nowInstant(),
      archiveReason: "user_removed",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    await moveByRemoveAndAdd(a, id, toDate);
    const moved = await rowOf(a, id);
    expect(moved.sourceWorkoutId).toBe(`${plan}:${next}`);
    const gone = await rowOf(a, "gone");
    expect(gone.sourceWorkoutId, "its claim is history: released").toBe("gone");
    expect(gone.archivedAt).not.toBeNull();
    await readAndImport(a);
    expect((await rowOf(a, id)).archivedAt).toBeNull();
    expect((await rowOf(a, "gone")).archivedAt).not.toBeNull();
  });

  it("belt and braces: a read that finds the session's own stamped copy at an address no row claims follows it there — no row minted, nothing archived", async () => {
    const a = await account();
    const { id, date } = await coachLongRun(a);
    const before = await rowOf(a, id);
    const toDate = addDays(date, 2);
    await moveByRemoveAndAdd(a, id, toDate);
    const clone = await rowOf(a, id);
    // The re-key lost (the lane died between the verified move and its result — or a move verified before the fix).
    await a.db
      .update(schema.plannedWorkouts)
      .set({ sourceWorkoutId: before.sourceWorkoutId, sourceIdInPlan: before.sourceIdInPlan, sourceProgramId: before.sourceProgramId })
      .where(eq(schema.plannedWorkouts.id, id));
    const rowsBefore = (await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, a.userId))).length;

    await readAndImport(a);
    await readAndImport(a);
    const after = await rowOf(a, id);
    expect(after.archivedAt).toBeNull();
    expect(after.sourceWorkoutId, "followed to its copy").toBe(clone.sourceWorkoutId);
    expect(after.sourceIdInPlan).toBe(clone.sourceIdInPlan);
    expect(after.sourceProgramId).toBe(clone.sourceProgramId);
    expect(after.missingReads).toBe(0);
    const rowsAfter = (await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, a.userId))).length;
    expect(rowsAfter).toBe(rowsBefore);
    expect((await liveOn(a, toDate)).filter((w) => w.title === "Long run").map((w) => w.id)).toEqual([id]);
  });

  it("…and only then: the athlete's copy of the session beside the original is not taken for it (the dedupe decides, as before)", async () => {
    const a = await account();
    const { id } = await coachLongRun(a);
    const coach = await rowOf(a, id);
    // A copy made in the COROS app: the same name and steps, the same day, a slot of its own — the original still at its address.
    const next = Number(a.server.state.schedule.maxIdInPlan) + 1;
    const entity = structuredClone(a.server.entityByIdInPlan(coach.sourceIdInPlan!)!);
    const program = structuredClone(a.server.programByIdInPlan(coach.sourceIdInPlan!)!);
    a.server.state.schedule.entities!.push({ ...entity, id: "copy-entity", idInPlan: String(next), planProgramId: String(next) });
    a.server.state.schedule.programs!.push({ ...program, id: "copy-program", idInPlan: String(next) });
    a.server.state.schedule.maxIdInPlan = next;

    await readAndImport(a);
    const after = await rowOf(a, id);
    expect(after.sourceWorkoutId, "the coach row keeps its own copy").toBe(coach.sourceWorkoutId);
    expect(after.archivedAt).toBeNull();
    const copies = (await a.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, a.userId))).filter(
      (w) => w.sourceIdInPlan === String(next),
    );
    expect(copies.map((w) => w.archiveReason), "minted, and archived as the coach row's mirror — as it always was").toEqual(["duplicate_mirror"]);
  });

  it("…nor a copy whose steps differ: an edited workout is not the session's own copy", async () => {
    const a = await account();
    const { id, date } = await coachLongRun(a);
    const before = await rowOf(a, id);
    await moveByRemoveAndAdd(a, id, addDays(date, 2));
    const moved = await rowOf(a, id);
    await a.db
      .update(schema.plannedWorkouts)
      .set({ sourceWorkoutId: before.sourceWorkoutId, sourceIdInPlan: before.sourceIdInPlan, sourceProgramId: before.sourceProgramId })
      .where(eq(schema.plannedWorkouts.id, id));
    const program = a.server.programByIdInPlan(moved.sourceIdInPlan!)!;
    program.exercises = [{ ...program.exercises![0]!, targetValue: Number(program.exercises![0]!.targetValue) + 600 }];

    await readAndImport(a);
    expect((await rowOf(a, id)).sourceWorkoutId, "not followed").toBe(before.sourceWorkoutId);
  });

  it("a LIVE row of the same plan still claiming the new address is left alone: the re-key is skipped, never thrown", async () => {
    const a = await account();
    const { id, date } = await coachLongRun(a);
    const coach = await rowOf(a, id);
    const plan = coach.sourceWorkoutId.split(":")[0]!;
    const next = String(Number(a.server.state.schedule.maxIdInPlan) + 1);
    await a.db.insert(schema.plannedWorkouts).values({
      id: "stale-live",
      userId: a.userId,
      planId: coach.planId,
      sourceWorkoutId: `${plan}:${next}`,
      sourceIdInPlan: next,
      sourceProgramId: next,
      title: "An old session",
      category: "easy",
      sport: "run",
      originalPlanDate: addDays(a.today, 20),
      lastVerifiedCorosDate: addDays(a.today, 20),
      effectiveDate: addDays(a.today, 20),
      effectiveTime: "07:00",
      sourceContentFingerprint: "old",
      calendarBlockDurationSeconds: 1800,
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });

    await moveByRemoveAndAdd(a, id, addDays(date, 2));
    const moved = await rowOf(a, id);
    expect(moved.sourceWorkoutId, "not re-keyed onto a live row's claim").toBe(coach.sourceWorkoutId);
    expect(moved.lastVerifiedCorosDate, "the rest of the verified move applied").toBe(addDays(date, 2));
    expect((await rowOf(a, "stale-live")).sourceWorkoutId).toBe(`${plan}:${next}`);
  });
});
