/**
 * THE BODY CHECK ON A DESIGNED RUN (§8 §3): a designed run lives in the coach lane, so the check eases it as it eases a
 * plan run (the thread coach's `ease`), and Undo, once the eased run reached the watch, rewrites the watch back to the
 * run as it was designed — its `run_watch` session, through the same builder its create used (the job union), never the
 * flattened stage rows. Synthetic data; a fixed Friday.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, runWatchSessionOf, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { answerBodyCheck, undoBodyCheck } from "../src/services/body-check.js";
import { designedRunStages } from "../src/services/designed-runs.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { DAY, NOON } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkoutStages, plannedWorkouts, syncIntents } = schema;
vi.setConfig({ testTimeout: 30_000 });

let db: Db;
let userId: string;
let prefs: UserPreferences;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
});
afterEach(() => vi.useRealTimers());
const ctx = () => ({ today: DAY, now: NOON, prefs });

const DOC: WorkoutDoc = {
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [{ kind: "run", effort: "tempo", target: { durationSec: 480 } }, { kind: "run", effort: "recovery", target: { durationSec: 120 } }] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
  ],
  source: { kind: "coach", ref: "run:r-1" },
  basedOn: { kind: "proposal", id: "dp-r-1", opId: "r-1" },
};
const SESSION = (() => {
  const made = runWatchSessionOf(DOC);
  if (!("session" in made)) throw new Error(made.refused);
  return made.session;
})();

/** A designed run the approve wrote and the lane put on the watch (its verified create, its address). */
async function seedPushed(): Promise<string> {
  const id = newId();
  await db.insert(plannedWorkouts).values({
    id, userId, planId: `studio-${userId}`, sourceWorkoutId: "4242:8", sourceProgramId: "8", sourceIdInPlan: "8", title: "Tempo blocks",
    category: "quality", qualitySubtype: "tempo", sport: "run", originalPlanDate: DAY, lastVerifiedCorosDate: DAY, effectiveDate: DAY,
    effectiveTime: "07:00", sourceContentFingerprint: "0123456789abcdef", fallbackEstimatedDurationSeconds: 3000, calendarBlockDurationSeconds: 3000,
    stageSummary: "10 min easy · 3 × 8 min tempo / 2 min recovery · 10 min easy", corosSyncState: "synced", completionState: "scheduled",
    origin: null, workoutDoc: JSON.stringify(DOC), workoutDocRev: 1, createdAt: NOON, updatedAt: NOON,
  });
  await db.insert(plannedWorkoutStages).values(designedRunStages(id, DOC, 289));
  await db.insert(corosWriteJobs).values({
    id: `${id}-push`, userId, workoutId: id, kind: "coach_create_workout", expectedContentFingerprint: "x", originalDate: DAY, destinationDate: DAY,
    payload: { workoutId: id, happenDay: DAY, name: `Tempo blocks — ${DAY}`, session: SESSION, thresholdPaceSecPerKm: 289 },
    requestedAt: NOON, status: "verified", verifiedAt: NOON, updatedAt: NOON,
  });
  await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: DAY, thresholdPaceSecPerKm: 289, contentFingerprint: "h", updatedAt: NOON });
  return id;
}
const rewrites = (id: string) => db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, id), eq(corosWriteJobs.kind, "coach_update_workout")));

describe("a designed run, A bit heavy, then Undo", () => {
  it("eased as a plan run is; Undo after the eased run reached the watch rewrites it back as designed (its run_watch session)", async () => {
    const id = await seedPushed();
    const eased = await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    expect(eased.view).toMatchObject({ change: { kind: "eased" } });
    const [job] = await rewrites(id);
    expect((job!.payload as { session: { run?: unknown } }).session.run).toBeDefined();
    // The drain ran: the watch holds the eased run.
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, job!.id));
    await db.update(syncIntents).set({ resolvedAt: NOON }).where(and(eq(syncIntents.targetId, id), eq(syncIntents.kind, "content")));
    await db.update(plannedWorkouts).set({ corosSyncState: "synced", sourceContentFingerprint: "fedcba9876543210" }).where(eq(plannedWorkouts.id, id));

    const undo = await undoBodyCheck(db, userId, id, ctx());
    expect(undo.coachDrain).toBe(true);
    const back = (await rewrites(id)).find((j) => j.status === "queued");
    expect((back!.payload as { session: unknown }).session).toEqual(SESSION);
    // The app's copy is the designed run again: its stages with their bands, its document.
    const stages = await db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, id)).orderBy(asc(plannedWorkoutStages.ord));
    expect(stages.map((s) => [s.kind, s.repeatCount, s.targetLow, s.label])).toEqual([
      ["warmup", null, 349, "easy"], ["repeat", 3, null, null], ["work", null, 299, "tempo"], ["recovery", null, null, "recovery"], ["cooldown", null, 349, "easy"],
    ]);
  });
});
