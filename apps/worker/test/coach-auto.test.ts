/**
 * NO TIME FRAME UP FRONT: THE AUTO SCOPE (the new shape §5; stream A, part 2). A run created without a scope is an auto
 * run: it starts as one workout's — the single ceiling ($1.50, or the athlete's lower "day" limit) and its day's window —
 * with every tool a main run has and plan_set too. The coach decides from the athlete's words whether to answer, design
 * one workout (right now: today with no time, placed when approved; otherwise at a time it picks, 15 minutes ahead at
 * least), change the plan or plan several workouts. plan_set raises the run's ceiling to the set ceiling ($6, or the
 * athlete's lower "set" limit) once, recorded in the run (`settings.raisedAt`), with a set's window; its designers are
 * a week's (they never ask). The weekly cap still bounds everything: the start (`week_budget`), plan_set's own check and
 * every model call. A client that sends a scope gets exactly what it did before.
 *
 * The real registry, opening context and loop, driven by one scripted model for the whole tree; no key, no network.
 * Synthetic data only: the made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { COACH_RUN_SET_WINDOW_HOURS } from "../src/services/cron-limits.js";
import { answerRun, createRun, endedLine, LINES, RUN_CEILING_MICROS, runStep, WeekBudgetError, type RunDeps, type RunSettings } from "../src/services/coach-runs.js";
import { buildDesignContext, designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS, roleBlock } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult, ToolResultBlock } from "../src/services/llm-messages.js";
import { LLM_BUDGET } from "../src/services/llm.js";
import { savePreferences, loadPreferences } from "../src/services/calendar-sync.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, mountRoutes, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", COACH_DESIGNER: "1" } as Env;
const THU = day(-1);
const MON = day(-5);

let db: Db;
let userId: string;
let cookie: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await seedRichAthlete(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_auto${++seq}`, name, input });
const idOf = (b: ContentBlock): string => (b as { id: string }).id;
const turn = (...uses: ContentBlock[]): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, ...uses],
  stopReason: uses.length > 0 ? "tool_use" : "end_turn",
  usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});

function scripted(turns: MessagesResult[]) {
  const requests: MessagesRequest[] = [];
  const deps: RunDeps = {
    callModel: async (_env, req) => {
      requests.push(structuredClone(req));
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps, requests };
}

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = () => ({
  scores: Object.fromEntries(DIMS.map((d) => [d, 4])),
  notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])),
  mustFix: [],
  improvements: [],
});
const propose = (title: string, target: Record<string, unknown>) => use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", ...target } });
const brief = (key: string, date: string) => ({
  key,
  date,
  purpose: `Workout ${key}: hips and trunk, steady.`,
  emphasis: "Control over load.",
  constraints: "About 30 minutes, at home.",
  why: "Spaced away from the runs for recovery.",
});
/** One designer's whole life: a draft, its review, its finish. */
const designed = (title: string, date: string): MessagesResult[] => [
  turn(propose(title, { date })),
  turn(use("submit_review", verdict())),
  turn(use("finish", { summary: `${title}, as briefed.` })),
];

async function drive(runId: string, deps: RunDeps, o: { from?: number; until?: (status: string) => boolean } = {}) {
  let last = "";
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + ((o.from ?? 0) + i + 1) * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      last = out.result.status;
      return o.until ? o.until(last) : last !== "active";
    },
    { max: 60, what: "drive" },
  );
  return last;
}

function sent(requests: MessagesRequest[], call: ContentBlock): { is_error?: boolean; body: any } {
  for (const r of requests) {
    for (const m of r.messages) {
      if (m.role !== "user" || typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type === "tool_result" && b.tool_use_id === idOf(call)) {
          const t = b as ToolResultBlock;
          return { is_error: t.is_error, body: JSON.parse(typeof t.content === "string" ? t.content : JSON.stringify(t.content)) };
        }
      }
    }
  }
  throw new Error(`no result sent for ${idOf(call)}`);
}

const stateOf = async (id: string) => {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return { row: row!, state: JSON.parse(row!.state!) as { settings: Record<string, any> } };
};
const proposalOf = async (runId: string) => {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
  return p ? { ...p, ops: p.ops as Array<DocWorkoutOp> } : undefined;
};

async function post(body: unknown) {
  const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(() => scripted([]).deps));
  const res = await app.request("/api/coach/runs", { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const cancelAll = () => db.update(schema.coachRuns).set({ status: "cancelled" });

describe("a create with no scope is an auto run", () => {
  it("starts as one workout's: the single ceiling and its own window, the set's ceiling kept for plan_set; a scope sent is as before", async () => {
    const made = await post({ request: "Something for my hips." });
    expect(made.status).toBe(200);
    expect(made.body.run.scope).toEqual({ kind: "auto" });
    expect(made.body.run.ceilingUsd).toBe(1.5);
    const { state } = await stateOf(made.body.run.id);
    expect(state.settings).toMatchObject({ ceilingMicros: RUN_CEILING_MICROS.now, setCeilingMicros: RUN_CEILING_MICROS.week, window: { kind: "until" } });
    expect(state.settings.raisedAt).toBeUndefined();
    expect(RUN_CEILING_MICROS.auto).toBe(RUN_CEILING_MICROS.now);
    await cancelAll();
    // Named, it is the same.
    expect((await post({ scope: { kind: "auto" }, request: "Anything." })).body.run.scope).toEqual({ kind: "auto" });
    await cancelAll();
    // An old client that sends a scope gets exactly what it did.
    for (const scope of [{ kind: "now" }, { kind: "later_today" }, { kind: "week" }, { kind: "next_n", n: 2 }]) {
      const old = await post({ scope, request: "As before." });
      expect(old.body.run.scope, scope.kind).toEqual(scope);
      await cancelAll();
    }
  });

  it("under the athlete's own limits: the lower day limit to start, the lower set limit to rise to; a rehearsal keeps the defaults", async () => {
    const prefs = await loadPreferences(db, userId);
    await savePreferences(db, userId, { ...prefs, coach: { ceilingsUsd: { day: 0.8, set: 2.5 }, defaultScope: "week" } });
    const made = await post({ request: "Something." });
    expect(made.body.run.scope).toEqual({ kind: "auto" });
    expect((await stateOf(made.body.run.id)).state.settings).toMatchObject({ ceilingMicros: 800_000, setCeilingMicros: 2_500_000 });
    await cancelAll();
    const rehearsal = await post({ request: "Rehearse.", rehearsal: true });
    expect((await stateOf(rehearsal.body.run.id)).state.settings).toMatchObject({ ceilingMicros: RUN_CEILING_MICROS.now, setCeilingMicros: RUN_CEILING_MICROS.week });
  });

  it("never starts when the week can't pay one workout's run (409 week_budget)", async () => {
    await db.insert(schema.llmUsage).values({
      id: newId(), userId, kind: "design_main", model: "m", inputTokens: 1, outputTokens: 1, costMicros: LLM_BUDGET.cutoffMicros - 100_000, cacheHit: false, requestFingerprint: "x", createdAt: NOW.toISOString(),
    });
    await expect(createRun(db, userId, { scope: { kind: "auto" }, request: "Something." }, NOW)).rejects.toBeInstanceOf(WeekBudgetError);
  });

  it("the start's measure: an auto run that planned a set is a set's cost, one that didn't a single workout's", async () => {
    const finished = async (scope: unknown, usd: number, raised: boolean) => {
      const id = newId();
      await db.insert(schema.coachRuns).values({
        id, userId, parentId: null, role: "main", scope: scope as Record<string, unknown>, request: "x", status: "finished",
        state: JSON.stringify({ v: 1, settings: { ceilingMicros: 6_000_000, maxCalls: 12, effort: "high", maxTokens: 16_000, rehearsal: false, ...(raised ? { raisedAt: NOW.toISOString() } : {}) }, system: null, messages: [] }),
        steps: 3, costUsd: usd, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
      });
    };
    for (let i = 0; i < 3; i++) await finished({ kind: "now" }, 0.5, false);
    for (let i = 0; i < 4; i++) await finished({ kind: "auto" }, 5, true);
    await db.insert(schema.llmUsage).values({
      id: newId(), userId, kind: "design_main", model: "m", inputTokens: 1, outputTokens: 1, costMicros: 15_200_000, cacheHit: false, requestFingerprint: "x", createdAt: NOW.toISOString(),
    });
    // A single workout's median stays $0.50 (the sets aren't in it): 15.70 fits.
    const auto = await createRun(db, userId, { scope: { kind: "auto" }, request: "One." }, NOW);
    expect(auto.existing).toBe(false);
    await db.update(schema.coachRuns).set({ status: "cancelled" }).where(eq(schema.coachRuns.id, auto.run.id));
    // A set's median is the raised autos' $5: 20.20 doesn't.
    await expect(createRun(db, userId, { scope: { kind: "week" }, request: "A week." }, NOW)).rejects.toBeInstanceOf(WeekBudgetError);
  });
});

describe("an auto run designs one workout as now or later today did", () => {
  it("today with no time is right now: placed when it is approved; the finish makes it the athlete's; no raise", async () => {
    const run = await createRun(db, userId, { request: "Something for right now." }, NOW);
    expect(run.run.scope).toEqual({ kind: "auto" });
    const { deps } = scripted([turn(propose("Now hips", { date: TODAY })), turn(use("submit_review", verdict())), turn(use("finish", { summary: "Ready." }))]);
    expect(await drive(run.run.id, deps)).toBe("finished");
    const p = (await proposalOf(run.run.id))!;
    expect(p.status).toBe("pending");
    expect(p.ops[0]!.target).toMatchObject({ kind: "new", date: TODAY, atNow: true });
    const { state } = await stateOf(run.run.id);
    expect(state.settings.ceilingMicros).toBe(RUN_CEILING_MICROS.now);
    expect(state.settings.raisedAt).toBeUndefined();
  });

  it("a time today is held 15 minutes ahead, and kept as asked; another day takes its time or none", async () => {
    const run = await createRun(db, userId, { request: "This evening." }, NOW);
    // 09:30 in Los Angeles: 09:40 is too soon; 18:00 stands, as a time — not now.
    const soon = propose("Soon", { date: TODAY, time: "09:40" });
    const evening = propose("Evening hips", { date: TODAY, time: "18:00" });
    const { deps, requests } = scripted([turn(soon), turn(evening), turn(use("submit_review", verdict())), turn(use("finish", { summary: "Ready." }))]);
    expect(await drive(run.run.id, deps)).toBe("finished");
    expect(sent(requests, soon)).toMatchObject({ is_error: true, body: { error: "time_too_soon" } });
    const p = (await proposalOf(run.run.id))!;
    expect(p.ops[0]!.target).toEqual({ kind: "new", date: TODAY, time: "18:00" });
    const later = await createRun(db, userId, { request: "Thursday." }, new Date(NOW.getTime() + 600_000));
    const thursday = propose("Thursday hips", { date: THU });
    const second = scripted([turn(thursday), turn(use("submit_review", verdict())), turn(use("finish", { summary: "Ready." }))]);
    expect(await drive(later.run.id, second.deps, { from: 600 })).toBe("finished");
    expect((await proposalOf(later.run.id))!.ops[0]!.target).toEqual({ kind: "new", date: THU });
  });
});

describe("plan_set in an auto run", () => {
  it("raises the ceiling once to the set ceiling, recorded with a set's window; its designers are a week's and never ask; one proposal, a set's", async () => {
    const run = await createRun(db, userId, { request: "Plan Thursday and Monday for me." }, NOW);
    const mainId = run.run.id;
    const plan = use("plan_set", { briefs: [brief("thu", THU), brief("mon", MON)] });
    const ask = use("ask_athlete", { questions: [{ text: "Gym?", chips: ["Yes", "No"], why: "Place." }] });
    const redo = use("plan_set", { briefs: [{ ...brief("mon", MON), note: "Gentler." }] });
    const { deps, requests } = scripted([
      turn(plan),
      turn(ask),
      ...designed("Thursday hips", THU).slice(0),
      ...designed("Monday reset", MON),
      turn(redo),
      ...designed("Monday reset, gentler", MON),
      turn(use("finish", { summary: "Two sessions around the runs." })),
    ]);
    // The context, then plan_set: the run waits on its set, its ceiling raised.
    const step = async (i: number) => {
      const out = await runStep(db, env, mainId, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      return out.result;
    };
    await step(1);
    expect((await stateOf(mainId)).state.settings.raisedAt).toBeUndefined();
    expect((await step(2)).nextDue?.role).toBe("designer");
    expect((await stateOf(mainId)).row.status).toBe("waiting_set");
    const raised = (await stateOf(mainId)).state.settings;
    expect(raised.ceilingMicros).toBe(RUN_CEILING_MICROS.week);
    expect(typeof raised.raisedAt).toBe("string");
    expect(raised.window).toEqual({ kind: "until", at: new Date(Date.parse(raised.raisedAt) + COACH_RUN_SET_WINDOW_HOURS * 3_600_000).toISOString() });
    const designers = await db.select().from(schema.coachRuns).where(and(eq(schema.coachRuns.parentId, mainId), eq(schema.coachRuns.role, "designer")));
    expect(designers).toHaveLength(2);
    for (const d of designers) expect(d.scope).toEqual({ kind: "week" });
    expect(await drive(mainId, deps, { from: 3 })).toBe("finished");
    // The first designer's ask was refused: a set's designer can't ask.
    expect(sent(requests, ask)).toMatchObject({ is_error: true, body: { error: "set_designer_cannot_ask" } });
    // The redo kept the first raise.
    expect((await stateOf(mainId)).state.settings.raisedAt).toBe(raised.raisedAt);
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title).sort()).toEqual(["Monday reset, gentler", "Thursday hips"]);
    expect(run.run.ceilingUsd).toBe(1.5);
  });

  it("the week's cap still holds: a set the week can't pay is refused, naming the week", async () => {
    const run = await createRun(db, userId, { request: "Plan my week." }, NOW);
    await db.insert(schema.llmUsage).values({
      // (The weekly cap a step reads is the week to the wall clock's now.)
      id: newId(), userId, kind: "design_main", model: "m", inputTokens: 1, outputTokens: 1, costMicros: LLM_BUDGET.cutoffMicros - 2_000_000, cacheHit: false, requestFingerprint: "y", createdAt: new Date().toISOString(),
    });
    const plan = use("plan_set", { briefs: [brief("thu", THU), brief("mon", MON)] });
    const { deps, requests } = scripted([turn(plan), turn(use("finish", { summary: "The week's budget is nearly used." }))]);
    const status = await drive(run.run.id, deps);
    const trail = await db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, run.run.id));
    expect(status, JSON.stringify(trail.map((e) => [e.kind, e.summary]))).toBe("finished");
    const answer = sent(requests, plan);
    expect(answer.is_error).toBe(true);
    expect(answer.body.error).toBe("over_budget");
    // (A run ceiling's own figure: a set's, as plan_set weighs it — the week's is the tighter.)
    expect(answer.body.why).toMatch(/this week's AI budget has/);
    // Refused, the run is still one workout's: its ceiling and its day's window, never raised.
    const { state } = await stateOf(run.run.id);
    expect(state.settings).toMatchObject({ ceilingMicros: RUN_CEILING_MICROS.now, window: { kind: "until" } });
    expect(state.settings.raisedAt).toBeUndefined();
    expect(Date.parse(state.settings.window.at)).toBeLessThan(NOW.getTime() + COACH_RUN_SET_WINDOW_HOURS * 3_600_000);
  });

  it("an auto run stays open two hours at least, or to the athlete's midnight when that is later: a question at 23:50 still stands at 00:30", async () => {
    // 09:30 in Los Angeles: open to its midnight.
    const morning = await createRun(db, userId, { request: "Something." }, NOW);
    const { state: m } = await stateOf(morning.run.id);
    expect(m.settings.window).toEqual({ kind: "until", at: "2026-05-14T07:00:00.000Z" });
    await db.update(schema.coachRuns).set({ status: "cancelled" }).where(eq(schema.coachRuns.id, morning.run.id));
    // 23:50 in Los Angeles: two hours, past its midnight.
    const late = new Date("2026-05-14T06:50:00Z");
    const run = await createRun(db, userId, { request: "Something for tomorrow morning?" }, late);
    expect((await stateOf(run.run.id)).state.settings.window).toEqual({ kind: "until", at: "2026-05-14T08:50:00.000Z" });
    const ask = use("ask_athlete", { questions: [{ text: "Before work or after?", chips: ["Before", "After"], why: "It decides the time." }] });
    const d = scripted([turn(ask)]).deps;
    for (let i = 1; i <= 2; i++) await runStep(db, env, run.run.id, userId, new Date(late.getTime() + i * 1000), d);
    const answered = await answerRun(db, userId, run.run.id, { answers: ["Before"] }, new Date("2026-05-14T07:30:00Z"));
    expect(answered.kind).toBe("ok");
  });

  it("an auto run that outlives its window says its day has passed, as a day's run does (its window ends at its midnight at least); one that planned a set says a set's", async () => {
    // 23:50 in Los Angeles, a question left unanswered: the step after 01:50 finds the window closed.
    const late = new Date("2026-05-14T06:50:00Z");
    const run = await createRun(db, userId, { request: "Something for tomorrow morning?" }, late);
    const ask = use("ask_athlete", { questions: [{ text: "Before work or after?", chips: ["Before", "After"], why: "It decides the time." }] });
    const d = scripted([turn(ask)]).deps;
    for (let i = 1; i <= 2; i++) await runStep(db, env, run.run.id, userId, new Date(late.getTime() + i * 1000), d);
    await runStep(db, env, run.run.id, userId, new Date("2026-05-14T09:00:00Z"), d);
    const linesOf = async (id: string) =>
      (await db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, id)).orderBy(schema.coachRunEvents.seq)).map((e) => e.summary);
    expect((await stateOf(run.run.id)).row.status).toBe("expired");
    expect((await linesOf(run.run.id)).slice(-2)).toEqual([LINES.expiredDay, LINES.nothingProposed]);
    // The conversation's line for it, and for an auto run that planned a set (a set's window from its raise).
    const settings = (await stateOf(run.run.id)).state.settings as RunSettings;
    expect(endedLine("expired", "expired", settings)).toBe(LINES.expiredDay);
    expect(endedLine("expired", "expired", { ...settings, raisedAt: late.toISOString(), window: { kind: "until", at: "2026-05-15T06:50:00.000Z" } })).toBe(LINES.expiredSet);

    // One whose workout for a later day is suggested as it closes says so in one line, as a day's run does.
    const t0 = new Date("2026-05-14T09:01:00Z");
    const second = await createRun(db, userId, { request: "Something for tomorrow?" }, t0);
    const morning = use("ask_athlete", { questions: [{ text: "Morning or evening?", chips: ["Morning", "Evening"], why: "It decides the time." }] });
    const s = scripted([turn(propose("Friday hips", { date: day(-2) })), turn(use("submit_review", verdict())), turn(morning)]).deps;
    let status = "";
    for (let i = 1; i <= 20 && status !== "waiting_athlete"; i++) {
      const out = await runStep(db, env, second.run.id, userId, new Date(t0.getTime() + i * 1000), s);
      if (out.kind === "ok") status = out.result.status;
    }
    expect(status).toBe("waiting_athlete");
    await runStep(db, env, second.run.id, userId, new Date("2026-05-15T08:00:00Z"), s);
    expect((await stateOf(second.run.id)).row.status).toBe("expired");
    expect((await proposalOf(second.run.id))!.status).toBe("pending");
    expect((await linesOf(second.run.id)).at(-1)).toBe(LINES.expiredDayLater);
  });

  it("old scopes are as they were: a now run can't plan a set, a week's main coach doesn't propose", async () => {
    const now = await createRun(db, userId, { scope: { kind: "now" }, request: "x" }, NOW);
    const plan = use("plan_set", { briefs: [brief("thu", THU)] });
    const a = scripted([turn(plan), turn(use("finish", { summary: "No." }))]);
    await drive(now.run.id, a.deps);
    expect(sent(a.requests, plan)).toMatchObject({ is_error: true, body: { error: "not_for_scope" } });
    const week = await createRun(db, userId, { scope: { kind: "week" }, request: "x" }, new Date(NOW.getTime() + 60_000));
    const p = propose("Mine", { date: THU });
    const b = scripted([turn(p), turn(use("finish", { summary: "No." }))]);
    await drive(week.run.id, b.deps, { from: 60 });
    expect(sent(b.requests, p)).toMatchObject({ is_error: true, body: { error: "not_for_scope" } });
  });
});

describe("the prompt and the opening message", () => {
  it("the main coach's block says how to choose when the scope is the coach's own", () => {
    const main = roleBlock("main", 12);
    expect(main).toMatch(/more than one workout or a stretch of days/);
    expect(main).toMatch(/plan_set/);
    expect(main).toMatch(/[Rr]ight now/);
    expect(main).toMatch(/two to four/);
    expect(main).toMatch(/answer in words/i);
  });

  it("an auto run's scope line leaves the choice to the coach; the plan is read two weeks ahead", async () => {
    const built = await buildDesignContext(db, env, userId, { id: "r1", role: "main", scope: { kind: "auto" }, request: "x", parentId: null }, NOW);
    expect(built.header).toMatch(/Scope: yours to choose from the request/);
    expect(built.header).toContain(`plan ${TODAY} to ${day(-13)}`);
  });
});
