/**
 * CHARACTERIZATION TESTS: THE APPROVAL BOUNDARY AS IT BEHAVES (migration Work Order A, R-COA-F08 and R-COA-F03). First written
 * against d9fae337; updated, not retired, when the approval contract landed (approval-contract.test.ts states that contract):
 * `{}` reaches only workouts and changes, and a change whose session moved on since its card is refused.
 *
 * These pin ACTUAL behaviour, including behaviour nobody should want. They are evidence, not a specification: a test here
 * going red after a deliberate fix of the contract is the expected result, and the fix updates it on purpose. Each name
 * starts with "CHARACTERIZATION:" so no reader takes one for a requirement.
 *
 * Everything goes through the real Hono route handlers (`POST /api/coach/proposals/:id/approve` and its neighbours), with
 * proposals written by the coach's real tools wherever one exists, on an in-memory SQLite holding the real migrations, D1's
 * bind cap on, under a faked `Date`. The client's guards (`ownCards`, `TurnCards`, packages/ui) are not in the path: this
 * is what any client holding a session gets.
 *
 * WHAT THE CONCURRENCY TESTS CAN AND CANNOT SHOW. better-sqlite3 runs one statement at a time, synchronously, in this
 * process, on one connection. Two requests can interleave here only at their `await`s, and a bare `Promise.all` barely
 * does: the session check hashes its token, a real macrotask, and everything after it can run in microtasks before the
 * other request gets past its own (one test below pins that). So the orderings that matter are FORCED with the gates
 * below: both requests past their read before either writes, a request held inside a claim. A check-then-act race in the
 * route's logic is reproduced that way. What this can't show: D1's network latency or retries, two isolates running at
 * once, a read replica behind the primary, or a Worker killed between statements (that is simulated by writing the state
 * such a death leaves). A compare-and-swap holding here means the logic is right IF D1 runs each statement atomically on
 * one primary, which is INFERRED, not shown.
 *
 * Synthetic data only. No key, no provider, no model: `fetch` is stubbed and every test ends asserting it was never called.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, adaptiveConfigSchema, newId, nowInstant, type UserPreferences } from "@rg/domain";

/** Hold a request at a point in its path. Each is awaited when set; a test sets it, and clears it by finishing. */
const gates = vi.hoisted(() => ({
  /** Inside the designed route, after it read the proposal, before `approveDesignOps` reads anything else. */
  beforeDesign: null as null | (() => Promise<void>),
  /** Inside the applier, whichever route called it, after a designed approve wrote its claim. */
  beforeApply: null as null | (() => Promise<void>),
}));

vi.mock("../src/services/design-approve.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/design-approve.js")>();
  return {
    ...real,
    approveDesignOps: async (...args: Parameters<typeof real.approveDesignOps>) => {
      if (gates.beforeDesign) await gates.beforeDesign();
      return real.approveDesignOps(...args);
    },
  };
});
vi.mock("../src/services/coach-apply.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/coach-apply.js")>();
  return {
    ...real,
    applyOps: async (...args: Parameters<typeof real.applyOps>) => {
      if (gates.beforeApply) await gates.beforeApply();
      return real.applyOps(...args);
    },
  };
});

import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { coachRoutes } from "../src/routes/coach.js";
import { libraryRoutes } from "../src/routes/library.js";
import { planRoutes } from "../src/routes/plan.js";
import { planRoutes as plansRoutes } from "../src/routes/plans.js";
import { programRoutes } from "../src/routes/programs.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import type { Db } from "../src/services/db.js";
import { APPLYING_STALE_MS, type DesignedOp } from "../src/services/design-approve.js";
import { supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { createDocWorkout } from "../src/services/doc-workouts.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { mondayOf } from "../src/services/design-tools/propose-plan.js";
import { isToolErr, type OpReview, type ToolContext, type ToolOk } from "../src/services/design-tools/types.js";
import { createObjective, getObjective, updateObjective } from "../src/services/objectives.js";
import { placeSlots } from "../src/services/program-slots.js";
import { correctionId, objectiveChangeId, planAdjustId, planChangeId, PLAN_STRUCTURE_ID, programmeChangeId, type PlanAdjustOp } from "../src/services/proposal-kinds.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { cloneTestDb, connectTestCoros, isWrite, makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { readSavesInRun } from "./saves-read-fixture.js";

const { activities, coachMessages, coachPlans, coachProposals, coachRuns, corosWriteJobs, exercisePrefs, importCorrections, personalMoves, plannedWorkouts, plannedWorkoutStages, programs, programVersions, scheduleOverrides, syncIntents, workoutDocRevisions } = schema;

/** Monday noon in Los Angeles, the test user's zone: today is 2026-10-05, a fortnight of plan ahead. */
const NOW = "2026-10-05T19:00:00.000Z";
const TODAY = "2026-10-05";
const day = (n: number): string => addDays(TODAY, n);

const makeEnv = (over: Partial<Env> = {}): Env =>
  ({
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
    COACH_DESIGNER: "1",
    ...over,
  }) as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let statements: string[];
let fetches: number;
/** The migrations, run once: each test starts on its own copy, so nothing carries between them. */
let migrated: Db;

beforeAll(() => {
  migrated = makeTestDb();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  gates.beforeDesign = null;
  gates.beforeApply = null;
  statements = [];
  fetches = 0;
  db = cloneTestDb(migrated, { boundVariableCap: 100, onStatement: (s) => void statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
});

afterEach(() => {
  expect(fetches, "no provider or model call anywhere in this file").toBe(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── The harness: real routes, real tools ─────────────────────────────────────────────────────────────────────────────

const app = () => {
  const a = mountRoutes(db, "/api/coach", coachRoutes);
  a.route("/api/plan", planRoutes);
  a.route("/api/plans", plansRoutes);
  a.route("/api/programs", programRoutes);
  a.route("/api/workouts", workoutRoutes);
  a.route("/api/library", libraryRoutes);
  return a;
};

interface Answer {
  status: number;
  json: Record<string, any>;
  writes: string[];
}

interface Call {
  /** The request's text as sent, for a malformed body (`body` is JSON-encoded). */
  raw?: string;
  headers?: Record<string, string>;
  cookie?: string | null;
  env?: Env;
}

async function invoke(method: string, path: string, body?: unknown, o: Call = {}): Promise<Answer> {
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  const from = statements.length;
  const text = o.raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const session = o.cookie === undefined ? cookie : o.cookie;
  const res = await app().request(
    path,
    { method, headers: { ...(session ? { Cookie: session } : {}), ...(text === undefined ? {} : { "Content-Type": "application/json" }), ...o.headers }, ...(text === undefined ? {} : { body: text }) },
    o.env ?? makeEnv(),
    executionCtx as never,
  );
  await Promise.all(pending);
  const out = await res.text();
  let json: Record<string, any> = {};
  try {
    json = out ? JSON.parse(out) : {};
  } catch {
    json = { text: out };
  }
  return { status: res.status, json, writes: statements.slice(from).filter(isWrite) };
}

const approve = (id: string, body?: unknown, o: Call = {}) => invoke("POST", `/api/coach/proposals/${id}/approve`, body, o);
const decline = (id: string, body?: unknown, o: Call = {}) => invoke("POST", `/api/coach/proposals/${id}/decline`, body, o);

/** As the web client's own loop: approve, then `{ opIds: remaining }` until none remain. Every answer. */
async function approveUntilDone(id: string, first: unknown): Promise<Answer[]> {
  const answers: Answer[] = [];
  let body = first;
  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    const res = await approve(id, body);
    answers.push(res);
    const remaining = (res.json.remaining ?? []) as string[];
    if (res.status !== 200 || remaining.length === 0) return answers;
    body = { opIds: remaining };
  }
  throw new Error("the approve never finished");
}

/** A session on the plan: a watch-plan easy run, 30 minutes, not on the watch. */
async function session(id: string, date: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<string> {
  await db.insert(plannedWorkouts).values({
    id, userId, planId: "plan-1", sourceWorkoutId: id, title: "Easy run", category: "easy", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: "",
    effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
    createdAt: nowInstant(), updatedAt: nowInstant(), ...over,
  });
  return id;
}

async function mainRun(request = "Sort out my week"): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({ id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request, status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW, updatedAt: NOW });
  return { db, env: makeEnv(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
}

/** One act tool's call in the run: stored, or the test fails with its refusal. */
async function act(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolOk> {
  const r = await ACT_TOOLS.find((t) => t.name === name)!.run({ ...ctx, toolUseId: `toolu_${newId()}` }, input);
  if (isToolErr(r)) throw new Error(`${name} refused: ${r.error} — ${r.why}`);
  return r;
}

const REVIEW: OpReview = { scores: { intent: 4, sequencing: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] };

/** A designer's new workout in the main run's proposal: its op id. */
async function workoutIn(ctx: ToolContext, date: string, target?: Record<string, unknown>, doc = calmDoc({ title: `Calm ${date}` })): Promise<string> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({ id, userId, parentId: ctx.run.id, role: "designer", scope: { kind: "auto" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW, updatedAt: NOW });
  const r = await proposeWorkout.run({ ...ctx, run: { id, role: "designer", scope: { kind: "auto" }, parentId: ctx.run.id, rehearsal: false }, toolUseId: `toolu_${newId()}` }, { doc, target: target ?? { kind: "new", date, time: "12:30" } });
  if (isToolErr(r)) throw new Error(`propose refused: ${r.error} — ${r.why}`);
  return id;
}

/** The run's proposal shown to the athlete, as a finish makes it. */
async function shown(ctx: ToolContext): Promise<string> {
  const id = designProposalId(ctx.run.id);
  const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
  const ops = (p!.ops as Array<DesignedOp | PlanAdjustOp>).map((x) => (x.kind === "doc_workout" ? { ...x, review: REVIEW } : x));
  await db.update(coachProposals).set({ status: "pending", ops }).where(eq(coachProposals.id, id));
  return id;
}

const change = (workoutId: string, c: Record<string, unknown>) => ({ workoutId, change: c, why: "It fits the week." });
const SKIP = { kind: "skip", reason: "Rest the legs." };

/** A proposal of these changes: shown, as a finish shows it. */
async function changes(...inputs: Array<ReturnType<typeof change>>): Promise<string> {
  const ctx = await mainRun();
  for (const c of inputs) await act(ctx, "adjust_plan", c);
  return shown(ctx);
}

/** A thread coach's proposal as the wake stored one: plain ops, no ids, pending. */
async function threadProposal(ops: unknown[], over: Partial<typeof coachProposals.$inferInsert> = {}): Promise<string> {
  const id = `tp-${newId()}`;
  await db.insert(coachProposals).values({ id, userId, planId: null, title: "This week", evidence: "", rationale: "", flags: [], ops, status: "pending", createdAt: NOW, expiresAt: day(7), ...over } as never);
  return id;
}

const proposalOf = async (id: string) => (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
const opsOf = async (id: string) => (await proposalOf(id)).ops as Array<Record<string, any>>;
const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const receipts = async () => (await db.select().from(coachMessages).where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "receipt")))).map((m) => m.body);
const outcomes = async (id: string) => Object.fromEntries((await opsOf(id)).map((o) => [o.id ?? o.by?.runId ?? o.kind, o.outcome?.status ?? "open"]));
const planRowsCount = async () => (await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).length;
const minutesOf = (r: { sourceEstimatedDurationSeconds: number | null; fallbackEstimatedDurationSeconds: number | null }) => Math.round((r.sourceEstimatedDurationSeconds ?? r.fallbackEstimatedDurationSeconds ?? 0) / 60);

// ── 1. The selection ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("1. what a request's selection applies (a designed proposal: a skip, a length, a workout)", () => {
  let id: string;
  let a: string;
  let b: string;
  let w: string;

  beforeEach(async () => {
    await session("w-1", day(1));
    await session("w-2", day(2));
    const ctx = await mainRun();
    await act(ctx, "adjust_plan", change("w-1", SKIP));
    await act(ctx, "adjust_plan", change("w-2", { kind: "adjust", durationMinutes: 20 }));
    w = await workoutIn(ctx, day(3));
    id = await shown(ctx);
    a = planAdjustId("w-1");
    b = planAdjustId("w-2");
  });

  const everything = async () => {
    expect((await rowOf("w-1")).completionState).toBe("skipped");
    expect(minutesOf(await rowOf("w-2"))).toBe(20);
    expect(await outcomes(id)).toEqual({ [a]: "applied", [b]: "applied", [w]: "applied" });
    expect((await proposalOf(id)).status).toBe("approved");
    expect(await planRowsCount()).toBe(3);
  };

  const nothing = async (res: Answer) => {
    expect(res.writes, "nothing written at all").toEqual([]);
    expect((await rowOf("w-1")).completionState).toBe("scheduled");
    expect(minutesOf(await rowOf("w-2"))).toBe(30);
    expect(await outcomes(id)).toEqual({ [a]: "open", [b]: "open", [w]: "open" });
    expect((await proposalOf(id)).status).toBe("pending");
    // No workout made: its row would carry the workout's title.
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).filter((r) => r.title.startsWith("Calm"))).toEqual([]);
    expect(await receipts()).toEqual([]);
  };

  it.each([
    ["no body at all", { raw: undefined, body: undefined }],
    ["an empty text body", { raw: "" }],
    ["a whitespace body", { raw: "  \n " }],
    ["`{}`", { body: {} }],
  ])("CHARACTERIZATION: %s approves every op, 200", async (_name, shape) => {
    const res = await approve(id, (shape as { body?: unknown }).body, { raw: (shape as { raw?: string }).raw });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, status: "approved", remaining: [], refused: [] });
    await everything();
  });

  it("CHARACTERIZATION: the Content-Type is not read: `{}` as text/plain approves every op", async () => {
    const res = await approve(id, undefined, { raw: "{}", headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(200);
    await everything();
  });

  it("CHARACTERIZATION: an explicitly empty selection is refused 400 `bad_request`, nothing written", async () => {
    const res = await approve(id, { opIds: [] });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("bad_request");
    await nothing(res);
  });

  it("CHARACTERIZATION: a subset applies only what it names; the proposal is `partially_approved`; the rest stays open", async () => {
    const res = await approve(id, { opIds: [a] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, status: "partially_approved", remaining: [], refused: [], applied: [], settled: [] });
    expect(res.json.changed.map((c: { opId: string }) => c.opId)).toEqual([a]);
    expect((await rowOf("w-1")).completionState).toBe("skipped");
    expect(minutesOf(await rowOf("w-2"))).toBe(30);
    expect(await outcomes(id)).toEqual({ [a]: "applied", [b]: "open", [w]: "open" });
    expect(await planRowsCount()).toBe(2);
  });

  it("CHARACTERIZATION: `{}` after a subset approves what the athlete left: nothing records that it was left on purpose", async () => {
    await approve(id, { opIds: [a] });
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json.settled).toEqual([{ opId: a, outcome: "applied", workoutId: "w-1" }]);
    await everything();
  });

  it("CHARACTERIZATION: an id named twice is refused 400 `bad_request`, nothing applied (it applied once at d9fae337; P6, 57a29879)", async () => {
    const res = await approve(id, { opIds: [a, a] });
    expect([res.status, res.json.error]).toEqual([400, "bad_request"]);
    expect(await outcomes(id)).toEqual({ [a]: "open", [b]: "open", [w]: "open" });
  });

  it("CHARACTERIZATION: an unknown id is 400 `unknown_op` naming it, and a known id beside it is not applied either", async () => {
    const alone = await approve(id, { opIds: ["nope"] });
    expect([alone.status, alone.json]).toEqual([400, { error: "unknown_op", opIds: ["nope"] }]);
    await nothing(alone);
    const mixed = await approve(id, { opIds: [a, "nope", b] });
    expect([mixed.status, mixed.json]).toEqual([400, { error: "unknown_op", opIds: ["nope"] }]);
    await nothing(mixed);
  });

  it("CHARACTERIZATION: another proposal's op id is unknown here, as any id: the other proposal is untouched", async () => {
    await session("w-3", day(4));
    const other = await changes(change("w-3", SKIP));
    const res = await approve(id, { opIds: [planAdjustId("w-3")] });
    expect([res.status, res.json]).toEqual([400, { error: "unknown_op", opIds: [planAdjustId("w-3")] }]);
    await nothing(res);
    expect((await rowOf("w-3")).completionState).toBe("scheduled");
    expect((await proposalOf(other)).status).toBe("pending");
  });

  it("CHARACTERIZATION: another account's proposal is a 404, whatever the body; with no session, 401", async () => {
    const { userId: them } = await makeTestUser(db);
    const theirs = `${SESSION_COOKIE}=${await createSession(db, them)}`;
    const res = await approve(id, {}, { cookie: theirs });
    expect([res.status, res.json]).toEqual([404, { error: "not_found" }]);
    await nothing(res);
    const anon = await approve(id, {}, { cookie: null });
    expect(anon.status).toBe(401);
    await nothing(anon);
  });

  it.each([
    ["unparseable JSON", "{"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["a JSON string", '"x"'],
    ["a JSON number", "1"],
    ["opIds null", '{"opIds":null}'],
    ["opIds a string", '{"opIds":"adj-w-1"}'],
    ["opIds of numbers", '{"opIds":[1]}'],
    ["an empty id", '{"opIds":[""]}'],
    ["an unknown key (strict)", '{"ops":["adj-w-1"]}'],
    ["a known key beside an unknown one", '{"opIds":["adj-w-1"],"confirm":true}'],
    ["opIds and edit together", '{"opIds":["adj-w-1"],"edit":{"opId":"x","doc":{}}}'],
    ["edit with no doc", '{"edit":{"opId":"x"}}'],
    ["more ids than the cap", JSON.stringify({ opIds: Array.from({ length: 51 }, (_, i) => `x${i}`) })],
    ["an id over 200 characters", JSON.stringify({ opIds: ["x".repeat(201)] })],
  ])("CHARACTERIZATION: a malformed body (%s) is 400 `bad_request`, nothing written", async (_name, raw) => {
    const res = await approve(id, undefined, { raw });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("bad_request");
    await nothing(res);
  });

  it("CHARACTERIZATION: a restore in progress answers 423 before the body is read, nothing written", async () => {
    await db.insert(schema.accountState).values({ userId, restoreId: "r-1", updatedAt: NOW } as never).onConflictDoUpdate({ target: schema.accountState.userId, set: { restoreId: "r-1" } });
    const res = await approve(id, {});
    expect([res.status, res.json]).toEqual([423, { error: "restore_in_progress" }]);
    await nothing(res);
  });

  it("CHARACTERIZATION: with the coach designer off, every shape answers 409 `not_yet`, nothing written", async () => {
    for (const body of [{}, { opIds: [a] }, { opIds: [] }]) {
      const res = await approve(id, body, { env: makeEnv({ COACH_DESIGNER: undefined }) });
      expect([res.status, res.json]).toEqual([409, { error: "not_yet" }]);
      await nothing(res);
    }
  });

  it.each([
    ["unreviewed", 409, "not_pending"],
    ["rehearsal", 409, "not_pending"],
    ["expired", 409, "not_pending"],
    ["rejected", 409, "not_pending"],
    ["superseded", 409, "not_pending"],
  ])("CHARACTERIZATION: a proposal `%s` is refused whatever the selection, nothing written", async (status, code, error) => {
    await db.update(coachProposals).set({ status }).where(eq(coachProposals.id, id));
    for (const body of [{}, { opIds: [a] }]) {
      const res = await approve(id, body);
      expect([res.status, res.json.error, res.json.status]).toEqual([code, error, status]);
      expect(res.writes).toEqual([]);
    }
    expect((await rowOf("w-1")).completionState).toBe("scheduled");
  });

  it("CHARACTERIZATION: an op declined stays declined under `{}` and when named: 200 `ok: true`, `settled`, nothing applied", async () => {
    await decline(id, { opIds: [a] });
    const named = await approve(id, { opIds: [a] });
    expect(named.status).toBe(200);
    expect(named.json).toMatchObject({ ok: true, status: "pending", settled: [{ opId: a, outcome: "declined" }], changed: [], applied: [] });
    expect((await rowOf("w-1")).completionState).toBe("scheduled");
    const all = await approve(id, {});
    expect(all.json.settled).toEqual([{ opId: a, outcome: "declined" }]);
    expect((await rowOf("w-1")).completionState).toBe("scheduled");
    expect(minutesOf(await rowOf("w-2"))).toBe(20);
    expect(await outcomes(id)).toEqual({ [a]: "declined", [b]: "applied", [w]: "applied" });
  });

  it("CHARACTERIZATION: `ok: true` is no evidence anything applied: a proposal declined whole answers 200 to a further approve", async () => {
    await decline(id, {});
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, status: "declined", applied: [], changed: [] });
    expect(res.json.settled).toHaveLength(3);
    expect((await rowOf("w-1")).completionState).toBe("scheduled");
  });

  it("CHARACTERIZATION: a refused op stays open: `{}` tries it again, and it applies once the plan allows it", async () => {
    await db.update(plannedWorkouts).set({ archivedAt: NOW }).where(eq(plannedWorkouts.id, "w-1"));
    const first = await approve(id, {});
    expect(first.json.refused.map((r: { opId: string; error: string }) => [r.opId, r.error])).toEqual([[a, "not_found"]]);
    expect((await proposalOf(id)).status).toBe("partially_approved");
    await db.update(plannedWorkouts).set({ archivedAt: null }).where(eq(plannedWorkouts.id, "w-1"));
    const again = await approve(id, {});
    expect(again.json.changed.map((c: { opId: string }) => c.opId)).toEqual([a]);
    await everything();
  });
});

describe("1b. the thread coach's proposal: the same route, and the body is never read", () => {
  it.each([
    ["no body", undefined, undefined],
    ["`{}`", {}, undefined],
    ["an empty selection", { opIds: [] }, undefined],
    ["a selection naming one op", { opIds: ["0"] }, undefined],
    ["a selection of unknown ids", { opIds: ["nope"] }, undefined],
    ["unparseable JSON", undefined, "{"],
  ])("CHARACTERIZATION: %s applies the WHOLE proposal, 200", async (_name, body, raw) => {
    await session("w-1", day(1));
    await session("w-2", day(2));
    const id = await threadProposal([
      { kind: "skip", workoutId: "w-1" },
      { kind: "adjust", workoutId: "w-2", durationMinutes: 20 },
    ]);
    const res = await approve(id, body, { raw });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect((await rowOf("w-1")).completionState).toBe("skipped");
    expect(minutesOf(await rowOf("w-2"))).toBe(20);
    expect((await proposalOf(id)).status).toBe("approved");
  });

  it("CHARACTERIZATION: the switch that stepped the thread coach back does not close this route: it applies with THREAD_COACH unset, as the shipped wrangler.toml leaves it", async () => {
    await session("w-1", day(1));
    const id = await threadProposal([{ kind: "skip", workoutId: "w-1" }]);
    const res = await approve(id, {}, { env: makeEnv({ THREAD_COACH: undefined, COACH_DESIGNER: undefined }) });
    expect(res.status).toBe(200);
    expect((await rowOf("w-1")).completionState).toBe("skipped");
  });
});

// ── 2. Objective exclusions, kind by kind ────────────────────────────────────────────────────────────────────────────

const WALL_SIT = { label: "Zorbex wall sit", measure: { kind: "hold_max", libraryIds: ["wallSit"] }, target: 120, dueDate: "2026-12-01" };
const LIFT = savedMoveDraft("Zorbex hip lift");

async function coachPlan(): Promise<string> {
  const id = `plan-${newId()}`;
  await db.insert(programs).values({ id, userId, kind: "coach", name: "Base block", status: "active", disciplines: ["run"], startDate: null, endDate: null, raceDate: null, source: null, config: {}, purpose: "Get fitter", brief: "Base block.", onEnd: "ask", createdAt: NOW, updatedAt: NOW, archivedAt: null } as never);
  return id;
}

async function adaptive(): Promise<string> {
  const id = newId();
  await db.insert(programs).values({ id, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null, config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 2], placementWeeksAhead: 2 }), createdAt: NOW, updatedAt: NOW, archivedAt: null } as never);
  await placeSlots(db, userId, id, TODAY, await loadPreferences(db, userId), NOW);
  return id;
}

const easyRun = (minutes: number, title: string) => ({ category: "easy", title, durationMinutes: minutes, run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] } });

function block(name = "Build block") {
  const monday = mondayOf(day(7));
  return {
    kind: "createPlan", discipline: "run", name, newPlan: { name: "Synthetic plan", purpose: "A synthetic purpose" }, startDate: monday, endDate: addDays(monday, 20),
    firmSessions: [0, 2].map((k) => ({ date: addDays(monday, k), session: easyRun(30 + k, `Run ${k}`) })),
    shapeWeeks: [1, 2].map((k) => ({ weekStart: addDays(monday, 7 * k), volumeTarget: "about 30 km", keySessions: ["long run"] })),
  };
}

async function savedLift() {
  const seeded = await seedSavedBatch(db, userId, { savedAt: "2026-10-04T17:00:00.000Z", posts: [{ moves: [{ draft: LIFT }] }] });
  return { batchId: seeded.batchId, lift: seeded.moveIds[0]![0]! };
}

type Made = { opId: string; made: () => Promise<boolean> };

/** Each kind's op, put in a run's proposal by the coach's own tool, and how to see it was applied. */
const KINDS: Record<string, (ctx: ToolContext) => Promise<Made>> = {
  doc_workout: async (ctx) => {
    const opId = await workoutIn(ctx, day(3));
    return { opId, made: async () => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).some((r) => r.title.startsWith("Calm")) };
  },
  plan_adjust: async (ctx) => {
    await session("w-adj", day(1));
    await act(ctx, "adjust_plan", change("w-adj", SKIP));
    return { opId: planAdjustId("w-adj"), made: async () => (await rowOf("w-adj")).completionState === "skipped" };
  },
  plan_structure: async (ctx) => {
    await act(ctx, "propose_plan", { change: block(), why: "The next phase." });
    return { opId: PLAN_STRUCTURE_ID, made: async () => (await db.select().from(coachPlans).where(eq(coachPlans.userId, userId))).length === 1 };
  },
  programme_change: async (ctx) => {
    const p = await adaptive();
    await act(ctx, "change_programme", { programmeId: p, days: ["thursday", "Tue"], why: "Your Mondays are full now." });
    return { opId: programmeChangeId(p), made: async () => ((await db.select().from(programs).where(eq(programs.id, p)))[0]!.config as { preferredDays: number[] }).preferredDays.includes(3) };
  },
  plan_change: async (ctx) => {
    const p = await coachPlan();
    await act(ctx, "change_plan", { planId: p, why: "You asked.", brief: "Base block, then the build." });
    return { opId: planChangeId(p), made: async () => (await db.select().from(programs).where(eq(programs.id, p)))[0]!.brief === "Base block, then the build." };
  },
  move_pins: async (ctx) => {
    const { batchId, lift } = await savedLift();
    await readSavesInRun(db, ctx, { batchId });
    await act(ctx, "pin_moves", { batchId, pin: [lift], title: "A move in rotation", why: "It serves the hips.", lines: [{ moveId: lift, text: "in rotation: it opens the hips." }] });
    return { opId: `pins-${ctx.run.id}`, made: async () => (await db.select().from(exercisePrefs).where(and(eq(exercisePrefs.userId, userId), eq(exercisePrefs.exerciseId, lift))))[0]?.pinned === true };
  },
  import_correction: async (ctx) => {
    const { batchId, lift } = await savedLift();
    await readSavesInRun(db, ctx, { batchId });
    await act(ctx, "correct_import", { target: "move", targetId: lift, field: "summary", after: "Slow.", why: "The transcript says so.", basis: "evidence", cites: ["history"] });
    return { opId: correctionId("move", lift, "summary"), made: async () => (await db.select().from(importCorrections).where(eq(importCorrections.userId, userId))).length === 1 };
  },
  objective_change: async (ctx) => {
    const o = await createObjective(db, userId, { title: "Strong legs", keyResults: [WALL_SIT] }, NOW);
    const krId = o.keyResults[0]!.id;
    await act(ctx, "propose_objective", { change: "retarget", keyResultId: krId, target: 90, why: "Your wall sit is at 45 s of 120 s with half the time gone: 90 s is the honest target.", basis: "stand" });
    return { opId: objectiveChangeId("retarget", krId), made: async () => (await getObjective(db, userId, o.id)).keyResults[0]!.target === 90 };
  },
};

describe("2. what is left out of a selection naming nothing", () => {
  it.each(["doc_workout", "plan_adjust"])("CHARACTERIZATION: `{}` on a proposal of one %s op applies it, 200 `approved` (the other six kinds: approval-contract.test.ts)", async (kind) => {
    const ctx = await mainRun();
    const { made, opId } = await KINDS[kind]!(ctx);
    const id = await shown(ctx);
    expect(await made()).toBe(false);
    const answers = await approveUntilDone(id, {});
    expect(answers.at(-1)!.status).toBe(200);
    expect(answers.at(-1)!.json.status).toBe("approved");
    expect(await made()).toBe(true);
    expect((await outcomes(id))[opId]).toBe("applied");
  });

  it("CHARACTERIZATION: `{}` on a proposal of one objective change is 200 `ok: true` with empty lists and writes nothing; only `notNamed` says why nothing happened", async () => {
    const ctx = await mainRun();
    const { made, opId } = await KINDS.objective_change!(ctx);
    const id = await shown(ctx);
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, status: "pending", applied: [], changed: [], refused: [], settled: [], remaining: [], notNamed: [opId] });
    expect(res.writes).toEqual([]);
    expect(await made()).toBe(false);
    expect((await outcomes(id))[opId]).toBe("open");
  });

  it("CHARACTERIZATION: named, an objective change applies, alone or beside others", async () => {
    const ctx = await mainRun();
    const goal = await KINDS.objective_change!(ctx);
    const adj = await KINDS.plan_adjust!(ctx);
    const id = await shown(ctx);
    const res = await approve(id, { opIds: [goal.opId, adj.opId] });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("approved");
    expect(res.json.objectives.map((o: { opId: string }) => o.opId)).toEqual([goal.opId]);
    expect(await goal.made()).toBe(true);
    expect(await adj.made()).toBe(true);
  });

  it("CHARACTERIZATION: an objective change is never named in `remaining`, so the client's loop never approves it", async () => {
    const ctx = await mainRun();
    const goal = await KINDS.objective_change!(ctx);
    for (const k of ["doc_workout", "plan_adjust", "plan_change", "import_correction"]) await KINDS[k]!(ctx);
    const id = await shown(ctx);
    const answers = await approveUntilDone(id, {});
    for (const a of answers) expect(a.json.remaining).not.toContain(goal.opId);
    expect(answers.at(-1)!.json.status).toBe("partially_approved");
    expect(await goal.made()).toBe(false);
    expect((await outcomes(id))[goal.opId]).toBe("open");
  });

  it("CHARACTERIZATION: EVERY kind in one suggestion: `{}` until done applies the workout and the change; the other six wait for their names, listed in `notNamed`", async () => {
    const ctx = await mainRun();
    const all: Record<string, Made> = {};
    for (const k of Object.keys(KINDS)) all[k] = await KINDS[k]!(ctx);
    const id = await shown(ctx);
    const answers = await approveUntilDone(id, {});
    expect(answers.at(-1)!.status).toBe(200);
    const made: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(all)) made[k] = await v.made();
    expect(made).toEqual({ doc_workout: true, plan_adjust: true, plan_structure: false, programme_change: false, plan_change: false, move_pins: false, import_correction: false, objective_change: false });
    expect((await proposalOf(id)).status).toBe("partially_approved");
    expect([...answers.at(-1)!.json.notNamed].sort()).toEqual([all.plan_structure!, all.programme_change!, all.plan_change!, all.move_pins!, all.import_correction!, all.objective_change!].map((m) => m.opId).sort());
  });

  it("CHARACTERIZATION: a decline naming nothing leaves the objective change open too, and the proposal `pending`", async () => {
    const ctx = await mainRun();
    const goal = await KINDS.objective_change!(ctx);
    const adj = await KINDS.plan_adjust!(ctx);
    const id = await shown(ctx);
    const res = await decline(id, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, status: "pending", declined: [adj.opId] });
    expect((await outcomes(id))[goal.opId]).toBe("open");
  });

  it("CHARACTERIZATION: Edit before approve never reaches an objective change or a session's change: 400 `unknown_op`", async () => {
    const ctx = await mainRun();
    const goal = await KINDS.objective_change!(ctx);
    const adj = await KINDS.plan_adjust!(ctx);
    const id = await shown(ctx);
    for (const opId of [goal.opId, adj.opId]) {
      const res = await approve(id, { edit: { opId, doc: {} } });
      expect([res.status, res.json]).toEqual([400, { error: "unknown_op", opIds: [opId] }]);
    }
  });

  it("CHARACTERIZATION: an op of a kind this server doesn't know is left as it was by `{}`, and is unknown when named; the exclusion is a deny-list of one kind, so a NEW known kind would default to approved", async () => {
    const ctx = await mainRun();
    const adj = await KINDS.plan_adjust!(ctx);
    const id = await shown(ctx);
    const ops = await opsOf(id);
    await db.update(coachProposals).set({ ops: [...ops, { kind: "some_future_kind", id: "future-1", x: 1 }] }).where(eq(coachProposals.id, id));
    const named = await approve(id, { opIds: ["future-1"] });
    expect([named.status, named.json]).toEqual([400, { error: "unknown_op", opIds: ["future-1"] }]);
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json.changed.map((c: { opId: string }) => c.opId)).toEqual([adj.opId]);
    expect((await opsOf(id)).find((o) => o.id === "future-1")).toEqual({ kind: "some_future_kind", id: "future-1", x: 1 });
  });
});

// ── 3. The base: what stands between the card being drawn and the tap ────────────────────────────────────────────────

/** Each change the coach can propose of a run that isn't a programme's. */
const CHANGES: Record<string, Record<string, unknown>> = {
  skip: SKIP,
  move: { kind: "move", toDate: day(3), toTime: "12:00" },
  adjust: { kind: "adjust", durationMinutes: 25 },
  ease: { kind: "ease", durationMinutes: 25 },
  swap: { kind: "swap", to: "recovery", durationMinutes: 25 },
  remove: { kind: "remove" },
};

const TEMPO = { title: "Tempo", category: "quality", qualitySubtype: "tempo", calendarBlockDurationSeconds: 2400, fallbackEstimatedDurationSeconds: 2400 } as const;

/** Another proposal touching the same row, the coach's own tool, approved through the route. */
async function otherApproved(workoutId: string, c: Record<string, unknown>): Promise<void> {
  const other = await changes(change(workoutId, c));
  const res = await approve(other, {});
  expect(res.json.status, JSON.stringify(res.json)).toBe("approved");
}

/** What can happen to a session after a card about it was drawn: the athlete's own routes, or what another writer leaves. */
const EVENTS: Record<string, (workoutId: string) => Promise<void>> = {
  nothing: async () => undefined,
  hand_move: async (w) => {
    const res = await invoke("POST", `/api/plan/workouts/${w}/move`, { toDate: day(4), toTime: "17:30" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  },
  hand_time: async (w) => {
    const res = await invoke("POST", `/api/plan/workouts/${w}/move`, { toDate: day(1), toTime: "17:30" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  },
  hand_skip: async (w) => {
    expect((await invoke("POST", `/api/plan/workouts/${w}/skip`)).status).toBe(200);
  },
  hand_remove: async (w) => {
    expect((await invoke("POST", `/api/plan/workouts/${w}/remove`)).status).toBe(200);
  },
  /** The match route's own write, through the route: a run the watch logged, matched to the session. */
  completed_by_match: async (w) => {
    const activityId = `a-${w}`;
    await db.insert(activities).values({ id: activityId, userId, source: "coros", sourceActivityId: activityId, sport: "run", startTime: `${day(0)}T14:00:00.000Z`, startTimeLocal: `${day(0)}T07:00:00`, durationSeconds: 1800, createdAt: NOW, updatedAt: NOW } as never);
    const res = await invoke("POST", `/api/plan/workouts/${w}/match`, { activityId });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  },
  /** What a session started leaves on its row: no route is driven here, the session player has its own suites. */
  under_way: async (w) => {
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, w));
  },
  /** What the COROS read writes when the watch's own copy changes (import-plan.ts rule 7), as a row update: reconcile isn't driven here. */
  upstream_edit: async (w) => {
    await db.update(plannedWorkouts).set({ title: "Long tempo", sourceEstimatedDurationSeconds: 3600, calendarBlockDurationSeconds: 3600, sourceContentFingerprint: "fp-upstream" }).where(eq(plannedWorkouts.id, w));
  },
  other_proposal_length: (w) => otherApproved(w, { kind: "adjust", durationMinutes: 35 }),
  other_proposal_ease: (w) => otherApproved(w, { kind: "ease", durationMinutes: 35 }),
  other_proposal_move: (w) => otherApproved(w, { kind: "move", toDate: day(5), toTime: "18:15" }),
};

/** One cell: a card about the session, the event, then `{}` — what the card said, what the route answered, what the row is. */
async function cell(changeName: string, event: string) {
  const w = await session(`w-${changeName}-${event}`, day(1), TEMPO);
  const id = await changes(change(w, CHANGES[changeName]!));
  const opId = planAdjustId(w);
  await EVENTS[event]!(w);
  const card = (await invoke("GET", `/api/coach/proposals/${id}`)).json.changes[0] as Record<string, unknown>;
  const res = await approve(id, {});
  const row = await rowOf(w);
  const verdict = res.json.changed?.some((c: { opId: string }) => c.opId === opId)
    ? "changed"
    : res.json.refused?.find((r: { opId: string }) => r.opId === opId)
      ? `refused:${res.json.refused[0].error}${res.json.refused[0].cause ? `/${res.json.refused[0].cause}` : ""}`
      : `other:${res.status}`;
  return { verdict, card, status: res.status, row, before: res.json.changed?.[0]?.before as Record<string, unknown> | undefined, receipts: await receipts() };
}

/** The row after `{}`: "date time | title | minutes | state". The session starts Tue 6 Oct 07:00, Tempo, 40 minutes, scheduled. */
const REFUSED_SKIPPED = "refused:not_editable/resolved 2026-10-06 07:00 | Tempo | 40 | skipped";
const REFUSED_GONE = "refused:not_found 2026-10-06 07:00 | Tempo | 40 | scheduled archived";
const REFUSED_DONE = "refused:not_editable/resolved 2026-10-06 07:00 | Tempo | 40 | completed";
/** Started, set directly here, on a session ahead of today (`session-guard.ts` has no lower bound). session-guard.test.ts drives the real Start. */
const REFUSED_UNDER_WAY = "refused:not_editable/under_way 2026-10-06 07:00 | Tempo | 40 | scheduled";

/** A session that moved on since its card: refused, and the row is as the event left it, whichever change the card holds. */
const MOVED_ON = {
  hand_move: "refused:changed_since_suggested 2026-10-09 17:30 | Tempo | 40 | scheduled",
  hand_time: "refused:changed_since_suggested 2026-10-06 17:30 | Tempo | 40 | scheduled",
  upstream_edit: "refused:changed_since_suggested 2026-10-06 07:00 | Long tempo | 60 | scheduled",
  other_proposal_length: "refused:changed_since_suggested 2026-10-06 07:00 | Tempo | 35 | scheduled",
  other_proposal_ease: "refused:changed_since_suggested 2026-10-06 07:00 | Easy run | 35 | scheduled",
  other_proposal_move: "refused:changed_since_suggested 2026-10-10 18:15 | Tempo | 40 | scheduled",
} as const;

/**
 * THE WHOLE TABLE: a verdict and the row it left, for each change after each event. Refused by the STATE (skipped, gone,
 * done) or because the session moved on since its card (`MOVED_ON`, where at d9fae337 all 36 cells applied: the athlete's own
 * move overwritten, or a skip or a remove landing on a day the card never named).
 */
const MATRIX: Record<string, Record<string, string>> = {
  skip: {
    ...MOVED_ON,
    nothing: "changed 2026-10-06 07:00 | Tempo | 40 | skipped",
    hand_skip: "changed 2026-10-06 07:00 | Tempo | 40 | skipped",
    hand_remove: REFUSED_GONE,
    completed_by_match: REFUSED_DONE,
    under_way: REFUSED_UNDER_WAY,
  },
  move: {
    ...MOVED_ON,
    nothing: "changed 2026-10-08 12:00 | Tempo | 40 | scheduled",
    hand_skip: REFUSED_SKIPPED,
    hand_remove: REFUSED_GONE,
    completed_by_match: REFUSED_DONE,
    under_way: REFUSED_UNDER_WAY,
  },
  adjust: {
    ...MOVED_ON,
    nothing: "changed 2026-10-06 07:00 | Tempo | 25 | scheduled",
    hand_skip: REFUSED_SKIPPED,
    hand_remove: REFUSED_GONE,
    completed_by_match: REFUSED_DONE,
    under_way: REFUSED_UNDER_WAY,
  },
  ease: {
    ...MOVED_ON,
    nothing: "changed 2026-10-06 07:00 | Easy run | 25 | scheduled",
    hand_skip: REFUSED_SKIPPED,
    hand_remove: REFUSED_GONE,
    completed_by_match: REFUSED_DONE,
    under_way: REFUSED_UNDER_WAY,
  },
  swap: {
    ...MOVED_ON,
    nothing: "changed 2026-10-06 07:00 | Recovery run | 25 | scheduled",
    hand_skip: REFUSED_SKIPPED,
    hand_remove: REFUSED_GONE,
    completed_by_match: REFUSED_DONE,
    under_way: REFUSED_UNDER_WAY,
  },
  remove: {
    ...MOVED_ON,
    nothing: "changed 2026-10-06 07:00 | Tempo | 40 | scheduled archived",
    hand_skip: REFUSED_SKIPPED,
    hand_remove: "changed 2026-10-06 07:00 | Tempo | 40 | scheduled archived",
    completed_by_match: REFUSED_DONE,
    under_way: REFUSED_UNDER_WAY,
  },
};

describe("3. plan_adjust after the session moved on: the session's state, and whether it is still the one its card drew", () => {
  const cells = Object.entries(MATRIX).flatMap(([c, row]) => Object.entries(row).map(([e, expected]) => [c, e, expected] as const));
  it.each(cells)("CHARACTERIZATION: %s after %s: %s", async (c, e, expected) => {
    const r = await cell(c, e);
    expect(`${r.verdict} ${r.row.effectiveDate} ${r.row.effectiveTime} | ${r.row.title} | ${minutesOf(r.row)} | ${r.row.completionState}${r.row.archivedAt ? " archived" : ""}`).toBe(expected);
    expect(r.status).toBe(200);
  });

  it("CHARACTERIZATION: the card still says what the row was when it was drawn; the tap refuses instead of misdescribing, and nothing is written over the row", async () => {
    const w = await session("w-1", day(1), TEMPO);
    const id = await changes(change(w, { kind: "adjust", durationMinutes: 25 }));
    await EVENTS.hand_move!(w);
    await EVENTS.other_proposal_length!(w);
    expect(minutesOf(await rowOf(w))).toBe(35);
    // The card, read now: the old day and length, nothing to say the session has moved on (a card that warns earlier is left out).
    const card = (await invoke("GET", `/api/coach/proposals/${id}`)).json.changes[0];
    expect(card).toMatchObject({ date: day(1), was: "40 min" });
    const receiptsBefore = await receipts();
    const res = await approve(id, {});
    expect(res.json.changed).toEqual([]);
    expect(res.json.refused.map((r: { opId: string; error: string }) => [r.opId, r.error])).toEqual([[planAdjustId(w), "changed_since_suggested"]]);
    expect(minutesOf(await rowOf(w))).toBe(35);
    expect((await rowOf(w)).effectiveDate).toBe(day(4));
    expect(await receipts()).toEqual(receiptsBefore);
    expect((await opsOf(id))[0]!.row).toMatchObject({ date: day(1), minutes: 40 });
    expect((await opsOf(id))[0]!.outcome.status).toBe("refused");
  });

  it("CHARACTERIZATION: a coach's move over the athlete's own move is refused: the athlete's override alone, the row where the athlete put it", async () => {
    const w = await session("w-1", day(1), TEMPO);
    const id = await changes(change(w, CHANGES.move!));
    await EVENTS.hand_move!(w);
    const res = await approve(id, {});
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["changed_since_suggested"]);
    const overrides = await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, w));
    expect(overrides.map((o) => [o.kind, o.fromDate, o.toDate, o.toTime, o.source])).toEqual([["user_move", day(1), day(4), "17:30", "app"]]);
    expect((await rowOf(w)).effectiveDate).toBe(day(4));
  });

  /**
   * A structured run of the coach's lane (an id of `cw-`: `threadCoachRun`, adjust-retime.ts), its stage rows the coach's
   * blocks: its length is re-timed by the rule, the only `plan_adjust` with a check against what the card said. Any other
   * session's length is `retime: null`, as the matrix's Tempo: length alone, no check.
   */
  const CW = "cw-t-1";
  async function tempoWithStages(): Promise<void> {
    await session(CW, day(1), { ...TEMPO, planId: "coach-plan", sourceContentFingerprint: "0123456789abcdef", calendarBlockDurationSeconds: 2100, fallbackEstimatedDurationSeconds: 2100 });
    const blocks = [["warmup", "easy"], ...Array.from({ length: 5 }, () => ["work", "threshold"]), ["cooldown", "easy"]] as const;
    await db.insert(plannedWorkoutStages).values(blocks.map(([kind, label], i) => ({ id: `${CW}:${i}`, workoutId: CW, parentStageId: null, ord: i, kind, repeatCount: null, durationType: "time", durationSeconds: 300, distanceMeters: null, label })));
  }

  it("CHARACTERIZATION: `adjust` with `retime`: its steps changed since the card is refused `changed_since_suggested`, nothing written", async () => {
    await tempoWithStages();
    const id = await changes(change(CW, { kind: "adjust", durationMinutes: 25 }));
    expect((await opsOf(id))[0]!.retime).toMatchObject({ minutes: 25 });
    await db.update(plannedWorkoutStages).set({ durationSeconds: 600 }).where(eq(plannedWorkoutStages.id, `${CW}:1`));
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["changed_since_suggested"]);
    expect(minutesOf(await rowOf(CW))).toBe(35);
  });

  it("CHARACTERIZATION: `adjust` with `retime` is held to the row as well as its steps: a hand move and an upstream retitle refuse it, nothing written", async () => {
    await tempoWithStages();
    const id = await changes(change(CW, { kind: "adjust", durationMinutes: 25 }));
    expect((await opsOf(id))[0]!.retime).toMatchObject({ minutes: 25 });
    await EVENTS.hand_move!(CW);
    await db.update(plannedWorkouts).set({ title: "Retitled upstream" }).where(eq(plannedWorkouts.id, CW));
    const res = await approve(id, {});
    expect(res.json.changed).toEqual([]);
    expect(res.json.refused.map((r: { opId: string; error: string }) => [r.opId, r.error])).toEqual([[planAdjustId(CW), "changed_since_suggested"]]);
    expect(await rowOf(CW)).toMatchObject({ effectiveDate: day(4), effectiveTime: "17:30" });
    expect(minutesOf(await rowOf(CW))).toBe(35);
  });

  it("CHARACTERIZATION: a length whose card had no `retime` is unchecked whatever the steps did: the Tempo's stage rows changed since, its length is written over them", async () => {
    const w = await session("w-1", day(1), TEMPO);
    await db.insert(plannedWorkoutStages).values({ id: "w-1:0", workoutId: w, parentStageId: null, ord: 0, kind: "work", repeatCount: null, durationType: "time", durationSeconds: 2400, distanceMeters: null, label: "threshold" });
    const id = await changes(change(w, { kind: "adjust", durationMinutes: 25 }));
    expect((await opsOf(id))[0]!.retime).toBeNull();
    await db.update(plannedWorkoutStages).set({ durationSeconds: 1200 }).where(eq(plannedWorkoutStages.id, "w-1:0"));
    const res = await approve(id, {});
    expect(res.json.refused).toEqual([]);
    expect(minutesOf(await rowOf(w))).toBe(25);
  });

  it.each([
    ["nothing", "changed", "scheduled", false],
    ["the athlete's own un-skip", "changed", "scheduled", false],
    ["a remove", "refused:not_found", "skipped", true],
  ] as const)("CHARACTERIZATION: `restore` after %s: %s", async (what, verdict, state, archived) => {
    const w = await session("w-1", day(1), TEMPO);
    await invoke("POST", `/api/plan/workouts/${w}/skip`);
    const id = await changes(change(w, { kind: "restore" }));
    if (what === "the athlete's own un-skip") expect((await invoke("POST", `/api/plan/workouts/${w}/unskip`)).status).toBe(200);
    if (what === "a remove") await db.update(plannedWorkouts).set({ archivedAt: NOW }).where(eq(plannedWorkouts.id, w));
    const res = await approve(id, {});
    const refused = res.json.refused[0] as { error: string } | undefined;
    expect(refused ? `refused:${refused.error}` : "changed").toBe(verdict);
    expect((await rowOf(w)).completionState).toBe(state);
    expect(!!(await rowOf(w)).archivedAt).toBe(archived);
  });

  it("CHARACTERIZATION: the thread coach's ops have no base either: its adjust lands over the hand move and the upstream edit, and a thread op that can't land still answers `approved`", async () => {
    const w = await session("w-1", day(1), TEMPO);
    const done = await session("w-2", day(2), TEMPO);
    const id = await threadProposal([
      { kind: "adjust", workoutId: w, durationMinutes: 25 },
      { kind: "skip", workoutId: done },
    ]);
    await EVENTS.hand_move!(w);
    await EVENTS.upstream_edit!(w);
    await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, done));
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json.applied).toMatchObject({ updated: [w], missed: ["a session it skips has already been done, so it was left as it was"] });
    expect(await rowOf(w)).toMatchObject({ effectiveDate: day(4), title: "Long tempo" });
    expect(minutesOf(await rowOf(w))).toBe(25);
    expect((await proposalOf(id)).status).toBe("approved");
    expect(await receipts()).toEqual(["✓ approved — This week · a session it skips has already been done, so it was left as it was"]);
  });

  it("CHARACTERIZATION: the one guard between proposals: a NEWER suggestion finishing supersedes an older open change of the same session; `{}` on the older is then 409", async () => {
    const w = await session("w-1", day(1), TEMPO);
    const older = await changes(change(w, { kind: "adjust", durationMinutes: 25 }));
    const newer = await changes(change(w, { kind: "adjust", durationMinutes: 35 }));
    await db.update(coachProposals).set({ createdAt: "2026-10-05T19:00:01.000Z" }).where(eq(coachProposals.id, newer));
    await supersedeOlderPlans(db, userId, newer, nowInstant());
    expect((await proposalOf(older)).status).toBe("superseded");
    const res = await approve(older, {});
    expect([res.status, res.json]).toEqual([409, { error: "not_pending", status: "superseded" }]);
    expect(minutesOf(await rowOf(w))).toBe(40);
    expect((await approve(newer, {})).json.status).toBe("approved");
    expect(minutesOf(await rowOf(w))).toBe(35);
  });

  it("CHARACTERIZATION: …and one approved BEFORE the newer finishes isn't open, so no supersede covers it: the card's own compare refuses the newer", async () => {
    const w = await session("w-1", day(1), TEMPO);
    const inFlight = await mainRun();
    await act(inFlight, "adjust_plan", change(w, { kind: "adjust", durationMinutes: 25 }));
    const first = await changes(change(w, { kind: "adjust", durationMinutes: 35 }));
    expect((await approve(first, {})).json.status).toBe("approved");
    const newer = await shown(inFlight);
    await db.update(coachProposals).set({ createdAt: "2026-10-05T19:00:01.000Z" }).where(eq(coachProposals.id, newer));
    await supersedeOlderPlans(db, userId, newer, nowInstant());
    expect((await proposalOf(first)).status).toBe("approved");
    const res = await approve(newer, {});
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["changed_since_suggested"]);
    expect(minutesOf(await rowOf(w))).toBe(35);
  });

  it("CHARACTERIZATION: expiry is a pending proposal's only: a `partially_approved` proposal past its day of expiry still judges its open ops, and one whose session moved on is refused and STAYS open (owner P4, P8)", async () => {
    const a = await session("w-1", day(1), TEMPO);
    const b = await session("w-2", day(2), TEMPO);
    const later = await changes(change(a, SKIP), change(b, SKIP));
    const pendingOne = await session("w-3", day(2), TEMPO);
    const stillPending = await changes(change(pendingOne, SKIP));
    await approve(later, { opIds: [planAdjustId(a)] });
    expect((await proposalOf(later)).status).toBe("partially_approved");
    // Both sessions moved on by hand, past the day the cards were good for; then the clock passes that day.
    for (const w of [b, pendingOne]) await invoke("POST", `/api/plan/workouts/${w}/move`, { toDate: day(12), toTime: "07:00" });
    vi.setSystemTime(new Date("2026-10-11T19:00:00.000Z"));
    const pendingAnswer = await approve(stillPending, {});
    expect([pendingAnswer.status, pendingAnswer.json]).toEqual([409, { error: "not_pending", status: "expired" }]);
    expect((await rowOf(pendingOne)).completionState).toBe("scheduled");
    const res = await approve(later, {});
    expect(res.status).toBe(200);
    expect(res.json.refused.map((r: { opId: string; error: string }) => [r.opId, r.error])).toEqual([[planAdjustId(b), "changed_since_suggested"]]);
    expect((await rowOf(b)).completionState).toBe("scheduled");
    expect((await proposalOf(later)).status).toBe("partially_approved");
    expect((await proposalOf(later)).expiresAt < "2026-10-11").toBe(true);
    // Refused is still open: it can be tried again, or declined.
    expect((await opsOf(later)).find((o) => o.id === planAdjustId(b))!.outcome.status).toBe("refused");
  });
});

describe("3b. the sibling classes: which compare what the card saw", () => {
  it("CHARACTERIZATION: `doc_workout` revise HAS one (`baseRev`): the athlete's revision since refuses it `stale_revision`, nothing written", async () => {
    const ctx0 = { today: TODAY, now: NOW, prefs: await loadPreferences(db, userId) };
    const made = await createDocWorkout(db, userId, { date: day(2), time: "12:00", doc: calmDoc({ title: "Mine" }) as never, clientId: "c-1" }, ctx0);
    const ctx = await mainRun();
    const opId = await workoutIn(ctx, day(2), { kind: "revise", workoutId: made.workout.id, baseRev: made.workout.docRev! }, calmDoc({ title: "The coach's" }));
    const id = await shown(ctx);
    const hand = await invoke("PUT", `/api/workouts/${made.workout.id}/doc`, { doc: calmDoc({ title: "Mine, edited" }), baseRev: made.workout.docRev });
    expect(hand.status, JSON.stringify(hand.json)).toBe(200);
    const res = await approve(id, {});
    expect(res.status).toBe(200);
    expect(res.json.refused.map((r: { opId: string; error: string }) => [r.opId, r.error])).toEqual([[opId, "stale_revision"]]);
    expect((await rowOf(made.workout.id)).title).toBe("Mine, edited");
  });

  it("CHARACTERIZATION: the same document workout's `plan_adjust` compares the row, not the revision: revised by hand under another name, the skip is refused", async () => {
    const ctx0 = { today: TODAY, now: NOW, prefs: await loadPreferences(db, userId) };
    const made = await createDocWorkout(db, userId, { date: day(2), time: "12:00", doc: calmDoc({ title: "Mine" }) as never, clientId: "c-1" }, ctx0);
    const id = await changes(change(made.workout.id, SKIP));
    const hand = await invoke("PUT", `/api/workouts/${made.workout.id}/doc`, { doc: calmDoc({ title: "Mine, edited" }), baseRev: made.workout.docRev });
    expect(hand.status, JSON.stringify(hand.json)).toBe(200);
    const res = await approve(id, {});
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["changed_since_suggested"]);
    expect(await rowOf(made.workout.id)).toMatchObject({ completionState: "scheduled", title: "Mine, edited" });
  });

  it("CHARACTERIZATION: a watch-plan run has no hand edit of its content at all: the Studio's save refuses it, so its hand edits are a move, a skip and a remove", async () => {
    const w = await session("w-1", day(1), TEMPO);
    const res = await invoke("PUT", `/api/workouts/${w}/doc`, { doc: calmDoc({ title: "Mine" }), baseRev: 0 });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe("run_unsupported");
    expect((await rowOf(w)).title).toBe("Tempo");
  });

  it("CHARACTERIZATION: a coach's lift, revised by hand after the card: the adoption makes it a Studio row, so a `remove` is refused `studio` by the state check, and a `skip` of the same session is refused because its name moved on", async () => {
    const lift = { title: "Gym", category: "strength", sport: "strength" } as const;
    const a = await session("w-1", day(1), lift);
    const b = await session("w-2", day(2), lift);
    const ctx = await mainRun();
    await act(ctx, "adjust_plan", change(a, { kind: "remove" }));
    await act(ctx, "adjust_plan", change(b, SKIP));
    const id = await shown(ctx);
    for (const w of [a, b]) {
      const hand = await invoke("PUT", `/api/workouts/${w}/doc`, { doc: calmDoc({ title: "Mine" }), baseRev: 0 });
      expect(hand.status, JSON.stringify(hand.json)).toBe(200);
    }
    const res = await approve(id, {});
    expect(res.json.refused.map((r: { opId: string; error: string; cause?: string }) => [r.opId, r.error, r.cause])).toEqual([
      [planAdjustId(a), "not_editable", "studio"],
      [planAdjustId(b), "changed_since_suggested", undefined],
    ]);
    expect(res.json.changed).toEqual([]);
    expect(await rowOf(b)).toMatchObject({ completionState: "scheduled", title: "Mine" });
  });

  it("CHARACTERIZATION: a workout under way: a revision and a skip of the same state are both refused `not_editable`/`under_way` (the state set directly: the player isn't driven)", async () => {
    const ctx0 = { today: TODAY, now: NOW, prefs: await loadPreferences(db, userId) };
    const a = await createDocWorkout(db, userId, { date: day(2), time: "12:00", doc: calmDoc({ title: "One" }) as never, clientId: "c-1" }, ctx0);
    const b = await createDocWorkout(db, userId, { date: day(3), time: "12:00", doc: calmDoc({ title: "Two" }) as never, clientId: "c-2" }, ctx0);
    const ctx = await mainRun();
    await workoutIn(ctx, day(2), { kind: "revise", workoutId: a.workout.id, baseRev: a.workout.docRev! }, calmDoc({ title: "Revised" }));
    await act(ctx, "adjust_plan", change(b.workout.id, SKIP));
    const id = await shown(ctx);
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.userId, userId));
    const answers = await approveUntilDone(id, {});
    expect(answers.flatMap((r) => r.json.refused).map((r: { error: string; cause?: string }) => [r.error, r.cause])).toEqual([["not_editable", "under_way"], ["not_editable", "under_way"]]);
    expect(answers.flatMap((r) => r.json.changed)).toEqual([]);
    expect((await rowOf(b.workout.id)).completionState).toBe("scheduled");
  });

  it("CHARACTERIZATION: `programme_change` HAS one (`base`): the settings saved by hand since refuse it `stale`, nothing written", async () => {
    const p = await adaptive();
    const ctx = await mainRun();
    await act(ctx, "change_programme", { programmeId: p, days: ["thursday", "Tue"], why: "Your Mondays are full now." });
    const id = await shown(ctx);
    const hand = await invoke("PATCH", `/api/programs/${p}`, { config: { preferredDays: [4] } });
    expect(hand.status, JSON.stringify(hand.json)).toBe(200);
    const res = await approve(id, { opIds: [programmeChangeId(p)] });
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["stale"]);
    expect(((await db.select().from(programs).where(eq(programs.id, p)))[0]!.config as { preferredDays: number[] }).preferredDays).toEqual([4]);
  });

  it("CHARACTERIZATION: `plan_change` HAS one (`base`): the plan edited by hand since refuses it `stale`, nothing written", async () => {
    const p = await coachPlan();
    const ctx = await mainRun();
    await act(ctx, "change_plan", { planId: p, why: "You asked.", brief: "The coach's brief." });
    const id = await shown(ctx);
    const hand = await invoke("PATCH", `/api/plans/${p}`, { brief: "My own brief." });
    expect(hand.status, JSON.stringify(hand.json)).toBe(200);
    const versions = (await db.select().from(programVersions).where(eq(programVersions.programId, p))).length;
    const res = await approve(id, { opIds: [planChangeId(p)] });
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["stale"]);
    expect((await db.select().from(programs).where(eq(programs.id, p)))[0]!.brief).toBe("My own brief.");
    expect(await db.select().from(programVersions).where(eq(programVersions.programId, p))).toHaveLength(versions);
  });

  it("CHARACTERIZATION: `objective_change` HAS one (`before`): the target changed since refuses it `stale`, atomically with its claim", async () => {
    const ctx = await mainRun();
    const goal = await KINDS.objective_change!(ctx);
    const id = await shown(ctx);
    const [objective] = await db.select().from(schema.objectives).where(eq(schema.objectives.userId, userId));
    const before = await getObjective(db, userId, objective!.id);
    await updateObjective(db, userId, objective!.id, { keyResults: [{ id: before.keyResults[0]!.id, ...WALL_SIT, target: 100 }] } as never, NOW);
    const res = await approve(id, { opIds: [goal.opId] });
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["stale"]);
    expect((await getObjective(db, userId, objective!.id)).keyResults[0]!.target).toBe(100);
  });

  it("CHARACTERIZATION: `import_correction` HAS one (`before`): the value changed since refuses it `stale`, nothing written", async () => {
    const ctx = await mainRun();
    const { batchId, lift } = await savedLift();
    await readSavesInRun(db, ctx, { batchId });
    await act(ctx, "correct_import", { target: "move", targetId: lift, field: "dose", after: { type: "time", range: [30, 30], sets: [2, 2] }, why: "The transcript says so.", basis: "evidence", cites: ["history"] });
    const id = await shown(ctx);
    const [move] = await db.select().from(personalMoves).where(eq(personalMoves.id, lift));
    await db.update(personalMoves).set({ record: { ...(move!.record as object), dose: { type: "reps", range: [5, 5] } } }).where(eq(personalMoves.id, lift));
    const res = await approve(id, { opIds: [correctionId("move", lift, "dose")] });
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["stale"]);
    expect(await db.select().from(importCorrections).where(eq(importCorrections.userId, userId))).toEqual([]);
  });

  it("CHARACTERIZATION: `move_pins` has NONE: the athlete's own unpin since the card is overwritten, without a line; only a move set aside is left", async () => {
    const pinnedByHand = "gobletSquat";
    const setAside = "deadBug";
    const ctx = await mainRun();
    await act(ctx, "pin_moves", { pin: [pinnedByHand, setAside], title: "Moves in rotation", summary: "Two moves in", why: "Your strength days lack a squat.", lines: [{ text: "Goblet squat in rotation." }, { text: "Dead bug in rotation." }] });
    const id = await shown(ctx);
    for (const body of [{ pinned: true }, { pinned: false }]) expect((await invoke("PUT", `/api/library/${pinnedByHand}/prefs`, body)).status).toBe(200);
    expect((await invoke("PUT", `/api/library/${setAside}/prefs`, { excluded: true })).status).toBe(200);
    const res = await approve(id, { opIds: [`pins-${ctx.run.id}`] });
    expect(res.status).toBe(200);
    expect(res.json.refused).toEqual([]);
    const pins = await db.select().from(exercisePrefs).where(eq(exercisePrefs.userId, userId));
    expect(pins.find((x) => x.exerciseId === pinnedByHand)?.pinned).toBe(true);
    expect(pins.find((x) => x.exerciseId === setAside)?.pinned).toBeFalsy();
    const outcome = (await opsOf(id)).find((o) => o.kind === "move_pins")!.outcome;
    expect(outcome).toMatchObject({ status: "applied", pinned: [pinnedByHand] });
    expect(outcome.lines.join(" ")).toContain("set aside");
    expect(outcome.lines.join(" ")).not.toContain("Goblet");
  });

  /** A running coach block with its two first-week sessions, through the approve route. Its plan id and the sessions. */
  async function runningBlock() {
    const ctx = await mainRun();
    await act(ctx, "propose_plan", { change: block(), why: "The next phase." });
    const id = await shown(ctx);
    expect((await approveUntilDone(id, { opIds: [PLAN_STRUCTURE_ID] })).at(-1)!.json.status).toBe("approved");
    const [plan] = await db.select().from(coachPlans).where(eq(coachPlans.userId, userId));
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, plan!.id));
    return { planId: plan!.id, rows };
  }

  it("CHARACTERIZATION: `plan_structure` has NONE beyond stopped or gone: a reshape archives a session the athlete moved by hand within the week, `applied`, `refused` empty", async () => {
    const { planId, rows } = await runningBlock();
    const monday = mondayOf(day(7));
    const ctx = await mainRun();
    await act(ctx, "propose_plan", { change: { kind: "reshapeWeek", planId, weekStart: monday, sessions: [{ date: addDays(monday, 1), session: easyRun(25, "Reshaped") }] }, why: "A lighter week." });
    const id = await shown(ctx);
    const handMoved = rows[0]!;
    const hand = await invoke("POST", `/api/plan/workouts/${handMoved.id}/move`, { toDate: addDays(monday, 4), toTime: "18:30" });
    expect(hand.status, JSON.stringify(hand.json)).toBe(200);
    const answers = await approveUntilDone(id, { opIds: [PLAN_STRUCTURE_ID] });
    expect(answers.flatMap((a) => a.json.refused)).toEqual([]);
    expect(answers.at(-1)!.json.status).toBe("approved");
    const after = await rowOf(handMoved.id);
    expect(after.archivedAt).not.toBeNull();
    expect(after.effectiveDate).toBe(addDays(monday, 4));
  });

  it("CHARACTERIZATION: `plan_structure` stopped since the card: refused `plan_refused`, nothing added", async () => {
    const { planId } = await runningBlock();
    const monday = mondayOf(day(7));
    const ctx = await mainRun();
    await act(ctx, "propose_plan", { change: { kind: "firmUp", planId, weekStart: addDays(monday, 7), sessions: [{ date: addDays(monday, 8), session: easyRun(25, "Firmed") }] }, why: "The next week." });
    const id = await shown(ctx);
    let answer: Answer | null = null;
    for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
      answer = await invoke("POST", `/api/coach/plans/${planId}/retire`);
      if (!answer.json.remaining) break;
    }
    expect(answer!.status, JSON.stringify(answer!.json)).toBe(200);
    const res = await approve(id, { opIds: [PLAN_STRUCTURE_ID] });
    expect(res.json.refused.map((r: { error: string }) => r.error)).toEqual(["plan_refused"]);
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Firmed")))).toEqual([]);
  });
});

// ── 4. Duplicates ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a double apply would double. */
async function counts() {
  return {
    rows: (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).length,
    overrides: (await db.select().from(scheduleOverrides)).length,
    revisions: (await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.userId, userId))).length,
    jobs: (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId))).length,
    intents: (await db.select().from(syncIntents).where(eq(syncIntents.userId, userId))).length,
    receipts: (await receipts()).length,
  };
}

/** One request held at the gate until the other arrived, then run whole while the other waits: both read the proposal before either wrote. */
function firstThenSecond(gate: "beforeDesign" | "beforeApply") {
  let arrivals = 0;
  let firstIn!: () => void;
  const firstArrived = new Promise<void>((r) => (firstIn = r));
  let secondIn!: () => void;
  const secondArrived = new Promise<void>((r) => (secondIn = r));
  let firstDone!: () => void;
  const firstFinished = new Promise<void>((r) => (firstDone = r));
  gates[gate] = async () => {
    arrivals += 1;
    if (arrivals === 1) {
      firstIn();
      await secondArrived;
    } else if (arrivals === 2) {
      secondIn();
      await firstFinished;
    }
  };
  return { firstArrived, firstDone, secondIn, arrivals: () => arrivals };
}

/** One change or kind's proposal, for the same approval twice. */
const REPEATS: Record<string, () => Promise<{ id: string; opIds: string[] }>> = {
  ...Object.fromEntries(
    Object.entries(CHANGES).map(([name, c]) => [
      `plan_adjust ${name}`,
      async () => {
        const w = await session("w-1", day(1), TEMPO);
        return { id: await changes(change(w, c)), opIds: [planAdjustId(w)] };
      },
    ]),
  ),
  ...Object.fromEntries(
    Object.keys(KINDS)
      .filter((k) => k !== "plan_adjust")
      .map((k) => [
        k,
        async () => {
          const ctx = await mainRun();
          const { opId } = await KINDS[k]!(ctx);
          return { id: await shown(ctx), opIds: [opId] };
        },
      ]),
  ),
};

describe("4. the same approval twice, one after the other", () => {
  it.each(Object.keys(REPEATS))("CHARACTERIZATION: %s approved twice: 200 and `settled`, nothing written the second time, one of everything", async (name) => {
    const { id, opIds } = await REPEATS[name]!();
    const first = await approveUntilDone(id, { opIds });
    expect(first.at(-1)!.status).toBe(200);
    expect((await proposalOf(id)).status).toBe("approved");
    const once = await counts();
    const before = await proposalOf(id);
    const second = await approve(id, { opIds });
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ ok: true, status: "approved", refused: [], remaining: [], applied: [], changed: [] });
    expect(second.json.settled.map((s: { opId: string; outcome: string }) => [s.opId, s.outcome])).toEqual(opIds.map((o) => [o, "applied"]));
    expect(second.writes).toEqual([]);
    expect(await counts()).toEqual(once);
    expect((await proposalOf(id)).ops).toEqual(before.ops);
    expect(once.receipts).toBe(1);
  });

  it("CHARACTERIZATION: `{}` twice: the same; a session moved back by hand after the first stays where the athlete put it", async () => {
    const w = await session("w-1", day(1), TEMPO);
    const id = await changes(change(w, CHANGES.move!));
    expect((await approve(id, {})).json.status).toBe("approved");
    await invoke("POST", `/api/plan/workouts/${w}/move`, { toDate: day(1), toTime: "07:00" });
    const again = await approve(id, {});
    expect(again.status).toBe(200);
    expect(again.writes).toEqual([]);
    expect((await rowOf(w)).effectiveDate).toBe(day(1));
  });

  it("CHARACTERIZATION: the thread coach's proposal twice: the second is 409 `not_pending` `approved`, nothing written (the client reads that as applied, coach-approve.ts)", async () => {
    const w = await session("w-1", day(1), TEMPO);
    const id = await threadProposal([{ kind: "ease", workoutId: w, session: easyRun(25, "Easy run") }]);
    expect((await approve(id)).status).toBe(200);
    const once = await counts();
    const second = await approve(id);
    expect([second.status, second.json]).toEqual([409, { error: "not_pending", status: "approved" }]);
    expect(second.writes).toEqual([]);
    expect(await counts()).toEqual(once);
  });
});

describe("4b. the same approval twice at once (the in-process interleaving: see the file's header for what this can't show)", () => {
  const twoChanges = async () => {
    const a = await session("w-1", day(1), TEMPO);
    const b = await session("w-2", day(2), TEMPO);
    const ctx = await mainRun();
    await act(ctx, "adjust_plan", change(a, SKIP));
    await act(ctx, "adjust_plan", change(b, { kind: "ease", durationMinutes: 25 }));
    return { id: await shown(ctx), a, b };
  };

  it("CHARACTERIZATION (harness limit): a bare `Promise.all` of two approves barely races here: `requireUser` hashes the session token, a real macrotask, and the rest of the winner runs in microtasks before the other gets past it. Only the gated tests below force an ordering", async () => {
    const { id, a, b } = await twoChanges();
    const answers = await Promise.all([approve(id, {}), approve(id, {})]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    // Whichever hash came back first (their order isn't this test's to say): that one did it all, and the other found it done.
    const [winner, other] = answers[0]!.json.changed.length > 0 ? answers : [answers[1]!, answers[0]!];
    expect(winner!.json.changed).toHaveLength(2);
    expect(other!.json).toMatchObject({ changed: [], settled: [{ opId: planAdjustId(a), outcome: "applied" }, { opId: planAdjustId(b), outcome: "applied" }] });
    expect((await counts()).receipts).toBe(1);
  });

  it("CHARACTERIZATION: forced, both read before either wrote: the second finds the first's effects made, and its guarded write's `status` predicate refuses it (the first ended `approved`): 409 `proposal_changed`, the applier run once", async () => {
    const { id, a, b } = await twoChanges();
    const f = firstThenSecond("beforeDesign");
    let applierRuns = 0;
    gates.beforeApply = async () => void (applierRuns += 1);
    const first = approve(id, {}).then((r) => {
      f.firstDone();
      return r;
    });
    await f.firstArrived;
    const [one, two] = await Promise.all([first, approve(id, {})]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(409);
    expect(two.json).toEqual({ error: "proposal_changed" });
    expect(applierRuns).toBe(1);
    expect((await counts()).receipts).toBe(1);
    expect((await db.select().from(syncIntents).where(eq(syncIntents.targetId, b))).length).toBe(1);
    expect((await rowOf(a)).completionState).toBe("skipped");
    // The client's own next step (approveUntilDone: read again, ask once more): settled, nothing written.
    const retry = await approve(id, {});
    expect(retry.status).toBe(200);
    expect(retry.writes).toEqual([]);
    expect(retry.json.status).toBe("approved");
  });

  it("CHARACTERIZATION: forced, the second read before the first's claim and writes while the first holds it, the status still `pending`: the guarded write's `ops` compare refuses it, 409 `proposal_changed`, the applier run once", async () => {
    const a = await session("w-1", day(1), TEMPO);
    const id = await changes(change(a, SKIP));
    let firstAtDesign!: () => void;
    const firstIn = new Promise<void>((r) => (firstAtDesign = r));
    let secondArrived!: () => void;
    const secondIn = new Promise<void>((r) => (secondArrived = r));
    let firstClaimedNow!: () => void;
    const firstClaimed = new Promise<void>((r) => (firstClaimedNow = r));
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    let arrivals = 0;
    gates.beforeDesign = async () => {
      arrivals += 1;
      if (arrivals === 1) {
        firstAtDesign();
        await secondIn;
      } else {
        secondArrived();
        await firstClaimed;
      }
    };
    let applierRuns = 0;
    gates.beforeApply = async () => {
      applierRuns += 1;
      firstClaimedNow();
      await firstHeld;
    };
    const first = approve(id, {});
    await firstIn;
    const two = await approve(id, {});
    expect([two.status, two.json]).toEqual([409, { error: "proposal_changed" }]);
    // Still pending, so the status predicate alone would have let the second through.
    expect((await proposalOf(id)).status).toBe("pending");
    releaseFirst();
    const one = await first;
    expect([one.status, one.json.status]).toEqual([200, "approved"]);
    expect(applierRuns).toBe(1);
    expect((await counts()).receipts).toBe(1);
    expect((await rowOf(a)).completionState).toBe("skipped");
  });

  it("CHARACTERIZATION: forced, a request that read the proposal, then waited out the other's whole approve and a later hand move: it records nothing and overwrites nothing", async () => {
    const a = await session("w-1", day(1), TEMPO);
    const id = await changes(change(a, CHANGES.move!));
    const f = firstThenSecond("beforeDesign");
    const first = approve(id, {}).then((r) => {
      f.firstDone();
      return r;
    });
    await f.firstArrived;
    const late = approve(id, {});
    const one = await first;
    expect(one.status).toBe(200);
    expect((await invoke("POST", `/api/plan/workouts/${a}/move`, { toDate: day(6), toTime: "06:00" })).status).toBe(200);
    const two = await late;
    expect([two.status, two.json]).toEqual([409, { error: "proposal_changed" }]);
    expect((await rowOf(a)).effectiveDate).toBe(day(6));
  });

  it("CHARACTERIZATION: an approve arriving while another's claim is held: 409 `in_flight` naming the changes; the applier isn't run for them; the holder then finishes", async () => {
    const a = await session("w-1", day(1), TEMPO);
    const id = await changes(change(a, SKIP));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inApplier = new Promise<void>((r) => (entered = r));
    let applierRuns = 0;
    gates.beforeApply = async () => {
      applierRuns += 1;
      entered();
      await held;
    };
    const first = approve(id, {});
    await inApplier;
    expect((await opsOf(id))[0]!.outcome.status).toBe("applying");
    const second = await approve(id, {});
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "in_flight", opIds: [planAdjustId(a)], status: "pending", applied: [], changed: [], refused: [], settled: [], remaining: [] });
    // A decline meets the same claim.
    const declined = await decline(id, {});
    expect(declined.status).toBe(409);
    expect(declined.json.error).toBe("in_flight");
    release();
    expect((await first).json.status).toBe("approved");
    expect(applierRuns).toBe(1);
    expect((await counts()).receipts).toBe(1);
  });

  it("CHARACTERIZATION: a claim whose request died answers `in_flight` for its window; past it, a made change is recorded applied without the applier, a change not made is applied by the next approve", async () => {
    const a = await session("w-1", day(1), TEMPO);
    const b = await session("w-2", day(2), TEMPO);
    const id = await changes(change(a, SKIP), change(b, SKIP));
    const claimed = (await opsOf(id)).map((o) => ({ ...o, outcome: { status: "applying", at: nowInstant(), before: { date: o.date, time: "07:00", title: "Tempo", minutes: 40 } } }));
    await db.update(coachProposals).set({ ops: claimed }).where(eq(coachProposals.id, id));
    // The first request's applier got as far as the first session.
    await db.update(plannedWorkouts).set({ completionState: "skipped", resolutionDate: TODAY }).where(eq(plannedWorkouts.id, a));
    const applierOps: unknown[] = [];
    const inWindow = await approve(id, {});
    // A claim found made is recorded at once, fresh or stale: the other waits for its window.
    expect(inWindow.status).toBe(200);
    expect(inWindow.json).toMatchObject({ inFlight: [planAdjustId(b)] });
    expect(inWindow.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId(a)]);
    vi.setSystemTime(new Date(Date.parse(NOW) + APPLYING_STALE_MS + 1));
    gates.beforeApply = async () => void applierOps.push(1);
    const after = await approve(id, {});
    expect(after.status).toBe(200);
    expect(after.json.changed.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId(b)]);
    expect(applierOps).toHaveLength(1);
    expect((await rowOf(b)).completionState).toBe("skipped");
    expect((await proposalOf(id)).status).toBe("approved");
  });

  it("CHARACTERIZATION: a new workout alone has no claim: raced, its key makes one row and one revision; the loser is 409 `proposal_changed`", async () => {
    const ctx = await mainRun();
    const w = await workoutIn(ctx, day(6));
    const id = await shown(ctx);
    const f = firstThenSecond("beforeDesign");
    const first = approve(id, {}).then((r) => {
      f.firstDone();
      return r;
    });
    await f.firstArrived;
    const [one, two] = await Promise.all([first, approve(id, {})]);
    expect([one.status, two.status]).toEqual([200, 409]);
    expect(two.json).toEqual({ error: "proposal_changed" });
    expect(await counts()).toMatchObject({ rows: 1, receipts: 1 });
    expect((await outcomes(id))[w]).toBe("applied");
    expect(await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.userId, userId))).toHaveLength(1);
  });

  it("CHARACTERIZATION: an approve meeting a decline, forced: the decline wins before the claim, and the approve is 409 `proposal_changed`, nothing applied", async () => {
    const a = await session("w-1", day(1), TEMPO);
    const id = await changes(change(a, SKIP));
    let hold!: () => void;
    const gate = new Promise<void>((r) => (hold = r));
    let arrived!: () => void;
    const atGate = new Promise<void>((r) => (arrived = r));
    gates.beforeDesign = async () => {
      gates.beforeDesign = null;
      arrived();
      await gate;
    };
    const first = approve(id, {});
    await atGate;
    expect((await decline(id, {})).json.status).toBe("declined");
    hold();
    const res = await first;
    expect([res.status, res.json]).toEqual([409, { error: "proposal_changed" }]);
    expect((await rowOf(a)).completionState).toBe("scheduled");
    expect((await proposalOf(id)).status).toBe("declined");
  });

  const threadOps = (w: string, m: string, s: string) => [
    { kind: "ease", workoutId: w, session: easyRun(25, "Easy run") },
    { kind: "move", workoutId: m, toDate: day(5), toTime: "12:00" },
    { kind: "skip", workoutId: s },
    { kind: "add", date: day(6), session: easyRun(20, "Added run") },
  ];

  it("CHARACTERIZATION: THREAD proposal, forced, both past the `pending` check: no claim and no guard: BOTH answer 200, BOTH write a receipt, and the second's applier runs over the first's work: the ease's intent twice; a move found done isn't", async () => {
    const [w, m, s] = [await session("w-1", day(1), TEMPO), await session("w-2", day(2), TEMPO), await session("w-3", day(3), TEMPO)];
    const id = await threadProposal(threadOps(w, m, s));
    const f = firstThenSecond("beforeApply");
    const first = approve(id).then((r) => {
      f.firstDone();
      return r;
    });
    await f.firstArrived;
    const [one, two] = await Promise.all([first, approve(id)]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(await receipts()).toHaveLength(2);
    expect((await db.select().from(syncIntents).where(eq(syncIntents.targetId, w))).length).toBe(2);
    expect((await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, m))).length).toBe(1);
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.title, "Added run")))).toHaveLength(1);
    expect((await proposalOf(id)).status).toBe("approved");
  });

  it("CHARACTERIZATION: THREAD proposal, a decline landing during the apply: the unguarded `approved` overwrites `declined`, and the thread holds both receipts", async () => {
    const w = await session("w-1", day(1), TEMPO);
    const id = await threadProposal([{ kind: "skip", workoutId: w }]);
    let hold!: () => void;
    const gate = new Promise<void>((r) => (hold = r));
    let arrived!: () => void;
    const atGate = new Promise<void>((r) => (arrived = r));
    gates.beforeApply = async () => {
      arrived();
      await gate;
    };
    const first = approve(id);
    await atGate;
    const declined = await decline(id);
    expect([declined.status, declined.json]).toEqual([200, { ok: true }]);
    expect((await proposalOf(id)).status).toBe("declined");
    hold();
    expect((await first).status).toBe(200);
    expect((await proposalOf(id)).status).toBe("approved");
    expect((await rowOf(w)).completionState).toBe("skipped");
    expect(await receipts()).toEqual(["Left as planned — This week", "✓ approved — This week"]);
  });

  it("CHARACTERIZATION: a move of a session on the watch, forced as above: one COROS job, queued for the client's drain, never run in the approve", async () => {
    await connectTestCoros(db, userId);
    await savePreferences(db, userId, { ...prefs, corosWritesEnabled: true });
    const w = await session("w-1", day(2), { ...TEMPO, lastVerifiedCorosDate: day(2), sourceWorkoutId: "123:9", sourceIdInPlan: "9", sourceProgramId: "p-1" });
    const id = await changes(change(w, { kind: "move", toDate: day(4) }));
    const f = firstThenSecond("beforeDesign");
    const first = approve(id, {}).then((r) => {
      f.firstDone();
      return r;
    });
    await f.firstArrived;
    const [x, y] = await Promise.all([first, approve(id, {})]);
    expect([x.status, y.status]).toEqual([200, 409]);
    expect(x.json.coachDrain).toBe(true);
    const jobs = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, w));
    expect(jobs.map((j) => [j.kind, j.destinationDate, j.status])).toEqual([["move_scheduled_workout", day(4), "queued"]]);
  });
});

// ── 5. The other writers, and 6. the shapes the clients send ─────────────────────────────────────────────────────────

describe("5. other requests that decide a proposal", () => {
  it("CHARACTERIZATION: reading a proposal writes nothing; the read is the only place the client learns which ops exist", async () => {
    const a = await session("w-1", day(1), TEMPO);
    const id = await changes(change(a, SKIP));
    const res = await invoke("GET", `/api/coach/proposals/${id}`);
    expect(res.status).toBe(200);
    expect(res.writes).toEqual([]);
    expect(res.json.changes.map((c: { opId: string }) => c.opId)).toEqual([planAdjustId(a)]);
  });

  it("CHARACTERIZATION: an edit whose document has no `parts` passes the route's schema (`z.record`) and throws in `isRunDoc`: an unhandled 500, nothing written", async () => {
    const ctx = await mainRun();
    const opId = await workoutIn(ctx, day(3));
    const id = await shown(ctx);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await approve(id, { edit: { opId, doc: { nonsense: true } } });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.writes).toEqual([]);
    expect((await outcomes(id))[opId]).toBe("open");
  });

  it("CHARACTERIZATION: `{ edit }` is the second way a request applies an op: one workout, by id, the athlete's own document; refused as a Studio save is, nothing recorded", async () => {
    const ctx = await mainRun();
    const opId = await workoutIn(ctx, day(3));
    const id = await shown(ctx);
    const refused = await approve(id, { edit: { opId, doc: { version: 1, title: "x", parts: [] } } });
    expect([refused.status, refused.json.error]).toEqual([422, "invalid_doc"]);
    expect((await outcomes(id))[opId]).toBe("open");
    const res = await approve(id, { edit: { opId, doc: calmDoc({ title: "My version" }) } });
    expect(res.status).toBe(200);
    expect(res.json.applied.map((a: { opId: string; edited?: boolean }) => [a.opId, a.edited])).toEqual([[opId, true]]);
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).map((r) => r.title)).toEqual(["My version"]);
  });

  it("CHARACTERIZATION: a decline changes no session: at most it records an op applied whose effect it finds made", async () => {
    const a = await session("w-1", day(1), TEMPO);
    const id = await changes(change(a, SKIP));
    const res = await decline(id, { reason: "Not this week." });
    expect(res.status).toBe(200);
    expect(res.writes.filter((q) => /planned_workouts/.test(q))).toEqual([]);
    expect((await rowOf(a)).completionState).toBe("scheduled");
    expect((await opsOf(id))[0]!.outcome).toMatchObject({ status: "declined", reason: "Not this week." });
  });
});

describe("6. the bodies the web client sends, as the server answers them", () => {
  it("CHARACTERIZATION: a bundle older than the card that names them sends `{}` beside a workout: its workout applies, and a plan change and a correction it never drew stay open, named in `notNamed` (which it ignores)", async () => {
    // ownCards counted plans, programmes and pins from 2026-10-25 (956f7ef9), plan changes from 2026-11-06 (ed3c81a6), corrections
    // and objectives from the merge. A bundle before each sends `{}` here, and this is what the server does with it.
    const ctx = await mainRun();
    const workout = await KINDS.doc_workout!(ctx);
    const planChange = await KINDS.plan_change!(ctx);
    const correction = await KINDS.import_correction!(ctx);
    const id = await shown(ctx);
    const answers = await approveUntilDone(id, {});
    expect(answers.at(-1)!.json.status).toBe("partially_approved");
    expect(answers.at(-1)!.json.notNamed).toEqual([planChange.opId, correction.opId]);
    expect([await workout.made(), await planChange.made(), await correction.made()]).toEqual([true, false, false]);
  });

  it("CHARACTERIZATION: today's client names what it drew, each card its own, then `{ opIds: remaining }`", async () => {
    const ctx = await mainRun();
    const workout = await KINDS.doc_workout!(ctx);
    const adj = await KINDS.plan_adjust!(ctx);
    const pc = await KINDS.plan_change!(ctx);
    const id = await shown(ctx);
    // What PlanCard sends for its own card.
    const own = await approve(id, { opIds: [pc.opId] });
    expect(own.json.planned.map((p: { opId: string }) => p.opId)).toEqual([pc.opId]);
    expect(await workout.made()).toBe(false);
    // What ProposalCard sends: its own ops by id.
    const card = await approve(id, { opIds: [adj.opId, workout.opId] });
    expect(card.json.status).toBe("approved");
    expect(await workout.made()).toBe(true);
    expect(await adj.made()).toBe(true);
  });

  it("CHARACTERIZATION: a whole-suggestion answer that doesn't fit one request names what is left, and that list is all a client needs next", async () => {
    const ids = await Promise.all(Array.from({ length: 11 }, (_, i) => session(`w-${i}`, day(i + 1))));
    const ctx = await mainRun();
    for (const w of ids.slice(0, 10)) await act(ctx, "adjust_plan", change(w, SKIP));
    const workouts = [await workoutIn(ctx, day(13)), await workoutIn(ctx, day(14))];
    const id = await shown(ctx);
    const first = await approve(id, {});
    expect(first.status).toBe(200);
    expect(first.json.remaining.length).toBeGreaterThan(0);
    expect(first.json.remaining).toEqual(expect.arrayContaining(workouts.slice(0, 1)));
    const answers = await approveUntilDone(id, { opIds: first.json.remaining });
    expect(answers.at(-1)!.json.status).toBe("approved");
  });
});
