/**
 * THE COACH'S REACH: EASE, SWAP, REMOVE AND RESTORE (the new shape §5; stream A, part 5). adjust_plan gains the thread
 * coach's proven single-session changes beside skip, move and a length, each applied at approval through coach-apply's
 * own applier (`applyOps`) — not a new authority — and approved op by op, its line the thread coach's own manifest line:
 *  - ease: a watch-plan run made easy and shorter (about 70% of its length by default, or the length or distance asked
 *    for), the thread coach's `ease` with the eased session;
 *  - swap: a day's run for an easier kind (an easy or a recovery run), the same applier;
 *  - remove: a session off the plan entirely (not counted as rest), the athlete's own remove;
 *  - restore: a skipped session back on the plan, the athlete's own un-skip.
 * The rules are the thread coach's and the app's: a programme session is skipped or moved (never eased, swapped or
 * removed), a Studio or template workout is revised (never eased), a race stays where it is, a restore needs a skip.
 * Two statements a change, as before; each kind's approval cost is the most it runs (pinned).
 *
 * Called at the tool and the service, on the made-up athlete of design-read-fixture.ts and its fixed clock. Synthetic
 * data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import {
  approveDesignOps,
  declineDesignOps,
  EASE_COST,
  PLAN_BATCH_FIXED,
  planOpCostOf,
  REMOVE_COST,
  RESTORE_COST,
  type AnyDesignedOp,
  type DesignedPlanOp,
} from "../src/services/design-approve.js";
import { planChangeLines } from "../src/services/design-manifest.js";
import { roleBlock, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { adjustPlan, EASE_SHARE } from "../src/services/design-tools/adjust-plan.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type RunScope, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { planAdjustId, type PlanAdjustOp } from "../src/services/proposal-kinds.js";
import { day, NOW, seedRichAthlete, studioDoc, TODAY } from "./design-read-fixture.js";
import { makeTestDb } from "./helpers.js";

const { coachProposals, plannedWorkouts } = schema;
const ENV = {} as Env;

let db: Db;
let statements: string[] = [];
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;
let prefs: UserPreferences;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  rich = await seedRichAthlete(db);
  prefs = await loadPreferences(db, rich.userId);
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no network here");
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

let runSeq = 0;
async function mainRun(scope: RunScope = { kind: "auto" }): Promise<ToolContext["run"]> {
  const id = `run-pp-${++runSeq}-${newId().slice(0, 8)}`;
  await db.insert(schema.coachRuns).values({
    id, userId: rich.userId, parentId: null, role: "main", scope: { ...scope }, request: "Ease my week.", status: "active", state: null,
    steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { id, role: "main", scope, parentId: null, rehearsal: false };
}
let useSeq = 0;
const ctxOf = (r: ToolContext["run"]): ToolContext => ({ db, env: ENV, userId: rich.userId, run: r, now: NOW, toolUseId: `toolu_pp${++useSeq}` });
async function adjust(r: ToolContext["run"], input: unknown) {
  statements.length = 0;
  const res = await adjustPlan.run(ctxOf(r), input);
  return { res, count: statements.length };
}
const ok = (res: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(res)) throw new Error(`refused: ${res.error} — ${res.why}`);
  return res;
};
const refused = (res: ToolOk | ToolErr): ToolErr => {
  if (!isToolErr(res)) throw new Error(`not refused: ${JSON.stringify(res.data)}`);
  return res;
};
async function proposalOf(id: string) {
  const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
  return p ? { ...p, ops: p.ops as AnyDesignedOp[] } : undefined;
}
const planOps = async (id: string) => (await proposalOf(id))!.ops.filter((o): o is DesignedPlanOp => o.kind === "plan_adjust");
const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;

/** A planned session of the athlete's: a watch-plan run unless said otherwise — on the watch (COROS holds it as the import
 * last saw it, `synced`) unless `sync` says otherwise; `distanceStage`: the plan prescribes it by one distance stage. */
async function planned(o: {
  date: string;
  /** Its id (and source workout id): the coach's own plan session's is `cw-…`. */
  id?: string;
  /** A document at revision 1 (a coach session's, `studioDoc`). */
  doc?: boolean;
  category?: string;
  origin?: string | null;
  title?: string;
  minutes?: number;
  meters?: number;
  state?: string;
  sport?: string;
  sync?: string;
  distanceStage?: boolean;
}): Promise<string> {
  const id = o.id ?? `pw-${newId().slice(0, 10)}`;
  await db.insert(plannedWorkouts).values({
    id, userId: rich.userId, planId: "coros-plan", sourceWorkoutId: id, title: o.title ?? "Tempo run", category: o.category ?? "quality",
    sport: o.sport ?? "run", originalPlanDate: o.date, lastVerifiedCorosDate: o.date, effectiveDate: o.date, effectiveTime: "18:00",
    sourceContentFingerprint: "fp", sourceEstimatedDurationSeconds: (o.minutes ?? 50) * 60, calendarBlockDurationSeconds: (o.minutes ?? 50) * 60,
    expectedDistanceMeters: o.meters ?? null, completionState: o.state ?? "scheduled", origin: o.origin ?? null, corosSyncState: o.sync ?? "synced",
    ...(o.state === "skipped" ? { resolutionDate: TODAY, sanctionedBy: "coach" } : {}),
    ...(o.doc ? { workoutDoc: JSON.stringify(studioDoc({ title: o.title ?? "Coach session" })), workoutDocRev: 1 } : {}),
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  if (o.distanceStage) {
    await db.insert(schema.plannedWorkoutStages).values({ id: `${id}-s1`, workoutId: id, parentStageId: null, ord: 0, kind: "work", durationType: "distance", distanceMeters: o.meters ?? 10_000 });
  }
  return id;
}
const programmeSession = async (): Promise<string> => {
  const [row] = await db
    .select({ id: plannedWorkouts.id })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, rich.userId), eq(plannedWorkouts.effectiveDate, day(-2)), eq(plannedWorkouts.origin, "program")));
  return row!.id;
};

const change = (workoutId: string, c: Record<string, unknown>) => ({ workoutId, change: c, why: "Heavy legs after the hills." });
/** A main run's proposal of these changes, pending as the finish leaves it. */
async function proposal(changes: unknown[]): Promise<string> {
  const r = await mainRun();
  for (const c of changes) ok((await adjust(r, c)).res);
  const id = designProposalId(r.id);
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
  return id;
}
const ctx = () => ({ today: TODAY, now: NOW.toISOString(), prefs });
async function approve(id: string, opIds?: string[]) {
  statements.length = 0;
  return approveDesignOps(db, rich.userId, (await proposalOf(id))! as never, opIds ? { opIds } : {}, ctx(), Number.POSITIVE_INFINITY);
}

describe("adjust_plan: ease, swap, remove and restore, into the run's one proposal", () => {
  it("eases a run on the watch by TIME — the wire carries no distance — an easy run at about 70% of its length: two statements", async () => {
    // Prescribed by distance, and on the watch: its time, eased (the owner's ruling; the body check's own `easedRun`).
    const run = await planned({ date: day(-1), minutes: 50, meters: 10_000, distanceStage: true });
    const r = await mainRun();
    const { res, count } = await adjust(r, change(run, { kind: "ease" }));
    expect(count).toBe(2);
    expect(count).toBeLessThanOrEqual(adjustPlan.statementCost);
    const data = ok(res).data as { change: { summary: { text: string } } };
    expect(data.change.summary.text).toBe(`Easy run · ${Math.round(50 * EASE_SHARE)} min`);
    const [op] = await planOps(designProposalId(r.id));
    expect(op!.op).toEqual({
      kind: "ease",
      workoutId: run,
      session: { category: "easy", title: "Easy run", durationMinutes: 35, run: { blocks: [{ kind: "duration", value: 35, intensity: "easy" }] } },
    });
    expect(EASE_SHARE).toBe(0.7);
    // A length asked for is the length; a distance asked for is that distance's time at the run's own pace (10 km in 50
    // minutes: 5 km is 25 minutes).
    const asked = await planned({ date: day(-3), minutes: 60 });
    ok((await adjust(r, change(asked, { kind: "ease", durationMinutes: 30 }))).res);
    const sessionOf = async (id: string) => ((await planOps(designProposalId(r.id))).find((o) => o.op.workoutId === id)!.op as { session: unknown }).session;
    expect(await sessionOf(asked)).toEqual({ category: "easy", title: "Easy run", durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] } });
    const byKm = await planned({ date: day(-4), minutes: 50, meters: 10_000, distanceStage: true });
    ok((await adjust(r, change(byKm, { kind: "ease", distanceKm: 5 }))).res);
    expect(await sessionOf(byKm)).toEqual({ category: "easy", title: "Easy run", durationMinutes: 25, run: { blocks: [{ kind: "duration", value: 25, intensity: "easy" }] } });
  });

  it("eases a run off the watch by its distance when the plan prescribes it so — or by the distance asked for", async () => {
    const run = await planned({ date: day(-1), minutes: 50, meters: 10_000, distanceStage: true, sync: "calendar_only" });
    const r = await mainRun();
    ok((await adjust(r, change(run, { kind: "ease" }))).res);
    const [op] = await planOps(designProposalId(r.id));
    expect((op!.op as { session: unknown }).session).toEqual({ category: "easy", title: "Easy run", durationMinutes: 35, run: { blocks: [{ kind: "distance", value: 7_000, intensity: "easy" }] } });
    const asked = await planned({ date: day(-3), minutes: 50, meters: 10_000, sync: "calendar_only" });
    ok((await adjust(r, change(asked, { kind: "ease", distanceKm: 6 }))).res);
    const eased = (await planOps(designProposalId(r.id))).find((o) => o.op.workoutId === asked)!;
    expect((eased.op as { session: { run: unknown } }).session.run).toEqual({ blocks: [{ kind: "distance", value: 6_000, intensity: "easy" }] });
  });

  it("a swap never lengthens the session: a length past the original's is capped at it", async () => {
    const run = await planned({ date: day(-1), minutes: 40 });
    const r = await mainRun();
    ok((await adjust(r, change(run, { kind: "swap", to: "easy", durationMinutes: 70 }))).res);
    const [op] = await planOps(designProposalId(r.id));
    expect((op!.op as { session: { durationMinutes: number; run: unknown } }).session).toMatchObject({
      durationMinutes: 40,
      run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] },
    });
  });

  it("swaps a day's run for an easier kind: an easy or a recovery run, through the same applier", async () => {
    const run = await planned({ date: day(-1), minutes: 50 });
    const r = await mainRun();
    ok((await adjust(r, change(run, { kind: "swap", to: "recovery", durationMinutes: 25 }))).res);
    const [op] = await planOps(designProposalId(r.id));
    expect(op!.verb).toBe("swap");
    expect(op!.op).toEqual({
      kind: "ease",
      workoutId: run,
      session: { category: "recovery", title: "Recovery run", durationMinutes: 25, run: { blocks: [{ kind: "duration", value: 25, intensity: "easy" }] } },
    });
    const [line] = planChangeLines((await proposalOf(designProposalId(r.id)))!.ops);
    expect(line).toMatchObject({ kind: "swap", summary: "Recovery run · 25 min", was: "Tempo run · 50 min" });
  });

  it("removes a session off the plan, and puts a skipped one back", async () => {
    const run = await planned({ date: day(-1) });
    const skipped = await planned({ date: day(-2), state: "skipped", title: "Easy run", category: "easy" });
    const r = await mainRun();
    ok((await adjust(r, change(run, { kind: "remove" }))).res);
    ok((await adjust(r, change(skipped, { kind: "restore" }))).res);
    const ops = await planOps(designProposalId(r.id));
    expect(ops.map((o) => o.op)).toEqual([
      { kind: "remove", workoutId: run },
      { kind: "restore", workoutId: skipped },
    ]);
    const lines = planChangeLines((await proposalOf(designProposalId(r.id)))!.ops);
    expect(lines.map((l) => [l.kind, l.summary])).toEqual([
      ["remove", "Tempo run — removed"],
      ["restore", "Easy run — back on"],
    ]);
    expect(lines[0]!.effect).toMatch(/taken off the plan entirely/);
  });

  it("the tool and the prompt say them: seven kinds of change, each the main coach's", () => {
    const kinds = ((adjustPlan.inputSchema.properties as Record<string, { anyOf: Array<{ properties: { kind: { const: string } } }> }>).change!.anyOf).map((c) => c.properties.kind.const);
    expect(kinds).toEqual(["skip", "move", "adjust", "ease", "swap", "remove", "restore"]);
    expect(adjustPlan.description).toMatch(/ease or swap a watch-plan run for an easier one, remove it, or restore a skipped one/);
    expect(roleBlock("main", 12)).toMatch(/ease it or swap it for an easier run \(heavy legs\), remove it, or put a skipped one back/);
    expect(SHARED_PROMPT).toMatch(/ease it \(easy, about 70% of it\) or swap it for an easier run; remove it \(off the plan, not rest\); or put a skipped one back/);
  });

  it("refused, each in words, writing nothing: a programme session, a revisable workout eased (Studio, or a coach session not a run), a Studio one removed, a race, no run, no easier, no skip", async () => {
    const r = await mainRun();
    const prog = await programmeSession();
    const race = await planned({ date: day(-4), category: "race", title: "Race" });
    // A coach session that isn't a run is revisable (workout-editability §5): it is revised, not eased here — its remove
    // applies (below): revising can't take a session off the plan.
    const strength = await planned({ date: day(-1), category: "strength", sport: "strength", title: "Strength" });
    const rest = await planned({ date: day(-1), category: "rest", title: "Rest" });
    const easy = await planned({ date: day(-1), category: "easy", title: "Easy run", minutes: 40 });
    const scheduled = await planned({ date: day(-1), category: "easy", title: "Easy run" });
    const pastSkip = await planned({ date: day(2), state: "skipped" });
    const cases: Array<[string, unknown, string]> = [
      ["ease a programme session", change(prog, { kind: "ease" }), "programme_session"],
      ["swap a programme session", change(prog, { kind: "swap", to: "easy", durationMinutes: 30 }), "programme_session"],
      ["remove a programme session", change(prog, { kind: "remove" }), "programme_session"],
      ["ease a Studio workout", change(rich.todayDocId, { kind: "ease" }), "revise_instead"],
      ["remove a Studio workout", change(rich.todayDocId, { kind: "remove" }), "revise_instead"],
      ["ease a race", change(race, { kind: "ease" }), "race_day"],
      ["remove a race", change(race, { kind: "remove" }), "race_day"],
      ["ease a coach strength session", change(strength, { kind: "ease" }), "revise_instead"],
      ["ease a rest day", change(rest, { kind: "ease" }), "not_a_run"],
      ["ease to no shorter", change(easy, { kind: "ease", durationMinutes: 40 }), "not_easier"],
      ["swap to no easier", change(easy, { kind: "swap", to: "easy", durationMinutes: 30 }), "not_easier"],
      ["restore one not skipped", change(scheduled, { kind: "restore" }), "not_skipped"],
      ["restore a past skip", change(pastSkip, { kind: "restore" }), "not_changeable"],
    ];
    for (const [what, input, code] of cases) {
      const e = refused((await adjust(r, input)).res);
      expect(e.error, what).toBe(code);
      expect(e.fix.length, what).toBeGreaterThan(0);
    }
    expect(await proposalOf(designProposalId(r.id))).toBeUndefined();
  });

  it("a Studio workout's remove points at the skip as well as the revise — for a set, at the skip and the brief", async () => {
    const now = refused((await adjust(await mainRun(), change(rich.todayDocId, { kind: "remove" }))).res);
    expect(now).toMatchObject({ error: "revise_instead", fix: "Skip it with adjust_plan, or revise it with propose_workout's revise target." });
    const set = refused((await adjust(await mainRun({ kind: "week" }), change(rich.todayDocId, { kind: "remove" }))).res);
    expect(set).toMatchObject({ error: "revise_instead", fix: "Skip it with adjust_plan, or brief its replacement in plan_set: a designer revises the workout itself." });
  });

  it("a coach session (origin NULL, revisable) is removed or skipped through adjust_plan — revising can't take it off the plan — and the approve applies both", async () => {
    // The coach's own plan sessions (`cw-…`), strength with a document: revisable, and still the coach's to take off.
    const removeMe = await planned({ id: `cw-pp-${newId().slice(0, 6)}-0`, date: day(-1), category: "strength", sport: "strength", title: "Legs, invented", doc: true });
    const skipMe = await planned({ id: `cw-pp-${newId().slice(0, 6)}-1`, date: day(-3), category: "strength", sport: "strength", title: "Core, invented", doc: true });
    const r = await mainRun();
    const removed = await adjust(r, change(removeMe, { kind: "remove" }));
    expect(removed.count).toBeLessThanOrEqual(adjustPlan.statementCost);
    ok(removed.res);
    ok((await adjust(r, change(skipMe, { kind: "skip", reason: "A heavy week: rest the legs." }))).res);
    expect((await planOps(designProposalId(r.id))).map((o) => o.op)).toEqual([
      { kind: "remove", workoutId: removeMe },
      expect.objectContaining({ kind: "skip", workoutId: skipMe }),
    ]);
    const id = designProposalId(r.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    const res = await approve(id);
    expect(res.refused).toEqual([]);
    expect(res.changed.map((c) => [c.change, c.workoutId])).toEqual([
      ["remove", removeMe],
      ["skip", skipMe],
    ]);
    expect(await rowOf(removeMe)).toMatchObject({ archiveReason: "user_removed" });
    expect(await rowOf(skipMe)).toMatchObject({ completionState: "skipped", archivedAt: null });
  });
});

describe("approve, op by op, through the thread coach's appliers", () => {
  it("each applies: the run eased, the run swapped, the session off the plan, the skip undone — and asked again, made, nothing written", async () => {
    const easeMe = await planned({ date: day(-1), minutes: 50 });
    const swapMe = await planned({ date: day(-3), minutes: 60, title: "Long run", category: "long" });
    const removeMe = await planned({ date: day(-4) });
    const restoreMe = await planned({ date: day(-2), state: "skipped", title: "Easy run", category: "easy" });
    const id = await proposal([
      change(easeMe, { kind: "ease", durationMinutes: 30 }),
      change(swapMe, { kind: "swap", to: "easy", durationMinutes: 40 }),
      change(removeMe, { kind: "remove" }),
      change(restoreMe, { kind: "restore" }),
    ]);
    const res = await approve(id);
    expect(res.status).toBe("approved");
    expect(res.refused).toEqual([]);
    expect(res.changed.map((c) => [c.change, c.workoutId])).toEqual([
      ["ease", easeMe],
      ["swap", swapMe],
      ["remove", removeMe],
      ["restore", restoreMe],
    ]);
    expect(await rowOf(easeMe)).toMatchObject({ title: "Easy run", category: "easy", calendarBlockDurationSeconds: 30 * 60 });
    expect(await rowOf(swapMe)).toMatchObject({ title: "Easy run", category: "easy", calendarBlockDurationSeconds: 40 * 60 });
    expect(await rowOf(removeMe)).toMatchObject({ archiveReason: "user_removed" });
    expect(await rowOf(restoreMe)).toMatchObject({ completionState: "scheduled", sanctionedBy: null });
    for (const op of await planOps(id)) expect(op.outcome, op.id).toMatchObject({ status: "applied" });
    expect((await planOps(id)).find((o) => o.op.workoutId === swapMe)!.outcome).toMatchObject({ before: { title: "Long run", minutes: 60 } });
    // Asked again: each is made — nothing runs twice.
    const again = await approve(id);
    expect(again.changed).toEqual([]);
    expect(again.settled.map((s) => s.outcome)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(statements.filter((s) => /^\s*(insert|update|delete)/i.test(s))).toEqual([]);
  });

  it("judged again at the tap: a session done since is refused, a restore already back is made", async () => {
    const easeMe = await planned({ date: day(-1) });
    const restoreMe = await planned({ date: day(-2), state: "skipped" });
    const id = await proposal([change(easeMe, { kind: "ease" }), change(restoreMe, { kind: "restore" })]);
    await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, easeMe));
    await db.update(plannedWorkouts).set({ completionState: "scheduled" }).where(eq(plannedWorkouts.id, restoreMe));
    const res = await approve(id);
    expect(res.refused).toEqual([expect.objectContaining({ opId: planAdjustId(easeMe), error: "not_editable", cause: "resolved", why: "It's already done.", instead: "Propose a new workout." })]);
    expect(res.changed.map((c) => c.workoutId)).toEqual([restoreMe]);
    expect(await rowOf(easeMe)).toMatchObject({ title: "Tempo run" });
  });

  it("judged again at the tap: a remove the athlete made since is made, an ease already in place is made, a session the app builds since is refused", async () => {
    const removeMe = await planned({ date: day(-4) });
    const easeMe = await planned({ date: day(-1), minutes: 50 });
    const becameProgramme = await planned({ date: day(-3) });
    const id = await proposal([
      change(removeMe, { kind: "remove" }),
      change(easeMe, { kind: "ease", durationMinutes: 30 }),
      change(becameProgramme, { kind: "ease", durationMinutes: 30 }),
    ]);
    // Since: the athlete removed one themselves, eased another the same way, and the third became a programme's.
    await db.update(plannedWorkouts).set({ archivedAt: NOW.toISOString(), archiveReason: "user_removed" }).where(eq(plannedWorkouts.id, removeMe));
    await db.update(plannedWorkouts).set({ title: "Easy run", category: "easy", sourceEstimatedDurationSeconds: null, fallbackEstimatedDurationSeconds: 30 * 60 }).where(eq(plannedWorkouts.id, easeMe));
    await db.update(plannedWorkouts).set({ origin: "program" }).where(eq(plannedWorkouts.id, becameProgramme));
    const res = await approve(id);
    expect(res.changed.map((c) => [c.change, c.workoutId])).toEqual([
      ["remove", removeMe],
      ["ease", easeMe],
    ]);
    expect(res.refused).toEqual([
      expect.objectContaining({
        opId: planAdjustId(becameProgramme),
        error: "not_editable",
        cause: "programme",
        instead: "Put moves in its pool with pin_moves, change the programme with change_programme, or propose a new workout for that day and skip the slot with adjust_plan.",
      }),
    ]);
    // Made: nothing of the plan written for them — and the programme's session is left as it is.
    expect(statements.filter((s) => /^\s*update\s+"?planned_workouts/i.test(s))).toEqual([]);
    expect(await rowOf(becameProgramme)).toMatchObject({ title: "Tempo run" });
  });

  it("each kind's cost is the most it runs (pinned)", async () => {
    const measured: Record<string, number> = {};
    for (const [kind, make] of [
      ["ease", async () => change(await planned({ date: day(-1) }), { kind: "ease" })],
      ["swap", async () => change(await planned({ date: day(-1) }), { kind: "swap", to: "recovery", durationMinutes: 30 })],
      ["remove", async () => change(await planned({ date: day(-1) }), { kind: "remove" })],
      ["restore", async () => change(await planned({ date: day(-1), state: "skipped" }), { kind: "restore" })],
    ] as const) {
      const id = await proposal([await make()]);
      await approve(id);
      // Less the approve's own: the proposal's write and the receipt (the plan read is the approve's too).
      measured[kind] = statements.length - 3;
    }
    // The day's sessions: the eased run's, the swapped one's and the fixture's run (the collision pass's moves).
    const dayRows = 3;
    const cost = (op: Record<string, unknown>) => PLAN_BATCH_FIXED + planOpCostOf({ op } as unknown as PlanAdjustOp, dayRows);
    expect(measured.ease).toBeLessThanOrEqual(cost({ kind: "ease", workoutId: "w", session: {} }));
    expect(measured.swap).toBeLessThanOrEqual(cost({ kind: "ease", workoutId: "w", session: {} }));
    expect(measured.remove).toBeLessThanOrEqual(cost({ kind: "remove", workoutId: "w" }));
    expect(measured.restore).toBeLessThanOrEqual(cost({ kind: "restore", workoutId: "w" }));
    // Each its applier's most (design-approve.ts): an ease's watch convergence and a remove's unpush aren't reached here.
    expect({ EASE_COST, REMOVE_COST, RESTORE_COST }).toEqual({ EASE_COST: 11, REMOVE_COST: 12, RESTORE_COST: 4 });
  });

  it("at their most: an ease converging the watch's copy, a remove taking the app's own copy back off — each within its cost", async () => {
    const watchPrefs = { ...prefs, corosWritesEnabled: true };
    const measure = async (input: unknown) => {
      const id = await proposal([input]);
      statements.length = 0;
      const res = await approveDesignOps(db, rich.userId, (await proposalOf(id))! as never, {}, { ...ctx(), prefs: watchPrefs }, Number.POSITIVE_INFINITY);
      expect(res.status).toBe("approved");
      return statements.length - 3;
    };
    // A run COROS holds, the import's own fingerprint on it, prescribed by distance: the ease's rewrite is queued (the
    // second proof) — by time, so the watch is rewritten, never emptied, and holds what the plan now says.
    const imported = await planned({ date: day(-1), minutes: 50, meters: 10_000, distanceStage: true });
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "123:45", sourceIdInPlan: "7", sourceProgramId: "999", lastVerifiedCorosDate: day(-1), sourceContentFingerprint: "0123456789abcdef" })
      .where(eq(plannedWorkouts.id, imported));
    const eased = await measure(change(imported, { kind: "ease" }));
    const jobs = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.workoutId, imported));
    expect(jobs.map((j) => j.kind)).toEqual(["coach_update_workout"]);
    const wire = (jobs[0]!.payload as { session: { durationMinutes: number; run: { blocks: Array<{ kind: string; value: number }> } } }).session;
    expect(wire.run.blocks).toEqual([{ kind: "duration", value: 35, intensity: "easy" }]);
    const row = await rowOf(imported);
    expect([row.calendarBlockDurationSeconds, row.expectedDistanceMeters]).toEqual([wire.durationMinutes * 60, null]);
    // A session the app put on the watch, its create verified: the remove queues its unpush.
    const pushed = await planned({ date: day(-4) });
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "123:46", sourceIdInPlan: "8", sourceProgramId: "998", lastVerifiedCorosDate: day(-4) })
      .where(eq(plannedWorkouts.id, pushed));
    await db.insert(schema.corosWriteJobs).values({
      id: `${pushed}-push`, userId: rich.userId, workoutId: pushed, kind: "coach_create_workout", expectedContentFingerprint: "", originalDate: day(-4),
      destinationDate: day(-4), payload: { name: "Tempo run · RG" }, requestedAt: NOW.toISOString(), status: "verified", verifiedAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    const r = await mainRun();
    const added = ok((await adjust(r, change(pushed, { kind: "remove" }))).res).data as { change: { effect: { text: string } } };
    expect(added.change.effect.text).toMatch(/comes off your watch/);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(r.id)));
    statements.length = 0;
    expect((await approveDesignOps(db, rich.userId, (await proposalOf(designProposalId(r.id)))! as never, {}, { ...ctx(), prefs: watchPrefs }, Number.POSITIVE_INFINITY)).status).toBe("approved");
    const removed = statements.length - 3;
    expect((await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, `${pushed}-unpush`)))[0]).toMatchObject({ kind: "coach_delete_workout" });
    // The day's other sessions: the fixture's run (the eased run's day), none (the removed one's).
    expect(eased).toBeLessThanOrEqual(PLAN_BATCH_FIXED + planOpCostOf({ op: { kind: "ease" } } as unknown as PlanAdjustOp, 2));
    expect(removed).toBeLessThanOrEqual(PLAN_BATCH_FIXED + planOpCostOf({ op: { kind: "remove" } } as unknown as PlanAdjustOp, 0));
  });

  it("declined, nothing is written", async () => {
    const removeMe = await planned({ date: day(-4) });
    const id = await proposal([change(removeMe, { kind: "remove" })]);
    statements.length = 0;
    await declineDesignOps(db, rich.userId, (await proposalOf(id))! as never, {}, NOW.toISOString());
    expect((await planOps(id))[0]!.outcome).toMatchObject({ status: "declined" });
    expect((await rowOf(removeMe)).archivedAt).toBeNull();
  });
});
