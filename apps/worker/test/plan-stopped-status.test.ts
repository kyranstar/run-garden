/**
 * A STOPPED PLAN SAYS SO (plans with a purpose, ruling R31). The `programs` row is what the list shows and what Stop acts on,
 * so when the last of a coach plan's blocks is stopped its row goes `retired`, in the same batch as the block, on every path
 * that stops one. Stopping one phase of a line still running changes nothing, and neither does a line that simply ran to its
 * end. The registry's backfill corrects a row already out of step, and only that.
 *
 * Fixed dates under a faked `Date`. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, type CoachOp, type UserPreferences } from "@rg/domain";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { coachRoutes } from "../src/routes/coach.js";
import { planRoutes, PLAN_STOP_FIXED } from "../src/routes/plans.js";
import { applyOps, applyStructuralChunk } from "../src/services/coach-apply.js";
import type { Db } from "../src/services/db.js";
import { backfillPlanRegistry, listPlans } from "../src/services/plan-registry.js";
import { planStoppedIfNoBlockLeft } from "../src/services/plan-status.js";
import { retireStudioPlan, STUDIO_PLAN_RETIRED } from "../src/services/studio-push.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { auditEvents, coachMessages, coachPlans, plannedWorkouts, programs, studioPlanPushes, studioPlans } = schema;

/** A Monday. */
const MON = "2026-10-05";
/** Monday noon in Los Angeles, the test user's zone. */
const NOW = "2026-10-05T19:00:00.000Z";
const AT = new Date(NOW);
const week = (n: number, weekday = 0): string => addDays(MON, 7 * n + weekday);
const ENV = { APP_URL: "https://app.test", FIXTURE_MODE: "0" } as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;
let statements: string[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT);
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

afterEach(() => {
  vi.useRealTimers();
});

const plan = (id: string, over: Partial<typeof programs.$inferInsert> = {}, owner = userId) =>
  db.insert(programs).values({ id, userId: owner, kind: "coach", name: `Plan ${id}`, status: "active", disciplines: ["run"], config: {}, createdAt: NOW, updatedAt: NOW, ...over });

const block = (id: string, programId: string | null, startDate: string, endDate: string, status = "active", owner = userId) =>
  db.insert(coachPlans).values({ id, userId: owner, discipline: "run", name: `Block ${id}`, status, startDate, endDate, raceDate: null, stampPrefix: id, programId, createdAt: NOW, updatedAt: NOW });

const sessionOf = async (planId: string, date: string): Promise<string> => {
  const id = newId();
  await db.insert(plannedWorkouts).values({
    id, userId, planId, sourceWorkoutId: id, title: "Run", category: "easy", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "07:00",
    sourceContentFingerprint: "coach", fallbackEstimatedDurationSeconds: 1800, calendarBlockDurationSeconds: 1800, completionState: "scheduled", createdAt: NOW, updatedAt: NOW,
  });
  return id;
};

/** A line of two phases: this week's and next week's. */
const twoPhases = async (id = "line") => {
  await plan(id);
  await block(`${id}-now`, id, week(0), week(0, 6));
  await block(`${id}-next`, id, week(1), week(1, 6));
};

const statusOf = async (id: string) => (await db.select().from(programs).where(eq(programs.id, id)))[0]!.status;
const blockStatus = async (id: string) => (await db.select().from(coachPlans).where(eq(coachPlans.id, id)))[0]!.status;

const post = (app: ReturnType<typeof mountRoutes>, path: string) => app.request(path, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" } }, ENV);
const retireRoute = (id: string, stop?: string) => post(mountRoutes(db, "/api/coach", coachRoutes), `/api/coach/plans/${id}/retire${stop ? `?stop=${stop}` : ""}`);
const stopRoute = (id: string) => post(mountRoutes(db, "/api/plans", planRoutes), `/api/plans/${id}/stop`);

/** The one structural chunk an approved proposal's `retirePlan` runs, or a Stop's with `stopping`. */
const chunk = (planId: string, stopping = false, budget = 40) =>
  applyStructuralChunk(db, { userId, proposalId: `p-${planId}`, opIndex: 0, op: { kind: "retirePlan", planId } as CoachOp, progress: null, budget, now: AT, prefs, stopping });

describe("a line's Stop (`POST /api/coach/plans/:id/retire`)", () => {
  it("one phase of a two-phase line leaves the plan running, whichever goes first", async () => {
    await twoPhases();
    expect((await retireRoute("line-now", "more")).status).toBe(200);
    expect(await blockStatus("line-now")).toBe("retired");
    expect(await statusOf("line")).toBe("active");
  });

  it("the later phase alone leaves it running too", async () => {
    await twoPhases();
    await retireRoute("line-next", "more");
    expect(await statusOf("line")).toBe("active");
  });

  it("the last phase stops the plan, and the list says so", async () => {
    await twoPhases();
    await retireRoute("line-now", "more");
    await retireRoute("line-next", "last");
    expect(await statusOf("line")).toBe("retired");
    expect((await listPlans(db, userId, MON)).find((p) => p.id === "line")!.status).toBe("retired");
  });

  it("a phase that has ended doesn't keep a stopped plan running", async () => {
    await plan("line");
    await block("old", "line", week(-3), week(-1, 6), "completed");
    await block("cur", "line", week(0), week(0, 6));
    await retireRoute("cur", "last");
    expect(await statusOf("line")).toBe("retired");
  });

  it("a phase still to come does keep it running", async () => {
    await plan("line");
    await block("cur", "line", week(0), week(0, 6));
    await block("draft", "line", week(2), week(2, 6), "draft");
    await retireRoute("cur", "last");
    expect(await statusOf("line")).toBe("active");
  });

  it("a page left open: a Stop of a phase already over, with nothing else running, stops the plan and leaves the phase as it was", async () => {
    await plan("line");
    await block("over", "line", week(-2), week(-1, 6));
    expect((await retireRoute("over", "last")).status).toBe(200);
    expect(await blockStatus("over")).toBe("active");
    expect(await statusOf("line")).toBe("retired");
  });

  it("a page left open: the same with a later phase still running leaves the plan alone", async () => {
    await plan("line");
    await block("over", "line", week(-2), week(-1, 6));
    await block("cur", "line", week(0), week(0, 6));
    await retireRoute("over", "more");
    expect(await statusOf("line")).toBe("active");
  });

  it("that shortcut, as measured: the block read and the plan's one statement, and what it says it spent", async () => {
    await plan("line");
    await block("over", "line", week(-2), week(-1, 6));
    statements.length = 0;
    const res = await chunk("over", true);
    expect(res.spent).toBe(2);
    expect(statements).toHaveLength(2);
  });

  it("a retire that isn't a Stop goes on through a phase that has ended, as it always has", async () => {
    await plan("line");
    await block("over", "line", week(-2), week(-1, 6));
    await chunk("over");
    expect(await blockStatus("over")).toBe("retired");
    expect(await statusOf("line")).toBe("retired");
  });

});

describe("the same step, the block and the plan together", () => {
  it("an approved proposal's retirePlan: its status step writes both", async () => {
    await plan("line");
    await block("only", "line", week(0), week(0, 6));
    expect((await chunk("only")).status).toBe("done");
    expect(await blockStatus("only")).toBe("retired");
    expect(await statusOf("line")).toBe("retired");
  });

  it("what it says it spent is what it ran: its plan read, its sessions read, the block and the plan", async () => {
    await plan("line");
    await block("only", "line", week(0), week(0, 6));
    statements.length = 0;
    const res = await chunk("only");
    expect(res.spent).toBe(4);
    expect(statements).toHaveLength(4);
  });

  it("both in one transaction: there's no moment the block is stopped and the plan says otherwise", async () => {
    let inTx = false;
    const writes: Array<{ sql: string; inTx: boolean }> = [];
    const rec = makeTestDb({ boundVariableCap: 100, onStatement: (s) => isWrite(s) && writes.push({ sql: s, inTx }) });
    const { userId: u, prefs: p } = await makeTestUser(rec);
    await rec.insert(programs).values({ id: "line", userId: u, kind: "coach", name: "P", status: "active", disciplines: [], config: {}, createdAt: NOW, updatedAt: NOW });
    await rec.insert(coachPlans).values({ id: "only", userId: u, discipline: "run", name: "B", status: "active", startDate: week(0), endDate: week(0, 6), raceDate: null, stampPrefix: "only", programId: "line", createdAt: NOW, updatedAt: NOW });
    const handle = rec as unknown as { transaction: (run: () => void) => void };
    const real = handle.transaction.bind(rec);
    handle.transaction = (run) => {
      real(() => {
        inTx = true;
        try {
          run();
        } finally {
          inTx = false;
        }
      });
    };
    writes.length = 0;
    await applyStructuralChunk(rec, { userId: u, proposalId: "p", opIndex: 0, op: { kind: "retirePlan", planId: "only" } as CoachOp, progress: null, budget: 40, now: AT, prefs: p });
    expect(writes.map((w) => [/^update "(\w+)"/.exec(w.sql)?.[1], w.inTx])).toEqual([
      ["coach_plans", true],
      ["programs", true],
    ]);
  });

  it("past the budget by one, the first step of a call still runs; otherwise it waits for room for both", async () => {
    await plan("line");
    await block("only", "line", week(0), week(0, 6));
    // Its plan read and its sessions read leave room for one statement, and the step wants two.
    const res = await applyStructuralChunk(db, { userId, proposalId: "p", opIndex: 0, op: { kind: "retirePlan", planId: "only" } as CoachOp, progress: null, budget: 3, now: AT, prefs });
    expect(res.status).toBe("more");
    expect(await blockStatus("only")).toBe("active");
    expect(await statusOf("line")).toBe("active");
  });

  it("with room for one statement and not two, the status step waits: the block isn't stopped without its plan", async () => {
    await plan("line");
    await block("only", "line", week(0), week(0, 6));
    const ahead = await sessionOf("only", week(0, 3));
    // Its plan read, its sessions read and the session's archive (its suppression, its queued writes, its row): five.
    const res = await applyStructuralChunk(db, { userId, proposalId: "p", opIndex: 0, op: { kind: "retirePlan", planId: "only" } as CoachOp, progress: null, budget: 6, now: AT, prefs });
    expect(res.status).toBe("more");
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, ahead)))[0]!.archivedAt).not.toBeNull();
    expect(await blockStatus("only")).toBe("active");
    expect(await statusOf("line")).toBe("active");
  });

  it("a plan stopped already isn't written again", async () => {
    const earlier = "2026-09-01T00:00:00.000Z";
    await plan("line", { status: "retired", updatedAt: earlier });
    await block("only", "line", week(0), week(0, 6));
    await chunk("only");
    expect((await db.select().from(programs).where(eq(programs.id, "line")))[0]!.updatedAt).toBe(earlier);
  });

  it("a block of another account's, named by mistake, stops none of mine", async () => {
    const other = await makeTestUser(db);
    await plan("line");
    await block("theirs", "line", week(-3), week(-2), "retired", other.userId);
    await planStoppedIfNoBlockLeft(db, { userId, today: MON, now: NOW }, { block: "theirs" });
    expect(await statusOf("line")).toBe("active");
  });

  it("the thread coach's retire (`applyOps`) too", async () => {
    await plan("line");
    await block("only", "line", week(0), week(0, 6));
    const ahead = await sessionOf("only", week(0, 3));
    statements.length = 0;
    await applyOps(db, userId, prefs, "p-sync", [{ kind: "retirePlan", planId: "only" } as CoachOp]);
    expect(statements.filter((s) => s.startsWith('update "programs" set "status"'))).toHaveLength(1);
    expect(await blockStatus("only")).toBe("retired");
    expect(await statusOf("line")).toBe("retired");
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, ahead)))[0]!.archivedAt).not.toBeNull();
  });

  it("the thread coach's retire of one phase leaves the plan running", async () => {
    await twoPhases();
    await applyOps(db, userId, prefs, "p-sync", [{ kind: "retirePlan", planId: "line-now" } as CoachOp]);
    expect(await statusOf("line")).toBe("active");
  });

  it("a block with no plan, or another account's or another kind's plan, is left alone", async () => {
    await block("loose", null, week(0), week(0, 6));
    expect((await chunk("loose")).status).toBe("done");
    await plan("a-course", { kind: "course" });
    await block("odd", "a-course", week(0), week(0, 6));
    await chunk("odd");
    expect(await statusOf("a-course")).toBe("active");
    const other = await makeTestUser(db);
    await plan("theirs", {}, other.userId);
    await block("mine-naming-theirs", "theirs", week(0), week(0, 6));
    await chunk("mine-naming-theirs");
    expect(await statusOf("theirs")).toBe("active");
  });

  it("another account's block naming my plan doesn't keep it running", async () => {
    const other = await makeTestUser(db);
    await plan("line");
    await block("mine", "line", week(0), week(0, 6));
    await block("theirs", "line", week(0), week(4), "active", other.userId);
    await chunk("mine");
    expect(await statusOf("line")).toBe("retired");
  });
});

describe("`POST /api/plans/:id/stop` on a coach plan", () => {
  it("every live block goes and the plan with them", async () => {
    await twoPhases();
    expect(await (await stopRoute("line")).json()).toEqual({ more: false });
    expect(await statusOf("line")).toBe("retired");
  });

  it("three blocks, as measured: within a request, at one statement more a block", async () => {
    await plan("line");
    for (const [i, id] of ["c1", "c2", "c3"].entries()) await block(id, "line", week(i), week(i, 6));
    for (let i = 0; i < 12; i++) await sessionOf(["c1", "c2", "c3"][Math.floor(i / 7)]!, addDays(MON, i));
    statements.length = 0;
    expect(await (await stopRoute("line")).json()).toEqual({ more: false });
    expect(statements.length).toBeLessThanOrEqual(45);
    // Beside what it spent before this ruling: 22.
    expect(statements).toHaveLength(25);
    expect(PLAN_STOP_FIXED).toBe(6);
  });

  it("nothing live: the plan is stopped all the same, in one write and with no receipt", async () => {
    await plan("line");
    await block("over", "line", week(-3), week(-1, 6), "completed");
    await block("stopped", "line", week(0), week(0, 6), "retired");
    statements.length = 0;
    const res = await stopRoute("line");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ more: false });
    expect(statements.filter(isWrite)).toHaveLength(1);
    expect(await statusOf("line")).toBe("retired");
    expect(await db.select().from(coachMessages).where(eq(coachMessages.userId, userId))).toEqual([]);
    expect(await blockStatus("over")).toBe("completed");
  });

  it("a coach plan with no blocks is still refused, and left as it was", async () => {
    await plan("studio-held", { source: { studioPlanId: "sp-1" } });
    expect((await stopRoute("studio-held")).status).toBe(409);
    expect(await statusOf("studio-held")).toBe("active");
  });
});

describe("a Studio plan's retire", () => {
  const retire = (studioPlanId: string, alreadyRetired = false) => retireStudioPlan(db, { userId, studioPlanId, today: MON, alreadyRetired });

  it("stops the row that holds it, and only that", async () => {
    await plan("held", { source: { studioPlanId: "sp-1" } });
    await plan("other", { source: { studioPlanId: "sp-2" } });
    expect((await retire("sp-1")).ok).toBe(true);
    expect(await statusOf("held")).toBe("retired");
    expect(await statusOf("other")).toBe("active");
  });

  it("another account's row with that id is left alone", async () => {
    const other = await makeTestUser(db);
    await plan("theirs", { source: { studioPlanId: "sp-1" } }, other.userId);
    await retire("sp-1");
    expect(await statusOf("theirs")).toBe("active");
  });

  it("with no row yet it does what it did", async () => {
    expect((await retire("sp-none")).ok).toBe(true);
  });

  it("a row whose source doesn't read is passed over, and doesn't throw", async () => {
    await plan("odd");
    (db as unknown as { $client: { prepare(sql: string): { run(...a: unknown[]): void } } }).$client.prepare("update programs set source = '{not json' where id = ?").run("odd");
    await plan("held", { source: { studioPlanId: "sp-1" } });
    expect((await retire("sp-1")).ok).toBe(true);
    expect(await statusOf("held")).toBe("retired");
  });
});

describe("the registry's backfill corrects a row out of step, and nothing else", () => {
  const backfill = () => backfillPlanRegistry(db, userId, MON, "America/Los_Angeles");

  it("a plan whose blocks were stopped goes retired, at one statement", async () => {
    await plan("drifted");
    await block("a", "drifted", week(-2), week(-1, 6), "completed");
    await block("b", "drifted", week(0), week(0, 6), "retired");
    statements.length = 0;
    await backfill();
    expect(await statusOf("drifted")).toBe("retired");
    expect(statements.filter((s) => s.startsWith('update "programs" set "status"'))).toHaveLength(1);
  });

  it("then writes nothing more about it", async () => {
    await plan("drifted");
    await block("b", "drifted", week(0), week(0, 6), "retired");
    await backfill();
    statements.length = 0;
    await backfill();
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("a running line stays running: a phase stopped beside one still live, or one to come", async () => {
    await plan("running");
    await block("r1", "running", week(0), week(1, 6));
    await plan("half");
    await block("h1", "half", week(-1), week(0, 6), "retired");
    await block("h2", "half", week(1), week(2, 6));
    await plan("draft-next");
    await block("d1", "draft-next", week(-1), week(-1, 6), "retired");
    await block("d2", "draft-next", week(1), week(2, 6), "draft");
    statements.length = 0;
    await backfill();
    for (const id of ["running", "half", "draft-next"]) expect(await statusOf(id), id).toBe("active");
    expect(statements.filter((s) => s.startsWith('update "programs" set "status"'))).toEqual([]);
  });

  describe("a line is stopped only when its last-ending block was (R38)", () => {
    /** A next phase naming the plan, as propose_plan's refusal tells the coach to. */
    const continuing = (planId: string) =>
      applyStructuralChunk(db, {
        userId,
        proposalId: "p-next",
        opIndex: 0,
        op: { kind: "createPlan", discipline: "run", name: "Next phase", continuesPlanId: planId, startDate: week(0), endDate: week(2, 6), firmSessions: [], shapeWeeks: [] } as unknown as CoachOp,
        progress: null,
        budget: 40,
        now: AT,
        prefs,
      });

    it("a phase retired early, and the rest ran to its end: nobody stopped the plan, so it stays running and can be continued", async () => {
      await plan("line");
      await block("early", "line", week(-6), week(-4), "retired");
      await block("rest", "line", week(-3), week(-1, 6), "completed");
      await backfill();
      expect(await statusOf("line")).toBe("active");
      expect((await continuing("line")).status).not.toBe("refused");
      expect((await db.select().from(coachPlans).where(eq(coachPlans.name, "Next phase")))[0]!.programId).toBe("line");
    });

    it("the same with the rest still marked active, a day past its end, before the hourly sweep flips it", async () => {
      await plan("line");
      await block("early", "line", week(-6), week(-4), "retired");
      await block("rest", "line", week(-3), week(-1, 6));
      await backfill();
      expect(await statusOf("line")).toBe("active");
    });

    it("a line whose last block really was stopped is corrected", async () => {
      await plan("line");
      await block("only", "line", week(-1), week(1), "retired");
      await backfill();
      expect(await statusOf("line")).toBe("retired");
    });

    it("a line stopped, with an earlier phase that ran to its end, is corrected too", async () => {
      await plan("line");
      await block("ran", "line", week(-6), week(-3), "completed");
      await block("stopped", "line", week(-2), week(2), "retired");
      await backfill();
      expect(await statusOf("line")).toBe("retired");
      expect((await continuing("line")).status).toBe("refused");
    });

    it("two blocks ending on one day: both have to have been stopped", async () => {
      await plan("tied");
      await block("t1", "tied", week(-3), week(-1), "retired");
      await block("t2", "tied", week(-2), week(-1), "completed");
      await plan("both");
      await block("b1", "both", week(-3), week(-1), "retired");
      await block("b2", "both", week(-2), week(-1), "retired");
      await backfill();
      expect(await statusOf("tied")).toBe("active");
      expect(await statusOf("both")).toBe("retired");
    });

    it("its last-ending block stopped, and another still running beside it: it's still running", async () => {
      await plan("line");
      await block("beside", "line", week(-1), week(1));
      await block("later", "line", week(0), week(3), "retired");
      statements.length = 0;
      await backfill();
      expect(await statusOf("line")).toBe("active");
      // Not even tried.
      expect(statements.filter((s) => s.startsWith('update "programs" set "status"'))).toEqual([]);
    });
  });

  it("a line that simply ran to its end isn't stopped: ended is computed, and nobody ended this one", async () => {
    await plan("finished");
    await block("f1", "finished", week(-6), week(-4, 6), "completed");
    await block("f2", "finished", week(-3), week(-1, 6), "active");
    await backfill();
    expect(await statusOf("finished")).toBe("active");
  });

  it("a plan with no blocks is no drift, nor is one of another kind or another account's", async () => {
    await plan("bare");
    await plan("a-programme", { kind: "adaptive" });
    await block("odd", "a-programme", week(0), week(0, 6), "retired");
    const other = await makeTestUser(db);
    await plan("theirs", {}, other.userId);
    await block("t1", "theirs", week(0), week(0, 6), "retired", other.userId);
    statements.length = 0;
    await backfill();
    for (const id of ["bare", "a-programme", "theirs"]) expect(await statusOf(id), id).toBe("active");
    // Not even tried.
    expect(statements.filter((s) => s.startsWith('update "programs" set "status"'))).toEqual([]);
  });

  it("a block of another account's naming a plan doesn't count for or against it", async () => {
    const other = await makeTestUser(db);
    await plan("mine");
    await block("m1", "mine", week(0), week(0, 6), "retired");
    await block("t1", "mine", week(0), week(4), "active", other.userId);
    await backfill();
    expect(await statusOf("mine")).toBe("retired");
  });

  it("a Studio plan the athlete retired, its row still saying running", async () => {
    await plan("held", { source: { studioPlanId: "sp-1" } });
    await db.insert(auditEvents).values({ id: newId(), userId, kind: STUDIO_PLAN_RETIRED, detail: { studioPlanId: "sp-1" }, createdAt: NOW });
    await backfill();
    expect(await statusOf("held")).toBe("retired");
  });

  it("a Studio plan nobody retired stays as it is", async () => {
    await plan("held", { source: { studioPlanId: "sp-1" } });
    await backfill();
    expect(await statusOf("held")).toBe("active");
  });

  describe("the Studio's mark is read only for a row that might be out of step", () => {
    const markReads = () => statements.filter((s) => s.startsWith('select "id" from "audit_events"'));

    it("read for a running row that holds some other plan", async () => {
      await plan("held", { source: { studioPlanId: "sp-1" } });
      statements.length = 0;
      await backfill();
      expect(markReads()).toHaveLength(1);
    });

    it("not for the plan on the list: it isn't retired, or it wouldn't be listed", async () => {
      await db.insert(studioPlans).values({ id: "sp-listed", userId, brief: { startDate: MON, durationWeeks: 4 }, plan: { name: "Lifting" }, version: 1, createdAt: NOW, updatedAt: NOW });
      await db.insert(studioPlanPushes).values({ id: newId(), planId: "sp-listed", planVersion: 1, happenDay: week(1), sessionTitle: "Lift", corosPlanId: "src-container", status: "verified", updatedAt: NOW });
      await plan("held", { source: { studioPlanId: "sp-listed" } });
      statements.length = 0;
      await backfill();
      expect(markReads()).toEqual([]);
    });

    it("not for another kind, or a row already stopped", async () => {
      await plan("a-programme", { kind: "adaptive", source: { studioPlanId: "sp-1" } });
      await plan("stopped", { status: "retired", source: { studioPlanId: "sp-2" } });
      statements.length = 0;
      await backfill();
      expect(markReads()).toEqual([]);
    });

    it("and never past the budget", async () => {
      for (let i = 0; i < 60; i++) await plan(`held-${i}`, { source: { studioPlanId: `sp-${i}` } });
      statements.length = 0;
      await backfill();
      expect(statements.length).toBeLessThanOrEqual(45);
    });
  });

  it("stays within its budget with many out of step: what doesn't fit waits for the next hour", async () => {
    for (let i = 0; i < 50; i++) {
      await plan(`p${i}`);
      await block(`b${i}`, `p${i}`, week(0), week(0, 6), "retired");
    }
    statements.length = 0;
    await backfill();
    expect(statements.length).toBeLessThanOrEqual(45);
    const still = (await db.select().from(programs).where(eq(programs.userId, userId))).filter((p) => p.status === "active");
    expect(still.length).toBeGreaterThan(0);
    expect(still.length).toBeLessThan(50);
  });

  it("a restore in progress: nothing is corrected", async () => {
    await plan("drifted");
    await block("b", "drifted", week(0), week(0, 6), "retired");
    await db.insert(schema.accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });
    await backfill();
    expect(await statusOf("drifted")).toBe("active");
  });
});
