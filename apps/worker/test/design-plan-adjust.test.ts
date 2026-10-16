/**
 * PLAN ADJUSTMENTS IN A DESIGNED PROPOSAL (Stage 3 Task 8b; the lead's ruling I6, Option A).
 *
 * The main coach may change a session already on the plan inside its own proposal — skip it, move it, or shorten a
 * watch-plan run — with `adjust_plan`. Each change is ONE op of kind `plan_adjust` holding the thread coach's own
 * `CoachOp` of that kind, applied at approval through coach-apply's existing applier (`applyOps`): not a new authority,
 * the same lever under the same approval. Ruling 3-R13 stands: a programme session is skipped or moved, never re-timed;
 * a Studio or template workout is revised, never re-timed. A change is never reviewed (it is a plan change, not a
 * document); the finish's "every op reviewed" rule counts designed workouts only.
 *
 * Called at the tool and the service, on the made-up athlete of design-read-fixture.ts and its fixed clock; the loop is
 * design-plan-adjust-loop.test.ts, the routes and their budgets design-plan-adjust-routes.test.ts. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, parseStoredWorkoutDoc, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { NOT_ACTIONABLE, whyNotActionable } from "../src/services/coach-apply.js";
import { sweepExpiredProposals } from "../src/routes/coach.js";
import {
  ADJUST_COST,
  APPLYING_STALE_MS,
  approveDesignOps,
  declineDesignOps,
  designDraft,
  MOVE_COST,
  opCostOf,
  PLAN_BATCH_FIXED,
  planOpCostOf,
  REJUDGE_COST,
  SKIP_COST,
  statusOfOps,
  UnknownOpError,
  type AnyDesignedOp,
  type DesignedOp,
  type DesignedPlanOp,
  type PlanOpOutcome,
} from "../src/services/design-approve.js";
import { planChangeLines } from "../src/services/design-manifest.js";
import { supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { proposalFields } from "../src/services/design-review.js";
import { adjustPlan, SANCTIONED_REST_PER_ROLLING_WEEK } from "../src/services/design-tools/adjust-plan.js";
import { buildDossier } from "../src/services/coach-context.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { readProposals } from "../src/services/design-tools/read-proposals.js";
import { isToolErr, type OpReview, type RunScope, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { coachOpsOf, isDesignedProposal, opIdOf, planAdjustId, type PlanAdjustOp } from "../src/services/proposal-kinds.js";
import { day, NOW, seedRichAthlete, studioDoc, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb } from "./helpers.js";

const { coachProposals, coachMessages, plannedWorkouts, workoutDocRevisions, scheduleOverrides } = schema;
const ENV = {} as Env;

let db: Db;
let statements: string[] = [];
/** Runs just before each statement the application executes (a test arms it to land another request's write there). */
let beforeStatement: ((sql: string) => void) | null = null;
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;
let prefs: UserPreferences;

beforeEach(async () => {
  // The thread coach's applier reads the clock itself (its today, its now): the fixture's day, so it agrees with the
  // approval's. Only Date is faked.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  statements = [];
  beforeStatement = null;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (s) => {
      statements.push(s);
      beforeStatement?.(s);
    },
  });
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

// ── Fixture ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const REVIEW: OpReview = {
  scores: { intent: 4, sequencing: 4, alignment: 4, balance: 4, progression: 4, diversity: 4, recovery: 4, condition_safety: 4, time_fit: 4, equipment_fit: 4, specificity: 4, honesty: 4 },
  notes: { intent: "Clear." },
  mustFix: [],
  improvements: [],
  rounds: 1,
  changes: [],
};

let runSeq = 0;
async function mainRun(scope: RunScope = { kind: "now" }, userId = rich.userId): Promise<ToolContext["run"]> {
  const id = `run-${++runSeq}-${newId().slice(0, 8)}`;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { ...scope }, request: "Ease today off, my jaw is flaring.",
    status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { id, role: "main", scope, parentId: null, rehearsal: false };
}
let useSeq = 0;
const ctxOf = (r: ToolContext["run"], o: { toolUseId?: string; userId?: string } = {}): ToolContext => ({
  db, env: ENV, userId: o.userId ?? rich.userId, run: r, now: NOW, toolUseId: o.toolUseId ?? `toolu_pa${++useSeq}`,
});

async function adjust(r: ToolContext["run"], input: unknown, o: { toolUseId?: string; userId?: string } = {}) {
  statements.length = 0;
  const res = await adjustPlan.run(ctxOf(r, o), input);
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

/** A planned session of the athlete's, as the plan holds one. */
async function planned(o: {
  date: string;
  time?: string;
  category?: string;
  origin?: string | null;
  title?: string;
  minutes?: number;
  doc?: boolean;
  state?: string;
  userId?: string;
}): Promise<string> {
  const id = `pw-${newId().slice(0, 10)}`;
  await db.insert(plannedWorkouts).values({
    id, userId: o.userId ?? rich.userId, planId: o.origin === "coach" ? "adhoc-run-x" : "coros-plan", sourceWorkoutId: id, title: o.title ?? "Easy run",
    category: o.category ?? "easy", sport: "run", originalPlanDate: o.date, lastVerifiedCorosDate: o.date, effectiveDate: o.date,
    effectiveTime: o.time ?? "18:00", sourceContentFingerprint: "fp", sourceEstimatedDurationSeconds: (o.minutes ?? 45) * 60,
    calendarBlockDurationSeconds: (o.minutes ?? 45) * 60, completionState: o.state ?? "scheduled", origin: o.origin ?? null,
    workoutDoc: o.doc ? JSON.stringify(studioDoc({ title: o.title ?? "Coach session" })) : null, workoutDocRev: o.doc ? 1 : null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return id;
}

/** A watch-plan run three days on (the fixture's), 45 minutes, no document. */
async function watchRun(): Promise<string> {
  const [row] = await db
    .select({ id: plannedWorkouts.id })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, rich.userId), eq(plannedWorkouts.effectiveDate, day(-3)), eq(plannedWorkouts.category, "easy")));
  return row!.id;
}
/** The next programme session after today's (the fixture's, the day after tomorrow). */
async function nextProgramme(): Promise<string> {
  const [row] = await db
    .select({ id: plannedWorkouts.id })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, rich.userId), eq(plannedWorkouts.effectiveDate, day(-2)), eq(plannedWorkouts.origin, "program")));
  return row!.id;
}

const skip = (workoutId: string, reason = "A flare day: rest the jaw.") => ({ workoutId, change: { kind: "skip", reason }, why: "Today's reading is high; a short relief session replaces it." });
const shorten = (workoutId: string, durationMinutes = 30) => ({ workoutId, change: { kind: "adjust", durationMinutes }, why: "Legs are heavy after the hills: keep it easy and short." });
const moveTo = (workoutId: string, toDate: string, toTime?: string) => ({ workoutId, change: { kind: "move", toDate, ...(toTime ? { toTime } : {}) }, why: "Thursday has more time." });

/** A main run's proposal of these changes and workouts, made pending as the finish leaves it (each workout reviewed). */
async function proposal(o: { changes?: unknown[]; docs?: Array<{ title: string; date: string }>; scope?: RunScope }): Promise<{ id: string; run: ToolContext["run"] }> {
  const r = await mainRun(o.scope ?? { kind: "now" });
  for (const c of o.changes ?? []) ok((await adjust(r, c)).res);
  for (const d of o.docs ?? []) ok(await proposeWorkout.run(ctxOf(r), { doc: calmDoc({ title: d.title }), target: { kind: "new", date: d.date } }));
  const id = designProposalId(r.id);
  const p = (await proposalOf(id))!;
  await db
    .update(coachProposals)
    .set({ status: "pending", ops: p.ops.map((x) => (x.kind === "doc_workout" ? { ...x, review: REVIEW } : x)) })
    .where(eq(coachProposals.id, id));
  return { id, run: r };
}

const ctx = (today = TODAY) => ({ today, now: NOW.toISOString(), prefs });
/** A proposal made `n` seconds after the others: the supersede reads which plan is the newer by when it was made. */
const newer = (id: string, n: number) => db.update(coachProposals).set({ createdAt: new Date(NOW.getTime() + n * 1000).toISOString() }).where(eq(coachProposals.id, id));
async function approve(id: string, input: Parameters<typeof approveDesignOps>[3] = {}, today = TODAY) {
  statements.length = 0;
  return approveDesignOps(db, rich.userId, (await proposalOf(id))! as never, input, ctx(today), Number.POSITIVE_INFINITY);
}
async function decline(id: string, input: Parameters<typeof declineDesignOps>[3] = {}) {
  statements.length = 0;
  return declineDesignOps(db, rich.userId, (await proposalOf(id))! as never, input, NOW.toISOString());
}

// ── coach-apply's rules, extracted ──────────────────────────────────────────────────────────────────────────────────

describe("coach-apply's actionable rule, as one function", () => {
  it("says why a session can't change, in the applier's own words — and nothing for one still to come", () => {
    const row = (o: { archivedAt?: string | null; completionState?: string; effectiveDate?: string }) => ({
      archivedAt: o.archivedAt ?? null,
      completionState: o.completionState ?? "scheduled",
      effectiveDate: o.effectiveDate ?? TODAY,
    });
    expect(whyNotActionable(undefined, TODAY)).toBe(NOT_ACTIONABLE.gone);
    expect(whyNotActionable(row({ archivedAt: NOW.toISOString() }), TODAY)).toBe(NOT_ACTIONABLE.gone);
    expect(whyNotActionable(row({ completionState: "completed" }), TODAY)).toBe(NOT_ACTIONABLE.done);
    expect(whyNotActionable(row({ completionState: "skipped" }), TODAY)).toBe(NOT_ACTIONABLE.skipped);
    expect(whyNotActionable(row({ completionState: "missed" }), TODAY)).toBe(NOT_ACTIONABLE.missed);
    expect(whyNotActionable(row({ effectiveDate: day(1) }), TODAY)).toBe(NOT_ACTIONABLE.past);
    expect(whyNotActionable(row({ completionState: "unresolved" }), TODAY)).toBe(NOT_ACTIONABLE.past);
    expect(whyNotActionable(row({ completionState: "partial" }), TODAY)).toBe("is already partial");
    expect(whyNotActionable(row({}), TODAY)).toBeUndefined();
    expect(whyNotActionable(row({ completionState: "planned", effectiveDate: day(-3) }), TODAY)).toBeUndefined();
    expect(NOT_ACTIONABLE).toEqual({
      gone: "isn't on the calendar any more",
      done: "has already been done",
      skipped: "was already skipped",
      missed: "was already missed",
      past: "has already had its day",
    });
  });
});

// ── adjust_plan ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("adjust_plan: a change to a session already on the plan, into the run's one proposal", () => {
  it("skips today's programme session: one plan_adjust op holding the thread coach's skip — two statements", async () => {
    const r = await mainRun();
    const { res, count } = await adjust(r, skip(rich.outlineToday));
    const out = ok(res);
    expect(count).toBe(2);
    expect(count).toBe(adjustPlan.statementCost);
    const id = designProposalId(r.id);
    const p = (await proposalOf(id))!;
    expect(p.status).toBe("unreviewed");
    const [op] = await planOps(id);
    expect(op).toMatchObject({
      kind: "plan_adjust",
      id: planAdjustId(rich.outlineToday),
      op: { kind: "skip", workoutId: rich.outlineToday, reason: "A flare day: rest the jaw." },
      why: "Today's reading is high; a short relief session replaces it.",
      issues: [],
      date: TODAY,
      row: { date: TODAY, time: "07:00", title: "Strength", minutes: 35, category: "strength", origin: "program", onWatch: false },
      at: NOW.toISOString(),
    });
    expect(opIdOf(op!)).toBe(planAdjustId(rich.outlineToday));
    // The model sees the change as the manifest says it, its own words marked.
    expect(out.data).toMatchObject({
      stored: true,
      proposalId: id,
      opId: planAdjustId(rich.outlineToday),
      // Its words carry a session's name (imported) and the coach's reason (the model's): marked (fix round, 6).
      change: { date: TODAY, summary: { untrusted: true, text: "Strength — skipped" }, effect: { untrusted: true, text: "comes off the plan — A flare day: rest the jaw." } },
      why: { untrusted: true, text: "Today's reading is high; a short relief session replaces it." },
    });
    expect(out.receipt).toEqual({ proposalId: id, opId: planAdjustId(rich.outlineToday), workoutId: rich.outlineToday, change: "skip" });
    // The proposal's fields count it.
    expect(p.title).toBe("Strength — skipped");
    expect(p.expiresAt).toBe(TODAY);
  });

  it("shortens a watch-plan run and moves a programme session", async () => {
    const r = await mainRun();
    const run = await watchRun();
    const prog = await nextProgramme();
    ok((await adjust(r, shorten(run))).res);
    ok((await adjust(r, moveTo(prog, day(-3), "17:30"))).res);
    const ops = await planOps(designProposalId(r.id));
    expect(ops.map((o) => o.op)).toEqual([
      { kind: "adjust", workoutId: run, durationMinutes: 30 },
      { kind: "move", workoutId: prog, toDate: day(-3), toTime: "17:30" },
    ]);
    expect(ops.map((o) => o.date)).toEqual([day(-3), day(-2)]);
  });

  it("refuses to re-time a programme session (ruling 3-R13), teaching the skip and the shorter workout — nothing written", async () => {
    const r = await mainRun();
    const now = refused((await adjust(r, shorten(rich.outlineToday))).res);
    expect(now).toEqual({
      error: "programme_session",
      why: "A programme session can't be re-timed.",
      fix: "Skip it with adjust_plan and propose the shorter workout with propose_workout; both go to the athlete together.",
    });
    // For a set the main coach briefs the workout: propose_workout is the designers'.
    const set = refused((await adjust(await mainRun({ kind: "week" }), shorten(await nextProgramme()))).res);
    expect(set.fix).toBe("Skip it with adjust_plan and brief the shorter workout in plan_set; both go to the athlete together.");
    expect(await proposalOf(designProposalId(r.id))).toBeUndefined();
  });

  it("refuses to re-time a Studio or template workout: it is revised", async () => {
    const r = await mainRun();
    for (const id of [rich.todayDocId, await planned({ date: day(-7), origin: "template", doc: true })]) {
      const e = refused((await adjust(r, shorten(id))).res);
      expect(e.error).toBe("revise_instead");
      expect(e.fix).toBe("Revise it with propose_workout's revise target.");
    }
    // A set's main coach never proposes: it briefs the replacement (fix round, 5).
    const set = refused((await adjust(await mainRun({ kind: "next_n", n: 3 }), shorten(rich.todayDocId))).res);
    expect(set).toMatchObject({ error: "revise_instead", fix: "Brief its replacement in plan_set: a designer revises the workout itself." });
    // Skipping or moving one is the thread coach's lever too, and stays legal.
    ok((await adjust(r, skip(rich.todayDocId))).res);
  });

  it("refuses a move into the past or past the plan this run reads, and a move or a length that changes nothing", async () => {
    const r = await mainRun();
    const run = await watchRun();
    const past = refused((await adjust(r, moveTo(run, day(1)))).res);
    expect(past.error).toBe("past_date");
    expect(past.why).toBe(`${day(1)} is before today (${TODAY}) where the athlete is.`);
    // Now and later today reach today plus seven days (a request may name another day): day 8 is past it.
    expect(refused((await adjust(r, moveTo(run, day(-8)))).res).error).toBe("beyond_horizon");
    ok((await adjust(r, moveTo(run, day(-7)))).res);
    const week = await mainRun({ kind: "week" });
    ok((await adjust(week, moveTo(run, day(-13)))).res);
    expect(refused((await adjust(week, moveTo(run, day(-14)))).res).error).toBe("beyond_horizon");
    // Where it already is, and its own length.
    expect(refused((await adjust(r, moveTo(run, day(-3), "18:00"))).res).error).toBe("no_change");
    expect(refused((await adjust(r, shorten(run, 45))).res).error).toBe("no_change");
  });

  it("refuses a session that can't change, by coach-apply's own rules: done, skipped, missed, its day gone, archived, another athlete's", async () => {
    const r = await mainRun();
    const done = await planned({ date: TODAY, state: "completed" });
    const skipped = await planned({ date: day(-1), state: "skipped" });
    const missed = await planned({ date: TODAY, state: "missed" });
    const gone = await planned({ date: day(2) });
    const archived = await planned({ date: day(-1) });
    await db.update(plannedWorkouts).set({ archivedAt: NOW.toISOString() }).where(eq(plannedWorkouts.id, archived));
    const other = await seedRichAthlete(db);
    const theirs = await planned({ date: day(-1), userId: other.userId });
    const cases: Array<[string, string, string]> = [
      [done, "not_changeable", "That session has already been done."],
      [skipped, "not_changeable", "That session was already skipped."],
      [missed, "not_changeable", "That session was already missed."],
      [gone, "not_changeable", "That session has already had its day."],
      [archived, "not_found", `No planned session of the athlete's has id "${archived}".`],
      [theirs, "not_found", `No planned session of the athlete's has id "${theirs}".`],
    ];
    for (const [id, error, why] of cases) {
      const e = refused((await adjust(r, skip(id))).res);
      expect([e.error, e.why], id).toEqual([error, why]);
    }
    expect(await proposalOf(designProposalId(r.id))).toBeUndefined();
  });

  it("refuses to skip or move the athlete's race", async () => {
    const r = await mainRun({ kind: "week" });
    const race = await planned({ date: day(-5), category: "race", title: "Spring 10K" });
    const s = refused((await adjust(r, skip(race))).res);
    expect(s.error).toBe("race_day");
    expect(s.why).toBe("Mon 18 May holds the athlete's race: a skip would take it off the plan.");
    expect(refused((await adjust(r, moveTo(race, day(-6)))).res).error).toBe("race_day");
  });

  it("keeps one change per workout: a second replaces the first, and a replay of either writes nothing", async () => {
    const r = await mainRun();
    const run = await watchRun();
    ok((await adjust(r, shorten(run, 30), { toolUseId: "toolu_first" })).res);
    const second = ok((await adjust(r, moveTo(run, day(-4)), { toolUseId: "toolu_second" })).res);
    expect(second.data).toMatchObject({ stored: true, replaced: true });
    const id = designProposalId(r.id);
    const ops = await planOps(id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: planAdjustId(run), op: { kind: "move", toDate: day(-4) }, toolUseId: "toolu_second", replaces: ["toolu_first"] });
    const before = (await proposalOf(id))!.ops;
    // A step that died after the write replays the call: the first answers that it was replaced, the second what it stored.
    const first = await adjust(r, shorten(run, 30), { toolUseId: "toolu_first" });
    expect(ok(first.res).data).toMatchObject({ stored: true, superseded: true });
    const again = await adjust(r, moveTo(run, day(-4)), { toolUseId: "toolu_second" });
    expect(ok(again.res).data).toMatchObject({ stored: true, opId: planAdjustId(run) });
    expect(statements.filter((s) => /^\s*(insert|update)/i.test(s))).toEqual([]);
    expect((await proposalOf(id))!.ops).toEqual(before);
  });

  it("never changes a workout the proposal revises, and propose never revises a workout a change touches", async () => {
    const r = await mainRun();
    ok(await proposeWorkout.run(ctxOf(r), { doc: calmDoc({ title: "Calmer" }), target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 2 } }));
    const e = refused((await adjust(r, skip(rich.todayDocId))).res);
    expect(e.error).toBe("target_taken");
    const r2 = await mainRun();
    ok((await adjust(r2, moveTo(rich.todayDocId, day(-1)))).res);
    const p = refused(await proposeWorkout.run(ctxOf(r2), { doc: calmDoc({ title: "Calmer" }), target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 2 } }));
    expect(p.error).toBe("target_taken");
    expect(p.why).toBe("adjust_plan already changes that workout in this proposal.");
  });

  it("keeps a proposal's other ops: a workout proposed after a change, and a change after a workout, both stand", async () => {
    const r = await mainRun();
    ok((await adjust(r, skip(rich.outlineToday))).res);
    ok(await proposeWorkout.run(ctxOf(r), { doc: calmDoc({ title: "Relief" }), target: { kind: "new", date: TODAY } }));
    ok(await proposeWorkout.run(ctxOf(r), { doc: calmDoc({ title: "Relief, softer" }), target: { kind: "new", date: TODAY } }));
    ok((await adjust(r, shorten(await watchRun()))).res);
    const ops = (await proposalOf(designProposalId(r.id)))!.ops;
    expect(ops.map((o) => (o.kind === "doc_workout" ? o.doc.title : o.op.kind))).toEqual(["skip", "Relief, softer", "adjust"]);
    const p = (await proposalOf(designProposalId(r.id)))!;
    expect(p.title).toBe("Relief, softer · 2 plan changes");
    expect(p.expiresAt).toBe(day(-3));
  });

  it("is refused once the proposal is with the athlete, and while the account is restored", async () => {
    const { run } = await proposal({ docs: [{ title: "Relief", date: TODAY }] });
    expect(refused((await adjust(run, skip(rich.outlineToday))).res).error).toBe("proposal_pending");
    const r = await mainRun();
    await db.insert(schema.accountState).values({ userId: rich.userId, restoreId: "restore-1", updatedAt: NOW.toISOString() });
    expect(refused((await adjust(r, skip(rich.outlineToday))).res).error).toBe("restoring");
  });

  it("says when the watch keeps its copy as it is", async () => {
    const r = await mainRun();
    const run = await watchRun();
    await db.update(plannedWorkouts).set({ sourceWorkoutId: "123:456", sourceIdInPlan: "7", sourceProgramId: "p-9" }).where(eq(plannedWorkouts.id, run));
    ok((await adjust(r, shorten(run))).res);
    const [op] = await planOps(designProposalId(r.id));
    expect(op!.row.onWatch).toBe(true);
    expect(op!.issues).toEqual([{ code: "watch_unchanged", message: "The watch keeps its copy as it is: only the plan's length changes." }]);
  });
});

// ── The proposal's fields ───────────────────────────────────────────────────────────────────────────────────────────

describe("a proposal's title, rationale and expiry count its changes", () => {
  it("names the workouts first, then the changes; expires on its last day, a move's destination included", () => {
    const op = (o: Partial<PlanAdjustOp> & Pick<PlanAdjustOp, "op" | "date">): PlanAdjustOp => ({
      kind: "plan_adjust", id: "adj-x", why: "Because.", issues: [], row: { date: o.date, time: "07:00", title: "Strength", minutes: 35, category: "strength", origin: "program", onWatch: false }, toolUseId: "t", at: NOW.toISOString(), ...o,
    });
    const move = op({ op: { kind: "move", workoutId: "w", toDate: day(-5) }, date: day(-1) });
    expect(proposalFields([move])).toMatchObject({ title: "Strength — moved to Mon 18 May", expiresAt: day(-5) });
    const skip1 = op({ op: { kind: "skip", workoutId: "w", reason: "Rest." }, date: TODAY });
    expect(proposalFields([skip1, move])).toMatchObject({ title: "2 plan changes", rationale: "Because. · Because.", expiresAt: day(-5) });
  });
});

// ── Approve ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("approve: each change through the thread coach's own applier", () => {
  it("the flare day: today's programme session skipped as the coach's sanctioned rest, and the relief workout made — one approval", async () => {
    const { id } = await proposal({ changes: [skip(rich.outlineToday)], docs: [{ title: "Five-minute relief", date: TODAY }] });
    const res = await approve(id);
    expect(res.status).toBe("approved");
    expect(res.refused).toEqual([]);
    expect(res.remaining).toEqual([]);
    expect(res.changed).toEqual([
      { opId: planAdjustId(rich.outlineToday), change: "skip", workoutId: rich.outlineToday, before: { date: TODAY, time: "07:00", title: "Strength", minutes: 35 } },
    ]);
    expect(res.applied.map((a) => a.workout.title)).toEqual(["Five-minute relief"]);
    expect(await rowOf(rich.outlineToday)).toMatchObject({ completionState: "skipped", sanctionedBy: "coach", resolutionDate: TODAY });
    const p = (await proposalOf(id))!;
    expect(p.ops.find((o) => o.kind === "plan_adjust")!.outcome).toEqual({
      status: "applied",
      at: NOW.toISOString(),
      workoutId: rich.outlineToday,
      before: { date: TODAY, time: "07:00", title: "Strength", minutes: 35 },
    });
    // The thread's receipt says both.
    const [receipt] = await db.select().from(coachMessages).where(and(eq(coachMessages.userId, rich.userId), eq(coachMessages.role, "receipt")));
    expect(receipt!.body).toMatch(/Wed 13 May · Strength — skipped/);
    expect(receipt!.body).toMatch(/Five-minute relief/);
    // The skip resolved today: the garden's replay of it is on record for its next walk, as the thread's approve's is.
    const [account] = await db.select().from(schema.accountState).where(eq(schema.accountState.userId, rich.userId));
    expect(account?.gardenChangedFrom).toBe(TODAY);
  });

  it("shortens a watch-plan run: the length changed, and with no document no revision is written", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [shorten(run, 30)] });
    const res = await approve(id);
    expect(res.status).toBe("approved");
    expect(await rowOf(run)).toMatchObject({ fallbackEstimatedDurationSeconds: 1800, calendarBlockDurationSeconds: 1800, sourceEstimatedDurationSeconds: null, workoutDoc: null });
    expect(await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, run))).toEqual([]);
  });

  it("shortens the thread coach's own session with a document: the length changed and its revision written, by the coach for this proposal", async () => {
    const own = await planned({ date: day(-1), origin: "coach", doc: true, title: "Hill strides", minutes: 50 });
    const { id } = await proposal({ changes: [shorten(own, 30)] });
    await approve(id);
    const row = await rowOf(own);
    expect(row.fallbackEstimatedDurationSeconds).toBe(1800);
    expect(row.workoutDocRev).toBe(2);
    expect(parseStoredWorkoutDoc(row.workoutDoc)!.setting?.targetMinutes).toBe(30);
    const revs = await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.workoutId, own));
    expect(revs.map((r) => [r.rev, r.sourceKind, r.sourceRef])).toEqual([[2, "coach", id]]);
  });

  it("moves a session to its day and time", async () => {
    const prog = await nextProgramme();
    const { id } = await proposal({ changes: [moveTo(prog, day(-3), "09:00")] });
    const res = await approve(id);
    expect(res.status).toBe("approved");
    expect(await rowOf(prog)).toMatchObject({ effectiveDate: day(-3), effectiveTime: "09:00" });
    expect((await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, prog))).map((o) => [o.kind, o.toDate])).toEqual([["user_move", day(-3)]]);
  });

  it("a session resolved since the coach proposed: that change is refused with why, the others apply", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [skip(rich.outlineToday), shorten(run, 30)], docs: [{ title: "Relief", date: TODAY }] });
    await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, rich.outlineToday));
    const res = await approve(id);
    expect(res.status).toBe("partially_approved");
    expect(res.refused).toEqual([{ opId: planAdjustId(rich.outlineToday), error: "not_editable", cause: "completed", why: "It's done already." }]);
    expect(res.changed.map((c) => c.opId)).toEqual([planAdjustId(run)]);
    expect(res.applied).toHaveLength(1);
    expect(await rowOf(rich.outlineToday)).toMatchObject({ completionState: "completed", sanctionedBy: null });
    const op = (await proposalOf(id))!.ops.find((o) => o.kind === "plan_adjust" && o.op.workoutId === rich.outlineToday)!;
    expect(op.outcome).toMatchObject({ status: "refused", error: "not_editable", cause: "completed" });
  });

  it("refuses at approval a move whose day has passed, and a change of a session archived since", async () => {
    const run = await watchRun();
    const prog = await nextProgramme();
    const { id } = await proposal({ changes: [moveTo(run, day(-1)), skip(prog)] });
    await db.update(plannedWorkouts).set({ archivedAt: NOW.toISOString() }).where(eq(plannedWorkouts.id, prog));
    const res = await approve(id, {}, day(-2));
    expect(res.refused).toEqual([
      { opId: planAdjustId(run), error: "past_date", why: `${"Thu 14 May"} has passed.` },
      { opId: planAdjustId(prog), error: "not_found", why: "It's no longer in the plan." },
    ]);
    expect(await rowOf(run)).toMatchObject({ effectiveDate: day(-3) });
  });

  it("a skip the athlete made themselves since is recorded applied, as the applier's own rule — nothing written", async () => {
    const { id } = await proposal({ changes: [skip(rich.outlineToday)] });
    await db.update(plannedWorkouts).set({ completionState: "skipped", resolutionDate: TODAY }).where(eq(plannedWorkouts.id, rich.outlineToday));
    const res = await approve(id);
    expect(res.status).toBe("approved");
    expect(statements.filter((s) => /^\s*update\s+"planned_workouts"/i.test(s))).toEqual([]);
  });

  it("a second approve does nothing: each change answers how it was settled, and nothing is written", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [skip(rich.outlineToday), shorten(run, 30), moveTo(await nextProgramme(), day(-4))] });
    await approve(id);
    const before = await proposalOf(id);
    const again = await approve(id);
    expect(again.changed).toEqual([]);
    expect(again.settled.map((s) => s.outcome)).toEqual(["applied", "applied", "applied"]);
    expect(statements.filter((s) => /^\s*(insert|update|delete)/i.test(s))).toEqual([]);
    expect(await proposalOf(id)).toEqual(before);
  });

  it("approves some: only the changes named, the rest still the athlete's", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [skip(rich.outlineToday), shorten(run, 30)] });
    const res = await approve(id, { opIds: [planAdjustId(run)] });
    expect(res.status).toBe("partially_approved");
    expect((await rowOf(rich.outlineToday)).completionState).toBe("scheduled");
    expect(statusOfOps((await proposalOf(id))!.ops)).toBe("partially_approved");
  });

  it("a change has no draft: Edit before approve can't name it, and the draft read finds none", async () => {
    const { id } = await proposal({ changes: [skip(rich.outlineToday)], docs: [{ title: "Relief", date: TODAY }] });
    await expect(approve(id, { edit: { opId: planAdjustId(rich.outlineToday), doc: calmDoc() as never } })).rejects.toBeInstanceOf(UnknownOpError);
    expect(designDraft((await proposalOf(id))! as never, planAdjustId(rich.outlineToday))).toBeNull();
  });

  it("each kind's cost is the most it runs, the collision pass's moves counted by the day's sessions", async () => {
    // A busy destination: two more sessions on the move's day, all at one time, so the collision pass re-times them.
    const prog = await nextProgramme();
    await planned({ date: day(-3), time: "18:00", title: "Second run" });
    await planned({ date: day(-3), time: "18:00", title: "Third run" });
    const own = await planned({ date: day(-3), time: "18:00", origin: "coach", doc: true, title: "Coach strides" });
    const measured: Record<string, number> = {};
    for (const [kind, input] of [
      ["skip", skip(rich.outlineToday)],
      ["adjust", shorten(own, 60)],
      ["move", moveTo(prog, day(-3), "18:00")],
    ] as const) {
      const { id } = await proposal({ changes: [input] });
      await approve(id);
      // Less the approve's own: the proposal's write and the receipt (the plan read is the approve's too).
      measured[kind] = statements.length - 3;
    }
    const dayRows = 4; // the fixture's run, the two added runs, the coach's own
    expect(measured.skip).toBeLessThanOrEqual(PLAN_BATCH_FIXED + planOpCostOf({ op: { kind: "skip", workoutId: "w" } } as PlanAdjustOp, 0));
    expect(measured.adjust).toBeLessThanOrEqual(PLAN_BATCH_FIXED + planOpCostOf({ op: { kind: "adjust", workoutId: "w", durationMinutes: 60 } } as PlanAdjustOp, dayRows));
    expect(measured.move).toBeLessThanOrEqual(PLAN_BATCH_FIXED + planOpCostOf({ op: { kind: "move", workoutId: "w", toDate: day(-3) } } as PlanAdjustOp, dayRows));
    expect([SKIP_COST, ADJUST_COST, MOVE_COST]).toEqual([2, 3, 16]);
    expect(planOpCostOf({ op: { kind: "adjust", workoutId: "w", durationMinutes: 1 } } as PlanAdjustOp, 4)).toBe(ADJUST_COST + 4);
    expect(planOpCostOf({ op: { kind: "move", workoutId: "w", toDate: TODAY } } as PlanAdjustOp, 4)).toBe(MOVE_COST + 4 + 1);
    expect(planOpCostOf({ op: { kind: "skip", workoutId: "w" } } as PlanAdjustOp, 4)).toBe(SKIP_COST);
    // The approve plans by one function: a change costs through it as a workout does.
    expect(opCostOf({ op: { kind: "move", workoutId: "w", toDate: TODAY } } as PlanAdjustOp, 4)).toBe(MOVE_COST + 4 + 1);
  });
});

describe("approve: judged again before the applier runs, and planned within the request's budget", () => {
  /** A change as a proposal holds it, rewritten to `op` (one stored before its session became what it is now). */
  async function storedAs(id: string, workoutId: string, op: Record<string, unknown>) {
    const p = (await proposalOf(id))!;
    const ops = p.ops.map((o) => (o.kind === "plan_adjust" ? { ...o, id: planAdjustId(workoutId), op: { ...op, workoutId } } : o));
    await db.update(coachProposals).set({ ops }).where(eq(coachProposals.id, id));
  }

  it("a length for a programme session, or a skip or move of a race, stored before: refused with why — never the applier's (which would skip a race, or throw on moving one)", async () => {
    const prog = await nextProgramme();
    const race = await planned({ date: day(-5), category: "race", title: "Spring 10K" });
    const a = await proposal({ changes: [skip(rich.outlineToday)] });
    await storedAs(a.id, prog, { kind: "adjust", durationMinutes: 20 });
    const b = await proposal({ changes: [skip(await watchRun())] });
    await storedAs(b.id, race, { kind: "skip", reason: "Rest." });
    const c = await proposal({ changes: [skip(await planned({ date: day(-1) }))] });
    await storedAs(c.id, race, { kind: "move", toDate: day(-6) });
    expect((await approve(a.id)).refused).toEqual([{ opId: planAdjustId(prog), error: "not_editable", cause: "programme", why: "It's a programme's session: the programme plans it." }]);
    expect((await approve(b.id)).refused).toEqual([{ opId: planAdjustId(race), error: "race", why: "It's the athlete's race: it stays where it is." }]);
    expect((await approve(c.id)).refused.map((r) => r.error)).toEqual(["race"]);
    expect(await rowOf(race)).toMatchObject({ completionState: "scheduled", effectiveDate: day(-5) });
    expect((await rowOf(prog)).fallbackEstimatedDurationSeconds).toBeNull();
  });

  it("a move or a length already in place is recorded applied with nothing written — the applier is never run", async () => {
    const run = await watchRun();
    const long = await planned({ date: day(-1), minutes: 50 });
    const { id } = await proposal({ changes: [moveTo(run, day(-4)), shorten(long, 30)] });
    const ops = (await proposalOf(id))!.ops as DesignedPlanOp[];
    // Since the coach proposed them, the athlete made both changes by hand.
    await db.update(plannedWorkouts).set({ effectiveDate: day(-4) }).where(eq(plannedWorkouts.id, run));
    await db.update(plannedWorkouts).set({ sourceEstimatedDurationSeconds: 1800 }).where(eq(plannedWorkouts.id, long));
    const res = await approve(id);
    expect(res.status).toBe("approved");
    expect(res.changed.map((c) => c.opId)).toEqual(ops.map((o) => o.id));
    // The approve's own writes only — the proposal's outcomes and the receipt — and no read of the applier's (its
    // threshold read of daily_health is its first statement).
    const writes = statements.filter((s) => /^\s*(insert|update|delete)/i.test(s));
    expect(writes.map((s) => s.match(/^\s*(?:insert into|update)\s+"(\w+)"/i)?.[1])).toEqual(["coach_proposals", "coach_messages"]);
    expect(statements.filter((s) => /daily_health/.test(s))).toEqual([]);
  });

  it("the changes go first and share the applier's fixed part once; what doesn't fit waits — the workouts after them", async () => {
    const one = await planned({ date: day(-1) });
    const two = await planned({ date: day(-2) });
    const { id } = await proposal({ changes: [skip(one), skip(two)], docs: [{ title: "Hips", date: day(-1) }] });
    const workout = (await proposalOf(id))!.ops.find((o) => o.kind === "doc_workout")!.by.runId;
    const room = PLAN_BATCH_FIXED + 2 * SKIP_COST;
    // One short of both skips: the first goes (with the fixed part), the second and the workout wait — each once.
    let res = await approveDesignOps(db, rich.userId, (await proposalOf(id))! as never, {}, ctx(), room - 1);
    expect(res.changed.map((c) => c.workoutId)).toEqual([one]);
    expect(res.remaining).toEqual([planAdjustId(two), workout]);
    // Room for both: the fixed part is paid once.
    const fresh = await proposal({ changes: [skip(await planned({ date: day(-1) })), skip(await planned({ date: day(-2) }))] });
    res = await approveDesignOps(db, rich.userId, (await proposalOf(fresh.id))! as never, {}, ctx(), room);
    expect(res.changed).toHaveLength(2);
    expect(res.remaining).toEqual([]);
  });

  it("a move is costed by the sessions its new day holds: one too many for the room waits", async () => {
    const busy = day(-6);
    await planned({ date: busy, time: "07:00" });
    await planned({ date: busy, time: "12:00" });
    const first = await planned({ date: day(-1) });
    const mover = await planned({ date: day(-2) });
    // The new day holds the fixture's run and the two added: three.
    const dayRows = (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, rich.userId), eq(plannedWorkouts.effectiveDate, busy)))).length;
    const { id } = await proposal({ changes: [skip(first), moveTo(mover, busy)] });
    const room = PLAN_BATCH_FIXED + SKIP_COST + planOpCostOf({ op: { kind: "move", workoutId: mover, toDate: busy } } as PlanAdjustOp, dayRows) - 1;
    const res = await approveDesignOps(db, rich.userId, (await proposalOf(id))! as never, {}, ctx(), room);
    expect(res.changed.map((c) => c.workoutId)).toEqual([first]);
    expect(res.remaining).toEqual([planAdjustId(mover)]);
    expect((await rowOf(mover)).effectiveDate).toBe(day(-2));
  });
});

describe("decline: per change", () => {
  it("declines one change with the athlete's reason; the rest is approved after", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [skip(rich.outlineToday), shorten(run, 30)], docs: [{ title: "Relief", date: TODAY }] });
    const d = await decline(id, { opIds: [planAdjustId(rich.outlineToday)], reason: "I'd rather do the programme today." });
    expect(d.declined).toEqual([planAdjustId(rich.outlineToday)]);
    expect(d.status).toBe("pending");
    const res = await approve(id);
    expect(res.status).toBe("partially_approved");
    expect((await rowOf(rich.outlineToday)).completionState).toBe("scheduled");
    expect((await rowOf(run)).fallbackEstimatedDurationSeconds).toBe(1800);
    const op = (await proposalOf(id))!.ops.find((o) => o.kind === "plan_adjust" && o.op.workoutId === rich.outlineToday)!;
    expect(op.outcome).toEqual({ status: "declined", at: NOW.toISOString(), reason: "I'd rather do the programme today." });
  });

  it("declining every change and workout declines the proposal: left as planned", async () => {
    const { id } = await proposal({ changes: [skip(rich.outlineToday)] });
    const d = await decline(id);
    expect(d.status).toBe("declined");
    const [receipt] = await db.select().from(coachMessages).where(and(eq(coachMessages.userId, rich.userId), eq(coachMessages.role, "receipt")));
    expect(receipt!.body).toBe("Left as planned — Strength — skipped");
  });
});

// ── Supersede ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("a newer plan supersedes an older one's change of the same workout", () => {
  async function older() {
    const run = await watchRun();
    const a = await proposal({ changes: [shorten(run, 30)], docs: [{ title: "Hips", date: day(-1) }] });
    return { run, a };
  }

  it("a newer change of the same workout supersedes the older change; its other ops stand", async () => {
    const { run, a } = await older();
    const b = await proposal({ changes: [moveTo(run, day(-4))] });
    await newer(b.id, 1);
    statements.length = 0;
    expect(await supersedeOlderPlans(db, rich.userId, b.id, NOW.toISOString())).toBe(1);
    expect(statements).toHaveLength(1);
    const p = (await proposalOf(a.id))!;
    expect(p.ops.map((o) => [o.kind, o.outcome?.status ?? "open"])).toEqual([["plan_adjust", "superseded"], ["doc_workout", "open"]]);
    expect(p.status).toBe("pending");
  });

  it("a newer revision of a workout supersedes an older change of it, and a newer change supersedes an older revision", async () => {
    const a = await proposal({ changes: [moveTo(rich.todayDocId, day(-1))] });
    const r = await mainRun();
    ok(await proposeWorkout.run(ctxOf(r), { doc: calmDoc({ title: "Calmer" }), target: { kind: "revise", workoutId: rich.todayDocId, baseRev: 2 } }));
    const b = designProposalId(r.id);
    await db.update(coachProposals).set({ status: "pending", createdAt: new Date(NOW.getTime() + 1000).toISOString() }).where(eq(coachProposals.id, b));
    await supersedeOlderPlans(db, rich.userId, b, NOW.toISOString());
    expect((await proposalOf(a.id))!).toMatchObject({ status: "superseded", supersededBy: b });

    const r2 = await mainRun();
    ok((await adjust(r2, skip(rich.todayDocId))).res);
    const c = designProposalId(r2.id);
    await db.update(coachProposals).set({ status: "pending", createdAt: new Date(NOW.getTime() + 2000).toISOString() }).where(eq(coachProposals.id, c));
    await supersedeOlderPlans(db, rich.userId, c, NOW.toISOString());
    expect((await proposalOf(b))!.ops[0]!.outcome).toMatchObject({ status: "superseded", by: c });
  });

  it("a change never supersedes a new workout, and a new workout never supersedes a change", async () => {
    const run = await watchRun();
    const a = await proposal({ changes: [skip(run)], docs: [{ title: "Hips", date: day(-3) }] });
    const r = await mainRun();
    ok((await adjust(r, skip(rich.outlineToday))).res);
    ok(await proposeWorkout.run(ctxOf(r), { doc: calmDoc({ title: "Other" }), target: { kind: "new", date: day(-1) } }));
    const b = designProposalId(r.id);
    await db.update(coachProposals).set({ status: "pending", createdAt: new Date(NOW.getTime() + 1000).toISOString() }).where(eq(coachProposals.id, b));
    expect(await supersedeOlderPlans(db, rich.userId, b, NOW.toISOString())).toBe(0);
    expect((await proposalOf(a.id))!.ops.every((o) => !o.outcome)).toBe(true);
  });

  it("an older proposal whose every op is decided takes its status from both kinds", async () => {
    const run = await watchRun();
    const a = await proposal({ changes: [shorten(run, 30)], docs: [{ title: "Hips", date: day(-1) }] });
    await approve(a.id, { opIds: [(await proposalOf(a.id))!.ops.find((o) => o.kind === "doc_workout")!.by.runId] });
    const b = await proposal({ changes: [shorten(run, 25)] });
    await db.update(coachProposals).set({ createdAt: new Date(NOW.getTime() + 1000).toISOString() }).where(eq(coachProposals.id, b.id));
    await supersedeOlderPlans(db, rich.userId, b.id, NOW.toISOString());
    const p = (await proposalOf(a.id))!;
    expect(p.status).toBe("partially_approved");
    expect(statusOfOps(p.ops)).toBe("partially_approved");
  });
});

// ── Manifest lines, read_proposals ──────────────────────────────────────────────────────────────────────────────────

describe("the manifest: one line per change, in the thread coach's own words, with the coach's why", () => {
  it("skip, move and shorten, as describeOps says them", async () => {
    const run = await watchRun();
    const prog = await nextProgramme();
    const { id } = await proposal({ changes: [skip(rich.outlineToday), moveTo(prog, day(-3), "17:30"), shorten(run, 30)] });
    const lines = planChangeLines((await proposalOf(id))!.ops as never);
    expect(lines).toEqual([
      { opId: planAdjustId(rich.outlineToday), kind: "skip", workoutId: rich.outlineToday, date: TODAY, time: null, summary: "Strength — skipped", was: null, effect: "comes off the plan — A flare day: rest the jaw.", why: "Today's reading is high; a short relief session replaces it.", issues: expect.any(Array), outcome: null },
      { opId: planAdjustId(prog), kind: "move", workoutId: prog, date: day(-3), time: "17:30", summary: "Strength", was: "Fri 15 May", effect: null, why: "Thursday has more time.", issues: expect.any(Array), outcome: null },
      { opId: planAdjustId(run), kind: "adjust", workoutId: run, date: day(-3), time: null, summary: "Easy run — 30 min", was: "45 min", effect: null, why: "Legs are heavy after the hills: keep it easy and short.", issues: expect.any(Array), outcome: null },
    ]);
  });
});

describe("read_proposals reports each change and how it ended", () => {
  it("the change, the session, the coach's words marked, and the outcome", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [skip(rich.outlineToday), shorten(run, 30)] });
    await decline(id, { opIds: [planAdjustId(rich.outlineToday)], reason: "Not today." });
    await approve(id);
    const res = ok(await readProposals.run(ctxOf(await mainRun()), {}));
    const p = (res.data as { proposals: Array<{ id: string; ops: unknown[] }> }).proposals.find((x) => x.id === id)!;
    expect(p.ops).toEqual([
      { kind: "plan_adjust", change: "skip", date: TODAY, title: { untrusted: true, text: "Strength" }, skipReason: { untrusted: true, text: "A flare day: rest the jaw." }, why: { untrusted: true, text: "Today's reading is high; a short relief session replaces it." }, outcome: "declined", reason: { untrusted: true, text: "Not today." } },
      { kind: "plan_adjust", change: "adjust", date: day(-3), title: { untrusted: true, text: "Easy run" }, minutes: 30, why: { untrusted: true, text: "Legs are heavy after the hills: keep it easy and short." }, outcome: "approved" },
    ]);
  });
});

// ── The thread coach's readers ──────────────────────────────────────────────────────────────────────────────────────

describe("the thread coach's readers tolerate a change in a designed proposal", () => {
  it("a change is a designed op: never one of the thread coach's ops, and a proposal of changes alone is a designed one", async () => {
    const { id } = await proposal({ changes: [skip(rich.outlineToday)] });
    const ops = (await proposalOf(id))!.ops;
    expect(isDesignedProposal(ops)).toBe(true);
    expect(coachOpsOf(ops)).toEqual([]);
    expect(coachOpsOf([{ kind: "skip", workoutId: "w" }, ...ops])).toEqual([{ kind: "skip", workoutId: "w" }]);
    expect(isDesignedProposal([{ kind: "skip", workoutId: "w" }])).toBe(false);
  });
});

// ── Review fix round ────────────────────────────────────────────────────────────────────────────────────────────────

describe("fix round 1: a change is claimed before the applier runs", () => {
  const sqlite = () => (db as unknown as { $client: { prepare(q: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown } } }).$client;
  /** Another request's write to the proposal's ops, landed as it would be: straight to the table. */
  const writeOps = (id: string, edit: (ops: Array<Record<string, unknown>>) => void) => {
    const row = sqlite().prepare("select ops from coach_proposals where id = ?").get(id) as { ops: string };
    const ops = JSON.parse(row.ops) as Array<Record<string, unknown>>;
    edit(ops);
    sqlite().prepare("update coach_proposals set ops = ? where id = ?").run(JSON.stringify(ops), id);
  };
  /** Lands `write` just before the `n`th statement this approve runs that matches `pattern`. */
  const raceAt = (pattern: RegExp, write: () => void, n = 1) => {
    let seen = 0;
    beforeStatement = (sql) => {
      if (!pattern.test(sql) || ++seen < n) return;
      beforeStatement = null;
      write();
    };
  };
  const changeOf = async (id: string, workoutId: string) => (await proposalOf(id))!.ops.find((o) => o.kind === "plan_adjust" && o.op.workoutId === workoutId) as DesignedPlanOp;
  const UPDATE_PROPOSAL = /^update "coach_proposals"/;
  /** The applier's first statement: its threshold read. */
  const APPLIER = /daily_health/;
  /** An approve whose request dies inside the applier, after its claim: nothing of it runs on — not even its catch. */
  async function approveDying(id: string, input: Parameters<typeof approveDesignOps>[3] = {}) {
    let dead = false;
    beforeStatement = (sql) => {
      if (!dead && !APPLIER.test(sql)) return;
      dead = true;
      throw new Error("the request died");
    };
    try {
      await expect(approve(id, input)).rejects.toThrow("the request died");
    } finally {
      beforeStatement = null;
    }
  }
  /** The proposal's claims made `ms` before now (the window's length: stale). */
  const claimedAgo = (id: string, ms = APPLYING_STALE_MS) =>
    writeOps(id, (ops) => {
      for (const o of ops) {
        const out = o.outcome as { status?: string; at?: string } | undefined;
        if (out?.status === "applying") out.at = new Date(NOW.getTime() - ms).toISOString();
      }
    });

  it("the claim: the changes are written `applying`, with the session as it stood, before the applier runs — one statement more", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [shorten(run, 30)] });
    let claimed: unknown = null;
    raceAt(APPLIER, () => {
      claimed = (JSON.parse((sqlite().prepare("select ops from coach_proposals where id = ?").get(id) as { ops: string }).ops) as Array<{ outcome?: unknown }>)[0]!.outcome;
    });
    await approve(id);
    expect(claimed).toEqual({ status: "applying", at: NOW.toISOString(), before: { date: day(-3), time: "18:00", title: "Easy run", minutes: 45 } });
    expect((await changeOf(id, run)).outcome).toMatchObject({ status: "applied", before: { minutes: 45 } });
    // The claim, and its release when the applier throws (the recovery rule, 4): one statement each.
    expect(PLAN_BATCH_FIXED).toBe(9);
    expect(statusOfOps([{ outcome: { status: "applying" } } as never, { outcome: { status: "applied" } } as never])).toBe("partially_approved");
    expect(statusOfOps([{ outcome: { status: "applying" } } as never])).toBe("pending");
  });

  it("R1: a decline landing before the claim: the claim loses, nothing is applied, the decline stands", async () => {
    const { id } = await proposal({ changes: [skip(rich.outlineToday)] });
    raceAt(UPDATE_PROPOSAL, () => writeOps(id, (ops) => (ops[0]!.outcome = { status: "declined", at: "elsewhere" })));
    await expect(approve(id)).rejects.toMatchObject({ name: "ProposalChangedError" });
    expect((await rowOf(rich.outlineToday)).completionState).toBe("scheduled");
    expect((await changeOf(id, rich.outlineToday)).outcome).toEqual({ status: "declined", at: "elsewhere" });
  });

  it("R1: a decline landing while a change is applying: that change is in flight — the others declined — and the approve that finishes it records it applied", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [skip(rich.outlineToday), shorten(run, 30)] });
    // The approve dies inside the applier, after its claim: the skip is applying.
    await approveDying(id, { opIds: [planAdjustId(rich.outlineToday)] });
    expect((await changeOf(id, rich.outlineToday)).outcome).toMatchObject({ status: "applying" });
    const d = await decline(id, { reason: "Not now." });
    expect(d.inFlight).toEqual([planAdjustId(rich.outlineToday)]);
    expect(d.declined).toEqual([planAdjustId(run)]);
    expect((await changeOf(id, rich.outlineToday)).outcome).toMatchObject({ status: "applying" });
    // Within the window the claim is the approve's that made it: another approve leaves it in flight.
    expect((await approve(id)).inFlight).toEqual([planAdjustId(rich.outlineToday)]);
    expect((await rowOf(rich.outlineToday)).completionState).toBe("scheduled");
    // Past it, asked again, the approve finishes the change it claimed: the record matches the plan.
    await claimedAgo(id);
    const again = await approve(id);
    expect(again.changed.map((c) => c.opId)).toEqual([planAdjustId(rich.outlineToday)]);
    expect((await rowOf(rich.outlineToday)).completionState).toBe("skipped");
    expect((await changeOf(id, rich.outlineToday)).outcome).toMatchObject({ status: "applied", before: { date: TODAY, title: "Strength" } });
    expect((await rowOf(run)).fallbackEstimatedDurationSeconds).toBeNull();
    expect((await proposalOf(id))!.status).toBe("partially_approved");
  });

  it("R2: a supersede landing before the claim: the claim loses and nothing is applied; one landing after it leaves the applying change alone", async () => {
    const run = await watchRun();
    const a = await proposal({ changes: [shorten(run, 30)] });
    raceAt(UPDATE_PROPOSAL, () => writeOps(a.id, (ops) => (ops[0]!.outcome = { status: "superseded", at: "x", reason: "a newer plan covers this session", by: "dp-newer" })));
    await expect(approve(a.id)).rejects.toMatchObject({ name: "ProposalChangedError" });
    expect((await rowOf(run)).fallbackEstimatedDurationSeconds).toBeNull();

    // After the claim: a newer plan changing the same session supersedes nothing while the change is applying.
    const b = await proposal({ changes: [shorten(run, 25)] });
    await approveDying(b.id);
    const c = await proposal({ changes: [moveTo(run, day(-4))] });
    await newer(c.id, 5);
    expect(await supersedeOlderPlans(db, rich.userId, c.id, NOW.toISOString())).toBe(0);
    expect((await changeOf(b.id, run)).outcome).toMatchObject({ status: "applying" });
    await claimedAgo(b.id);
    await approve(b.id);
    expect((await changeOf(b.id, run)).outcome).toMatchObject({ status: "applied", before: { minutes: 45 } });
    expect((await rowOf(run)).fallbackEstimatedDurationSeconds).toBe(1500);
  });

  it("a change claimed by an approve that died keeps its claim's `before` when asked again — even after its session changed meanwhile", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [moveTo(run, day(-4))] });
    await approveDying(id);
    // Meanwhile the athlete moved the run's time by hand: the claim still says how the session stood when it was claimed.
    await db.update(plannedWorkouts).set({ effectiveTime: "06:30" }).where(eq(plannedWorkouts.id, run));
    await claimedAgo(id);
    const again = await approve(id);
    expect(again.changed).toEqual([{ opId: planAdjustId(run), change: "move", workoutId: run, before: { date: day(-3), time: "18:00", title: "Easy run", minutes: 45 } }]);
    expect((await changeOf(id, run)).outcome).toMatchObject({ status: "applied", before: { time: "18:00" } });
    expect((await rowOf(run)).effectiveDate).toBe(day(-4));
  });

  it("R3: the write after the applier loses: asked again, the change is recorded applied with the session as it stood before — never as it stands after", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [shorten(run, 30), skip(rich.outlineToday)] });
    // The second write to the proposal (the outcomes, after the applier) loses to another request.
    raceAt(UPDATE_PROPOSAL, () => writeOps(id, (ops) => (ops[1]!.outcome = { status: "declined", at: "elsewhere" })), 2);
    await expect(approve(id, { opIds: [planAdjustId(run)] })).rejects.toMatchObject({ name: "ProposalChangedError" });
    expect((await rowOf(run)).fallbackEstimatedDurationSeconds).toBe(1800);
    // The claim is still within its window, but its change is made: recorded, nothing in flight, the applier not run.
    const again = await approve(id, { opIds: [planAdjustId(run)] });
    expect(again).not.toHaveProperty("inFlight");
    expect(statements.some((s) => APPLIER.test(s))).toBe(false);
    expect(again.changed).toEqual([{ opId: planAdjustId(run), change: "adjust", workoutId: run, before: { date: day(-3), time: "18:00", title: "Easy run", minutes: 45 } }]);
    expect((await changeOf(id, run)).outcome).toMatchObject({ status: "applied", before: { minutes: 45 } });
    expect((await changeOf(id, rich.outlineToday)).outcome).toEqual({ status: "declined", at: "elsewhere" });
  });

  describe("the recovery rule: a claim no request finishes (the Task 9 review)", () => {
    const claimOn = (ops: Array<Record<string, unknown>>, workoutId: string, outcome: unknown) => {
      ops.find((o) => o.kind === "plan_adjust" && (o.op as { workoutId: string }).workoutId === workoutId)!.outcome = outcome;
    };
    const writes = () => statements.filter((s) => /^\s*(insert|update|delete)/i.test(s));
    const receipts = async () => (await db.select().from(coachMessages).where(and(eq(coachMessages.userId, rich.userId), eq(coachMessages.role, "receipt")))).length;

    it("a claim under two minutes old is the approve's that made it: another approve answers it in flight and runs nothing of it, the others go on; at two minutes it is stale and taken over", async () => {
      expect(APPLYING_STALE_MS).toBe(2 * 60_000);
      const run = await watchRun();
      const { id } = await proposal({ changes: [skip(rich.outlineToday), shorten(run, 30)] });
      const skipId = planAdjustId(rich.outlineToday);
      // Another approve claimed the skip a moment under two minutes ago, and is applying it still.
      const claim = { status: "applying", at: new Date(NOW.getTime() - (APPLYING_STALE_MS - 1)).toISOString(), before: { date: TODAY, time: "07:00", title: "Strength", minutes: 40 } };
      writeOps(id, (ops) => claimOn(ops, rich.outlineToday, claim));
      const told = await receipts();
      const res = await approve(id);
      expect(res.inFlight).toEqual([skipId]);
      // No receipt while a change is in flight: the approve that finishes it writes the one.
      expect(await receipts()).toBe(told);
      expect(res.changed.map((c) => c.opId)).toEqual([planAdjustId(run)]);
      expect(res.remaining).toEqual([]);
      expect(res.status).toBe("partially_approved");
      expect((await rowOf(rich.outlineToday)).completionState).toBe("scheduled");
      expect((await changeOf(id, rich.outlineToday)).outcome).toEqual(claim);
      // Named alone: in flight, and nothing written.
      const before = (await proposalOf(id))!.ops;
      const alone = await approve(id, { opIds: [skipId] });
      expect(alone).toEqual({ status: "partially_approved", applied: [], changed: [], refused: [], settled: [], remaining: [], inFlight: [skipId] });
      expect(writes()).toEqual([]);
      expect((await proposalOf(id))!.ops).toEqual(before);
      // Two minutes on, the claim is stale: the approve takes it over, with the claim's `before`.
      await claimedAgo(id);
      const over = await approve(id);
      expect(over).not.toHaveProperty("inFlight");
      expect(over.changed).toEqual([{ opId: skipId, change: "skip", workoutId: rich.outlineToday, before: claim.before }]);
      expect((await rowOf(rich.outlineToday)).completionState).toBe("skipped");
      expect((await proposalOf(id))!.status).toBe("approved");
      expect(await receipts()).toBe(told + 1);
    });

    it("the release: a throw in the applier puts its claims back, stale at once with their `before` — one statement — so the next approve takes them over", async () => {
      const run = await watchRun();
      const { id } = await proposal({ changes: [shorten(run, 30)] });
      let thrownAt = -1;
      beforeStatement = (sql) => {
        if (thrownAt >= 0 || !APPLIER.test(sql)) return;
        thrownAt = statements.length;
        throw new Error("the applier threw");
      };
      await expect(approve(id)).rejects.toThrow("the applier threw");
      beforeStatement = null;
      // After the throw, one statement: the release, under the guard every write of the proposal has.
      expect(statements.slice(thrownAt).map((s) => s.match(/^\s*(?:insert into|update|select)\s+"?(\w+)"?/i)?.[1])).toEqual(["coach_proposals"]);
      const out = (await changeOf(id, run)).outcome as Extract<PlanOpOutcome, { status: "applying" }>;
      expect(out).toMatchObject({ status: "applying", before: { date: day(-3), time: "18:00", title: "Easy run", minutes: 45 } });
      expect(NOW.getTime() - Date.parse(out.at)).toBeGreaterThanOrEqual(APPLYING_STALE_MS);
      expect((await proposalOf(id))!.status).toBe("pending");
      const again = await approve(id);
      expect(again).not.toHaveProperty("inFlight");
      expect(again.changed).toEqual([{ opId: planAdjustId(run), change: "adjust", workoutId: run, before: { date: day(-3), time: "18:00", title: "Easy run", minutes: 45 } }]);
      expect((await rowOf(run)).fallbackEstimatedDurationSeconds).toBe(1800);
    });

    it("a decline re-judges a claim past the window on the plan read it declares: one not made is declined, one made recorded applied with the claim's `before` — a skip's day put on the garden's replay", async () => {
      const run = await watchRun();
      const { id } = await proposal({ changes: [skip(rich.outlineToday), shorten(run, 30)] });
      await approveDying(id);
      // The skip was made before the request died (the applier's own write); the length never was.
      await db.update(plannedWorkouts).set({ completionState: "skipped", resolutionDate: TODAY }).where(eq(plannedWorkouts.id, rich.outlineToday));
      const claim = (await changeOf(id, rich.outlineToday)).outcome as Extract<PlanOpOutcome, { status: "applying" }>;
      await claimedAgo(id);
      const d = await decline(id, { reason: "Not now." });
      // The proposal (the route's read), the plan read, the write and the replay; no "Left as planned": the proposal is
      // approved in part.
      expect(statements).toHaveLength(4);
      expect(d).toEqual({
        status: "partially_approved",
        declined: [planAdjustId(run)],
        settled: [{ opId: planAdjustId(rich.outlineToday), outcome: "applied", workoutId: rich.outlineToday }],
      });
      expect((await changeOf(id, rich.outlineToday)).outcome).toEqual({ status: "applied", at: NOW.toISOString(), workoutId: rich.outlineToday, before: claim.before });
      expect((await changeOf(id, run)).outcome).toEqual({ status: "declined", at: NOW.toISOString(), reason: "Not now." });
      expect((await rowOf(run)).fallbackEstimatedDurationSeconds).toBeNull();
      const [account] = await db.select().from(schema.accountState).where(eq(schema.accountState.userId, rich.userId));
      expect(account?.gardenChangedFrom).toBe(TODAY);
      expect(await db.select().from(coachMessages).where(and(eq(coachMessages.userId, rich.userId), eq(coachMessages.role, "receipt")))).toEqual([]);
    });

    it("the expiry sweep never expires a proposal under a fresh claim, and re-judges a stale one first — made or not, a session past included — one a sweep", async () => {
      // Days on: every session these change has passed, b's moved one too. The fixture's own proposals expire first.
      const later = day(-5);
      await sweepExpiredProposals(db, rich.userId, later);
      const run = await watchRun();
      const prog = await nextProgramme();
      const a = await proposal({ changes: [shorten(run, 30)] });
      const b = await proposal({ changes: [moveTo(prog, day(-4))] });
      const c = await proposal({ changes: [skip(rich.outlineToday)] });
      for (const p of [a, b, c]) await approveDying(p.id);
      await claimedAgo(a.id, 1000);
      await claimedAgo(b.id);
      await claimedAgo(c.id);
      // b's move was made before its request died; c's skip never was.
      await db.update(plannedWorkouts).set({ effectiveDate: day(-4) }).where(eq(plannedWorkouts.id, prog));
      const bBefore = ((await changeOf(b.id, prog)).outcome as Extract<PlanOpOutcome, { status: "applying" }>).before;
      await db.update(coachProposals).set({ expiresAt: TODAY }).where(inArray(coachProposals.id, [a.id, b.id, c.id]));
      statements.length = 0;
      expect(await sweepExpiredProposals(db, rich.userId, later)).toBe(1);
      // The read, the one re-judged (its plan read and replay), its expiry and receipt.
      expect(statements.length).toBeLessThanOrEqual(1 + REJUDGE_COST + 2);
      expect(await sweepExpiredProposals(db, rich.userId, later)).toBe(1);
      expect(await sweepExpiredProposals(db, rich.userId, later)).toBe(0);
      expect((await proposalOf(a.id))!.status).toBe("pending");
      expect((await changeOf(a.id, run)).outcome).toMatchObject({ status: "applying" });
      expect((await proposalOf(b.id))!.status).toBe("expired");
      expect((await changeOf(b.id, prog)).outcome).toEqual({ status: "applied", at: NOW.toISOString(), workoutId: prog, before: bBefore });
      expect((await proposalOf(c.id))!.status).toBe("expired");
      expect((await changeOf(c.id, rich.outlineToday)).outcome).toBeUndefined();
      // Past its window, a's claim is re-judged too: never made, released.
      await claimedAgo(a.id);
      expect(await sweepExpiredProposals(db, rich.userId, later)).toBe(1);
      expect((await proposalOf(a.id))!.status).toBe("expired");
      expect((await changeOf(a.id, run)).outcome).toBeUndefined();
    });

    it("a claim written between the sweep's read and its write wins: the proposal is not expired under it", async () => {
      await sweepExpiredProposals(db, rich.userId, day(-5));
      const run = await watchRun();
      const { id } = await proposal({ changes: [shorten(run, 30)] });
      await db.update(coachProposals).set({ expiresAt: TODAY }).where(eq(coachProposals.id, id));
      const claim = { status: "applying", at: NOW.toISOString(), before: { date: day(-3), time: "18:00", title: "Easy run", minutes: 45 } };
      raceAt(UPDATE_PROPOSAL, () => writeOps(id, (ops) => claimOn(ops, run, claim)));
      expect(await sweepExpiredProposals(db, rich.userId, day(-5))).toBe(0);
      expect((await proposalOf(id))!.status).toBe("pending");
      expect((await changeOf(id, run)).outcome).toEqual(claim);
    });
  });
});

describe("fix round 3: a skip the applier made before a request died", () => {
  it("a skip and a move whose move fails: asked again, the skip is found made, its day's garden replay put on record, and the move applied", async () => {
    const prog = await nextProgramme();
    const { id } = await proposal({ changes: [skip(rich.outlineToday), moveTo(prog, day(-4))] });
    beforeStatement = (sql) => {
      if (!/^insert into "schedule_overrides"/.test(sql)) return;
      beforeStatement = null;
      throw new Error("the move failed");
    };
    await expect(approve(id)).rejects.toThrow("the move failed");
    expect((await rowOf(rich.outlineToday)).completionState).toBe("skipped");
    const account = async () => (await db.select().from(schema.accountState).where(eq(schema.accountState.userId, rich.userId)))[0];
    expect((await account())?.gardenChangedFrom ?? null).toBeNull();
    const again = await approve(id);
    expect(again.status).toBe("approved");
    expect(again.changed.map((c) => c.change)).toEqual(["skip", "move"]);
    expect((await account())?.gardenChangedFrom).toBe(TODAY);
    expect((await rowOf(prog)).effectiveDate).toBe(day(-4));
  });

  it("the garden's replay and the drain's read never turn an applied change into an error", async () => {
    const { id } = await proposal({ changes: [skip(rich.outlineToday)] });
    beforeStatement = (sql) => {
      if (/^insert into "account_state"/.test(sql)) throw new Error("account_state unavailable");
    };
    const res = await approve(id);
    expect(res.status).toBe("approved");
    expect((await rowOf(rich.outlineToday)).completionState).toBe("skipped");
  });

  it("the drain's read failing never turns an applied move into an error: the move is recorded applied", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [moveTo(run, day(-4))] });
    // Its one read of the watch's queue (the move itself queues no watch job with the athlete's writes off).
    beforeStatement = (sql) => {
      if (/from "coros_write_jobs"/.test(sql)) throw new Error("coros_write_jobs unavailable");
    };
    const res = await approve(id);
    expect(res.status).toBe("approved");
    expect(res).not.toHaveProperty("coachDrain");
    expect((await rowOf(run)).effectiveDate).toBe(day(-4));
  });
});

describe("fix round 4: caps", () => {
  it("at most ten changes in a proposal: the eleventh is refused, teachably; a change of one already there still replaces it", async () => {
    const r = await mainRun();
    const rows: string[] = [];
    for (let i = 0; i < 11; i++) rows.push(await planned({ date: day(-(i % 7)), time: `0${i % 10}:15` }));
    for (const id of rows.slice(0, 10)) ok((await adjust(r, skip(id))).res);
    const e = refused((await adjust(r, skip(rows[10]!))).res);
    expect(e).toMatchObject({ error: "too_many_changes" });
    expect(e.why).toBe("This proposal already holds 10 changes to planned sessions, the most one proposal holds.");
    ok((await adjust(r, moveTo(rows[0]!, day(-1)))).res);
    expect(await planOps(designProposalId(r.id))).toHaveLength(10);
  });

  it("a change's session must fall inside the run's reach: today plus seven days for now and later today, the plan read for a set", async () => {
    const far = await planned({ date: day(-21) });
    const e = refused((await adjust(await mainRun(), skip(far))).res);
    expect(e.error).toBe("beyond_horizon");
    expect(e.why).toBe(`That session is on ${day(-21)}, past the plan this run reads (to ${day(-7)}).`);
    ok((await adjust(await mainRun({ kind: "next_n", n: 14 }), skip(far))).res);
    expect(refused((await adjust(await mainRun({ kind: "week" }), skip(far))).res).error).toBe("beyond_horizon");
  });

  it("a declined or superseded change is settled without the plan read reading its session", async () => {
    const run = await watchRun();
    const { id } = await proposal({ changes: [shorten(run, 30)], docs: [{ title: "Hips", date: day(-1) }] });
    await decline(id, { opIds: [planAdjustId(run)] });
    // Every raw statement's bound values, as drizzle binds them (the plan read is one).
    const bound: unknown[][] = [];
    const all = db.all.bind(db);
    (db as unknown as { all: (q: unknown) => unknown }).all = (q: unknown) => {
      bound.push((db as unknown as { dialect: { sqlToQuery(q: unknown): { params: unknown[] } } }).dialect.sqlToQuery(q).params);
      return all(q as never);
    };
    const res = await approve(id);
    expect(res.applied).toHaveLength(1);
    expect(res.settled).toEqual([{ opId: planAdjustId(run), outcome: "declined" }]);
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.flat()).not.toContain(run);
  });
});

describe("fix round 7: the sanctioned rest the thread coach is held to", () => {
  it("a skip past the rolling week's allowance gets the thread coach's advisory note, and the result counts it", async () => {
    const r = await mainRun();
    const first = ok((await adjust(r, skip(rich.outlineToday))).res);
    expect((first.data as { sanctionedRest: unknown }).sanctionedRest).toEqual({ usedThisWeek: 0, inProposal: 1, allowance: SANCTIONED_REST_PER_ROLLING_WEEK });
    expect((await planOps(designProposalId(r.id)))[0]!.issues).toEqual([]);
    const second = ok((await adjust(r, skip(await watchRun()))).res);
    expect((second.data as { sanctionedRest: unknown }).sanctionedRest).toEqual({ usedThisWeek: 0, inProposal: 2, allowance: 1 });
    const [, op] = await planOps(designProposalId(r.id));
    expect(op!.issues).toEqual([
      { code: "sanctioned_rest", message: "This would be the 2nd sanctioned skip in a rolling week: only the first counts as a rest day for the garden; further ones are merely neutral." },
    ]);
  });

  it("counts the week's sanctioned skips already resolved, as the thread coach's dossier does — and holds its number", async () => {
    await planned({ date: day(2), state: "skipped" });
    await db.update(plannedWorkouts).set({ sanctionedBy: "coach", resolutionDate: day(2) }).where(eq(plannedWorkouts.effectiveDate, day(2)));
    // One a week ago — the day before the rolling week's first — counts for nothing.
    await planned({ date: day(7), state: "skipped" });
    await db.update(plannedWorkouts).set({ sanctionedBy: "coach", resolutionDate: day(7) }).where(eq(plannedWorkouts.effectiveDate, day(7)));
    const res = ok((await adjust(await mainRun(), skip(rich.outlineToday))).res);
    expect((res.data as { sanctionedRest: unknown }).sanctionedRest).toEqual({ usedThisWeek: 1, inProposal: 1, allowance: 1 });
    const [op] = (await proposalOf((res.data as { proposalId: string }).proposalId))!.ops as DesignedPlanOp[];
    expect(op!.issues.map((i) => i.code)).toEqual(["sanctioned_rest"]);
    const dossier = await buildDossier(db, rich.userId, prefs, TODAY);
    expect(dossier.text).toContain(`sanctioned rest used 1 of ${SANCTIONED_REST_PER_ROLLING_WEEK} this rolling week`);
  });
});
