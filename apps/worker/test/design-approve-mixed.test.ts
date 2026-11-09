/**
 * A SUGGESTION OF SEVERAL KINDS, APPROVED (the merge of plans with a purpose and the coach's review of imported posts). Each
 * side's suites test its own ops alone or beside a workout; these are the combinations neither had: a `plan_change` beside
 * corrections, beside an objective change, beside a whole plan — a pause among them, at its dearest — and a retried approve.
 * Every class spends from one budget in one order (design-approve.ts, "A CARD OF SEVERAL KINDS"), so everything lands once, in
 * that order, each request within the Workers' budget, with the receipt's words true. The counts are measured and pinned:
 * each request's statements, on a realistic account, its sweep and its receipt included.
 *
 * Also what the kinds meet elsewhere: a plan's linked objective retired or gone (read_plans, where you stand, change_plan), a
 * stop's promote and the readers that switch over the kinds.
 *
 * On a made-up course (`course-fixture.ts`), under a faked `Date`. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@rg/workout", async (importOriginal) => {
  const { withIntroCourse } = await import("./course-fixture.js");
  return withIntroCourse(await importOriginal<typeof import("@rg/workout")>());
});

import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, courseConfigSchema, newId, type CourseConfig, type UserPreferences } from "@rg/domain";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { coachRoutes } from "../src/routes/coach.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { designedWords } from "../src/services/coach-context.js";
import { cardsOf } from "../src/services/coach-conversation.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { writeCourseSession } from "../src/services/course-sessions.js";
import type { Db } from "../src/services/db.js";
import { PLAN_NOT_ADDED, REQUEST_BUDGET } from "../src/services/design-approve.js";
import { pastDayLine } from "../src/services/design-review.js";
import { ACT_TOOLS, READ_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { mondayOf } from "../src/services/design-tools/propose-plan.js";
import { isToolErr, type ToolContext, type ToolOk } from "../src/services/design-tools/types.js";
import { queueProvisionalPush } from "../src/services/mirror.js";
import { createObjective, getObjective, updateObjective } from "../src/services/objectives.js";
import { placeSlots, slotId } from "../src/services/program-slots.js";
import { correctionId, objectiveChangeId, planChangeId, PLAN_STRUCTURE_ID } from "../src/services/proposal-kinds.js";
import { driftsOf, readStandFacts, standBlock } from "../src/services/where-you-stand.js";
import { makeTestDb, MAX_LOOP_ITERATIONS, mountRoutes, wholeSuggestion } from "./helpers.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeRealisticEnv, seedRealisticAccount } from "./realistic-account.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";
import { readSavesInRun } from "./saves-read-fixture.js";
import { connectMock, seedCatalog, switchOn } from "./watch-push-fixture.js";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";

const { coachMessages, coachProposals, coachRuns, corosWriteJobs, importCorrections, keyResults, objectives, plannedWorkouts, programs, programVersions, sessionBuilds, userPreferences } = schema;

/** A Monday. */
const MON = "2026-10-05";
/** Monday noon in Los Angeles, the test user's zone. */
const NOW = "2026-10-05T19:00:00.000Z";
const SAVED_AT = "2026-10-04T17:00:00.000Z";
const WHY = "Your wall sit is at 45 s of 120 s with half the time gone: 90 s is the honest target.";
const WALL_SIT = { label: "Zorbex wall sit", measure: { kind: "hold_max", libraryIds: ["wallSit"] }, target: 120, dueDate: "2026-12-01" };
const LIFT = savedMoveDraft("Zorbex hip lift", {
  dose: { text: "6-10 reps", type: "reps", range: [6, 10] },
  useWhen: [{ text: "after an easy run", evidence: "stated" }],
  quotes: [{ field: "dose", text: "two sets of thirty seconds", at: 192, from: "transcript", check: "verified" }],
});
const DOSE_FIX = { type: "time", range: [30, 30], sets: [2, 2] };

let db: Db;
let userId: string;
let prefs: UserPreferences;
let statements: string[];
let cookie: string;
/** A test's own look at each statement (one may throw: a request that dies). */
let watch: ((q: string) => void) | null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  statements = [];
  watch = null;
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => { statements.push(s); watch?.(s); } });
  const account = await seedRealisticAccount(db);
  userId = account.userId;
  prefs = { ...(await loadPreferences(db, userId)), corosWritesEnabled: true };
  await db.update(userPreferences).set({ prefs: prefs as never }).where(eq(userPreferences.userId, userId));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  await seedCatalog(db);
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const env = (): Env => ({ ...makeRealisticEnv(), COACH_DESIGNER: "1", AI_GATEWAY_API_KEY: "test-key", WATCH_PUSH_ENABLED: "1" }) as Env;
const app = () => mountRoutes(db, "/api/coach", coachRoutes);

async function invoke(method: string, path: string, body?: unknown) {
  body = await wholeSuggestion(db, path, body);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (w: Promise<unknown>) => pending.push(w), passThroughOnException: () => undefined, props: {} };
  statements.length = 0;
  const res = await app().request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env(), executionCtx as never);
  await Promise.all(pending);
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { text };
  }
  return { status: res.status, json, total: statements.length, seen: [...statements] };
}

/** Approve as the client does — naming `opIds` (none: the whole suggestion) — until nothing remains. */
async function approveAll(id: string, opIds?: string[]) {
  const answers: Array<Awaited<ReturnType<typeof invoke>>> = [];
  let remaining: string[] | null = opIds ?? null;
  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.total, `request ${i}`).toBeLessThanOrEqual(REQUEST_BUDGET);
    answers.push(res);
    remaining = res.json.remaining as string[];
    if (remaining.length === 0) return answers;
  }
  throw new Error("the approve never finished");
}

async function mainRun(request = "Sort these out"): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request, status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW, updatedAt: NOW,
  });
  return { db, env: env(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
}

/** One act tool's call in the run: stored, or the test fails with its refusal. */
async function act(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolOk> {
  const r = await ACT_TOOLS.find((t) => t.name === name)!.run({ ...ctx, toolUseId: `toolu_${newId()}` }, input);
  if (isToolErr(r)) throw new Error(`${name} refused: ${r.error} — ${r.why}`);
  return r;
}

const pending = (ctx: ToolContext) => db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
const proposalOf = async (id: string) => (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
const opsOf = async (id: string) => (await proposalOf(id)).ops as Array<{ id?: string; kind: string; outcome?: { status: string; why?: string; error?: string; changed?: string[] } }>;
const statusOf = async (id: string, opId: string) => (await opsOf(id)).find((o) => o.id === opId)?.outcome?.status;
const planRow = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!;
const versionsOf = (id: string) => db.select().from(programVersions).where(eq(programVersions.programId, id));
const receipts = async () => (await db.select().from(coachMessages).where(eq(coachMessages.userId, userId))).filter((m) => m.role === "receipt").map((m) => m.body);

/** A coach's plan of the account's. */
async function plan(name = "Base block"): Promise<string> {
  const id = `plan-${newId()}`;
  await db.insert(programs).values({
    id, userId, kind: "coach", name, status: "active", disciplines: ["run"], startDate: null, endDate: null, raceDate: null, source: null, config: {},
    purpose: "Get fitter", brief: "Base block.", onEnd: "ask", createdAt: NOW, updatedAt: NOW, archivedAt: null,
  });
  return id;
}

/** A course with today's session written and its copy on the watch: a pause's dearest pass. */
async function courseWithCopy(config: Partial<CourseConfig> = {}): Promise<{ p: string; session: string }> {
  const server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
  const p = newId();
  await db.insert(programs).values({
    id: p, userId, kind: "course", name: "Evening practice", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "18:15", placementWeeksAhead: 1, ...config }),
    onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null,
  });
  await placeSlots(db, userId, p, MON, prefs, NOW);
  const session = slotId(p, MON);
  const ctx = { today: MON, now: NOW, prefs };
  const row = async () => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, session)))[0]!;
  expect((await writeCourseSession(db, userId, await row(), ctx)).written).toBe(true);
  expect(await queueProvisionalPush(db, switchOn(), userId, await row(), ctx)).toBe("queued");
  await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  const [record] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, session));
  expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${record!.id}`)))[0]!.status).toBe("verified");
  return { p, session };
}

async function savedLift() {
  const seeded = await seedSavedBatch(db, userId, { savedAt: SAVED_AT, posts: [{ moves: [{ draft: LIFT }] }] });
  return { batchId: seeded.batchId, post: seeded.postIds[0]!, lift: seeded.moveIds[0]![0]! };
}

async function wallSit() {
  const o = await createObjective(db, userId, { title: "Strong legs", keyResults: [WALL_SIT] }, NOW);
  return { objectiveId: o.id, krId: o.keyResults[0]!.id };
}

/** Corrections of `lift`, by field: three a request is the most. */
const FIXES: Array<[string, unknown]> = [
  ["dose", DOSE_FIX],
  ["summary", "Slow."],
  ["purpose", "Hips."],
  ["cues", ["Slow."]],
  ["load", "bodyweight"],
  ["steps", ["Up."]],
  ["laterality", "unilateral"],
  ["name", "Zorbex hip raise"],
];
const fix = (ctx: ToolContext, lift: string, field: string, after: unknown) =>
  act(ctx, "correct_import", { target: "move", targetId: lift, field, after, why: "The transcript says so.", basis: "evidence", cites: ["history"] });
const fixIdOf = (lift: string, field: string) => correctionId("move", lift, field);
const retarget = (ctx: ToolContext, krId: string, target = 90) => act(ctx, "propose_objective", { change: "retarget", keyResultId: krId, target, why: WHY, basis: "stand" });
const goalIdOf = (krId: string) => objectiveChangeId("retarget", krId);
const firm = (monday: string, n: number) =>
  Array.from({ length: n }, (_, k) => ({
    date: addDays(monday, k % 7),
    session: { category: "easy", title: `Run ${k + 1}`, durationMinutes: 30 + k, run: { blocks: [{ kind: "duration", value: 30 + k, intensity: "easy" }] } },
  }));
const block = (ctx: ToolContext, n = 1) => {
  const monday = mondayOf(addDays(MON, 7));
  return act(ctx, "propose_plan", {
    change: {
      kind: "createPlan", discipline: "run", name: "Build block", newPlan: { name: "Synthetic plan", purpose: "A synthetic purpose" }, startDate: monday, endDate: addDays(monday, 20), firmSessions: firm(monday, n),
      shapeWeeks: [0, 1].map((k) => ({ weekStart: addDays(monday, 7 * (k + 1)), volumeTarget: "about 30 km", keySessions: ["long run"] })),
    },
    why: "The next phase.",
  });
};
const change = (ctx: ToolContext, planId: string, input: Record<string, unknown>) => act(ctx, "change_plan", { planId, why: "You asked.", ...input });

describe("a plan change beside corrections, beside an objective change", () => {
  it("a brief, three corrections and an objective change: one request, each once, within the budget — and the receipt says all of it", async () => {
    const p = await plan();
    const { lift } = await savedLift();
    const { objectiveId, krId } = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await change(ctx, p, { brief: "Base block, then the build." });
    for (const [field, after] of FIXES.slice(0, 3)) await fix(ctx, lift, field, after);
    await retarget(ctx, krId);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    const ops = (await opsOf(id)).map((o) => o.id!);

    const answers = await approveAll(id, ops);
    // MEASURED: the request's own, the plan change's 6, the objectives' 3 and the corrections' 11.
    expect(answers.map((a) => a.total)).toEqual([27]);
    expect(answers[0]!.json).toMatchObject({ status: "approved", remaining: [], refused: [] });
    expect((await planRow(p)).brief).toBe("Base block, then the build.");
    expect(await versionsOf(p)).toHaveLength(1);
    expect(await db.select().from(importCorrections).where(eq(importCorrections.userId, userId))).toHaveLength(3);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(90);
    expect(await receipts()).toEqual([expect.stringMatching(/^✓ approved — .*: Ending: Ask me; 3 corrections to your saves; 1 change to your objectives$/)]);

    // Asked again: settled, nothing more written.
    const again = await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: ops });
    expect(again.status).toBe(200);
    expect(again.seen.filter((q) => /^(insert|update|delete) /i.test(q))).toEqual([]);
    expect(await versionsOf(p)).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
  });

  it("more corrections than a request takes: the plan change and the objective change first, the rest in `remaining` in order, each once", async () => {
    const p = await plan();
    const { lift } = await savedLift();
    const { krId } = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await change(ctx, p, { onEnd: "continue" });
    for (const [field, after] of FIXES.slice(0, 5)) await fix(ctx, lift, field, after);
    await retarget(ctx, krId);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);

    const answers = await approveAll(id, (await opsOf(id)).map((o) => o.id!));
    expect(answers.map((a) => a.total)).toEqual([26, 15]);
    expect(answers[0]!.json.planned.map((x: { opId: string }) => x.opId)).toEqual([planChangeId(p)]);
    expect(answers[0]!.json.objectives.map((x: { opId: string }) => x.opId)).toEqual([goalIdOf(krId)]);
    expect(answers[0]!.json.corrected).toHaveLength(3);
    expect(answers[1]!.json.corrected).toHaveLength(2);
    expect(answers[1]!.json).toMatchObject({ status: "approved", remaining: [] });
    expect(await db.select().from(importCorrections).where(eq(importCorrections.userId, userId))).toHaveLength(5);
    expect(await versionsOf(p)).toHaveLength(1);
    expect(await receipts()).toEqual([expect.stringContaining("5 corrections to your saves; 1 change to your objectives")]);
  });

  it("the whole suggestion's tap — every op its cards draw, named (`wholeSuggestion`) — leaves the objective change open, whatever rides beside it", async () => {
    const p = await plan();
    const { lift } = await savedLift();
    const { objectiveId, krId } = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await change(ctx, p, { brief: "Base block, then the build." });
    await fix(ctx, lift, "dose", DOSE_FIX);
    await retarget(ctx, krId);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);

    const answers = await approveAll(id);
    expect(answers.at(-1)!.json.status).toBe("partially_approved");
    expect(await statusOf(id, goalIdOf(krId))).toBeUndefined();
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(120);
    expect((await planRow(p)).brief).toBe("Base block, then the build.");
    // The receipt counts it as not yet approved, in its true numbers.
    expect(await receipts()).toEqual([expect.stringContaining("(2 of 3)")]);
    // Named, it applies.
    await approveAll(id, [goalIdOf(krId)]);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(90);
    expect((await proposalOf(id)).status).toBe("approved");
  });

  it("a plan change refused (the athlete's own edit) leaves the corrections and objective change landing; a correction refused leaves the plan change landed", async () => {
    const p = await plan();
    const { lift } = await savedLift();
    const { objectiveId, krId } = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await change(ctx, p, { brief: "The coach's words." });
    await fix(ctx, lift, "dose", DOSE_FIX);
    await retarget(ctx, krId);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    await db.update(programs).set({ brief: "The athlete's own words." }).where(eq(programs.id, p));
    await updateObjective(db, userId, objectiveId, { keyResults: [{ id: krId, ...WALL_SIT, target: 100 }] }, NOW);

    const answers = await approveAll(id, (await opsOf(id)).map((o) => o.id!));
    expect(answers).toHaveLength(1);
    expect(answers[0]!.json.refused.map((r: { opId: string; error: string }) => [r.opId, r.error])).toEqual([
      [planChangeId(p), "stale"],
      [goalIdOf(krId), "stale"],
    ]);
    expect(answers[0]!.json.corrected.map((x: { opId: string }) => x.opId)).toEqual([fixIdOf(lift, "dose")]);
    expect(answers[0]!.json.status).toBe("partially_approved");
    expect((await planRow(p)).brief).toBe("The athlete's own words.");
    expect(await versionsOf(p)).toEqual([]);
    expect(await receipts()).toEqual([expect.stringContaining("not approved:")]);
  });
});

describe("a pause beside corrections and an objective change, at its dearest pass", () => {
  it("the pause and its pass first; an objective change fits the three left; the corrections wait for the next request", async () => {
    const { p, session } = await courseWithCopy();
    const { lift } = await savedLift();
    const { objectiveId, krId } = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await change(ctx, p, { pausedUntil: addDays(MON, 3) });
    for (const [field, after] of FIXES.slice(0, 2)) await fix(ctx, lift, field, after);
    await retarget(ctx, krId);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);

    const answers = await approveAll(id, (await opsOf(id)).map((o) => o.id!));
    // MEASURED: 39 is the pause alone at its dearest (course-pause-request.test.ts): the objective change's on it.
    expect(answers.map((a) => a.total)).toEqual([41, 15]);
    expect(answers[0]!.json.planned.map((x: { opId: string }) => x.opId)).toEqual([planChangeId(p)]);
    expect(answers[0]!.json.objectives.map((x: { opId: string }) => x.opId)).toEqual([goalIdOf(krId)]);
    expect(answers[0]!.json.corrected ?? []).toEqual([]);
    expect(answers[0]!.json.remaining).toEqual([fixIdOf(lift, "dose"), fixIdOf(lift, "summary")]);
    expect(answers[1]!.json.corrected).toHaveLength(2);
    expect(answers[1]!.json).toMatchObject({ status: "approved", remaining: [] });
    expect((await planRow(p)).pausedUntil).toBe(addDays(MON, 3));
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, session)))[0]!.archivedAt).toBe(NOW);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(90);
    expect(await versionsOf(p)).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
    expect((await receipts())[0]).toContain("paused until");
  });

  it("a pause with nothing to take costs what it spends: what's beside it runs in the same request", async () => {
    const p = newId();
    await db.insert(programs).values({
      id: p, userId, kind: "course", name: "Evening practice", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
      config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [3], time: "18:15", placementWeeksAhead: 1 }), onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    const { lift } = await savedLift();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await change(ctx, p, { pausedUntil: addDays(MON, 1) });
    for (const [field, after] of FIXES.slice(0, 3)) await fix(ctx, lift, field, after);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    const answers = await approveAll(id, (await opsOf(id)).map((o) => o.id!));
    expect(answers.map((a) => a.total)).toEqual([34]);
    expect(answers[0]!.json).toMatchObject({ status: "approved", remaining: [] });
    expect(answers[0]!.json.corrected).toHaveLength(3);
  });

  it("the fullest request: a pause that takes an outline, three objective changes, three corrections and the pins — what doesn't fit its declared cost waits", async () => {
    const p = newId();
    await db.insert(programs).values({
      id: p, userId, kind: "course", name: "Evening practice", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
      config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "18:15", placementWeeksAhead: 1 }), onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    await placeSlots(db, userId, p, MON, prefs, NOW);
    const { batchId, lift } = await savedLift();
    const a = await wallSit();
    const b = await wallSit();
    const c = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await change(ctx, p, { pausedUntil: addDays(MON, 3) });
    for (const g of [a, b, c]) await retarget(ctx, g.krId);
    await act(ctx, "pin_moves", { batchId, pin: [lift], title: "One in", why: "The lift fills the hip work.", lines: [{ moveId: lift, text: "It serves hip mobility.", cites: ["history"] }] });
    for (const [field, after] of FIXES.slice(0, 3)) await fix(ctx, lift, field, after);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    const answers = await approveAll(id, (await opsOf(id)).map((o) => o.id!));
    // MEASURED: the first request holds the pause and its pass, the objectives and the corrections its declared room fits;
    // the last correction and the pins wait.
    expect(answers.map((x) => x.total)).toEqual([40, 17]);
    expect(answers[0]!.json.planned.map((x: { opId: string }) => x.opId)).toEqual([planChangeId(p)]);
    expect(answers[0]!.json.objectives).toHaveLength(3);
    expect(answers.map((x) => (x.json.corrected ?? []).length)).toEqual([2, 1]);
    expect(answers[0]!.json.pinned ?? []).toEqual([]);
    expect(answers.at(-1)!.json).toMatchObject({ status: "approved", remaining: [] });
    expect(answers.at(-1)!.json.pinned).toHaveLength(1);
    expect(await db.select().from(importCorrections).where(eq(importCorrections.userId, userId))).toHaveLength(3);
    expect(await versionsOf(p)).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
  });
});

describe("a whole plan with a plan change, corrections and an objective change", () => {
  it("the plan, then its change, then the rest: each once, the plan change never ahead of the plan", async () => {
    const p = await plan();
    const { lift } = await savedLift();
    const { objectiveId, krId } = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await block(ctx);
    await change(ctx, p, { brief: "Base block, then the build." });
    await fix(ctx, lift, "dose", DOSE_FIX);
    await retarget(ctx, krId);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    const ops = (await opsOf(id)).map((o) => o.id!);
    // One card the plan's, naming the plan change that rides it; the others their own.
    const answers = await approveAll(id, ops);
    expect(answers.map((a) => a.total)).toEqual([37]);
    expect(answers[0]!.json.planned.map((x: { opId: string }) => x.opId)).toEqual([PLAN_STRUCTURE_ID, planChangeId(p)]);
    expect(answers.at(-1)!.json).toMatchObject({ status: "approved", remaining: [], refused: [] });
    expect((await planRow(p)).brief).toBe("Base block, then the build.");
    expect(await versionsOf(p)).toHaveLength(1);
    expect(await db.select().from(importCorrections).where(eq(importCorrections.userId, userId))).toHaveLength(1);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(90);
    expect(await receipts()).toHaveLength(1);
  });

  it("the plan's cards name what the card's words say: one card for the plan and its change, one each for the corrections and the objectives", async () => {
    const p = await plan();
    const { lift } = await savedLift();
    const { krId } = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await block(ctx);
    await change(ctx, p, { brief: "Base block, then the build." });
    await fix(ctx, lift, "dose", DOSE_FIX);
    await retarget(ctx, krId);
    const stored = await opsOf(designProposalId(ctx.run.id));
    const brief = stored.map((o) => ({
      kind: o.kind as "plan_structure",
      date: null, time: null, atNow: null, title: null, minutes: null, effort: null, by: null, change: null, row: null, outcome: null, reason: null,
      planTitle: (o as { title?: string }).title ?? null,
      planSummary: (o as { summary?: string }).summary ?? null,
      lines: (o as { lines?: unknown }).lines ?? null,
      opId: o.id ?? null,
      fixLine: (o as { line?: string }).line ?? null,
    }));
    const cards = cardsOf(null, { id: designProposalId(ctx.run.id), title: "t", status: "pending", ops: brief }, MON);
    expect(cards.map((c) => c.kind)).toEqual(["plan", "corrections", "objectives"]);
    expect(cards[0]!.opIds).toEqual([PLAN_STRUCTURE_ID, planChangeId(p)]);
    expect(cards[0]!.lines!.at(-1)).toBe("Brief: Base block, then the build.");
  });

  it("a pause and corrections beside seven sessions: no request goes over, the pause after the plan, the corrections after the pause", async () => {
    const { p, session } = await courseWithCopy();
    const { lift } = await savedLift();
    const { krId } = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await block(ctx, 7);
    await change(ctx, p, { pausedUntil: addDays(MON, 3) });
    await fix(ctx, lift, "dose", DOSE_FIX);
    await retarget(ctx, krId);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    const answers = await approveAll(id, (await opsOf(id)).map((o) => o.id!));
    expect(answers.map((a) => a.total)).toEqual([35, 26, 41, 12]);
    const when = (opId: string) => answers.findIndex((a) => [...(a.json.planned ?? []), ...(a.json.corrected ?? []), ...(a.json.objectives ?? [])].some((x: { opId: string }) => x.opId === opId));
    expect(when(PLAN_STRUCTURE_ID)).toBeLessThanOrEqual(when(planChangeId(p)));
    expect(when(planChangeId(p))).toBeLessThanOrEqual(when(fixIdOf(lift, "dose")));
    // Every request before the plan change's leaves its version unwritten.
    for (const a of answers.slice(0, when(planChangeId(p)))) expect(a.seen.filter((s) => /^insert into "program_versions"/.test(s))).toEqual([]);
    expect(answers.at(-1)!.json).toMatchObject({ status: "approved", remaining: [] });
    expect((await planRow(p)).pausedUntil).toBe(addDays(MON, 3));
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, session)))[0]!.archivedAt).toBe(NOW);
    expect(await versionsOf(p)).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
  });

  it("the plan refused (Task 6's rule): its change is refused in words, nothing of it written — the corrections and the objective change still land", async () => {
    const p = await plan();
    const { lift } = await savedLift();
    const { objectiveId, krId } = await wallSit();
    const blockId = `cp-${newId()}`;
    await db.insert(schema.coachPlans).values({
      id: blockId, userId, name: "Old block", goal: "general", discipline: "run", startDate: MON, endDate: addDays(MON, 27), raceDate: null, status: "active", stampPrefix: "T", createdAt: NOW, updatedAt: NOW,
    } as never);
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await act(ctx, "propose_plan", { change: { kind: "extendPlan", planId: blockId, shapeWeeks: [{ weekStart: mondayOf(addDays(MON, 28)), volumeTarget: "x", keySessions: [] }] }, why: "More of it." });
    await change(ctx, p, { brief: "Base block, then the build." });
    await fix(ctx, lift, "dose", DOSE_FIX);
    await retarget(ctx, krId);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    await db.delete(schema.coachPlans).where(eq(schema.coachPlans.id, blockId));

    const answers = await approveAll(id, (await opsOf(id)).map((o) => o.id!));
    expect(answers).toHaveLength(1);
    const refused = answers[0]!.json.refused as Array<{ opId: string; error: string; why: string }>;
    expect(refused.map((r) => [r.opId, r.error])).toEqual([[PLAN_STRUCTURE_ID, "plan_refused"], [planChangeId(p), "plan_refused"]]);
    expect(refused[1]!.why).toBe(PLAN_NOT_ADDED);
    expect((await planRow(p)).brief).toBe("Base block.");
    expect(await versionsOf(p)).toEqual([]);
    expect(answers[0]!.json.corrected).toHaveLength(1);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(90);
    expect(answers[0]!.json.status).toBe("partially_approved");
  });

  it("nine corrections ahead of the plan change and the plan, past one plan read's ten ops: the change waits for the plan, never refused", async () => {
    const p = await plan();
    const { lift, post } = await savedLift();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    for (const [field, after] of FIXES) await fix(ctx, lift, field, after);
    await act(ctx, "correct_import", { target: "reading", targetId: `${post}:0`, field: "why", after: "Long runs.", why: "The transcript says so.", basis: "evidence", cites: ["history"] });
    await change(ctx, p, { brief: "Base block, then the build." });
    await block(ctx);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    expect((await opsOf(id)).map((o) => o.kind).slice(-2)).toEqual(["plan_change", "plan_structure"]);

    const answers = await approveAll(id);
    for (const a of answers) expect((a.json.refused as unknown[]) ?? []).toEqual([]);
    expect(answers.at(-1)!.json).toMatchObject({ status: "approved", remaining: [] });
    expect((await planRow(p)).brief).toBe("Base block, then the build.");
    expect(await db.select().from(importCorrections).where(eq(importCorrections.userId, userId))).toHaveLength(9);
  });
});

describe("a retried approve", () => {
  it("a request that dies at the objectives' claim, its plan change written: the retry writes no second version, and lands the rest once", async () => {
    const p = await plan();
    const { lift } = await savedLift();
    const { objectiveId, krId } = await wallSit();
    const ctx = await mainRun();
    await readSavesInRun(db, ctx);
    await change(ctx, p, { brief: "Base block, then the build." });
    await fix(ctx, lift, "dose", DOSE_FIX);
    await retarget(ctx, krId);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    const ops = (await opsOf(id)).map((o) => o.id!);

    watch = (q) => {
      if (/^update "coach_proposals"/i.test(q.trim()) && statements.some((s) => /^insert into "program_versions"/.test(s))) throw new Error("the request died");
    };
    const died = await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: ops });
    watch = null;
    expect(died.status).toBeGreaterThanOrEqual(500);
    expect((await planRow(p)).brief).toBe("Base block, then the build.");
    expect(await versionsOf(p)).toHaveLength(1);
    expect((await opsOf(id)).every((o) => o.outcome === undefined)).toBe(true);

    const answers = await approveAll(id, ops);
    expect(answers[0]!.json).toMatchObject({ status: "approved", remaining: [], refused: [] });
    expect(await versionsOf(p)).toHaveLength(1);
    expect((await opsOf(id)).find((o) => o.id === planChangeId(p))!.outcome).toMatchObject({ status: "applied", changed: [] });
    expect(await db.select().from(importCorrections).where(eq(importCorrections.userId, userId))).toHaveLength(1);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(90);
    expect(await receipts()).toHaveLength(1);
  });

  it("an objective change already being applied by another approve is in flight, and what was named beside it still answers 200", async () => {
    const { objectiveId, krId } = await wallSit();
    const other = await createObjective(db, userId, { title: "Second", keyResults: [WALL_SIT] }, NOW);
    const ctx = await mainRun();
    await retarget(ctx, krId);
    await retarget(ctx, other.keyResults[0]!.id, 80);
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    const ops = (await opsOf(id)) as Array<Record<string, unknown>>;
    await db.update(coachProposals).set({ ops: ops.map((o) => (o.id === goalIdOf(krId) ? { ...o, outcome: { status: "applying", at: NOW } } : o)) }).where(eq(coachProposals.id, id));
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: ops.map((o) => o.id as string) });
    // An objective changed is an answer of its own: never the 409 that says nothing else was named.
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.inFlight).toEqual([goalIdOf(krId)]);
    expect(res.json.objectives.map((x: { opId: string }) => x.opId)).toEqual([goalIdOf(other.keyResults[0]!.id)]);
    expect((await getObjective(db, userId, objectiveId)).keyResults[0]!.target).toBe(120);
  });
});

describe("a plan's linked objective, retired or gone", () => {
  /** A plan linked to a live objective, one done and one that is no more. */
  async function linked() {
    const live = await createObjective(db, userId, { title: "Live", keyResults: [WALL_SIT] }, NOW);
    const done = await createObjective(db, userId, { title: "Done", keyResults: [WALL_SIT] }, NOW);
    await db.update(objectives).set({ status: "done" }).where(eq(objectives.id, done.id));
    // The account's own programme: read_plans lists it by its row.
    const [programme] = await db.select().from(programs).where(eq(programs.userId, userId));
    await db.update(programs).set({ objectiveIds: [live.id, done.id, "gone-objective"] }).where(eq(programs.id, programme!.id));
    return { p: programme!.id, live: live.id, done: done.id };
  }
  const readPlans = async (ctx: ToolContext) => {
    const r = await READ_TOOLS.find((t) => t.name === "read_plans")!.run(ctx, {});
    if (isToolErr(r)) throw new Error(r.why);
    return r.data as { plans: Array<{ planId: string | null; objectiveIds: string[] }>; lines?: unknown };
  };

  it("read_plans says only the objectives it still serves: never one done or gone, and never throws", async () => {
    const { p, live } = await linked();
    const data = await readPlans(await mainRun());
    const row = JSON.stringify(data);
    expect(row).toContain(`"objectiveIds":["${live}"],"planId":"${p}"`);
    expect(row).not.toContain("gone-objective");
  });

  it("an objective_change retiring what a plan links: approved, the plan's next read leaves it out", async () => {
    const o = await createObjective(db, userId, { title: "Strong legs", keyResults: [WALL_SIT] }, NOW);
    const [programme] = await db.select().from(programs).where(eq(programs.userId, userId));
    const p = programme!.id;
    await db.update(programs).set({ objectiveIds: [o.id] }).where(eq(programs.id, p));
    const ctx = await mainRun();
    await act(ctx, "propose_objective", { change: "retire", objectiveId: o.id, status: "done", why: "You told me it's done: 120 s of 120 s.", basis: "stand" });
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    await approveAll(id, (await opsOf(id)).map((x) => x.id!));
    expect((await getObjective(db, userId, o.id)).status).toBe("done");
    expect(JSON.stringify(await readPlans(await mainRun()))).not.toContain(o.id);
    // The plan itself is untouched: its link stays where it was written, and says nothing false anywhere.
    expect((await planRow(p)).objectiveIds).toEqual([o.id]);
  });

  it("where you stand never joins the two: its plan line is the plan's name and purpose, whatever the link", async () => {
    const { done } = await linked();
    const facts = await readStandFacts(db, userId, { today: MON, tz: prefs.timezone });
    const stand = standBlock(facts, driftsOf(facts));
    expect(stand).toMatch(/Plans \(read_plans has each one's brief and ending\):\n- .*: no purpose set yet/);
    expect(stand).not.toContain("gone-objective");
    expect(stand).not.toContain(done);
  });

  it("change_plan links only what the plan can serve: done or dropped refused in words, none of the athlete's refused", async () => {
    const { p, live, done } = await linked();
    const ctx = await mainRun();
    const refused = await ACT_TOOLS.find((t) => t.name === "change_plan")!.run(ctx, { planId: p, objectiveIds: [live, done], why: "You asked." });
    expect(isToolErr(refused) ? refused.why : "").toContain(`${JSON.stringify(done)} is done`);
    const none = await ACT_TOOLS.find((t) => t.name === "change_plan")!.run(ctx, { planId: p, objectiveIds: ["gone-objective"], why: "You asked." });
    expect(isToolErr(none) ? none.why : "").toContain("is none of the athlete's objectives");
    // Dropping the dead links is a change it can make.
    await change(ctx, p, { objectiveIds: [live] });
    await pending(ctx);
    const id = designProposalId(ctx.run.id);
    await approveAll(id);
    expect((await planRow(p)).objectiveIds).toEqual([live]);
  });

  it("a key result gone from a linked objective changes nothing about the link", async () => {
    const { p, live } = await linked();
    await db.delete(keyResults).where(eq(keyResults.objectiveId, live));
    const data = JSON.stringify(await readPlans(await mainRun()));
    expect(data).toContain(`"objectiveIds":["${live}"],"planId":"${p}"`);
  });
});

describe("the readers that switch over the kinds", () => {
  const op = (o: Record<string, unknown>) => ({ date: "2026-10-01", toolUseId: "t", at: NOW, why: "w", ...o });

  it("a stop's past-day line names a correction and an objective change, never a TypeError", () => {
    const line = pastDayLine([
      op({ kind: "import_correction", id: "f", name: "Zorbex hip lift", line: "Dose: 30 s" }) as never,
      op({ kind: "objective_change", id: "g", title: "Strong legs", line: "x" }) as never,
      op({ kind: "plan_change", id: "h", title: "Base block: new brief" }) as never,
    ]);
    expect(line).toBe("Its day passed before it could be suggested, so left out: “Zorbex hip lift” (Thu 1 Oct), “Strong legs” (Thu 1 Oct), “Base block: new brief” (Thu 1 Oct).");
  });

  it("the thread's dossier says what a designed proposal holds, never “0 changes” for corrections or objectives alone", () => {
    expect(designedWords([op({ kind: "import_correction", id: "f" }), op({ kind: "import_correction", id: "f2" })])).toBe("a designed proposal: 2 corrections to the saves");
    expect(designedWords([op({ kind: "objective_change", id: "g" })])).toBe("a designed proposal: 1 change to the objectives");
    expect(designedWords([op({ kind: "move_pins", id: "p" }), op({ kind: "import_correction", id: "f" })])).toBe("a designed proposal: a change to the engine's pool (pins) and 1 correction to the saves");
    expect(designedWords([op({ kind: "plan_change", id: "h", title: "Base block: new brief" })])).toBe("a plan change: Base block: new brief");
  });

  it("a follow-up's replaces never takes a correction or an objective change with the one workout beside it", async () => {
    const { lift } = await savedLift();
    const { krId } = await wallSit();
    const first = await mainRun();
    await readSavesInRun(db, first);
    const made = await proposeWorkout.run(first, { doc: calmDoc({ title: "Hips, gently" }), target: { kind: "new", date: addDays(MON, 2) } });
    if (isToolErr(made)) throw new Error(made.why);
    await fix(first, lift, "dose", DOSE_FIX);
    await pending(first);
    const second = await mainRun();
    await retarget(second, krId);
    const again = await proposeWorkout.run(second, { doc: calmDoc({ title: "Hips, calmer" }), target: { kind: "new", date: addDays(MON, 2) }, replaces: designProposalId(first.run.id) });
    expect(isToolErr(again) ? `${again.error}: ${again.why}` : "").toMatch(/^replaces_not_open: .*isn't one workout alone/);
  });
});
