import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  calendarEventLinks,
  calendarEventSuppressions,
  plannedWorkouts,
  providerConnections,
  providerCursorState,
  userPreferences,
} from "@rg/database";
import {
  addDays,
  COROS_SYNC_LABELS,
  newId,
  nowInstant,
  todayInZone,
  userPreferencesSchema,
  type CorosSyncState,
  type UserPreferences,
} from "@rg/domain";
import { computeBlock, planReminders } from "@rg/scheduling";
import {
  buildEventResource,
  eventContentFingerprint,
  NOTES_MARKER,
  reconcileCalendar,
  workoutIdFromEvent,
  type ActualEvent,
  type DesiredEvent,
  type ReconcileOp,
} from "@rg/calendar";
import type { Env } from "../env.js";
import { chunkIds, type Db } from "./db.js";
import { googleCalendarClient, type GoogleCalendarClient } from "./google-calendar.js";
import { activeSyncNotes, postSyncNote } from "./sync-notes.js";
import { applyMove } from "./jobs.js";

/**
 * Google Calendar mirror: at least 8 weeks ahead and 2 weeks back, one padded
 * managed event per non-rest workout, incremental sync for manual-edit
 * detection, deletion suppression, and notes preservation.
 */

export async function loadPreferences(db: Db, userId: string): Promise<UserPreferences> {
  const rows = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  return userPreferencesSchema.parse(rows[0]?.prefs ?? {});
}

export async function savePreferences(db: Db, userId: string, prefs: UserPreferences): Promise<void> {
  const now = nowInstant();
  const existing = await db
    .select({ userId: userPreferences.userId })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (existing[0]) {
    await db
      .update(userPreferences)
      .set({ prefs: prefs as unknown as Record<string, unknown>, updatedAt: now })
      .where(eq(userPreferences.userId, userId));
  } else {
    await db.insert(userPreferences).values({
      userId,
      prefs: prefs as unknown as Record<string, unknown>,
      updatedAt: now,
    });
  }
}

interface RawGoogleEvent {
  id: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  summary?: string;
  description?: string;
  extendedProperties?: { private?: Record<string, string> };
  updated?: string;
}

function toActualEvent(e: RawGoogleEvent): ActualEvent {
  return {
    eventId: e.id,
    status: (e.status as ActualEvent["status"]) ?? "confirmed",
    startDateTime: e.start?.dateTime,
    endDateTime: e.end?.dateTime,
    summary: e.summary,
    description: e.description,
    extendedProperties: e.extendedProperties,
    updated: e.updated,
  };
}

export interface CalendarSyncStats {
  created: number;
  updated: number;
  deleted: number;
  userMovesAccepted: number;
  userDeletions: number;
  notesPreserved: number;
  skipped: boolean;
  /** Ops that failed and were skipped this run (each retried next run). */
  opErrors?: number;
}

export async function syncCalendar(
  db: Db,
  env: Env,
  userId: string,
  opts: { fullResync?: boolean } = {},
): Promise<CalendarSyncStats> {
  const stats: CalendarSyncStats = {
    created: 0,
    updated: 0,
    deleted: 0,
    userMovesAccepted: 0,
    userDeletions: 0,
    notesPreserved: 0,
    skipped: false,
  };
  const prefs = await loadPreferences(db, userId);
  const client = await googleCalendarClient(db, env, userId);
  if (!client || !prefs.calendarId) {
    stats.skipped = true;
    return stats;
  }
  const calendarId = prefs.calendarId;
  const today = todayInZone(prefs.timezone);
  const windowStart = addDays(today, -7 * prefs.mirrorWeeksBehind);
  const windowEnd = addDays(today, 7 * prefs.mirrorWeeksAhead);

  // ── Desired state ────────────────────────────────────────────────────────
  const workouts = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        gte(plannedWorkouts.effectiveDate, windowStart),
        lte(plannedWorkouts.effectiveDate, windowEnd),
      ),
    );

  // D1 caps bound variables (~100/statement) and the workout window has
  // outgrown it — an unchunked inArray here failed EVERY calendar sync once
  // the lifting plan landed ("too many SQL variables", live-observed), which
  // silently froze the user's Google Calendar. Chunked reads, same shape.
  const workoutIds = workouts.map((w) => w.id);
  const links: (typeof calendarEventLinks.$inferSelect)[] = [];
  const suppressions: (typeof calendarEventSuppressions.$inferSelect)[] = [];
  for (const ids of chunkIds(workoutIds)) {
    links.push(
      ...(await db.select().from(calendarEventLinks).where(inArray(calendarEventLinks.workoutId, ids))),
    );
    suppressions.push(
      ...(await db
        .select()
        .from(calendarEventSuppressions)
        .where(inArray(calendarEventSuppressions.workoutId, ids))),
    );
  }
  const linkByWorkout = new Map(links.map((l) => [l.workoutId, l]));

  const desired: DesiredEvent[] = [];
  const removedWorkoutIds: string[] = [];
  for (const w of workouts) {
    if (w.category === "rest") {
      // A workout that BECAME a rest day upstream still has its old event —
      // clean it up like an archived row, or the calendar shows a phantom
      // session (with reminders) forever.
      if (linkByWorkout.has(w.id)) removedWorkoutIds.push(w.id);
      continue;
    }
    if (w.archivedAt) {
      if (linkByWorkout.has(w.id)) removedWorkoutIds.push(w.id);
      continue;
    }
    const workoutSeconds =
      w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds ?? 45 * 60;
    const block = computeBlock(w.effectiveDate, w.effectiveTime, workoutSeconds, prefs);
    const reminders = planReminders(w.effectiveDate, w.effectiveTime, block.startInstant, prefs);
    desired.push({
      workoutId: w.id,
      resource: buildEventResource({
        workout: {
          workoutId: w.id,
          title: w.title,
          category: w.category as never,
          workoutSeconds,
          calendarSeconds: w.calendarBlockDurationSeconds,
          stageSummary: w.stageSummary ?? undefined,
          corosDate: w.lastVerifiedCorosDate,
          effectiveDate: w.effectiveDate,
          effectiveTime: w.effectiveTime,
          corosStatusLabel: COROS_SYNC_LABELS[w.corosSyncState as CorosSyncState] ?? w.corosSyncState,
          sleepReminderText: reminders.sleepReminderText,
        },
        block,
        reminders,
        timezone: prefs.timezone,
        appUrl: env.APP_URL,
        userNotes: linkByWorkout.get(w.id)?.userNotes ?? undefined,
      }),
    });
  }

  // ── Actual state (incremental sync with fallback to windowed read) ───────
  const cursorId = `${userId}:google_calendar:events_sync_token:${calendarId}`;
  const cursorRows = await db
    .select()
    .from(providerCursorState)
    .where(eq(providerCursorState.id, cursorId))
    .limit(1);
  const syncToken = opts.fullResync ? undefined : cursorRows[0]?.value;

  // Bounds pad one day each side: stapling `Z` onto LOCAL dates cut up to
  // ~8h off the window's edges for a Pacific user, and an evening workout on
  // the last local day read as user-deleted on a full read (audit#2 #20).
  const timeMin = `${addDays(windowStart, -1)}T00:00:00Z`;
  const timeMax = `${addDays(windowEnd, 1)}T23:59:59Z`;
  let listResult = await client.listEvents(calendarId, { syncToken, timeMin, timeMax });
  if (listResult.fullSyncRequired) {
    listResult = await client.listEvents(calendarId, { timeMin, timeMax });
  }

  const rawEvents = (listResult.items as RawGoogleEvent[]).filter(
    (e) => workoutIdFromEvent(e.extendedProperties) !== undefined,
  );
  let actual = rawEvents.map(toActualEvent);

  // With an incremental token we only see CHANGED events; merge with links so
  // unchanged events aren't misread as deleted.
  if (syncToken) {
    const changedIds = new Set(actual.map((a) => a.eventId));
    for (const link of links) {
      if (!changedIds.has(link.eventId)) {
        // Unchanged since last sync: reconstruct "actual" from our last write.
        const w = workouts.find((x) => x.id === link.workoutId);
        const d = desired.find((x) => x.workoutId === link.workoutId);
        if (w && link.lastWrittenFingerprint && d) {
          actual.push({
            eventId: link.eventId,
            status: "confirmed",
            // Assume our last-written times still stand (they weren't changed).
            startDateTime: d.resource.start.dateTime,
            endDateTime: d.resource.end.dateTime,
            description: undefined,
            extendedProperties: {
              private: { rgWorkoutId: link.workoutId, rgFingerprint: link.lastWrittenFingerprint },
            },
          });
        }
      }
    }
  }

  // Synthesized "actual" rows above reflect our own desired times, which would
  // hide a pending update. Correct that: for unchanged events, use the stored
  // fingerprint as both actual and last-written so only content diffs trigger.
  const ops = reconcileCalendar({
    desired,
    actual,
    links: links.map((l) => ({
      workoutId: l.workoutId,
      eventId: l.eventId,
      lastWrittenFingerprint: l.lastWrittenFingerprint ?? undefined,
      userNotes: l.userNotes ?? undefined,
    })),
    suppressions: suppressions.map((s) => ({ workoutId: s.workoutId })),
    removedWorkoutIds,
  });

  await executeOps(db, env, userId, client, calendarId, ops, prefs, stats);

  if (listResult.nextSyncToken) {
    const now = nowInstant();
    if (cursorRows[0]) {
      await db
        .update(providerCursorState)
        .set({ value: listResult.nextSyncToken, updatedAt: now })
        .where(eq(providerCursorState.id, cursorId));
    } else {
      await db.insert(providerCursorState).values({
        id: cursorId,
        userId,
        provider: "google_calendar",
        cursorKey: `events_sync_token:${calendarId}`,
        value: listResult.nextSyncToken,
        updatedAt: now,
      });
    }
  }

  // A successful sync stamps the connection — before this, google
  // last_sync_at was NEVER written (293 ok runs, still NULL) and Settings
  // had no honest freshness to show.
  await db
    .update(providerConnections)
    .set({ lastSyncAt: nowInstant(), lastErrorCategory: null, updatedAt: nowInstant() })
    .where(
      and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "google_calendar")),
    );

  return stats;
}

async function executeOps(
  db: Db,
  env: Env,
  userId: string,
  client: GoogleCalendarClient,
  calendarId: string,
  ops: ReconcileOp[],
  prefs: UserPreferences,
  stats: CalendarSyncStats,
): Promise<void> {
  const now = nowInstant();
  for (const op of ops) {
    try {
      await executeOneOp(db, userId, client, calendarId, op, prefs, stats, now);
    } catch (e) {
      // A rejected RACE move deserves a visible note, not a swallowed warn
      // (audit#2 #3): the user dragged the race event believing it worked,
      // and the mirror kept claiming "synced" while diverging permanently.
      if (
        op.op === "accept_user_move" &&
        e instanceof Error &&
        e.message === "races_cannot_move"
      ) {
        const existing = await activeSyncNotes(db, userId);
        if (!existing.some((n) => n.kind === "race_move_rejected" && n.workoutId === op.workoutId)) {
          await postSyncNote(db, {
            userId,
            kind: "race_move_rejected",
            workoutId: op.workoutId,
            payload: { attemptedStart: op.newStart },
          });
        }
        continue;
      }
      // One poisoned event (quota 403, an id the token lost access to, a
      // race-duplicated link) must never wedge the whole mirror: before this
      // guard, the loop aborted at the same position on every run and
      // everything downstream of one bad op silently stopped syncing forever.
      stats.opErrors = (stats.opErrors ?? 0) + 1;
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "calendar: op failed, continuing",
          op: op.op,
          workoutId: "workoutId" in op ? op.workoutId : undefined,
          detail: e instanceof Error ? e.message.slice(0, 200) : "unknown",
        }),
      );
    }
  }
}

async function executeOneOp(
  db: Db,
  userId: string,
  client: GoogleCalendarClient,
  calendarId: string,
  op: ReconcileOp,
  prefs: UserPreferences,
  stats: CalendarSyncStats,
  now: string,
): Promise<void> {
  {
    switch (op.op) {
      case "create": {
        const created = await client.insertEvent(calendarId, op.resource);
        const fp = eventContentFingerprint(op.resource);
        await db.insert(calendarEventLinks).values({
          id: newId(),
          workoutId: op.workoutId,
          calendarId,
          eventId: created.id,
          state: "synced",
          lastWrittenFingerprint: fp,
          lastWrittenAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await db
          .update(plannedWorkouts)
          .set({ calendarSyncState: "synced", updatedAt: now })
          .where(eq(plannedWorkouts.id, op.workoutId));
        stats.created += 1;
        break;
      }
      case "update":
      case "preserve_notes_update": {
        const resource =
          op.op === "preserve_notes_update"
            ? rebuildWithNotes(op.resource, op.userNotes)
            : op.resource;
        await client.patchEvent(calendarId, op.eventId, resource);
        const fp = eventContentFingerprint(resource);
        await db
          .update(calendarEventLinks)
          .set({
            lastWrittenFingerprint: fp,
            lastWrittenAt: now,
            state: "synced",
            userNotes: op.op === "preserve_notes_update" ? op.userNotes : undefined,
            updatedAt: now,
          })
          .where(eq(calendarEventLinks.workoutId, op.workoutId));
        await db
          .update(plannedWorkouts)
          .set({ calendarSyncState: "synced", updatedAt: now })
          .where(eq(plannedWorkouts.id, op.workoutId));
        if (op.op === "preserve_notes_update") stats.notesPreserved += 1;
        else stats.updated += 1;
        break;
      }
      case "accept_user_move": {
        // Adopt the user's manual calendar change; queue COROS if date changed.
        const local = new Date(op.newStart);
        const zoned = new Intl.DateTimeFormat("en-CA", {
          timeZone: prefs.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(local);
        const get = (type: string) => zoned.find((p) => p.type === type)?.value ?? "";
        // The event start includes the before-buffer; workout starts after it.
        const startMinutes =
          Number(get("hour")) * 60 + Number(get("minute")) + prefs.bufferBeforeMinutes;
        const toTime = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, "0")}:${String(startMinutes % 60).padStart(2, "0")}`;
        // A drag to 23:50 plus the buffer crosses midnight — the overflow
        // belongs to the NEXT day, or the workout lands a day early
        // (audit#3 T5).
        const toDate = addDays(
          `${get("year")}-${get("month")}-${get("day")}`,
          Math.floor(startMinutes / 1440),
        );
        await applyMove(db, {
          userId,
          workoutId: op.workoutId,
          toDate,
          toTime,
          source: "calendar_edit",
          corosWritesEnabled: prefs.corosWritesEnabled,
        });
        stats.userMovesAccepted += 1;
        break;
      }
      case "mark_user_deleted": {
        await db
          .update(calendarEventLinks)
          .set({ state: "user_deleted", updatedAt: now })
          .where(eq(calendarEventLinks.workoutId, op.workoutId));
        await db
          .insert(calendarEventSuppressions)
          .values({ id: newId(), workoutId: op.workoutId, eventId: op.eventId, reason: "user_deleted", createdAt: now });
        await db
          .update(plannedWorkouts)
          .set({ calendarSyncState: "user_deleted", updatedAt: now })
          .where(eq(plannedWorkouts.id, op.workoutId));
        stats.userDeletions += 1;
        break;
      }
      case "delete": {
        await client.deleteEvent(calendarId, op.eventId);
        await db.delete(calendarEventLinks).where(eq(calendarEventLinks.workoutId, op.workoutId));
        stats.deleted += 1;
        break;
      }
    }
  }
}

function rebuildWithNotes(
  resource: DesiredEvent["resource"],
  notes: string,
): DesiredEvent["resource"] {
  // The description is rebuilt by the caller without notes; splice them in
  // ahead of the managed footer.
  const marker = "Managed by";
  const idx = resource.description.lastIndexOf(marker);
  const notesBlock = `${NOTES_MARKER}\n${notes}\n\n`;
  const description =
    idx === -1
      ? `${resource.description}\n\n${notesBlock}`
      : `${resource.description.slice(0, idx)}${notesBlock}${resource.description.slice(idx)}`;
  return { ...resource, description };
}

/** Restore a user-deleted event (explicit user action). */
export async function restoreCalendarEvent(db: Db, userId: string, workoutId: string): Promise<void> {
  // Ownership BEFORE any write: the suppression/link deletes below key on
  // workoutId alone (neither table has a user_id column), so an unverified
  // id would let one user clear another's calendar rows.
  const owned = await db
    .select({ id: plannedWorkouts.id })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!owned[0]) return;
  const now = nowInstant();
  await db.delete(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, workoutId));
  await db.delete(calendarEventLinks).where(eq(calendarEventLinks.workoutId, workoutId));
  await db
    .update(plannedWorkouts)
    .set({ calendarSyncState: "pending", updatedAt: now })
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)));
}
