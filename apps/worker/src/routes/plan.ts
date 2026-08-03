import { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  activities,
  calendarEventLinks,
  calendarEventSuppressions,
  corosWriteJobs,
  dailyHealth,
  gardenState,
  plannedWorkoutStages,
  plannedWorkouts,
  providerConnections,
  scheduleOverrides,
  trainingPlans,
  workoutCompletionMatches,
} from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { conditionWord, DEFAULT_GARDEN_CONFIG, type GardenSnapshot } from "@rg/garden-engine";
import { proposeReschedules } from "@rg/scheduling";
import type { AppContext } from "../auth/middleware.js";
import { requireUser } from "../auth/middleware.js";
import { googleCalendarClient } from "../services/google-calendar.js";
import { loadPreferences, restoreCalendarEvent, syncCalendar } from "../services/calendar-sync.js";
import { chunkIds, type Db } from "../services/db.js";
import { applyMove } from "../services/jobs.js";
import { recentGardenEvents, resimulateFrom } from "../services/garden-sync.js";
import { openIntentFor, openMoveIntents, recordIntent, resolveIntent } from "../services/sync-intents.js";
import { deriveWorkoutSync, devicePresence } from "../services/sync-status.js";

export const planRoutes = new Hono<AppContext>();
planRoutes.use("*", requireUser);

/** `corosWriteJobs.status` values that mean "a write is in flight" — same set
 * `jobs.ts`/`sync-status.ts` already use, duplicated locally the same way
 * those files each already do (no shared export exists for it). */
const IN_FLIGHT_JOB_STATUSES = ["queued", "claimed", "in_progress", "verifying"] as const;

/**
 * Bulk-loads what `deriveWorkoutSync` needs for every workout in `workouts`
 * in a small, fixed number of queries (chunked with `chunkIds` for D1's bound-
 * variable cap) rather than one round-trip per workout. `presence` is a
 * single shared computation — device liveness doesn't vary per workout.
 */
async function loadWorkoutSyncViews(
  db: Db,
  userId: string,
  workouts: Array<typeof plannedWorkouts.$inferSelect>,
  prefs: UserPreferences,
): Promise<Map<string, ReturnType<typeof deriveWorkoutSync>>> {
  const map = new Map<string, ReturnType<typeof deriveWorkoutSync>>();
  if (workouts.length === 0) return map;

  const ids = workouts.map((w) => w.id);
  const openIntentTargets = new Set((await openMoveIntents(db, userId)).map((i) => i.targetId));

  const pendingIds = new Set<string>();
  const failedIds = new Set<string>();
  for (const chunk of chunkIds(ids)) {
    const jobs = await db
      .select({ workoutId: corosWriteJobs.workoutId, status: corosWriteJobs.status })
      .from(corosWriteJobs)
      .where(and(eq(corosWriteJobs.userId, userId), inArray(corosWriteJobs.workoutId, chunk)));
    for (const j of jobs) {
      if ((IN_FLIGHT_JOB_STATUSES as readonly string[]).includes(j.status)) pendingIds.add(j.workoutId);
      else if (j.status === "failed") failedIds.add(j.workoutId);
    }
  }

  const presence = await devicePresence(db, userId);
  for (const w of workouts) {
    map.set(
      w.id,
      deriveWorkoutSync({
        effectiveDate: w.effectiveDate,
        lastVerifiedCorosDate: w.lastVerifiedCorosDate,
        hasOpenIntent: openIntentTargets.has(w.id),
        hasPendingJob: pendingIds.has(w.id),
        hasFailedJob: failedIds.has(w.id),
        presence,
        writesEnabled: prefs.corosWritesEnabled,
      }),
    );
  }
  return map;
}

function workoutDto(
  w: typeof plannedWorkouts.$inferSelect,
  corosSyncView?: ReturnType<typeof deriveWorkoutSync>,
) {
  return {
    id: w.id,
    title: w.title,
    category: w.category,
    qualitySubtype: w.qualitySubtype,
    sport: w.sport,
    originalPlanDate: w.originalPlanDate,
    lastVerifiedCorosDate: w.lastVerifiedCorosDate,
    effectiveDate: w.effectiveDate,
    effectiveTime: w.effectiveTime,
    workoutSeconds: w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds,
    estimateSource: (w.durationEstimate as { source?: string } | null)?.source,
    calendarSeconds: w.calendarBlockDurationSeconds,
    stageSummary: w.stageSummary,
    calendarSyncState: w.calendarSyncState,
    corosSyncState: w.corosSyncState,
    // Derived per-workout view (sync-transparency Task 10), alongside the
    // legacy stored `corosSyncState` above — not a replacement for it.
    // Optional: routes that don't bulk-load it (or callers that predate this
    // change) simply omit the field, `workoutDto`'s signature stays
    // backward-compatible either way.
    ...(corosSyncView !== undefined ? { corosSyncView } : {}),
    completionState: w.completionState,
    archived: !!w.archivedAt,
  };
}

/** The Today payload: next workout, statuses, readiness, garden preview. */
planRoutes.get("/today", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);

  const upcoming = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        gte(plannedWorkouts.effectiveDate, today),
        isNull(plannedWorkouts.archivedAt),
        // Only genuinely upcoming work: a provisionally-completed run is DONE
        // (it's just awaiting its richer COROS record) — showing it as "next
        // workout" right after you ran it reads as the app not noticing.
        eq(plannedWorkouts.completionState, "scheduled"),
      ),
    )
    .orderBy(asc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.effectiveTime))
    .limit(8);
  const next = upcoming.find((w) => w.category !== "rest") ?? upcoming[0];

  const unresolved = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.completionState, "unresolved"),
        // Never ask "did this run happen?" about a date that hasn't happened:
        // a workout can sit unresolved with a future date briefly when it was
        // rescheduled after the question was raised.
        lte(plannedWorkouts.effectiveDate, today),
        isNull(plannedWorkouts.archivedAt),
      ),
    )
    .orderBy(desc(plannedWorkouts.effectiveDate))
    .limit(3);

  const attention = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.corosSyncState, "needs_attention"),
        isNull(plannedWorkouts.archivedAt),
        // Attention is for things the user can still act on: a conflict on a
        // long-past (or already-resolved) workout must not pin a warning to
        // the Today screen forever.
        gte(plannedWorkouts.effectiveDate, addDays(today, -14)),
        inArray(plannedWorkouts.completionState, ["scheduled", "unresolved"]),
      ),
    )
    .limit(5);

  const pendingJobs = await db
    .select()
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
      ),
    );

  const presence = await devicePresence(db, userId);

  const health = await db
    .select()
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), lte(dailyHealth.date, today)))
    .orderBy(desc(dailyHealth.date))
    .limit(14);

  const stravaConn = (
    await db
      .select()
      .from(providerConnections)
      .where(
        and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "strava")),
      )
      .limit(1)
  )[0];

  const gardenRows = await db.select().from(gardenState).where(eq(gardenState.userId, userId)).limit(1);
  const snapshot = gardenRows[0]?.snapshot as unknown as GardenSnapshot | undefined;
  const gardenEventsRecent = await recentGardenEvents(db, userId, 6);

  const yesterdayDone = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.effectiveDate, addDays(today, -1)),
        inArray(plannedWorkouts.completionState, ["completed", "provisionally_completed"]),
      ),
    )
    .limit(1);

  // One bulk load covers every workout shown on Today (next is always a
  // member of upcoming, included here via the same dedup-by-id map).
  const syncViewSource = new Map<string, typeof plannedWorkouts.$inferSelect>();
  for (const w of [...upcoming, ...unresolved, ...attention]) syncViewSource.set(w.id, w);
  const syncViews = await loadWorkoutSyncViews(db, userId, [...syncViewSource.values()], prefs);

  return c.json({
    today,
    nextWorkout: next ? workoutDto(next, syncViews.get(next.id)) : null,
    upcoming: upcoming.map((w) => workoutDto(w, syncViews.get(w.id))),
    unresolved: unresolved.map((w) => workoutDto(w, syncViews.get(w.id))),
    needsAttention: attention.map((w) => workoutDto(w, syncViews.get(w.id))),
    sync: {
      pendingCorosJobs: pendingJobs.length,
      deviceOnline: presence.online,
      deviceRegistered: presence.registered,
      corosWritesEnabled: prefs.corosWritesEnabled,
      calendarConnected: !!prefs.calendarId,
      // "connected" | "error" (subscription lapsed / revoked) | undefined (never connected)
      stravaStatus: stravaConn?.status,
    },
    readiness: {
      latest: health[0] ?? null,
      baseline:
        health.length >= 7
          ? {
              restingHeartRate: median(health.map((h) => h.restingHeartRate).filter(nonNull)),
              hrv: median(health.map((h) => h.hrv).filter(nonNull)),
            }
          : null,
      sampleDays: health.length,
    },
    garden: snapshot
      ? {
          condition: conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG),
          weather: snapshot.state.weatherState,
          plants: snapshot.plants.filter((p) => p.state !== "dead").length,
          recentEvents: gardenEventsRecent,
          wateredYesterday: yesterdayDone.length > 0,
        }
      : null,
  });
});

function nonNull<T>(v: T | null | undefined): v is T {
  return v != null;
}
function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

/** Week view of the plan. */
planRoutes.get("/workouts", async (c) => {
  const db = c.get("db");
  const prefs = await loadPreferences(db, c.get("userId"));
  const today = todayInZone(prefs.timezone);
  // Look back 8 weeks by default so completed/past runs are browsable; callers
  // can widen with ?start=.
  const start = c.req.query("start") ?? addDays(today, -56);
  const end = c.req.query("end") ?? addDays(today, 7 * prefs.mirrorWeeksAhead);
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, c.get("userId")),
        gte(plannedWorkouts.effectiveDate, start),
        lte(plannedWorkouts.effectiveDate, end),
        isNull(plannedWorkouts.archivedAt),
      ),
    )
    .orderBy(asc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.effectiveTime));
  const plans = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, c.get("userId")), eq(trainingPlans.status, "active")));
  // The header names the plan the user actually lives in: with several active
  // plan rows (merged COROS reads create mirrors and a lifting container),
  // an arbitrary plans[0] could surface a synthesized "COROS plan" label.
  const countByPlanId = new Map<string, number>();
  for (const w of rows) {
    if (w.archivedAt) continue;
    countByPlanId.set(w.planId, (countByPlanId.get(w.planId) ?? 0) + 1);
  }
  const primary = [...plans].sort(
    (a, b) => (countByPlanId.get(b.id) ?? 0) - (countByPlanId.get(a.id) ?? 0),
  )[0];
  const syncViews = await loadWorkoutSyncViews(db, c.get("userId"), rows, prefs);
  return c.json({
    today,
    plan: primary ? { name: primary.name, startDate: primary.startDate, endDate: primary.endDate } : null,
    corosWritesEnabled: prefs.corosWritesEnabled,
    workouts: rows.map((w) => workoutDto(w, syncViews.get(w.id))),
  });
});

planRoutes.get("/workouts/:id", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);
  const prefs = await loadPreferences(db, userId);
  const syncViews = await loadWorkoutSyncViews(db, userId, [w], prefs);
  const stages = await db
    .select()
    .from(plannedWorkoutStages)
    .where(eq(plannedWorkoutStages.workoutId, w.id))
    .orderBy(asc(plannedWorkoutStages.ord));
  const match = (
    await db
      .select()
      .from(workoutCompletionMatches)
      .where(and(eq(workoutCompletionMatches.workoutId, w.id), isNull(workoutCompletionMatches.undoneAt)))
      .limit(1)
  )[0];
  const activity = match
    ? (await db.select().from(activities).where(eq(activities.id, match.activityId)).limit(1))[0]
    : undefined;
  const link = (
    await db.select().from(calendarEventLinks).where(eq(calendarEventLinks.workoutId, w.id)).limit(1)
  )[0];
  const jobs = await db
    .select()
    .from(corosWriteJobs)
    .where(eq(corosWriteJobs.workoutId, w.id))
    .orderBy(desc(corosWriteJobs.requestedAt))
    .limit(3);
  return c.json({
    workout: workoutDto(w, syncViews.get(w.id)),
    durationEstimate: w.durationEstimate,
    stages,
    match: match ? { ...match, activity } : null,
    calendarEvent: link ? { eventId: link.eventId, state: link.state } : null,
    recentJobs: jobs.map((j) => ({
      id: j.id,
      status: j.status,
      originalDate: j.originalDate,
      destinationDate: j.destinationDate,
      pathUsed: j.pathUsed,
      degraded: j.degraded,
      attemptCount: j.attemptCount,
      requestedAt: j.requestedAt,
    })),
  });
});

/** Reschedule candidates (never auto-applied). */
planRoutes.get("/workouts/:id/candidates", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);

  const others = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        gte(plannedWorkouts.effectiveDate, addDays(w.effectiveDate, -5)),
        lte(plannedWorkouts.effectiveDate, addDays(w.effectiveDate, 5)),
        isNull(plannedWorkouts.archivedAt),
      ),
    );

  // Busy intervals from Google Calendar free/busy (best effort).
  let busy: Array<{ start: string; end: string }> = [];
  const client = await googleCalendarClient(db, c.env, userId);
  if (client && prefs.calendarId) {
    try {
      const calendars = await client.listCalendars();
      const ids = calendars.filter((cal) => cal.id !== prefs.calendarId).map((cal) => cal.id);
      if (ids.length > 0) {
        busy = await client.freeBusy(
          ids.slice(0, 8),
          `${addDays(w.effectiveDate, -3)}T00:00:00Z`,
          `${addDays(w.effectiveDate, 4)}T00:00:00Z`,
        );
      }
    } catch {
      busy = [];
    }
  }

  const result = proposeReschedules({
    workout: {
      id: w.id,
      title: w.title,
      category: w.category as never,
      qualitySubtype: w.qualitySubtype ?? undefined,
      effectiveDate: w.effectiveDate,
      effectiveTime: w.effectiveTime,
      workoutSeconds: w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds ?? 2700,
    },
    others: others
      .filter((o) => o.id !== w.id)
      .map((o) => ({
        id: o.id,
        title: o.title,
        category: o.category as never,
        qualitySubtype: o.qualitySubtype ?? undefined,
        effectiveDate: o.effectiveDate,
        effectiveTime: o.effectiveTime,
        workoutSeconds: o.sourceEstimatedDurationSeconds ?? o.fallbackEstimatedDurationSeconds ?? 2700,
      })),
    busy,
    prefs,
    today,
    now: nowInstant(),
  });
  return c.json(result);
});

const moveSchema = z.object({ toDate: z.string(), toTime: z.string() });

planRoutes.post("/workouts/:id/move", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const parsed = moveSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const prefs = await loadPreferences(db, userId);
  try {
    const outcome = await applyMove(db, {
      userId,
      workoutId: c.req.param("id"),
      toDate: parsed.data.toDate,
      toTime: parsed.data.toTime,
      source: "app",
      corosWritesEnabled: prefs.corosWritesEnabled,
    });
    await syncCalendar(db, c.env, userId).catch(() => undefined);
    return c.json(outcome);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "move_failed";
    return c.json({ error: msg }, msg === "races_cannot_move" ? 422 : 500);
  }
});

planRoutes.post("/workouts/:id/skip", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  const now = nowInstant();
  await db
    .update(plannedWorkouts)
    .set({ completionState: "skipped", resolutionDate: today, updatedAt: now })
    .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)));
  await resimulateFrom(db, userId, today, prefs).catch(() => undefined);
  return c.json({ ok: true });
});

/**
 * Reverse a skip: only valid while still `skipped` (a completed/matched
 * workout has moved on and isn't "un-skippable"). Back to scheduled, the
 * skip's resolutionDate cleared, and — since that resolutionDate is what fed
 * `missedRuns` into the garden sim (garden-sync.ts's `buildDayInput`) —
 * resimulated from that same date so the garden forgets the miss, mirroring
 * how the skip route itself resimulates from the date it just wrote.
 */
planRoutes.post("/workouts/:id/unskip", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);
  if (w.completionState !== "skipped") return c.json({ error: "not_skipped" }, 422);
  const now = nowInstant();
  // buildDayInput falls back to effectiveDate when resolutionDate is unset;
  // matching that fallback here keeps the resim target correct either way.
  const resolvedOn = w.resolutionDate ?? w.effectiveDate;
  await db
    .update(plannedWorkouts)
    .set({ completionState: "scheduled", resolutionDate: null, updatedAt: now })
    .where(and(eq(plannedWorkouts.id, w.id), eq(plannedWorkouts.userId, userId)));
  await db.insert(scheduleOverrides).values({
    id: newId(),
    workoutId: w.id,
    kind: "restore",
    fromDate: resolvedOn,
    source: "app",
    createdAt: now,
  });
  const prefs = await loadPreferences(db, userId);
  await resimulateFrom(db, userId, resolvedOn, prefs).catch(() => undefined);
  return c.json({ ok: true });
});

/** "Not yet" on the did-this-run-happen prompt: back to scheduled, and
 * snoozed until tomorrow — otherwise the hourly reconcile re-asked within
 * the hour and the button read as broken. */
planRoutes.post("/workouts/:id/defer", async (c) => {
  const prefs = await loadPreferences(c.get("db"), c.get("userId"));
  const tomorrow = addDays(todayInZone(prefs.timezone), 1);
  await c
    .get("db")
    .update(plannedWorkouts)
    .set({ completionState: "scheduled", snoozedUntil: tomorrow, updatedAt: nowInstant() })
    .where(
      and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, c.get("userId"))),
    );
  return c.json({ ok: true });
});

/** Manually match an activity to a workout. */
planRoutes.post("/workouts/:id/match", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const { activityId } = await c.req.json<{ activityId: string }>();
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  const a = (
    await db
      .select()
      .from(activities)
      .where(and(eq(activities.id, activityId), eq(activities.userId, userId)))
      .limit(1)
  )[0];
  if (!w || !a) return c.json({ error: "not_found" }, 404);
  if (a.completionMatchId) return c.json({ error: "activity_already_matched" }, 422);
  const now = nowInstant();
  const matchId = newId();
  await db.insert(workoutCompletionMatches).values({
    id: matchId,
    workoutId: w.id,
    activityId: a.id,
    confidence: 1,
    method: "manual",
    provisional: !a.corosActivityId,
    matchedAt: now,
  });
  await db.update(activities).set({ completionMatchId: matchId, updatedAt: now }).where(eq(activities.id, a.id));
  await db
    .update(plannedWorkouts)
    .set({
      completionState: a.corosActivityId ? "completed" : "provisionally_completed",
      resolutionDate: (a.startTimeLocal ?? a.startTime).slice(0, 10),
      updatedAt: now,
    })
    .where(eq(plannedWorkouts.id, w.id));
  const prefs = await loadPreferences(db, userId);
  await resimulateFrom(db, userId, (a.startTimeLocal ?? a.startTime).slice(0, 10), prefs).catch(
    () => undefined,
  );
  return c.json({ ok: true });
});

/** Undo a match. */
planRoutes.post("/workouts/:id/unmatch", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const now = nowInstant();
  const match = (
    await db
      .select()
      .from(workoutCompletionMatches)
      .where(
        and(
          eq(workoutCompletionMatches.workoutId, c.req.param("id")),
          isNull(workoutCompletionMatches.undoneAt),
        ),
      )
      .limit(1)
  )[0];
  if (!match) return c.json({ error: "not_found" }, 404);
  await db
    .update(workoutCompletionMatches)
    .set({ undoneAt: now })
    .where(eq(workoutCompletionMatches.id, match.id));
  await db
    .update(activities)
    .set({ completionMatchId: null, updatedAt: now })
    .where(eq(activities.id, match.activityId));
  await db
    .update(plannedWorkouts)
    .set({ completionState: "unresolved", resolutionDate: null, updatedAt: now })
    .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)));
  const prefs = await loadPreferences(db, userId);
  await resimulateFrom(db, userId, todayInZone(prefs.timezone), prefs).catch(() => undefined);
  return c.json({ ok: true });
});

/**
 * Remove a workout from the plan: archived locally, calendar event suppressed.
 * Never touches the COROS calendar — for COROS-sourced workouts the archived
 * row keeps its sourceWorkoutId, so future imports update it in place without
 * resurrecting it into the visible plan.
 */
planRoutes.post("/workouts/:id/remove", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);
  if (w.archivedAt) return c.json({ ok: true });
  const now = nowInstant();
  const workoutId = w.id;
  await db
    .update(plannedWorkouts)
    .set({ archivedAt: now, updatedAt: now, archiveReason: "user_removed" })
    .where(eq(plannedWorkouts.id, workoutId));
  await db.insert(calendarEventSuppressions).values({
    id: newId(),
    workoutId: workoutId,
    eventId: null,
    // "user_removed" (not the absence-detector's "workout_removed"): a hand
    // removal is a decision, and import's presence-healing must never undo it.
    reason: "user_removed",
    createdAt: now,
  });
  await recordIntent(db, {
    userId,
    targetKind: "workout",
    targetId: workoutId,
    kind: "remove_local",
    source: "remove_from_plan",
  });
  // Close out any open move intent for this workout too — once it's removed
  // from the plan there's nothing left to sync, and leaving the move intent
  // open behind an archived workout would strand a permanent, uncloseable
  // sync_issue (emitPendingWork resolves it too, but this closes the gap
  // immediately rather than waiting for the next bridge sync).
  const openMove = await openIntentFor(db, userId, workoutId, "move");
  if (openMove) await resolveIntent(db, openMove.id, now);
  await syncCalendar(db, c.env, userId).catch(() => undefined);
  const prefs = await loadPreferences(db, userId);
  const today = todayInZone(prefs.timezone);
  // A removed past workout must stop counting against the garden.
  const resimFrom = w.effectiveDate < today ? w.effectiveDate : today;
  await resimulateFrom(db, userId, resimFrom, prefs).catch(() => undefined);
  return c.json({ ok: true });
});

planRoutes.post("/workouts/:id/restore-calendar", async (c) => {
  await restoreCalendarEvent(c.get("db"), c.get("userId"), c.req.param("id"));
  await syncCalendar(c.get("db"), c.env, c.get("userId")).catch(() => undefined);
  return c.json({ ok: true });
});

/** Retry a failed COROS write. */
planRoutes.post("/workouts/:id/retry-coros", async (c) => {
  const db = c.get("db");
  const userId = c.get("userId");
  const prefs = await loadPreferences(db, userId);
  const w = (
    await db
      .select()
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, c.req.param("id")), eq(plannedWorkouts.userId, userId)))
      .limit(1)
  )[0];
  if (!w) return c.json({ error: "not_found" }, 404);
  // A terminally failed job for this workout's current destination blocks
  // emitPendingWork's retry-forever guard (jobs.ts) from ever re-arming
  // future emission for it — superseding it here before applyMove clears
  // that block, so this user-initiated retry actually re-arms emission.
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: nowInstant() })
    .where(and(eq(corosWriteJobs.workoutId, w.id), eq(corosWriteJobs.status, "failed")));
  const outcome = await applyMove(db, {
    userId,
    workoutId: w.id,
    toDate: w.effectiveDate,
    toTime: w.effectiveTime,
    source: "app",
    corosWritesEnabled: prefs.corosWritesEnabled,
  });
  return c.json(outcome);
});
