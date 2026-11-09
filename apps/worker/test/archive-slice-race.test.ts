/**
 * A PLAN'S SESSIONS ARCHIVED IN BULK, RACED (final review B, A): a slice of `archiveSlice` (a plan structure's retire, its
 * reshaped week) reads a plan's still-scheduled sessions, then archives them in one batch. A Start, or the watch's completion,
 * landing between that read and the batch must leave the session as it is: not archived, no copy taken off the watch, its
 * build still locked, its completion standing. The batch is held at its door with a gate. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, type UserPreferences } from "@rg/domain";

/** The slice's own batch (the one that writes `archive_reason`), held at its door. */
const gates = vi.hoisted(() => ({ batch: null as null | (() => Promise<void>) }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/db.js")>();
  return {
    ...real,
    runAtomically: async (...args: Parameters<typeof real.runAtomically>) => {
      const archives = (args[1] as unknown as Array<{ toSQL?: () => { sql: string } }>).some((s) => s.toSQL?.().sql.includes("archive_reason"));
      const hold = archives ? gates.batch : null;
      if (archives) gates.batch = null;
      if (hold) await hold();
      return real.runAtomically(...args);
    },
  };
});

import type { Db } from "../src/services/db.js";
import { applyStructuralChunk } from "../src/services/coach-apply.js";
import { buildSession, startSession } from "../src/services/session-build.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser } from "./helpers.js";
import { DAY, NOON, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { coachPlans, corosWriteJobs, plannedWorkouts, sessionBuilds } = schema;

let db: Db;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  gates.batch = null;
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await seedTmj(db, userId);
  await seedCatalog(db);
});
afterEach(() => vi.useRealTimers());

/** A slot sent to the watch and verified there, filed under a coach plan (as a workout naming the plan is). */
async function sentUnderPlan() {
  const programId = await seedProgram(db, userId);
  const workoutId = await seedSlot(db, userId, programId, DAY);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, { today: DAY, now: NOON, prefs });
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, workoutId, buildId, { today: DAY, now: NOON, prefs });
  await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, `push:${buildId}`));
  await db.update(plannedWorkouts).set({ sourceWorkoutId: "4738:91", sourceIdInPlan: "91", sourceProgramId: "91", lastVerifiedCorosDate: DAY, corosSyncState: "synced" }).where(eq(plannedWorkouts.id, workoutId));
  const planId = "plan-race";
  await db.insert(coachPlans).values({ id: planId, userId, discipline: "lift", name: "Base block", status: "active", startDate: addDays(DAY, -30), endDate: addDays(DAY, 30), raceDate: null, stampPrefix: "RG", programId: null, createdAt: nowInstant(), updatedAt: nowInstant() });
  await db.update(plannedWorkouts).set({ planId }).where(eq(plannedWorkouts.id, workoutId));
  return { workoutId, buildId, planId };
}

async function retire(planId: string) {
  let progress = null as never;
  for (let i = 0; i < 8; i++) {
    const r = await applyStructuralChunk(db, { userId, proposalId: `tp-${planId}`, opIndex: 0, op: { kind: "retirePlan", planId } as never, progress, budget: 200, now: new Date(), prefs });
    if (r.status !== "more") return r.status;
    progress = r.progress as never;
  }
  return "unfinished";
}

const stateOf = async (workoutId: string, buildId: string) => {
  const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
  const [build] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, buildId));
  const unpushes = (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId))).filter((j) => j.kind === "coach_delete_workout");
  return { archived: row!.archivedAt !== null, completion: row!.completionState, content: row!.contentState, locked: build!.lockedAt !== null, unpushes: unpushes.length };
};

describe("archiveSlice: what lands between the slice's read and its batch", () => {
  it("a Start: the session isn't archived, no copy is taken off the watch, its build stays locked", async () => {
    const { workoutId, buildId, planId } = await sentUnderPlan();
    let landed = false;
    gates.batch = async () => {
      // (Before the fix the slice had already unsent the build here, so the Start itself was refused.)
      landed = await startSession(db, userId, workoutId, buildId, NOON).then(
        () => true,
        () => false,
      );
    };
    await retire(planId);
    expect(await stateOf(workoutId, buildId)).toEqual({ archived: false, completion: "scheduled", content: "started", locked: true, unpushes: 0 });
    expect(landed).toBe(true);
  });

  it("the watch's completion: the session isn't archived, its completion stands, no copy taken off", async () => {
    const { workoutId, buildId, planId } = await sentUnderPlan();
    gates.batch = async () => {
      // As the watch's match leaves the row: completed, its content as it was.
      await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, workoutId));
    };
    await retire(planId);
    const s = await stateOf(workoutId, buildId);
    expect(s).toMatchObject({ archived: false, completion: "completed", unpushes: 0 });
  });

  it("nothing landing: the slice archives it and takes its copy off, after the batch, as before", async () => {
    const { workoutId, buildId, planId } = await sentUnderPlan();
    expect(await retire(planId)).toBe("done");
    expect(await stateOf(workoutId, buildId)).toMatchObject({ archived: true, unpushes: 1 });
  });
});
