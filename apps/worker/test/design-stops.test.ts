/**
 * A STOP PROPOSES WHAT WAS REVIEWED (Stage 3 fix wave 3A, A2) — AND THE WEEK'S CAP IS A HARD CEILING (A5).
 *
 * Every way a design tree stops but the athlete's cancel proposes what had been reviewed: the money stops, the account
 * out of credits or no key, the state cap, the main run's retries run out, a refusal, a rejected call, an internal error,
 * a designer's failure that stops the whole tree, and the run's window closing (a workout whose day has passed left
 * out). Each stop's lines say exactly what happened: that the coach stopped, then what was proposed — or that nothing
 * was. A cancel proposes nothing. Before every model call the week's spend plus the call's worst case must fit under the
 * weekly cutoff, or the call isn't made and the tree takes the same stop.
 *
 * The real registry, the real opening context and the real loop, driven by ONE scripted model shared by every run of
 * the tree. No key, no network, no billed call. Synthetic data only: the made-up athlete of design-read-fixture.ts, on
 * its fixed clock.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { dayLabel } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import {
  cancelRun,
  createRun,
  LINES,
  PROMPT_BYTES_PER_TOKEN,
  ROUTE_OVERHEAD,
  RUN_LIMITS,
  runStep,
  STEP_BUDGET,
  sweepCoachRuns,
  type RunDeps,
} from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { pastDayLine, STOPPED_NOTES, stoppedNote } from "../src/services/design-review.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import { designModel, messagesCostMicros, type ContentBlock, type MessagesOk, type MessagesRequest, type MessagesResult } from "../src/services/llm-messages.js";
import { LLM_BUDGET } from "../src/services/llm.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let db: Db;
let statements = 0;

beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
});

const athlete = () => seedRichAthlete(db);

// ── One scripted model for the whole tree ───────────────────────────────

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_stop${++seq}`, name, input });

function turn(uses: ContentBlock[], o: { cost?: number; text?: string } = {}): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text: o.text ?? "Working on it." }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: o.cost ?? 1_000,
  };
}
const t = (...uses: ContentBlock[]) => turn(uses);

type Scripted = MessagesResult | (() => MessagesResult | Promise<MessagesResult>);

function scripted(turns: Scripted[]) {
  const requests: MessagesRequest[] = [];
  const deps: RunDeps = {
    callModel: async (_env, req) => {
      requests.push(structuredClone(req));
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return typeof next === "function" ? await next() : next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  return { deps, requests };
}

/** Step the main run until it is no longer active (bounded); `at` seconds after NOW for the first step. */
async function drive(userId: string, runId: string, deps: RunDeps, o: { from?: number; max?: number } = {}) {
  const all: Array<{ status: string }> = [];
  const from = o.from ?? 0;
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + (from + i) * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      all.push(out.result);
      return out.result.status !== "active";
    },
    { max: o.max ?? 80, what: "drive" },
  );
  return all;
}

/** One step, counted as the route counts it: its statements, the route's own two, and one fetch when the model was called. */
async function counted(userId: string, runId: string, deps: RunDeps, now: Date, requests: MessagesRequest[]) {
  statements = 0;
  const calls = requests.length;
  const out = await runStep(db, env, runId, userId, now, deps);
  if (out.kind !== "ok") throw new Error(out.kind);
  return { cost: ROUTE_OVERHEAD + statements + (requests.length - calls), status: out.result.status };
}

async function proposalOf(mainRunId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(mainRunId)));
  return p ? { ...p, ops: p.ops as DocWorkoutOp[], flags: p.flags as string[] } : undefined;
}
async function runRow(id: string) {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return row!;
}
async function designersOf(mainId: string) {
  return db
    .select()
    .from(schema.coachRuns)
    .where(and(eq(schema.coachRuns.parentId, mainId), eq(schema.coachRuns.role, "designer")))
    .orderBy(schema.coachRuns.createdAt, schema.coachRuns.id);
}
async function lines(runId: string) {
  return (await db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId)).orderBy(schema.coachRunEvents.seq)).map((e) => e.summary);
}

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
function verdict(score: number) {
  return {
    scores: Object.fromEntries(DIMS.map((d) => [d, score])) as Record<string, number>,
    notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])) as Record<string, string>,
    mustFix: [],
    improvements: [],
  };
}

const propose = (title: string, date: string) => use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date } });
const submit = (v: unknown) => use("submit_review", v);
const finish = (summary: string) => use("finish", { summary });
const brief = (key: string, date: string) => ({
  key,
  date,
  purpose: `Workout ${key}: hips and trunk, steady.`,
  emphasis: "Control over load.",
  constraints: "About 30 minutes, at home.",
  why: "Spaced away from the runs for recovery.",
  sameDayWhy: "A short session beside what the day holds.",
});
const planSet = (briefs: Array<ReturnType<typeof brief> & { note?: string }>) => use("plan_set", { briefs });
/** One designer's whole life: a draft, its review, its finish. */
const designed = (title: string, date: string): Scripted[] => [t(propose(title, date)), t(submit(verdict(4))), t(finish(`${title}, as briefed.`))];
const ask = () => use("ask_athlete", { questions: [{ text: "Is Saturday's event still on?", chips: ["Yes", "No"], why: "It decides Saturday's session." }] });

const nowRun = async (userId: string) => (await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm for the hips." }, NOW)).run.id;
const weekRun = async (userId: string) => (await createRun(db, userId, { scope: { kind: "week" }, request: "Plan my week around the runs." }, NOW)).run.id;

/** A now run's context, its draft and the draft's clean review, its reviewer over, and the main run resumed. */
const REVIEWED: Scripted[] = [t(propose("Calm hips", TODAY)), t(submit(verdict(4)))];
const STEPS_TO_REVIEWED = 5;

// ── A2: every stop but a cancel proposes what was reviewed ──────────────

describe("a set's designer stopping the whole tree proposes the reviewed workouts", () => {
  it("a 402 at designer 6 of 7: the five reviewed workouts are proposed, the two days without one named — counted", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const days = [0, 1, 2, 3, 4, 5, 6].map((k) => day(-k));
    const { deps, requests } = scripted([
      t(planSet(days.map((d, i) => brief(`d${i + 1}`, d)))),
      ...days.slice(0, 5).flatMap((d, i) => designed(`Day ${i + 1} hips`, d)),
      { ok: false, kind: "out_of_credits", reason: "gateway_402", status: 402 },
    ]);
    // Everything up to designer 6's model call, which the next step makes.
    await untilDone(
      async (i) => {
        const out = await runStep(db, env, mainId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
        if (out.kind !== "ok") throw new Error(out.kind);
        return requests.length === 1 + 5 * 3 && (await designersOf(mainId))[5]!.steps === 1;
      },
      { max: 80, what: "to designer 6" },
    );
    const stop = await counted(a.userId, mainId, deps, new Date(NOW.getTime() + 100_000), requests);
    expect(stop.status).toBe("failed");
    expect(await runRow(mainId)).toMatchObject({ status: "failed", error: "gateway_402" });
    expect((await designersOf(mainId)).map((d) => d.status)).toEqual(["finished", "finished", "finished", "finished", "finished", "failed", "failed"]);

    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Day 1 hips", "Day 2 hips", "Day 3 hips", "Day 4 hips", "Day 5 hips"]);
    expect(p.flags).toEqual([STOPPED_NOTES.gateway_402, `Not designed before the stop: ${dayLabel(days[5]!)}, ${dayLabel(days[6]!)}.`]);
    expect((await lines(mainId)).slice(-2)).toEqual([LINES.outOfCredits, LINES.proposed]);
    // The tree, the claim, the weekly cap, the usage row and its update, the call, the standing read (the restore marker
    // and the still-ours read, one statement), the credits marker, the designer's write, the rest of the tree stopped,
    // the proposal read and made pending, the older plans superseded, the lines.
    expect(stop.cost).toBe(2 + 13 + 1);
    expect(stop.cost).toBeLessThanOrEqual(STEP_BUDGET);
  });
});

describe("the main run's own stops propose its reviewed draft", () => {
  it("the state cap after a clean review: the workout is proposed, and the stop's line claims nothing", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps } = scripted([...REVIEWED, turn([], { text: "x".repeat(70_000) })]);
    expect((await drive(a.userId, runId, deps)).at(-1)!.status).toBe("stopped_cap");
    expect(await runRow(runId)).toMatchObject({ status: "stopped_cap", error: "state_cap" });
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.flags).toEqual([STOPPED_NOTES.state_cap]);
    expect((await lines(runId)).slice(-2)).toEqual([LINES.stateCap, LINES.proposed]);
    expect(LINES.stateCap).not.toMatch(/with what it had/);
    expect(LINES.stepCap).not.toMatch(/with what it had/);
  });

  const failures: Array<{ name: string; error: string; line: string; tail: Scripted[] }> = [
    {
      name: "retries run out",
      error: "retries",
      line: LINES.retries,
      tail: [1, 2, 3].map(() => ({ ok: false, kind: "retryable", reason: "gateway_503", status: 503 }) as MessagesResult),
    },
    { name: "a refusal", error: "refusal", line: LINES.refusal, tail: [{ ...turn([]), stopReason: "refusal" }] },
    { name: "a rejected call", error: "gateway_400", line: LINES.rejected, tail: [{ ok: false, kind: "rejected", reason: "gateway_400", status: 400 }] },
    { name: "no key", error: "no_key", line: LINES.noKey, tail: [{ ok: false, kind: "no_key", reason: "no_key" }] },
    {
      name: "an internal error",
      error: "internal",
      line: LINES.internal,
      tail: [
        () => {
          throw new Error("boom");
        },
      ],
    },
  ];
  for (const f of failures) {
    it(`${f.name} after a clean review: the reviewed draft is proposed with its note`, async () => {
      const a = await athlete();
      const runId = await nowRun(a.userId);
      const { deps } = scripted([...REVIEWED, ...f.tail]);
      // Retries are spaced: drive steps until the run is over.
      await untilDone(
        async (i) => {
          const out = await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 60_000), deps);
          if (out.kind !== "ok") throw new Error(out.kind);
          return out.result.status !== "active";
        },
        { max: 20, what: f.name },
      );
      expect(await runRow(runId)).toMatchObject({ status: "failed", error: f.error });
      const p = (await proposalOf(runId))!;
      expect(p.status).toBe("pending");
      expect(p.flags).toEqual([stoppedNote(f.error)]);
      expect((await lines(runId)).slice(-2)).toEqual([f.line, LINES.proposed]);
    });
  }

  it("a rejected call's code has a note of its own", () => {
    expect(stoppedNote("gateway_400")).toMatch(/refused a request; this is what had been reviewed by then\.$/);
    for (const code of ["state_cap", "gateway_402", "no_key", "retries", "refusal", "internal", "bad_state", "expired"]) {
      expect(STOPPED_NOTES[code], code).toMatch(/this is what had been reviewed by then\.$/);
    }
  });

  it("a stop with nothing reviewed proposes nothing, and says so", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps } = scripted([t(propose("Calm hips", TODAY)), { ok: false, kind: "no_key", reason: "no_key" }]);
    expect((await drive(a.userId, runId, deps)).at(-1)!.status).toBe("failed");
    expect((await proposalOf(runId))!.status).toBe("unreviewed");
    expect((await lines(runId)).slice(-2)).toEqual([LINES.noKey, LINES.nothingProposed]);
  });

  it("a cancel proposes nothing: the reviewed draft is closed with the run", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps } = scripted([...REVIEWED]);
    for (let i = 0; i < STEPS_TO_REVIEWED; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
    expect((await proposalOf(runId))!.ops[0]!.review).toBeDefined();
    await cancelRun(db, a.userId, runId, new Date(NOW.getTime() + 10_000));
    expect((await proposalOf(runId))!.status).toBe("cancelled");
    expect((await lines(runId)).at(-1)).toBe("Cancelled.");
  });
});

describe("a set that expires proposes its reviewed workouts still ahead", () => {
  it("waiting on an answer past its window: the future workouts are proposed, a past-dated one left out with a line — counted", async () => {
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const [wed, thu, sat] = [TODAY, day(-1), day(-3)];
    const { deps, requests } = scripted([
      t(planSet([brief("wed", wed), brief("thu", thu), brief("sat", sat)])),
      ...designed("Wednesday hips", wed),
      ...designed("Thursday trunk", thu),
      ...designed("Saturday reset", sat),
      t(ask()),
    ]);
    const steps = await drive(a.userId, mainId, deps);
    expect(steps.at(-1)!.status).toBe("waiting_athlete");
    // A day and an hour later, the next step finds the window closed (the athlete's today is now Thursday).
    const expired = await counted(a.userId, mainId, deps, new Date(NOW.getTime() + 25 * 3_600_000), requests);
    expect(expired.status).toBe("expired");
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Thursday trunk", "Saturday reset"]);
    expect(p.flags).toEqual([STOPPED_NOTES.expired, `Its day passed before it could be suggested, so left out: “Wednesday hips” (${dayLabel(wed)}).`]);
    expect((await lines(mainId)).slice(-2)).toEqual([LINES.expiredSet, LINES.proposed]);
    // The tree, the expiry, the proposal read and made pending, the older plans superseded, the lines.
    expect(expired.cost).toBe(2 + 6);
  });

  it("a now run past its day: its workout's day has passed, so nothing is proposed and the draft is closed", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps, requests } = scripted([...REVIEWED, t(ask())]);
    for (let i = 0; i < STEPS_TO_REVIEWED + 1; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
    expect((await runRow(runId)).status).toBe("waiting_athlete");
    const expired = await counted(a.userId, runId, deps, new Date(NOW.getTime() + 25 * 3_600_000), requests);
    expect(expired.status).toBe("expired");
    expect((await proposalOf(runId))!.status).toBe("expired");
    expect((await lines(runId)).slice(-2)).toEqual([LINES.expiredDay, LINES.nothingProposed]);
    // The tree, the expiry, the proposal read, the proposal closed, the lines.
    expect(expired.cost).toBe(2 + 5);
  });

  it("the past-day line names each workout left out", () => {
    const op = { doc: calmDoc({ title: "Hips" }), date: TODAY } as unknown as DocWorkoutOp;
    expect(pastDayLine([op])).toBe(`Its day passed before it could be suggested, so left out: “Hips” (${dayLabel(TODAY)}).`);
  });
});

// ── A5: the week's cap is a hard ceiling ────────────────────────────────

describe("the week's AI budget is a hard ceiling: a call is made only when its worst case fits", () => {
  async function spentThisWeek(userId: string, micros: number) {
    await db.insert(schema.llmUsage).values({
      id: `week-${userId}`,
      userId,
      kind: "coach_wake",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: micros,
      cacheHit: false,
      createdAt: new Date().toISOString(),
    });
  }

  it("$19.80 spent: the call (its output alone up to $0.32) isn't made; the run stops at the weekly limit and proposes its reviewed draft", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps, requests } = scripted([...REVIEWED, t(finish("Done."))]);
    for (let i = 0; i < STEPS_TO_REVIEWED; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
    expect(LLM_BUDGET.cutoffMicros).toBe(20_000_000);
    await spentThisWeek(a.userId, 19_800_000);
    const calls = requests.length;
    const out = await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + 10_000), deps);
    expect(out.kind === "ok" && out.result.status).toBe("stopped_cap");
    expect(requests.length).toBe(calls);
    expect(await runRow(runId)).toMatchObject({ status: "stopped_cap", error: "weekly_cap" });
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.flags).toEqual([STOPPED_NOTES.weekly_cap]);
    expect((await lines(runId)).slice(-2)).toEqual([LINES.weeklyCap, LINES.proposed]);
  });

  it("$19.50 spent: the call's worst case still fits, and it is made", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps, requests } = scripted([...REVIEWED, t(finish("Done."))]);
    for (let i = 0; i < STEPS_TO_REVIEWED; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
    await spentThisWeek(a.userId, 19_500_000);
    const calls = requests.length;
    const out = await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + 10_000), deps);
    expect(out.kind === "ok" && out.result.status).toBe("finished");
    expect(requests.length).toBe(calls + 1);
  });
});

// ── Round 2 (the re-review of part A) ───────────────────────────────────

/** A verdict that lands between a promote's read and its write — a reviewer's step still live while its tree stops —
 * as another request would write it: the first promote of the proposal loses its `ops IS` guard. */
function racing(proposalId: string) {
  let raced = false;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop !== "all") return value.bind(target);
      return async (q: { queryChunks?: Array<{ value?: unknown }> }) => {
        const text = (q.queryChunks ?? []).map((c) => (Array.isArray(c?.value) ? c.value.join("") : "")).join("");
        if (!raced && text.includes("SET status = 'pending', ops =")) {
          raced = true;
          await db.run(sql`UPDATE coach_proposals SET ops = json_set(ops, '$[0].review.note', 'A verdict that landed late.') WHERE id = ${proposalId}`);
        }
        return (value as (q: unknown) => Promise<unknown>).call(target, q);
      };
    },
  });
  return { db: proxy as Db, raced: () => raced };
}

type ExpiryPath = "step" | "create" | "sweep";
const EXPIRY_PATHS: ExpiryPath[] = ["step", "create", "sweep"];

/** The main run's window closed: found by its next step, by a new run's create, or by the hourly sweep. */
async function expireBy(path: ExpiryPath, userId: string, mainId: string, deps: RunDeps, at: Date) {
  if (path === "step") return runStep(db, env, mainId, userId, at, deps);
  if (path === "create") return createRun(db, userId, { scope: { kind: "now" }, request: "Something new." }, at);
  return sweepCoachRuns(db, env, userId, at, deps, { maxSteps: 0 });
}

/** Steps the set until `done` says so (bounded), from NOW. */
async function stepUntil(userId: string, mainId: string, deps: RunDeps, done: () => Promise<boolean>, what: string) {
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, mainId, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(out.kind);
      return done();
    },
    { max: 60, what },
  );
}

const DAY_AND_AN_HOUR = 25 * 3_600_000;

describe("an expiry proposes the same, whoever finds it (round 2, A-I1)", () => {
  it("a redone set expiring before its main run resumes proposes Thursday and Saturday's redo — never both Saturdays — by a step, a create or the sweep", async () => {
    const [thu, sat] = [day(-1), day(-3)];
    const seen: Array<{ path: ExpiryPath; status: string; titles: string[]; flags: string[] }> = [];
    for (const path of EXPIRY_PATHS) {
      const a = await athlete();
      const mainId = await weekRun(a.userId);
      const { deps } = scripted([
        t(planSet([brief("thu", thu), brief("sat", sat)])),
        ...designed("Thursday trunk", thu),
        ...designed("Saturday reset", sat),
        t(planSet([{ ...brief("sat", sat), note: "Gentler: it follows the long run." }])),
        t(propose("Saturday, gentler", sat)),
        t(submit(verdict(5))),
        t(finish("Gentler, as asked.")),
      ]);
      // Up to the redo's finish: the main run would settle the redo at its next step.
      await stepUntil(
        a.userId,
        mainId,
        deps,
        async () => {
          const ds = await designersOf(mainId);
          return ds.length === 3 && ds[2]!.status === "finished";
        },
        "to the redo's finish",
      );
      expect((await proposalOf(mainId))!.ops.map((o) => o.doc.title)).toEqual(["Thursday trunk", "Saturday reset", "Saturday, gentler"]);
      await expireBy(path, a.userId, mainId, deps, new Date(NOW.getTime() + DAY_AND_AN_HOUR));
      expect((await runRow(mainId)).status, path).toBe("expired");
      const p = (await proposalOf(mainId))!;
      seen.push({ path, status: p.status, titles: p.ops.map((o) => o.doc.title), flags: p.flags });
    }
    for (const s of seen) {
      expect(s, s.path).toEqual({ path: s.path, status: "pending", titles: ["Thursday trunk", "Saturday, gentler"], flags: [STOPPED_NOTES.expired] });
    }
  });

  it("a set expiring after a designer failed names that day — by a step, a create or the sweep", async () => {
    const [thu, fri, sat] = [day(-1), day(-2), day(-3)];
    const seen: Array<{ path: ExpiryPath; status: string; titles: string[]; flags: string[] }> = [];
    for (const path of EXPIRY_PATHS) {
      const a = await athlete();
      const mainId = await weekRun(a.userId);
      const { deps } = scripted([
        t(planSet([brief("thu", thu), brief("fri", fri), brief("sat", sat)])),
        ...designed("Thursday trunk", thu),
        { ...turn([]), stopReason: "refusal" },
        ...designed("Saturday reset", sat),
      ]);
      // Every designer over — Friday's failed — and the main run not yet resumed.
      await stepUntil(
        a.userId,
        mainId,
        deps,
        async () => {
          const ds = await designersOf(mainId);
          return ds.length === 3 && ds.every((d) => d.status === "finished" || d.status === "failed");
        },
        "to the last designer's finish",
      );
      expect((await designersOf(mainId)).map((d) => d.status)).toEqual(["finished", "failed", "finished"]);
      await expireBy(path, a.userId, mainId, deps, new Date(NOW.getTime() + DAY_AND_AN_HOUR));
      const p = (await proposalOf(mainId))!;
      seen.push({ path, status: p.status, titles: p.ops.map((o) => o.doc.title), flags: p.flags });
    }
    for (const s of seen) {
      expect(s, s.path).toEqual({
        path: s.path,
        status: "pending",
        titles: ["Thursday trunk", "Saturday reset"],
        flags: [STOPPED_NOTES.expired, `Not designed before the stop: ${dayLabel(fri)}.`],
      });
    }
  });
});

describe("a stop names a day once (round-2 minors)", () => {
  it("a set settled with a failed designer, then a stop: the day its proposal already says has no workout is not named again", async () => {
    const [thu, fri, sat] = [day(-1), day(-2), day(-3)];
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const { deps } = scripted([
      t(planSet([brief("thu", thu), brief("fri", fri), brief("sat", sat)])),
      ...designed("Thursday trunk", thu),
      { ...turn([]), stopReason: "refusal" },
      ...designed("Saturday reset", sat),
      // The main run resumes with the set's outcome, then its next call finds no key.
      { ok: false, kind: "no_key", reason: "no_key" },
    ]);
    await drive(a.userId, mainId, deps);
    expect((await runRow(mainId)).status).toBe("failed");
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Thursday trunk", "Saturday reset"]);
    expect(p.flags.filter((f) => f.includes(dayLabel(fri)))).toHaveLength(1);
    expect(p.flags[0]).toMatch(new RegExp(`^No workout on ${dayLabel(fri)}: `));
    expect(p.flags).not.toContainEqual(expect.stringMatching(/^Not designed before the stop/));
  });

  it("a redo's designer that never designed is not named: its key's first version is proposed", async () => {
    const [thu, sat, sun] = [day(-1), day(-3), day(-4)];
    const a = await athlete();
    const mainId = await weekRun(a.userId);
    const { deps } = scripted([
      t(planSet([brief("thu", thu), brief("sat", sat)])),
      ...designed("Thursday trunk", thu),
      ...designed("Saturday reset", sat),
      // A redo of Saturday's, briefed for Sunday; its designer fails, and the main run then finds no key.
      t(planSet([{ ...brief("sat", sun), note: "Move it a day: Saturday is the long run." }])),
      { ...turn([]), stopReason: "refusal" },
      { ok: false, kind: "no_key", reason: "no_key" },
    ]);
    await drive(a.userId, mainId, deps);
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Thursday trunk", "Saturday reset"]);
    expect(p.flags).not.toContainEqual(expect.stringMatching(/^Not designed before the stop/));
  });
});

describe("a promote that loses to a late verdict reads again before it gives up (round 2, A-M3)", () => {
  it("an expiry: the proposal is read again and proposed, the verdict kept — never closed — with one line for a day run whose workout is for a later day (A-M7)", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps } = scripted([t(propose("Calm hips", day(-1))), t(submit(verdict(4))), t(ask())]);
    for (let i = 0; i < STEPS_TO_REVIEWED + 1; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
    expect((await runRow(runId)).status).toBe("waiting_athlete");
    const r = racing(designProposalId(runId));
    const out = await runStep(r.db, env, runId, a.userId, new Date(NOW.getTime() + DAY_AND_AN_HOUR), deps);
    expect(out.kind === "ok" && out.result.status).toBe("expired");
    expect(r.raced()).toBe(true);
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.ops[0]!.review!.note).toBe("A verdict that landed late.");
    expect(p.flags).toEqual([STOPPED_NOTES.expired]);
    // Its window was the day it began on, which has passed; its workout is tomorrow's: one line, no contradiction.
    const trail = await lines(runId);
    expect(trail.at(-1)).toBe("The day this was designed for has passed. The workouts for later days are suggested.");
    expect(trail).not.toContain(LINES.expiredDay);
    expect(trail).not.toContain(LINES.proposed);
  });

  it("a set's expiry: its proposal is read again and proposed, the verdict kept — and only its own designers are read", async () => {
    const a = await athlete();
    // Another main run's designer that failed on Friday, long ago: never this set's, so never named by its stop.
    await db.insert(schema.coachRuns).values({
      id: `ds-elsewhere-${a.userId}`,
      userId: a.userId,
      parentId: "another-main-run",
      role: "designer",
      scope: { kind: "week" },
      request: null,
      status: "failed",
      state: JSON.stringify({ day: day(-2) }),
      steps: 1,
      costUsd: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const mainId = await weekRun(a.userId);
    const [thu, sat] = [day(-1), day(-3)];
    const { deps } = scripted([t(planSet([brief("thu", thu), brief("sat", sat)])), ...designed("Thursday trunk", thu), ...designed("Saturday reset", sat), t(ask())]);
    expect((await drive(a.userId, mainId, deps)).at(-1)!.status).toBe("waiting_athlete");
    const r = racing(designProposalId(mainId));
    const out = await runStep(r.db, env, mainId, a.userId, new Date(NOW.getTime() + DAY_AND_AN_HOUR), deps);
    expect(out.kind === "ok" && out.result.status).toBe("expired");
    expect(r.raced()).toBe(true);
    const p = (await proposalOf(mainId))!;
    expect(p.status).toBe("pending");
    expect(p.ops.map((o) => o.doc.title)).toEqual(["Thursday trunk", "Saturday reset"]);
    expect(p.ops[0]!.review!.note).toBe("A verdict that landed late.");
    expect(p.flags).toEqual([STOPPED_NOTES.expired]);
    expect((await lines(mainId)).slice(-2)).toEqual([LINES.expiredSet, LINES.proposed]);
  });

  it("a stop: the proposal is read again and proposed, the verdict kept", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    const { deps } = scripted([...REVIEWED, { ok: false, kind: "no_key", reason: "no_key" }]);
    for (let i = 0; i < STEPS_TO_REVIEWED; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
    const r = racing(designProposalId(runId));
    const out = await runStep(r.db, env, runId, a.userId, new Date(NOW.getTime() + 10_000), deps);
    expect(out.kind === "ok" && out.result.status).toBe("failed");
    expect(r.raced()).toBe(true);
    const p = (await proposalOf(runId))!;
    expect(p.status).toBe("pending");
    expect(p.ops[0]!.review!.note).toBe("A verdict that landed late.");
    expect((await lines(runId)).slice(-2)).toEqual([LINES.noKey, LINES.proposed]);
  });
});

describe("the week's cap prices a call's prompt as its usage row does (round 2, A-M2)", () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text).length;
  /** What the row written before the next call records: the prompt (the stored state and the tools) as a cache write,
   * the output at the call's ceiling. */
  async function worstOf(runId: string): Promise<number> {
    const tools = allTools().map((x) => ({ name: x.name, description: x.description, input_schema: x.inputSchema }));
    const promptTokens = Math.ceil((bytesOf((await runRow(runId)).state!) + bytesOf(JSON.stringify(tools))) / PROMPT_BYTES_PER_TOKEN);
    return messagesCostMicros(designModel(env), { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: promptTokens, outputTokens: RUN_LIMITS.main.maxTokens });
  }
  async function spentThisWeek(userId: string, micros: number) {
    await db.insert(schema.llmUsage).values({
      id: `week-${userId}`,
      userId,
      kind: "coach_wake",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: micros,
      cacheHit: false,
      createdAt: new Date().toISOString(),
    });
  }
  /** The week's spend as the call is made: the spend before it, and the row written for it. */
  async function recordedAtTheCall(userId: string, runId: string): Promise<number> {
    const [row] = (await db.all(sql`
      SELECT (SELECT cost_micros FROM llm_usage WHERE id = ${`week-${userId}`}) +
        (SELECT max(cost_micros) FROM llm_usage WHERE request_fingerprint LIKE ${`run:${runId}:%`}) AS total
    `)) as Array<{ total: number }>;
    return row!.total;
  }

  it("a call admitted at the cutoff less its worst case records exactly the cutoff, never more; a micro more and it isn't made", async () => {
    const a = await athlete();
    const runId = await nowRun(a.userId);
    let recorded = -1;
    const { deps } = scripted([
      ...REVIEWED,
      async () => {
        recorded = await recordedAtTheCall(a.userId, runId);
        return t(finish("Done."));
      },
    ]);
    for (let i = 0; i < STEPS_TO_REVIEWED; i++) await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + i * 1000), deps);
    await spentThisWeek(a.userId, LLM_BUDGET.cutoffMicros - (await worstOf(runId)));
    const out = await runStep(db, env, runId, a.userId, new Date(NOW.getTime() + 10_000), deps);
    expect(out.kind === "ok" && out.result.status).toBe("finished");
    expect(recorded).toBe(LLM_BUDGET.cutoffMicros);

    const b = await athlete();
    const other = await nowRun(b.userId);
    const two = scripted([...REVIEWED, t(finish("Done."))]);
    for (let i = 0; i < STEPS_TO_REVIEWED; i++) await runStep(db, env, other, b.userId, new Date(NOW.getTime() + i * 1000), two.deps);
    await spentThisWeek(b.userId, LLM_BUDGET.cutoffMicros - (await worstOf(other)) + 1);
    const calls = two.requests.length;
    const refused = await runStep(db, env, other, b.userId, new Date(NOW.getTime() + 10_000), two.deps);
    expect(refused.kind === "ok" && refused.result.status).toBe("stopped_cap");
    expect(two.requests.length).toBe(calls);
    expect(await runRow(other)).toMatchObject({ status: "stopped_cap", error: "weekly_cap" });
  });
});
