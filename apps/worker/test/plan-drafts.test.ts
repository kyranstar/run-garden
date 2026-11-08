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
import { readNudges } from "../src/services/coach-nudges.js";
import { createRun, LIVE_STATUSES, runStep, RunKeyTakenError, RUN_CEILING_MICROS, type RunDeps } from "../src/services/coach-runs.js";
import { STEPPER_LEASE_SET_MS } from "../src/services/coach-run-stepper.js";
import { readConversation } from "../src/services/coach-conversation.js";
import { buildDesignContext, designContextBuilder, DRAFT_REQUEST_LINE } from "../src/services/design-context.js";
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

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  told = [];
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
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
  it("starts one run per ending, however many passes see it", async () => {
    expect(await pass()).toEqual({ started: 1 });
    expect(await pass()).toEqual({ started: 0 });
    // Two passes at once: one key, one run between them.
    await Promise.all([pass(), pass()]);
    const [key] = await keys();
    expect(await keys()).toHaveLength(1);
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

  it("starts none while a proposal waits that names the plan, or once a later plan of its sport has followed it", async () => {
    const at = NOW.toISOString();
    // The athlete's own run proposed an extension of the block: it waits for them.
    const op: Partial<PlanStructureOp> = { kind: "plan_structure", id: "plan", op: { kind: "extendPlan", planId: "lift1", shapeWeeks: [] } as never, date: "2026-05-25", why: "w", title: "t", summary: "s", lines: [], planKey: "plan:lift1", issues: [], toolUseId: "t1", at };
    await db.insert(schema.coachProposals).values({ id: "dp-other", userId, title: "t", evidence: "", rationale: "r", flags: [], ops: [op], status: "pending", createdAt: at, expiresAt: "2026-06-30" });
    expect(await pass()).toEqual({ started: 0 });
    expect((await rowPrompt())?.kind).toBe("draft_ready");
    await db.update(schema.coachProposals).set({ status: "declined" }).where(eq(schema.coachProposals.id, "dp-other"));
    expect(await pass(), "declined: nothing waits").toEqual({ started: 1 });
    // A later plan of its sport running on past it has followed it: nothing to draft (as the chip leaves it out).
    await db.delete(schema.auditEvents);
    await db.delete(schema.coachRuns);
    await db.update(schema.coachPlans).set({ endDate: "2026-05-12" }).where(eq(schema.coachPlans.id, "lift1"));
    await db.delete(schema.plannedWorkouts);
    await seedSession("2026-05-11", "lift1");
    expect((await rowPrompt())).toBeNull();
    expect(await pass(), "run out: a plan that continues has nothing to draft once it has ended").toEqual({ started: 0 });
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
    // The chip asks nothing meanwhile (the proposal is the conversation's card).
    expect((await readNudges(db, userId, prefs, TODAY, NOW, { drafts: true })).map((n) => n.id)).toEqual([]);
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

  it("a new ending, after approval, can draft again", async () => {
    const { run } = await draftAndDrive(proposing());
    // Approved: its block on the plan (as the apply lands it), the plan's last day now the new block's.
    await db.update(schema.coachProposals).set({ status: "approved", resolvedAt: NOW.toISOString() }).where(eq(schema.coachProposals.id, designProposalId(run.id)));
    const at = NOW.toISOString();
    await db.insert(schema.coachPlans).values({ id: "lift2", userId, discipline: "lift", name: "Next strength block", status: "active", startDate: "2026-05-25", endDate: "2026-05-31", raceDate: null, stampPrefix: "Next", programId: PLAN, createdAt: at, updatedAt: at });
    expect((await listPlans(db, userId, TODAY, { drafts: true })).find((p) => p.id === PLAN)!.prompt).toBeNull();
    expect(await pass()).toEqual({ started: 1 });
    expect((await keys()).map((k) => k.id).sort()).toEqual([KEY, planDraftKey(PLAN, "2026-05-31")].sort());
    expect(await runs()).toHaveLength(2);
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
    // Due: the blocks, then the create — preferences, the week, the key and the run in one batch.
    await db.update(schema.coachPlans).set({ endDate: LAST }).where(eq(schema.coachPlans.id, "lift1"));
    statements.length = 0;
    expect(await pass()).toEqual({ started: 1 });
    expect(statements).toHaveLength(1 + 2 + 1 + 4);
    expect(statements.filter(isWrite)).toHaveLength(2);
    // At the cap: the create's preferences and week, the live read, and the key.
    await db.delete(schema.coachRuns);
    await db.delete(schema.auditEvents);
    await spend(19_990_000);
    statements.length = 0;
    expect(await pass()).toEqual({ started: 0 });
    expect(statements).toHaveLength(1 + 2 + 1 + 2 + 1 + 1);
    expect(statements.filter(isWrite)).toHaveLength(1);
    // The athlete's own run live: the create's four (its batch writes nothing) and the live read that finds it.
    await db.delete(schema.llmUsage);
    await db.delete(schema.auditEvents);
    await createRun(db, userId, { request: "Something for my hips." }, NOW);
    statements.length = 0;
    expect(await pass()).toEqual({ started: 0 });
    expect(statements).toHaveLength(1 + 2 + 1 + 4 + 1);
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

  it("a plan's keys are found by the primary key's range, never by walking every account's audit rows", async () => {
    const lines = ((await db.all(sql`explain query plan select ${planDraftsSql(TODAY)} as d from programs where programs.user_id = ${userId}`)) as Array<{ detail: string }>).map((r) => r.detail.trim());
    expect(lines.some((l) => /^SEARCH a USING INDEX sqlite_autoindex_audit_events_1 \(id>\? AND id<\?\)$/.test(l))).toBe(true);
    expect(lines.some((l) => /^SCAN a\b/.test(l))).toBe(false);
  });

  it("an account with no running coach plan spends nothing past the pass's one read", async () => {
    await db.update(schema.programs).set({ status: "retired" }).where(and(eq(schema.programs.id, PLAN), eq(schema.programs.userId, userId)));
    statements.length = 0;
    expect(await pass()).toEqual({ started: 0 });
    expect(statements).toHaveLength(1);
  });
});
