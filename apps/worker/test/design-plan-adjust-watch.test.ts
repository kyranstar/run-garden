/**
 * A DESIGNED PROPOSAL'S MOVE OF A SENT PROGRAMME SESSION (Stage 3 Task 8b; ruling I6, Option A; ruling 3-R13).
 *
 * The move's worst case: a programme session sent to the watch and verified there, moved to another day. The applier
 * is the thread coach's own (`applyOps` → `applyMove`), so its watch writes are exactly the thread coach's: the sent copy
 * is taken off (the unpush queued for the client to drain) and the slot goes back to an outline for its new day — never
 * a rewrite or a create. Its statements stay within the move's declared cost. A synthetic program and a mock COROS
 * server; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { approveDesignOps, PLAN_BATCH_FIXED, planOpCostOf } from "../src/services/design-approve.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { buildSession } from "../src/services/session-build.js";
import { sendToWatch, unpushJobId } from "../src/services/watch-push.js";
import type { PlanAdjustOp } from "../src/services/proposal-kinds.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { connectMock, DAY, makeEnv, NOON, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn, TOMORROW } from "./watch-push-fixture.js";

const { corosWriteJobs, coachProposals } = schema;
vi.setConfig({ testTimeout: 30_000 });

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let server: MockCorosServer;
let statements = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
  server = mockCorosServer({ baseMonday: "2026-10-05" });
  await connectMock(db, userId, server);
  vi.stubGlobal("fetch", server.fetchImpl);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });

describe("a designed proposal moves a programme session sent to the watch", () => {
  it("the applier takes the sent copy off for the client to drain, the slot is an outline for its new day — within the move's cost", async () => {
    const workoutId = await seedSlot(db, userId, programId, DAY);
    const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
    const buildId = built.build!.buildId;
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx());
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${buildId}`)))[0]!.status).toBe("verified");

    const runId = `run-${newId()}`;
    await db.insert(schema.coachRuns).values({
      id: runId, userId, parentId: null, role: "main", scope: { kind: "now" }, request: "Move today's strength to tomorrow.",
      status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOON, updatedAt: NOON,
    });
    const run: ToolContext["run"] = { id: runId, role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false };
    const res = await adjustPlan.run({ db, env: makeEnv(), userId, run, now: new Date(NOON), toolUseId: "toolu_move_sent" }, {
      workoutId,
      change: { kind: "move", toDate: TOMORROW },
      why: "Today is full.",
    });
    if (isToolErr(res)) throw new Error(res.why);
    const id = designProposalId(runId);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));

    statements = 0;
    const answer = await approveDesignOps(db, userId, p! as never, {}, ctx(), Number.POSITIVE_INFINITY);
    // Less the approve's own: the plan read, the proposal's write, the receipt.
    const batch = statements - 3;
    expect(answer).toMatchObject({ status: "approved", coachDrain: true });
    const row = await rowOf(db, workoutId);
    expect([row.effectiveDate, row.contentState]).toEqual([TOMORROW, "outline"]);
    const unpush = (await db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.id, unpushJobId(buildId)))))[0];
    expect(unpush).toMatchObject({ kind: "coach_delete_workout", status: "queued" });
    // Never a rewrite or a create of an app-built session's copy (ruling 3-R13).
    expect((await db.select().from(corosWriteJobs)).filter((j) => j.kind === "coach_update_workout" || j.kind === "coach_create_workout")).toEqual([]);
    // Tomorrow holds nothing else: the slot alone.
    expect(batch).toBeLessThanOrEqual(PLAN_BATCH_FIXED + planOpCostOf({ op: { kind: "move", workoutId, toDate: TOMORROW } } as PlanAdjustOp, 0));
  });
});
