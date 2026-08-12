/**
 * Apply path (Plan A Task A8, spec §7): deterministic, idempotent mutations —
 * re-applying the same proposal's ops never duplicates rows.
 */
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type CoachOp } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyOps } from "../src/services/coach-apply.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const run40 = {
  category: "easy" as const,
  title: "Steady 40 Z2",
  durationMinutes: 40,
  run: { blocks: [{ kind: "duration" as const, value: 40, intensity: "easy" as const }] },
};

async function seedWorkout(db: Db, userId: string, id: string, date: string, category = "quality") {
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id}`,
    title: "Tempo 3×10",
    category,
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "scheduled",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

describe("applyOps", () => {
  it("ease rewrites in place and marks the row calendar_only", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedWorkout(db, userId, "w1", addDays(today, 1));
    const out = await applyOps(db, userId, prefs, "prop1", [
      { kind: "ease", workoutId: "w1", session: run40 },
    ]);
    expect(out.updated).toEqual(["w1"]);
    const [w] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1"));
    expect(w!.title).toBe("Steady 40 Z2");
    expect(w!.category).toBe("easy");
    expect(w!.corosSyncState).toBe("calendar_only");
    expect(w!.stageSummary).toBe("40min easy");
  });

  it("skip resolves the workout", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedWorkout(db, userId, "w1", addDays(today, 1));
    await applyOps(db, userId, prefs, "prop1", [
      { kind: "skip", workoutId: "w1", reason: "rest needed" },
    ]);
    const [w] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1"));
    expect(w!.completionState).toBe("skipped");
    expect(w!.resolutionDate).toBe(today);
  });

  it("createPlan inserts the plan, firm sessions and shape weeks — idempotently", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const op: CoachOp = {
      kind: "createPlan",
      discipline: "run",
      name: "Fall Half",
      startDate: today,
      endDate: addDays(today, 27),
      firmSessions: [
        { date: addDays(today, 1), session: run40 },
        { date: addDays(today, 3), session: { ...run40, title: "Long 14k", category: "long" } },
      ],
      shapeWeeks: [
        { weekStart: addDays(today, 14), volumeTarget: "42k", keySessions: ["long 16k"] },
      ],
    };
    const first = await applyOps(db, userId, prefs, "prop2", [op]);
    const second = await applyOps(db, userId, prefs, "prop2", [op]);
    expect(second.created).toEqual(first.created);

    const plans = await db.select().from(schema.coachPlans).where(eq(schema.coachPlans.userId, userId));
    expect(plans).toHaveLength(1);
    const workouts = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, userId), eq(schema.plannedWorkouts.planId, plans[0]!.id)));
    expect(workouts).toHaveLength(2);
    const weeks = await db.select().from(schema.coachPlanWeeks).where(eq(schema.coachPlanWeeks.planId, plans[0]!.id));
    expect(weeks).toHaveLength(1);
  });

  it("firmUp materializes a shape week", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Fall Half",
      status: "active",
      startDate: today,
      endDate: addDays(today, 40),
      stampPrefix: "Fall Half",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const weekStart = addDays(today, 14);
    await db.insert(schema.coachPlanWeeks).values({
      id: newId(),
      planId: "cp1",
      weekStart,
      state: "shape",
      shape: { volumeTarget: "40k", keySessions: ["long"] },
    });
    await applyOps(db, userId, prefs, "prop3", [
      {
        kind: "firmUp",
        planId: "cp1",
        weekStart,
        sessions: [{ date: addDays(weekStart, 1), session: run40 }],
      },
    ]);
    const [wk] = await db
      .select()
      .from(schema.coachPlanWeeks)
      .where(and(eq(schema.coachPlanWeeks.planId, "cp1"), eq(schema.coachPlanWeeks.weekStart, weekStart)));
    expect(wk!.state).toBe("firm");
    const created = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, userId), eq(schema.plannedWorkouts.planId, "cp1")));
    expect(created).toHaveLength(1);
  });

  it("retirePlan archives future sessions and retires the plan", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.coachPlans).values({
      id: "cp1",
      userId,
      discipline: "run",
      name: "Fall Half",
      status: "active",
      startDate: addDays(today, -7),
      endDate: addDays(today, 30),
      stampPrefix: "Fall Half",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await seedWorkout(db, userId, "w-future", addDays(today, 5));
    await db
      .update(schema.plannedWorkouts)
      .set({ planId: "cp1" })
      .where(eq(schema.plannedWorkouts.id, "w-future"));

    const out = await applyOps(db, userId, prefs, "prop4", [{ kind: "retirePlan", planId: "cp1" }]);
    expect(out.archived).toEqual(["w-future"]);
    const [plan] = await db.select().from(schema.coachPlans).where(eq(schema.coachPlans.id, "cp1"));
    expect(plan!.status).toBe("retired");
    const live = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, userId), isNull(schema.plannedWorkouts.archivedAt)));
    expect(live.map((w) => w.id)).not.toContain("w-future");
  });
});

describe("sanctioned skip (garden-loop spec §1)", () => {
  it("coach skip marks sanctionedBy", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedWorkout(db, userId, "w1", addDays(today, 1));
    await applyOps(db, userId, prefs, "prop-s", [
      { kind: "skip", workoutId: "w1", reason: "you need the rest" },
    ]);
    const [w] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1"));
    expect(w!.completionState).toBe("skipped");
    expect(w!.sanctionedBy).toBe("coach");
  });
});

describe("structured lift persist (2026-08-11 rework §5)", () => {
  it("createPlan lift sessions keep their exercises JSON on the workout row", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const exercises = [
      { originId: "S1", name: "Bench Press", sets: 3, reps: 8, weight: { type: "kg" as const, value: 52 }, restSeconds: 120 },
    ];
    await applyOps(db, userId, prefs, "prop-lift-1", [
      {
        kind: "createPlan",
        discipline: "lift",
        name: "Coached Strength",
        startDate: today,
        endDate: addDays(today, 27),
        firmSessions: [
          {
            date: addDays(today, 1),
            session: { category: "strength", title: "Upper A", durationMinutes: 60, lift: { exercises } },
          },
        ],
        shapeWeeks: [],
      },
    ]);
    const rows = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.structuredJson).toEqual({ exercises });
  });
});

describe("coach adds reach the watch (2026-08-12)", () => {
  it("an approved duration-block run add enqueues a coach_create_workout job", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const applied = await applyOps(db, userId, prefs, "prop-1", [
      {
        kind: "add",
        date: "2026-10-22",
        session: {
          category: "easy",
          title: "Race-week shakeout",
          durationMinutes: 25,
          run: { blocks: [{ kind: "duration", value: 25, intensity: "easy" }] },
        },
      } as never,
    ]);
    expect(applied.created).toHaveLength(1);
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.kind, "coach_create_workout"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.workoutId).toBe(applied.created[0]);
    expect((jobs[0]!.payload as { name: string }).name).toBe("Race-week shakeout");
  });

  it("distance blocks and disabled writes stay app-only — no job", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    await applyOps(db, userId, prefs, "prop-2", [
      {
        kind: "add",
        date: "2026-10-22",
        session: {
          category: "long",
          title: "Long run",
          durationMinutes: 90,
          run: { blocks: [{ kind: "distance", value: 16_000 }] },
        },
      } as never,
    ]);
    const { userId: u2, prefs: p2 } = await makeTestUser(db, { corosWritesEnabled: false });
    await applyOps(db, u2, p2, "prop-3", [
      {
        kind: "add",
        date: "2026-10-22",
        session: {
          category: "easy",
          title: "Easy",
          durationMinutes: 30,
          run: { blocks: [{ kind: "duration", value: 30 }] },
        },
      } as never,
    ]);
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.kind, "coach_create_workout"));
    expect(jobs).toHaveLength(0);
  });
});
