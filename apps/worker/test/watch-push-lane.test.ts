/**
 * THE PUSH IN THE CLOUD WRITE LANE (Phase 3 Task 5; spec §4.3, §6, §7).
 *
 * A queued `program_session_push` runs through the production `createWorkout` against the mock COROS: the row
 * records the address, the wire fingerprint and `synced`; the job records what the read-back observed. The executor
 * re-reads the row at claim (archived, moved, or holding another locked build → superseded, no wire call), re-checks
 * the catalog before any wire call, and queues the unpush at once when the row moved while the push ran (Review
 * Focus 3). The switch off: the push is never claimed, and nothing behind it waits. One run stays inside the Workers
 * Free subrequest budget. Against a COROS that re-encodes what it stores, the observed fingerprints are its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import { corosProgramFingerprint, corosStructureFingerprint, programTextFingerprint, type RawCorosProgram } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { buildSession } from "../src/services/session-build.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { renormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import {
  connectMock,
  counting,
  DAY,
  makeEnv,
  NOON,
  rowOf,
  seedCatalog,
  seedProgram,
  seedSlot,
  seedTmj,
  switchOn,
  TOMORROW,
} from "./watch-push-fixture.js";

const { corosWriteJobs, sessionBuilds, plannedWorkouts } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let server: MockCorosServer;

async function setup(make: () => MockCorosServer = () => mockCorosServer({ baseMonday: "2026-10-12" })) {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
  server = make();
  await connectMock(db, userId, server);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
});
afterEach(() => {
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });

/** A slot built today and sent: its push queued. */
async function sent(id?: string): Promise<{ workoutId: string; buildId: string }> {
  const workoutId = await seedSlot(db, userId, programId, DAY, id);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
  await sendToWatch(db, switchOn(), userId, workoutId, built.build!.buildId, ctx());
  return { workoutId, buildId: built.build!.buildId };
}

const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const storedProgram = (name: string): RawCorosProgram | undefined =>
  (server.state.schedule.programs ?? []).find((p) => p.name === name);

describe("a queued push runs", () => {
  beforeEach(() => setup());

  it("records the address, the wire fingerprint and synced; the job is verified with what the read-back observed", async () => {
    const { workoutId, buildId } = await sent();
    const fetches = counting(server);
    const { executed } = await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: fetches.fetchImpl });
    expect(executed).toBe(1);

    const job = await jobOf(`push:${buildId}`);
    expect(job).toMatchObject({ status: "verified" });
    expect(job!.verifiedAt).toBeTruthy();
    const payload = programSessionPushJobSchema.parse(job!.payload);
    const stored = storedProgram(payload.name)!;
    expect(stored).toBeDefined();
    expect(payload.observed).toEqual({ wire: corosProgramFingerprint(stored), text: programTextFingerprint(stored), structure: corosStructureFingerprint(stored) });

    const row = await rowOf(db, workoutId);
    const entity = server.state.schedule.entities!.find((e) => String(e.idInPlan) === String(stored.idInPlan))!;
    expect(row).toMatchObject({
      sourceWorkoutId: `${server.state.schedule.id}:${entity.idInPlan}`,
      sourceIdInPlan: String(entity.idInPlan),
      sourceProgramId: String(entity.planProgramId ?? entity.idInPlan),
      lastVerifiedCorosDate: DAY,
      corosSyncState: "synced",
      sourceContentFingerprint: corosProgramFingerprint(stored),
      contentState: "built",
    });
    // The stored steps are the payload's, one wire step each.
    expect((stored.exercises ?? []).filter((e) => e.isGroup !== true)).toHaveLength(payload.session.steps.length);
    console.info(`[budget] one push, typical path: ${fetches.calls()} COROS fetches`);

    // A second run of the same job creates nothing: the stamp is already on the day.
    await db.update(corosWriteJobs).set({ status: "queued" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    const writes = server.counts.scheduleWrites;
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(server.counts.scheduleWrites).toBe(writes);
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect(programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload).observed).toEqual(payload.observed);
  });
});

describe("the switch off", () => {
  beforeEach(() => setup());

  it("a queued push is never claimed, and a coach job queued behind it still runs", async () => {
    const { buildId } = await sent();
    // A coach session queued AFTER the push.
    await db.insert(plannedWorkouts).values({
      id: "coach-1", userId, planId: "coach-adhoc", sourceWorkoutId: "coach-1", title: "Easy 30", category: "easy", sport: "run",
      originalPlanDate: TOMORROW, lastVerifiedCorosDate: "", effectiveDate: TOMORROW, effectiveTime: "07:00", completionState: "scheduled",
      corosSyncState: "calendar_only", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, createdAt: NOON, updatedAt: NOON,
    });
    await db.insert(corosWriteJobs).values({
      id: "coach-1-push", userId, workoutId: "coach-1", kind: "coach_create_workout", expectedContentFingerprint: "fp",
      originalDate: TOMORROW, destinationDate: TOMORROW, requestedAt: `${DAY}T19:00:01.000Z`, status: "queued", updatedAt: NOON,
      payload: {
        workoutId: "coach-1", happenDay: TOMORROW, name: `Easy 30 — ${TOMORROW}`,
        session: { category: "easy", title: "Easy 30", durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] } },
      },
    });
    const { executed } = await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect(executed).toBe(1);
    expect((await jobOf("coach-1-push"))!.status).toBe("verified");
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
    expect(storedProgram(programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload).name)).toBeUndefined();
  });
});

describe("the row is re-read at claim: superseded, no wire call", () => {
  beforeEach(() => setup());

  const runCounted = async () => {
    const fetches = counting(server);
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: fetches.fetchImpl });
    return fetches;
  };

  it("archived", async () => {
    const { workoutId, buildId } = await sent();
    await db.update(plannedWorkouts).set({ archivedAt: NOON }).where(eq(plannedWorkouts.id, workoutId));
    const fetches = await runCounted();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
    expect(fetches.calls()).toBe(0);
  });

  it("moved to another day", async () => {
    const { workoutId, buildId } = await sent();
    await db.update(plannedWorkouts).set({ effectiveDate: TOMORROW }).where(eq(plannedWorkouts.id, workoutId));
    const fetches = await runCounted();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
    expect(fetches.calls()).toBe(0);
  });

  it("holding another locked build", async () => {
    const { workoutId, buildId } = await sent();
    await db.update(sessionBuilds).set({ lockedAt: null }).where(eq(sessionBuilds.id, buildId));
    await db.insert(sessionBuilds).values({
      id: "other-build", userId, workoutId, version: 99, engineVersion: "x", inputsHash: "x", payload: {}, lockedAt: NOON, createdAt: NOON,
    });
    const fetches = await runCounted();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("superseded");
    expect(fetches.calls()).toBe(0);
  });
});

describe("the slot moved while the push ran (Review Focus 3)", () => {
  beforeEach(() => setup());

  it("the push verifies, then unpush:<buildId> is queued at once for where COROS holds it", async () => {
    const { workoutId, buildId } = await sent();
    const fetches = counting(server, async (url, init) => {
      if (url.pathname !== "/training/schedule/update") return;
      const body = JSON.parse(String(init?.body)) as { versionObjects?: Array<{ status?: number }> };
      if (body.versionObjects?.[0]?.status !== 1) return;
      // The athlete moves the slot to tomorrow while the create is on the wire.
      await db.update(plannedWorkouts).set({ effectiveDate: TOMORROW }).where(eq(plannedWorkouts.id, workoutId));
    });
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: fetches.fetchImpl, cap: 1 });
    const push = await jobOf(`push:${buildId}`);
    expect(push!.status).toBe("verified");
    const name = programSessionPushJobSchema.parse(push!.payload).name;
    const row = await rowOf(db, workoutId);
    expect(row.lastVerifiedCorosDate).toBe(DAY);
    const unpush = await jobOf(`unpush:${buildId}`);
    expect(unpush).toMatchObject({ kind: "coach_delete_workout", status: "queued" });
    expect(unpush!.payload).toMatchObject({ workoutId, happenDay: DAY, name, idInPlan: row.sourceIdInPlan, programId: row.sourceProgramId });

    // The unpush runs (deletes and unpushes run whatever the switch says): the watch ends with nothing on the old day.
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("verified");
    expect(storedProgram(name)).toBeUndefined();
  });
});

describe("the catalog changed between send and run", () => {
  beforeEach(() => setup());

  it("a catalog id that left coros_exercises: failed (error), nothing written", async () => {
    const { buildId } = await sent();
    const payload = programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload);
    const catalogStep = payload.session.steps.find((s) => s.originId !== "0");
    expect(catalogStep, "the build holds at least one catalog move").toBeDefined();
    await db.delete(schema.corosExercises).where(eq(schema.corosExercises.id, catalogStep!.originId));
    const fetches = counting(server);
    // One claim is enough: retrying cannot bring the catalog row back, so the job fails outright.
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: fetches.fetchImpl, cap: 1 });
    expect(await jobOf(`push:${buildId}`)).toMatchObject({ status: "failed", lastErrorCategory: "error" });
    expect(fetches.calls()).toBe(0);
  });
});

describe("the subrequest budget (Workers Free: 50 per invocation)", () => {
  beforeEach(() => setup());

  async function threeSent(): Promise<void> {
    await sent();
    await sent(`slot-${programId}-${DAY}-b`);
    await sent(`slot-${programId}-${DAY}-c`);
  }

  it("a three-push run, typical path: at most 45 COROS fetches", async () => {
    await threeSent();
    const fetches = counting(server);
    const { executed } = await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: fetches.fetchImpl });
    expect(executed).toBe(3);
    console.info(`[budget] three pushes, typical path: ${fetches.calls()} COROS fetches`);
    expect(fetches.calls()).toBeLessThanOrEqual(45);
  });

  it("a three-push run, worst path (every read-back misses and the wide sweep runs): at most 45", async () => {
    await threeSent();
    server.addSilentlyFails = true;
    const fetches = counting(server);
    const { executed } = await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: fetches.fetchImpl });
    expect(executed).toBe(3);
    console.info(`[budget] three pushes, worst path: ${fetches.calls()} COROS fetches`);
    expect(fetches.calls()).toBeLessThanOrEqual(45);
  });
});

describe("against a COROS that re-encodes what it stores (Review Focus 5)", () => {
  beforeEach(() => setup(() => renormalizingCoros({ baseMonday: "2026-10-12" })));

  it("verifies, and the recorded fingerprints are the re-encoded program's", async () => {
    const { workoutId, buildId } = await sent();
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    const job = await jobOf(`push:${buildId}`);
    expect(job!.status).toBe("verified");
    const payload = programSessionPushJobSchema.parse(job!.payload);
    const stored = storedProgram(payload.name)!;
    expect((server as unknown as { reencoded: number }).reencoded).toBe(1);
    expect(payload.observed).toEqual({ wire: corosProgramFingerprint(stored), text: programTextFingerprint(stored), structure: corosStructureFingerprint(stored) });
    expect((await rowOf(db, workoutId)).sourceContentFingerprint).toBe(corosProgramFingerprint(stored));
  });
});
