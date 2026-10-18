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

/** One call of `op` from `progress` with `budget`. */
const chunk = (w: World, op: CoachOp, progress: StructuralProgress | null, budget: number, proposalId = "p1") =>
  applyStructuralChunk(w.db, { userId: w.userId, proposalId, opIndex: 0, op, progress, budget, now: NOW, prefs: w.prefs });

describe("applyStructuralChunk: a call re-run with the same progress does nothing twice", () => {
  it("a chunk of sessions met again skips every session whose row is there — an athlete's change since included", async () => {
    const w = await world();
    const op: CoachOp = {
      kind: "createPlan", discipline: "run", name: "10K block", startDate: w.monday, endDate: addDays(w.monday, 27),
      firmSessions: sessionsFrom(w.monday, 12), shapeWeeks: [],
    };
    const first = await chunk(w, op, null, 12);
    expect(first.status).toBe("more");
    const p1 = (first as { progress: StructuralProgress }).progress;
    const second = await chunk(w, op, p1, 14);
    expect(second.status).toBe("more");
    const p2 = (second as { progress: StructuralProgress }).progress;
    expect(p2.done).toBeGreaterThan(p1.done);
    // The athlete changes one of the second chunk's sessions meanwhile.
    const changed = `cw-p1-0-${p1.done}`;
    await w.db.update(schema.plannedWorkouts).set({ title: "Changed by hand" }).where(eq(schema.plannedWorkouts.id, changed));
    await w.db.delete(schema.plannedWorkoutStages).where(eq(schema.plannedWorkoutStages.workoutId, changed));
    const before = await planState(w);
    // The second chunk's progress was never stored: it is met again. What it finds there costs it nothing, so it goes
    // on past them — and touches none of them.
    const again = await chunk(w, op, p1, 14);
    expect(again.status).toBe("more");
    expect((again as { progress: StructuralProgress }).progress.done).toBeGreaterThan(p2.done);
    const after = await planState(w);
    const had = new Set(before.workouts.map((x) => x.id));
    const keep = <T extends { id: string }>(xs: T[], idOf: (x: T) => string = (x) => x.id) => xs.filter((x) => had.has(idOf(x)));
    expect(keep(after.workouts)).toEqual(before.workouts);
    expect(keep(after.stages, (s) => s.id.split(":")[0]!)).toEqual(before.stages);
    expect(keep(after.revisions, (r) => r.id.split(":")[0]!)).toEqual(before.revisions);
    expect(keep(after.jobs, (j) => j.id.replace(/-push$/, ""))).toEqual(before.jobs);
    expect(after.workouts.find((x) => x.id === changed)!.title).toBe("Changed by hand");
  });

  it("an archive slice met again finds the rows it finished gone: no second suppression, no second unpush", async () => {
    const w = await world();
    const planId = await seedPlan(w, sessionsFrom(w.monday, 30));
    await pushed(w, ["cw-seed-0-0", "cw-seed-0-1"]);
    const op: CoachOp = { kind: "retirePlan", planId };
    const first = await chunk(w, op, null, 8);
    expect(first.status).toBe("more");
    const p1 = (first as { progress: StructuralProgress }).progress;
    const second = await chunk(w, op, p1, 8);
    expect(second.status).toBe("more");
    const before = await planState(w);
    expect(before.workouts.filter((x) => x.archived).length).toBeGreaterThan(0);
    const again = await chunk(w, op, p1, 8);
    expect(again.status).toBe("more");
    const after = await planState(w);
    // The re-run took the NEXT rows still scheduled; nothing it had finished was written again.
    for (const s of before.suppressions) expect(after.suppressions.filter((x) => x.workoutId === s.workoutId)).toHaveLength(1);
    expect(after.jobs.filter((j) => j.kind === "coach_delete_workout")).toHaveLength(2);
  });

  it("a wind-down met again at its archive step never archives the sessions it has already added", async () => {
    const w = await world();
    const planId = await seedPlan(w, sessionsFrom(w.monday, 14));
    const op: CoachOp = { kind: "windDown", planId, sessions: sessionsFrom(addDays(w.monday, 7), 5, "Taper") };
    let progress: StructuralProgress | null = null;
    let atArchive: StructuralProgress | null = null;
    for (let i = 0; i < 50 && progress?.step !== "sessions"; i++) {
      const r = await chunk(w, op, progress, 10);
      expect(r.status).toBe("more");
      progress = (r as { progress: StructuralProgress }).progress;
      if (progress.step === "archive" && atArchive === null) atArchive = progress;
    }
    expect(atArchive).not.toBeNull();
    const added = await chunk(w, op, progress, 10);
    expect(added.status).toBe("more");
    expect((await planState(w)).workouts.some((x) => x.id.startsWith("cw-p1-0-"))).toBe(true);
    // A stored progress from before: the archive step again, after some taper sessions are on the plan.
    let p: StructuralProgress | null = atArchive;
    let finished = false;
    for (let i = 0; i < 50 && !finished; i++) {
      const r = await chunk(w, op, p, 10);
      finished = r.status === "done";
      if (r.status === "more") p = r.progress;
    }
    expect(finished).toBe(true);
    const taper = (await planState(w)).workouts.filter((x) => x.id.startsWith("cw-p1-0-"));
    expect(taper).toHaveLength(5);
    expect(taper.every((x) => !x.archived)).toBe(true);
  });
});

describe("applyStructuralChunk: what it writes", () => {
  it("a plan's sessions fill firm weeks; a shape week its sessions fill becomes firm; the rest stay shape", async () => {
    const w = await world();
    const op: CoachOp = {
      kind: "createPlan", discipline: "run", name: "Half block", startDate: w.monday, endDate: addDays(w.monday, 41),
      firmSessions: sessionsFrom(addDays(w.monday, 2), 7),
      shapeWeeks: [0, 1, 2, 3].map((i) => ({ weekStart: addDays(w.monday, 7 * i), volumeTarget: "30 km", keySessions: ["long run"] })),
    };
    const calls = await applyAll(w, "p1", op, 45);
    expect(calls.at(-1)!.result.status).toBe("done");
    const { weeks } = await planState(w);
    expect(weeks.map((x) => [x.weekStart, x.state, x.shape])).toEqual([
      [w.monday, "firm", null],
      [addDays(w.monday, 7), "firm", null],
      [addDays(w.monday, 14), "shape", { volumeTarget: "30 km", keySessions: ["long run"] }],
      [addDays(w.monday, 21), "shape", { volumeTarget: "30 km", keySessions: ["long run"] }],
    ]);
  });

  it("between two calls the plan reads sensibly: the plan, and each session there whole — its document, stages and watch create", async () => {
    const w = await world();
    const op = {
      kind: "createPlan", discipline: "run", name: "10K block", startDate: w.monday, endDate: addDays(w.monday, 27),
      firmSessions: sessionsFrom(w.monday, 9), shapeWeeks: [],
    } satisfies CoachOp;
    const r = await chunk(w, op, null, 15);
    expect(r.status).toBe("more");
    const state = await planState(w);
    expect(state.plans.map((x) => x.status)).toEqual(["active"]);
    expect(state.workouts.length).toBeGreaterThan(0);
    expect(state.workouts.length).toBeLessThan(9);
    for (const row of state.workouts) {
      const n = Number(row.id.split("-").at(-1));
      const { session } = op.firmSessions[n]!;
      expect(row.doc, row.id).toBeTruthy();
      expect(state.revisions.some((x) => x.id === `${row.id}:1`), row.id).toBe(true);
      expect(state.stages.filter((s) => s.id.startsWith(`${row.id}:`)).length).toBe(session.run?.blocks.length ?? 0);
      expect(state.jobs.some((j) => j.id === `${row.id}-push`)).toBe(!!session.run || (session.lift?.exercises.every((e) => e.originId) ?? false));
    }
  });

  it("two sessions of one title on one day take two stamps", async () => {
    const w = await world();
    const op: CoachOp = {
      kind: "createPlan", discipline: "run", name: "Doubles", startDate: w.monday, endDate: addDays(w.monday, 6),
      firmSessions: [
        { date: w.monday, session: runSession("Easy", 30) },
        { date: w.monday, session: runSession("Easy", 30) },
      ],
      shapeWeeks: [],
    };
    await applyAll(w, "p1", op, 45);
    const names = (await planState(w)).jobs.map((j) => j.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it("with watch writes off, nothing is queued for the watch", async () => {
    const w = await world({ writes: false });
    const planId = await seedPlan(w, sessionsFrom(w.monday, 6));
    await applyAll(w, "p1", { kind: "retirePlan", planId }, 10);
    const state = await planState(w);
    expect(state.jobs).toEqual([]);
    expect(state.workouts.every((x) => x.archived)).toBe(true);
    expect(state.plans[0]!.status).toBe("retired");
  });

  it("retiring keeps what is done and what is past: only future, still-scheduled sessions go", async () => {
    const w = await world();
    const planId = await seedPlan(w, sessionsFrom(w.monday, 4));
    await w.db.update(schema.plannedWorkouts).set({ completionState: "completed" }).where(eq(schema.plannedWorkouts.id, "cw-seed-0-1"));
    await w.db.update(schema.plannedWorkouts).set({ effectiveDate: addDays(w.today, -1) }).where(eq(schema.plannedWorkouts.id, "cw-seed-0-2"));
    const calls = await applyAll(w, "p1", { kind: "retirePlan", planId }, 10);
    expect(calls.at(-1)!.result).toMatchObject({ status: "done", summary: "Retired “Base block” and took 2 sessions off your plan" });
    const archived = (await planState(w)).workouts.filter((x) => x.archived).map((x) => x.id);
    expect(archived).toEqual(["cw-seed-0-0", "cw-seed-0-3"]);
  });

  for (const [kind, reason] of [
    ["retirePlan", "That plan isn't there any more, so nothing was retired."],
    ["extendPlan", "That plan isn't there any more, so it wasn't extended."],
    ["windDown", "That plan isn't there any more, so nothing was eased down."],
    ["firmUp", "That plan isn't there any more, so no sessions were added."],
    ["reshapeWeek", "That plan isn't there any more, so the week was left as it was."],
  ] as const) {
    it(`${kind} on a plan that isn't the athlete's is refused in words, and writes nothing`, async () => {
      const other = await world();
      const planId = await seedPlan(other, sessionsFrom(other.monday, 3));
      // The same database, another athlete: the plan id names a plan, but not theirs.
      const { userId, prefs } = await makeTestUser(other.db, { corosWritesEnabled: true });
      const w: World = { ...other, userId, prefs };
      const sessions = sessionsFrom(w.monday, 2);
      const op = {
        retirePlan: { kind: "retirePlan", planId },
        extendPlan: { kind: "extendPlan", planId, shapeWeeks: [{ weekStart: addDays(w.monday, 70), volumeTarget: "x", keySessions: [] }] },
        windDown: { kind: "windDown", planId, sessions },
        firmUp: { kind: "firmUp", planId, weekStart: w.monday, sessions },
        reshapeWeek: { kind: "reshapeWeek", planId, weekStart: w.monday, sessions },
      }[kind] as CoachOp;
      const before = await planState(other);
      const r = await chunk(w, op, null, 45);
      expect(r).toEqual({ status: "refused", reason, spent: 1 });
      expect(await planState(w)).toMatchObject({ workouts: [], plans: [] });
      expect(await planState(other)).toEqual(before);
    });
  }

  it("an op that is not structural is refused", async () => {
    const w = await world();
    const r = await chunk(w, { kind: "skip", workoutId: "x" } as CoachOp, null, 45);
    expect(r.status).toBe("refused");
  });
});
