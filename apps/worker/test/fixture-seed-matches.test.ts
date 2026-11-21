/**
 * THE FIXTURE ACCOUNT'S RUNS ANSWER THEIR SESSIONS (R1.3 review, MINOR-1). `seedFixtures` — the demo, FIXTURE_MODE, every
 * web e2e journey and the realistic account the budget tests measure — imports its nine-week COROS plan at the seed's own
 * clock, then ingests nine weeks of past runs with no plan link. At `59fe8c8f` the creation rule refused every guess (each
 * session "created" by the import after its run ended): 0 matches, the plan read as weeks missed. A session imported from
 * COROS is judged by its day alone (MINOR-2), so they answer again. Pinned here, as nothing pinned it before.
 */
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { seedFixtures } from "../src/services/fixtures.js";
import { activityDate } from "../src/services/garden-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { makeRealisticEnv } from "./realistic-account.js";

const { activities, plannedWorkouts, workoutCompletionMatches } = schema;

describe("the fixture account's matches (R1.3 review, MINOR-1)", () => {
  it("its runs answer their sessions: one scored match for each run session with a run on its day, each on that day", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await seedFixtures(db, makeRealisticEnv(), userId);
    const live = await db
      .select({ method: workoutCompletionMatches.method, day: plannedWorkouts.effectiveDate, startTime: activities.startTime, startTimeLocal: activities.startTimeLocal })
      .from(workoutCompletionMatches)
      .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutCompletionMatches.workoutId))
      .innerJoin(activities, eq(activities.id, workoutCompletionMatches.activityId))
      .where(and(eq(plannedWorkouts.userId, userId), isNull(workoutCompletionMatches.undoneAt)));
    const scored = live.filter((m) => m.method === "scored_auto");
    // Every run session with a run on its day is answered. The review's probe counted 32 runs with a run session on their
    // day; one day holds two runs seconds apart (a twin pair the seed keeps) for one session, so 31 sessions are answered.
    const runs = await db.select().from(activities).where(and(eq(activities.userId, userId), eq(activities.sport, "run")));
    const sessions = await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.sport, "run")));
    const answerable = sessions.filter((s) => s.category !== "rest" && runs.some((r) => activityDate(r) === s.effectiveDate));
    expect(scored).toHaveLength(answerable.length);
    expect(scored).toHaveLength(31);
    for (const m of scored) expect(activityDate(m)).toBe(m.day);
  });
});
