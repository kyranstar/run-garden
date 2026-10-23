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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, newId, nowInstant, startOfIsoWeek, todayInZone, type CoachOp, type CoachSession, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { coachRoutes, sweepExpiredProposals } from "../src/routes/coach.js";
import { structuralStarted } from "../src/routes/thread-structural.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { STRUCTURAL_MIN_BUDGET } from "../src/services/coach-apply.js";

/** The budget every chunk call was handed, in order. */
const budgets: number[] = [];
/** Run after a chunk returns, inside the request — what lands between the chunk and the request's last write. */
const hooks: { afterChunk: (() => Promise<void>) | null } = { afterChunk: null };
vi.mock("../src/services/coach-apply.js", async (original) => {
  const m = await original<typeof import("../src/services/coach-apply.js")>();
  return {
    ...m,
    applyStructuralChunk: async (...args: Parameters<typeof m.applyStructuralChunk>) => {
      budgets.push(args[1].budget);
      const out = await m.applyStructuralChunk(...args);
      if (hooks.afterChunk) await hooks.afterChunk();
      return out;
    },
  };
});

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

const decline = async (id: string) => {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const res = await app.request(`/api/coach/proposals/${id}/decline`, { method: "POST", headers: { Cookie: cookie } }, makeEnv());
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

  it("a second structural op starts in a request only with the room a chunk needs", async () => {
    // A plan of ten sessions, every one on the watch: retiring it spends 36 of the request's 38 (its read, a slice
    // with ten unpushes, the status), and the new block waits for the next request.
    const seed = await proposal([createPlan(10)]);
    for (let i = 0; i < 5 && (await approve(seed)).json.remaining; i++);
    const planId = `cp-${seed}-0`;
    for (const [n, row] of (await planRows(planId)).entries()) {
      await db.update(schema.plannedWorkouts)
        .set({ sourceWorkoutId: `9000:${n + 1}`, sourceIdInPlan: String(n + 1), sourceProgramId: `77${n}`, lastVerifiedCorosDate: row.effectiveDate })
        .where(eq(schema.plannedWorkouts.id, row.id));
      await db.update(schema.corosWriteJobs).set({ status: "verified", verifiedAt: nowInstant() }).where(eq(schema.corosWriteJobs.id, `${row.id}-push`));
    }
    budgets.length = 0;
    const id = await proposal([{ kind: "retirePlan", planId }, createPlan(3)]);
    let last = await approve(id);
    for (let i = 0; i < 5 && last.json.remaining; i++) last = await approve(id);
    expect(last.json).toMatchObject({ summaries: ["Retired “Base block” and took 10 sessions off your plan", "Added “Base block” with 3 sessions"] });
    expect(budgets.length).toBeGreaterThan(1);
    for (const b of budgets) expect(b).toBeGreaterThanOrEqual(STRUCTURAL_MIN_BUDGET);
  });

  it("a plan that isn't there any more is said in the receipt, never a success for nothing", async () => {
    const id = await proposal([{ kind: "retirePlan", planId: "cp-gone" }]);
    const r = await approve(id);
    expect(r.status).toBe(200);
    expect((r.json.applied as { missed: string[] }).missed).toEqual(["that plan isn't there any more, so nothing was retired"]);
    expect(await receipts()).toEqual(["✓ approved — New block · that plan isn't there any more, so nothing was retired"]);
  });

  it("an approval that changes nothing says so — never \"✓ approved\" for nothing; one that changes something is approved (B6)", async () => {
    // The banner already settled the race days: nothing to resolve.
    const id = await proposal([{ kind: "resolveRaceConflict", keep: "settings" }]);
    const r = await approve(id);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, unchanged: true });
    expect(await receipts()).toEqual(["Nothing to change — New block: your race day and your plan already agree"]);
    // Beside a change that lands, the approval is an approval.
    await seedRow("w-skip", addDays(today, 2));
    const mixed = await proposal([{ kind: "skip", workoutId: "w-skip" }, { kind: "resolveRaceConflict", keep: "settings" }]);
    let res = await approve(mixed);
    for (let i = 0; i < 5 && res.json.remaining; i++) res = await approve(mixed);
    expect(res.json.unchanged).toBeUndefined();
    expect((await receipts()).at(-1)).toBe("✓ approved — New block");
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

  it("part-applied is a thread proposal's own mark: never a designed proposal's", () => {
    const progress = { step: "sessions", done: 3 };
    expect(structuralStarted([{ kind: "createPlan" }, { kind: "skip" }])).toBe(false);
    expect(structuralStarted([{ kind: "createPlan", progress }])).toBe(true);
    expect(structuralStarted([{ kind: "skip", progress: { step: "done", done: 0 } }, { kind: "createPlan" }])).toBe(true);
    expect(structuralStarted([{ kind: "plan_adjust", progress }])).toBe(false);
    expect(structuralStarted(null)).toBe(false);
  });

  it("finished days later, it leaves out the sessions whose days have passed — no row, no watch create (review-1 I2)", async () => {
    const id = await proposal([createPlan(40)]);
    expect((await approve(id)).json).toEqual({ ok: true, remaining: true });
    const added = ((await proposalRow(id)).ops as { progress: { done: number } }[])[0]!.progress.done;
    expect(added).toBeLessThan(13);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(`${addDays(monday, 13)}T20:00:00Z`));
      let last = await approve(id);
      for (let i = 0; i < 20 && last.json.remaining; i++) last = await approve(id);
      const passed = 13 - added;
      expect(last.json).toMatchObject({ summaries: [`Added “Base block” with ${40 - passed} sessions — ${passed} days had passed and were left out`] });
    } finally {
      vi.useRealTimers();
    }
    const rows = await planRows(`cp-${id}-0`);
    expect(rows.filter((r) => r.effectiveDate < addDays(monday, 13)).map((r) => r.id).sort()).toEqual(Array.from({ length: added }, (_, n) => `cw-${id}-0-${n}`).sort());
    const jobs = await db.select({ day: schema.corosWriteJobs.originalDate }).from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId));
    expect(jobs.filter((j) => j.day < addDays(monday, 13))).toHaveLength(added);
  });

  it("one not begun is expired as before", async () => {
    const id = await proposal([createPlan(3)], addDays(today, -1));
    expect(await approve(id)).toEqual({ status: 409, json: { error: "not_pending", status: "expired" } });
    expect(await planRows(`cp-${id}-0`)).toHaveLength(0);
  });

  it("a decline between two chunks is refused: the plan is being added, and the next approve finishes it (review-1)", async () => {
    const id = await proposal([createPlan(40)]);
    await approve(id);
    const added = (await planRows(`cp-${id}-0`)).length;
    expect(await decline(id)).toEqual({ status: 409, json: { error: "in_flight", status: "pending" } });
    expect((await proposalRow(id)).status).toBe("pending");
    expect(await receipts()).toEqual([]);
    expect(await planRows(`cp-${id}-0`)).toHaveLength(added);
    let last = await approve(id);
    for (let i = 0; i < 20 && last.json.remaining; i++) last = await approve(id);
    expect((await proposalRow(id)).status).toBe("approved");
    expect(await planRows(`cp-${id}-0`)).toHaveLength(40);
  });

  it("a decline that lands while the approve's request runs wins: no approved over it, no ✓ receipt (review-1)", async () => {
    const id = await proposal([createPlan(5)]);
    hooks.afterChunk = async () => {
      await db.update(schema.coachProposals).set({ status: "declined", resolvedAt: nowInstant() }).where(eq(schema.coachProposals.id, id));
    };
    try {
      const r = await approve(id);
      expect(r).toEqual({ status: 409, json: { error: "not_pending", status: "declined" } });
    } finally {
      hooks.afterChunk = null;
    }
    expect((await proposalRow(id)).status).toBe("declined");
    expect(await receipts()).toEqual([]);
  });

  it("a decline of a thread proposal not begun still declines it", async () => {
    const id = await proposal([createPlan(5)]);
    expect(await decline(id)).toEqual({ status: 200, json: { ok: true } });
    expect((await proposalRow(id)).status).toBe("declined");
  });
});
