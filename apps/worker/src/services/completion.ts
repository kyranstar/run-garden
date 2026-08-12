import { and, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
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
  NORMALIZER_VERSION,
  scoreAgainstStoredRow,
  ORPHAN_ADOPTION_FLOOR,
  singleSourceActivity,
} from "@rg/providers";
import { chunkedInsert, type Db } from "./db.js";

/**
 * Completed-activity ingestion: source records from COROS are
 * deduplicated into one normalized activity, then matched against planned
 * workouts. Never uploads or mutates anything on the provider side.
 */

export interface IngestInput {
  userId: string;
  sources: SourceActivity[];
  /** laps keyed by provider activity id (COROS structured laps). */
  lapsByProviderId?: Record<
    string,
    Array<{
      lapIndex: number;
      durationSeconds: number;
      distanceMeters?: number;
      avgHeartRate?: number;
      avgPaceSecPerKm?: number;
      splitType?: string;
      avgCadenceSpm?: number;
      minHeartRate?: number;
      maxHeartRate?: number;
      elevGainMeters?: number;
      avgGradePercent?: number;
      avgPowerWatts?: number;
      exerciseNameKey?: string;
    }>
  >;
}

export interface IngestStats {
  newActivities: number;
  mergedPairs: number;
  matchesCreated: number;
  completions: number;
  affectedDates: string[];
}

/** DB row → domain activity: SQL nulls become the domain's optional absences. */
export function rowToNormalized(row: typeof activities.$inferSelect): NormalizedActivity {
  return {
    id: row.id,
    corosActivityId: row.corosActivityId ?? undefined,
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
    completionMatchId: row.completionMatchId ?? undefined,
    sourceMergeConfidence: row.sourceMergeConfidence,
  };
}

/**
 * Guard against the COROS centisecond bug (older desktop bridge builds stored
 * activity duration in centiseconds as if seconds). A run whose implied pace is
 * impossibly slow (> 30 min/km) has a 100x-too-large duration — correct it. No
 * real run sustains a 30 min/km average, so this never touches good data, and
 * it's idempotent (a corrected row's implied pace is normal).
 */
/**
 * One-shot corrective sweep for already-stored rows hit by the COROS centisecond
 * bug (same 30-min/km signature as sanitizeRunDuration). Idempotent — once a row
 * is corrected its implied pace is normal and it's excluded. Runs at the start of
 * every ingest so it self-heals on the next sync.
 */
export async function repairDurations(db: Db, userId: string): Promise<void> {
  await db
    .update(activities)
    .set({
      durationSeconds: sql`round(${activities.durationSeconds} / 100.0)`,
      elapsedSeconds: sql`case when ${activities.elapsedSeconds} is not null then round(${activities.elapsedSeconds} / 100.0) else ${activities.elapsedSeconds} end`,
      updatedAt: nowInstant(),
    })
    .where(
      and(
        eq(activities.userId, userId),
        eq(activities.sport, "run"),
        gt(activities.distanceMeters, 0),
        sql`(${activities.durationSeconds} * 1.0) / (${activities.distanceMeters} / 1000.0) > 1800`,
      ),
    );
}

/**
 * Repair activities flung into the far future by the COROS centisecond
 * startTimestamp bug (epoch ×100 → year ~7625): rescale their timestamps, then
 * re-unite each repaired COROS row with any source-less copy of the same
 * run it could never adopt (the ±1h adoption window can't reach year
 * 7625). The surviving row is the one holding a completion match; laps and
 * source links are repointed, the duplicate is deleted. Idempotent, runs at the
 * start of every ingest. Returns the affected local dates (for resimulation).
 */
export async function repairTimestamps(db: Db, userId: string): Promise<string[]> {
  const now = nowInstant();
  const affected = new Set<string>();

  // ISO strings compare lexicographically, so year >= 3000 is simply >= "3000".
  const bogus = await db
    .select()
    .from(activities)
    .where(and(eq(activities.userId, userId), gte(activities.startTime, "3000")));

  for (const row of bogus) {
    const bogusStartMs = Date.parse(row.startTime);
    const fixedStartMs = Math.round(bogusStartMs / 100);
    const startTime = new Date(fixedStartMs).toISOString().replace(".000Z", "Z");
    // The stored local time is offset from startTime by the *unscaled* tz
    // offset, so recover the offset from the bogus pair and re-apply it.
    let startTimeLocal: string | null = row.startTimeLocal;
    if (startTimeLocal) {
      const offsetMs = Date.parse(`${startTimeLocal}Z`) - bogusStartMs;
      startTimeLocal = new Date(fixedStartMs + offsetMs)
        .toISOString()
        .replace(".000Z", "")
        .replace("Z", "");
    }
    await db
      .update(activities)
      .set({ startTime, startTimeLocal, updatedAt: now })
      .where(eq(activities.id, row.id));
    affected.add((startTimeLocal ?? startTime).slice(0, 10));

    // Reunite the repaired row with a source-less copy of the same session, if
    // one exists. This cannot be left to ingest-time adoption: the ±1h window
    // can't span the ~5600 years the bug moved the row by, so the two rows only
    // become adjacent once the timestamp is rescaled, here.
    if (!row.corosActivityId) continue;
    const windowStart = new Date(fixedStartMs - 3600_000).toISOString();
    const windowEnd = new Date(fixedStartMs + 3600_000).toISOString();
    const nearby = await db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.userId, userId),
          gte(activities.startTime, windowStart),
          lte(activities.startTime, windowEnd),
          isNull(activities.corosActivityId),
          eq(activities.sport, row.sport),
        ),
      );
    const twin = nearby.find(
      (c) =>
        c.id !== row.id &&
        (c.distanceMeters == null ||
          row.distanceMeters == null ||
          Math.abs(c.distanceMeters - row.distanceMeters) <
            0.2 * Math.max(c.distanceMeters, row.distanceMeters)),
    );
    if (!twin) continue;

    // Keep whichever row holds a completion match — historically the legacy
    // copy matched a workout while the COROS row sat in year 7625.
    const survivor = row.completionMatchId ? row : twin;
    const duplicate = survivor.id === row.id ? twin : row;
    // Repoint children, then delete the duplicate BEFORE giving the survivor
    // its provider id — (user_id, coros_activity_id) is unique.
    await db
      .update(activityLaps)
      .set({ activityId: survivor.id })
      .where(eq(activityLaps.activityId, duplicate.id));
    await db
      .update(activitySourceLinks)
      .set({ activityId: survivor.id })
      .where(eq(activitySourceLinks.activityId, duplicate.id));
    await db.delete(activities).where(eq(activities.id, duplicate.id));
    await db
      .update(activities)
      .set({
        corosActivityId: row.corosActivityId,
        // COROS metrics are authoritative for the surviving record.
        durationSeconds: row.durationSeconds,
        elapsedSeconds: row.elapsedSeconds ?? survivor.elapsedSeconds,
        distanceMeters: row.distanceMeters ?? survivor.distanceMeters,
        avgHeartRate: row.avgHeartRate ?? survivor.avgHeartRate,
        maxHeartRate: row.maxHeartRate ?? survivor.maxHeartRate,
        avgPaceSecPerKm: row.avgPaceSecPerKm ?? survivor.avgPaceSecPerKm,
        elevationGainMeters: row.elevationGainMeters ?? survivor.elevationGainMeters,
        trainingLoad: row.trainingLoad ?? survivor.trainingLoad,
        deviceName: row.deviceName ?? survivor.deviceName,
        startTime,
        startTimeLocal,
        updatedAt: now,
      })
      .where(eq(activities.id, survivor.id));
    affected.add((startTimeLocal ?? startTime).slice(0, 10));

  }

  return [...affected].sort();
}

export function sanitizeRunDuration(a: NormalizedActivity): NormalizedActivity {
  if (
    a.sport === "run" &&
    a.distanceMeters != null &&
    a.distanceMeters > 0 &&
    a.durationSeconds / (a.distanceMeters / 1000) > 1800
  ) {
    return {
      ...a,
      durationSeconds: Math.round(a.durationSeconds / 100),
      elapsedSeconds: a.elapsedSeconds != null ? Math.round(a.elapsedSeconds / 100) : a.elapsedSeconds,
    };
  }
  return a;
}

async function upsertNormalized(
  db: Db,
  userId: string,
  normalized: NormalizedActivity,
  existingId?: string,
): Promise<string> {
  normalized = sanitizeRunDuration(normalized);
  const now = nowInstant();
  if (existingId) {
    // A refresh must be NON-DESTRUCTIVE: a list-only re-normalization carries
    // far less than the detail-derived record already stored (telemetry
    // shrinks to {deviceTempC}, maxHr can vanish). The 2026-08-12 incident
    // clobbered zones/cadence/power on 12 rows this way. Detail-grade fields
    // therefore merge over / coalesce with what's stored, never replace it
    // with less.
    const existing = (
      await db.select().from(activities).where(eq(activities.id, existingId)).limit(1)
    )[0];
    const mergedTelemetry =
      existing?.telemetry || normalized.telemetry
        ? { ...(existing?.telemetry ?? {}), ...(normalized.telemetry ?? {}) }
        : null;
    await db
      .update(activities)
      .set({
        corosActivityId: normalized.corosActivityId ?? null,
        startTime: normalized.startTime,
        startTimeLocal: normalized.startTimeLocal ?? null,
        timezone: normalized.timezone ?? null,
        sport: normalized.sport,
        durationSeconds: normalized.durationSeconds,
        elapsedSeconds: normalized.elapsedSeconds ?? existing?.elapsedSeconds ?? null,
        distanceMeters: normalized.distanceMeters ?? existing?.distanceMeters ?? null,
        avgHeartRate: normalized.avgHeartRate ?? existing?.avgHeartRate ?? null,
        maxHeartRate: normalized.maxHeartRate ?? existing?.maxHeartRate ?? null,
        avgPaceSecPerKm: normalized.avgPaceSecPerKm ?? null,
        elevationGainMeters: normalized.elevationGainMeters ?? existing?.elevationGainMeters ?? null,
        trainingLoad: normalized.trainingLoad ?? existing?.trainingLoad ?? null,
        deviceName: normalized.deviceName ?? existing?.deviceName ?? null,
        title: normalized.title ?? existing?.title ?? null,
        telemetry: mergedTelemetry,
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
    telemetry: normalized.telemetry ?? null,
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
  await repairDurations(db, input.userId);
  const repairedDates = await repairTimestamps(db, input.userId);
  const now = nowInstant();
  const stats: IngestStats = {
    newActivities: 0,
    mergedPairs: 0,
    matchesCreated: 0,
    completions: 0,
    affectedDates: [],
  };
  const affectedDates = new Set<string>(repairedDates);
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
      // Unchanged since the last snapshot: nothing to re-normalize, no laps
      // to rewrite, and — critically — no reason to drag this date into the
      // garden resimulation window. Before this check, every 30-minute
      // snapshot fed all 14 days of history into affectedDates and the
      // garden rewound to a weeks-old checkpoint and replayed, 48×/day.
      if (link[0].contentFingerprint === src.contentFingerprint) {
        continue;
      }
      const row = (await db.select().from(activities).where(eq(activities.id, activityId)).limit(1))[0];
      if (row) {
        // COROS is the only source, so a refresh is simply the new normalized
        // record over the old one, keeping the row's identity.
        await upsertNormalized(
          db,
          input.userId,
          { ...singleSourceActivity(src), id: activityId },
          activityId,
        );
      }
      await upsertSourceLink(db, activityId, src);
    } else {
      // New source record. Before creating a row, look for an existing one at
      // the same time that carries no COROS source — a session ingested before
      // COROS became the only provider (historically, a second provider's copy of a
      // run the watch also recorded).
      //
      // Adopting it rather than inserting alongside it is what keeps the
      // backfill from duplicating history, and it preserves the row id, so its
      // completion match, garden contribution, and records all survive. This
      // deliberately does NOT depend on the backfill running before the legacy
      // columns are dropped: a row with no COROS source is recognisable either
      // way, so the two operations can happen in any order.
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
      let orphan: typeof activities.$inferSelect | undefined;
      let bestScore = 0;
      for (const row of nearby) {
        if (row.corosActivityId) continue; // already has a COROS source
        const { score } = scoreAgainstStoredRow(src, {
          startTime: row.startTime,
          sport: row.sport,
          durationSeconds: row.durationSeconds,
          distanceMeters: row.distanceMeters ?? undefined,
        });
        if (score > bestScore) {
          bestScore = score;
          orphan = row;
        }
      }

      if (orphan && bestScore >= ORPHAN_ADOPTION_FLOOR) {
        // COROS is authoritative for every metric; the adopted row keeps only
        // its identity and anything COROS did not supply.
        await upsertNormalized(
          db,
          input.userId,
          { ...singleSourceActivity(src), id: orphan.id, title: src.title ?? orphan.title ?? undefined },
          orphan.id,
        );
        activityId = orphan.id;
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
      const lapRows = laps.map((l) => ({
        id: `${activityId}:${l.lapIndex}`,
        activityId,
        lapIndex: l.lapIndex,
        durationSeconds: l.durationSeconds,
        distanceMeters: l.distanceMeters ?? null,
        avgHeartRate: l.avgHeartRate ?? null,
        avgPaceSecPerKm: l.avgPaceSecPerKm ?? null,
        splitType: l.splitType ?? null,
        avgCadenceSpm: l.avgCadenceSpm ?? null,
        minHeartRate: l.minHeartRate ?? null,
        maxHeartRate: l.maxHeartRate ?? null,
        elevGainMeters: l.elevGainMeters ?? null,
        avgGradePercent: l.avgGradePercent ?? null,
        avgPowerWatts: l.avgPowerWatts ?? null,
        exerciseNameKey: l.exerciseNameKey ?? null,
      }));
      // Column count derived from the row itself: a hardcoded count silently
      // rots when the table grows (migration 0012's lap telemetry columns
      // pushed 8-column batches past the ~100-bound-variable cap, failing
      // ingest for any run with 8+ laps).
      await chunkedInsert(lapRows, Object.keys(lapRows[0]!).length, (batch) =>
        db.insert(activityLaps).values(batch),
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
          inArray(plannedWorkouts.completionState, ["scheduled", "unresolved"]),
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

      const matchId = newId();
      await db.insert(workoutCompletionMatches).values({
        id: matchId,
        workoutId: m.workoutId,
        activityId: m.activityId,
        confidence: m.confidence,
        method: m.method === "coros_plan_link" ? "coros_plan_link" : "scored_auto",
        matchedAt: now,
      });
      await db
        .update(activities)
        .set({ completionMatchId: matchId, updatedAt: now })
        .where(eq(activities.id, m.activityId));

      await db
        .update(plannedWorkouts)
        .set({
          completionState: "completed",
          resolutionDate: (activityRow.startTimeLocal ?? activityRow.startTime).slice(0, 10),
          updatedAt: now,
        })
        .where(eq(plannedWorkouts.id, m.workoutId));
      stats.matchesCreated += 1;
      stats.completions += 1;
      // The workout's own day needs resimulating too, not just the activity's
      // day: a cross-day match (matcher's ±1-day window) can complete a
      // workout dated yesterday from an activity synced today, and if
      // yesterday's checkpoint was already durably simulated as "missed",
      // only re-adding this date makes resimulateFrom replay it.
      affectedDates.add(workout.effectiveDate);
    }

  }

  stats.affectedDates = [...affectedDates].sort();
  return stats;
}

