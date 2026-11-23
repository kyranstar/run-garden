/**
 * A COURSE'S DAYS, TIME AND RHYTHM, CHANGED IN PLACE (R1.6; DEBUG-tre-cadence §4). `PATCH /api/plans/:id` and the coach's
 * `change_plan` take a course's `weekdays`, `time` and `everyWeeks` (with an optional `cadenceFrom`, put on its Monday; none
 * given, the week of the next of its days), checked by the course's own schema and written once (`applyPlanPatch`: one write,
 * one version). The keys of a rhythm are written only when it is longer than a week. The change takes effect in its own
 * request, as a pause does: its placement pass runs there, a new time re-times the outlines ahead, and what doesn't fit is the
 * next hourly pass's. A programme's or a coach plan's days are not this route's. The card says what changes, a line each, and
 * where the next sessions fall.
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
import { adaptiveConfigSchema, addDays, courseConfigSchema, newId, type CourseConfig, type UserPreferences } from "@rg/domain";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { coachRoutes } from "../src/routes/coach.js";
import { planRoutes } from "../src/routes/plans.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import type { Db } from "../src/services/db.js";
import { REQUEST_BUDGET } from "../src/services/design-approve.js";
import { changePlan } from "../src/services/design-tools/change-plan.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import { applyMove } from "../src/services/jobs.js";
import type { PlanChangeOp } from "../src/services/proposal-kinds.js";
import { placeSlots, slotId } from "../src/services/program-slots.js";
import { isWrite, makeTestDb, MAX_LOOP_ITERATIONS, mountRoutes, wholeSuggestion } from "./helpers.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { makeRealisticEnv, seedRealisticAccount } from "./realistic-account.js";

const { coachProposals, coachRuns, plannedWorkouts, programs, programVersions } = schema;

/** A Monday. */
const MON = "2026-10-05";
/** Monday noon in Los Angeles, the test user's zone. */
const NOW = "2026-10-05T19:00:00.000Z";
const AT = new Date(NOW);
const day = (week: number, weekday: number): string => addDays(MON, 7 * week + weekday);

let db: Db;
let userId: string;
let prefs: UserPreferences;
let statements: string[];
let cookie: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT);
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  const account = await seedRealisticAccount(db);
  userId = account.userId;
  prefs = await loadPreferences(db, userId);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const env = (): Env => ({ ...makeRealisticEnv(), COACH_DESIGNER: "1", AI_GATEWAY_API_KEY: "test-key" }) as Env;
const row = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const planOf = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!;
const configOf = async (id: string) => (await planOf(id)).config as Record<string, unknown>;
const live = async (p: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, p))).filter((r) => r.archivedAt === null).map((r) => r.effectiveDate).sort();

/** A running course on Monday and Friday at 18:15, its next two weeks placed. */
async function course(config: Partial<CourseConfig> = {}, over: Partial<typeof programs.$inferInsert> = {}): Promise<string> {
  const id = over.id ?? newId();
  await db.insert(programs).values({
    id, userId, kind: "course", name: "TRE", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "18:15", placementWeeksAhead: 1, ...config }),
    onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over,
  });
  await placeSlots(db, userId, id, MON, prefs, NOW);
  return id;
}

/** Each statement of one request, its waitUntil work included. */
async function invoke(app: ReturnType<typeof mountRoutes>, method: string, path: string, body?: unknown) {
  body = await wholeSuggestion(db, path, body);
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (w: Promise<unknown>) => pending.push(w), passThroughOnException: () => undefined, props: {} };
  statements.length = 0;
  const res = await app.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env(), executionCtx as never);
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, total: statements.length, seen: [...statements] };
}

const patch = (p: string, body: unknown) => invoke(mountRoutes(db, "/api/plans", planRoutes), "PATCH", `/api/plans/${p}`, body);

describe("through PATCH /api/plans/:id", () => {
  it("every 2 weeks from this week: the off week's outlines come off in the request, and the keys are written", async () => {
    const p = await course();
    expect(await live(p)).toEqual([MON, day(0, 4), day(1, 0), day(1, 4)]);
    const res = await patch(p, { everyWeeks: 2, cadenceFrom: MON });
    expect(res.status).toBe(200);
    expect(await configOf(p)).toMatchObject({ weekdays: [0, 4], everyWeeks: 2, cadenceFrom: MON });
    // The off week's two came off in the request; the window reaches the next on week (one rhythm ahead).
    expect((await live(p)).filter((d) => d >= day(1, 0) && d <= day(1, 6))).toEqual([]);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await live(p)).toEqual([MON, day(0, 4), day(2, 0), day(2, 4)]);
    expect(res.json.plan.schedule).toEqual({ days: [0, 4], time: "18:15", everyWeeks: 2, from: MON });
    expect(res.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    const [version] = await db.select().from(programVersions).where(eq(programVersions.programId, p));
    expect((version!.summary as { changed: string[] }).changed.sort()).toEqual(["cadenceFrom", "everyWeeks"]);
  });

  it("days and a rhythm with no anchor, nothing done yet: the rhythm counts from this week", async () => {
    const p = await course({ placementWeeksAhead: 2 });
    const res = await patch(p, { weekdays: [0], everyWeeks: 2 });
    expect(res.status).toBe(200);
    expect(res.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(await configOf(p)).toMatchObject({ weekdays: [0], everyWeeks: 2, cadenceFrom: MON });
    // Four retractions don't all fit one request: the soonest went, and the hourly pass takes the rest.
    expect((await live(p)).length).toBeLessThan(6);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    expect(await live(p)).toEqual([MON, day(2, 0)]);
  });

  it("an anchor on any day is put on its Monday", async () => {
    const p = await course();
    expect((await patch(p, { everyWeeks: 2, cadenceFrom: day(1, 3) })).status).toBe(200);
    expect(await configOf(p)).toMatchObject({ cadenceFrom: day(1, 0) });
    // This week is off: Friday's outline goes; today's, as ever, stays (rule 3).
    expect(await live(p)).toEqual([MON, day(1, 0), day(1, 4)]);
  });

  it("back to every week removes both keys and brings the outlines back", async () => {
    const p = await course({ everyWeeks: 2, cadenceFrom: MON });
    expect(await live(p)).toEqual([MON, day(0, 4), day(2, 0), day(2, 4)]);
    const res = await patch(p, { everyWeeks: 1 });
    expect(res.status).toBe(200);
    const config = await configOf(p);
    expect(Object.keys(config)).not.toContain("everyWeeks");
    expect(Object.keys(config)).not.toContain("cadenceFrom");
    // Next week's come back; the week after, past the shorter window now, keeps the two it still wants.
    expect(await live(p)).toEqual([MON, day(0, 4), day(1, 0), day(1, 4), day(2, 0), day(2, 4)]);
    expect(res.json.plan.schedule).toEqual({ days: [0, 4], time: "18:15", everyWeeks: 1, from: null });
  });

  it("a new time re-times the outlines from tomorrow; today's and one the athlete moved keep theirs", async () => {
    const p = await course();
    await applyMove(db, { userId, workoutId: slotId(p, day(1, 0)), toDate: day(1, 1), toTime: "12:00", source: "app", corosWritesEnabled: false });
    const res = await patch(p, { time: "07:30" });
    expect(res.status).toBe(200);
    expect(await configOf(p)).toMatchObject({ time: "07:30" });
    expect((await row(slotId(p, MON))).effectiveTime).toBe("18:15");
    expect((await row(slotId(p, day(0, 4)))).effectiveTime).toBe("07:30");
    expect((await row(slotId(p, day(1, 4)))).effectiveTime).toBe("07:30");
    expect((await row(slotId(p, day(1, 0)))).effectiveTime).toBe("12:00");
    expect(res.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    // Asked again, nothing more is written.
    const again = await patch(p, { time: "07:30" });
    expect(again.seen.filter(isWrite)).toEqual([]);
  });

  it("the same days in another order are no change: nothing written, no pass", async () => {
    const p = await course();
    const res = await patch(p, { weekdays: [4, 0] });
    expect(res.status).toBe(200);
    expect(res.seen.filter(isWrite)).toEqual([]);
  });

  it.each([
    ["every 5 weeks", { everyWeeks: 5 }],
    ["every 0 weeks", { everyWeeks: 0 }],
    ["a day that isn't one", { weekdays: [7] }],
    ["no days", { weekdays: [] }],
    ["a time that isn't one", { time: "7pm" }],
    ["an anchor with no rhythm", { cadenceFrom: MON }],
  ])("refuses %s on a course, nothing written", async (_, body) => {
    const p = await course();
    const res = await patch(p, body);
    expect(res.status).toBe(422);
    expect(res.seen.filter(isWrite)).toEqual([]);
  });

  it("a programme's rhythm is its settings', and a coach plan has no days here: both refused", async () => {
    const programme = newId();
    await db.insert(programs).values({
      id: programme, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    const refused = await patch(programme, { everyWeeks: 2 });
    expect(refused.status).toBe(422);
    expect(refused.json.issues[0]).toMatchObject({ path: ["everyWeeks"] });
    expect(refused.json.issues[0].message).toContain("course");
    const coach = newId();
    await db.insert(programs).values({ id: coach, userId, kind: "coach", name: "Running", status: "active", disciplines: ["run"], startDate: null, endDate: null, raceDate: null, source: null, config: {}, createdAt: NOW, updatedAt: NOW, archivedAt: null });
    expect((await patch(coach, { weekdays: [0] })).status).toBe(422);
  });
});

describe("through the coach's change_plan, and its approve", () => {
  const app = () => mountRoutes(db, "/api/coach", coachRoutes);

  async function mainRun(): Promise<ToolContext> {
    const id = `run-${newId()}`;
    await db.insert(coachRuns).values({
      id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Can we change TRE to be like every two weeks please", status: "active",
      state: null, steps: 0, costUsd: 0, createdAt: NOW, updatedAt: NOW,
    });
    return { db, env: env(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
  }

  const ok = (r: ToolOk | ToolErr): ToolOk => {
    if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
    return r;
  };
  const opOf = async (ctx: ToolContext) => {
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, designProposalId(ctx.run.id)));
    return (p!.ops as PlanChangeOp[])[0]!;
  };

  async function approveAll(id: string) {
    const answers: Array<Awaited<ReturnType<typeof invoke>>> = [];
    let remaining: string[] | null = null;
    for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
      const res = await invoke(app(), "POST", `/api/coach/proposals/${id}/approve`, remaining ? { opIds: remaining } : {});
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      answers.push(res);
      remaining = res.json.remaining as string[];
      if (remaining.length === 0) return answers;
    }
    throw new Error("the approve never finished");
  }

  it("Monday every 2 weeks: the card says each change and where the next sessions fall", async () => {
    const p = await course();
    const ctx = await mainRun();
    statements.length = 0;
    const res = ok(await changePlan.run(ctx, { planId: p, days: ["Mon"], everyWeeks: 2, why: "Every two weeks, as you asked: Mondays, from today." }));
    expect(statements.length).toBeLessThanOrEqual(changePlan.statementCost);
    expect(statements.filter((s) => isWrite(s) && !/coach_proposals/.test(s))).toEqual([]);
    const op = await opOf(ctx);
    expect(op.change).toEqual({ weekdays: [0], everyWeeks: 2, cadenceFrom: MON });
    expect(op.base).toEqual({ weekdays: [0, 4], everyWeeks: 1, cadenceFrom: null });
    expect(op.title).toBe("TRE: new days and rhythm");
    expect(op.lines).toEqual(["Days Mon · Fri → Mon", "Every week → Every 2 weeks", "Next TRE Mon 5 Oct · Mon 19 Oct · Mon 2 Nov"]);
    expect(op.summary).toBe("Mon · every 2 weeks · 18:15 · Ending: Continue");
    expect((res.data as { lines: string[] }).lines).toEqual(op.lines);
    // Nothing is written until the athlete approves.
    expect(await live(p)).toEqual([MON, day(0, 4), day(1, 0), day(1, 4)]);
  });

  it("approved, the change lands with its pass in the same request; an approve retried writes nothing more", async () => {
    const p = await course();
    const ctx = await mainRun();
    ok(await changePlan.run(ctx, { planId: p, days: ["Mon"], everyWeeks: 2, why: "Every two weeks." }));
    const id = designProposalId(ctx.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    const answers = await approveAll(id);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    expect(await configOf(p)).toMatchObject({ weekdays: [0], everyWeeks: 2, cadenceFrom: MON });
    // The soonest retractions went in the request (today's Friday first); what didn't fit is the hourly pass's.
    expect((await row(slotId(p, day(0, 4)))).archivedAt).toBe(NOW);
    expect((await live(p)).filter((d) => d > MON && d <= day(1, 6))).not.toEqual([day(0, 4), day(1, 0), day(1, 4)]);
    await placeSlots(db, userId, p, MON, prefs, NOW);
    // Today's, then the Monday two weeks on: the window reaches one rhythm ahead.
    expect(await live(p)).toEqual([MON, day(2, 0)]);

    const again = await invoke(app(), "POST", `/api/coach/proposals/${id}/approve`, { opIds: [`pc-${p}`] });
    expect(again.seen.filter((s) => isWrite(s) && /planned_workouts|"programs"|program_versions/.test(s))).toEqual([]);
    expect(await live(p)).toEqual([MON, day(2, 0)]);
  });

  it("a new time on the card, re-timed on approval", async () => {
    const p = await course();
    const ctx = await mainRun();
    ok(await changePlan.run(ctx, { planId: p, time: "07:30", why: "Mornings suit you better." }));
    expect((await opOf(ctx)).lines).toEqual(["Time 18:15 → 07:30"]);
    const id = designProposalId(ctx.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    await approveAll(id);
    expect((await row(slotId(p, day(0, 4)))).effectiveTime).toBe("07:30");
  });

  it("overtaken by the athlete's own change of days, the card is refused stale", async () => {
    const p = await course();
    const ctx = await mainRun();
    ok(await changePlan.run(ctx, { planId: p, days: ["Mon"], everyWeeks: 2, why: "Every two weeks." }));
    expect((await patch(p, { weekdays: [2] })).status).toBe(200);
    const id = designProposalId(ctx.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    const res = await invoke(app(), "POST", `/api/coach/proposals/${id}/approve`, {});
    expect(res.json.refused[0]).toMatchObject({ error: "stale" });
    expect(await configOf(p)).toMatchObject({ weekdays: [2] });
    expect(Object.keys(await configOf(p))).not.toContain("everyWeeks");
  });

  /** A session of the plan done on `date`. */
  async function doneOn(p: string, date: string) {
    const id = newId();
    await db.insert(plannedWorkouts).values({
      id, userId, planId: p, sourceWorkoutId: id, title: "TRE", category: "yoga", sport: "yoga", originalPlanDate: date, lastVerifiedCorosDate: "",
      effectiveDate: date, effectiveTime: "18:15", sourceContentFingerprint: "studio", fallbackEstimatedDurationSeconds: 660, calendarBlockDurationSeconds: 900,
      origin: "studio", contentState: "outline", completionState: "completed", courseSession: 1, createdAt: NOW, updatedAt: NOW,
    });
  }

  // Fix round 1 (the review's MAJOR 2): a new rhythm counts from the week of the latest done session; the same rhythm keeps its
  // own anchor.
  it("a new rhythm with no from counts from the week of the plan's latest done session", async () => {
    const p = await course();
    await doneOn(p, day(-1, 4));
    await doneOn(p, day(-2, 0));
    const ctx = await mainRun();
    ok(await changePlan.run(ctx, { planId: p, days: ["Mon"], everyWeeks: 2, why: "Every two weeks." }));
    expect((await opOf(ctx)).change).toEqual({ weekdays: [0], everyWeeks: 2, cadenceFrom: day(-1, 0) });
  });

  it("the same rhythm keeps its anchor: new days alone, or the rhythm named again with them", async () => {
    const p = await course({ everyWeeks: 2, cadenceFrom: day(1, 0) });
    await doneOn(p, day(-1, 0));
    const first = await mainRun();
    ok(await changePlan.run(first, { planId: p, days: ["Mon", "Thu"], why: "Thursdays suit you better than Fridays." }));
    expect((await opOf(first)).change).toEqual({ weekdays: [0, 3] });
    const second = await mainRun();
    ok(await changePlan.run(second, { planId: p, days: ["Thu"], everyWeeks: 2, why: "Thursdays only." }));
    expect((await opOf(second)).change).toEqual({ weekdays: [3] });
  });

  it.each([
    ["a day that isn't one", { days: ["Mon", "Funday"] }, "days"],
    ["a day named twice", { days: ["Mon", "monday"] }, "days"],
    ["no days", { days: [] }, "days"],
    ["every 5 weeks", { everyWeeks: 5 }, "everyWeeks"],
    ["a time that isn't one", { time: "7pm" }, "time"],
    ["a start that isn't a date", { everyWeeks: 2, from: "next week" }, "from"],
    ["a start with every week", { from: MON }, "from"],
  ])("refuses %s, teachably", async (_, input, word) => {
    const p = await course();
    const res = await changePlan.run(await mainRun(), { planId: p, ...input, why: "x" });
    expect(isToolErr(res) && res.error).toBe("invalid_input");
    expect(isToolErr(res) && res.why).toContain(word);
  });

  it("a programme's days or rhythm are change_programme's, said so", async () => {
    const programme = newId();
    await db.insert(programs).values({
      id: programme, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    const res = await changePlan.run(await mainRun(), { planId: programme, everyWeeks: 2, why: "x" });
    expect(isToolErr(res) && res.error).toBe("invalid_input");
    expect(isToolErr(res) && res.why).toContain("change_programme");
  });

  it("the same schedule is no change", async () => {
    const p = await course({ everyWeeks: 2, cadenceFrom: MON });
    const res = await changePlan.run(await mainRun(), { planId: p, days: ["Fri", "Mon"], everyWeeks: 2, why: "x" });
    expect(isToolErr(res) && res.error).toBe("no_change");
  });
});
