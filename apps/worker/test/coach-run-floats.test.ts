/**
 * A THREAD-COACH RUN'S JOGS ARE RECOVERIES IN ITS STAGE ROWS (audit D4, 2026-10-23). The coach's words "recovery",
 * "jog" and "float" all fold onto `easy`, and the rows took the wire's roles (`runBlockRoles`), which call an easy block
 * between two reps work: an 11-stage quality session stored its four jogs as work, so the coach's PLAN CONTEXT read nine
 * work stages and the sheet's Full structure "work — 2 min (easy)". The rows now say recovery; the watch's copy is
 * byte for byte what it was (a role-4 step would drop the jog's easy band). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, type CoachSession } from "@rg/domain";
import { buildRunProgram } from "@rg/coros";
import { coachStageRows, writeStages } from "../src/services/coach-apply.js";
import { buildEffortPackage } from "../src/services/coach-effort.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const min = (value: number, intensity: "easy" | "threshold") => ({ kind: "duration" as const, value, intensity });
/** 10 easy · 5 × 5 min threshold with a 2 min jog between · 10 easy: eleven blocks. */
const session: CoachSession = {
  category: "quality",
  title: "Threshold 5×5",
  durationMinutes: 53,
  run: {
    blocks: [
      min(10, "easy"),
      ...Array.from({ length: 5 }, (_, k) => (k < 4 ? [min(5, "threshold"), min(2, "easy")] : [min(5, "threshold")])).flat(),
      min(10, "easy"),
    ],
  },
};
const KINDS = ["warmup", "work", "recovery", "work", "recovery", "work", "recovery", "work", "recovery", "work", "cooldown"];

describe("a thread-coach run's stage rows", () => {
  it("call a jog between two reps a recovery, keeping its label and its easy band", () => {
    const rows = coachStageRows("cw-t-0-0", session, 289);
    expect(rows.map((r) => r.kind)).toEqual(KINDS);
    expect(rows.map((r) => r.label)).toEqual(session.run!.blocks.map((b) => b.intensity));
    expect(rows[2]).toMatchObject({ durationSeconds: 120, targetType: "pace", targetLow: 349, targetHigh: 409 });
    // An easy run with no reps between its blocks has no jog to find; a walk-back stays the recovery it always was.
    expect(coachStageRows("cw-e", { category: "easy", title: "Easy", durationMinutes: 40, run: { blocks: [min(20, "easy"), min(20, "easy")] } }).map((r) => r.kind)).toEqual(["work", "work"]);
  });

  it("leave the watch's copy as it was: the jogs go as 'Run' steps with the easy band", () => {
    const p = buildRunProgram({ happenDay: "20261027", name: "Threshold 5×5", session, thresholdPaceSecPerKm: 289 });
    const steps = (p.exercises as Array<Record<string, number>>).map((e) => [e.exerciseType, e.targetValue, e.intensityValue, e.intensityValueExtend]);
    const easy = (s: number) => [s, 349_000, 409_000];
    const rep = [2, 300, 289_000, 313_000];
    expect(steps).toEqual([[1, ...easy(600)], rep, [2, ...easy(120)], rep, [2, ...easy(120)], rep, [2, ...easy(120)], rep, [2, ...easy(120)], rep, [3, ...easy(600)]]);
  });

  it("reach the coach's plan context as recoveries — five reps, not nine", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const workoutId = "cw-t-0-0";
    await db.insert(schema.plannedWorkouts).values({
      id: workoutId, userId, planId: "p", sourceWorkoutId: workoutId, title: session.title, category: "quality", sport: "run",
      originalPlanDate: "2026-10-09", lastVerifiedCorosDate: "", effectiveDate: "2026-10-09", effectiveTime: "07:00",
      completionState: "completed", resolutionDate: "2026-10-09", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3180,
      createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    await writeStages(db, workoutId, session, 289);
    const stored = await db.select().from(schema.plannedWorkoutStages).where(eq(schema.plannedWorkoutStages.workoutId, workoutId)).orderBy(asc(schema.plannedWorkoutStages.ord));
    expect(stored.map((s) => s.kind)).toEqual(KINDS);
    const activityId = newId();
    await db.insert(schema.activities).values({
      id: activityId, userId, startTime: "2026-10-09T14:00:00Z", startTimeLocal: "2026-10-09T07:00:00", sport: "run", durationSeconds: 3180,
      sourceMergeConfidence: 1, createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    await db.insert(schema.workoutCompletionMatches).values({ id: "m1", workoutId, activityId, confidence: 1, method: "coros_plan_link", matchedAt: nowInstant() });
    const text = (await buildEffortPackage(db, userId, activityId))!.text;
    expect(text).toContain('  recovery "easy": 2:00 @ 5:49/km–6:49/km');
    expect(text.match(/^ {2}work "threshold"/gm)).toHaveLength(5);
    expect(text).not.toContain('work "easy"');
  });
});
