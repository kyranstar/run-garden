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
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { approveDesignOps, type DesignedOp } from "../src/services/design-approve.js";
import { docWorkoutLines, placeNamer } from "../src/services/design-manifest.js";
import { designProposalId, proposeWorkout, type DocWorkoutTarget } from "../src/services/design-tools/propose.js";
import { isToolErr, type OpReview, type RunScope, type ToolContext, type ToolErr, type ToolRole } from "../src/services/design-tools/types.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb } from "./helpers.js";

const { coachProposals, plannedWorkouts, scheduleOverrides } = schema;
const ENV = {} as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
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
  const id = `run-${++seq}-${newId().slice(0, 8)}`;
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

  it("no time left today: refused, and it says to plan another day", async () => {
    const { result } = await propose({ kind: "later_today" }, { kind: "new", date: TODAY }, la("23:50"));
    expect((result as ToolErr).error).toBe("needs_time");
    expect((result as ToolErr).fix).toMatch(/another day|tomorrow/);
  });
});

describe("any design: a time today already past is refused at propose", () => {
  it("a set's designer, and the main coach for now", async () => {
    const designer = await propose({ kind: "week" }, { kind: "new", date: TODAY, time: "08:00" }, la("09:32"), "designer");
    expect((designer.result as ToolErr).error).toBe("past_time");
    expect((designer.result as ToolErr).why).toMatch(/08:00.*passed/);
    const now = await propose({ kind: "now" }, { kind: "new", date: TODAY, time: "09:00" }, la("09:32"));
    expect((now.result as ToolErr).error).toBe("past_time");
    // A later day's morning is no past time; nor is this minute.
    expect(isToolErr((await propose({ kind: "week" }, { kind: "new", date: addDays(TODAY, 1), time: "08:00" }, la("09:32"), "designer")).result)).toBe(false);
    expect(isToolErr((await propose({ kind: "now" }, { kind: "new", date: TODAY, time: "09:32" }, la("09:32", 20))).result)).toBe(false);
  });
});

// ── Now ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("now: no time means the moment of the approve, rounded up to five minutes", () => {
  it("the op is marked for now; the approve places it then, pinned; the line said the same time", async () => {
    const { id, op } = await designed({ kind: "now" }, { kind: "new", date: TODAY }, la("09:31"));
    expect(op.target).toEqual({ kind: "new", date: TODAY, atNow: true });
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

  it("on the minute, it stays on the minute; a timed now workout keeps its own time", async () => {
    const { op } = await designed({ kind: "now" }, { kind: "new", date: TODAY }, la("09:31"));
    expect((await lineAt(op, la("09:40"))).time).toBe("09:40");
    const timed = await designed({ kind: "now" }, { kind: "new", date: TODAY, time: "10:15" }, la("09:31"));
    expect(timed.op.target).toEqual({ kind: "new", date: TODAY, time: "10:15" });
    expect((await lineAt(timed.op, la("09:40"))).time).toBe("10:15");
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
    expect((await lineAt(op, la("10:00"))).time).toBe("09:45");
    const late = await approveAt(id, la("10:00"));
    expect(late.applied).toEqual([]);
    expect(late.refused).toEqual([expect.objectContaining({ error: "past_time", why: "09:45 today has passed." })]);
    expect(late.status).toBe("pending");
    const untimed = await designed({ kind: "week" }, { kind: "new", date: TODAY }, la("09:20"));
    const nearMidnight = await approveAt(untimed.id, la("23:50"));
    expect(nearMidnight.refused).toEqual([expect.objectContaining({ error: "past_time", why: "There's no time left today." })]);
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
