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
import { openIntentFor } from "../src/services/sync-intents.js";
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

describe("archive aftermath (audit#3 D1/D2)", () => {
  const seedCoachPlan = async (db: Db, userId: string, today: string) => {
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
  };

  it("retirePlan suppresses archived rows and unpushes verified watch sessions", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const today = todayInZone(prefs.timezone);
    await seedCoachPlan(db, userId, today);
    const date = addDays(today, 5);
    await seedWorkout(db, userId, "w-watch", date);
    await db
      .update(schema.plannedWorkouts)
      .set({
        planId: "cp1",
        sourceWorkoutId: "473846232060707016:42",
        sourceIdInPlan: "42",
        sourceProgramId: "9001",
        corosSyncState: "synced",
        lastVerifiedCorosDate: date,
      })
      .where(eq(schema.plannedWorkouts.id, "w-watch"));
    await db.insert(schema.corosWriteJobs).values({
      id: "w-watch-push",
      userId,
      workoutId: "w-watch",
      kind: "coach_create_workout",
      expectedContentFingerprint: "fp",
      originalDate: date,
      destinationDate: date,
      payload: { workoutId: "w-watch", happenDay: date, name: `Tempo 3×10 — ${date}` },
      requestedAt: nowInstant(),
      status: "verified",
      updatedAt: nowInstant(),
    });

    const ops: CoachOp[] = [{ kind: "retirePlan", planId: "cp1" }];
    await applyOps(db, userId, prefs, "prop-retire", ops);

    const suppressions = await db
      .select()
      .from(schema.calendarEventSuppressions)
      .where(eq(schema.calendarEventSuppressions.workoutId, "w-watch"));
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]!.reason).toBe("user_removed");

    const [unpush] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.id, "w-watch-unpush"));
    expect(unpush?.kind).toBe("coach_delete_workout");
    expect(unpush?.status).toBe("queued");
    expect(unpush?.payload).toMatchObject({
      workoutId: "w-watch",
      happenDay: date,
      name: `Tempo 3×10 — ${date}`,
      idInPlan: "42",
      programId: "9001",
      corosPlanId: "473846232060707016",
    });

    // Re-applying the approved proposal stays a no-op: one suppression, ever.
    await applyOps(db, userId, prefs, "prop-retire", ops);
    const again = await db
      .select()
      .from(schema.calendarEventSuppressions)
      .where(eq(schema.calendarEventSuppressions.workoutId, "w-watch"));
    expect(again).toHaveLength(1);
  });

  it("retirePlan aimed at a plan the coach did not author is a no-op", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedWorkout(db, userId, "w-imported", addDays(today, 3));
    await db
      .update(schema.plannedWorkouts)
      .set({ planId: "imported-coros-plan" })
      .where(eq(schema.plannedWorkouts.id, "w-imported"));

    const out = await applyOps(db, userId, prefs, "prop-x", [
      { kind: "retirePlan", planId: "imported-coros-plan" },
    ]);
    expect(out.archived).toEqual([]);
    const [w] = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(eq(schema.plannedWorkouts.id, "w-imported"));
    expect(w!.archivedAt).toBeNull();
  });

  it("ease records the app's permanent content claim", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seedWorkout(db, userId, "w1", addDays(today, 1));
    await applyOps(db, userId, prefs, "prop-ease", [
      { kind: "ease", workoutId: "w1", session: run40 },
    ]);
    const intent = await openIntentFor(db, userId, "w1", "content");
    expect(intent).not.toBeNull();
    expect(intent!.source).toBe("coach_ease");
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
    // The stamp is uniquified with the date (audit#2 #7) — raw recurring
    // titles would refuse every create after the first.
    expect((jobs[0]!.payload as { name: string }).name).toBe("Race-week shakeout — 2026-10-22");
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

describe("pace targets on coach sessions (2026-08-14)", () => {
  it("writes pace-banded stages and hands the threshold to the watch push", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const today = todayInZone(prefs.timezone);
    // The athlete's measured threshold — the only anchor the bands use.
    await db.insert(schema.dailyHealth).values({
      id: `${userId}:${today}`,
      userId,
      date: today,
      thresholdPaceSecPerKm: 289,
      provider: "coros",
      contentFingerprint: "fp",
      updatedAt: nowInstant(),
    });

    const out = await applyOps(db, userId, prefs, "prop-pace", [
      {
        kind: "add",
        date: addDays(today, 2),
        session: {
          category: "quality",
          title: "Threshold block",
          durationMinutes: 45,
          run: {
            blocks: [
              { kind: "duration", value: 15, intensity: "easy" },
              { kind: "duration", value: 30, intensity: "threshold" },
            ],
          },
        },
      },
    ]);
    const id = out.created[0]!;

    const stages = await db
      .select()
      .from(schema.plannedWorkoutStages)
      .where(eq(schema.plannedWorkoutStages.workoutId, id));
    expect(stages).toHaveLength(2);
    const sorted = [...stages].sort((a, b) => a.ord - b.ord);
    expect(sorted[0]).toMatchObject({ kind: "warmup", targetType: "pace", targetLow: 349, targetHigh: 409 });
    expect(sorted[1]).toMatchObject({ kind: "work", targetType: "pace", targetLow: 289, targetHigh: 313 });

    const [job] = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.id, `${id}-push`));
    expect((job!.payload as { thresholdPaceSecPerKm?: number }).thresholdPaceSecPerKm).toBe(289);
  });

  it("without a threshold reading the session still lands, just without targets", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const out = await applyOps(db, userId, prefs, "prop-nopace", [
      {
        kind: "add",
        date: addDays(today, 2),
        session: {
          category: "easy",
          title: "Easy 30",
          durationMinutes: 30,
          run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] },
        },
      },
    ]);
    const stages = await db
      .select()
      .from(schema.plannedWorkoutStages)
      .where(eq(schema.plannedWorkoutStages.workoutId, out.created[0]!));
    expect(stages[0]).toMatchObject({ targetType: "none", targetLow: null, targetHigh: null });
  });
});

/**
 * One `add` op, N real sessions (2026-08-17). The op got cheaper to WRITE —
 * a ten-day daily piece used to cost ten ops each re-serialising the same
 * exercise list, and cost a live wake 16k output tokens — but what the
 * athlete approves must be indistinguishable from what ten adds produced:
 * one planned_workouts row per date, each with its own id and its own
 * calendar block.
 */
describe("an add carrying multiple dates expands into one session per date", () => {
  it("writes a real row for every date, ids distinct, and is idempotent", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const dates = [addDays(today, 1), addDays(today, 2), addDays(today, 3)];
    const op = {
      kind: "add",
      date: dates[0],
      dates: [dates[1], dates[2]],
      session: {
        category: "yoga",
        title: "Ankles and hips",
        durationMinutes: 10,
        mobility: {
          rounds: 2,
          exercises: [
            {
              name: "Couch stretch",
              sets: 1,
              holdSeconds: 45,
              perSide: true,
              weight: { type: "bodyweight" },
              restSeconds: 0,
            },
          ],
        },
      },
    } as unknown as CoachOp;

    const out = await applyOps(db, userId, prefs, "prop-daily", [op]);
    expect(out.created).toHaveLength(3);
    expect(new Set(out.created).size).toBe(3);
    const rows = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, userId), isNull(schema.plannedWorkouts.archivedAt)));
    expect(rows.map((r) => r.effectiveDate).sort()).toEqual([...dates].sort());
    // A mobility body is a yoga session on every one of them, not a run.
    expect(rows.every((r) => r.sport === "yoga")).toBe(true);
    expect(rows.every((r) => r.title === "Ankles and hips")).toBe(true);

    // Re-applying the same proposal (crash, retry, double tap) adds nothing.
    await applyOps(db, userId, prefs, "prop-daily", [op]);
    const again = await db
      .select()
      .from(schema.plannedWorkouts)
      .where(and(eq(schema.plannedWorkouts.userId, userId), isNull(schema.plannedWorkouts.archivedAt)));
    expect(again).toHaveLength(3);
  });

  it("a plain single-date add is unchanged — every op ever persisted still applies", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const date = addDays(todayInZone(prefs.timezone), 1);
    const out = await applyOps(db, userId, prefs, "prop-one", [
      { kind: "add", date, session: run40 } as CoachOp,
    ]);
    expect(out.created).toHaveLength(1);
  });
});
