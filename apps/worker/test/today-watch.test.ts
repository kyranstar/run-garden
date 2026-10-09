/**
 * TODAY AND THE WATCH (Phase 3 Tasks 8 and 9; approved mocks §2 "Today · a sent session", §3 "Log your session").
 *
 *  - `todaySessions[].onWatch`: the session's sent build is on the watch — its push verified and the row holding the
 *    copy's address. Today marks it "On your watch". Never while the switch is off.
 *  - The request stays inside the Workers Free budget (ruling 3-R11: ≤ 45 D1 statements + COROS fetches): counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { sendToWatch, takeOffWatch } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { buildToday, DAY, makeEnv, NOON, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts } = schema;

vi.setConfig({ testTimeout: 30_000 });

/** The ceiling: D1 statements + COROS fetches in one invocation (ruling 3-R11). */
const BUDGET = 45;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let statements = 0;
const sqls: string[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => {
      statements += 1;
      sqls.push(q);
    },
  });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
});
afterEach(() => {
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });

type TodayBody = {
  todaySessions: Array<{ workout: { id: string }; onWatch?: boolean }>;
};

async function getToday(env: Env = switchOn()): Promise<{ body: TodayBody; d1: number }> {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  statements = 0;
  const res = await mountRoutes(db, "/api/plan", planRoutes).request("/api/plan/today", { headers: { Cookie: cookie } }, env);
  const d1 = statements;
  expect(res.status).toBe(200);
  return { body: (await res.json()) as TodayBody, d1 };
}

const onWatchOf = (body: TodayBody, id: string) => body.todaySessions.find((s) => s.workout.id === id)?.onWatch ?? false;

/** A slot built today and sent: its push queued, its build locked. */
async function sentSlot(id?: string): Promise<{ workoutId: string; buildId: string }> {
  const workoutId = await seedSlot(db, userId, programId, DAY, id);
  const built = await buildToday(db, userId, prefs, workoutId);
  const buildId = built.build!.buildId;
  await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
  return { workoutId, buildId };
}

/** The push verified, the row holding the copy's address — as the lane leaves it. */
async function landed(workoutId: string, buildId: string, idInPlan = "7"): Promise<void> {
  await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON, completedAt: NOON }).where(eq(corosWriteJobs.id, `push:${buildId}`));
  await db
    .update(plannedWorkouts)
    .set({ sourceWorkoutId: `4242:${idInPlan}`, sourceIdInPlan: idInPlan, sourceProgramId: "991", lastVerifiedCorosDate: DAY, corosSyncState: "synced" })
    .where(eq(plannedWorkouts.id, workoutId));
}

describe("GET /today — onWatch (Task 8)", () => {
  it("a sent build whose push verified, the row holding the address: on the watch", async () => {
    const { workoutId, buildId } = await sentSlot();
    expect(onWatchOf((await getToday()).body, workoutId)).toBe(false); // queued: not on the watch yet
    await landed(workoutId, buildId);
    const { body, d1 } = await getToday();
    expect(onWatchOf(body, workoutId)).toBe(true);
    console.info(`[budget] GET /today with a sent session: ${d1} D1 + 0 COROS = ${d1}`);
    expect(d1).toBeLessThanOrEqual(BUDGET);
  });

  it("never while the switch is off — nothing about the watch on Today", async () => {
    const { workoutId, buildId } = await sentSlot();
    await landed(workoutId, buildId);
    const { body } = await getToday(makeEnv());
    expect(body.todaySessions.find((s) => s.workout.id === workoutId)).not.toHaveProperty("onWatch", true);
  });

  it("removed in COROS (the address cleared), or taken off (the build unlocked): not on the watch", async () => {
    const a = await sentSlot();
    await landed(a.workoutId, a.buildId);
    await db.update(plannedWorkouts).set({ lastVerifiedCorosDate: "", corosSyncState: "calendar_only" }).where(eq(plannedWorkouts.id, a.workoutId));
    expect(onWatchOf((await getToday()).body, a.workoutId)).toBe(false);

    const b = await sentSlot(`${a.workoutId}-b`);
    await landed(b.workoutId, b.buildId, "8");
    expect(onWatchOf((await getToday()).body, b.workoutId)).toBe(true);
    await takeOffWatch(db, userId, b.workoutId, ctx());
    expect(onWatchOf((await getToday()).body, b.workoutId)).toBe(false);
  });

  it("a day with no sent session costs nothing more: no extra read of the jobs, switch on or off", async () => {
    const workoutId = await seedSlot(db, userId, programId, DAY);
    await buildToday(db, userId, prefs, workoutId);
    const jobReads = async (env: Env) => {
      sqls.length = 0;
      const { d1 } = await getToday(env);
      return { jobs: sqls.filter((q) => q.includes('from "coros_write_jobs"')).length, d1 };
    };
    expect(await jobReads(switchOn())).toEqual(await jobReads(makeEnv()));
  });
});
