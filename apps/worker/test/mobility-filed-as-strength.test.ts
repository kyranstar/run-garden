/**
 * A MOBILITY SESSION FILED AS STRENGTH IS STILL MOBILITY (audit 1, ingest
 * IMPORTANT; Ruling A2 — fixed importer-side).
 *
 * COROS's program namespace has no yoga or mobility sport, so the create
 * executor files a coach mobility session under Strength and the next plan read
 * serves it back with sport "strength". The importer read that sport flip as
 * COROS recycling the slot for a different workout and rewrote the row to
 * category/sport strength — after which the sport-aware matcher (correctly)
 * refused the Yoga-mode activity the athlete recorded, and the garden booked a
 * miss against a session they did.
 *
 * It is the SAME program type. The row keeps its category and sport through
 * every read — including a content edit upstream (rule 7) — and completes from
 * the Yoga activity. The matcher keeps refusing yoga for a real lift.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, type SourceActivity, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { ingestActivities } from "../src/services/completion.js";
import { connectTestCoros, makeTestDb, makeTestUser } from "./helpers.js";

const { plannedWorkouts, corosWriteJobs } = schema;
const PLAN = "700000000000000002";
const ADDRESS = `${PLAN}:5`;

async function seedPushedMobility(db: Db, userId: string, day: string) {
  const now = nowInstant();
  await db.insert(plannedWorkouts).values({
    id: "mob",
    userId,
    planId: "adhoc-mobility",
    sourceWorkoutId: ADDRESS,
    sourceIdInPlan: "5",
    sourceProgramId: "55",
    title: "Ankles and hips",
    category: "yoga",
    sport: "yoga",
    originalPlanDate: day,
    lastVerifiedCorosDate: day,
    effectiveDate: day,
    effectiveTime: "07:00",
    sourceContentFingerprint: "0123456789abcdef",
    fallbackEstimatedDurationSeconds: 1200,
    calendarBlockDurationSeconds: 1200,
    structuredJson: { exercises: [{ name: "Couch stretch", sets: 2, holdSeconds: 45 }] },
    corosSyncState: "synced",
    completionState: "scheduled",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(corosWriteJobs).values({
    id: "mob-push",
    userId,
    workoutId: "mob",
    kind: "coach_create_workout",
    expectedContentFingerprint: "fp",
    originalDate: day,
    destinationDate: day,
    payload: { workoutId: "mob", happenDay: day, name: `Ankles and hips — ${day}` },
    requestedAt: now,
    status: "verified",
    updatedAt: now,
  });
}

/** COROS serving the pushed session back: under Strength, as it files it. */
function readBack(db: Db, userId: string, prefs: UserPreferences, today: string, day: string, contentFingerprint: string) {
  return importPlanSnapshot(
    db,
    {
      userId,
      plan: { sourcePlanId: PLAN, name: "Run Garden" },
      workouts: [
        {
          sourceWorkoutId: ADDRESS,
          sourcePlanId: PLAN,
          sourceIdInPlan: "5",
          sourceProgramId: "55",
          date: day,
          title: `Ankles and hips — ${day}`,
          sport: "strength",
          stages: [],
          contentFingerprint,
          isRestDay: false,
          estimatedDurationSeconds: 1200,
        },
      ],
      rangeStart: addDays(today, -30),
      rangeEnd: addDays(today, 60),
      source: "fixture",
    },
    prefs,
  );
}

describe("a coach mobility session pushed to the watch and read back as strength", () => {
  it("stays yoga/yoga through every read, and completes from a Yoga-mode activity", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await connectTestCoros(db, userId);
    const today = todayInZone(prefs.timezone);
    const day = today;
    await seedPushedMobility(db, userId, day);

    const first = await readBack(db, userId, prefs, today, day, "0123456789abcdef");
    expect(first.replacedRecycled).toBe(0);
    // A content edit upstream is rule 7 — upstream wins for the content, but
    // the program type it filed under is still the coarse one.
    await readBack(db, userId, prefs, today, day, "fedcba9876543210");
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, "mob"));
    expect([row!.category, row!.sport]).toEqual(["yoga", "yoga"]);
    expect(row!.completionState).toBe("scheduled");

    // The athlete does it in the watch's Yoga mode (904 → "yoga").
    const yoga: SourceActivity = {
      provider: "coros",
      providerActivityId: "act-yoga",
      startTime: `${day}T14:05:00Z`,
      startTimeLocal: `${day}T07:05:00`,
      sport: "yoga",
      durationSeconds: 1200,
      contentFingerprint: "act-fp",
    };
    const stats = await ingestActivities(db, { userId, sources: [yoga] });

    expect(stats.matchesCreated).toBe(1);
    const [done] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, "mob"));
    expect(done!.completionState).toBe("completed");
  });

  it("a real recycled slot — a run row whose address now holds a lift — is still replaced", async () => {
    // The rule the exception must not swallow.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await connectTestCoros(db, userId);
    const today = todayInZone(prefs.timezone);
    const day = addDays(today, 2);
    await seedPushedMobility(db, userId, day);
    await db
      .update(plannedWorkouts)
      .set({ category: "easy", sport: "run", title: "Easy 30", structuredJson: null })
      .where(eq(plannedWorkouts.id, "mob"));

    const stats = await readBack(db, userId, prefs, today, day, "0123456789abcdef");

    expect(stats.replacedRecycled).toBe(1);
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, "mob"));
    expect(row!.sport).toBe("strength");
  });
});
