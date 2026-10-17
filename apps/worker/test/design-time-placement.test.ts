/**
 * A TIME ALREADY PAST (fix wave 3B, B-I1). A designed workout never lands at a time that has gone by:
 *
 *  - LATER TODAY: the main coach's propose_workout refuses a new workout with no time, or one less than 15 minutes
 *    after now in the athlete's zone — the refusal says the earliest time that works, so the coach can fix the call.
 *  - ANY DESIGN: a new workout for today at a time already past is refused (`past_time`), as approving it would be.
 *  - NOW: a new workout for today with no time is placed at the moment of the approve, rounded up to five minutes.
 *  - APPROVE: a new workout for today with no time whose usual time (the athlete's window) has passed is placed at the
 *    next quarter hour from now, never in the past; a time the coach set that has passed since is refused in plain
 *    words (`past_time`), the op left open; no time left today is refused the same way.
 *  - THE MANIFEST: a line always carries the time the approve would use.
 *
 * On the made-up athlete of design-read-fixture.ts (Los Angeles; a weekday; usual time 07:00) and its fixed clock,
 * moved where a case needs another minute. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { approveDesignOps, type DesignedOp } from "../src/services/design-approve.js";
import { docWorkoutLines, placeNamer } from "../src/services/design-manifest.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { approvalKey } from "../src/services/design-placement.js";
import { keyedRowId } from "../src/services/doc-workouts.js";
import { bookedSeconds } from "../src/services/session-build.js";
import { designedManifest } from "../src/routes/design-proposals.js";
import { designProposalId, proposeWorkout, type DocWorkoutTarget } from "../src/services/design-tools/propose.js";
import { isToolErr, type OpReview, type RunScope, type ToolContext, type ToolErr, type ToolRole } from "../src/services/design-tools/types.js";
import { NOW, seedRichAthlete, studioDoc, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, mountRoutes } from "./helpers.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { coachRoutes } from "../src/routes/coach.js";

const { coachProposals, plannedWorkouts, scheduleOverrides } = schema;
const ENV = {} as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let statementsSeen = 0;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statementsSeen += 1) });
  ({ userId } = await seedRichAthlete(db));
  prefs = await loadPreferences(db, userId);
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("no network here");
  }));
});

afterEach(() => vi.unstubAllGlobals());

/** An instant at `hhmm` (and seconds) in Los Angeles on the fixture's today (PDT, UTC-7). */
const la = (hhmm: string, seconds = 0): Date => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) + ((h! + 7) * 3600 + m! * 60 + seconds) * 1000);
};

const REVIEW: OpReview = {
  scores: { intent: 5, sequencing: 4, alignment: 4, balance: 4, progression: 4, diversity: 4, recovery: 5, condition_safety: 5, time_fit: 4, equipment_fit: 4, specificity: 4, honesty: 4 },
  notes: {},
  mustFix: [],
  improvements: [],
  rounds: 1,
  changes: [],
};

let seq = 0;
async function run(role: ToolRole, scope: RunScope, parentId: string | null = null): Promise<ToolContext["run"]> {
  return runWithId(`run-${++seq}-${newId().slice(0, 8)}`, role, scope, parentId);
}
async function runWithId(id: string, role: ToolRole, scope: RunScope, parentId: string | null): Promise<ToolContext["run"]> {
  await db.insert(schema.coachRuns).values({
    id, userId, parentId, role, scope: { ...scope }, request: "a short session", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { id, role, scope, parentId, rehearsal: false };
}
const ctxOf = (r: ToolContext["run"], now: Date = NOW): ToolContext => ({ db, env: ENV, userId, run: r, now, toolUseId: `toolu_${++seq}` });

async function propose(scope: RunScope, target: DocWorkoutTarget, now: Date = NOW, role: "main" | "designer" = "main") {
  const main = await run("main", scope);
  const r = role === "main" ? main : await run("designer", scope, main.id);
  return { mainId: main.id, result: await proposeWorkout.run(ctxOf(r, now), { doc: calmDoc({ title: "Hips" }), target }) };
}

/** A proposal of one op the coach proposed (`scope`'s main run, or a designer of a set), made pending with a review. */
async function designed(scope: RunScope, target: DocWorkoutTarget, now: Date = NOW): Promise<{ id: string; op: DesignedOp }> {
  const { mainId, result } = await propose(scope, target, now, scope.kind === "now" || scope.kind === "later_today" ? "main" : "designer");
  if (isToolErr(result)) throw new Error(`propose refused: ${result.error} — ${result.why}`);
  const id = designProposalId(mainId);
  const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
  const ops = (p!.ops as DesignedOp[]).map((o) => ({ ...o, review: REVIEW }));
  await db.update(coachProposals).set({ status: "pending", ops }).where(eq(coachProposals.id, id));
  return { id, op: ops[0]! };
}

async function approveAt(id: string, now: Date, at: UserPreferences = prefs) {
  const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
  return approveDesignOps(db, userId, { ...p!, ops: p!.ops as DesignedOp[] }, {}, { today: TODAY, now: now.toISOString(), prefs: at }, Number.POSITIVE_INFINITY);
}

const lineAt = async (op: DesignedOp, now: Date, at: UserPreferences = prefs) => docWorkoutLines([op], await placeNamer(db, userId), { now, prefs: at })[0]!;
const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;

// ── Later today ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("later today: the main coach's workout needs a time at least 15 minutes ahead", () => {
  it("no time is refused, and the refusal names the earliest time that works", async () => {
    const { result } = await propose({ kind: "later_today" }, { kind: "new", date: TODAY }, la("09:32"));
    expect(isToolErr(result)).toBe(true);
    const e = result as ToolErr;
    expect(e.error).toBe("needs_time");
    expect(e.why).toContain("09:47");
    expect(e.fix).toMatch(/target\.time/);
    expect(e.fix).toContain("09:47");
  });

  it("a time less than 15 minutes away is refused; 15 minutes on, it goes through", async () => {
    const soon = await propose({ kind: "later_today" }, { kind: "new", date: TODAY, time: "09:45" }, la("09:30", 30));
    expect((soon.result as ToolErr).error).toBe("time_too_soon");
    expect((soon.result as ToolErr).why).toContain("09:45");
    expect((soon.result as ToolErr).fix).toContain("09:46");
    const fine = await propose({ kind: "later_today" }, { kind: "new", date: TODAY, time: "09:45" }, la("09:30"));
    expect(isToolErr(fine.result)).toBe(false);
    // A later day the request names is not held to today's clock.
    const tomorrow = await propose({ kind: "later_today" }, { kind: "new", date: addDays(TODAY, 1), time: "09:35" }, la("09:30"));
    expect(isToolErr(tomorrow.result)).toBe(false);
  });

  it("no time left today: refused with its own code, and it says to plan another day", async () => {
    const { result } = await propose({ kind: "later_today" }, { kind: "new", date: TODAY }, la("23:50"));
    expect((result as ToolErr).error).toBe("no_time_today");
    expect((result as ToolErr).why).toContain("There's no time left today.");
    expect((result as ToolErr).fix).toMatch(/another day|tomorrow/);
  });
});

describe("any design: a time today already past is refused at propose", () => {
  it("a set's designer, and the main coach for now", async () => {
    const designer = await propose({ kind: "week" }, { kind: "new", date: TODAY, time: "08:00" }, la("09:32"), "designer");
    expect((designer.result as ToolErr).error).toBe("past_time");
    expect((designer.result as ToolErr).why).toMatch(/08:00.*passed/);
    // A later day's morning is no past time; nor is this minute.
    expect(isToolErr((await propose({ kind: "week" }, { kind: "new", date: addDays(TODAY, 1), time: "08:00" }, la("09:32"), "designer")).result)).toBe(false);
    expect(isToolErr((await propose({ kind: "now" }, { kind: "new", date: TODAY, time: "09:32" }, la("09:32", 20))).result)).toBe(false);
  });
});

// ── Now ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("now: no time means the moment of the approve, rounded up to five minutes", () => {
  it("the op is marked for now; the approve places it then, pinned; the line said the same time", async () => {
    const { id, op } = await designed({ kind: "now" }, { kind: "new", date: TODAY }, la("09:31"));
    // Its floor is the propose-time clock, rounded up as the approve rounds (round 2, I2: a session that covers no
    // evening one, by the supersede's own rule).
    expect(op.target).toEqual({ kind: "new", date: TODAY, atNow: true, notBefore: "09:35" });
    // Read at 09:32:10, the card says 09:35; approved a minute later, it is 09:35 still.
    expect((await lineAt(op, la("09:32", 10))).time).toBe("09:35");
    const answer = await approveAt(id, la("09:33", 40));
    expect(answer.refused).toEqual([]);
    const workout = answer.applied[0]!.workout;
    expect(workout.time).toBe("09:35");
    expect(answer.applied[0]!.moved).toBeUndefined();
    expect(await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, workout.id))).toHaveLength(1);
    expect((await rowOf(workout.id)).effectiveTime).toBe("09:35");
  });

  it("on the minute, it stays on the minute; a timed now workout keeps its time as its earliest", async () => {
    const { op } = await designed({ kind: "now" }, { kind: "new", date: TODAY }, la("09:31"));
    expect((await lineAt(op, la("09:40"))).time).toBe("09:40");
    const timed = await designed({ kind: "now" }, { kind: "new", date: TODAY, time: "10:15" }, la("09:31"));
    expect(timed.op.target).toEqual({ kind: "new", date: TODAY, atNow: true, notBefore: "10:15" });
    expect(timed.op.time).toBe("10:15");
    expect((await lineAt(timed.op, la("09:40"))).time).toBe("10:15");
  });
});

describe("a now design floats (Task 13's fix wave, R1): its time is a floor, never a time passed", () => {
  it("timed 13:15 by the coach, read and approved at 13:40: the card says 13:40, no 'time passed', and it lands at 13:40, pinned", async () => {
    const { id, op } = await designed({ kind: "now" }, { kind: "new", date: TODAY, time: "13:15" }, la("13:01"));
    expect(op.target).toEqual({ kind: "new", date: TODAY, atNow: true, notBefore: "13:15" });
    const line = await lineAt(op, la("13:40"));
    expect(line.time).toBe("13:40");
    expect(line).not.toHaveProperty("timePassed");
    const answer = await approveAt(id, la("13:40"));
    expect(answer.refused).toEqual([]);
    expect(answer.applied[0]!.workout.time).toBe("13:40");
    expect(answer.applied[0]!.moved).toBeUndefined();
    expect(await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, answer.applied[0]!.workout.id))).toHaveLength(1);
  });

  it("a time already gone by when the coach proposes is dropped, not refused: the workout is for now", async () => {
    const { result } = await propose({ kind: "now" }, { kind: "new", date: TODAY, time: "09:00" }, la("09:32"));
    expect(isToolErr(result)).toBe(false);
    const { op } = await designed({ kind: "now" }, { kind: "new", date: TODAY, time: "09:00" }, la("09:32"));
    expect(op.target).toEqual({ kind: "new", date: TODAY, atNow: true, notBefore: "09:35" });
    expect(op.time).toBeUndefined();
  });

  it("an untimed now design proposed at 07:00 and approved at 07:20 lands at 07:20: its floor never holds it back (round 2, I2)", async () => {
    const { id, op } = await designed({ kind: "now" }, { kind: "new", date: TODAY }, la("07:00", 20));
    expect(op.target).toEqual({ kind: "new", date: TODAY, atNow: true, notBefore: "07:05" });
    expect((await approveAt(id, la("07:20"))).applied[0]!.workout.time).toBe("07:20");
  });

  it("a later day named in a now run keeps its time as asked; so does a set's workout for today", async () => {
    const later = await designed({ kind: "now" }, { kind: "new", date: addDays(TODAY, 1), time: "08:00" }, la("09:31"));
    expect(later.op.target).toEqual({ kind: "new", date: addDays(TODAY, 1), time: "08:00" });
    const set = await designed({ kind: "week" }, { kind: "new", date: TODAY, time: "11:00" }, la("09:31"));
    expect(set.op.target).toEqual({ kind: "new", date: TODAY, time: "11:00" });
  });
});

// ── Approve ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("approve: never a time already past", () => {
  it("today, no time, the usual time gone by: the next quarter hour from now, pinned — and the line says so first", async () => {
    // A set's workout for today, untimed; the athlete's usual time is 07:00 and it is 09:32 there.
    const { id, op } = await designed({ kind: "week" }, { kind: "new", date: TODAY }, la("09:20"));
    expect(op.target).toEqual({ kind: "new", date: TODAY });
    expect((await lineAt(op, la("09:32", 10))).time).toBe("09:45");
    const answer = await approveAt(id, la("09:32", 10));
    const workout = answer.applied[0]!.workout;
    expect(workout.time).toBe("09:45");
    expect(answer.applied[0]!.moved).toBeUndefined();
    expect(await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, workout.id))).toHaveLength(1);
  });

  it("today, no time, the usual time still ahead: the athlete's window, as before (the line says it too)", async () => {
    // An afternoon window, clear of the fixture's 07:00 and 18:00 sessions (a collision pass may still move a placed one).
    const evening: UserPreferences = { ...prefs, defaultWindow: "evening", weekdayEveningTime: "15:00" };
    const { id, op } = await designed({ kind: "week" }, { kind: "new", date: TODAY }, la("09:20"));
    expect((await lineAt(op, la("09:32"), evening)).time).toBe("15:00");
    const answer = await approveAt(id, la("09:32"), evening);
    expect(answer.applied[0]!.workout.time).toBe("15:00");
    // Placed at the window, as a Studio save places one: no time asked for, nothing pinned.
    expect(await db.select().from(scheduleOverrides).where(eq(scheduleOverrides.workoutId, answer.applied[0]!.workout.id))).toHaveLength(0);
  });

  it("a later day, no time: the window, as before; the line carries it", async () => {
    // A Tuesday the fixture leaves empty.
    const later = addDays(TODAY, 13);
    const { id, op } = await designed({ kind: "week" }, { kind: "new", date: later }, la("09:20"));
    expect((await lineAt(op, la("09:32"))).time).toBe("07:00");
    expect((await approveAt(id, la("09:32"))).applied[0]!.workout.time).toBe("07:00");
  });

  it("a time the coach set that has passed since is refused in plain words, the op left open; no slot left today, the same", async () => {
    const { id, op } = await designed({ kind: "week" }, { kind: "new", date: TODAY, time: "09:45" }, la("09:20"));
    // Still ahead, the line is plain; gone by, it says so (the polish round, 4) — never the old time as if it stood.
    expect(await lineAt(op, la("09:30"))).not.toHaveProperty("timePassed");
    expect(await lineAt(op, la("10:00"))).toMatchObject({ time: "09:45", timePassed: true });
    const late = await approveAt(id, la("10:00"));
    expect(late.applied).toEqual([]);
    expect(late.refused).toEqual([expect.objectContaining({ error: "past_time", why: "09:45 today has passed." })]);
    expect(late.status).toBe("pending");
    const untimed = await designed({ kind: "week" }, { kind: "new", date: TODAY }, la("09:20"));
    expect(await lineAt(untimed.op, la("23:50"))).toMatchObject({ timePassed: true });
    const nearMidnight = await approveAt(untimed.id, la("23:50"));
    // No slot left before midnight has its own code (the polish round, 5).
    expect(nearMidnight.refused).toEqual([expect.objectContaining({ error: "no_time_today", why: "There's no time left today." })]);
  });

  it("Edit before approve runs the same check: the edit's time, or the coach's when the edit leaves it — refused as a save is", async () => {
    const { id, op } = await designed({ kind: "week" }, { kind: "new", date: TODAY, time: "11:00" }, la("09:20"));
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const editAt = (edit: Record<string, unknown>, now: Date) =>
      approveDesignOps(db, userId, { ...p!, ops: p!.ops as DesignedOp[] }, { edit: { opId: op.by.runId, doc: op.doc as unknown as Record<string, unknown>, ...edit } }, { today: TODAY, now: now.toISOString(), prefs }, Number.POSITIVE_INFINITY);
    await expect(editAt({ time: "08:00" }, la("09:32"))).rejects.toMatchObject({ code: "past_time", why: "08:00 today has passed." });
    await expect(editAt({}, la("11:30"))).rejects.toMatchObject({ code: "past_time", why: "11:00 today has passed." });
    // A later day, or a time still ahead, is approved as before.
    expect((await editAt({ time: "10:30" }, la("09:32"))).applied).toHaveLength(1);
  });

  it("found again after a crash, a time the approve placed is no move of the athlete's", async () => {
    const { id } = await designed({ kind: "now" }, { kind: "new", date: TODAY }, la("09:31"));
    const [untouched] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const first = await approveAt(id, la("09:32"));
    expect(first.applied[0]).toMatchObject({ workout: { time: "09:35" } });
    expect(first.applied[0]!.moved).toBeUndefined();
    // The proposal's record lost: the plan read finds the workout, pinned at the approve's own time — not moved.
    await db.update(coachProposals).set({ ops: untouched!.ops, status: "pending", resolvedAt: null }).where(eq(coachProposals.id, id));
    const again = await approveAt(id, la("09:40"));
    expect(again.applied.map((x) => [x.workout.time, x.moved ?? false])).toEqual([["09:35", false]]);
  });
});

// ── The card's time is where the approve will put it (the lead's case, from Part U's QA) ───────────────────────────

describe("a set's workout on a day that holds another session: the line says where the approve will put it", () => {
  // Two days on, the fixture holds its programme's 07:00 session (35 min): the athlete's window, 07:00, is taken.
  const busy = addDays(TODAY, 2);
  /** The card's read of a proposal, as GET /api/coach/proposals/:id answers it. */
  const card = async (id: string, now: Date) => {
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    return (await designedManifest(db, userId, id, p!.ops, now)).lines;
  };
  /** A set of these workouts (untimed), each its own designer's, made pending with a review. */
  async function set(dates: string[], o: { skipFirst?: string } = {}): Promise<string> {
    const main = await run("main", { kind: "week" });
    for (const [i, date] of dates.entries()) {
      const designer = await run("designer", { kind: "week" }, main.id);
      const r = await proposeWorkout.run(ctxOf(designer, la("09:20")), { doc: calmDoc({ title: `Set ${i + 1}` }), target: { kind: "new", date } });
      if (isToolErr(r)) throw new Error(r.why);
    }
    if (o.skipFirst) {
      const r = await adjustPlan.run(ctxOf(main, la("09:20")), { workoutId: o.skipFirst, change: { kind: "skip", reason: "Rest the legs." }, why: "A lighter week." });
      if (isToolErr(r)) throw new Error(r.why);
    }
    const id = designProposalId(main.id);
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const ops = (p!.ops as Array<{ kind: string }>).map((x) => (x.kind === "doc_workout" ? { ...x, review: REVIEW } : x));
    await db.update(coachProposals).set({ status: "pending", ops }).where(eq(coachProposals.id, id));
    return id;
  }
  const programmeOn = async (date: string) =>
    (await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.effectiveDate, date), eq(plannedWorkouts.origin, "program"))))[0]!;

  it("one workout: the line's time is the approve's, after the day's other session — never the window it can't have", async () => {
    const id = await set([busy]);
    const [line] = await card(id, la("09:32"));
    expect(line!.time).not.toBe("07:00");
    const answer = await approveAt(id, la("09:32"));
    expect(answer.applied).toHaveLength(1);
    expect(answer.applied[0]!.workout.time).toBe(line!.time);
  });

  it("two on one day: each line is where its approve puts it, the second's pass weighed for both", async () => {
    const id = await set([busy, busy]);
    const lines = await card(id, la("09:32"));
    const answer = await approveAt(id, la("09:32"));
    const written = new Map((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).map((w) => [w.id, w.effectiveTime]));
    expect(answer.applied.map((a) => written.get(a.workout.id))).toEqual(lines.map((l) => l.time));
    expect(new Set(lines.map((l) => l.time)).size).toBe(2);
  });

  it("with the suggestion's own skip of that day's session first: the window is free, and the line says it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(la("09:32"));
    try {
      const programme = await programmeOn(busy);
      const id = await set([busy], { skipFirst: programme.id });
      const [line] = await card(id, la("09:32"));
      expect(line!.time).toBe("07:00");
      const answer = await approveAt(id, la("09:32"));
      expect(answer.changed).toHaveLength(1);
      expect(answer.applied[0]!.workout.time).toBe("07:00");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the card's read is still one statement for the lines", async () => {
    const id = await set([busy, addDays(TODAY, 3)]);
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const before = statementsSeen;
    await designedManifest(db, userId, id, p!.ops, la("09:32"));
    expect(statementsSeen - before).toBe(1);
  });
});

describe("the card's time, every rule the approve's writes follow (design-placement.ts)", () => {
  // Tomorrow and the Monday after: days the fixture leaves empty.
  const free = addDays(TODAY, 1);
  const other = addDays(TODAY, 5);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(la("09:32"));
  });
  afterEach(() => vi.useRealTimers());

  /** A session on the plan: a watch-plan run (no document), or a Studio workout with its document (revision 1). */
  async function session(o: { date: string; time: string; minutes?: number; studio?: WorkoutDoc }): Promise<string> {
    const id = `pw-${newId().slice(0, 10)}`;
    const seconds = o.studio ? deriveDoc(o.studio, EXERCISES).estimatedMinutes * 60 : (o.minutes ?? 45) * 60;
    await db.insert(plannedWorkouts).values({
      id, userId, planId: o.studio ? `studio-${userId}` : "coros-plan", sourceWorkoutId: id, title: o.studio ? o.studio.title : "Easy run",
      category: o.studio ? "strength" : "easy", sport: o.studio ? "strength" : "run", originalPlanDate: o.date, lastVerifiedCorosDate: o.date, effectiveDate: o.date,
      effectiveTime: o.time, sourceContentFingerprint: o.studio ? "studio" : "fp", sourceEstimatedDurationSeconds: o.studio ? null : seconds,
      fallbackEstimatedDurationSeconds: o.studio ? seconds : null, calendarBlockDurationSeconds: bookedSeconds(seconds), completionState: "scheduled",
      origin: o.studio ? "studio" : null, contentState: "outline", workoutDoc: o.studio ? JSON.stringify(o.studio) : null, workoutDocRev: o.studio ? 1 : null,
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    return id;
  }

  /** A set's proposal: its main coach's changes first, then each workout its own designer's (ids as given). */
  async function suggestion(o: {
    changes?: unknown[];
    workouts?: Array<{ target: DocWorkoutTarget; doc?: WorkoutDoc; designerId?: string }>;
    mainId?: string;
  }): Promise<string> {
    const main = o.mainId ? await runWithId(o.mainId, "main", { kind: "week" }, null) : await run("main", { kind: "week" });
    for (const c of o.changes ?? []) {
      const r = await adjustPlan.run(ctxOf(main, la("09:32")), c);
      if (isToolErr(r)) throw new Error(`adjust refused: ${r.why}`);
    }
    for (const w of o.workouts ?? []) {
      const designer = w.designerId ? await runWithId(w.designerId, "designer", { kind: "week" }, main.id) : await run("designer", { kind: "week" }, main.id);
      const r = await proposeWorkout.run(ctxOf(designer, la("09:32")), { doc: w.doc ?? calmDoc({ title: "Set" }), target: w.target });
      if (isToolErr(r)) throw new Error(`propose refused: ${r.why}`);
    }
    const id = designProposalId(main.id);
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const ops = (p!.ops as Array<{ kind: string }>).map((x) => (x.kind === "doc_workout" ? { ...x, review: REVIEW } : x));
    await db.update(coachProposals).set({ status: "pending", ops }).where(eq(coachProposals.id, id));
    return id;
  }
  /** Each workout's line time, then each one's time once everything is approved: the two must agree. */
  async function saidAndWritten(id: string): Promise<{ said: Array<string | null>; written: Array<string | undefined> }> {
    const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
    const lines = (await designedManifest(db, userId, id, p!.ops, la("09:32"))).lines;
    const answer = await approveAt(id, la("09:32"));
    expect(answer.refused).toEqual([]);
    const rows = new Map((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).map((w) => [w.id, w.effectiveTime]));
    return { said: lines.map((l) => l.time), written: answer.applied.map((a) => rows.get(a.workout.id)) };
  }

  it("the approve route answers an edit at a time gone by as a save's refusal: 422, its code and plain words", async () => {
    const { id, op } = await designed({ kind: "week" }, { kind: "new", date: TODAY, time: "11:00" }, la("09:20"));
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const app = mountRoutes(db, "/api/coach", coachRoutes);
    const res = await app.request(
      `/api/coach/proposals/${id}/approve`,
      { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ edit: { opId: op.by.runId, doc: op.doc, time: "08:00" } }) },
      { APP_URL: "https://app.test", FIXTURE_MODE: "0", COACH_DESIGNER: "1" } as Env,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "past_time", why: "08:00 today has passed." });
  });

  it("a move to today never lands at a past time: the tool refuses it, teaching the fix, and so does the approve", async () => {
    const tomorrow = await session({ date: free, time: "07:00" });
    const main = await run("main", { kind: "now" });
    const move = (toTime?: string) => ({ workoutId: tomorrow, change: { kind: "move", toDate: TODAY, ...(toTime ? { toTime } : {}) }, why: "Today has room." });
    // No toTime: it keeps its own 07:00 — gone by at 09:32.
    const kept = await adjustPlan.run(ctxOf(main, la("09:32")), move());
    expect(kept).toMatchObject({ error: "past_time" });
    expect((kept as ToolErr).why).toContain("07:00");
    expect((kept as ToolErr).fix).toMatch(/toTime/);
    expect((kept as ToolErr).fix).toContain("09:47");
    // Less than 15 minutes ahead: too soon; 15 minutes on: it stands.
    expect(await adjustPlan.run(ctxOf(main, la("09:32")), move("09:40"))).toMatchObject({ error: "time_too_soon" });
    expect(isToolErr(await adjustPlan.run(ctxOf(main, la("09:32")), move("09:47")))).toBe(false);
    // Approved once that time has gone by: past_time, the session left where it was.
    const id = designProposalId(main.id);
    await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, id));
    const late = await approveAt(id, la("09:40"));
    expect(late.changed).toEqual([]);
    expect(late.refused).toEqual([expect.objectContaining({ error: "past_time" })]);
    expect((await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, tomorrow)))[0]!).toMatchObject({ effectiveDate: free, effectiveTime: "07:00" });
  });

  it("a revision whose length now collides: its line is where the day's pass puts it", async () => {
    // A short calm workout at 07:00 clears a run at 07:40; six times as long, it doesn't — and the run, the heavier
    // session, keeps the window.
    const calm = calmDoc({ title: "Calm" });
    const studio = await session({ date: free, time: "07:00", studio: calm });
    await session({ date: free, time: "07:40" });
    const sixTimes = { ...calm, title: "Calm, longer", parts: Array.from({ length: 6 }, () => calm.parts).flat() };
    const id = await suggestion({ workouts: [{ target: { kind: "revise", workoutId: studio, baseRev: 1 }, doc: sixTimes }] });
    const { said, written } = await saidAndWritten(id);
    expect(said[0]).not.toBe("07:00");
    expect(written).toEqual(said);
  });

  it("a session moved onto the day first: the day is laid out again before a revision of the same length", async () => {
    const studio = await session({ date: free, time: "07:00", studio: studioDoc({ title: "Strong hips" }) });
    const run2 = await session({ date: other, time: "07:00" });
    const id = await suggestion({
      changes: [{ workoutId: run2, change: { kind: "move", toDate: free, toTime: "07:20" }, why: "Monday is full." }],
      workouts: [{ target: { kind: "revise", workoutId: studio, baseRev: 1 }, doc: studioDoc({ title: "Strong hips, the same length" }) }],
    });
    const { said, written } = await saidAndWritten(id);
    expect(said[0]).not.toBe("07:00");
    expect(written).toEqual(said);
  });

  it("a session moved within its day keeps its new time — pinned — and the new workout goes around it", async () => {
    await session({ date: free, time: "07:00", studio: studioDoc({ title: "Strong hips" }) });
    const run1 = await session({ date: free, time: "12:00" });
    const id = await suggestion({
      changes: [{ workoutId: run1, change: { kind: "move", toDate: free, toTime: "07:20" }, why: "Run before work." }],
      workouts: [{ target: { kind: "new", date: free } }],
    });
    const { said, written } = await saidAndWritten(id);
    expect(written).toEqual(said);
  });

  it("a run given a new length first: the new workout goes after the longer run", async () => {
    const run1 = await session({ date: free, time: "07:00", minutes: 45 });
    const id = await suggestion({
      changes: [{ workoutId: run1, change: { kind: "adjust", durationMinutes: 120 }, why: "A long run this week." }],
      workouts: [{ target: { kind: "new", date: free } }],
    });
    const { said, written } = await saidAndWritten(id);
    expect(written).toEqual(said);
  });

  it("two workouts alike on one day: the one whose approve key sorts first takes the window, as the approve's layout breaks the tie", async () => {
    await session({ date: free, time: "07:00" });
    // Designer ids whose order is the opposite of their workouts' keys: the line must follow the keys.
    const mainId = `run-tie-${newId().slice(0, 8)}`;
    const proposalId = designProposalId(mainId);
    let pair: [string, string] | null = null;
    for (let i = 0; i < 40 && !pair; i += 2) {
      const a = `ds-tie-${String(i).padStart(2, "0")}`;
      const b = `ds-tie-${String(i + 1).padStart(2, "0")}`;
      if ((await keyedRowId(userId, approvalKey(proposalId, a))) > (await keyedRowId(userId, approvalKey(proposalId, b)))) pair = [a, b];
    }
    expect(pair).not.toBeNull();
    const id = await suggestion({
      mainId,
      workouts: [
        { target: { kind: "new", date: free }, designerId: pair![0] },
        { target: { kind: "new", date: free }, designerId: pair![1] },
      ],
    });
    const { said, written } = await saidAndWritten(id);
    expect(written).toEqual(said);
  });
});
