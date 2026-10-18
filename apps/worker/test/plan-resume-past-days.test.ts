/**
 * A WHOLE PLAN FINISHED DAYS LATER, ON THE DESIGN PATH (review-1 I2; §8 §4 and §5). A plan the conversation coach
 * proposed is applied a chunk a request (design-approve.ts, through `applyStructuralChunk`); a started one resumes
 * whatever the date. Resumed after some of its days have gone — the phone backgrounded mid-approve, "Finish adding" days
 * later — it leaves those sessions out: no row to turn "missed", no watch create for a day gone. The plan's summary
 * says how many. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { approveDesignOps } from "../src/services/design-approve.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { mondayOf, proposePlan } from "../src/services/design-tools/propose-plan.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { coachProposals, plannedWorkouts, corosWriteJobs } = schema;

const env = {
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  AI_GATEWAY_API_KEY: "test-key",
  COACH_DESIGNER: "1",
} as unknown as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let monday: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  monday = mondayOf(addDays(todayInZone(prefs.timezone), 7));
});

afterEach(() => {
  vi.useRealTimers();
});

const easy = (minutes: number, title: string) => ({ category: "easy", title, durationMinutes: minutes, run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] } });

/** A main run's plan proposal of 14 daily runs from Monday, made pending as its finish makes it. */
async function planned(): Promise<string> {
  const id = `run-${newId()}`;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Plan my next weeks", status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  const ctx: ToolContext = { db, env, userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` };
  const change = {
    kind: "createPlan",
    discipline: "run",
    name: "Base block",
    startDate: monday,
    endDate: addDays(monday, 27),
    firmSessions: Array.from({ length: 14 }, (_, n) => ({ date: addDays(monday, n), session: easy(30 + n, `Run ${n + 1}`) })),
    shapeWeeks: [2, 3].map((k) => ({ weekStart: addDays(monday, 7 * k), volumeTarget: "about 30 km", keySessions: ["long run"] })),
  };
  const res = await proposePlan.run(ctx, { change, why: "A steady build." });
  if (isToolErr(res)) throw new Error(`propose_plan refused: ${res.error} — ${res.why}`);
  await db.update(coachProposals).set({ status: "pending" }).where(eq(coachProposals.id, designProposalId(id)));
  return designProposalId(id);
}

/** One approve of every open op, with `budget` for the request, on the clock as it stands. */
async function approveOnce(id: string, budget?: number) {
  const [p] = await db.select().from(coachProposals).where(eq(coachProposals.id, id));
  const now = nowInstant();
  return approveDesignOps(db, userId, { id: p!.id, title: p!.title, status: p!.status, ops: p!.ops, resolvedAt: p!.resolvedAt }, {}, { today: todayInZone(prefs.timezone), now, prefs }, budget);
}

describe("a whole plan from the conversation, finished days later", () => {
  it("leaves out the sessions whose days have passed — no row, no watch create — and its summary says so", async () => {
    const id = await planned();
    // Part of it today: a request with a small room.
    const first = await approveOnce(id, 20);
    expect(first.remaining).toEqual(["plan"]);
    const own = `cw-${id}-0-`;
    const rowsNow = await db.select({ id: plannedWorkouts.id }).from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), like(plannedWorkouts.id, `${own}%`)));
    const added = rowsNow.length;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(13);
    // The rest on Monday+13, in the athlete's zone — past the stale window, so the next approve takes the claim over.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${addDays(monday, 13)}T20:00:00Z`));
    let answer = await approveOnce(id);
    for (let i = 0; i < 20 && answer.remaining.length > 0; i++) answer = await approveOnce(id);
    const passed = 13 - added;
    expect(answer.planned).toEqual([{ opId: "plan", summary: `Added “Base block” with ${14 - passed} sessions and 2 weeks sketched out — ${passed} days had passed and were left out` }]);
    const rows = await db.select({ id: plannedWorkouts.id, date: plannedWorkouts.effectiveDate }).from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), like(plannedWorkouts.id, `${own}%`)));
    expect(rows.filter((r) => r.date < addDays(monday, 13))).toHaveLength(added);
    expect(rows.map((r) => r.id)).toContain(`${own}13`);
    const jobs = await db.select({ day: corosWriteJobs.originalDate }).from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));
    expect(jobs.filter((j) => j.day < addDays(monday, 13))).toHaveLength(added);
  });
});
