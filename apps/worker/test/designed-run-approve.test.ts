/**
 * APPROVING A DESIGNED RUN (§8 §3): the approve's run branch writes the coach-lane row — its columns from the
 * document and the steps on the watch, its stage rows with their bands, the document at revision 1 — and, COROS writes
 * on, queues its watch create and says the client has a job to drain. Then the drain: the mock COROS holds the run with
 * its pace bytes. Every request within 45 statements, measured on a busy account. Synthetic data; the mock server only.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, parseStoredWorkoutDoc, todayInZone, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes } from "../src/routes/coach.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { APPROVE_FIXED, opCostOf, REQUEST_BUDGET, type DesignedOp } from "../src/services/design-approve.js";
import { designProposalId, proposeWorkout, type DocWorkoutTarget } from "../src/services/design-tools/propose.js";
import { isToolErr, type OpReview, type ToolContext } from "../src/services/design-tools/types.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { coachProposals, plannedWorkouts, plannedWorkoutStages, corosWriteJobs, workoutDocRevisions } = schema;
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s", TOKEN_ENCRYPTION_KEY: TEST_KEY, ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c",
    COACH_DESIGNER: "1",
  } as Env;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let cookie: string;
let statements = 0;
let fetches = 0;

/** 10 min easy · 3 × (8 min tempo / 2 min jog) · 10 min easy: fifty minutes. */
const tempo = (over: Partial<WorkoutDoc> = {}): WorkoutDoc => ({
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks to lift the threshold.", goals: ["speed"], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 }, why: "Ease in." }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [
      { kind: "run", effort: "tempo", target: { durationSec: 480 }, why: "Comfortably hard." },
      { kind: "run", effort: "recovery", target: { durationSec: 120 }, why: "Jog it back." },
    ] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 }, why: "Settle." }] },
  ],
  source: { kind: "coach" },
  ...over,
});

async function setup(o: { writes?: boolean } = {}) {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: o.writes ?? true }));
  today = todayInZone(prefs.timezone);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  // A busy fortnight: an easy run every morning, a second one every third day.
  for (let i = 0; i < 14; i++) {
    const date = addDays(today, i);
    for (const slot of i % 3 === 0 ? ["07:00", "18:00"] : ["07:00"]) {
      const id = `w-${i}-${slot}`;
      await db.insert(plannedWorkouts).values({
        id, userId, planId: "plan-1", sourceWorkoutId: id, title: "Easy run", category: "easy", sport: "run", originalPlanDate: date,
        lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: slot, sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800,
        fallbackEstimatedDurationSeconds: 1800, createdAt: nowInstant(), updatedAt: nowInstant(),
      });
    }
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
});
afterEach(() => vi.unstubAllGlobals());

const REVIEW: OpReview = { scores: { intent: 4, structure: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] };

async function designed(doc: WorkoutDoc, target: DocWorkoutTarget): Promise<{ id: string; opId: string }> {
  const id = `run-${newId()}`;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "A tempo run", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  const ctx: ToolContext = { db, env: makeEnv(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
  const res = await proposeWorkout.run(ctx, { doc, target });
  if (isToolErr(res)) throw new Error(`propose refused: ${res.error} — ${res.why}`);
  const pid = designProposalId(id);
  const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, pid));
  await db.update(coachProposals).set({ status: "pending", ops: (p!.ops as DesignedOp[]).map((x) => ({ ...x, review: REVIEW })) }).where(eq(coachProposals.id, pid));
  return { id: pid, opId: id };
}

async function invoke(path: string, body: unknown = {}) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await app.request(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }, makeEnv(), executionCtx as never);
  await Promise.all(pending);
  return { status: res.status, json: (await res.json()) as Record<string, any>, total: statements + fetches };
}

async function threshold(v: number) {
  await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: addDays(today, -2), thresholdPaceSecPerKm: v, contentFingerprint: "h", updatedAt: nowInstant() });
}

describe("approving a designed run", () => {
  it("writes the coach-lane row, its stages with their bands, its document, and queues its watch create — within 45", async () => {
    await setup();
    await threshold(289);
    const date = addDays(today, 2);
    const { id, opId } = await designed(tempo(), { kind: "new", date });
    const res = await invoke(`/api/coach/proposals/${id}/approve`);
    expect(res.status).toBe(200);
    expect(res.json.applied).toHaveLength(1);
    expect(res.json.coachDrain).toBe(true);
    // Its own declared cost holds, and the request is within the budget.
    const [op] = (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!.ops as DesignedOp[];
    expect(res.total).toBeLessThanOrEqual(APPROVE_FIXED + opCostOf(op!, 1));
    expect(res.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    // Pinned: 23 measured (the approve's own, the run's create — its five stage rows in one insert, the day's collision
    // pass, its watch job — and the calendar's step in the room left), against 30 declared.
    expect(res.total).toBe(23);
    expect(APPROVE_FIXED + opCostOf(op!, 1)).toBe(30);

    const workoutId = res.json.applied[0].workout.id as string;
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    expect(row).toMatchObject({
      origin: null, sport: "run", category: "quality", qualitySubtype: "tempo", title: "Tempo blocks", effectiveDate: date,
      fallbackEstimatedDurationSeconds: 3000, calendarBlockDurationSeconds: 3000, corosSyncState: "calendar_only", workoutDocRev: 1,
      stageSummary: "10 min easy · 3 × 8 min tempo / 2 min recovery · 10 min easy",
    });
    // Each timed step at its band's middle: easy 379, tempo 306.5, the jog 409 s/km.
    expect(row!.expectedDistanceMeters).toBe(Math.round((1200 / 379 + 3 * (480 / 306.5 + 120 / 409)) * 1000));
    const doc = parseStoredWorkoutDoc(row!.workoutDoc)!;
    expect(doc.basedOn).toEqual({ kind: "proposal", id, opId });
    // The document keeps what was authored: no computed pace in it.
    expect(JSON.stringify(doc)).not.toContain("fastSecPerKm");
    const [rev] = await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, workoutId));
    expect(rev).toMatchObject({ rev: 1, sourceKind: "coach" });

    const stages = await db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, workoutId)).orderBy(asc(plannedWorkoutStages.ord));
    expect(stages.map((s) => [s.kind, s.repeatCount, s.durationSeconds, s.targetLow, s.targetHigh, s.label])).toEqual([
      ["warmup", null, 600, 349, 409, "easy"],
      ["repeat", 3, null, null, null, null],
      ["work", null, 480, 299, 314, "tempo"],
      ["recovery", null, 120, null, null, "recovery"],
      ["cooldown", null, 600, 349, 409, "easy"],
    ]);
    expect(stages[2]!.parentStageId).toBe(stages[1]!.id);

    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "coach_create_workout", status: "queued", id: `${workoutId}-push` });
    expect((jobs[0]!.payload as { session: { kind: string } }).session.kind).toBe("run_watch");
    expect((jobs[0]!.payload as { thresholdPaceSecPerKm?: number }).thresholdPaceSecPerKm).toBe(289);
  });

  it("then the drain: the mock COROS holds the run with its pace bytes", async () => {
    await setup();
    await threshold(289);
    const server = mockCorosServer();
    const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
    expect((await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
    const { id } = await designed(tempo(), { kind: "new", date: addDays(today, 3) });
    const res = await invoke(`/api/coach/proposals/${id}/approve`);
    const workoutId = res.json.applied[0].workout.id as string;
    await executeCloudJobs(db, makeEnv(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId));
    expect(row!.corosSyncState).toBe("synced");
    const program = server.programByIdInPlan(row!.sourceIdInPlan!)!;
    const steps = program.exercises!.map((e) => e as unknown as Record<string, unknown>);
    expect(steps.map((s) => s.exerciseType)).toEqual([1, 2, 4, 2, 4, 2, 4, 3]);
    expect(steps[1]).toMatchObject({ targetType: 2, targetValue: 480, intensityType: 3, intensityValue: 299_000, intensityValueExtend: 314_000, intensityMultiplier: 1000 });
    expect(program.name).toMatch(/^Tempo blocks/);
  });

  it("with COROS writes off: the row, no watch job, nothing to drain", async () => {
    await setup({ writes: false });
    const { id } = await designed(tempo(), { kind: "new", date: addDays(today, 2) });
    const res = await invoke(`/api/coach/proposals/${id}/approve`);
    expect(res.json.applied).toHaveLength(1);
    expect(res.json.coachDrain).toBeUndefined();
    expect(await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId))).toEqual([]);
  });

  it("a time asked for is pinned; approving again writes nothing twice", async () => {
    await setup();
    await threshold(289);
    const date = addDays(today, 4);
    const { id } = await designed(tempo(), { kind: "new", date, time: "17:30" });
    const first = await invoke(`/api/coach/proposals/${id}/approve`);
    expect(first.json.applied[0].workout).toMatchObject({ date, time: "17:30" });
    const workoutId = first.json.applied[0].workout.id as string;
    const pins = await db.select().from(schema.scheduleOverrides).where(and(eq(schema.scheduleOverrides.workoutId, workoutId), eq(schema.scheduleOverrides.kind, "time_change")));
    expect(pins).toHaveLength(1);
    const again = await invoke(`/api/coach/proposals/${id}/approve`);
    expect(again.status).toBe(200);
    expect(await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, workoutId))).toHaveLength(1);
    expect(await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId))).toHaveLength(1);
  });

  it("no threshold and a distance: the row with its warning, and it stays off the watch", async () => {
    await setup();
    const doc = tempo();
    doc.parts[2] = { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { distanceM: 2000 }, why: "Settle." }] };
    const { id } = await designed(doc, { kind: "new", date: addDays(today, 2) });
    const res = await invoke(`/api/coach/proposals/${id}/approve`);
    expect(res.json.applied).toHaveLength(1);
    expect((res.json.applied[0].warnings as Array<{ code: string }>).map((w) => w.code)).toContain("run_pace_owed");
    expect(await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId))).toEqual([]);
  });
});
