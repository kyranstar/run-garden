/**
 * THE ACT TOOLS ON A DESIGNED RUN (§8 §3): validate_workout and propose_workout take a run document — judged as a run,
 * with the athlete's running (`RunCtx`: their threshold, the hard sessions near the day, the week's running and the four
 * weeks before) read inside the statement the tools already run — and refuse a run only as a revision of a Studio or
 * template workout. A made-up athlete on the read fixture's clock.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import { isToolErr, type ReviewHooks, type ReviewStart, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { NOW, TODAY } from "./design-read-fixture.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const TOMORROW = addDays(TODAY, 1);
let db: Db;
let userId: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db, { timezone: "America/Los_Angeles", units: "km" }));
});

async function runRow(): Promise<ToolContext["run"]> {
  const id = `run-${newId().slice(0, 8)}`;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "A tempo run tomorrow", status: "active", state: null, steps: 0,
    costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false };
}
let seq = 0;
const ctxOf = (run: ToolContext["run"], extra: Partial<ToolContext> = {}): ToolContext => ({ db, env: {} as Env, userId, run, now: NOW, toolUseId: `toolu_r${++seq}`, ...extra });
const tool = (name: string) => ACT_TOOLS.find((t) => t.name === name)!;
async function call(name: string, c: ToolContext, input: unknown): Promise<ToolOk | ToolErr> {
  statements = 0;
  return tool(name).run(c, input);
}
const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};

const tempo = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});
const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

async function threshold(v: number) {
  await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: addDays(TODAY, -3), thresholdPaceSecPerKm: v, contentFingerprint: "f", updatedAt: NOW.toISOString() });
}
async function planRun(date: string, category: string, title: string) {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId: "p", sourceWorkoutId: id, title, category, sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date,
    effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 2700, completionState: "scheduled",
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
}

describe("validate_workout on a run", () => {
  it("judges it as a run: valid, a run derived, and what the athlete's running makes a cost", async () => {
    const r = await runRow();
    const fresh = ok(await call("validate_workout", ctxOf(r), { doc: tempo(), date: TOMORROW })).data as any;
    expect(fresh.valid).toBe(true);
    expect(fresh.derived).toMatchObject({ discipline: "run", category: "quality", minutes: 50 });
    // No threshold yet: the watch shows time only.
    expect(codes(fresh.warnings)).toEqual(["run_pace_owed"]);
    expect(statements).toBeLessThanOrEqual(6);
    await threshold(289);
    await planRun(TODAY, "quality", "Hill repeats");
    const near = ok(await call("validate_workout", ctxOf(r), { doc: tempo(), date: TOMORROW })).data as any;
    expect(codes(near.warnings)).toEqual(["run_hard_close"]);
    expect(near.warnings[0].message).toBe("Hill repeats is the day before: hard running wants 48 hours from other hard running and hard leg strength.");
    expect(statements).toBeLessThanOrEqual(6);
  });

  it("a run among moves, an open segment, a pace far from its effort: errors to fix", async () => {
    const r = await runRow();
    await threshold(289);
    const mixed = tempo();
    (mixed.parts as any[]).push({ purpose: "cooldown", format: "straight", items: [{ kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 10 } }] });
    expect(codes((ok(await call("validate_workout", ctxOf(r), { doc: mixed, date: TOMORROW })).data as any).errors)).toEqual(["run_mixed"]);
    const far = tempo();
    (far.parts as any[])[1].items[0].target = { durationSec: 480, pace: { fastSecPerKm: 230, slowSecPerKm: 240 } };
    const v = ok(await call("validate_workout", ctxOf(r), { doc: far, date: TOMORROW })).data as any;
    expect(v.valid).toBe(false);
    expect(codes(v.errors)).toEqual(["run_pace_far"]);
  });

  it("a run can't replace a Studio or template workout: proposed as a new run", async () => {
    const r = await runRow();
    const e = await call("validate_workout", ctxOf(r), { doc: tempo(), date: TOMORROW, workoutId: "w-1" });
    expect(isToolErr(e) && e.error).toBe("run_unsupported");
    expect((e as ToolErr).fix).toMatch(/new workout/);
  });
});

describe("propose_workout on a run", () => {
  it("a new run: stored for review like any draft, its warnings kept, within its statements", async () => {
    const r = await runRow();
    await threshold(289);
    const started: ReviewStart[] = [];
    const hooks: ReviewHooks = { start: async (req) => (started.push(req), true), ended: () => null };
    const out = ok(await call("propose_workout", ctxOf(r, { review: hooks }), { doc: tempo(), target: { kind: "new", date: TOMORROW } }));
    expect(out.control).toBe("review");
    expect(statements).toBeLessThanOrEqual(9);
    expect(started[0]!.draft).toMatchObject({ date: TOMORROW, doc: { title: "Tempo blocks" }, derived: { discipline: "run" } });
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(r.id)));
    expect((p!.ops as DocWorkoutOp[])[0]!.doc.parts.map((x) => x.purpose)).toEqual(["warmup", "run", "cooldown"]);
  });

  it("as a revision: refused, with what to do", async () => {
    const r = await runRow();
    const e = await call("propose_workout", ctxOf(r), { doc: tempo(), target: { kind: "revise", workoutId: "w-1", baseRev: 1 } });
    expect(isToolErr(e) && e.error).toBe("run_unsupported");
  });
});
