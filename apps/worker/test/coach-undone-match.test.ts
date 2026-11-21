/**
 * AN UNDONE MATCH IS NO MATCH TO THE COACH (R1.3 review, MAJOR-1). The owner's correction — `unmatch` on a guess, as on the
 * Nov 20 yoga the matcher paired with "TRE · floor" — leaves the match row with `undone_at` set, the session reopened and the
 * activity unmatched. R1.3 holds that: no sync re-pairs it. So every reader must read it that way, the coach's too:
 *  - the dossier's LAST 14 DAYS: the session as it stands (not "did 25min"), the activity as unplanned;
 *  - the guardrail calendar's trailing minutes: the activity's minutes counted, as nothing else counts them now;
 *  - the effort package's PLAN CONTEXT: the activity's live match, never an undone one before it.
 * Synthetic data, on a test account.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone } from "@rg/domain";
import { buildDossier } from "../src/services/coach-context.js";
import { buildEffortPackage } from "../src/services/coach-effort.js";
import { guardrailCtx } from "../src/services/coach-wake.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { activities, plannedWorkouts, workoutCompletionMatches } = schema;

/** A test account with a 25-minute yoga two days ago, and a way to add that day's sessions. */
async function scene() {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db); // Los Angeles
  const today = todayInZone(prefs.timezone);
  const day = addDays(today, -2);
  const at = `${addDays(day, -3)}T12:00:00.000Z`;
  const session = (id: string, title: string, completionState: string) =>
    db.insert(plannedWorkouts).values({
      id, userId, planId: `studio-${userId}`, origin: "studio", sourceWorkoutId: `studio:${id}`, title, category: "yoga", sport: "yoga",
      originalPlanDate: day, lastVerifiedCorosDate: day, effectiveDate: day, effectiveTime: "18:00", sourceContentFingerprint: "fp",
      calendarBlockDurationSeconds: 1500, sourceEstimatedDurationSeconds: 1500, completionState, createdAt: at, updatedAt: at,
    });
  await db.insert(activities).values({
    id: "yoga", userId, corosActivityId: "c-yoga", source: "coros", startTime: `${day}T22:03:00Z`, startTimeLocal: `${day}T14:03:00`,
    timezone: prefs.timezone, sport: "yoga", durationSeconds: 25 * 60, sourceMergeConfidence: 1, createdAt: at, updatedAt: at,
  });
  const match = (id: string, workoutId: string, method: string, undone: boolean) =>
    db.insert(workoutCompletionMatches).values({ id, workoutId, activityId: "yoga", confidence: 0.507, method, matchedAt: at, undoneAt: undone ? nowInstant() : null });
  return { db, userId, prefs, today, day, session, match };
}

describe("an undone match is no match to the coach (R1.3 review, MAJOR-1)", () => {
  it("the dossier reads the session as it stands and the activity as unplanned; the trailing minutes count it", async () => {
    const { db, userId, prefs, today, day, session, match } = await scene();
    // As the owner's unmatch leaves it: the match undone, the session reopened, the activity unmatched.
    await session("tre", "TRE · floor", "unresolved");
    await match("m-undone", "tre", "scored_auto", true);
    const guard = await guardrailCtx(db, userId, prefs, today);
    const d = await buildDossier(db, userId, prefs, guard.today, guard);
    expect(d.text).toContain(`${day} · yoga · "TRE · floor" · unresolved`);
    expect(d.text).not.toContain("did 25min");
    expect(d.text).toContain(`${day} · unplanned yoga · 25min`);
    expect((guard.weeklyMinutesByDiscipline.yoga ?? []).reduce((x, y) => x + y, 0)).toBe(25);
  });

  it("a live match still reads as the session done, and its activity is not listed again", async () => {
    const { db, userId, prefs, today, session, match } = await scene();
    await session("tre", "TRE · floor", "completed");
    await match("m-live", "tre", "scored_auto", false);
    await db.update(activities).set({ completionMatchId: "m-live" }).where(eq(activities.id, "yoga"));
    const guard = await guardrailCtx(db, userId, prefs, today);
    const d = await buildDossier(db, userId, prefs, guard.today, guard);
    expect(d.text).toContain("did 25min");
    expect(d.text).not.toContain("unplanned yoga");
  });

  it("the effort package's plan context is the activity's live match, never an undone one before it", async () => {
    const { db, userId, session, match } = await scene();
    await session("tre", "TRE · floor", "unresolved");
    await session("flow", "Evening flow", "completed");
    // Undone first (the guess), then the owner's own match to the session it was.
    await match("m-undone", "tre", "scored_auto", true);
    await match("m-manual", "flow", "manual", false);
    await db.update(activities).set({ completionMatchId: "m-manual" }).where(eq(activities.id, "yoga"));
    const p = (await buildEffortPackage(db, userId, "yoga"))!;
    expect(p.text).toMatch(/planned: "[^"]*flow[^"]*"/i);
    expect(p.text).not.toContain("TRE");
  });
});
