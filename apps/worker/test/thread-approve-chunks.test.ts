/**
 * A THREAD PROPOSAL THAT SHAPES A PLAN, APPROVED A CHUNK A REQUEST (§8 §4; routes/thread-structural.ts).
 *
 * In order, op by op: a structural op a chunk at a time, the thread's other ops a run at a time through the applier
 * they always went through; `remaining` until done; one receipt, on the request that finishes. A plan part-applied is
 * the athlete's already: its next approve finishes it whatever the date, and the expiry sweep leaves it alone. The
 * thread coach's switch is off here (§8 §6): its old proposals stay approvable.
 *
 * Synthetic fixtures only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, newId, nowInstant, startOfIsoWeek, todayInZone, type CoachOp, type CoachSession, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { coachRoutes, sweepExpiredProposals } from "../src/routes/coach.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: "k",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let today: string;
let monday: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  today = todayInZone(prefs.timezone);
  monday = addDays(startOfIsoWeek(today), 7);
});

const approve = async (id: string) => {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const res = await app.request(`/api/coach/proposals/${id}/approve`, { method: "POST", headers: { Cookie: cookie } }, makeEnv());
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const run = (title: string, minutes = 40): CoachSession => ({
  category: "easy",
  title,
  durationMinutes: minutes,
  run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] },
});
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), session: run(`Easy ${i}`, 30 + i) }));

async function proposal(ops: CoachOp[], expiresAt = addDays(today, 20)): Promise<string> {
  const id = newId();
  await db.insert(schema.coachProposals).values({
    id, userId, title: "New block", evidence: "e", rationale: "r", flags: [], ops: ops.map((o) => coachOpSchema.parse(o)), status: "pending", createdAt: nowInstant(), expiresAt,
  });
  return id;
}

async function seedRow(id: string, date: string) {
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId: "p", sourceWorkoutId: id, title: "Tempo", category: "quality", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date,
    effectiveDate: date, effectiveTime: "07:00", completionState: "scheduled", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(), updatedAt: nowInstant(),
  });
}

const receipts = async () =>
  (await db.select().from(schema.coachMessages).where(eq(schema.coachMessages.userId, userId))).filter((m) => m.role === "receipt").map((m) => m.body);
const proposalRow = async (id: string) => (await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id)))[0]!;
const planRows = async (planId: string) => db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.planId, planId));

const createPlan = (n: number): CoachOp => ({ kind: "createPlan", discipline: "run", name: "Base block", startDate: monday, endDate: addDays(monday, 69), firmSessions: days(monday, n), shapeWeeks: [] });

describe("a structural thread approve, a chunk a request", () => {
  it("answers `remaining` while a plan is being added, pending with where it got to; the request that finishes approves it and says so once", async () => {
    const id = await proposal([createPlan(40)]);
    const first = await approve(id);
    expect(first).toEqual({ status: 200, json: { ok: true, remaining: true } });
    const mid = await proposalRow(id);
    expect(mid.status).toBe("pending");
    expect((mid.ops as { progress?: { step: string } }[])[0]!.progress?.step).toBe("sessions");
    expect((await planRows(`cp-${id}-0`)).length).toBeGreaterThan(0);
    expect(await receipts()).toEqual([]);
    let last = first;
    for (let i = 0; i < 20 && last.json.remaining; i++) last = await approve(id);
    expect(last.json).toMatchObject({ ok: true, summaries: ["Added “Base block” with 40 sessions"] });
    expect(last.json.remaining).toBeUndefined();
    expect((await proposalRow(id)).status).toBe("approved");
    expect(await planRows(`cp-${id}-0`)).toHaveLength(40);
    expect(await receipts()).toEqual(["✓ approved — New block"]);
    // A tap after it finished is the first tap's answer, as ever.
    expect(await approve(id)).toEqual({ status: 409, json: { error: "not_pending", status: "approved" } });
  });

  it("applies the thread's other ops in order, between the plan's chunks — each in a request of its own", async () => {
    await seedRow("w1", addDays(today, 2));
    await seedRow("w2", addDays(today, 3));
    const id = await proposal([{ kind: "skip", workoutId: "w1" }, createPlan(5), { kind: "skip", workoutId: "w2" }]);
    const first = await approve(id);
    expect(first.json).toEqual({ ok: true, remaining: true });
    const w1 = (await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1")))[0]!;
    expect(w1.completionState).toBe("skipped");
    expect(await planRows(`cp-${id}-1`)).toHaveLength(0);
    const second = await approve(id);
    expect(second.json).toEqual({ ok: true, remaining: true });
    expect(await planRows(`cp-${id}-1`)).toHaveLength(5);
    const w2 = (await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w2")))[0]!;
    expect(w2.completionState).toBe("scheduled");
    const third = await approve(id);
    expect(third.json).toMatchObject({ ok: true, summaries: ["Added “Base block” with 5 sessions"] });
    expect((await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w2")))[0]!.completionState).toBe("skipped");
    // Each run's before-state kept: the second never overwrote the first's.
    expect(Object.keys((await proposalRow(id)).appliedRefs ?? {}).sort()).toEqual(["w1", "w2"]);
    expect(await receipts()).toEqual(["✓ approved — New block"]);
  });

  it("a plan that isn't there any more is said in the receipt, never a success for nothing", async () => {
    const id = await proposal([{ kind: "retirePlan", planId: "cp-gone" }]);
    const r = await approve(id);
    expect(r.status).toBe(200);
    expect((r.json.applied as { missed: string[] }).missed).toEqual(["that plan isn't there any more, so nothing was retired"]);
    expect(await receipts()).toEqual(["✓ approved — New block · that plan isn't there any more, so nothing was retired"]);
  });

  it("a plan part-applied is never expired: the sweep leaves it, and its next approve finishes it whatever the date", async () => {
    const id = await proposal([createPlan(40)]);
    expect((await approve(id)).json).toEqual({ ok: true, remaining: true });
    await db.update(schema.coachProposals).set({ expiresAt: addDays(today, -2) }).where(eq(schema.coachProposals.id, id));
    expect(await sweepExpiredProposals(db, userId, today)).toBe(0);
    expect((await proposalRow(id)).status).toBe("pending");
    let last = await approve(id);
    for (let i = 0; i < 20 && last.json.remaining; i++) last = await approve(id);
    expect(last.status).toBe(200);
    expect((await proposalRow(id)).status).toBe("approved");
    expect(await planRows(`cp-${id}-0`)).toHaveLength(40);
  });

  it("one not begun is expired as before", async () => {
    const id = await proposal([createPlan(3)], addDays(today, -1));
    expect(await approve(id)).toEqual({ status: 409, json: { error: "not_pending", status: "expired" } });
    expect(await planRows(`cp-${id}-0`)).toHaveLength(0);
  });

  it("a decline between two chunks stands: the next approve is refused, and what was added stays whole", async () => {
    const id = await proposal([createPlan(40)]);
    await approve(id);
    const added = (await planRows(`cp-${id}-0`)).length;
    await db.update(schema.coachProposals).set({ status: "declined" }).where(eq(schema.coachProposals.id, id));
    expect(await approve(id)).toEqual({ status: 409, json: { error: "not_pending", status: "declined" } });
    expect(await planRows(`cp-${id}-0`)).toHaveLength(added);
  });
});
