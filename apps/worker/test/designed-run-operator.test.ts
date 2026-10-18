/**
 * THE OPERATOR PATHS ON A DESIGNED RUN (§8 §3; review-2 M2): the content convergence (`convergeDivergedContent`, the
 * operator's backfill and the census) and the absent-session push (`pushAbsentSessions`) rebuild a session for the
 * watch from the row. A designed run's is its document's `run_watch` session — its tempo and its bare recoveries, its
 * repeats — never its stage rows read as a thread-coach run ("tempo" as threshold, the jog as easy work, a repeat
 * unpushable). And a designed run they cannot time is left alone: never unpushed, never rebuilt wrongly. Synthetic
 * data; a fixed Friday.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, runWatchSessionOf, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { convergeDivergedContent } from "../src/services/content-converge.js";
import { designedRunStages } from "../src/services/designed-runs.js";
import { pushAbsentSessions } from "../src/services/push-absent.js";
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

const doc = (cooldown: Record<string, unknown> = { durationSec: 600 }): WorkoutDoc => ({
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [{ kind: "run", effort: "tempo", target: { durationSec: 480 } }, { kind: "run", effort: "recovery", target: { durationSec: 120 } }] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: cooldown }] },
  ],
  source: { kind: "coach", ref: "run:r-1" },
  basedOn: { kind: "proposal", id: "dp-r-1", opId: "r-1" },
});
const sessionOf = (d: WorkoutDoc) => {
  const made = runWatchSessionOf(d);
  if (!("session" in made)) throw new Error(made.refused);
  return made.session;
};

/** A designed run the approve wrote; `pushed`: the lane put it on the watch (its verified create, its address). */
async function seed(d: WorkoutDoc, opts: { pushed: boolean; paceDebt?: boolean; threshold?: boolean }): Promise<string> {
  const id = newId();
  await db.insert(plannedWorkouts).values({
    id, userId, planId: `studio-${userId}`, sourceWorkoutId: opts.pushed ? "4242:8" : id, ...(opts.pushed ? { sourceProgramId: "8", sourceIdInPlan: "8" } : {}),
    title: "Tempo blocks", category: "quality", qualitySubtype: "tempo", sport: "run", originalPlanDate: DAY, lastVerifiedCorosDate: opts.pushed ? DAY : "",
    effectiveDate: DAY, effectiveTime: "07:00", sourceContentFingerprint: "0123456789abcdef", fallbackEstimatedDurationSeconds: 3000,
    calendarBlockDurationSeconds: 3000, stageSummary: "10 min easy · 3 × 8 min tempo / 2 min recovery · 10 min easy",
    corosSyncState: opts.pushed ? "synced" : "calendar_only", completionState: "scheduled", origin: null, workoutDoc: JSON.stringify(d), workoutDocRev: 1,
    createdAt: NOON, updatedAt: NOON,
  });
  await db.insert(plannedWorkoutStages).values(designedRunStages(id, d, opts.threshold === false ? null : 289));
  if (opts.pushed) {
    await db.insert(corosWriteJobs).values({
      id: `${id}-push`, userId, workoutId: id, kind: "coach_create_workout", expectedContentFingerprint: "x", originalDate: DAY, destinationDate: DAY,
      payload: { workoutId: id, happenDay: DAY, name: `Tempo blocks — ${DAY}`, session: sessionOf(d) },
      requestedAt: NOON, status: "verified", verifiedAt: NOON, updatedAt: NOON, ...(opts.paceDebt ? { lastErrorCategory: "pace_targets_owed" } : {}),
    });
  }
  if (opts.threshold !== false) {
    await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: DAY, thresholdPaceSecPerKm: 289, contentFingerprint: "h", updatedAt: NOON });
  }
  return id;
}
const jobsOf = (id: string, kind: string) => db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, id), eq(corosWriteJobs.kind, kind)));

describe("the content convergence on a designed run", () => {
  it("rewrites it from its document's run_watch session — tempo, bare recoveries, repeats — never from its stage rows", async () => {
    // Created with no threshold (its paces owed), one known since: the backfill's pace-debt evidence.
    const id = await seed(doc(), { pushed: true, paceDebt: true });
    const plan = await convergeDivergedContent(db, userId, { dryRun: true });
    expect(plan.rows.find((r) => r.workoutId === id)).toMatchObject({ action: "rewrite", evidence: ["pace_targets_never_pushed"] });
    await convergeDivergedContent(db, userId, { dryRun: false });
    const [job] = await jobsOf(id, "coach_update_workout");
    expect((job!.payload as { session: unknown }).session).toEqual(sessionOf(doc()));
    expect((job!.payload as { thresholdPaceSecPerKm?: number }).thresholdPaceSecPerKm).toBe(289);
  });

  it("a designed run it can't time (a distance, no threshold in hand) is left alone — never unpushed", async () => {
    const id = await seed(doc({ distanceM: 2000 }), { pushed: true, threshold: false });
    await db.insert(syncIntents).values({ id: newId(), userId, targetKind: "workout", targetId: id, kind: "content", payload: null, source: "coach_ease", createdAt: NOON });
    const plan = await convergeDivergedContent(db, userId, { dryRun: false, only: "open_content_intent" });
    const row = plan.rows.find((r) => r.workoutId === id)!;
    expect(row.action).toBe("skipped");
    expect(row.reason).toMatch(/designed run/);
    expect(await jobsOf(id, "coach_delete_workout")).toEqual([]);
    expect(await jobsOf(id, "coach_update_workout")).toEqual([]);
  });
});

describe("the absent-session push on a designed run", () => {
  it("sends it as its document's run_watch session, repeats and all", async () => {
    const id = await seed(doc(), { pushed: false });
    const plan = await pushAbsentSessions(db, userId, { dryRun: true });
    expect(plan.rows.find((r) => r.workoutId === id)).toMatchObject({ action: "push" });
    await pushAbsentSessions(db, userId, { dryRun: false });
    const [job] = await jobsOf(id, "coach_create_workout");
    expect((job!.payload as { session: unknown }).session).toEqual(sessionOf(doc()));
  });

  it("a distance no pace can time yet: unpushable, and says why", async () => {
    const id = await seed(doc({ distanceM: 2000 }), { pushed: false, threshold: false });
    const plan = await pushAbsentSessions(db, userId, { dryRun: false });
    const row = plan.rows.find((r) => r.workoutId === id)!;
    expect(row.action).toBe("unpushable");
    expect(row.reason).toMatch(/threshold/);
    expect(await jobsOf(id, "coach_create_workout")).toEqual([]);
  });
});
