/**
 * A STRUCTURED RUN'S LENGTH, PROPOSED AND APPROVED (the owner's decision, 2026-10-20). The main coach's adjust_plan
 * re-times a structured run by the rule when it proposes the length (adjust-retime.ts `retimeOfRow`): the card says the
 * new structure ("Tempo 35 → 25 min · 3 × 5 min (was 5 × 5)"), the op keeps it (`retime`), the rule's refusals come back
 * in its words; the approve declares its cost from it (RETIME_COST and its stage inserts) and the applier re-times the
 * run only when it finds the same — the watch's rewrite queued. A taper of twelve structured runs on the watch splits
 * across requests, every one within 45 statements. Measured on the routes as design-plan-adjust-routes.test.ts measures:
 * every D1 statement and fetch, a busy account, D1's bind cap on. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes } from "../src/routes/coach.js";
import {
  ADJUST_COST,
  ADJUST_RECLAIM_COST,
  APPROVE_FIXED,
  opCostOf,
  PLAN_BATCH_FIXED,
  planOpCostOf,
  REQUEST_BUDGET,
  RETIME_COST,
} from "../src/services/design-approve.js";
import { adjustPlan, MAX_CHANGES } from "../src/services/design-tools/adjust-plan.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { describeChange, planAdjustId, type PlanAdjustOp } from "../src/services/proposal-kinds.js";
import { makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";

const { coachProposals, plannedWorkouts, plannedWorkoutStages, corosWriteJobs } = schema;

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s", TOKEN_ENCRYPTION_KEY: "k", ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c",
    AI_GATEWAY_API_KEY: "test-key", COACH_DESIGNER: "1",
  } as Env;
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let cookie: string;
let statements = 0;
let fetches = 0;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  today = todayInZone(prefs.timezone);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
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
});

afterEach(() => vi.unstubAllGlobals());

/**
 * A thread-coach tempo on the plan, on the watch: 5 min easy · 5 × 5 min threshold · 5 min easy, its stage rows the
 * coach's blocks, at a COROS address its verified create stamped (a name of its own: the rewrite reads the day's stamps).
 */
async function tempoOnTheWatch(id: string, day: number, o: { watch?: boolean } = {}): Promise<void> {
  const date = addDays(today, day);
  const watch = o.watch ?? true;
  await db.insert(plannedWorkouts).values({
    id, userId, planId: "coach-plan", sourceWorkoutId: watch ? `123:${day}` : id, sourceIdInPlan: watch ? String(day) : null, sourceProgramId: watch ? `9${day}` : null,
    title: "Tempo", category: "quality", qualitySubtype: "tempo", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: watch ? date : "",
    effectiveDate: date, effectiveTime: "12:00", sourceContentFingerprint: "0123456789abcdef", calendarBlockDurationSeconds: 2100,
    fallbackEstimatedDurationSeconds: 2100, corosSyncState: watch ? "synced" : "calendar_only", createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  const blocks = [["warmup", "easy"], ...Array.from({ length: 5 }, () => ["work", "threshold"]), ["cooldown", "easy"]] as const;
  await db.insert(plannedWorkoutStages).values(
    blocks.map(([kind, label], i) => ({ id: `${id}:${i}`, workoutId: id, parentStageId: null, ord: i, kind, repeatCount: null, durationType: "time", durationSeconds: 300, distanceMeters: null, label })),
  );
  if (watch) {
    await db.insert(corosWriteJobs).values({
      id: `${id}-push`, userId, workoutId: id, kind: "coach_create_workout", expectedContentFingerprint: "x", originalDate: date, destinationDate: date,
      requestedAt: nowInstant(), status: "verified", verifiedAt: nowInstant(), updatedAt: nowInstant(), payload: { workoutId: id, happenDay: date, name: `Tempo ~ ${id}` },
    });
  }
}

async function mainRun(): Promise<ToolContext["run"]> {
  const id = `run-${newId()}`;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "week" }, request: null, status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  return { id, role: "main", scope: { kind: "week" }, parentId: null, rehearsal: false };
}
const ctxOf = (r: ToolContext["run"]): ToolContext => ({ db, env: makeEnv(), userId, run: r, now: new Date(), toolUseId: `toolu_${newId()}` });
async function adjust(r: ToolContext["run"], workoutId: string, minutes: number) {
  statements = 0;
  const res = await adjustPlan.run(ctxOf(r), { workoutId, change: { kind: "adjust", durationMinutes: minutes }, why: "A lighter week." });
  return { res, count: statements };
}
const ok = (res: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(res)) throw new Error(`refused: ${res.error} — ${res.why}`);
  return res;
};
const refused = (res: ToolOk | ToolErr): ToolErr => {
  if (!isToolErr(res)) throw new Error(`not refused: ${JSON.stringify(res.data)}`);
  return res;
};
const opsOf = async (r: ToolContext["run"]) => (await db.select().from(coachProposals).where(eq(coachProposals.id, designProposalId(r.id))))[0]!.ops as PlanAdjustOp[];
const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;

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

/** A proposal of these changes, with the athlete. */
async function pending(r: ToolContext["run"], ops?: PlanAdjustOp[]): Promise<string> {
  const id = designProposalId(r.id);
  await db.update(coachProposals).set({ status: "pending", ...(ops ? { ops } : {}) }).where(eq(coachProposals.id, id));
  return id;
}

describe("adjust_plan: the card says the new structure, and the op keeps it", () => {
  it("a structured run's length: re-timed by the rule — 'Tempo 35 → 25 min · 3 × 5 min (was 5 × 5)', no 'watch unchanged' — still two statements", async () => {
    await tempoOnTheWatch("t-1", 2);
    const r = await mainRun();
    const { res, count } = await adjust(r, "t-1", 25);
    const data = ok(res).data as { change: { summary: { text: string }; was: string | null }; issues: unknown[] };
    expect(data.change.summary.text).toBe("Tempo 35 → 25 min · 3 × 5 min (was 5 × 5)");
    expect(data.change.was).toBeNull();
    expect(data.issues).toEqual([]);
    expect(count).toBe(2);
    const [op] = await opsOf(r);
    expect(op!.retime).toMatchObject({ minutes: 25, summary: "3 × 5 min (was 5 × 5)", stageRows: 5, stageInserts: 1 });
    expect(describeChange(op!).summary).toBe("Tempo 35 → 25 min · 3 × 5 min (was 5 × 5)");
  });

  it("the rule's minutes, which the counts may leave off the coach's: asked 27, the nearest count makes 25", async () => {
    await tempoOnTheWatch("t-1", 2);
    const r = await mainRun();
    ok((await adjust(r, "t-1", 27)).res);
    const [op] = await opsOf(r);
    expect([op!.op, op!.retime?.minutes]).toEqual([{ kind: "adjust", workoutId: "t-1", durationMinutes: 27 }, 25]);
  });

  it("too short for a warm-up, a cool-down and one rep: refused in the rule's words, telling the coach to ease — nothing written", async () => {
    await tempoOnTheWatch("t-1", 2);
    const r = await mainRun();
    const err = refused((await adjust(r, "t-1", 9)).res);
    expect(err.error).toBe("too_short");
    expect(err.why).toContain("too short to keep its warm-up, cool-down and one rep");
    expect(err.why).toContain("ease");
    expect(await db.select().from(coachProposals)).toEqual([]);
  });

  it("a length its reps come no nearer: no change, said", async () => {
    // 5 + 2 × 5 + 5 = 20 → 22: a third rep makes 25, further off than 20 — and there is no block to extend.
    await tempoOnTheWatch("t-1", 2);
    await db.delete(plannedWorkoutStages).where(inArray(plannedWorkoutStages.id, ["t-1:3", "t-1:4", "t-1:5"]));
    await db.update(plannedWorkouts).set({ fallbackEstimatedDurationSeconds: 1200 }).where(eq(plannedWorkouts.id, "t-1"));
    const r = await mainRun();
    const err = refused((await adjust(r, "t-1", 22)).res);
    expect(err.error).toBe("no_change");
    expect(err.why).toContain("stays 20 min");
  });

  it("an unstructured run (no stages) keeps the length alone: the card as before, 'watch unchanged' when it is on the watch, no retime", async () => {
    await tempoOnTheWatch("t-1", 2);
    await db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, "t-1"));
    const r = await mainRun();
    const data = ok((await adjust(r, "t-1", 25)).res).data as { change: { summary: { text: string }; was: string | null }; issues: Array<{ code: string }> };
    expect(data.change.summary.text).toBe("Tempo — 25 min · watch unchanged");
    expect(data.change.was).toBe("35 min");
    expect(data.issues.map((i) => i.code)).toEqual(["watch_unchanged"]);
    expect((await opsOf(r))[0]!.retime).toBeNull();
  });
});

describe("the approve: declared from the card, applied when the rule finds it again", () => {
  it("a re-timed length costs RETIME_COST and its stage inserts; a length alone ADJUST_COST (and the reclaim's on a marked row)", () => {
    expect(RETIME_COST).toBe(12);
    const op = { kind: "adjust", workoutId: "w", durationMinutes: 25 } as const;
    const card = { minutes: 25, summary: "3 × 5 min (was 5 × 5)", stageSummary: "s", stageRows: 12, stageInserts: 3 };
    expect(planOpCostOf({ op, retime: card }, 2)).toBe(RETIME_COST + 3 + 2);
    // A marked row's reclaim is inside the re-time's own (the mark lifts in its row write).
    expect(planOpCostOf({ op, retime: card }, 2, true)).toBe(RETIME_COST + 3 + 2);
    expect(planOpCostOf({ op, retime: null }, 2)).toBe(ADJUST_COST + 2);
    expect(planOpCostOf({ op }, 2, true)).toBe(ADJUST_COST + 2 + ADJUST_RECLAIM_COST);
  });

  it("applies the card's re-time: the stages, the length, the rewrite queued — within what it declared; asked again, made, nothing written", async () => {
    await tempoOnTheWatch("t-1", 2);
    const r = await mainRun();
    // Asked 27: the rule's 25 is what is made — and what "made" is judged by when asked again.
    ok((await adjust(r, "t-1", 27)).res);
    const id = await pending(r);
    const [op] = await opsOf(r);
    const res = await invoke(`/api/coach/proposals/${id}/approve`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "approved", coachDrain: true });
    expect(res.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId("t-1")]);
    expect(res.total).toBeLessThanOrEqual(APPROVE_FIXED + PLAN_BATCH_FIXED + opCostOf(op!, 2 + 1));
    const row = await rowOf("t-1");
    expect([row.fallbackEstimatedDurationSeconds, row.stageSummary]).toEqual([1500, op!.retime!.stageSummary]);
    expect((await db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, "t-1"))).length).toBe(5);
    const update = (await db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, "t-1"), eq(corosWriteJobs.kind, "coach_update_workout"))))[0]!;
    expect(update.status).toBe("queued");
    expect((update.payload as { session: { run: { blocks: unknown[] } } }).session.run.blocks).toHaveLength(5);
    // Asked again: made (its length and its steps the card's) — the applier never runs.
    await db.update(coachProposals).set({ status: "pending", ops: (await opsOf(r)).map((o) => ({ ...o, outcome: undefined })) }).where(eq(coachProposals.id, id));
    const again = await invoke(`/api/coach/proposals/${id}/approve`);
    expect(again.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId("t-1")]);
    expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.kind, "coach_update_workout"))).length).toBe(1);
  });

  it("a row already stating the rule's length, its steps not yet re-timed, is not 'made': its steps are", async () => {
    // It says 25 minutes; its steps are 35 (5 + 5 × 5 + 5). Asked 26, the rule makes 25 — the length it already says.
    await tempoOnTheWatch("t-1", 2);
    await db.update(plannedWorkouts).set({ fallbackEstimatedDurationSeconds: 1500 }).where(eq(plannedWorkouts.id, "t-1"));
    const r = await mainRun();
    ok((await adjust(r, "t-1", 26)).res);
    expect((await opsOf(r))[0]!.retime?.minutes).toBe(25);
    const id = await pending(r);
    const res = await invoke(`/api/coach/proposals/${id}/approve`);
    expect(res.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId("t-1")]);
    expect((await db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, "t-1"))).length).toBe(5);
  });

  it("a run changed since the card (its steps rewritten): refused with why — nothing written", async () => {
    await tempoOnTheWatch("t-1", 2);
    const r = await mainRun();
    ok((await adjust(r, "t-1", 25)).res);
    const id = await pending(r);
    // An import replaced its steps meanwhile: 6 × 5 now.
    await db.insert(plannedWorkoutStages).values({ id: "t-1:9", workoutId: "t-1", parentStageId: null, ord: 3, kind: "work", repeatCount: null, durationType: "time", durationSeconds: 300, distanceMeters: null, label: "threshold" });
    const before = await rowOf("t-1");
    const res = await invoke(`/api/coach/proposals/${id}/approve`);
    expect(res.json.refused).toEqual([{ opId: planAdjustId("t-1"), error: "not_editable", cause: "unknown", why: "A session it re-times has changed since it was suggested, so it is as it was." }]);
    expect(await rowOf("t-1")).toEqual(before);
    expect(await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.kind, "coach_update_workout"))).toEqual([]);
  });

  it(`a taper of twelve structured runs on the watch splits across requests, every one within ${REQUEST_BUDGET} — each re-timed, each rewrite queued`, async () => {
    // A proposal holds at most MAX_CHANGES (10) of adjust_plan's; twelve — two more, as a second run's — is past the
    // approve's plan read (10 ops) too: the hardest split there is.
    expect(MAX_CHANGES).toBe(10);
    const ids = Array.from({ length: 12 }, (_, i) => `t-${i + 1}`);
    for (const [i, id] of ids.entries()) await tempoOnTheWatch(id, i + 1);
    const a = await mainRun();
    const b = await mainRun();
    for (const id of ids.slice(0, 10)) ok((await adjust(a, id, 25)).res);
    for (const id of ids.slice(10)) ok((await adjust(b, id, 25)).res);
    const all = [...(await opsOf(a)), ...(await opsOf(b))];
    expect(all.every((o) => o.retime?.minutes === 25 && o.retime.stageInserts === 1)).toBe(true);
    const pid = await pending(a, all);

    const costs: number[] = [];
    const chunks: string[][] = [];
    let remaining: string[] | null = null;
    for (let i = 0; remaining === null || remaining.length > 0; i++) {
      if (i >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
      const res = await invoke(`/api/coach/proposals/${pid}/approve`, remaining ? { opIds: remaining } : {});
      expect(res.status).toBe(200);
      costs.push(res.total);
      chunks.push((res.json.changed as Array<{ opId: string }>).map((c) => c.opId));
      remaining = res.json.remaining as string[];
    }
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(chunks.flat()).toEqual(ids.map(planAdjustId));
    // Pinned: one a request — a re-timed run on the watch declares 12 + 1 + its day's sessions, and two don't fit
    // beside the approve's own (7 + 9). Measured 24 a request (the last 25), against 30–32 declared.
    expect(chunks.map((c) => c.length)).toEqual(Array.from({ length: 12 }, () => 1));
    for (const id of ids) {
      expect((await rowOf(id)).fallbackEstimatedDurationSeconds).toBe(1500);
      expect((await db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, id))).length).toBe(5);
    }
    expect((await db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.kind, "coach_update_workout"), eq(corosWriteJobs.status, "queued")))).length).toBe(12);
    expect((await db.select().from(coachProposals).where(eq(coachProposals.id, pid)))[0]!.status).toBe("approved");
  });
});
