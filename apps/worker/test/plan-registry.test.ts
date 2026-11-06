/**
 * The registry's backfill (plans with a purpose, Stage 1): every existing plan gets a `programs` row, once, within
 * the free plan's statement budget. All names and dates here are made up.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, addDays, linesOf, newId } from "@rg/domain";
import { lineBlockOf } from "../src/services/coach-plans.js";
import type { Db } from "../src/services/db.js";
import { listPrograms } from "../src/services/programs.js";
import { backfillPlanRegistry, listPlans } from "../src/services/plan-registry.js";
import { placeSlotsForAllPrograms } from "../src/services/program-slots.js";
import { readStandRows } from "../src/services/where-you-stand.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const { coachPlans, programs, accountState, studioPlans, studioPlanPushes, trainingPlans } = schema;
const NOW = "2026-10-05T12:00:00.000Z";
const TODAY = "2026-10-05";

let db: Db;
let statements: string[];
let userId: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId } = await makeTestUser(db));
});

async function block(id: string, discipline: "run" | "lift" | "mobility", startDate: string, endDate: string, extra: { status?: string; name?: string } = {}) {
  await db.insert(coachPlans).values({
    id,
    userId,
    discipline,
    name: extra.name ?? `Block ${id}`,
    status: extra.status ?? "active",
    startDate,
    endDate,
    raceDate: null,
    stampPrefix: id,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

const rows = () => db.select().from(programs).where(eq(programs.userId, userId));
const linkOf = async (id: string) => (await db.select().from(coachPlans).where(eq(coachPlans.id, id)))[0]!.programId;

async function studioWithContainer(withContainer: boolean): Promise<string> {
  const studioId = newId();
  await db.insert(studioPlans).values({
    id: studioId,
    userId,
    brief: { startDate: "2026-10-05", durationWeeks: 4 },
    plan: { name: "Synthetic lifting" },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(studioPlanPushes).values({
    id: newId(),
    planId: studioId,
    planVersion: 1,
    happenDay: "2026-10-06",
    sessionTitle: "Session A",
    corosPlanId: "src-container",
    status: "verified",
    updatedAt: NOW,
  });
  if (withContainer) {
    await db.insert(trainingPlans).values({
      id: "container-1",
      userId,
      provider: "coros",
      sourcePlanId: "src-container",
      name: "Container",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return studioId;
}

describe("backfillPlanRegistry", () => {
  it("makes one plan of abutting blocks and links every block to it", async () => {
    await block("b1", "run", "2026-09-07", "2026-09-20", { name: "Base" });
    await block("b2", "run", "2026-09-21", "2026-10-04", { name: "Build" });
    await block("b3", "run", "2026-10-05", "2026-10-18", { name: "Peak" });

    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 1, linked: 3 });

    const [plan, ...rest] = await rows();
    expect(rest).toEqual([]);
    expect(plan).toMatchObject({
      id: "plan-b1",
      kind: "coach",
      name: "Running", // a many-phase line is named for its sport, as the plan list names it
      status: "active",
      disciplines: ["run"],
      startDate: null, // dates are computed from the blocks, never stored: a later block would leave them stale
      endDate: null,
      raceDate: null,
      onEnd: "ask", // running asks what comes next
      config: {},
    });
    for (const id of ["b1", "b2", "b3"]) expect(await linkOf(id)).toBe("plan-b1");
  });

  it("names a one-phase line for its block, and speaks strength and yoga for lift and mobility", async () => {
    await block("l1", "lift", "2026-10-05", "2026-10-18", { name: "Heavy" });
    await block("m1", "mobility", "2026-10-05", "2026-10-18", { name: "Loose" });

    await backfillPlanRegistry(db, userId, TODAY);

    const byId = new Map((await rows()).map((r) => [r.id, r]));
    expect(byId.get("plan-l1")).toMatchObject({ name: "Heavy", disciplines: ["strength"], onEnd: "continue" });
    expect(byId.get("plan-m1")).toMatchObject({ name: "Loose", disciplines: ["yoga"], onEnd: "continue" });
  });

  it("is idempotent: a second call returns zeros and writes nothing", async () => {
    await block("b1", "run", "2026-10-05", "2026-10-18");
    await backfillPlanRegistry(db, userId, TODAY);
    const before = await rows();
    statements.length = 0;

    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 0, linked: 0 });

    expect(statements.filter(isWrite)).toEqual([]);
    expect(await rows()).toEqual(before);
  });

  it("joins a block added later to its line's existing plan", async () => {
    await block("b1", "run", "2026-10-05", "2026-10-18");
    await backfillPlanRegistry(db, userId, TODAY);
    await block("b2", "run", "2026-10-19", "2026-11-01");

    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 0, linked: 1 });

    expect(await linkOf("b2")).toBe("plan-b1");
    expect(await rows()).toHaveLength(1);
  });

  it("leaves a retired block unlinked", async () => {
    await block("b1", "run", "2026-10-05", "2026-10-18");
    await block("gone", "run", "2026-10-19", "2026-11-01", { status: "retired" });

    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 1, linked: 1 });

    expect(await linkOf("gone")).toBeNull();
  });

  it("gives an adhoc- bucket no plan", async () => {
    await block("adhoc-run", "run", "2026-10-05", "2026-10-06");

    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 0, linked: 0 });

    expect(await rows()).toEqual([]);
    expect(await linkOf("adhoc-run")).toBeNull();
  });

  it("gives the Studio's plan the id of its sessions' container", async () => {
    const studioId = await studioWithContainer(true);

    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 1, linked: 0 });

    const [plan] = await rows();
    expect(plan).toMatchObject({
      id: "container-1",
      kind: "coach",
      name: "Synthetic lifting",
      disciplines: ["strength"],
      source: { studioPlanId: studioId },
      startDate: null,
      endDate: null,
      raceDate: null,
      onEnd: "continue",
    });
    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 0, linked: 0 });
  });

  it("stores status active for an ended line and a completed Studio plan: ended is computed, never stored", async () => {
    await block("old", "run", "2026-01-05", "2026-01-18");
    await studioWithContainer(true);

    // A day after both have ended.
    await backfillPlanRegistry(db, userId, "2026-12-01");

    const byId = new Map((await rows()).map((r) => [r.id, r.status]));
    expect(byId.get("plan-old")).toBe("active");
    expect(byId.get("container-1")).toBe("active");
  });

  it("makes nothing of a Studio plan with no container yet", async () => {
    await studioWithContainer(false);

    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 0, linked: 0 });

    expect(await rows()).toEqual([]);
  });

  it("makes a coros_import plan of a listed COROS running plan, under its own id", async () => {
    await db.insert(trainingPlans).values({
      id: "coros-run-1",
      userId,
      provider: "coros",
      sourcePlanId: "src-run",
      name: "Synthetic 10K",
      startDate: "2026-09-01",
      endDate: "2026-12-31",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(schema.plannedWorkouts).values({
      id: "w-run",
      userId,
      planId: "coros-run-1",
      sourceWorkoutId: "src-run:w1",
      title: "Easy",
      category: "easy",
      sport: "run",
      originalPlanDate: "2099-01-01",
      lastVerifiedCorosDate: "2099-01-01",
      effectiveDate: "2099-01-01",
      effectiveTime: "07:00",
      completionState: "scheduled",
      sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 3600,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 1, linked: 0 });

    expect((await rows())[0]).toMatchObject({ id: "coros-run-1", kind: "coros_import", name: "Synthetic 10K", disciplines: ["run"], onEnd: "ask", startDate: null, endDate: null, raceDate: null });
  });

  it("sets an adaptive programme's ending to continue, and only when it has none", async () => {
    const mk = (id: string, onEnd: string | null) =>
      db.insert(programs).values({
        id,
        userId,
        kind: "adaptive",
        name: id,
        status: "active",
        disciplines: ["yoga"],
        config: adaptiveConfigSchema.parse({ weeklyGoal: 3, preferredDays: [0, 2, 4], placementWeeksAhead: 1 }),
        onEnd,
        createdAt: NOW,
        updatedAt: NOW,
      });
    await mk("a-null", null);
    await mk("a-set", "continue");

    await backfillPlanRegistry(db, userId, TODAY);

    const byId = new Map((await rows()).map((r) => [r.id, r.onEnd]));
    expect(byId.get("a-null")).toBe("continue");
    expect(byId.get("a-set")).toBe("continue");
  });

  it("leaves the adaptive listing and slot placement seeing only the adaptive programme", async () => {
    await db.insert(programs).values({
      id: "adaptive-1",
      userId,
      kind: "adaptive",
      name: "Mobility",
      status: "active",
      disciplines: ["yoga"],
      config: adaptiveConfigSchema.parse({ weeklyGoal: 3, preferredDays: [0, 2, 4], placementWeeksAhead: 1 }),
      createdAt: NOW,
      updatedAt: NOW,
    });
    await block("b1", "run", "2026-10-05", "2026-10-18");
    await backfillPlanRegistry(db, userId, TODAY);

    expect((await listPrograms(db, userId, TODAY)).map((p) => p.id)).toEqual(["adaptive-1"]);
    expect(await placeSlotsForAllPrograms(db, new Date(NOW))).toMatchObject({ programs: 1, failed: 0 });
  });

  it("writes nothing while a restore is replacing the account", async () => {
    await block("b1", "run", "2026-10-05", "2026-10-18");
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });
    statements.length = 0;

    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 0, linked: 0 });

    expect(statements.filter(isWrite)).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(await linkOf("b1")).toBeNull();
  });

  it("stays within 45 statements with 40 blocks, and finishes over the next calls", async () => {
    // Forty blocks a month apart: forty lines, which no single call can afford.
    for (let i = 0; i < 40; i++) {
      const start = new Date(Date.UTC(2026, 0, 1) + i * 40 * 86_400_000).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(2026, 0, 1) + (i * 40 + 6) * 86_400_000).toISOString().slice(0, 10);
      await block(`b${String(i).padStart(2, "0")}`, "lift", start, end);
    }
    statements.length = 0;

    const first = await backfillPlanRegistry(db, userId, "2026-01-01");

    expect(statements.length).toBeLessThanOrEqual(45);
    expect(first.created).toBeGreaterThan(0);
    expect(first.created).toBeLessThan(40);
    expect(first.linked).toBe(first.created);
    let total = first.created;
    for (let i = 0; i < 5 && total < 40; i++) {
      statements.length = 0;
      total += (await backfillPlanRegistry(db, userId, "2026-01-01")).created;
      expect(statements.length).toBeLessThanOrEqual(45);
    }
    expect(total).toBe(40);
    expect(await rows()).toHaveLength(40);
  });
});

/**
 * A stop from before the registry could say so (R38). An old account's retired block carries no link, since the backfill works
 * from `linesOf`, which drops it. So only the dates tie it to a plan: a line is stopped when, retired blocks counted, its
 * last-ending block is retired and nothing of it is left to run. TODAY is 2026-10-05, so everything below that's "behind" ended
 * before it.
 */
describe("a plan stopped before the registry", () => {
  const statusOf = async (id: string) => (await rows()).find((r) => r.id === id)?.status;
  /** A row already made by an earlier pass, as `plan-<first block>`, its live blocks linked. */
  const existingRow = async (id: string, linked: readonly string[] = []) => {
    await db.insert(programs).values({ id, userId, kind: "coach", name: id, status: "active", disciplines: ["run"], config: {}, onEnd: "ask", createdAt: NOW, updatedAt: NOW });
    for (const b of linked) await db.update(coachPlans).set({ programId: id }).where(eq(coachPlans.id, b));
  };
  const pass = () => backfillPlanRegistry(db, userId, TODAY);
  /** The pass writes nothing more. */
  const settled = async () => {
    const before = await rows();
    statements.length = 0;
    expect(await pass()).toEqual({ created: 0, linked: 0 });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await rows()).toEqual(before);
  };

  describe("wholly retired, with no row: nothing lists it, so it gets none", () => {
    it("one block in the past: no row, no link, nothing written, and the plans read says nothing of it", async () => {
      await block("r1", "run", "2026-09-01", "2026-09-14", { status: "retired" });
      statements.length = 0;
      expect(await pass()).toEqual({ created: 0, linked: 0 });
      expect(statements.filter(isWrite)).toEqual([]);
      expect(await rows()).toEqual([]);
      expect(await linkOf("r1")).toBeNull();
      expect(await listPlans(db, userId, TODAY)).toEqual([]);
    });

    it("two adjacent phases: the same", async () => {
      await block("r1", "run", "2026-08-17", "2026-08-30", { status: "retired" });
      await block("r2", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      statements.length = 0;
      expect(await pass()).toEqual({ created: 0, linked: 0 });
      expect(statements.filter(isWrite)).toEqual([]);
      expect(await rows()).toEqual([]);
    });
  });

  describe("with a row already, named for its first block and holding no link", () => {
    it("one block in the past goes retired", async () => {
      await block("r1", "run", "2026-09-01", "2026-09-14", { status: "retired" });
      await existingRow("plan-r1");
      await pass();
      expect(await statusOf("plan-r1")).toBe("retired");
      await settled();
    });

    it("two adjacent phases go retired", async () => {
      await block("r1", "run", "2026-08-17", "2026-08-30", { status: "retired" });
      await block("r2", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await existingRow("plan-r1");
      await pass();
      expect(await statusOf("plan-r1")).toBe("retired");
      await settled();
    });

    it("a row with no blocks of its own, as the Studio's has none, stays as it is through every pass", async () => {
      await studioWithContainer(true);
      await pass();
      await pass();
      await pass();
      expect((await rows()).map((r) => [r.id, r.status])).toEqual([["container-1", "active"]]);
    });

    it("the block its id names is another plan's once it's linked to that one", async () => {
      await block("x", "run", "2026-09-01", "2026-09-14", { status: "retired" });
      await existingRow("plan-other", ["x"]);
      await existingRow("plan-x");
      await pass();
      expect(await statusOf("plan-x")).toBe("active");
      expect(await statusOf("plan-other")).toBe("retired");
    });

    it("another account's stopped block beside it is nothing to do with this one", async () => {
      await block("r1", "run", "2026-09-01", "2026-09-14");
      await existingRow("plan-r1");
      const other = await makeTestUser(db);
      await db.insert(coachPlans).values({ id: "their-r1", userId: other.userId, discipline: "run", name: "x", status: "retired", startDate: "2026-09-15", endDate: "2026-09-28", raceDate: null, stampPrefix: "x", createdAt: NOW, updatedAt: NOW });
      await pass();
      expect(await statusOf("plan-r1")).toBe("active");
    });
  });

  describe("a phase that ran, then a stopped one: the case an old account really has", () => {
    it("the first pass makes the plan already stopped, the retired phase still unlinked, and the next pass has nothing to do", async () => {
      await block("a", "run", "2026-08-17", "2026-08-30", { name: "Base" });
      await block("r", "run", "2026-08-31", "2026-09-13", { status: "retired", name: "Build" });
      expect(await pass()).toEqual({ created: 1, linked: 1 });
      expect((await rows())[0]).toMatchObject({ id: "plan-a", status: "retired", name: "Base" });
      expect(await linkOf("a")).toBe("plan-a");
      expect(await linkOf("r")).toBeNull();
      await settled();
    });

    it("a row a pass already left active is corrected once, then settles", async () => {
      await block("a", "run", "2026-08-17", "2026-08-30");
      await block("r", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await existingRow("plan-a", ["a"]);
      statements.length = 0;
      await pass();
      expect(statements.filter(isWrite)).toHaveLength(1);
      expect(await statusOf("plan-a")).toBe("retired");
      await settled();
    });

    it("through more than one stopped phase", async () => {
      await block("a", "run", "2026-08-03", "2026-08-16");
      await block("r1", "run", "2026-08-17", "2026-08-30", { status: "retired" });
      await block("r2", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await pass();
      expect(await statusOf("plan-a")).toBe("retired");
      await settled();
    });

    it("the chain's own rest: eight days after its end still joins, nine don't", async () => {
      await block("near", "run", "2026-08-01", "2026-08-14");
      await block("near-r", "run", "2026-08-22", "2026-08-30", { status: "retired" });
      await block("far", "lift", "2026-08-01", "2026-08-14");
      await block("far-r", "lift", "2026-08-23", "2026-08-30", { status: "retired" });
      await pass();
      await pass();
      expect(await statusOf("plan-near")).toBe("retired");
      expect(await statusOf("plan-far")).toBe("active");
    });

    it("the stopped phase overlapping it and ending later counts; one ending inside it doesn't", async () => {
      await block("long", "run", "2026-08-01", "2026-08-30");
      await block("over", "run", "2026-08-20", "2026-09-10", { status: "retired" });
      await block("lift-long", "lift", "2026-08-01", "2026-08-30");
      await block("inside", "lift", "2026-08-10", "2026-08-20", { status: "retired" });
      await pass();
      expect(await statusOf("plan-long")).toBe("retired");
      expect(await statusOf("plan-lift-long")).toBe("active");
    });
  });

  describe("still a plan that may be continued (R38)", () => {
    it("a retired phase followed by a live one stays active", async () => {
      await block("r", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await block("b", "run", "2026-09-14", "2026-10-18");
      expect(await pass()).toEqual({ created: 1, linked: 1 });
      expect(await statusOf("plan-b")).toBe("active");
      expect(await linkOf("r")).toBeNull();
      await settled();
    });

    it("a retired phase followed by one that ran to its natural end stays active", async () => {
      await block("r", "run", "2026-08-17", "2026-08-30", { status: "retired" });
      await block("b", "run", "2026-08-31", "2026-09-13");
      await pass();
      await pass();
      expect(await statusOf("plan-b")).toBe("active");
      await settled();
    });

    it("a retired phase and one that ran, ending the same day: both must be retired", async () => {
      await block("a", "run", "2026-08-17", "2026-09-13");
      await block("r", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await pass();
      await pass();
      expect(await statusOf("plan-a")).toBe("active");
    });

    it("a stopped phase ending later, with a phase of the plan still to run: not stopped", async () => {
      await block("a", "run", "2026-09-28", "2026-10-18");
      await block("r", "run", "2026-10-10", "2026-11-01", { status: "retired" });
      await pass();
      await pass();
      expect(await statusOf("plan-a")).toBe("active");
      await settled();
    });

    it("a stopped phase of another sport is no phase of this plan", async () => {
      await block("a", "run", "2026-08-17", "2026-08-30");
      await block("r", "lift", "2026-08-31", "2026-09-13", { status: "retired" });
      await pass();
      await pass();
      expect(await statusOf("plan-a")).toBe("active");
    });

    it("a one-off bucket's retired row is no phase of it", async () => {
      await block("a", "run", "2026-08-17", "2026-08-30");
      await block("adhoc-run", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await pass();
      await pass();
      expect(await statusOf("plan-a")).toBe("active");
    });

    it("a block about to join it counts: not retired, unlinked, later than the stopped one", async () => {
      await block("a", "run", "2026-08-03", "2026-08-16");
      await existingRow("plan-a", ["a"]);
      await block("r", "run", "2026-08-17", "2026-08-20", { status: "retired" });
      await block("next", "run", "2026-08-21", "2026-09-13");
      await pass();
      expect(await statusOf("plan-a")).toBe("active");
      expect(await linkOf("next")).toBe("plan-a");
    });
  });

  describe("two plans of one sport", () => {
    it("a stopped plan from months earlier neither retires a later one nor merges with it: it stays as it was, a retired block with no row", async () => {
      await block("old", "run", "2026-03-02", "2026-03-15", { status: "retired" });
      await block("later", "run", "2026-09-07", "2026-10-18");
      expect(await pass()).toEqual({ created: 1, linked: 1 });
      expect(await rows()).toHaveLength(1);
      expect(await statusOf("plan-later")).toBe("active");
      expect(await linkOf("old")).toBeNull();
      await settled();
    });

    it("nor one that has simply ended: months between, and the later line is its own", async () => {
      await block("old", "run", "2026-03-02", "2026-03-15", { status: "retired" });
      await block("later", "run", "2026-08-03", "2026-08-16");
      await pass();
      await pass();
      expect(await statusOf("plan-later")).toBe("active");
    });

    it("nor does a stop months after a plan ended reach back to it", async () => {
      await block("ended", "run", "2026-03-02", "2026-03-15");
      await block("stopped-later", "run", "2026-08-03", "2026-08-16", { status: "retired" });
      await pass();
      await pass();
      expect(await statusOf("plan-ended")).toBe("active");
      expect(await rows()).toHaveLength(1);
    });

    it("another plan's own stopped block is its stop, not this one's", async () => {
      await block("mine", "run", "2026-08-17", "2026-08-30");
      await block("theirs", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await existingRow("plan-mine", ["mine"]);
      await existingRow("plan-theirs", ["theirs"]);
      await pass();
      expect(await statusOf("plan-mine")).toBe("active");
      expect(await statusOf("plan-theirs")).toBe("retired");
    });

    it("a stopped phase between two lines, the later one running on: neither is stopped", async () => {
      await block("first", "run", "2026-06-01", "2026-06-14");
      await block("between", "run", "2026-06-15", "2026-08-30", { status: "retired" });
      await block("second", "run", "2026-08-31", "2026-10-18");
      await pass();
      await pass();
      expect(await rows()).toHaveLength(2);
      expect(await statusOf("plan-first")).toBe("active");
      expect(await statusOf("plan-second")).toBe("active");
    });
  });

  describe("what reads it", () => {
    it("the plans read says stopped, and a line it still lists has ended, so Past plans reads it by date as the status says", async () => {
      await block("a", "run", "2026-08-17", "2026-08-30");
      await block("r", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await pass();
      const [plan, ...none] = await listPlans(db, userId, TODAY);
      expect(none).toEqual([]);
      expect(plan).toMatchObject({ id: "plan-a", status: "retired" });
      const lines = linesOf((await db.select().from(coachPlans).where(eq(coachPlans.userId, userId))).map(lineBlockOf), TODAY);
      expect(lines.map((l) => [l.key, l.ended])).toEqual([[plan!.lineKey, true]]);
      expect(lines[0]!.phases.map((p) => p.id)).toEqual(["a"]);
    });

    it("where you stand leaves it out", async () => {
      await block("a", "run", "2026-08-17", "2026-10-18");
      await block("r", "run", "2026-08-31", "2026-11-01", { status: "retired" });
      await pass();
      expect(await statusOf("plan-a")).toBe("active");
      expect(JSON.stringify((await readStandRows(db, userId, TODAY, { library: false })).plans)).toContain("plan-a");
      // Its last live phase over, and the later one stopped.
      const later = "2026-10-20";
      await backfillPlanRegistry(db, userId, later);
      expect(await statusOf("plan-a")).toBe("retired");
      expect(JSON.stringify((await readStandRows(db, userId, later, { library: false })).plans)).not.toContain("plan-a");
    });

    it("a row made stopped stays stopped: a later pass never brings a coach plan back", async () => {
      await block("a", "run", "2026-08-17", "2026-08-30");
      await block("r", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await pass();
      await db.update(coachPlans).set({ status: "active" }).where(eq(coachPlans.id, "r"));
      await pass();
      expect(await statusOf("plan-a")).toBe("retired");
    });

    it("a pass with nothing drifted costs what it did: its reads alone, 5 with no watch plan", async () => {
      await block("a", "run", "2026-08-17", "2026-08-30");
      await block("r", "run", "2026-08-31", "2026-09-13", { status: "retired" });
      await block("b", "lift", "2026-09-07", "2026-10-18");
      await pass();
      await pass();
      statements.length = 0;
      await pass();
      expect(statements.filter(isWrite)).toEqual([]);
      expect(statements).toHaveLength(5);
    });

    it("with far more stopped plans than a pass may correct, it stays within 45 and finishes over the next passes", async () => {
      const n = 60;
      for (let i = 0; i < n; i++) {
        const key = String(i).padStart(2, "0");
        // A plan every 24 days: 14 of its own, then ten with nothing, which no chain crosses. All long over by TODAY.
        const on = (d: number) => addDays("2022-01-03", i * 24 + d);
        await block(`a${key}`, "lift", on(0), on(6));
        await block(`r${key}`, "lift", on(7), on(13), { status: "retired" });
        await existingRow(`plan-a${key}`, [`a${key}`]);
      }
      for (let i = 0; i < 5; i++) {
        statements.length = 0;
        await pass();
        expect(statements.length).toBeLessThanOrEqual(45);
      }
      expect((await rows()).map((r) => r.status)).toEqual(Array.from({ length: n }, () => "retired"));
      await settled();
    });
  });
});

describe("a watch plan whose import is archived", () => {
  const watchPlan = async (id: string, over: Partial<typeof trainingPlans.$inferInsert> = {}) =>
    db.insert(trainingPlans).values({ id, userId, provider: "coros", sourcePlanId: `src-${id}`, name: "Synthetic 10K", startDate: "2026-09-01", endDate: "2026-12-31", status: "active", createdAt: NOW, updatedAt: NOW, ...over });
  const futureRun = (planId: string) =>
    db.insert(schema.plannedWorkouts).values({
      id: `w-${planId}`, userId, planId, sourceWorkoutId: `src:${planId}`, title: "Easy", category: "easy", sport: "run", originalPlanDate: "2099-01-01", lastVerifiedCorosDate: "2099-01-01",
      effectiveDate: "2099-01-01", effectiveTime: "07:00", completionState: "scheduled", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, createdAt: NOW, updatedAt: NOW,
    });
  const listed = async () => {
    await watchPlan("w1");
    await futureRun("w1");
    await backfillPlanRegistry(db, userId, TODAY);
    expect((await rows())[0]).toMatchObject({ id: "w1", kind: "coros_import", status: "active" });
  };
  const setImport = (set: Partial<typeof trainingPlans.$inferInsert>) => db.update(trainingPlans).set(set).where(eq(trainingPlans.id, "w1"));
  const pass = () => backfillPlanRegistry(db, userId, TODAY);

  it("goes retired, the plans read says so, and the next pass writes nothing", async () => {
    await listed();
    await setImport({ status: "archived", archivedAt: NOW });
    await pass();
    expect((await rows())[0]!.status).toBe("retired");
    expect((await listPlans(db, userId, TODAY))[0]).toMatchObject({ id: "w1", status: "retired" });
    statements.length = 0;
    await pass();
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("archived by its date alone reads the same, as the coach's read has it, and so does its status alone", async () => {
    await listed();
    await setImport({ archivedAt: NOW });
    await pass();
    expect((await rows())[0]!.status).toBe("retired");
    await setImport({ status: "archived", archivedAt: null });
    await pass();
    expect((await rows())[0]!.status).toBe("retired");
    await setImport({ status: "active", archivedAt: null });
    await pass();
    expect((await rows())[0]!.status).toBe("active");
    await setImport({ status: "archived", archivedAt: null });
    await pass();
    expect((await rows())[0]!.status).toBe("retired");
  });

  it("with more to correct than a pass may write, it stays within 45 and finishes over the next passes", async () => {
    const n = 50;
    for (let i = 0; i < n; i++) {
      const id = `w${String(i).padStart(2, "0")}`;
      await watchPlan(id, { status: "archived" });
      await db.insert(programs).values({ id, userId, kind: "coros_import", name: id, status: "active", disciplines: ["run"], config: {}, onEnd: "ask", createdAt: NOW, updatedAt: NOW });
    }
    statements.length = 0;
    await pass();
    expect(statements.length).toBeLessThanOrEqual(45);
    // The reads, no sessions' read with no live watch plan, and as many as fit.
    expect(statements.filter(isWrite)).toHaveLength(39);
    expect((await rows()).filter((r) => r.status === "retired")).toHaveLength(39);
    statements.length = 0;
    await pass();
    expect(statements.length).toBeLessThanOrEqual(45);
    expect((await rows()).filter((r) => r.status === "retired")).toHaveLength(n);
  });

  it("un-archived, it comes back active, and the next pass writes nothing", async () => {
    await listed();
    await setImport({ status: "archived", archivedAt: NOW });
    await pass();
    await setImport({ status: "active", archivedAt: null });
    await pass();
    expect((await rows())[0]!.status).toBe("active");
    statements.length = 0;
    await pass();
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("imported again, COROS's same plan comes in as a new row beside it, which is active: the old row keeps what it says", async () => {
    await listed();
    await setImport({ status: "archived", archivedAt: NOW });
    await pass();
    // What the import does finding no active plan for this COROS plan: a new row, under a new id.
    await watchPlan("w2", { sourcePlanId: "src-w1" });
    await futureRun("w2");
    await pass();
    const byId = new Map((await rows()).map((r) => [r.id, r.status]));
    expect(byId.get("w1")).toBe("retired");
    expect(byId.get("w2")).toBe("active");
  });

  it("a registry row whose import isn't there is left alone, and only a coros_import row is read this way", async () => {
    await listed();
    await db.delete(trainingPlans).where(eq(trainingPlans.id, "w1"));
    // A coach plan that happens to share an id with an archived import of the same account.
    await watchPlan("plan-c", { status: "archived", archivedAt: NOW });
    await block("c", "run", "2026-09-07", "2026-10-18");
    await db.insert(programs).values({ id: "plan-c", userId, kind: "coach", name: "c", status: "active", disciplines: ["run"], config: {}, onEnd: "ask", createdAt: NOW, updatedAt: NOW });
    await pass();
    const byId = new Map((await rows()).map((r) => [r.id, r.status]));
    expect(byId.get("w1")).toBe("active");
    expect(byId.get("plan-c")).toBe("active");
  });

  it("another account's archived import with the same id doesn't reach this one's row", async () => {
    await db.insert(programs).values({ id: "shared-id", userId, kind: "coros_import", name: "w", status: "active", disciplines: ["run"], config: {}, onEnd: "ask", createdAt: NOW, updatedAt: NOW });
    const other = await makeTestUser(db);
    await db.insert(trainingPlans).values({ id: "shared-id", userId: other.userId, provider: "coros", sourcePlanId: "x", name: "x", status: "archived", createdAt: NOW, updatedAt: NOW });
    await pass();
    expect((await rows())[0]!.status).toBe("active");
  });

  it("costs no statement of its own: a pass with nothing drifted is 6 with a watch plan listed, its sessions' read among them", async () => {
    await listed();
    statements.length = 0;
    await pass();
    expect(statements.filter(isWrite)).toEqual([]);
    expect(statements).toHaveLength(6);
  });
});
