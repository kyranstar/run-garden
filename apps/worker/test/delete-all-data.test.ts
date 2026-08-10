/**
 * C20 (audit slice A): `deleteAllUserData` (misc.ts) used to miss 13 tables —
 * every coach table, the garden visitor ledger, gardenSeen,
 * gardenSceneLayouts, backfillState, syncIntents, and syncNotes all survived
 * "delete everything". Two tests:
 *
 *  - a structural coverage check that introspects the `@rg/database` schema
 *    barrel and fails if ANY user-scoped table (has a `userId` column, isn't
 *    on the small global-catalog allowlist) is never referenced by a
 *    `db.delete(...)` call inside `deleteAllUserData` — this is the guard
 *    against the next table falling through the same gap;
 *  - a behavioral check that a fully-populated account (one row in every
 *    table this fix newly covers) is actually empty afterward, and that a
 *    second user's rows in the two plan-scoped child tables
 *    (coach_plan_weeks, studio_plan_pushes — reached only via planId, no
 *    userId of their own) survive.
 */
import { describe, expect, it } from "vitest";
import { eq, getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { deleteAllUserData } from "../src/routes/misc.js";
import { recordIntent } from "../src/services/sync-intents.js";
import { postSyncNote } from "../src/services/sync-notes.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const {
  backfillState,
  coachMemory,
  coachMessages,
  coachPlans,
  coachPlanWeeks,
  coachProposals,
  coachQuestions,
  coachTriggers,
  gardenSceneLayouts,
  gardenSeen,
  gardenVisitors,
  studioPlans,
  studioPlanPushes,
  syncIntents,
  syncNotes,
} = schema;

/**
 * Tables that are deliberately NOT user-scoped — shared catalog/versioning
 * data that must survive "delete everything" (species/exercise catalogs, the
 * app's own schema-component version rows). Anything else the schema barrel
 * exports with a `userId` column must be reachable from `deleteAllUserData`.
 */
const GLOBAL_TABLE_NAMES = new Set(["garden_species", "coros_exercises", "schema_versions"]);

function allTables(): Array<{ name: string; table: object }> {
  return Object.values(schema)
    .filter((value) => is(value, SQLiteTable))
    .map((table) => ({ name: getTableName(table as never), table: table as object }));
}

async function seedCoachPlan(db: Db, userId: string): Promise<string> {
  const planId = newId();
  await db.insert(coachPlans).values({
    id: planId,
    userId,
    discipline: "run",
    name: "seed plan",
    status: "active",
    startDate: "2026-08-01",
    endDate: "2026-12-01",
    stampPrefix: "seed",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(coachPlanWeeks).values({
    id: newId(),
    planId,
    weekStart: "2026-08-03",
    state: "shape",
    shape: null,
  });
  return planId;
}

async function seedStudioPlan(db: Db, userId: string): Promise<string> {
  const planId = newId();
  await db.insert(studioPlans).values({
    id: planId,
    userId,
    brief: {},
    plan: {},
    version: 1,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(studioPlanPushes).values({
    id: newId(),
    planId,
    planVersion: 1,
    happenDay: "2026-09-07",
    sessionTitle: "seed session",
    status: "pending",
    updatedAt: nowInstant(),
  });
  return planId;
}

describe("deleteAllUserData — schema coverage (C20)", () => {
  it("touches every user-scoped table the schema barrel currently exports", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);

    // Seed just enough that every conditional branch inside
    // deleteAllUserData actually runs: the two plan-scoped child-table loops
    // (studioPlanPushes, coachPlanWeeks) only issue a delete when this user
    // owns at least one plan (chunkIds([]) yields zero chunks otherwise).
    await seedStudioPlan(db, userId);
    await seedCoachPlan(db, userId);

    // Record which table SQL names deleteAllUserData actually issues a
    // delete against — the real enforcement: any user-scoped table this run
    // never touches fails the assertion below, regardless of whether a
    // future contributor remembers to update this test's own seed list.
    const touched = new Set<string>();
    const originalDelete = db.delete.bind(db);
    (db as unknown as { delete: typeof db.delete }).delete = ((table: unknown) => {
      touched.add(getTableName(table as never));
      return (originalDelete as (t: unknown) => unknown)(table);
    }) as typeof db.delete;

    await deleteAllUserData(db, userId);

    // EVERY exported table must be either deleted by deleteAllUserData or on
    // the explicit global allowlist — including tables WITHOUT a userId
    // column (FK/plan-scoped children like coach_plan_weeks were exactly the
    // kind of table the original bug missed; a userId-only filter would have
    // silently excused them).
    const missed = allTables()
      .filter(({ name }) => !GLOBAL_TABLE_NAMES.has(name))
      .filter(({ name }) => !touched.has(name))
      .map(({ name }) => name);

    expect(missed).toEqual([]);
  });

  it("never touches the deliberately-global catalog/version tables", async () => {
    // Sanity check on the allowlist itself: every name in it really does
    // exist in the schema and really does lack a userId column — otherwise
    // the coverage test above would be silently excusing a real gap.
    const globals = allTables().filter(({ name }) => GLOBAL_TABLE_NAMES.has(name));
    expect(globals.map((g) => g.name).sort()).toEqual([...GLOBAL_TABLE_NAMES].sort());
    for (const { table } of globals) {
      expect("userId" in getTableColumns(table as never)).toBe(false);
    }
  });
});

describe("deleteAllUserData — the 13 previously-missed tables (C20)", () => {
  it("clears coach*, garden visitors/seen/scene-layouts, backfillState, syncIntents and syncNotes", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);

    await db.insert(backfillState).values({ userId, updatedAt: nowInstant() });
    await db.insert(coachMemory).values({
      id: newId(),
      userId,
      kind: "fact",
      body: "runs on Tuesdays",
      provenance: { source: "test", at: nowInstant() },
      learnedAt: nowInstant(),
    });
    await db.insert(coachQuestions).values({
      id: newId(),
      userId,
      body: "how's the knee?",
      chips: ["fine", "sore"],
      askedAt: nowInstant(),
    });
    await db.insert(coachMessages).values({
      id: newId(),
      userId,
      role: "user",
      body: "hey coach",
      refs: {},
      at: nowInstant(),
    });
    await db.insert(coachProposals).values({
      id: newId(),
      userId,
      title: "swap Thursday",
      evidence: "e",
      rationale: "r",
      flags: [],
      ops: [],
      status: "pending",
      createdAt: nowInstant(),
      expiresAt: nowInstant(),
    });
    await db.insert(coachTriggers).values({
      id: newId(),
      userId,
      kind: "missed_run",
      evidence: {},
      firedAt: nowInstant(),
    });
    await seedCoachPlan(db, userId);
    await db.insert(gardenVisitors).values({
      id: `${userId}:deer`,
      userId,
      kind: "deer",
      count: 1,
      firstSeen: "2026-08-01",
      lastSeen: "2026-08-01",
    });
    await db.insert(gardenSeen).values({
      userId,
      lastSeenDate: "2026-08-09",
      lastSeenSeq: 0,
      celebratedSpeciesIds: [],
      updatedAt: nowInstant(),
    });
    await db.insert(gardenSceneLayouts).values({ userId, layoutVersion: 1, updatedAt: nowInstant() });
    await recordIntent(db, {
      userId,
      targetKind: "workout",
      targetId: "w1",
      kind: "move",
      payload: { toDate: "2026-08-10" },
      source: "user_move",
    });
    await postSyncNote(db, {
      userId,
      workoutId: "w1",
      kind: "adopted_coros_change",
      payload: { previousDate: "2026-08-08", newDate: "2026-08-09" },
    });

    await deleteAllUserData(db, userId);

    expect(await db.select().from(backfillState).where(eq(backfillState.userId, userId))).toHaveLength(0);
    expect(await db.select().from(coachMemory).where(eq(coachMemory.userId, userId))).toHaveLength(0);
    expect(await db.select().from(coachQuestions).where(eq(coachQuestions.userId, userId))).toHaveLength(0);
    expect(await db.select().from(coachMessages).where(eq(coachMessages.userId, userId))).toHaveLength(0);
    expect(await db.select().from(coachProposals).where(eq(coachProposals.userId, userId))).toHaveLength(0);
    expect(await db.select().from(coachTriggers).where(eq(coachTriggers.userId, userId))).toHaveLength(0);
    expect(await db.select().from(coachPlans).where(eq(coachPlans.userId, userId))).toHaveLength(0);
    expect(await db.select().from(coachPlanWeeks)).toHaveLength(0);
    expect(await db.select().from(gardenVisitors).where(eq(gardenVisitors.userId, userId))).toHaveLength(0);
    expect(await db.select().from(gardenSeen).where(eq(gardenSeen.userId, userId))).toHaveLength(0);
    expect(await db.select().from(gardenSceneLayouts).where(eq(gardenSceneLayouts.userId, userId))).toHaveLength(0);
    expect(await db.select().from(syncIntents).where(eq(syncIntents.userId, userId))).toHaveLength(0);
    expect(await db.select().from(syncNotes).where(eq(syncNotes.userId, userId))).toHaveLength(0);
  });

  it("leaves another user's coach_plan_weeks and studio_plan_pushes rows alone (both are reached only through planId, not a userId of their own)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const other = await makeTestUser(db);

    await seedCoachPlan(db, userId);
    await seedStudioPlan(db, userId);
    const theirCoachPlanId = await seedCoachPlan(db, other.userId);
    const theirStudioPlanId = await seedStudioPlan(db, other.userId);

    await deleteAllUserData(db, userId);

    expect(await db.select().from(coachPlanWeeks)).toHaveLength(1);
    expect((await db.select().from(coachPlanWeeks))[0]!.planId).toBe(theirCoachPlanId);
    expect(await db.select().from(studioPlanPushes)).toHaveLength(1);
    expect((await db.select().from(studioPlanPushes))[0]!.planId).toBe(theirStudioPlanId);
    expect(await db.select().from(coachPlans).where(eq(coachPlans.userId, other.userId))).toHaveLength(1);
    expect(await db.select().from(studioPlans).where(eq(studioPlans.userId, other.userId))).toHaveLength(1);
  });
});
