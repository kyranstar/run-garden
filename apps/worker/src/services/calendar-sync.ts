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
  CALENDAR_EVENT_PROPERTY_NS,
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
  appOrigin,
  buildEventResource,
  eventContentFingerprint,
  extractUserNotes,
  NOTES_MARKER,
  originFromEvent,
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
import { isRestoring, loadAccountState, patchAccountState, restoreInProgress } from "./account-state.js";

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
  /** Post-restore reconcile (B6): events linked, links recreated, orphans deleted. */
  adopted?: number;
  recreated?: number;
  orphansDeleted?: number;
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
  // A restore is replacing the account (B2): the links and suppressions the
  // file carries are not in yet, so any sync now would duplicate every event.
  const account = await loadAccountState(db, userId);
  if (isRestoring(account)) {
    stats.skipped = true;
    return stats;
  }
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

  // ── Actual state (incremental sync with fallback to windowed read) ───────
  const cursorId = `${userId}:google_calendar:events_sync_token:${calendarId}`;
  const cursorRows = await db
    .select()
    .from(providerCursorState)
    .where(eq(providerCursorState.id, cursorId))
    .limit(1);
  // After a restore the stored token (if any) predates the file: the one-shot
  // reconcile needs the whole window, so every sync reads it in full until
  // the reconcile is done.
  const postRestore = account?.calendarReconcile ?? null;
  const syncToken = opts.fullResync || postRestore ? undefined : cursorRows[0]?.value;

  // Bounds pad one day each side: stapling `Z` onto LOCAL dates cut up to
  // ~8h off the window's edges for a Pacific user, and an evening workout on
  // the last local day read as user-deleted on a full read (audit#2 #20).
  const timeMin = `${addDays(windowStart, -1)}T00:00:00Z`;
  const timeMax = `${addDays(windowEnd, 1)}T23:59:59Z`;
  let listResult = await client.listEvents(calendarId, { syncToken, timeMin, timeMax });
  let fullRead = !syncToken;
  if (listResult.fullSyncRequired) {
    listResult = await client.listEvents(calendarId, { timeMin, timeMax });
    fullRead = true;
  }
  // A read Google still refused is not a full picture of the calendar.
  if (listResult.fullSyncRequired) fullRead = false;

  // The read takes a while; a restore that began meanwhile wins.
  if (await restoreInProgress(db, userId)) {
    stats.skipped = true;
    return stats;
  }

  // D1 caps bound variables (~100/statement) and the workout window has
  // outgrown it — an unchunked inArray here failed EVERY calendar sync once
  // the lifting plan landed ("too many SQL variables", live-observed), which
  // silently froze the user's Google Calendar. Chunked reads, same shape.
  const workoutIds = workouts.map((w) => w.id);
  const links: (typeof calendarEventLinks.$inferSelect)[] = [];
  const suppressions: (typeof calendarEventSuppressions.$inferSelect)[] = [];
  const loadLinks = async (): Promise<void> => {
    links.length = 0;
    suppressions.length = 0;
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
  };
  await loadLinks();

  // ── One-shot post-restore reconcile, part 1 (ruling B6 a, b) ───────────
  // Only on a FULL read that succeeded: a failed read threw above, and an
  // incremental one sees only what changed.
  if (postRestore && fullRead && postRestore.phase === "pending") {
    await adoptAndRecreate(db, userId, {
      calendarId,
      items: listResult.items as RawGoogleEvent[],
      workouts,
      links,
      suppressions,
      restoreFinishedAt: account?.restoreFinishedAt ?? null,
      stats,
    });
    await loadLinks();
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

  // ── One-shot post-restore reconcile, part 2: the orphan sweep (B6 c) ────
  if (postRestore && fullRead) {
    const done = postRestore.sweep
      ? await sweepOrphans(db, client, calendarId, env.APP_URL, listResult.items as RawGoogleEvent[], stats)
      : true;
    await patchAccountState(db, userId, { calendarReconcile: done ? null : { phase: "sweeping", sweep: true } });
  }

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

/** Most orphaned events one sync deletes after a restore; the rest wait. */
export const POST_RESTORE_DELETE_CAP = 25;

/** Of `ids`, those naming a planned_workouts row — of this account when
 * `userId` is given, of ANY account otherwise. Live or archived alike. */
async function workoutIdsWithRows(db: Db, ids: string[], userId?: string): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunkIds([...new Set(ids)])) {
    const rows = await db
      .select({ id: plannedWorkouts.id })
      .from(plannedWorkouts)
      .where(userId ? and(inArray(plannedWorkouts.id, chunk), eq(plannedWorkouts.userId, userId)) : inArray(plannedWorkouts.id, chunk));
    for (const r of rows) found.add(r.id);
  }
  return found;
}

const liveEvent = (e: RawGoogleEvent) => e.status !== "cancelled";

/**
 * Post-restore (a) and (b), database only — the ordinary reconcile that
 * follows does the Google writes.
 *
 * (a) An event whose rgWorkoutId names a row of this account — live OR
 *     archived — is that row's event: link it (keeping the athlete's notes and
 *     treating our own last-written fingerprint as the one it carries), unless
 *     the row is already linked to an event that is still there. Without this
 *     a restored row whose event was written after the export got a second
 *     event, or was "updated" forever without a link, reverting every edit
 *     the athlete made to it. An archived row's event is then deleted by the
 *     ordinary removed-workout path — never by the sweep.
 * (b) A restored link of a live row in the window whose event is gone is
 *     dropped, so the reconcile creates the event again — unless the FILE held
 *     a user_deleted suppression for it (created before the restore
 *     finished): then the athlete deleted it, and it stays deleted.
 */
async function adoptAndRecreate(
  db: Db,
  userId: string,
  input: {
    calendarId: string;
    items: RawGoogleEvent[];
    workouts: Array<typeof plannedWorkouts.$inferSelect>;
    links: Array<typeof calendarEventLinks.$inferSelect>;
    suppressions: Array<typeof calendarEventSuppressions.$inferSelect>;
    restoreFinishedAt: string | null;
    stats: CalendarSyncStats;
  },
): Promise<void> {
  const now = nowInstant();
  const liveIds = new Set(input.items.filter(liveEvent).map((e) => e.id));
  const eventByWorkout = new Map<string, RawGoogleEvent>();
  for (const e of input.items) {
    const wid = workoutIdFromEvent(e.extendedProperties);
    if (wid && liveEvent(e) && !eventByWorkout.has(wid)) eventByWorkout.set(wid, e);
  }

  // (a)
  const owned = await workoutIdsWithRows(db, [...eventByWorkout.keys()], userId);
  const existing = new Map<string, typeof calendarEventLinks.$inferSelect>();
  for (const ids of chunkIds([...owned])) {
    for (const l of await db.select().from(calendarEventLinks).where(inArray(calendarEventLinks.workoutId, ids))) {
      existing.set(l.workoutId, l);
    }
  }
  for (const workoutId of owned) {
    const current = existing.get(workoutId);
    if (current && liveIds.has(current.eventId)) continue;
    const event = eventByWorkout.get(workoutId)!;
    const values = {
      calendarId: input.calendarId,
      eventId: event.id,
      state: "synced",
      lastWrittenFingerprint: event.extendedProperties?.private?.[`${CALENDAR_EVENT_PROPERTY_NS}Fingerprint`] ?? null,
      lastWrittenAt: now,
      userNotes: extractUserNotes(event.description) ?? null,
      updatedAt: now,
    };
    if (current) await db.update(calendarEventLinks).set(values).where(eq(calendarEventLinks.id, current.id));
    else await db.insert(calendarEventLinks).values({ id: newId(), workoutId, createdAt: now, ...values });
    input.stats.adopted = (input.stats.adopted ?? 0) + 1;
  }

  // (b)
  const deletedInFile = new Set(
    input.suppressions
      .filter((s) => s.reason === "user_deleted" && (!input.restoreFinishedAt || s.createdAt <= input.restoreFinishedAt))
      .map((s) => s.workoutId),
  );
  const linkBy = new Map(input.links.map((l) => [l.workoutId, l]));
  for (const w of input.workouts) {
    if (w.archivedAt || w.category === "rest") continue;
    const restored = linkBy.get(w.id);
    if (!restored || liveIds.has(restored.eventId)) continue;
    if (eventByWorkout.has(w.id)) continue; // (a) linked another event carrying its id
    if (deletedInFile.has(w.id)) continue;
    await db.delete(calendarEventLinks).where(eq(calendarEventLinks.id, restored.id));
    input.stats.recreated = (input.stats.recreated ?? 0) + 1;
  }
}

/**
 * Post-restore (c): delete events that carry THIS app's origin and whose
 * rgWorkoutId names no row — sessions the restore took away (added after the
 * export), whose events nothing else would ever remove. The id is looked up
 * against every planned_workouts row, not the sync's window (an event on the
 * day before the window is still a live row's), and against every account
 * (a row of another account is never this sweep's to judge). An unstamped
 * event is never deleted: it may predate the stamp, or belong to another
 * deployment writing into the same calendar. At most
 * POST_RESTORE_DELETE_CAP deletions per sync; returns true once none remain.
 */
async function sweepOrphans(
  db: Db,
  client: GoogleCalendarClient,
  calendarId: string,
  appUrl: string,
  items: RawGoogleEvent[],
  stats: CalendarSyncStats,
): Promise<boolean> {
  const origin = appOrigin(appUrl);
  if (!origin) return true;
  const stamped = items.filter(
    (e) => liveEvent(e) && originFromEvent(e.extendedProperties) === origin && workoutIdFromEvent(e.extendedProperties),
  );
  const named = await workoutIdsWithRows(db, stamped.map((e) => workoutIdFromEvent(e.extendedProperties)!));
  const orphans = stamped.filter((e) => !named.has(workoutIdFromEvent(e.extendedProperties)!));
  for (const e of orphans.slice(0, POST_RESTORE_DELETE_CAP)) {
    try {
      await client.deleteEvent(calendarId, e.id);
      stats.deleted += 1;
      stats.orphansDeleted = (stats.orphansDeleted ?? 0) + 1;
    } catch {
      stats.opErrors = (stats.opErrors ?? 0) + 1;
      return false; // tried again on the next full read
    }
  }
  return orphans.length <= POST_RESTORE_DELETE_CAP;
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
