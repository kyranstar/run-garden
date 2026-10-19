/**
 * A PROGRAMME'S SETTINGS, CHANGED BY THE COACH (§8 §5, stream W): change_programme stores one `programme_change` op —
 * only the settings it changes, what they were, the card's words — checked as the settings sheet's save is; the approve
 * route applies it as that save is (`updateProgram`, then its sessions placed a request's room at a time), every request
 * within 45 statements and fetches, its waitUntil work included; done and past sessions untouched; a change the athlete
 * overtook in the sheet refused `stale`; and every reader of designed proposals tolerates the kind — the conversation's
 * card and block, read_proposals, the cover rule, the proposal's title and expiry, decline and the expiry sweep, read_plans'
 * settings. A Wednesday morning in UTC (Date faked). Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { PROFILES } from "@rg/exercise-library";
import { adaptiveConfigSchema, newId, type AdaptiveConfig } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes, sweepExpiredProposals } from "../src/routes/coach.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import { conversationBlock, conversationRows, namedConversationSql, readConversation } from "../src/services/coach-conversation.js";
import { endedLine } from "../src/services/coach-runs.js";
import { markUntrusted } from "../src/services/design-prompt.js";
import {
  APPLYING_STALE_MS,
  approveDesignOps,
  PROGRAMME_CHANGE_FIXED,
  PROGRAMME_MIN_BUDGET,
  PROGRAMME_WRITE_COST,
  REQUEST_BUDGET,
  type DesignedProgrammeOp,
} from "../src/services/design-approve.js";
import { supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { proposalFields } from "../src/services/design-review.js";
import { changeProgramme, dayIndex, nextLine, programmeTitle, settingLines } from "../src/services/design-tools/change-programme.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { readPlans } from "../src/services/design-tools/read-plans.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { currentRun } from "../src/services/coach-runs.js";
import { readProposals } from "../src/services/design-tools/read-proposals.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { placeSlots, placeSlotsWithin } from "../src/services/program-slots.js";
import { updateProgram } from "../src/services/programs.js";
import { programmeChangeId } from "../src/services/proposal-kinds.js";
import { cloneTestDb, makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";

const { coachProposals, coachMessages, coachRuns, plannedWorkouts, programs, userConditions } = schema;
/** A Wednesday morning in UTC: this week's Monday has gone, today's session stands. */
const NOW = new Date("2026-10-14T08:00:00.000Z");
const TODAY = "2026-10-14";

function makeEnv(): Env {
  return {
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
    AI_GATEWAY_API_KEY: "test-key",
    COACH_DESIGNER: "1",
  } as Env;
}

let db: Db;
let userId: string;
let cookie: string;
let statements = 0;
let fetches = 0;
let counting = true;
/** A test's own look at each statement's SQL, while it is set. */
let watch: ((sql: string) => unknown) | null = null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  statements = 0;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (q) => {
      if (counting) statements += 1;
      watch?.(q);
    },
  });
  const made = await makeTestUser(db, { timezone: "UTC" });
  userId = made.userId;
  await savePreferences(db, userId, { ...made.prefs, timezone: "UTC" });
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => {
    fetches += 1;
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** An adaptive programme placed from this Monday (Monday's session done) at `ahead` weeks. */
async function programme(o: { goal: number; days: number[]; ahead?: number; name?: string; owner?: string; status?: "active" | "retired" }): Promise<string> {
  const owner = o.owner ?? userId;
  const id = newId();
  await db.insert(programs).values({
    id, userId: owner, kind: "adaptive", name: o.name ?? "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null,
    raceDate: null, source: null, config: adaptiveConfigSchema.parse({ weeklyGoal: o.goal, preferredDays: o.days, placementWeeksAhead: o.ahead ?? 2 }),
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), archivedAt: null,
  });
  await placeSlots(db, owner, id, "2026-10-12", await loadPreferences(db, owner), "2026-10-12T05:00:00.000Z");
  for (const r of await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, id))) {
    if (r.effectiveDate < TODAY) await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, r.id));
  }
  if (o.status === "retired") await db.update(programs).set({ status: "retired" }).where(eq(programs.id, id));
  return id;
}

/** A main run and its tool context. */
async function mainRun(): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Move my mobility programme to Tuesdays and Thursdays", status: "active",
    state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { db, env: makeEnv(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
}

async function change(ctx: ToolContext, input: Record<string, unknown>): Promise<{ res: ToolOk | ToolErr; count: number }> {
  statements = 0;
  const res = await changeProgramme.run(ctx, { why: "Your Mondays are full now.", ...input });
  return { res, count: statements };
}

const ok = (r: ToolOk | ToolErr): ToolOk => {
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return r;
};

const proposalOf = async (id: string) => (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
const opOf = async (id: string, programId: string) =>
  ((await proposalOf(id)).ops as unknown[]).find((o) => (o as { id?: string }).id === programmeChangeId(programId)) as DesignedProgrammeOp;

/** A change proposed and made pending, as the finish makes it. */
async function proposed(programId: string, input: Record<string, unknown>): Promise<{ id: string; ctx: ToolContext }> {
  const ctx = await mainRun();
  ok((await change(ctx, { programmeId: programId, ...input })).res);
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
  return { id: designProposalId(ctx.run.id), ctx };
}

async function invoke(method: string, path: string, body?: unknown) {
  const app = mountRoutes(db, "/api/coach", coachRoutes);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await app.request(
    path,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    makeEnv(),
    executionCtx as never,
  );
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, total: statements + fetches };
}

/** Approve until nothing remains: each request's answer and cost. */
async function approveAll(id: string, opIds?: string[]) {
  const answers: Array<Record<string, any>> = [];
  const costs: number[] = [];
  let remaining: string[] | null = opIds ?? null;
  for (let i = 0; ; i++) {
    if (i >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
    const res = await invoke("POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    answers.push(res.json);
    costs.push(res.total);
    remaining = res.json.remaining as string[];
    if (remaining.length === 0) break;
  }
  return { answers, costs };
}

/** The programme's live sessions: day and state. */
async function live(programId: string): Promise<string[]> {
  const rows = await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.planId, programId), isNull(plannedWorkouts.archivedAt)));
  return rows.map((r) => `${r.effectiveDate}:${r.completionState}`).sort();
}
const configOf = async (programId: string): Promise<AdaptiveConfig> => adaptiveConfigSchema.parse((await db.select().from(programs).where(eq(programs.id, programId)))[0]!.config);

describe("change_programme: one change to a programme's settings, as the sheet checks it", () => {
  it("stores only what changes, what it was, and the card's words: days in week order, where the next sessions go — in four statements", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const ctx = await mainRun();
    const { res, count } = await change(ctx, { programmeId: p, days: ["thursday", "Tue"] });
    const stored = ok(res);
    expect(count).toBeLessThanOrEqual(changeProgramme.statementCost);
    expect(changeProgramme.statementCost).toBe(4);
    expect(stored.data).toMatchObject({ stored: true, opId: programmeChangeId(p), programmeId: p });
    const op = await opOf(designProposalId(ctx.run.id), p);
    expect(op).toMatchObject({
      kind: "programme_change",
      programId: p,
      change: { preferredDays: [1, 3] },
      base: { preferredDays: [0, 2] },
      title: "Mobility: new days",
      summary: "Tue · Thu · 2 a week · 30 min",
      date: TODAY,
      issues: [],
    });
    // Today's session stays (it is today's); the weeks after move from Mon and Wed to Tue and Thu.
    expect(op.lines).toEqual(["Days Mon · Wed → Tue · Thu", "Next sessions move to Wed 14 Oct · Tue 20 Oct · Thu 22 Oct"]);
    // Nothing on the plan moved yet.
    expect(await live(p)).toEqual(["2026-10-12:completed", "2026-10-14:scheduled", "2026-10-19:scheduled", "2026-10-21:scheduled", "2026-10-26:scheduled", "2026-10-28:scheduled"]);
    expect((await configOf(p)).preferredDays).toEqual([0, 2]);
  });

  it("goal, minutes, block length, modes and care each say their line; fewer days than sessions is a note", async () => {
    const caring = Object.values(PROFILES).find((x) => x.care)!;
    await db.insert(userConditions).values({ id: `${userId}:${caring.id}`, userId, profileId: caring.id, active: true, since: "2026-09-01", settings: {} });
    const p = await programme({ goal: 2, days: [0, 2] });
    await db.update(programs).set({ config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 2], careProfiles: [caring.id], placementWeeksAhead: 2 }) }).where(eq(programs.id, p));
    const ctx = await mainRun();
    ok((await change(ctx, { programmeId: p, weeklyGoal: 3, minutes: 20, blockWeeks: 4, modes: ["build", "recovery"], care: { [caring.id]: false } })).res);
    const op = await opOf(designProposalId(ctx.run.id), p);
    expect(op.change).toEqual({ weeklyGoal: 3, defaultMinutes: 20, blockWeeks: 4, modes: ["recovery", "build"], careProfiles: [] });
    expect(op.title).toBe("Mobility: new settings");
    expect(op.lines.slice(0, 5)).toEqual([
      "Weekly goal 2 → 3 sessions",
      "Minutes 30 → 20",
      "Block length 5 → 4 weeks",
      "Modes Recovery · Consistent · Build → Recovery · Build",
      `${caring.care!.block.label} on → off`,
    ]);
    expect(op.issues).toEqual([{ code: "days_short", message: "2 days for 3 sessions a week: the rest go on the week's other days" }]);
  });

  it("refuses, in words, what the sheet would refuse — and a programme that isn't the athlete's, a retired one, settings it has", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const retired = await programme({ goal: 2, days: [0, 2], status: "retired" });
    const other = (await makeTestUser(db, { timezone: "UTC" })).userId;
    const theirs = await programme({ goal: 2, days: [0, 2], owner: other });
    const ctx = await mainRun();
    const refusal = async (input: Record<string, unknown>) => {
      const { res } = await change(ctx, input);
      if (!isToolErr(res)) throw new Error("stored");
      return `${res.error}: ${res.why}`;
    };
    expect(await refusal({ programmeId: p })).toMatch(/^invalid_input: No setting to change/);
    expect(await refusal({ programmeId: p, days: ["Tue", "Funday"] })).toContain(`days: "Funday" isn't a day`);
    expect(await refusal({ programmeId: p, days: ["Tue", "tuesday"] })).toContain("a day is named twice");
    expect(await refusal({ programmeId: p, weeklyGoal: 9 })).toContain("weeklyGoal: 1 to 7");
    expect(await refusal({ programmeId: p, minutes: 5 })).toContain("minutes: 10 to 90");
    expect(await refusal({ programmeId: p, blockWeeks: 8 })).toContain("blockWeeks: 4 to 6");
    expect(await refusal({ programmeId: p, modes: [] })).toContain("modes: at least one");
    expect(await refusal({ programmeId: p, care: { "no-such-profile": true } })).toMatch(/^invalid_input: care: "no-such-profile" isn't a switched-on condition/);
    expect(await refusal({ programmeId: theirs, days: ["Tue"] })).toMatch(/^not_your_programme/);
    expect(await refusal({ programmeId: retired, days: ["Tue"] })).toMatch(/^not_running: Mobility is retired/);
    expect(await refusal({ programmeId: p, days: ["Wed", "Mon"], weeklyGoal: 2 })).toBe("no_change: Mobility already has Mon · Wed · 2 a week · 30 min.");
    // A designer's run may not.
    const designer: ToolContext = { ...ctx, run: { ...ctx.run, role: "designer", parentId: ctx.run.id } };
    const d = await changeProgramme.run(designer, { programmeId: p, days: ["Tue"], why: "x" });
    expect(isToolErr(d) && d.error).toBe("not_for_role");
    // Nothing was stored by any of them.
    expect(await db.select().from(coachProposals)).toEqual([]);
  });

  it("a second call for the programme replaces the first; a replay of a call answers what it stored; another programme's is its own op", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const q = await programme({ goal: 1, days: [5], name: "Strength" });
    const ctx = await mainRun();
    const first = { ...ctx, toolUseId: "toolu_first" };
    ok((await change(first, { programmeId: p, days: ["Tue", "Thu"] })).res);
    ok((await change({ ...ctx, toolUseId: "toolu_second" }, { programmeId: p, days: ["Tue", "Fri"] })).res);
    ok((await change({ ...ctx, toolUseId: "toolu_third" }, { programmeId: q, weeklyGoal: 2 })).res);
    const ops = (await proposalOf(designProposalId(ctx.run.id))).ops as DesignedProgrammeOp[];
    expect(ops.map((o) => [o.id, o.change])).toEqual([
      [programmeChangeId(p), { preferredDays: [1, 4] }],
      [programmeChangeId(q), { weeklyGoal: 2 }],
    ]);
    expect(ops[0]!.replaces).toEqual(["toolu_first"]);
    const replay = ok((await change(first, { programmeId: p, days: ["Tue", "Thu"] })).res);
    expect(replay.data).toMatchObject({ superseded: true });
    expect((await proposalOf(designProposalId(ctx.run.id))).title).toBe("Mobility: new days · Strength: new goal");
  });

  it("the words, unit by unit: a day's names, the lines, the title", () => {
    expect(["Mon", "tues", "Weds", "thurs", "Fri", "sat", "SUNDAY", "tu", "th"].map(dayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 1, 3]);
    expect(["t", "s", "", "Funday", "x1"].map(dayIndex)).toEqual([null, null, null, null, null]);
    const base = { weeklyGoal: 3, preferredDays: [0, 2, 4], defaultMinutes: 30, blockWeeks: 5, modes: ["recovery", "consistent", "build"] as AdaptiveConfig["modes"], careProfiles: ["a"] };
    expect(settingLines(base, { ...base, preferredDays: [] }, (id) => id)).toEqual(["Days Mon · Wed · Fri → any day"]);
    expect(settingLines(base, { ...base, weeklyGoal: 1, careProfiles: ["b"] }, (id) => `${id} care`)).toEqual(["Weekly goal 3 → 1 session", "a care on → off", "b care off → on"]);
    expect(nextLine(["2026-10-19", "2026-10-21"], ["2026-10-19", "2026-10-21"])).toBeNull();
    expect(nextLine([], ["2026-10-20"])).toBe("Next sessions Tue 20 Oct");
    expect(nextLine(["2026-10-19"], [])).toBeNull();
    // In the settings sheet's order: sessions a week, then days.
    expect(programmeTitle("Mobility", ["preferredDays", "weeklyGoal"])).toBe("Mobility: new goal and days");
    expect(programmeTitle("Mobility", ["defaultMinutes"])).toBe("Mobility: new length");
  });
});

describe("approving a programme change", () => {
  it("writes the settings once and moves its sessions a request's room at a time — each within 45, done and today's untouched, the receipt once", async () => {
    const p = await programme({ goal: 2, days: [0, 2], ahead: 4 });
    const { id } = await proposed(p, { days: ["Tue", "Thu"] });
    const writes: string[] = [];
    watch = (q) => /^update "programs"/i.test(q) && writes.push(q);
    const { answers, costs } = await approveAll(id);
    watch = null;
    for (const cost of costs) expect(cost, costs.join(", ")).toBeLessThanOrEqual(REQUEST_BUDGET);
    // Measured, statements and fetches a request: the settings written in the first, then a request's room of placing.
    expect(costs).toEqual([32, 36, 36, 20]);
    // The settings written once, whatever the requests.
    expect(writes).toHaveLength(1);
    expect(answers.length).toBeGreaterThan(1);
    for (const a of answers.slice(0, -1)) expect(a.remaining).toEqual([programmeChangeId(p)]);
    const last = answers.at(-1)!;
    expect(last.status).toBe("approved");
    expect(last.planned).toEqual([{ opId: programmeChangeId(p), summary: "Tue · Thu · 2 a week · 30 min — 8 sessions placed again" }]);
    expect((await configOf(p)).preferredDays).toEqual([1, 3]);
    expect(await live(p)).toEqual([
      "2026-10-12:completed",
      "2026-10-14:scheduled",
      ...["2026-10-20", "2026-10-22", "2026-10-27", "2026-10-29", "2026-11-03", "2026-11-05", "2026-11-10", "2026-11-12"].map((d) => `${d}:scheduled`),
    ]);
    expect((await opOf(id, p)).outcome).toMatchObject({ status: "applied", placed: 8, archived: 8 });
    const receipts = await db.select().from(coachMessages).where(and(eq(coachMessages.userId, userId), eq(coachMessages.role, "receipt")));
    // Named once: the proposal is named by the change, so the receipt says only what it set.
    expect(receipts.map((r) => r.body)).toEqual(["✓ approved — Mobility: new days: Tue · Thu · 2 a week · 30 min — 8 sessions placed again"]);
    // Asked again: settled, nothing more written.
    const again = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(again.json).toMatchObject({ status: "approved", settled: [{ opId: programmeChangeId(p), outcome: "applied" }], remaining: [] });
  });

  for (const [label, o, input, expected] of [
    ["six a week at four weeks ahead, onto other days", { goal: 6, days: [0, 1, 2, 3, 4, 5] }, { days: ["Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] }, [32, 36]],
    ["days and goal at four weeks ahead", { goal: 4, days: [0, 1, 3, 5] }, { days: ["Wed", "Fri", "Sat", "Sun"], weeklyGoal: 3 }, [32, 36, 36, 36, 36, 21]],
  ] as Array<[string, { goal: number; days: number[] }, Record<string, unknown>, number[]]>) {
    it(`${label}: every request within 45 statements and fetches, its waitUntil work included`, async () => {
      const p = await programme({ ...o, ahead: 4 });
      const kept = (await live(p)).filter((d) => d <= `${TODAY}:~`);
      const { id } = await proposed(p, input);
      const { answers, costs } = await approveAll(id);
      for (const cost of costs) expect(cost, costs.join(", ")).toBeLessThanOrEqual(REQUEST_BUDGET);
      expect(costs).toEqual(expected);
      expect(answers.length).toBeGreaterThanOrEqual(2);
      expect(answers.at(-1)!.status).toBe("approved");
      // Done and today's stay where they were.
      expect(kept.length).toBeGreaterThan(1);
      expect((await live(p)).filter((d) => d <= `${TODAY}:~`)).toEqual(kept);
    });
  }

  it("beside a change to another session in the same suggestion: the change first, then the programme in the room left — every request within 45", async () => {
    const p = await programme({ goal: 6, days: [0, 1, 2, 3, 4, 5], ahead: 4 });
    const runId = "w-run-tomorrow";
    await db.insert(plannedWorkouts).values({
      id: runId, userId, planId: "plan-1", sourceWorkoutId: runId, title: "Easy run", category: "easy", sport: "run", originalPlanDate: "2026-10-15",
      lastVerifiedCorosDate: "", effectiveDate: "2026-10-15", effectiveTime: "07:00", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800,
      fallbackEstimatedDurationSeconds: 1800, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    const ctx = await mainRun();
    ok(await adjustPlan.run({ ...ctx, toolUseId: "toolu_skip" }, { workoutId: runId, change: { kind: "skip", reason: "Rest." }, why: "Heavy legs." }));
    ok((await change(ctx, { programmeId: p, days: ["Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] })).res);
    const id = designProposalId(ctx.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    const { answers, costs } = await approveAll(id);
    for (const cost of costs) expect(cost, costs.join(", ")).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(answers.at(-1)!.status).toBe("approved");
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, runId)))[0]!.completionState).toBe("skipped");
    expect((await configOf(p)).preferredDays).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("after a move that leaves less than its least room, it waits whole for the next request — unclaimed, nothing of it written", async () => {
    const p = await programme({ goal: 2, days: [0, 2], ahead: 4 });
    const runId = "w-run-tomorrow";
    await db.insert(plannedWorkouts).values({
      id: runId, userId, planId: "plan-1", sourceWorkoutId: runId, title: "Easy run", category: "easy", sport: "run", originalPlanDate: "2026-10-15",
      lastVerifiedCorosDate: "", effectiveDate: "2026-10-15", effectiveTime: "07:00", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800,
      fallbackEstimatedDurationSeconds: 1800, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    const ctx = await mainRun();
    ok(await adjustPlan.run({ ...ctx, toolUseId: "toolu_move" }, { workoutId: runId, change: { kind: "move", toDate: "2026-10-16" }, why: "A freer day." }));
    ok((await change(ctx, { programmeId: p, days: ["Tue", "Thu"] })).res);
    const id = designProposalId(ctx.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    const first = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(first.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(first.json.changed).toHaveLength(1);
    expect(first.json.remaining).toEqual([programmeChangeId(p)]);
    expect((await opOf(id, p)).outcome).toBeUndefined();
    expect((await configOf(p)).preferredDays).toEqual([0, 2]);
    const { answers, costs } = await approveAll(id, first.json.remaining as string[]);
    for (const cost of costs) expect(cost).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(answers.at(-1)!.status).toBe("approved");
  });

  it("the athlete changed its settings in the sheet since: refused stale, nothing written; one already written (its request died) carries on", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const { id } = await proposed(p, { days: ["Tue", "Thu"] });
    await db.update(programs).set({ config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [4, 5], placementWeeksAhead: 2 }) }).where(eq(programs.id, p));
    const { answers } = await approveAll(id);
    expect(answers.at(-1)!.refused).toEqual([{ opId: programmeChangeId(p), error: "stale", why: "Its settings changed since this was suggested: ask the coach again." }]);
    expect((await configOf(p)).preferredDays).toEqual([4, 5]);

    // Its settings already the change's (the write landed, the request died before its outcome did): not stale.
    const q = await programme({ goal: 2, days: [0, 2], name: "Strength" });
    const { id: id2 } = await proposed(q, { days: ["Tue", "Thu"] });
    await db.update(programs).set({ config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [1, 3], placementWeeksAhead: 2 }) }).where(eq(programs.id, q));
    const done = await approveAll(id2);
    expect(done.answers.at(-1)!.status).toBe("approved");
    expect(await live(q)).toContain("2026-10-20:scheduled");
  });

  it("care compared as a set (review-1): a sheet save that re-orders the same care list leaves the change approvable", async () => {
    const caring = Object.values(PROFILES).find((x) => x.care)!;
    await db.insert(userConditions).values({ id: `${userId}:${caring.id}`, userId, profileId: caring.id, active: true, since: "2026-09-01", settings: {} });
    // Two profiles the sheet doesn't show (switched off in the account): kept as they are, listed first by the sheet.
    const [x, y] = ["switched-off-one", "switched-off-two"];
    const p = await programme({ goal: 2, days: [0, 2] });
    const cfg = (careProfiles: string[]) => adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 2], careProfiles, placementWeeksAhead: 2 });
    await db.update(programs).set({ config: cfg([caring.id, x, y]) }).where(eq(programs.id, p));
    const { id } = await proposed(p, { care: { [caring.id]: false } });
    expect((await opOf(id, p)).base).toEqual({ careProfiles: [caring.id, x, y] });
    expect((await opOf(id, p)).change).toEqual({ careProfiles: [x, y] });
    // The sheet saves the care list back in its own order — the ones it doesn't show first: the same care, re-ordered.
    await db.update(programs).set({ config: cfg([y, x, caring.id]) }).where(eq(programs.id, p));
    const { answers } = await approveAll(id);
    expect(answers.at(-1)!.refused).toEqual([]);
    expect(answers.at(-1)!.status).toBe("approved");
    expect((await configOf(p)).careProfiles).toEqual([x, y]);
    // The change already written (its request died), in another order: not stale either.
    const q = await programme({ goal: 2, days: [0, 2], name: "Strength" });
    await db.update(programs).set({ config: cfg([caring.id, x, y]) }).where(eq(programs.id, q));
    const { id: id2 } = await proposed(q, { care: { [caring.id]: false } });
    await db.update(programs).set({ config: cfg([y, x]) }).where(eq(programs.id, q));
    const done = await approveAll(id2);
    expect(done.answers.at(-1)!.refused).toEqual([]);
    expect(done.answers.at(-1)!.status).toBe("approved");
    // A set, not a part of one: the athlete dropped one of them since — a real change, so stale.
    const r = await programme({ goal: 2, days: [0, 2], name: "Core" });
    await db.update(programs).set({ config: cfg([caring.id, x, y]) }).where(eq(programs.id, r));
    const { id: id3 } = await proposed(r, { care: { [caring.id]: false } });
    await db.update(programs).set({ config: cfg([caring.id, x]) }).where(eq(programs.id, r));
    expect((await approveAll(id3)).answers.at(-1)!.refused).toMatchObject([{ error: "stale" }]);
    expect((await configOf(r)).careProfiles).toEqual([caring.id, x]);
  });

  it("the write counted once (review-1): a request's pass gets the room the claim and the write leave, and what it declares is the claim, the write and the pass", async () => {
    const p = await programme({ goal: 6, days: [0, 1, 2, 3, 4, 5], ahead: 4 });
    const { id } = await proposed(p, { days: ["Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], weeklyGoal: 5 });
    const budget = 41;
    const room = budget - PROGRAMME_CHANGE_FIXED - PROGRAMME_WRITE_COST;
    // What one pass with exactly that room declares, on a copy with the settings written.
    const copy = cloneTestDb(db);
    await updateProgram(copy, userId, p, { config: (await opOf(id, p)).change }, NOW.toISOString());
    const pass = await placeSlotsWithin(copy, userId, p, TODAY, await loadPreferences(copy, userId), NOW.toISOString(), room);
    expect(pass.more).toBe(true);
    const row = (await db.select().from(coachProposals).where(eq(coachProposals.id, id)))[0]!;
    const meter = { left: 0 };
    const res = await approveDesignOps(db, userId, { id: row.id, title: row.title, status: row.status, ops: row.ops, resolvedAt: row.resolvedAt }, {}, { today: TODAY, now: NOW.toISOString(), prefs: await loadPreferences(db, userId) }, budget, meter);
    expect(res.remaining).toEqual([programmeChangeId(p)]);
    expect((await opOf(id, p)).outcome).toMatchObject({ status: "applying", progress: { written: true, archived: pass.archived.length } });
    expect(meter.left).toBe(budget - PROGRAMME_CHANGE_FIXED - PROGRAMME_WRITE_COST - pass.spent);
  });

  it("a retired programme or one gone: refused, in words", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const { id } = await proposed(p, { days: ["Tue", "Thu"] });
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, p));
    const { answers } = await approveAll(id);
    expect(answers.at(-1)!.refused).toEqual([{ opId: programmeChangeId(p), error: "stale", why: "Mobility is retired." }]);
  });

  it("started, it is finished by Approve — never declined half made, never expired; claimed fresh, another approve answers it in flight", async () => {
    const p = await programme({ goal: 2, days: [0, 2], ahead: 4 });
    const { id } = await proposed(p, { days: ["Tue", "Thu"] });
    const first = await invoke("POST", `/api/coach/proposals/${id}/approve`, {});
    expect(first.json.remaining).toEqual([programmeChangeId(p)]);
    expect((await opOf(id, p)).outcome).toMatchObject({ status: "applying", progress: { written: true } });
    const decline = await invoke("POST", `/api/coach/proposals/${id}/decline`, { opIds: [programmeChangeId(p)] });
    expect(decline.status).toBe(409);
    expect(decline.json).toMatchObject({ error: "in_flight", opIds: [programmeChangeId(p)] });
    expect((await opOf(id, p)).outcome?.status).toBe("applying");
    // Its expiry passes: the sweep leaves it for the next approve.
    await db.update(coachProposals).set({ expiresAt: "2026-10-01" }).where(eq(coachProposals.id, id));
    await sweepExpiredProposals(db, userId, TODAY);
    expect((await proposalOf(id)).status).toBe("pending");
    // A claim within the window is another request's: in flight.
    const op = await opOf(id, p);
    await db.update(coachProposals).set({ ops: ((await proposalOf(id)).ops as unknown[]).map((o) => ((o as { id?: string }).id === op.id ? { ...op, outcome: { ...op.outcome, at: new Date(NOW.getTime() - 1000).toISOString() } } : o)) }).where(eq(coachProposals.id, id));
    const busy = await invoke("POST", `/api/coach/proposals/${id}/approve`, { opIds: [op.id] });
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({ error: "in_flight" });
    // Past the window it is taken over and finished.
    vi.setSystemTime(new Date(NOW.getTime() + APPLYING_STALE_MS + 1000));
    const { answers } = await approveAll(id, [op.id]);
    expect(answers.at(-1)!.status).toBe("approved");
    expect((await configOf(p)).preferredDays).toEqual([1, 3]);
  });

  it("not started, Not now declines it; nothing of the programme changes", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const { id } = await proposed(p, { days: ["Tue", "Thu"] });
    const decline = await invoke("POST", `/api/coach/proposals/${id}/decline`, { opIds: [programmeChangeId(p)] });
    expect(decline.json).toMatchObject({ status: "declined", declined: [programmeChangeId(p)] });
    expect((await configOf(p)).preferredDays).toEqual([0, 2]);
    expect((await opOf(id, p)).outcome?.status).toBe("declined");
  });

  it("its declared room: the claim and its release, the check and the write once, a pass of at least one retraction", () => {
    expect(PROGRAMME_CHANGE_FIXED).toBe(2);
    expect(PROGRAMME_WRITE_COST).toBe(4);
    expect(PROGRAMME_MIN_BUDGET).toBe(15);
  });
});

describe("every reader tolerates a programme change", () => {
  it("the conversation: one card a programme — kind, op, lines — and the block's line for the model", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const q = await programme({ goal: 1, days: [5], name: "Strength" });
    const ctx = await mainRun();
    ok((await change(ctx, { programmeId: p, days: ["Tue", "Thu"] })).res);
    ok((await change(ctx, { programmeId: q, weeklyGoal: 2 })).res);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
    await db.update(coachRuns).set({ status: "finished" }).where(eq(coachRuns.id, ctx.run.id));
    const conv = await readConversation(db, userId, NOW, { endedLine });
    const cards = conv.turns.at(-1)!.cards;
    expect(cards.map((c) => [c.kind, c.opId, c.title])).toEqual([
      ["programme", programmeChangeId(p), "Mobility: new days"],
      ["programme", programmeChangeId(q), "Strength: new goal"],
    ]);
    expect(cards[0]!.lines).toEqual(["Days Mon · Wed → Tue · Thu", "Next sessions move to Wed 14 Oct · Tue 20 Oct · Thu 22 Oct"]);
    const block = conversationBlock(await conversationRows(db, userId, namedConversationSql(userId, ctx.run.id), { limit: 6 }), NOW)!;
    expect(block).toContain(`Suggested a programme change (id ${designProposalId(ctx.run.id)}): ${markUntrusted("main coach", "Mobility: new days")} · Tue · Thu · 2 a week · 30 min — still open`);
  });

  it("read_proposals, the proposal's title and expiry, and the cover rule (a newer change for the programme supersedes the older)", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const older = await proposed(p, { days: ["Tue", "Thu"] });
    const fields = proposalFields((await proposalOf(older.id)).ops as unknown[]);
    expect(fields).toMatchObject({ title: "Mobility: new days", rationale: "Your Mondays are full now.", expiresAt: "2026-10-17" });
    const read = ok(await readProposals.run(older.ctx, {}));
    expect(JSON.stringify(read.data)).toContain('"kind":"programme_change"');
    expect(JSON.stringify(read.data)).toContain('"summary":"Tue · Thu · 2 a week · 30 min"');
    // Another programme's change, older still: never covered by a change to this one.
    const q = await programme({ goal: 1, days: [5], name: "Strength" });
    const others = await proposed(q, { weeklyGoal: 2 });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const newer = await proposed(p, { days: ["Tue", "Fri"] });
    await supersedeOlderPlans(db, userId, newer.id, NOW.toISOString());
    expect((await proposalOf(older.id)).status).toBe("superseded");
    expect((await opOf(older.id, p)).outcome?.status).toBe("superseded");
    expect((await proposalOf(others.id)).status).toBe("pending");
    expect((await opOf(others.id, q)).outcome).toBeUndefined();
  });

  it("the Coach button's current run: a finished run whose suggestion is a programme change still open is the one it opens", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const { id, ctx } = await proposed(p, { days: ["Tue", "Thu"] });
    await db.update(coachRuns).set({ status: "finished" }).where(eq(coachRuns.id, ctx.run.id));
    const current = await currentRun(db, userId, NOW);
    expect(current?.run.id).toBe(ctx.run.id);
    expect(current?.proposal?.id).toBe(id);
  });

  it("read_plans: each programme's settings, what change_programme changes", async () => {
    const p = await programme({ goal: 2, days: [0, 2] });
    const ctx = await mainRun();
    const res = ok(await readPlans.run(ctx, {}));
    const plan = (res.data as { plans: Array<Record<string, any>> }).plans.find((x) => x.id === p)!;
    expect(plan.settings).toEqual({ days: ["Mon", "Wed"], weeklyGoal: 2, minutes: 30, blockWeeks: 5, modes: ["recovery", "consistent", "build"], care: [] });
    expect(plan.why).toContain("change_programme");
    expect(plan.next.map((n: { date: string }) => n.date)).toEqual(["2026-10-14", "2026-10-19", "2026-10-21"]);
  });
});
