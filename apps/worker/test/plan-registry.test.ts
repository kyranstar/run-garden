/**
 * The registry's backfill (plans with a purpose, Stage 1): every existing plan gets a `programs` row, once, within
 * the free plan's statement budget. All names and dates here are made up.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { listPrograms } from "../src/services/programs.js";
import { backfillPlanRegistry } from "../src/services/plan-registry.js";
import { placeSlotsForAllPrograms } from "../src/services/program-slots.js";
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
      startDate: "2026-09-07",
      endDate: "2026-10-18",
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
      startDate: "2026-10-05",
      endDate: "2026-11-01",
      onEnd: "finish",
    });
    expect(await backfillPlanRegistry(db, userId, TODAY)).toEqual({ created: 0, linked: 0 });
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

    expect((await rows())[0]).toMatchObject({ id: "coros-run-1", kind: "coros_import", name: "Synthetic 10K", disciplines: ["run"], onEnd: "ask" });
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
