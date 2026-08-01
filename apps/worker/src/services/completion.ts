import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  activities,
  activityLaps,
  activitySourceLinks,
  plannedWorkouts,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  newId,
  nowInstant,
  type NormalizedActivity,
  type SourceActivity,
} from "@rg/domain";
import {
  matchActivities,
  matchBand,
  mergeActivityPair,
  NORMALIZER_VERSION,
  scoreActivityPair,
  singleSourceActivity,
} from "@rg/providers";
import type { Db } from "./db.js";

/**
 * Completed-activity ingestion: source records from COROS and Strava are
 * deduplicated into one normalized activity, then matched against planned
 * workouts. Never uploads or mutates anything on the provider side.
 */

export interface IngestInput {
  userId: string;
  sources: SourceActivity[];
  /** laps keyed by provider activity id (COROS structured laps). */
  lapsByProviderId?: Record<
    string,
    Array<{ lapIndex: number; durationSeconds: number; distanceMeters?: number; avgHeartRate?: number; avgPaceSecPerKm?: number; splitType?: string }>
  >;
}

export interface IngestStats {
  newActivities: number;
  mergedPairs: number;
  matchesCreated: number;
  provisionalCompletions: number;
  completions: number;
  affectedDates: string[];
}

function rowToNormalized(row: typeof activities.$inferSelect): NormalizedActivity {
  return {
    id: row.id,
    corosActivityId: row.corosActivityId ?? undefined,
    stravaActivityId: row.stravaActivityId ?? undefined,
    startTime: row.startTime,
    startTimeLocal: row.startTimeLocal ?? undefined,
    timezone: row.timezone ?? undefined,
    sport: row.sport,
    durationSeconds: row.durationSeconds,
    elapsedSeconds: row.elapsedSeconds ?? undefined,
    distanceMeters: row.distanceMeters ?? undefined,
    avgHeartRate: row.avgHeartRate ?? undefined,
    maxHeartRate: row.maxHeartRate ?? undefined,
    avgPaceSecPerKm: row.avgPaceSecPerKm ?? undefined,
    elevationGainMeters: row.elevationGainMeters ?? undefined,
    trainingLoad: row.trainingLoad ?? undefined,
    deviceName: row.deviceName ?? undefined,
    title: row.title ?? undefined,
    summaryPolyline: row.summaryPolyline ?? undefined,
    completionMatchId: row.completionMatchId ?? undefined,
    sourceMergeConfidence: row.sourceMergeConfidence,
  };
}

async function upsertNormalized(
  db: Db,
  userId: string,
  normalized: NormalizedActivity,
  existingId?: string,
): Promise<string> {
  const now = nowInstant();
  if (existingId) {
    await db
      .update(activities)
      .set({
        corosActivityId: normalized.corosActivityId ?? null,
        stravaActivityId: normalized.stravaActivityId ?? null,
        startTime: normalized.startTime,
        startTimeLocal: normalized.startTimeLocal ?? null,
        timezone: normalized.timezone ?? null,
        sport: normalized.sport,
        durationSeconds: normalized.durationSeconds,
        elapsedSeconds: normalized.elapsedSeconds ?? null,
        distanceMeters: normalized.distanceMeters ?? null,
        avgHeartRate: normalized.avgHeartRate ?? null,
        maxHeartRate: normalized.maxHeartRate ?? null,
        avgPaceSecPerKm: normalized.avgPaceSecPerKm ?? null,
        elevationGainMeters: normalized.elevationGainMeters ?? null,
        trainingLoad: normalized.trainingLoad ?? null,
        deviceName: normalized.deviceName ?? null,
        title: normalized.title ?? null,
        summaryPolyline: normalized.summaryPolyline ?? null,
        sourceMergeConfidence: normalized.sourceMergeConfidence,
        updatedAt: now,
      })
      .where(eq(activities.id, existingId));
    return existingId;
  }
  await db.insert(activities).values({
    id: normalized.id,
    userId,
    corosActivityId: normalized.corosActivityId ?? null,
    stravaActivityId: normalized.stravaActivityId ?? null,
    startTime: normalized.startTime,
    startTimeLocal: normalized.startTimeLocal ?? null,
    timezone: normalized.timezone ?? null,
    sport: normalized.sport,
    durationSeconds: normalized.durationSeconds,
    elapsedSeconds: normalized.elapsedSeconds ?? null,
    distanceMeters: normalized.distanceMeters ?? null,
    avgHeartRate: normalized.avgHeartRate ?? null,
    maxHeartRate: normalized.maxHeartRate ?? null,
    avgPaceSecPerKm: normalized.avgPaceSecPerKm ?? null,
    elevationGainMeters: normalized.elevationGainMeters ?? null,
    trainingLoad: normalized.trainingLoad ?? null,
    deviceName: normalized.deviceName ?? null,
    title: normalized.title ?? null,
    summaryPolyline: normalized.summaryPolyline ?? null,
    sourceMergeConfidence: normalized.sourceMergeConfidence,
    createdAt: now,
    updatedAt: now,
  });
  return normalized.id;
}

async function upsertSourceLink(
  db: Db,
  activityId: string,
  src: SourceActivity,
): Promise<void> {
  const now = nowInstant();
  const existing = await db
    .select()
    .from(activitySourceLinks)
    .where(
      and(
        eq(activitySourceLinks.provider, src.provider),
        eq(activitySourceLinks.providerActivityId, src.providerActivityId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(activitySourceLinks)
      .set({ activityId, lastSeenAt: now, contentFingerprint: src.contentFingerprint })
      .where(eq(activitySourceLinks.id, existing[0].id));
    return;
  }
  await db.insert(activitySourceLinks).values({
    id: newId(),
    activityId,
    provider: src.provider,
    providerActivityId: src.providerActivityId,
    sourceCreatedAt: src.sourceCreatedAt ?? null,
    sourceUpdatedAt: src.sourceUpdatedAt ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    contentFingerprint: src.contentFingerprint,
    normalizerVersion: NORMALIZER_VERSION,
    sourceVersion: null,
    rawSummary: {
      title: src.title,
      device: src.deviceName,
      plannedWorkoutId: src.sourcePlannedWorkoutId,
    },
  });
}

export async function ingestActivities(db: Db, input: IngestInput): Promise<IngestStats> {
  const now = nowInstant();
  const stats: IngestStats = {
    newActivities: 0,
    mergedPairs: 0,
    matchesCreated: 0,
    provisionalCompletions: 0,
    completions: 0,
    affectedDates: [],
  };
  const affectedDates = new Set<string>();
  const corosProgramIdByActivity = new Map<string, string>();

  for (const src of input.sources) {
    // Already ingested? Update the link and refresh the normalized record.
    const link = await db
      .select()
      .from(activitySourceLinks)
      .where(
        and(
          eq(activitySourceLinks.provider, src.provider),
          eq(activitySourceLinks.providerActivityId, src.providerActivityId),
        ),
      )
      .limit(1);

    let activityId: string;
    if (link[0]) {
      activityId = link[0].activityId;
      const row = (await db.select().from(activities).where(eq(activities.id, activityId)).limit(1))[0];
      if (row) {
        const other =
          src.provider === "coros" && row.stravaActivityId
            ? rowToNormalized(row)
            : src.provider === "strava" && row.corosActivityId
              ? rowToNormalized(row)
              : null;
        // Re-merge to refresh metrics (COROS remains authoritative).
        if (other && src.provider === "coros") {
          const stravaSide: SourceActivity = {
            provider: "strava",
            providerActivityId: row.stravaActivityId!,
            startTime: row.startTime,
            sport: row.sport,
            durationSeconds: row.durationSeconds,
            title: row.title ?? undefined,
            summaryPolyline: row.summaryPolyline ?? undefined,
            contentFingerprint: "existing",
          };
          const merged = mergeActivityPair(src, stravaSide, activityId);
          await upsertNormalized(db, input.userId, merged.activity, activityId);
        } else if (src.provider === "coros") {
          await upsertNormalized(db, input.userId, { ...singleSourceActivity(src), id: activityId }, activityId);
        }
      }
      await upsertSourceLink(db, activityId, src);
    } else {
      // New source record. Look for a counterpart from the other provider.
      const windowStart = new Date(Date.parse(src.startTime) - 3600_000).toISOString();
      const windowEnd = new Date(Date.parse(src.startTime) + 3600_000).toISOString();
      const nearby = await db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.userId, input.userId),
            gte(activities.startTime, windowStart),
            lte(activities.startTime, windowEnd),
          ),
        );
      let counterpart: typeof activities.$inferSelect | undefined;
      let bestScore = 0;
      for (const row of nearby) {
        const hasOther =
          src.provider === "coros" ? row.stravaActivityId && !row.corosActivityId : row.corosActivityId && !row.stravaActivityId;
        if (!hasOther) continue;
        const other: SourceActivity = {
          provider: src.provider === "coros" ? "strava" : "coros",
          providerActivityId:
            src.provider === "coros" ? row.stravaActivityId! : row.corosActivityId!,
          startTime: row.startTime,
          sport: row.sport,
          durationSeconds: row.durationSeconds,
          distanceMeters: row.distanceMeters ?? undefined,
          deviceName: row.deviceName ?? undefined,
          contentFingerprint: "existing",
        };
        const { score } = scoreActivityPair(src, other);
        if (score > bestScore) {
          bestScore = score;
          counterpart = row;
        }
      }

      if (counterpart && bestScore >= 0.6) {
        // Merge into the existing normalized activity.
        const existingNorm = rowToNormalized(counterpart);
        const corosSide = src.provider === "coros" ? src : null;
        if (corosSide) {
          const stravaSide: SourceActivity = {
            provider: "strava",
            providerActivityId: counterpart.stravaActivityId!,
            startTime: counterpart.startTime,
            startTimeLocal: counterpart.startTimeLocal ?? undefined,
            timezone: counterpart.timezone ?? undefined,
            sport: counterpart.sport,
            durationSeconds: counterpart.durationSeconds,
            elapsedSeconds: counterpart.elapsedSeconds ?? undefined,
            distanceMeters: counterpart.distanceMeters ?? undefined,
            title: counterpart.title ?? undefined,
            summaryPolyline: counterpart.summaryPolyline ?? undefined,
            contentFingerprint: "existing",
          };
          const merged = mergeActivityPair(corosSide, stravaSide, counterpart.id);
          await upsertNormalized(db, input.userId, merged.activity, counterpart.id);
        } else {
          // Strava arriving after COROS: enrich only.
          await db
            .update(activities)
            .set({
              stravaActivityId: src.providerActivityId,
              title: src.title ?? counterpart.title,
              summaryPolyline: src.summaryPolyline ?? counterpart.summaryPolyline,
              timezone: src.timezone ?? counterpart.timezone,
              sourceMergeConfidence: bestScore,
              updatedAt: now,
            })
            .where(eq(activities.id, counterpart.id));
        }
        activityId = counterpart.id;
        stats.mergedPairs += 1;
        await upsertSourceLink(db, activityId, src);
      } else {
        const normalized = singleSourceActivity(src);
        activityId = await upsertNormalized(db, input.userId, normalized);
        stats.newActivities += 1;
        await upsertSourceLink(db, activityId, src);
      }
    }

    if (src.provider === "coros" && src.sourcePlannedWorkoutId) {
      corosProgramIdByActivity.set(activityId, src.sourcePlannedWorkoutId);
    }
    const laps = input.lapsByProviderId?.[src.providerActivityId];
    if (laps && laps.length > 0) {
      await db.delete(activityLaps).where(eq(activityLaps.activityId, activityId));
      await db.insert(activityLaps).values(
        laps.map((l) => ({
          id: `${activityId}:${l.lapIndex}`,
          activityId,
          lapIndex: l.lapIndex,
          durationSeconds: l.durationSeconds,
          distanceMeters: l.distanceMeters ?? null,
          avgHeartRate: l.avgHeartRate ?? null,
          avgPaceSecPerKm: l.avgPaceSecPerKm ?? null,
          splitType: l.splitType ?? null,
        })),
      );
    }
    affectedDates.add((src.startTimeLocal ?? src.startTime).slice(0, 10));
  }

  // ── Matching ──────────────────────────────────────────────────────────────
  const dates = [...affectedDates];
  if (dates.length > 0) {
    const minDate = addDays(dates.reduce((a, b) => (a < b ? a : b)), -1);
    const maxDate = addDays(dates.reduce((a, b) => (a > b ? a : b)), 1);
    const openWorkouts = await db
      .select()
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, input.userId),
          gte(plannedWorkouts.effectiveDate, minDate),
          lte(plannedWorkouts.effectiveDate, maxDate),
          isNull(plannedWorkouts.archivedAt),
          inArray(plannedWorkouts.completionState, ["scheduled", "unresolved", "provisionally_completed"]),
        ),
      );

    const unmatchedActivities = await db
      .select()
      .from(activities)
      .where(and(eq(activities.userId, input.userId), isNull(activities.completionMatchId)));
    const candidates = unmatchedActivities
      .filter((a) => {
        const d = (a.startTimeLocal ?? a.startTime).slice(0, 10);
        return d >= minDate && d <= maxDate;
      })
      .map((a) => ({
        activity: rowToNormalized(a),
        corosProgramId: corosProgramIdByActivity.get(a.id),
      }));

    const matchables = openWorkouts.map((w) => ({
      workout: {
        ...w,
        stages: [],
        sourceProvider: "coros" as const,
        durationEstimate: undefined,
        sourceProgramId: w.sourceProgramId ?? undefined,
        sourceEstimatedDurationSeconds: w.sourceEstimatedDurationSeconds ?? undefined,
        fallbackEstimatedDurationSeconds: w.fallbackEstimatedDurationSeconds ?? undefined,
        expectedDistanceMeters: w.expectedDistanceMeters ?? undefined,
        qualitySubtype: (w.qualitySubtype ?? undefined) as never,
        sourceIdInPlan: w.sourceIdInPlan ?? undefined,
        sourceVersion: w.sourceVersion ?? undefined,
        stageSummary: w.stageSummary ?? undefined,
        archivedAt: w.archivedAt,
      },
      corosProgramId: w.sourceProgramId ?? undefined,
    }));

    const matches = matchActivities(matchables as never, candidates);
    for (const m of matches) {
      const band = matchBand(m.confidence);
      if (band === "low") continue; // review queue: surfaced in UI, no auto-match

      // A workout already provisionally completed can be upgraded by a better
      // (COROS-linked) activity; otherwise skip re-matching.
      const workout = openWorkouts.find((w) => w.id === m.workoutId)!;
      const activityRow = unmatchedActivities.find((a) => a.id === m.activityId)!;
      const hasCoros = !!activityRow.corosActivityId;

      if (workout.completionState === "provisionally_completed") {
        const existingMatch = await db
          .select()
          .from(workoutCompletionMatches)
          .where(
            and(
              eq(workoutCompletionMatches.workoutId, workout.id),
              isNull(workoutCompletionMatches.undoneAt),
            ),
          )
          .limit(1);
        if (existingMatch[0] && existingMatch[0].activityId !== m.activityId) continue;
      }

      const matchId = newId();
      await db.insert(workoutCompletionMatches).values({
        id: matchId,
        workoutId: m.workoutId,
        activityId: m.activityId,
        confidence: m.confidence,
        method: m.method === "coros_plan_link" ? "coros_plan_link" : "scored_auto",
        provisional: !hasCoros,
        matchedAt: now,
      });
      await db
        .update(activities)
        .set({ completionMatchId: matchId, updatedAt: now })
        .where(eq(activities.id, m.activityId));

      const newState = hasCoros ? "completed" : "provisionally_completed";
      await db
        .update(plannedWorkouts)
        .set({
          completionState: newState,
          resolutionDate: (activityRow.startTimeLocal ?? activityRow.startTime).slice(0, 10),
          updatedAt: now,
        })
        .where(eq(plannedWorkouts.id, m.workoutId));
      stats.matchesCreated += 1;
      if (newState === "completed") stats.completions += 1;
      else stats.provisionalCompletions += 1;
      affectedDates.add(workout.effectiveDate);
    }

    // Upgrade provisional matches when the COROS copy has arrived.
    const provisional = await db
      .select()
      .from(workoutCompletionMatches)
      .where(and(eq(workoutCompletionMatches.provisional, true), isNull(workoutCompletionMatches.undoneAt)));
    for (const pm of provisional) {
      const row = (await db.select().from(activities).where(eq(activities.id, pm.activityId)).limit(1))[0];
      if (row?.corosActivityId) {
        await db
          .update(workoutCompletionMatches)
          .set({ provisional: false })
          .where(eq(workoutCompletionMatches.id, pm.id));
        await db
          .update(plannedWorkouts)
          .set({ completionState: "completed", updatedAt: now })
          .where(and(eq(plannedWorkouts.id, pm.workoutId), eq(plannedWorkouts.completionState, "provisionally_completed")));
        stats.completions += 1;
      }
    }
  }

  stats.affectedDates = [...affectedDates].sort();
  return stats;
}
