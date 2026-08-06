/**
 * Coach tables (Plan A Task A1, spec 2026-08-06-coach-intelligence-design.md):
 * insert/read smoke per table proves the migration applied and the drizzle
 * schema round-trips its JSON columns.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { makeTestDb, makeTestUser } from "./helpers.js";

describe("coach tables", () => {
  it("round-trips one row per table", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const at = nowInstant();

    await db.insert(schema.coachMemory).values({
      id: newId(),
      userId,
      kind: "rule",
      body: "Long runs stay on Saturdays",
      provenance: { source: "message", messageId: "m1", at },
      learnedAt: at,
      active: true,
    });
    const [mem] = await db
      .select()
      .from(schema.coachMemory)
      .where(eq(schema.coachMemory.userId, userId));
    expect(mem?.kind).toBe("rule");
    expect(mem?.provenance).toEqual({ source: "message", messageId: "m1", at });
    expect(mem?.active).toBe(true);

    await db.insert(schema.coachQuestions).values({
      id: "q1",
      userId,
      body: "Finish strong or chase a time?",
      chips: ["Finish strong", "Sub 1:45"],
      askedAt: at,
    });
    const [q] = await db
      .select()
      .from(schema.coachQuestions)
      .where(eq(schema.coachQuestions.userId, userId));
    expect(q?.chips).toEqual(["Finish strong", "Sub 1:45"]);
    expect(q?.answeredAt).toBeNull();

    await db.insert(schema.coachMessages).values({
      id: "msg1",
      userId,
      role: "receipt",
      body: "✓ approved — eased Thursday",
      refs: { proposalId: "p1" },
      at,
    });
    const [msg] = await db
      .select()
      .from(schema.coachMessages)
      .where(eq(schema.coachMessages.userId, userId));
    expect(msg?.refs).toEqual({ proposalId: "p1" });

    await db.insert(schema.coachProposals).values({
      id: "p1",
      userId,
      title: "Ease tomorrow",
      evidence: "slept 5h avg",
      rationale: "Three short nights.",
      flags: [],
      ops: [{ kind: "skip", workoutId: "w1", reason: "rest" }],
      status: "pending",
      createdAt: at,
      expiresAt: "2026-08-07",
    });
    const [p] = await db
      .select()
      .from(schema.coachProposals)
      .where(eq(schema.coachProposals.userId, userId));
    expect(p?.status).toBe("pending");
    expect(p?.ops).toEqual([{ kind: "skip", workoutId: "w1", reason: "rest" }]);

    await db.insert(schema.coachTriggers).values({
      id: newId(),
      userId,
      kind: "sleep_deficit",
      evidence: { avgSleepH: 5.2 },
      firedAt: at,
    });
    const [t] = await db
      .select()
      .from(schema.coachTriggers)
      .where(eq(schema.coachTriggers.userId, userId));
    expect(t?.consumedAt).toBeNull();

    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Fall Half Block",
      status: "active",
      startDate: "2026-08-03",
      endDate: "2026-10-11",
      raceDate: "2026-10-18",
      stampPrefix: "Fall Half Block",
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(schema.coachPlanWeeks).values({
      id: newId(),
      planId: "cp1",
      weekStart: "2026-09-07",
      state: "shape",
      shape: { volumeTarget: "40k", keySessions: ["long 20k", "tempo"] },
    });
    const [wk] = await db
      .select()
      .from(schema.coachPlanWeeks)
      .where(eq(schema.coachPlanWeeks.planId, "cp1"));
    expect(wk?.shape).toEqual({ volumeTarget: "40k", keySessions: ["long 20k", "tempo"] });
  });
});
