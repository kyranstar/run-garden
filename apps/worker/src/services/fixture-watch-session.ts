/**
 * FIXTURE MODE ONLY: "the athlete did today's sent session on the watch" (Phase 3 Task 11; the e2e journey (c)).
 *
 * `POST /api/dev/watch-session` makes what the import would have made after a real watch session of today's sent
 * slot: a COROS strength activity, its derived `watch` session from synthetic lap items shaped like the real ones
 * (watch-sets.ts R1–R4: one data item per set — two for a one-sided move, one per side — then its rest), and the
 * scorer's match completing the slot. The laps log the build's moves the watch knows by T-code; the rest log nothing,
 * as free-text steps may not (spec §9). Nothing leaves the Worker; no provider is called.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { activities, plannedWorkouts, sessionBuilds, workoutCompletionMatches } from "@rg/database";
import { nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { RawCorosLapItem } from "@rg/providers";
import type { Db } from "./db.js";
import { ingestActivities } from "./completion.js";
import { corosKeyOf } from "./coros-exercise-map.js";
import { sentBuildIdOf, type BuildPayload } from "./session-build.js";
import { linkWatchSessionsToWorkouts } from "./watch-sets.js";

export type FixtureWatchSessionResult =
  | { status: "ok"; workoutId: string; activityId: string; providerActivityId: string }
  | { status: "no_sent_session" };

/** One lap item with the real skeleton's keys; the fields that matter are passed in. */
function lapItem(fields: Partial<RawCorosLapItem>): RawCorosLapItem {
  return {
    lapIndex: 0,
    time: 0,
    avgHr: 104,
    exerciseIndex: 0,
    exerciseNameKey: "T1004",
    exerciseType: 2,
    setIndex: 0,
    sets: 1,
    targetSets: 3,
    targetType: 3,
    targetValue: 8,
    intensityType: 1,
    intensityValue: 0,
    intensityValueExtend: 0,
    intensityMultiplier: 0,
    intensityCustom: 0,
    intensityDisplayUnit: 6,
    lapTrainIndex: 0,
    programExerciseIndex: 0,
    indexInOriginLap: 0,
    pauseTime: 0,
    reps: 0,
    weight: 0,
    exerciseId: "8100",
    lapType: 0,
    ...fields,
  };
}

/** The build's moves the watch knows, logged as the watch would: 3 sets of 8 at 25 lb (as pounds typed on the watch). */
export function fixtureLaps(build: BuildPayload): RawCorosLapItem[] {
  const out: RawCorosLapItem[] = [];
  let exerciseIndex = 0;
  for (const item of build.items) {
    const key = corosKeyOf(item.exerciseId);
    if (!key) continue;
    const perSide = build.exercises[item.exerciseId]?.laterality === "unilateral";
    for (let setIndex = 0; setIndex < 3; setIndex++) {
      const data = { exerciseIndex, setIndex, exerciseNameKey: key, programExerciseIndex: exerciseIndex, reps: 8, weight: 11_340, time: 4_000 };
      out.push(lapItem(data));
      if (perSide) out.push(lapItem(data));
      out.push(lapItem({ exerciseIndex, setIndex, exerciseNameKey: key, programExerciseIndex: exerciseIndex, time: 6_000 }));
    }
    exerciseIndex += 1;
  }
  // A move the watch did beyond the build: kept as its own entry by the review.
  out.push(lapItem({ exerciseIndex, setIndex: 0, exerciseNameKey: "T1004", programExerciseIndex: exerciseIndex, reps: 10, time: 3_000 }));
  return out.map((i, n) => ({ ...i, lapIndex: n + 1 }));
}

export async function seedWatchSession(db: Db, userId: string, prefs: UserPreferences): Promise<FixtureWatchSessionResult> {
  const today = todayInZone(prefs.timezone);
  const slots = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.effectiveDate, today),
        isNull(plannedWorkouts.archivedAt),
        inArray(plannedWorkouts.origin, ["program", "on_demand"]),
        // Still to do: a session already done today (an earlier journey's) is not the one the watch just did.
        eq(plannedWorkouts.completionState, "scheduled"),
        ne(plannedWorkouts.contentState, "done"),
      ),
    );
  let slot: (typeof slots)[number] | undefined;
  let buildId: string | null = null;
  for (const s of slots) {
    buildId = await sentBuildIdOf(db, s.id);
    if (buildId) {
      slot = s;
      break;
    }
  }
  if (!slot || !buildId) return { status: "no_sent_session" };
  const [stored] = await db.select({ payload: sessionBuilds.payload }).from(sessionBuilds).where(eq(sessionBuilds.id, buildId)).limit(1);
  const build = (stored?.payload as { build: BuildPayload }).build;

  // Thirty-two minutes, ending a few minutes ago.
  const now = Date.now();
  const startMs = now - 37 * 60_000;
  const providerActivityId = `fixture-watch-${slot.id.slice(-12)}-${Math.floor(startMs / 1000)}`;
  const startTime = new Date(startMs).toISOString().replace(".000Z", "Z");
  const local = new Date(startMs).toLocaleString("sv-SE", { timeZone: prefs.timezone }).replace(" ", "T");
  await ingestActivities(db, {
    userId,
    sources: [
      {
        provider: "coros",
        providerActivityId,
        startTime,
        startTimeLocal: local,
        sport: "strength",
        durationSeconds: 1920,
        avgHeartRate: 104,
        title: "Strength",
        contentFingerprint: `fp-${providerActivityId}`,
      },
    ],
    strengthDetailsByProviderId: { [providerActivityId]: { lapList: [{ lapItemList: fixtureLaps(build) }] } as never },
  });
  const [activity] = await db.select({ id: activities.id }).from(activities).where(and(eq(activities.userId, userId), eq(activities.corosActivityId, providerActivityId)));
  if (!activity) return { status: "no_sent_session" };

  // The scorer's match, as the import makes it: the slot completed by this activity (whatever the matcher chose).
  const at = nowInstant();
  await db
    .update(workoutCompletionMatches)
    .set({ undoneAt: at })
    .where(and(eq(workoutCompletionMatches.workoutId, slot.id), isNull(workoutCompletionMatches.undoneAt)));
  const matchId = `fixture-watch:${slot.id}:${activity.id}`;
  // One activity, one match: whatever slot the import's matcher gave it first lets it go, as an unmatch leaves it.
  const others = await db
    .select({ id: workoutCompletionMatches.id, workoutId: workoutCompletionMatches.workoutId })
    .from(workoutCompletionMatches)
    .where(and(eq(workoutCompletionMatches.activityId, activity.id), isNull(workoutCompletionMatches.undoneAt)));
  for (const o of others) {
    if (o.id === matchId) continue;
    await db.update(workoutCompletionMatches).set({ undoneAt: at }).where(eq(workoutCompletionMatches.id, o.id));
    if (o.workoutId !== slot.id) {
      await db
        .update(plannedWorkouts)
        .set({ completionState: "unresolved", resolutionDate: null, updatedAt: at })
        .where(and(eq(plannedWorkouts.id, o.workoutId), eq(plannedWorkouts.userId, userId)));
    }
  }
  await db
    .insert(workoutCompletionMatches)
    .values({ id: matchId, workoutId: slot.id, activityId: activity.id, confidence: 0.9, method: "scored_auto", matchedAt: at })
    .onConflictDoUpdate({ target: workoutCompletionMatches.id, set: { undoneAt: null, method: "scored_auto", matchedAt: at } });
  await db.update(activities).set({ completionMatchId: matchId, updatedAt: at }).where(eq(activities.id, activity.id));
  await db
    .update(plannedWorkouts)
    .set({ completionState: "completed", resolutionDate: today, updatedAt: at })
    .where(and(eq(plannedWorkouts.id, slot.id), eq(plannedWorkouts.userId, userId)));
  await linkWatchSessionsToWorkouts(db, userId, [{ activityId: activity.id, workoutId: slot.id }], at);
  return { status: "ok", workoutId: slot.id, activityId: activity.id, providerActivityId };
}
