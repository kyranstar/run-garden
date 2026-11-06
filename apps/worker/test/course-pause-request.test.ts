/**
 * A PAUSE TAKES EFFECT IN THE REQUEST (plans with a purpose, rulings R23 and R25). A change to `pausedUntil`, set or cleared,
 * runs that plan's placement pass in the same request, through `PATCH /api/plans/:id` and through approving the coach's
 * `plan_change`. So someone pausing for illness sees today's session go at once, with its copy owed off the watch, and lifting
 * a pause brings the outlines back. The pass is budgeted: today's go first, and what doesn't fit goes with the next hourly pass.
 * Every request here stays within the statement budget, on a realistic account with the dearest case: a session written
 * today with its copy on the watch.
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
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { writeCourseSession } from "../src/services/course-sessions.js";
import type { Db } from "../src/services/db.js";
import { changePlan } from "../src/services/design-tools/change-plan.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { mondayOf, proposePlan } from "../src/services/design-tools/propose-plan.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { queueProvisionalPush } from "../src/services/mirror.js";
import { applyPlanPatch } from "../src/services/plan-registry.js";
import { placeAfterPauseChange, placeSlots, placeSlotsForAllPrograms, slotId } from "../src/services/program-slots.js";
import { makeTestDb, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";
import { INTRO_COURSE } from "./course-fixture.js";
import { makeRealisticEnv, seedRealisticAccount } from "./realistic-account.js";
import { connectMock, seedCatalog, switchOn } from "./watch-push-fixture.js";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";

const { calendarEventSuppressions, coachProposals, coachRuns, corosWriteJobs, plannedWorkouts, programs, sessionBuilds, userPreferences } = schema;

/** A Monday. */
const MON = "2026-10-05";
/** Monday noon in Los Angeles, the test user's zone. */
const NOW = "2026-10-05T19:00:00.000Z";
const AT = new Date(NOW);
const day = (week: number, weekday: number): string => addDays(MON, 7 * week + weekday);
const REQUEST_BUDGET = 45;

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
  prefs = { ...(await loadPreferences(db, userId)), corosWritesEnabled: true };
  await db.update(userPreferences).set({ prefs: prefs as never }).where(eq(userPreferences.userId, userId));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  await seedCatalog(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const env = (): Env => ({ ...makeRealisticEnv(), COACH_DESIGNER: "1", AI_GATEWAY_API_KEY: "test-key", WATCH_PUSH_ENABLED: "1" }) as Env;
const row = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const planOf = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!;
const unpushOf = (id: string) => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id));
const live = async (p: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, p))).filter((r) => r.archivedAt === null).map((r) => r.effectiveDate).sort();

async function course(config: Partial<CourseConfig> = {}, over: Partial<typeof programs.$inferInsert> = {}): Promise<string> {
  const id = over.id ?? newId();
  await db.insert(programs).values({
    id, userId, kind: "course", name: "Evening practice", status: "active", disciplines: ["yoga"], startDate: null, endDate: null, raceDate: null, source: null,
    config: courseConfigSchema.parse({ course: INTRO_COURSE.id, weekdays: [0, 4], time: "19:30", placementWeeksAhead: 1, ...config }),
    onEnd: "continue", createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over,
  });
  await placeSlots(db, userId, id, MON, prefs, NOW);
  return id;
}

/** Today's session written, its copy on the watch: the pass's dearest. */
async function writtenWithCopy(config: Partial<CourseConfig> = {}): Promise<{ p: string; id: string; recordId: string }> {
  const server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
  const p = await course(config);
  const id = slotId(p, MON);
  const ctx = { today: MON, now: NOW, prefs };
  expect((await writeCourseSession(db, userId, await row(id), ctx)).written).toBe(true);
  expect(await queueProvisionalPush(db, switchOn(), userId, await row(id), ctx)).toBe("queued");
  await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  const [record] = await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, id));
  expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${record!.id}`)))[0]!.status).toBe("verified");
  return { p, id, recordId: record!.id };
}

/** Each statement of one request, its waitUntil work included. */
async function invoke(app: ReturnType<typeof mountRoutes>, method: string, path: string, body?: unknown) {
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (w: Promise<unknown>) => pending.push(w), passThroughOnException: () => undefined, props: {} };
  statements.length = 0;
  const res = await app.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env(), executionCtx as never);
  await Promise.all(pending);
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, any>, total: statements.length, seen: [...statements] };
}

/** A failure the pass can't get past: nothing can archive a planned row. */
const nothingArchives = () =>
  (db as unknown as { $client: { exec(sql: string): void } }).$client.exec(
    `create trigger refuse_archive before update of archived_at on planned_workouts begin select raise(abort, 'refused'); end;`,
  );

describe("through PATCH /api/plans/:id", () => {
  const patch = (p: string, body: unknown) => invoke(mountRoutes(db, "/api/plans", planRoutes), "PATCH", `/api/plans/${p}`, body);

  it("pausing takes today's written session within the request, and its copy on the watch is owed its removal", async () => {
    const { p, id, recordId } = await writtenWithCopy();
    const res = await patch(p, { pausedUntil: addDays(MON, 3) });
    expect(res.status).toBe(200);
    expect(res.json.plan.pausedUntil).toBe(addDays(MON, 3));
    expect(await row(id)).toMatchObject({ archivedAt: NOW, archiveReason: "program_replaced" });
    expect((await unpushOf(id)).find((j) => j.id === `unpush:${recordId}`)).toMatchObject({ status: "queued" });
    expect(res.total).toBe(36);
  });

  it("clearing a pause brings its outlines back within the request", async () => {
    const { p, id } = await writtenWithCopy();
    await patch(p, { pausedUntil: addDays(MON, 3) });
    expect(await live(p)).toEqual([day(0, 4), day(1, 0), day(1, 4)]);
    const res = await patch(p, { pausedUntil: null });
    expect(res.status).toBe(200);
    expect(await live(p)).toEqual([MON, day(0, 4), day(1, 0), day(1, 4)]);
    expect(await row(id)).toMatchObject({ archivedAt: null, origin: "program", workoutDoc: null, courseSession: null });
    // The one slot brought back clears its overrides as well as its suppression (REVIVE_COST).
    expect(res.total).toBe(22);
  });

  it("a long pause stays inside the budget with today's taken first, and what's left goes with the next hourly pass", async () => {
    const { p, id } = await writtenWithCopy({ weekdays: [0, 1, 2, 3], placementWeeksAhead: 3 });
    expect((await live(p)).length).toBeGreaterThan(4);
    const res = await patch(p, { pausedUntil: day(4, 0) });
    expect(res.status).toBe(200);
    expect(res.total).toBe(35);
    expect((await row(id)).archivedAt).toBe(NOW);
    expect((await live(p)).length).toBeGreaterThan(0);

    await placeSlotsForAllPrograms(db, AT);
    expect(await live(p)).toEqual([]);
  });

  it("an adaptive programme's pause takes effect in the request too", async () => {
    const p = newId();
    await db.insert(programs).values({
      id: p, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ weeklyGoal: 2, preferredDays: [0, 4], defaultMinutes: 30 }), createdAt: NOW, updatedAt: NOW, archivedAt: null,
    });
    await placeSlots(db, userId, p, MON, prefs, "2026-10-05T12:00:00.000Z");
    const res = await patch(p, { pausedUntil: MON });
    expect(res.status).toBe(200);
    expect((await row(slotId(p, MON))).archivedAt).toBe(NOW);
  });

  it("a patch that doesn't change the pause places nothing, and keeps its old count", async () => {
    const { p, id } = await writtenWithCopy();
    const before = await row(id);
    const res = await patch(p, { purpose: "A synthetic purpose" });
    expect(res.status).toBe(200);
    expect(res.seen.filter((s) => /from "planned_workouts"/.test(s) && /"origin"/.test(s) && /"course_session"/.test(s))).toEqual([]);
    expect(await row(id)).toEqual(before);
    expect(res.total).toBe(PATCH_WITHOUT_A_PASS);

    // The same pause again is no change either.
    const paused = "2099-01-01";
    await db.update(programs).set({ pausedUntil: paused }).where(eq(programs.id, p));
    const again = await patch(p, { pausedUntil: paused });
    expect(again.status).toBe(200);
    expect(await row(id)).toEqual(before);
  });

  it("a coach's plan has nothing to place: its pause is written, for the pass's two looks", async () => {
    const p = newId();
    await db.insert(programs).values({ id: p, userId, kind: "coach", name: "Running", status: "active", disciplines: ["run"], startDate: null, endDate: null, raceDate: null, source: null, config: {}, createdAt: NOW, updatedAt: NOW, archivedAt: null });
    const res = await patch(p, { pausedUntil: addDays(MON, 3) });
    expect(res.status).toBe(200);
    expect((await planOf(p)).pausedUntil).toBe(addDays(MON, 3));
    expect(res.total).toBe(PATCH_WITHOUT_A_PASS + 2);
  });

  it("a pass that fails doesn't fail the request: the pause has landed, and the hourly pass finishes it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { p, id } = await writtenWithCopy();
    nothingArchives();
    const res = await patch(p, { pausedUntil: MON });
    expect(res.status).toBe(200);
    expect((await planOf(p)).pausedUntil).toBe(MON);
    expect((await row(id)).archivedAt).toBeNull();
    expect(error).toHaveBeenCalledWith(`pause_placement_failed: plan ${p} SqliteError`);
  });
});

/** PATCH of what isn't a pause, on this account: the session and the user, the preferences, the patch's five, the list's. */
const PATCH_WITHOUT_A_PASS = 10;

describe("the pass's failure", () => {
  it("our own runtime ceiling isn't swallowed: the invocation is over, and saying otherwise would hide it", async () => {
    const { p } = await writtenWithCopy();
    (db as unknown as { $client: { exec(sql: string): void } }).$client.exec(
      `create trigger the_ceiling before update of archived_at on planned_workouts begin select raise(abort, 'Too many API requests by single worker invocation.'); end;`,
    );
    await db.update(programs).set({ pausedUntil: MON }).where(eq(programs.id, p));
    await expect(placeAfterPauseChange(db, userId, p, MON, prefs, NOW, 33)).rejects.toThrow("Too many API requests");
  });
});

describe("through approving the coach's plan_change", () => {
  const app = () => mountRoutes(db, "/api/coach", coachRoutes);

  async function mainRun(): Promise<ToolContext> {
    const id = `run-${newId()}`;
    await db.insert(coachRuns).values({
      id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Pause it", status: "active",
      state: null, steps: 0, costUsd: 0, createdAt: NOW, updatedAt: NOW,
    });
    return { db, env: env(), userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
  }

  /** The coach's card for this change, waiting on the athlete. */
  async function proposed(p: string, change: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
    const run = ctx ?? (await mainRun());
    const made = await changePlan.run(run, { planId: p, ...change, why: "You asked." });
    expect(isToolErr(made) ? made.why : "").toBe("");
    const id = designProposalId(run.run.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    return id;
  }

  /** Approve as the client does, until nothing is left. Each request's answer and what it cost. */
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

  it("pausing takes today's written session within the request, and its copy on the watch is owed its removal", async () => {
    const { p, id, recordId } = await writtenWithCopy();
    const answers = await approveAll(await proposed(p, { pausedUntil: addDays(MON, 3) }));
    expect(answers).toHaveLength(1);
    expect(answers[0]!.total).toBe(39);
    expect((await planOf(p)).pausedUntil).toBe(addDays(MON, 3));
    expect(await row(id)).toMatchObject({ archivedAt: NOW, archiveReason: "program_replaced" });
    expect((await unpushOf(id)).find((j) => j.id === `unpush:${recordId}`)).toMatchObject({ status: "queued" });
    // What the card says landed has: the pause.
    expect(answers[0]!.json.planned[0].summary).toContain("paused until");
  });

  it("clearing a pause brings its outlines back within the request", async () => {
    const p = await course({}, { pausedUntil: day(1, 4) });
    expect(await live(p)).toEqual([]);
    const answers = await approveAll(await proposed(p, { pausedUntil: null }));
    expect(answers).toHaveLength(1);
    expect(answers[0]!.total).toBe(24);
    expect((await planOf(p)).pausedUntil).toBeNull();
    expect(await live(p)).toEqual([MON, day(0, 4), day(1, 0), day(1, 4)]);
  });

  it("a long pause stays inside the budget with today's taken first, and what's left goes with the next hourly pass", async () => {
    const { p, id } = await writtenWithCopy({ weekdays: [0, 1, 2, 3], placementWeeksAhead: 3 });
    const answers = await approveAll(await proposed(p, { pausedUntil: day(4, 0) }));
    expect(answers).toHaveLength(1);
    expect(answers[0]!.total).toBe(38);
    expect((await row(id)).archivedAt).toBe(NOW);
    expect((await live(p)).length).toBeGreaterThan(0);

    await placeSlotsForAllPrograms(db, AT);
    expect(await live(p)).toEqual([]);
  });

  it.each([1, 7])("a pause beside a whole plan of %i firm sessions waits, and runs first in the next request: no request goes over", async (firm) => {
    const { p, id } = await writtenWithCopy();
    const ctx = await mainRun();
    const monday = mondayOf(addDays(MON, 7));
    const plan = await proposePlan.run(ctx, {
      change: {
        kind: "createPlan", discipline: "run", name: "Build block", newPlan: { name: "Synthetic plan", purpose: "A synthetic purpose" }, startDate: monday, endDate: addDays(monday, 20),
        firmSessions: Array.from({ length: firm }, (_, n) => ({
          date: addDays(monday, n % 7),
          session: { category: "easy", title: `Run ${n + 1}`, durationMinutes: 30 + n, run: { blocks: [{ kind: "duration", value: 30 + n, intensity: "easy" }] } },
        })),
        shapeWeeks: [0, 1].map((k) => ({ weekStart: addDays(monday, 7 * (k + 1)), volumeTarget: "about 30 km", keySessions: ["long run"] })),
      },
      why: "The next phase.",
    });
    expect(isToolErr(plan) ? plan.why : "").toBe("");
    const answers = await approveAll(await proposed(p, { pausedUntil: addDays(MON, 3) }, ctx));

    expect(answers.length).toBeGreaterThan(1);
    for (const a of answers) expect(a.total).toBeLessThanOrEqual(REQUEST_BUDGET);
    // Every request but the last leaves the pause alone, and says it's still to come.
    const last = answers.at(-1)!;
    for (const a of answers.slice(0, -1)) {
      expect(a.seen.filter((s) => /^insert into "program_versions"/.test(s))).toEqual([]);
      expect(a.json.remaining.length).toBeGreaterThan(0);
    }
    // The last writes the pause and its pass, the pause alone on it, and nothing of the card is left.
    expect(last.seen.filter((s) => /^insert into "program_versions"/.test(s))).toHaveLength(1);
    expect(last.total).toBe(39);
    expect((await planOf(p)).pausedUntil).toBe(addDays(MON, 3));
    expect((await row(id)).archivedAt).toBe(NOW);
  });

  it("an approve retried after its request died still places, and places once", async () => {
    const { p, id } = await writtenWithCopy();
    const proposal = await proposed(p, { pausedUntil: addDays(MON, 3) });
    // The request that died: the plan's change landed, and nothing after it.
    await applyPlanPatch(db, userId, p, { pausedUntil: addDays(MON, 3) }, NOW, MON);
    expect((await row(id)).archivedAt).toBeNull();

    const answers = await approveAll(proposal);
    expect(answers[0]!.json.refused).toEqual([]);
    expect(answers[0]!.total).toBe(36);
    expect((await row(id)).archivedAt).toBe(NOW);
    const once = async () => [
      (await db.select().from(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, id))).length,
      (await unpushOf(id)).filter((j) => j.kind !== "program_session_push").length,
    ];
    expect(await once()).toEqual([1, 1]);

    // Approved again, it's settled: nothing more.
    const again = await invoke(app(), "POST", `/api/coach/proposals/${proposal}/approve`, {});
    expect(again.status).toBe(200);
    expect(again.seen.filter((s) => /^update "planned_workouts"/.test(s))).toEqual([]);
    expect(await once()).toEqual([1, 1]);
  });

  it("a change that isn't to the pause places nothing, and keeps its old count", async () => {
    const { p, id } = await writtenWithCopy();
    const before = await row(id);
    const answers = await approveAll(await proposed(p, { purpose: "A synthetic purpose" }));
    expect(answers).toHaveLength(1);
    expect(await row(id)).toEqual(before);
    expect(answers[0]!.seen.filter((s) => /from "planned_workouts"/.test(s) && /"course_session"/.test(s))).toEqual([]);
    expect(answers[0]!.total).toBe(APPROVE_WITHOUT_A_PASS);
  });

  it("a change that's refused places nothing", async () => {
    const { p, id } = await writtenWithCopy();
    const before = await row(id);
    const proposal = await proposed(p, { pausedUntil: addDays(MON, 3) });
    // The athlete moved it since, to neither what it was nor what this asks.
    await db.update(programs).set({ pausedUntil: addDays(MON, 9) }).where(eq(programs.id, p));
    const answers = await approveAll(proposal);
    expect(answers[0]!.json.refused).toHaveLength(1);
    expect(await row(id)).toEqual(before);
  });

  it("a pass that fails doesn't fail the approve: the pause has landed, and the hourly pass finishes it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { p, id } = await writtenWithCopy();
    const proposal = await proposed(p, { pausedUntil: addDays(MON, 3) });
    nothingArchives();
    const answers = await approveAll(proposal);
    expect(answers[0]!.json.refused).toEqual([]);
    expect((await planOf(p)).pausedUntil).toBe(addDays(MON, 3));
    expect((await row(id)).archivedAt).toBeNull();
    expect(error).toHaveBeenCalledWith(`pause_placement_failed: plan ${p} SqliteError`);
  });
});

/** Approving what isn't a pause, on this account: alone on its card. */
const APPROVE_WITHOUT_A_PASS = 16;
