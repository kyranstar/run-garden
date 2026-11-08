/**
 * DRAFTING A PLAN'S NEXT STRETCH (plans with a purpose §4.2; rulings R51–R54): the hourly pass starts one coach run for a
 * coach plan that continues and is ending — once per ending, however many passes see it — and the plan's prompt reads where
 * that draft stands. The fake model only (a scripted one, through the real loop and tools); no key, no network, no stepper
 * but a stand-in that records what it is told. Synthetic data only, on a fixed clock (today Wed 13 May 2026).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, PLAN_DRAFT_NOTES, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { hourly } from "../src/index.js";
import { readCoachOpening, readNudges } from "../src/services/coach-nudges.js";
import { createRun, currentRun, LIVE_STATUSES, runStep, RunKeyTakenError, RUN_CEILING_MICROS, type RunDeps } from "../src/services/coach-runs.js";
import { STEPPER_LEASE_SET_MS } from "../src/services/coach-run-stepper.js";
import { conversationBlock, conversationRows, namedConversationSql, readConversation } from "../src/services/coach-conversation.js";
import { buildDesignContext, designContextBuilder, DRAFT_REQUEST_LINE, DRAFT_REQUEST_SUB_LINE } from "../src/services/design-context.js";
import { DESIGNED_OP_KINDS } from "../src/services/design-op-kinds.js";
import { recordAnswer } from "../src/services/design-tools/record-answer.js";
import { askedWordsSql } from "../src/services/objective-changes.js";
import {
  isDesignedOp,
  isDocWorkoutOp,
  isImportCorrectionOp,
  isMovePinsOp,
  isObjectiveChangeOp,
  isPlanAdjustOp,
  isPlanChangeOp,
  isPlanStructureOp,
  isProgrammeChangeOp,
} from "../src/services/proposal-kinds.js";
import { viaD1 } from "./fake-d1.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { planSet } from "../src/services/design-tools/plan-set.js";
import { askAthlete } from "../src/services/design-tools/ask.js";
import { isToolErr, type SetHooks, type ToolErr } from "../src/services/design-tools/types.js";
import type { ContentBlock, MessagesOk, MessagesResult } from "../src/services/llm-messages.js";
import { DRAFT_LIVE_STATUSES, DRAFT_PROPOSAL_PREFIX, DRAFT_UNSEEN_STATUSES, planDraftKey, planDraftsSql } from "../src/services/plan-ending.js";
import { draftEndingPlans, draftRequest, planDraftsOn } from "../src/services/plan-drafts.js";
import { listPlans } from "../src/services/plan-registry.js";
import type { PlanStructureOp } from "../src/services/proposal-kinds.js";
import { isWrite, makeTestDb, makeTestUser, untilDone } from "./helpers.js";

const NOW = new Date("2026-05-13T16:30:00Z");
const TODAY = "2026-05-13";
/** The block's last day: Sunday, in 11 days. */
const LAST = "2026-05-24";
const PLAN = "plan-lift1";
const KEY = planDraftKey(PLAN, LAST);

/** What the run's object was told. */
let told: Array<{ op: string; body: { runId: string; userId: string; stepping?: boolean; leaseMs?: number } }>;
const stepper = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async (url: string, init: { body: string }) => {
      told.push({ op: url.slice(url.lastIndexOf("/") + 1), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ armed: true, working: false, nextAt: null }), { status: 200 });
    },
  }),
} as unknown as DurableObjectNamespace;

const ON = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", COACH_DESIGNER: "1", COACH_STEP_ALARM: "1", COACH_RUN_STEPPER: stepper, PLAN_DRAFTS: "1" } as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let statements: string[];
/** Given a statement about to run, what to do first (once), if anything: a change landing between a read and a write. */
let before: ((sql: string) => (() => void) | null) | null = null;
/** A statement on the test database itself, run then and there (inside a batch's transaction when one is open). */
const raw = (text: string, ...params: unknown[]) =>
  (db as unknown as { $client: { prepare: (s: string) => { run: (...p: unknown[]) => unknown } } }).$client.prepare(text).run(...params);
/** The keyed create's key statement (coach-runs.ts `insertKeyed`), and the week's key (plan-drafts.ts). */
const KEY_INSERT = /^\s*insert into "audit_events"/;
const WEEK_KEY_INSERT = /^\s*INSERT OR IGNORE INTO audit_events/;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  told = [];
  statements = [];
  before = null;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (s) => {
      statements.push(s);
      // Something that happens between a pass's read and a write of its: run once, just before the statement it names.
      const act = before?.(s);
      if (act) {
        before = null;
        act();
      }
    },
  });
  ({ userId, prefs } = await makeTestUser(db, { timezone: "America/Los_Angeles" }));
  await seedLiftingPlan();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A lifting plan that continues: one block to Sunday 24 May, three sessions left in it. */
async function seedLiftingPlan(o: { onEnd?: string | null; pausedUntil?: string | null; disciplines?: string[]; discipline?: string } = {}) {
  const at = NOW.toISOString();
  await db.insert(schema.programs).values({
    id: PLAN,
    userId,
    kind: "coach",
    name: "Synthetic strength",
    status: "active",
    disciplines: o.disciplines ?? ["strength"],
    config: {},
    onEnd: o.onEnd === undefined ? "continue" : o.onEnd,
    pausedUntil: o.pausedUntil ?? null,
    purpose: "A synthetic purpose",
    brief: "A synthetic brief",
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(schema.coachPlans).values({
    id: "lift1",
    userId,
    discipline: o.discipline ?? "lift",
    name: "Synthetic block",
    status: "active",
    startDate: "2026-04-13",
    endDate: LAST,
    raceDate: null,
    stampPrefix: "Synthetic block",
    programId: PLAN,
    createdAt: at,
    updatedAt: at,
  });
  for (const date of ["2026-05-14", "2026-05-18", "2026-05-21"]) await seedSession(date, "lift1");
}

async function seedSession(date: string, planId: string) {
  const at = NOW.toISOString();
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId,
    sourceWorkoutId: `src-${id}`,
    title: "Strength",
    category: "strength",
    sport: "strength",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "scheduled",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: at,
    updatedAt: at,
  });
}

const keys = () => db.select().from(schema.auditEvents).where(eq(schema.auditEvents.kind, "plan_draft"));
const runs = () => db.select().from(schema.coachRuns).where(eq(schema.coachRuns.userId, userId));
const pass = (env: Env = ON, at: Date = NOW) => draftEndingPlans(db, env, at);
const rowPrompt = async (env: { drafts: boolean } = { drafts: true }) => (await listPlans(db, userId, TODAY, env)).find((p) => p.id === PLAN)!.prompt;

async function spend(micros: number) {
  await db.insert(schema.llmUsage).values({ id: newId(), userId, kind: "coach_wake", model: "m", inputTokens: 1, outputTokens: 1, costMicros: micros, cacheHit: false, createdAt: NOW.toISOString() });
}

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_pd${++seq}`, name, input });
const turn = (...uses: ContentBlock[]): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text: "Working on it." }, ...uses],
  stopReason: uses.length > 0 ? "tool_use" : "end_turn",
  usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});
function scripted(turns: MessagesResult[]): RunDeps {
  return {
    callModel: async () => {
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
}
async function drive(runId: string, deps: RunDeps) {
  let status = "";
  await untilDone(
    async (i) => {
      const out = await runStep(db, ON, runId, userId, new Date(NOW.getTime() + (i + 1) * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      status = out.result.status;
      return status !== "active";
    },
    { max: 40, what: "drive" },
  );
  return status;
}

/** The next block, as the coach drafts it: from the Monday after, naming no plan — the run's plan is the default. */
const nextBlock = {
  kind: "createPlan",
  discipline: "lift",
  name: "Next strength block",
  startDate: "2026-05-25",
  endDate: "2026-06-21",
  firmSessions: [
    { date: "2026-05-25", session: { category: "strength", title: "Strength A", durationMinutes: 45, lift: { exercises: [{ name: "Goblet squat", sets: 3, reps: 8 }] } } },
    { date: "2026-05-28", session: { category: "strength", title: "Strength B", durationMinutes: 45, lift: { exercises: [{ name: "Goblet squat", sets: 3, reps: 10 }] } } },
  ],
  shapeWeeks: ["2026-06-01", "2026-06-08", "2026-06-15"].map((weekStart) => ({ weekStart, volumeTarget: "two sessions", keySessions: ["strength A", "strength B"] })),
};
const drafts = (turns: MessagesResult[]) => scripted(turns);
const proposing = () => drafts([turn(use("propose_plan", { change: nextBlock, why: "The next four weeks build on this block." })), turn(use("finish", { summary: "Here's the next four weeks of your strength plan." }))]);
const finishingEmpty = () => drafts([turn(use("finish", { summary: "Nothing to change yet." }))]);

/** The pass's one draft run, driven to its end. */
async function draftAndDrive(deps: RunDeps) {
  expect(await pass()).toEqual({ started: 1 });
  const [run] = await runs();
  return { run: run!, status: await drive(run!.id, deps) };
}

describe("the pieces agree with the loop's own", () => {
  it("live statuses, unseen proposals and a design proposal's id are the loop's (written out where the loop can't be imported)", () => {
    expect([...DRAFT_LIVE_STATUSES]).toEqual([...LIVE_STATUSES]);
    expect([...DRAFT_UNSEEN_STATUSES].sort()).toEqual(["cancelled", "rehearsal", "unreviewed"]);
    expect(DRAFT_PROPOSAL_PREFIX).toBe(designProposalId(""));
  });

  it("the designed op kinds are one list, for the SQL and the code: each its own predicate's, both ways", () => {
    // Every designed kind's own predicate, by hand: a kind added to the list with none, or a predicate whose kind isn't
    // listed, fails here.
    const own: Record<string, (op: unknown) => boolean> = {
      doc_workout: isDocWorkoutOp,
      plan_adjust: isPlanAdjustOp,
      plan_structure: isPlanStructureOp,
      programme_change: isProgrammeChangeOp,
      plan_change: isPlanChangeOp,
      move_pins: isMovePinsOp,
      import_correction: isImportCorrectionOp,
      objective_change: isObjectiveChangeOp,
    };
    expect([...DESIGNED_OP_KINDS].sort()).toEqual(Object.keys(own).sort());
    for (const [kind, is] of Object.entries(own)) {
      expect(is({ kind }), kind).toBe(true);
      expect(isDesignedOp({ kind }), kind).toBe(true);
    }
    // A thread coach's op is none of them.
    for (const kind of ["move", "skip", "extendPlan", "createPlan"]) expect(isDesignedOp({ kind }), kind).toBe(false);
  });

  it("a draft starts through drizzle's own D1 driver: its two statements batch as production's batch takes them", async () => {
    const d1 = viaD1(db);
    expect(await draftEndingPlans(d1, ON, NOW)).toEqual({ started: 1 });
    const all = await runs();
    expect(all).toHaveLength(1);
    expect((await keys()).map((k) => [k.id, k.detail])).toEqual([[KEY, { planId: PLAN, lastSessionDate: LAST, runId: all[0]!.id }]]);
    expect(told).toHaveLength(1);
    // And again: the key read back through the driver, nothing more started.
    expect(await draftEndingPlans(d1, ON, NOW)).toEqual({ started: 0 });
    expect(await runs()).toHaveLength(1);
    // A keyed create of a taken key, through the driver, once that draft is over: refused, nothing written.
    await db.update(schema.coachRuns).set({ status: "finished" }).where(eq(schema.coachRuns.id, all[0]!.id));
    await expect(
      createRun(d1, userId, { scope: { kind: "next_n" }, request: "x", conversationId: null, origin: "plan_draft", planId: PLAN, once: { key: KEY, kind: "plan_draft", detail: {} } }, NOW),
    ).rejects.toBeInstanceOf(RunKeyTakenError);
  });

  it("the switch is PLAN_DRAFTS with the step alarm and the coach designer: any one missing is off", () => {
    expect(planDraftsOn(ON)).toBe(true);
    expect(planDraftsOn({ ...ON, PLAN_DRAFTS: undefined })).toBe(false);
    expect(planDraftsOn({ ...ON, PLAN_DRAFTS: "true" })).toBe(false);
    expect(planDraftsOn({ ...ON, COACH_STEP_ALARM: "0" })).toBe(false);
    expect(planDraftsOn({ ...ON, COACH_RUN_STEPPER: undefined })).toBe(false);
    expect(planDraftsOn({ ...ON, COACH_DESIGNER: undefined })).toBe(false);
    expect(planDraftsOn(undefined)).toBe(false);
  });
});

describe("draftEndingPlans", () => {
  it("starts one run per ending, however many passes see it — three at once on a fresh ending among them", async () => {
    expect(await keys()).toHaveLength(0);
    statements.length = 0;
    // A true race: each pass reads the ending as due and goes on to the write — three key statements, one key between them.
    const raced = await Promise.all([pass(), pass(), pass()]);
    expect(statements.filter((s) => KEY_INSERT.test(s))).toHaveLength(3);
    expect(raced.map((r) => r.started).sort()).toEqual([0, 0, 1]);
    expect(await keys()).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
    expect(told).toHaveLength(1);
    // A pass after it reads the key: nothing due, and it never reaches the write.
    statements.length = 0;
    expect(await pass()).toEqual({ started: 0 });
    expect(statements.filter((s) => KEY_INSERT.test(s))).toEqual([]);
    const [key] = await keys();
    expect(key!.id).toBe(KEY);
    const all = await runs();
    expect(all).toHaveLength(1);
    expect(key!.detail).toEqual({ planId: PLAN, lastSessionDate: LAST, runId: all[0]!.id });
    // The app's request, naming the plan, for the next workouts, its plan and who asked kept with it.
    expect(all[0]!.request).toBe("Draft the next stretch of the plan Synthetic strength, from its purpose and brief. Nothing changes until I approve it.");
    expect(all[0]!.request).toBe(draftRequest("Synthetic strength"));
    expect(all[0]!.scope).toEqual({ kind: "next_n", n: 3 });
    const settings = (JSON.parse(all[0]!.state!) as { settings: Record<string, unknown> }).settings;
    expect(settings).toMatchObject({ origin: "plan_draft", planId: PLAN, conversationId: all[0]!.id, ceilingMicros: RUN_CEILING_MICROS.next_n });
    // Starting is one step: its object armed once, for a set's lease.
    expect(told).toEqual([{ op: "arm", body: { runId: all[0]!.id, userId, stepping: false, leaseMs: STEPPER_LEASE_SET_MS } }]);
  });

  it("the key's own statement looks at the plan again: paused or stopped between the pass's read and its write, nothing starts", async () => {
    for (const [what, change, undo] of [
      ["paused", "update programs set paused_until = '2026-05-30' where id = ?", "update programs set paused_until = null where id = ?"],
      ["stopped", "update programs set status = 'retired' where id = ?", "update programs set status = 'active' where id = ?"],
      ["archived", "update programs set archived_at = '2026-05-13T16:30:00.000Z' where id = ?", "update programs set archived_at = null where id = ?"],
    ] as const) {
      before = (s) => (KEY_INSERT.test(s) ? () => raw(change, PLAN) : null);
      expect(await pass(), what).toEqual({ started: 0 });
      expect(before, `${what}: the change landed before the key's statement`).toBeNull();
      expect(await keys(), what).toHaveLength(0);
      expect(await runs(), what).toHaveLength(0);
      raw(undo, PLAN);
    }
    expect(told).toEqual([]);
    // As it was read, with nothing landing between: the draft starts.
    expect(await pass()).toEqual({ started: 1 });
  });

  it("the week's key is written only while no restore is replacing the account (one beginning after the pass looked)", async () => {
    await spend(19_990_000);
    before = (s) => (WEEK_KEY_INSERT.test(s) ? () => raw("insert into account_state (user_id, restore_id, updated_at) values (?, 'r1', ?)", userId, NOW.toISOString()) : null);
    expect(await pass()).toEqual({ started: 0 });
    expect(before).toBeNull();
    expect(await keys()).toHaveLength(0);
  });

  it("the key holds once the run is over: the same ending's key starts nothing more, even asked for directly", async () => {
    await draftAndDrive(finishingEmpty());
    expect(await pass()).toEqual({ started: 0 });
    const again = createRun(db, userId, { scope: { kind: "next_n" }, request: "x", conversationId: null, origin: "plan_draft", planId: PLAN, once: { key: KEY, kind: "plan_draft", detail: {} } }, NOW);
    await expect(again).rejects.toBeInstanceOf(RunKeyTakenError);
    expect(await runs()).toHaveLength(1);
    expect(await keys()).toHaveLength(1);
  });

  it("starts none when the switch is off, for a paused plan, for ask, for a live run, or at the weekly cap", async () => {
    statements.length = 0;
    for (const env of [{ ...ON, PLAN_DRAFTS: undefined }, { ...ON, COACH_STEP_ALARM: undefined }, { ...ON, COACH_DESIGNER: undefined }]) {
      expect(await pass(env as Env)).toEqual({ started: 0 });
    }
    expect(statements.filter(isWrite)).toEqual([]);
    const reset = async (o: Parameters<typeof seedLiftingPlan>[0]) => {
      await db.delete(schema.plannedWorkouts);
      await db.delete(schema.coachPlans);
      await db.delete(schema.programs);
      await seedLiftingPlan(o);
    };
    await reset({ pausedUntil: "2026-05-20" });
    expect(await pass(), "paused").toEqual({ started: 0 });
    await reset({ onEnd: "ask" });
    expect(await pass(), "asks").toEqual({ started: 0 });
    // A running plan's own default is to ask: nothing either.
    await reset({ onEnd: null, disciplines: ["run"], discipline: "run" });
    expect(await pass(), "a running plan's default").toEqual({ started: 0 });
    await reset({});
    // The athlete's own run is live: nothing, and the ending waits for a pass with none.
    const own = await createRun(db, userId, { request: "Something for my hips." }, NOW);
    expect(await pass(), "live run").toEqual({ started: 0 });
    expect(await keys()).toHaveLength(0);
    await db.update(schema.coachRuns).set({ status: "finished" }).where(eq(schema.coachRuns.id, own.run.id));
    // At the weekly cap: nothing started, the key says why, and nothing retries.
    await spend(19_990_000);
    expect(await pass(), "weekly cap").toEqual({ started: 0 });
    expect((await keys()).map((k) => [k.id, k.detail])).toEqual([[KEY, { planId: PLAN, lastSessionDate: LAST, outcome: "week_budget" }]]);
    await db.delete(schema.llmUsage);
    expect(await pass(), "a week later, the same ending").toEqual({ started: 0 });
    expect(await runs()).toHaveLength(1);
    expect(told).toEqual([]);
  });

  it("starts none while a suggestion of the athlete's waits that names the plan: the plain question shows meanwhile, never 'next stretch ready'", async () => {
    const at = NOW.toISOString();
    // The athlete's own run proposed an extension of the block: it waits for them.
    const op: Partial<PlanStructureOp> = { kind: "plan_structure", id: "plan", op: { kind: "extendPlan", planId: "lift1", shapeWeeks: [] } as never, date: "2026-05-25", why: "w", title: "t", summary: "s", lines: [], planKey: "plan:lift1", issues: [], toolUseId: "t1", at };
    await db.insert(schema.coachProposals).values({ id: "dp-other", userId, title: "t", evidence: "", rationale: "r", flags: [], ops: [op], status: "pending", createdAt: at, expiresAt: "2026-06-30" });
    expect(await pass()).toEqual({ started: 0 });
    // Held back: the question as drafts off asks it (nothing goes quiet), and no chip for a stretch the draft never made.
    expect(await rowPrompt()).toStrictEqual({ kind: "whats_next", label: "Plan what comes after my lifting plan", request: "Plan what comes after my lifting plan — it ends in 11 days." });
    expect((await readCoachOpening(db, userId, prefs, TODAY, NOW, new Set(), { drafts: true })).ready).toBeUndefined();
    await db.update(schema.coachProposals).set({ status: "declined" }).where(eq(schema.coachProposals.id, "dp-other"));
    expect(await pass(), "declined: nothing waits").toEqual({ started: 1 });
  });

  it("a suggestion filed under a plan far from its end is no next stretch (R58; the review's probe C)", async () => {
    // Ending 79 days out, one pending workout of the athlete's filed under it.
    await db.update(schema.coachPlans).set({ endDate: "2026-07-31" }).where(eq(schema.coachPlans.id, "lift1"));
    await seedSession("2026-07-30", "lift1");
    const at = NOW.toISOString();
    const op = { kind: "doc_workout", id: "w1", date: "2026-05-15", planId: PLAN, title: "t", why: "w" };
    await db.insert(schema.coachProposals).values({ id: "dp-athlete", userId, title: "t", evidence: "", rationale: "r", flags: [], ops: [op], status: "pending", createdAt: at, expiresAt: "2026-06-30" });
    expect(await rowPrompt({ drafts: false })).toBeNull();
    expect(await rowPrompt()).toBeNull();
    expect((await readCoachOpening(db, userId, prefs, TODAY, NOW, new Set(), { drafts: true })).ready).toBeUndefined();
  });

  it("a plan that continues has nothing to draft once it has run out", async () => {
    await db.update(schema.coachPlans).set({ endDate: "2026-05-12" }).where(eq(schema.coachPlans.id, "lift1"));
    await db.delete(schema.plannedWorkouts);
    await seedSession("2026-05-11", "lift1");
    expect(await rowPrompt()).toBeNull();
    expect(await pass()).toEqual({ started: 0 });
  });

  it("a restore in progress starts nothing", async () => {
    await db.insert(schema.accountState).values({ userId, restoreId: "r1", restoreHeartbeatAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    expect(await pass()).toEqual({ started: 0 });
    expect(await keys()).toHaveLength(0);
    expect(await runs()).toHaveLength(0);
    // And a create keyed for a draft never starts behind one, whatever its caller checked.
    await expect(
      createRun(db, userId, { scope: { kind: "next_n" }, request: "x", conversationId: null, origin: "plan_draft", planId: PLAN, once: { key: KEY, kind: "plan_draft", detail: {} } }, NOW),
    ).rejects.toBeInstanceOf(RunKeyTakenError);
    expect(await keys()).toHaveLength(0);
  });

  it("changes nothing on the plan before approval", async () => {
    const before = {
      programs: await db.select().from(schema.programs),
      blocks: await db.select().from(schema.coachPlans),
      weeks: await db.select().from(schema.coachPlanWeeks),
      sessions: await db.select().from(schema.plannedWorkouts),
      versions: await db.select().from(schema.programVersions),
    };
    const { run, status } = await draftAndDrive(proposing());
    expect(status).toBe("finished");
    const [proposal] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(run.id)));
    expect(proposal!.status).toBe("pending");
    expect({
      programs: await db.select().from(schema.programs),
      blocks: await db.select().from(schema.coachPlans),
      weeks: await db.select().from(schema.coachPlanWeeks),
      sessions: await db.select().from(schema.plannedWorkouts),
      versions: await db.select().from(schema.programVersions),
    }).toEqual(before);
  });

  it("files what it draws under the plan", async () => {
    const { run } = await draftAndDrive(proposing());
    const [proposal] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(run.id)));
    const op = (proposal!.ops as PlanStructureOp[]).find((o) => o.kind === "plan_structure")!;
    // The call named no plan: the run's is the default.
    expect(op.op).toMatchObject({ kind: "createPlan", continuesPlanId: PLAN });
    // The row says its next stretch is ready, and a tap opens it: its words are no request to send.
    expect(await rowPrompt()).toStrictEqual({ kind: "draft_ready", label: "Next stretch ready for my lifting plan", request: "Next stretch ready for my lifting plan." });
    // No chip asks what comes next meanwhile; its "next stretch ready" chip opens the draft's proposal and carries no request
    // (R55) — and with drafts off the read has no such field at all.
    const opening = await readCoachOpening(db, userId, prefs, TODAY, NOW, new Set(), { drafts: true });
    expect(opening.nudges).toEqual([]);
    expect(opening.ready).toStrictEqual([{ id: `ready:${PLAN}`, label: "Next stretch ready for my lifting plan", proposalId: designProposalId(run.id) }]);
    expect("ready" in (await readCoachOpening(db, userId, prefs, TODAY, NOW))).toBe(false);
    // "Also waiting" lists it though its run is the current pick, being over (R55): findable once its conversation is quiet.
    const current = await currentRun(db, userId, NOW);
    expect(current!.run.id).toBe(run.id);
    expect(current!.alsoOpen.map((a) => a.proposalId)).toEqual([designProposalId(run.id)]);
    // plan_set's briefs too: a brief that names no plan is the run's plan's.
    const started: Array<{ planId?: string }> = [];
    const hooks: SetHooks = {
      rounds: () => [],
      start: async (designers) => {
        started.push(...designers);
        return designers.map((d) => d.runId);
      },
      budget: () => ({ ceilingMicros: 10_000_000, spentMicros: 0, mainSpentMicros: 0, perDesignerMicros: null, estimate: null }),
      started: () => false,
      keyLine: () => undefined,
    };
    const brief = { key: "mon", date: "2026-05-18", purpose: "Legs and trunk.", emphasis: "Control.", constraints: "Forty minutes.", why: "The block's next session." };
    const r = await planSet.run(
      { db, env: ON, userId, run: { id: "run-ps", role: "main", scope: { kind: "next_n", n: 3 }, parentId: null, rehearsal: false, planId: PLAN }, now: NOW, toolUseId: "toolu_ps", set: hooks },
      { briefs: [brief] },
    );
    if (isToolErr(r)) throw new Error(r.why);
    expect(started.map((d) => d.planId)).toEqual([PLAN]);
  });

  it("a failed draft falls back to the plain prompt, and doesn't retry", async () => {
    // While it is at work, the plan asks nothing: no chip, no row line.
    expect(await pass()).toEqual({ started: 1 });
    expect(await rowPrompt()).toBeNull();
    expect((await readNudges(db, userId, prefs, TODAY, NOW, { drafts: true })).map((n) => n.id)).toEqual([]);
    const [run] = await runs();
    expect(await drive(run!.id, finishingEmpty())).toBe("finished");
    // Over with no proposal: the question comes back, saying so, on the row and in the chip's request; the label is the chip's.
    const words = `Plan what comes after my lifting plan — it ends in 11 days.`;
    expect(await rowPrompt()).toStrictEqual({ kind: "whats_next", label: "Plan what comes after my lifting plan", request: `${words} ${PLAN_DRAFT_NOTES.no_proposal}`, note: PLAN_DRAFT_NOTES.no_proposal });
    expect(await readNudges(db, userId, prefs, TODAY, NOW, { drafts: true })).toEqual([
      { id: "ending:lift1", label: "Plan what comes after my lifting plan", request: `${words} ${PLAN_DRAFT_NOTES.no_proposal}` },
    ]);
    expect(await pass()).toEqual({ started: 0 });
    expect(await runs()).toHaveLength(1);
    // The week couldn't pay for it: the same, saying that.
    await db.delete(schema.auditEvents);
    await db.delete(schema.coachRuns);
    await spend(19_990_000);
    expect(await pass()).toEqual({ started: 0 });
    expect((await rowPrompt())?.note).toBe(PLAN_DRAFT_NOTES.week_budget);
    expect((await rowPrompt())?.request).toBe(`${words} ${PLAN_DRAFT_NOTES.week_budget}`);
  });

  it("a declined draft asks again plainly, with nothing to explain", async () => {
    const { run } = await draftAndDrive(proposing());
    await db.update(schema.coachProposals).set({ status: "declined", resolvedAt: NOW.toISOString() }).where(eq(schema.coachProposals.id, designProposalId(run.id)));
    expect(await rowPrompt()).toStrictEqual({ kind: "whats_next", label: "Plan what comes after my lifting plan", request: "Plan what comes after my lifting plan — it ends in 11 days." });
    expect(await pass()).toEqual({ started: 0 });
  });

  /** An hour on: after a draft driven from NOW has ended (its steps are NOW plus seconds). */
  const LATER = new Date(NOW.getTime() + 3_600_000).toISOString();
  /** The draft's proposal decided as the approve writes it: its status, when (`at`, else LATER), and each op's outcome. */
  async function decide(runId: string, status: "approved" | "declined", at = LATER) {
    const id = designProposalId(runId);
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, id));
    const outcome = { status: status === "approved" ? "applied" : "declined", at };
    await db
      .update(schema.coachProposals)
      .set({ status, resolvedAt: at, ops: (p!.ops as Array<Record<string, unknown>>).map((o) => ({ ...o, outcome })) })
      .where(eq(schema.coachProposals.id, id));
  }
  /** A suggestion of the athlete's naming the plan, approved at `at`: a workout filed under it, applied. */
  async function approvedElsewhere(at: string) {
    const op = { kind: "doc_workout", id: "w1", date: "2026-05-26", planId: PLAN, title: "t", why: "w", outcome: { status: "applied", at } };
    await db.insert(schema.coachProposals).values({ id: "dp-athlete", userId, title: "t", evidence: "", rationale: "r", flags: [], ops: [op], status: "approved", createdAt: at, expiresAt: "2026-06-30", resolvedAt: at });
  }
  /** The plan's last session moved later, by hand: a session on `date` under its block, the block's end with it. */
  async function lastDayTo(date: string) {
    await db.update(schema.coachPlans).set({ endDate: date }).where(eq(schema.coachPlans.id, "lift1"));
    await seedSession(date, "lift1");
  }

  it("a new ending, after approval, can draft again", async () => {
    const { run } = await draftAndDrive(proposing());
    // Approved: its block on the plan (as the apply lands it), the plan's last day now the new block's.
    await decide(run.id, "approved");
    const at = NOW.toISOString();
    await db.insert(schema.coachPlans).values({ id: "lift2", userId, discipline: "lift", name: "Next strength block", status: "active", startDate: "2026-05-25", endDate: "2026-05-31", raceDate: null, stampPrefix: "Next", programId: PLAN, createdAt: at, updatedAt: at });
    // The new ending is due (R57: an approval naming the plan since its key re-arms it): nothing to ask meanwhile.
    expect((await listPlans(db, userId, TODAY, { drafts: true })).find((p) => p.id === PLAN)!.prompt).toBeNull();
    expect(await pass()).toEqual({ started: 1 });
    expect((await keys()).map((k) => k.id).sort()).toEqual([KEY, planDraftKey(PLAN, "2026-05-31")].sort());
    expect(await runs()).toHaveLength(2);
  });

  it("one draft a stretch: a last day moved by hand drafts nothing more, and the plain question shows — never silent (R57)", async () => {
    await draftAndDrive(finishingEmpty());
    await lastDayTo("2026-05-27");
    expect(await pass()).toEqual({ started: 0 });
    expect(await keys()).toHaveLength(1);
    // The stretch's draft stands for the moved ending: over, and why.
    expect(await rowPrompt()).toStrictEqual({
      kind: "whats_next",
      label: "Plan what comes after my lifting plan",
      request: `Plan what comes after my lifting plan — it ends in 14 days. ${PLAN_DRAFT_NOTES.no_proposal}`,
      note: PLAN_DRAFT_NOTES.no_proposal,
    });
    // At the week's cap too: its key stands for the stretch, run or none.
    await db.delete(schema.auditEvents);
    await db.delete(schema.coachRuns);
    await db.delete(schema.coachProposals);
    await spend(19_990_000);
    expect(await pass()).toEqual({ started: 0 });
    await db.delete(schema.llmUsage);
    await lastDayTo("2026-05-29");
    expect(await pass(), "a week_budget key holds the stretch too").toEqual({ started: 0 });
    expect((await rowPrompt())?.note).toBe(PLAN_DRAFT_NOTES.week_budget);
  });

  it("a draft declined doesn't re-arm the plan, whatever its last day does after", async () => {
    const { run } = await draftAndDrive(proposing());
    await decide(run.id, "declined");
    expect(await pass()).toEqual({ started: 0 });
    await lastDayTo("2026-05-27");
    expect(await pass()).toEqual({ started: 0 });
    expect(await runs()).toHaveLength(1);
    expect(await rowPrompt()).toStrictEqual({ kind: "whats_next", label: "Plan what comes after my lifting plan", request: "Plan what comes after my lifting plan — it ends in 14 days." });
    // An approval of something else naming the plan, since the draft ended, does: the next stretch may be drafted.
    await approvedElsewhere(LATER);
    expect(await pass()).toEqual({ started: 1 });
  });

  it("an approval made while the draft still works re-arms nothing: it ends with no proposal, and no second draft follows (R61)", async () => {
    expect(await pass()).toEqual({ started: 1 });
    const [run] = await runs();
    // Mid-draft, the athlete approves something of their own filed under the plan, and its last day moves.
    await approvedElsewhere(NOW.toISOString());
    await lastDayTo("2026-05-27");
    expect(await drive(run!.id, finishingEmpty())).toBe("finished");
    expect(await pass()).toEqual({ started: 0 });
    expect(await runs()).toHaveLength(1);
    expect((await rowPrompt())?.note).toBe(PLAN_DRAFT_NOTES.no_proposal);
    // A key with no run (the week's, a failed start's) re-arms on an approval after the key itself.
    await db.delete(schema.auditEvents);
    await db.delete(schema.coachRuns);
    await db.delete(schema.coachProposals);
    await spend(19_990_000);
    expect(await pass()).toEqual({ started: 0 });
    await db.delete(schema.llmUsage);
    await lastDayTo("2026-05-29");
    await approvedElsewhere(LATER);
    expect(await pass()).toEqual({ started: 1 });
  });

  it("a start that fails any other way writes its key too: the plain question says so, and nothing retries (R60)", async () => {
    // The create's batch breaks in the database (any failure but the week's budget).
    before = (s) =>
      KEY_INSERT.test(s)
        ? () => {
            throw new Error("the database dropped a statement");
          }
        : null;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await pass()).toEqual({ started: 0 });
    // The log says what broke, not only its kind: the message is the app's own text.
    expect(logged).toHaveBeenCalledWith("plan draft could not start: Error: the database dropped a statement");
    logged.mockRestore();
    expect((await keys()).map((k) => [k.id, k.detail])).toEqual([[KEY, { planId: PLAN, lastSessionDate: LAST, outcome: "start_failed" }]]);
    expect(await runs()).toHaveLength(0);
    expect(told).toEqual([]);
    expect(await rowPrompt()).toStrictEqual({
      kind: "whats_next",
      label: "Plan what comes after my lifting plan",
      request: `Plan what comes after my lifting plan — it ends in 11 days. ${PLAN_DRAFT_NOTES.start_failed}`,
      note: PLAN_DRAFT_NOTES.start_failed,
    });
    // The next hour tries nothing: it never reaches the create.
    statements.length = 0;
    expect(await pass()).toEqual({ started: 0 });
    expect(statements.filter((s) => KEY_INSERT.test(s))).toEqual([]);
    expect(await runs()).toHaveLength(0);
  });

  it("a draft's opening names the plan's last day — the key's own reading — and to propose what comes after it as its next phase (R62)", async () => {
    /** The draft's opening message, as its first step builds it (no model call). */
    const opening = async () => {
      const [run] = await runs();
      const out = await runStep(db, ON, run!.id, userId, NOW, scripted([]));
      expect(out.kind).toBe("ok");
      const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, run!.id));
      const state = JSON.parse(row!.state!) as { settings: { planLastDay?: string }; messages: Array<{ content: Array<{ text: string }> }> };
      return { header: state.messages[0]!.content[0]!.text, lastDay: state.settings.planLastDay };
    };
    expect(await pass()).toEqual({ started: 1 });
    const first = await opening();
    expect(first.lastDay).toBe(LAST);
    expect((await keys())[0]!.id).toBe(planDraftKey(PLAN, first.lastDay!));
    expect(first.header).toContain(
      `The plan (id ${PLAN}) ends with its last session on Sun 24 May · in 11 d (2026-05-24). Read its purpose and brief, and propose what comes after that day as the plan's next phase, with propose_plan (a new block continuing it) — not the sessions before it again — then finish; nothing changes until they approve it:\n<untrusted from="plan draft">${draftRequest("Synthetic strength")}</untrusted>`,
    );
    // A new draft for a moved last day names the new day.
    await db.delete(schema.auditEvents);
    await db.delete(schema.coachRuns);
    await lastDayTo("2026-05-27");
    expect(await pass()).toEqual({ started: 1 });
    const moved = await opening();
    expect(moved.lastDay).toBe("2026-05-27");
    expect(moved.header).toContain(`ends with its last session on Wed 27 May · in 14 d (2026-05-27).`);
    expect(moved.header).not.toContain("2026-05-24");
  });

  it("an account whose preferences don't read is skipped, as every other reader of its day stops — never read in UTC — and the rest go on", async () => {
    // Another account, its own plan ending, its preferences fine.
    const other = await makeTestUser(db, { timezone: "Europe/Berlin" });
    const at = NOW.toISOString();
    await db.insert(schema.programs).values({ id: "plan-other", userId: other.userId, kind: "coach", name: "Other strength", status: "active", disciplines: ["strength"], config: {}, onEnd: "continue", createdAt: at, updatedAt: at });
    await db.insert(schema.coachPlans).values({ id: "other1", userId: other.userId, discipline: "lift", name: "Other block", status: "active", startDate: "2026-04-13", endDate: LAST, raceDate: null, stampPrefix: "Other", programId: "plan-other", createdAt: at, updatedAt: at });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const unreadable of ["not json", JSON.stringify({ timezone: 42 })]) {
      await db.delete(schema.auditEvents);
      await db.delete(schema.coachRuns);
      raw("update user_preferences set prefs = ? where user_id = ?", unreadable, userId);
      expect(await pass(), unreadable).toEqual({ started: 1 });
      expect((await db.select().from(schema.auditEvents)).map((k) => k.id), unreadable).toEqual([planDraftKey("plan-other", LAST)]);
    }
    expect(logged).toHaveBeenCalledWith("plan draft skipped an account: its preferences don't read");
    logged.mockRestore();
  });

  it("a draft asks the athlete nothing: nobody is there to answer", async () => {
    const r = await askAthlete.run(
      { db, env: ON, userId, run: { id: "run-a", role: "main", scope: { kind: "next_n", n: 3 }, parentId: null, rehearsal: false, origin: "plan_draft", planId: PLAN }, now: NOW },
      { questions: [{ text: "Gym or home?", chips: ["Gym", "Home"], why: "It changes the moves." }] },
    );
    expect(isToolErr(r)).toBe(true);
    expect((r as ToolErr).error).toBe("draft_cannot_ask");
  });

  it("reads as the app's, never as the athlete's own words: its opening message, its turn, and the chips' asks", async () => {
    expect(await pass()).toEqual({ started: 1 });
    const [run] = await runs();
    const built = await buildDesignContext(db, ON, userId, { id: run!.id, role: "main", scope: { kind: "next_n", n: 3 }, request: run!.request, parentId: null, origin: "plan_draft" }, NOW);
    expect(built.header).toContain(`${DRAFT_REQUEST_LINE}\n<untrusted from="plan draft">${run!.request}</untrusted>`);
    expect(built.header).not.toContain("The athlete's request, in their own words");
    const conversation = await readConversation(db, userId, NOW, { endedLine: () => null });
    expect(conversation.turns.map((t) => [t.words, t.from])).toEqual([[run!.request, "app"]]);
  });
});

describe("a draft's request is the app's, never the athlete's own words (each guard, alone)", () => {
  /** A finished main run with `request`, a plan's draft's or the athlete's own. */
  async function finishedRun(request: string, origin?: "plan_draft") {
    const id = newId();
    const at = NOW.toISOString();
    const state = { v: 1, settings: { ceilingMicros: 1, maxCalls: 1, conversationId: id, ...(origin ? { origin } : {}) }, system: null, messages: [] };
    await db.insert(schema.coachRuns).values({ id, userId, parentId: null, role: "main", scope: { kind: "next_n", n: 3 }, request, status: "finished", state: JSON.stringify(state), createdAt: at, updatedAt: at });
    return id;
  }

  it("a draft's words never count as the athlete having asked a chip", async () => {
    const chip = { id: "ending:lift1", label: "Plan what comes after my lifting plan", request: "Plan what comes after my lifting plan — it ends in 11 days." };
    // Its words holding the chip's, from the app: the chip is still theirs to tap.
    await finishedRun("Plan what comes after my lifting plan, as the app asks it.", "plan_draft");
    expect(await readNudges(db, userId, prefs, TODAY, NOW)).toEqual([chip]);
    // The same words from the athlete: asked, so it stays away.
    await finishedRun("Plan what comes after my lifting plan, please.");
    expect(await readNudges(db, userId, prefs, TODAY, NOW)).toEqual([]);
  });

  it("a draft's request is no words of the athlete's for an objective's basis (askedWordsSql)", async () => {
    const words = "Draft the next stretch of the plan Synthetic strength, from its purpose and brief. Nothing changes until I approve it.";
    const draft = await finishedRun(words, "plan_draft");
    const own = await finishedRun(words);
    const read = async (runId: string) => ((await db.all(sql`select ${askedWordsSql(userId, runId)} as w`)) as Array<{ w: string | null }>)[0]!.w;
    expect(await read(draft)).toBeNull();
    expect(await read(own)).toBe(words);
  });

  it("nothing in a draft's request can be quoted as the athlete's answer or remembered as their word (athleteRequestSql)", async () => {
    const words = "Draft the next stretch of the plan Synthetic strength, from its purpose and brief. Nothing changes until I approve it.";
    const answer = { answers: [{ question: "energy", value: 4, quote: "approve it" }] };
    const ctx = (id: string) => ({ db, env: ON, userId, run: { id, role: "main" as const, scope: { kind: "next_n" as const, n: 3 }, parentId: null, rehearsal: false }, now: NOW, toolUseId: `toolu_${id}` });
    const draft = await finishedRun(words, "plan_draft");
    const refused = await recordAnswer.run(ctx(draft), answer);
    expect(isToolErr(refused) && refused.error).toBe("not_in_request");
    expect((refused as ToolErr).why).toBe("This run has no request: the athlete only tapped to start it.");
    // The same words from the athlete quote, as far as the quote's check goes (its value then isn't a number they gave).
    const own = await finishedRun(words);
    expect((await recordAnswer.run(ctx(own), answer)) as ToolErr).toMatchObject({ error: "value_not_stated" });
  });

  it("a later turn reads a draft as the app's, for the athlete — never as the athlete's words", async () => {
    const draft = await finishedRun(draftRequest("Synthetic strength"), "plan_draft");
    const rows = await conversationRows(db, userId, namedConversationSql(userId, draft), { limit: 6 });
    const block = conversationBlock(rows, NOW)!;
    expect(block).toContain(`— the app, for the athlete (a draft of their plan's next stretch): <untrusted from="plan draft">${draftRequest("Synthetic strength")}</untrusted>`);
    expect(block).not.toContain("— the athlete:");
  });

  it("a set's designer of a draft reads whose words they are, never the main coach's instruction (M6)", async () => {
    const run = { id: "run-x", role: "designer" as const, scope: { kind: "next_n" as const, n: 3 }, request: draftRequest("Synthetic strength"), parentId: "run-main", brief: "Thirty minutes, legs.", origin: "plan_draft" as const };
    const built = await buildDesignContext(db, ON, userId, run, NOW);
    expect(built.header).toContain(`${DRAFT_REQUEST_SUB_LINE}\n<untrusted from="plan draft">`);
    expect(built.header).not.toContain(DRAFT_REQUEST_LINE);
    expect(built.header).not.toContain("The athlete's request, in their own words");
  });

  it("a draft supersedes none of the athlete's open suggestions when it proposes (R59)", async () => {
    // The athlete's own older suggestion for a new lifting plan: what a newer plan change for a new lifting block covers.
    const earlier = new Date(NOW.getTime() - 3_600_000).toISOString();
    const older: Partial<PlanStructureOp> = {
      kind: "plan_structure", id: "plan", op: { kind: "createPlan", discipline: "lift", name: "Other", newPlan: { name: "Other", purpose: "p" }, startDate: "2026-05-25", endDate: "2026-06-21", firmSessions: [], shapeWeeks: [] } as never,
      date: "2026-05-25", why: "w", title: "Other", summary: "s", lines: [], planKey: "new:lift", issues: [], toolUseId: "t0", at: earlier,
    };
    await db.insert(schema.coachProposals).values({ id: "dp-older", userId, title: "Other", evidence: "", rationale: "r", flags: [], ops: [older], status: "pending", createdAt: earlier, expiresAt: "2026-06-30" });
    const { run, status } = await draftAndDrive(proposing());
    expect(status).toBe("finished");
    expect((await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(run.id))))[0]!.status).toBe("pending");
    const [kept] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, "dp-older"));
    expect(kept!.status).toBe("pending");
    expect((kept!.ops as Array<{ outcome?: unknown }>)[0]!.outcome).toBeUndefined();
  });
});

describe("the prompt rule with drafts off is today's, byte for byte", () => {
  it("a coach plan that continues and is ending: the same prompt, the same chip, and no read of a draft", async () => {
    statements.length = 0;
    const off = await rowPrompt({ drafts: false });
    expect(JSON.stringify(off)).toBe(JSON.stringify({ kind: "whats_next", label: "Plan what comes after my lifting plan", request: "Plan what comes after my lifting plan — it ends in 11 days." }));
    expect(await readNudges(db, userId, prefs, TODAY, NOW)).toEqual([{ id: "ending:lift1", label: "Plan what comes after my lifting plan", request: "Plan what comes after my lifting plan — it ends in 11 days." }]);
    expect(statements.some((s) => /audit_events|plan-draft/.test(s))).toBe(false);
    // With drafts on and a draft over that came to nothing, the off read still says what it always did.
    expect(await pass()).toEqual({ started: 1 });
    const [run] = await runs();
    await drive(run!.id, finishingEmpty());
    expect(JSON.stringify(await rowPrompt({ drafts: false }))).toBe(JSON.stringify(off));
  });
});

describe("the hourly pass", () => {
  const cron = (over: Partial<Env> = {}) =>
    ({
      ...ON,
      DB: {} as unknown as Env["DB"],
      ASSETS: {} as unknown as Env["ASSETS"],
      FIXTURE_MODE: "1",
      AI_DEFAULT_ENABLED: "0",
      SESSION_SECRET: "s",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      ALLOWED_GOOGLE_EMAIL: "runner@example.com",
      GOOGLE_CLIENT_ID: "c",
      GOOGLE_CLIENT_SECRET: "c",
      ...over,
    }) as Env;

  it("drafts the ending once, however many hours see it; with the switch off it reads nothing of drafts at all", async () => {
    statements.length = 0;
    await hourly(db, cron({ PLAN_DRAFTS: undefined }));
    expect(await runs()).toHaveLength(0);
    expect(statements.some((s) => /plan_draft|plan-draft/.test(s))).toBe(false);
    await hourly(db, cron());
    await hourly(db, cron());
    expect(await runs()).toHaveLength(1);
    expect((await keys()).map((k) => k.id)).toEqual([KEY]);
    expect(told.map((t) => t.op)).toEqual(["arm"]);
    // The pass never calls the model: the run waits for its alarm, its context not yet built.
    const [run] = await runs();
    expect(run!.steps).toBe(0);
    expect(await db.select().from(schema.llmUsage)).toEqual([]);
  });
});

describe("what a pass spends", () => {
  it("one statement for the pass, two for an account with nothing due, and the start's own when one is", async () => {
    // Nothing due: the plan ends in 30 days.
    await db.update(schema.coachPlans).set({ endDate: "2026-06-12" }).where(eq(schema.coachPlans.id, "lift1"));
    statements.length = 0;
    expect(await pass()).toEqual({ started: 0 });
    expect(statements).toHaveLength(1 + 2);
    expect(statements.filter(isWrite)).toEqual([]);
    // Due: the create — preferences, the week, the key and the run in one batch.
    await db.update(schema.coachPlans).set({ endDate: LAST }).where(eq(schema.coachPlans.id, "lift1"));
    statements.length = 0;
    expect(await pass()).toEqual({ started: 1 });
    expect(statements).toHaveLength(1 + 2 + 4);
    expect(statements.filter(isWrite)).toHaveLength(2);
    // At the cap: the create's preferences and week, the live read, and the key.
    await db.delete(schema.coachRuns);
    await db.delete(schema.auditEvents);
    await spend(19_990_000);
    statements.length = 0;
    expect(await pass()).toEqual({ started: 0 });
    expect(statements).toHaveLength(1 + 2 + 2 + 1 + 1);
    expect(statements.filter(isWrite)).toHaveLength(1);
    // The athlete's own run live: the create's four (its batch writes nothing) and the live read that finds it.
    await db.delete(schema.llmUsage);
    await db.delete(schema.auditEvents);
    await createRun(db, userId, { request: "Something for my hips." }, NOW);
    statements.length = 0;
    expect(await pass()).toEqual({ started: 0 });
    expect(statements).toHaveLength(1 + 2 + 4 + 1);
    expect(await keys()).toHaveLength(0);
  });

  it("the chip and the row read a draft in the statements they always spent: drafts on is no statement more", async () => {
    const count = async (read: () => Promise<unknown>) => {
      statements.length = 0;
      await read();
      return statements.length;
    };
    const chips = (drafts: boolean) => count(() => readNudges(db, userId, prefs, TODAY, NOW, { drafts }));
    // Its draft due, there is no chip to offer, and so no asks to read: one statement fewer.
    expect(await chips(true)).toBe((await chips(false)) - 1);
    // Its draft over with nothing to show, the chip comes back: the same statements, the draft's facts read in the plans' own.
    await draftAndDrive(finishingEmpty());
    expect(await chips(true)).toBe(await chips(false));
    expect(await count(() => listPlans(db, userId, TODAY, { drafts: true }))).toBe(await count(() => listPlans(db, userId, TODAY)));
    expect(await count(() => listPlans(db, userId, TODAY))).toBe(2);
  });

  it("a plan's keys are found by the primary key's range, and the proposals by the athlete's and their status — never a walk of every row", async () => {
    const lines = ((await db.all(sql`explain query plan select ${planDraftsSql(TODAY)} as d from programs where programs.user_id = ${userId}`)) as Array<{ detail: string }>).map((r) => r.detail.trim());
    expect(lines.filter((l) => /^SEARCH a2? USING INDEX sqlite_autoindex_audit_events_1 \(id>\? AND id<\?\)$/.test(l))).toHaveLength(2);
    expect(lines.some((l) => /^SCAN a2?\b/.test(l))).toBe(false);
    // `waiting` and `rearmed`: the athlete's suggestions in the statuses asked, by `coach_proposals_user_status_idx`.
    expect(lines.filter((l) => /^SEARCH p USING INDEX coach_proposals_user_status_idx \(user_id=\? AND status=\?\)$/.test(l))).toHaveLength(2);
    expect(lines.some((l) => /^SCAN p\b/.test(l))).toBe(false);
  });

  it("an account with no running coach plan spends nothing past the pass's one read", async () => {
    await db.update(schema.programs).set({ status: "retired" }).where(and(eq(schema.programs.id, PLAN), eq(schema.programs.userId, userId)));
    statements.length = 0;
    expect(await pass()).toEqual({ started: 0 });
    expect(statements).toHaveLength(1);
  });
});
