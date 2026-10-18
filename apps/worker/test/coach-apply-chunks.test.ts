/**
 * PLANS THAT RESUME (§8 §4, 2026-10-18): `applyStructuralChunk` applies the thread coach's structural ops a slice at a
 * time, within the budget it is given, and ends where one unbounded apply ends.
 *
 * For every structural op: applied with a budget of 10 a call, looping until done, the plan is the same — rows, stage
 * rows, documents' revisions, weeks, suppressions, watch jobs — as one unbounded call's. Every call spends what it says
 * (counted, never more), and a call re-run with the same progress does nothing twice.
 *
 * Synthetic fixtures only.
 */
import { describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, startOfIsoWeek, todayInZone, type CoachOp, type CoachSession, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { applyStructuralChunk, type StructuralChunkResult, type StructuralProgress } from "../src/services/coach-apply.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const NOW = new Date();
const PUSHUP = "426109589008859137";

const runSession = (title: string, minutes: number, intensity = "easy"): CoachSession =>
  ({
    category: intensity === "easy" ? "easy" : "quality",
    title,
    durationMinutes: minutes,
    run: {
      blocks: [
        { kind: "duration", value: 10, intensity: "easy" },
        { kind: "duration", value: minutes - 10, intensity },
      ],
    },
  }) as CoachSession;
const liftSession = (title: string, mapped: boolean): CoachSession =>
  ({
    category: "strength",
    title,
    durationMinutes: 30,
    lift: {
      exercises: [
        { name: "Push-up", ...(mapped ? { originId: PUSHUP } : {}), sets: 3, reps: 10, weight: { type: "bodyweight" }, restSeconds: 60 },
      ],
    },
  }) as CoachSession;

/** n sessions from `from`, a day apart: runs, a lift every third (the watch takes only the mapped one). */
function sessionsFrom(from: string, n: number, title = "Session") {
  return Array.from({ length: n }, (_, i) => ({
    date: addDays(from, i),
    session: i % 3 === 2 ? liftSession(`${title} lift ${i}`, i % 2 === 0) : runSession(`${title} ${i}`, 30 + i, i % 4 === 1 ? "threshold" : "easy"),
  }));
}

interface World {
  db: Db;
  userId: string;
  prefs: UserPreferences;
  today: string;
  monday: string;
  statements: string[];
}

async function world(opts: { writes?: boolean } = {}): Promise<World> {
  const statements: string[] = [];
  const db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => statements.push(q) });
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: opts.writes ?? true });
  const today = todayInZone(prefs.timezone, NOW);
  return { db, userId, prefs, today, monday: addDays(startOfIsoWeek(today), 14), statements };
}

/** Apply `op` to the end with `budget` a call: every call's result, and its statements counted. Fails past `max` calls. */
async function applyAll(w: World, proposalId: string, op: CoachOp, budget: number, max = 200) {
  let progress: StructuralProgress | null = null;
  const calls: { result: StructuralChunkResult; counted: number }[] = [];
  for (let i = 0; i < max; i++) {
    w.statements.length = 0;
    const result = await applyStructuralChunk(w.db, { userId: w.userId, proposalId, opIndex: 0, op, progress, budget, now: NOW, prefs: w.prefs });
    calls.push({ result, counted: w.statements.length });
    if (result.status !== "more") return calls;
    progress = result.progress;
  }
  throw new Error(`not done in ${max} calls`);
}

/** The athlete's plan as it stands, without the user id (two worlds hold two users) or a clock. */
async function planState(w: World) {
  const { db, userId } = w;
  const workouts = await db
    .select({
      id: schema.plannedWorkouts.id,
      planId: schema.plannedWorkouts.planId,
      date: schema.plannedWorkouts.effectiveDate,
      time: schema.plannedWorkouts.effectiveTime,
      title: schema.plannedWorkouts.title,
      state: schema.plannedWorkouts.completionState,
      archived: sql<number>`${schema.plannedWorkouts.archivedAt} is not null`,
      reason: schema.plannedWorkouts.archiveReason,
      rev: schema.plannedWorkouts.workoutDocRev,
      doc: schema.plannedWorkouts.workoutDoc,
      summary: schema.plannedWorkouts.stageSummary,
    })
    .from(schema.plannedWorkouts)
    .where(eq(schema.plannedWorkouts.userId, userId))
    .orderBy(schema.plannedWorkouts.id);
  const ids = workouts.map((x) => x.id);
  const stages = ids.length
    ? await db
        .select({ id: schema.plannedWorkoutStages.id, kind: schema.plannedWorkoutStages.kind, secs: schema.plannedWorkoutStages.durationSeconds, low: schema.plannedWorkoutStages.targetLow })
        .from(schema.plannedWorkoutStages)
        .where(inArray(schema.plannedWorkoutStages.workoutId, ids))
        .orderBy(schema.plannedWorkoutStages.id)
    : [];
  const revisions = await db
    .select({ id: schema.workoutDocRevisions.id, ref: schema.workoutDocRevisions.sourceRef })
    .from(schema.workoutDocRevisions)
    .where(eq(schema.workoutDocRevisions.userId, userId))
    .orderBy(schema.workoutDocRevisions.id);
  const plans = await db
    .select({ id: schema.coachPlans.id, name: schema.coachPlans.name, status: schema.coachPlans.status, start: schema.coachPlans.startDate, end: schema.coachPlans.endDate, race: schema.coachPlans.raceDate })
    .from(schema.coachPlans)
    .where(eq(schema.coachPlans.userId, userId))
    .orderBy(schema.coachPlans.id);
  const weeks = plans.length
    ? await db
        .select({ id: schema.coachPlanWeeks.id, planId: schema.coachPlanWeeks.planId, weekStart: schema.coachPlanWeeks.weekStart, state: schema.coachPlanWeeks.state, shape: schema.coachPlanWeeks.shape })
        .from(schema.coachPlanWeeks)
        .where(inArray(schema.coachPlanWeeks.planId, plans.map((p) => p.id)))
        .orderBy(schema.coachPlanWeeks.planId, schema.coachPlanWeeks.weekStart)
    : [];
  const suppressions = ids.length
    ? await db
        .select({ id: schema.calendarEventSuppressions.id, workoutId: schema.calendarEventSuppressions.workoutId, reason: schema.calendarEventSuppressions.reason })
        .from(schema.calendarEventSuppressions)
        .where(inArray(schema.calendarEventSuppressions.workoutId, ids))
        .orderBy(schema.calendarEventSuppressions.workoutId)
    : [];
  const jobs = (
    await db
      .select({ id: schema.corosWriteJobs.id, kind: schema.corosWriteJobs.kind, status: schema.corosWriteJobs.status, payload: schema.corosWriteJobs.payload })
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.userId, userId))
      .orderBy(schema.corosWriteJobs.id)
  ).map((j) => ({ id: j.id, kind: j.kind, status: j.status, name: (j.payload as { name?: string }).name }));
  return { workouts, stages, revisions, plans, weeks, suppressions, jobs };
}

/** A plan made by the seam itself (proposal "seed"): `cp-seed-0`, its sessions `cw-seed-0-<n>`. */
async function seedPlan(w: World, sessions: { date: string; session: CoachSession }[], shapeWeeks = 2) {
  const op: CoachOp = {
    kind: "createPlan",
    discipline: "run",
    name: "Base block",
    startDate: w.monday,
    endDate: addDays(w.monday, 7 * 6 - 1),
    raceDate: null,
    firmSessions: sessions,
    shapeWeeks: Array.from({ length: shapeWeeks }, (_, i) => ({ weekStart: addDays(w.monday, 7 * (4 + i)), volumeTarget: "30 km", keySessions: ["long run"] })),
  };
  const calls = await applyAll(w, "seed", op, 10_000);
  expect(calls.at(-1)!.result.status).toBe("done");
  return "cp-seed-0";
}

/** Some of the plan's sessions on the watch: a verified create (its stamp) and the address COROS holds them at. */
async function pushed(w: World, ids: string[]) {
  for (const [n, id] of ids.entries()) {
    const [row] = await w.db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, id));
    await w.db
      .update(schema.plannedWorkouts)
      .set({ sourceWorkoutId: `9000:${n + 1}`, sourceIdInPlan: String(n + 1), sourceProgramId: `77${n}`, lastVerifiedCorosDate: row!.effectiveDate, corosSyncState: "synced" })
      .where(eq(schema.plannedWorkouts.id, id));
    await w.db
      .update(schema.corosWriteJobs)
      .set({ status: "verified", verifiedAt: NOW.toISOString() })
      .where(eq(schema.corosWriteJobs.id, `${id}-push`));
  }
}

type Case = { name: string; setup: (w: World) => Promise<CoachOp> };

const CASES: Case[] = [
  {
    name: "createPlan of 40 sessions and 4 shape weeks",
    setup: async (w) => ({
      kind: "createPlan",
      discipline: "run",
      name: "10K block",
      startDate: w.monday,
      endDate: addDays(w.monday, 7 * 10 - 1),
      raceDate: addDays(w.monday, 7 * 10 - 2),
      firmSessions: sessionsFrom(w.monday, 40),
      shapeWeeks: Array.from({ length: 4 }, (_, i) => ({ weekStart: addDays(w.monday, 7 * (6 + i)), volumeTarget: `${30 + i} km`, keySessions: ["long run", "tempo"] })),
    }),
  },
  {
    name: "createPlan whose sessions share days with the athlete's other plan (the collision pass)",
    setup: async (w) => {
      await seedPlan(w, sessionsFrom(w.monday, 6, "Other"), 0);
      return {
        kind: "createPlan",
        discipline: "lift",
        name: "Strength block",
        startDate: w.monday,
        endDate: addDays(w.monday, 13),
        raceDate: null,
        firmSessions: sessionsFrom(w.monday, 8, "Strength").map((s) => ({ ...s, session: liftSession(s.session.title, true) })),
        shapeWeeks: [],
      };
    },
  },
  {
    name: "firmUp of a week",
    setup: async (w) => {
      const planId = await seedPlan(w, sessionsFrom(w.monday, 3));
      const weekStart = addDays(w.monday, 28);
      return { kind: "firmUp", planId, weekStart, sessions: sessionsFrom(weekStart, 6, "Firm") };
    },
  },
  {
    name: "reshapeWeek over pushed sessions",
    setup: async (w) => {
      const planId = await seedPlan(w, sessionsFrom(w.monday, 12));
      await pushed(w, ["cw-seed-0-0", "cw-seed-0-2", "cw-seed-0-3", "cw-seed-0-5"]);
      return { kind: "reshapeWeek", planId, weekStart: w.monday, sessions: sessionsFrom(addDays(w.monday, 1), 4, "Reshaped") };
    },
  },
  {
    name: "windDown across two weeks over pushed sessions",
    setup: async (w) => {
      const planId = await seedPlan(w, sessionsFrom(w.monday, 21));
      await pushed(w, ["cw-seed-0-8", "cw-seed-0-9", "cw-seed-0-12", "cw-seed-0-15"]);
      return { kind: "windDown", planId, sessions: sessionsFrom(addDays(w.monday, 8), 9, "Taper") };
    },
  },
  {
    name: "retirePlan with 30 future sessions, some on the watch",
    setup: async (w) => {
      const planId = await seedPlan(w, sessionsFrom(w.monday, 30));
      await pushed(w, Array.from({ length: 10 }, (_, i) => `cw-seed-0-${i * 3}`));
      return { kind: "retirePlan", planId };
    },
  },
  {
    name: "extendPlan by six weeks",
    setup: async (w) => {
      const planId = await seedPlan(w, sessionsFrom(w.monday, 3));
      return { kind: "extendPlan", planId, shapeWeeks: Array.from({ length: 6 }, (_, i) => ({ weekStart: addDays(w.monday, 7 * (6 + i)), volumeTarget: "35 km", keySessions: ["long run"] })) };
    },
  },
  {
    name: "resolveRaceConflict with nothing to resolve",
    setup: async () => ({ kind: "resolveRaceConflict", keep: "settings" }),
  },
];

describe("applyStructuralChunk: a budget of 10 a call ends where one unbounded call ends", () => {
  for (const c of CASES) {
    it(c.name, { timeout: 60_000 }, async () => {
      const whole = await world();
      const wholeOp = await c.setup(whole);
      const wholeCalls = await applyAll(whole, "p1", wholeOp, 10_000);
      expect(wholeCalls).toHaveLength(1);
      expect(wholeCalls[0]!.result.status).toBe("done");

      const sliced = await world();
      const op = await c.setup(sliced);
      const calls = await applyAll(sliced, "p1", op, 10);
      const last = calls.at(-1)!.result;
      expect(last.status).toBe("done");
      expect(last).toMatchObject({ summary: (wholeCalls[0]!.result as { summary: string }).summary });
      for (const [i, call] of calls.entries()) {
        // What a call says it spent is never less than what it ran, and never past its budget.
        expect(call.counted, `call ${i}: ${JSON.stringify(call.result)}`).toBeLessThanOrEqual(call.result.spent);
        expect(call.result.spent, `call ${i}: ${JSON.stringify(call.result)}`).toBeLessThanOrEqual(10);
      }
      expect(wholeCalls[0]!.counted).toBeLessThanOrEqual(wholeCalls[0]!.result.spent);
      expect(calls.length, "the budget sliced it").toBeGreaterThan(c.name.startsWith("extendPlan") || c.name.startsWith("resolve") ? 0 : 1);
      expect(await planState(sliced)).toEqual(await planState(whole));
    });
  }
});
