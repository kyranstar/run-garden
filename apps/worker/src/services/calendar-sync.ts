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
  /** The run stopped at its op cap (CALENDAR_OPS_PER_RUN, or a request's `maxOps`); `deferred` more wait for the next run. */
  capped?: true;
  deferred?: number;
}

/**
 * Most ops one sync executes; the rest wait for the next run. Each op is a Google call and up to two D1 writes (a
 * move more), and one invocation on Workers Free has 50 subrequests and a few milliseconds of CPU: a first sync, a
 * token reset or a change touching every event (a description format, a buffer) once meant 70+ Google calls in one
 * invocation, which the runtime killed part-way, leaving the run `running` (2026-10-03 on). The half-hourly cron
 * spends one invocation on this and then the COROS sweeps, so 20 leaves them room. A capped run keeps the sync
 * token it read with, so whatever it did not get to — a move or deletion the athlete made in Google included — is
 * in the next run's feed again.
 */
export const CALENDAR_OPS_PER_RUN = 20;

/**
 * Most ops a sync run BY A USER'S REQUEST executes beside that request's own work (2026-10-10). The coach approve
 * synced in its own invocation with the cron's whole cap of 20 — up to 20 Google calls and 40 D1 writes on top of
 * the approve, past the free plan's 50 on any proposal that touches a week. A request books the few sessions it
 * changed; anything past this waits, unsaved token and all, for the half-hourly run.
 */
export const CALENDAR_OPS_PER_REQUEST = 4;

/**
 * The ops a run executes: all of them within the budget; past it, the sessions still ahead first (soonest first),
 * then the past ones (latest first) — a first sync or a token reset books the coming weeks before the two behind.
 */
function opsThisRun(
  ops: ReconcileOp[],
  dateOf: Map<string, string>,
  today: string,
  failedLastRun: ReadonlySet<string>,
  cap: number = CALENDAR_OPS_PER_RUN,
): ReconcileOp[] {
  if (ops.length <= cap) return ops;
  const date = (op: ReconcileOp) => dateOf.get(op.workoutId) ?? "";
  const ordered = (list: ReconcileOp[]) => [
    ...list.filter((op) => date(op) >= today).sort((a, b) => date(a).localeCompare(date(b))),
    ...list.filter((op) => date(op) < today).sort((a, b) => date(b).localeCompare(date(a))),
  ];
  // AN OP THAT FAILED LAST RUN WAITS BEHIND THE REST (re-review C-2a). One Google refuses every run (a 403'd event)
  // was otherwise re-picked first every run, and CALENDAR_OPS_PER_RUN of them starved everything behind them — the
  // "one poisoned op wedges the mirror" hole executeOps' catch closed, reopened by the cap. They are still retried,
  // with whatever room the rest leave.
  const fresh = ops.filter((op) => !failedLastRun.has(op.workoutId));
  const failed = ops.filter((op) => failedLastRun.has(op.workoutId));
  return [...ordered(fresh), ...ordered(failed)].slice(0, cap);
}

/** The workouts whose op failed on the last run that reached them — `opsThisRun` puts them last. */
const FAILED_OPS_CURSOR_KEY = (calendarId: string) => `failed_ops:${calendarId}`;

function parseFailedOps(value: string | undefined): Set<string> {
  if (!value) return new Set();
  try {
    const ids: unknown = JSON.parse(value);
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export async function syncCalendar(
  db: Db,
  env: Env,
  userId: string,
  opts: {
    fullResync?: boolean;
    /** Most ops this run executes — `CALENDAR_OPS_PER_REQUEST` from a user's request; the cron's CALENDAR_OPS_PER_RUN by default. */
    maxOps?: number;
  } = {},
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
  const failedOpsId = `${userId}:google_calendar:${FAILED_OPS_CURSOR_KEY(calendarId)}`;
  // One read for both: the sync token, and the ops that failed last run.
  const cursorBoth = await db
    .select()
    .from(providerCursorState)
    .where(inArray(providerCursorState.id, [cursorId, failedOpsId]));
  const cursorRows = cursorBoth.filter((r) => r.id === cursorId);
  const failedOpsRow = cursorBoth.find((r) => r.id === failedOpsId);
  const failedLastRun = parseFailedOps(failedOpsRow?.value);
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
      appUrl: env.APP_URL,
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

  // During the post-restore reconcile the ordinary pass below sees only the
  // events adoption would claim (B10, M7): this app's, or unstamped ones the
  // file itself linked. Otherwise it would take the rest over anyway — edit
  // another deployment's event (prod's, when a local stack restores prod's
  // file into the same calendar) because it carries the same workout id.
  const thisOrigin = appOrigin(env.APP_URL);
  const linkedEventIds = new Set(links.map((l) => l.eventId));
  const rawEvents = (listResult.items as RawGoogleEvent[]).filter((e) => {
    if (workoutIdFromEvent(e.extendedProperties) === undefined) return false;
    if (!postRestore) return true;
    const origin = originFromEvent(e.extendedProperties);
    return origin === undefined ? linkedEventIds.has(e.id) : thisOrigin !== undefined && origin === thisOrigin;
  });
  let actual = rawEvents.map(toActualEvent);

  // With an incremental token we only see CHANGED events; merge with links so
  // unchanged events aren't misread as deleted.
  if (syncToken) {
    const changedIds = new Set(actual.map((a) => a.eventId));
    // By id, not a scan per link: a scan per link was quadratic in the window.
    const workoutIdSet = new Set(workouts.map((x) => x.id));
    const desiredByWorkout = new Map(desired.map((x) => [x.workoutId, x]));
    for (const link of links) {
      if (!changedIds.has(link.eventId)) {
        // Unchanged since last sync: reconstruct "actual" from our last write.
        const d = desiredByWorkout.get(link.workoutId);
        if (workoutIdSet.has(link.workoutId) && link.lastWrittenFingerprint && d) {
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

  const cap = opts.maxOps ?? CALENDAR_OPS_PER_RUN;
  const runNow = opsThisRun(ops, new Map(workouts.map((w) => [w.id, w.effectiveDate])), today, failedLastRun, cap);
  const failedNow = await executeOps(db, env, userId, client, calendarId, runNow, prefs, stats);
  if (ops.length > runNow.length) {
    stats.capped = true;
    stats.deferred = ops.length - runNow.length;
  }
  // What failed this run, plus what failed before and did not get a turn — written only when it changed.
  const ranNow = new Set(runNow.map((op) => op.workoutId));
  const deferredIds = new Set(ops.map((op) => op.workoutId).filter((id) => !ranNow.has(id)));
  const failedNext = [...failedNow, ...[...failedLastRun].filter((id) => deferredIds.has(id))].sort();
  if (failedNext.join("\n") !== [...failedLastRun].sort().join("\n")) {
    const now = nowInstant();
    await db
      .insert(providerCursorState)
      .values({
        id: failedOpsId,
        userId,
        provider: "google_calendar",
        cursorKey: FAILED_OPS_CURSOR_KEY(calendarId),
        value: JSON.stringify(failedNext),
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: providerCursorState.id, set: { value: JSON.stringify(failedNext), updatedAt: now } });
  }

  // ── One-shot post-restore reconcile, part 2: the orphan sweep (B6 c) ────
  // Its deletions come out of the same per-run budget. A capped run leaves the
  // reconcile open (full reads go on) and its token unsaved, whatever it swept.
  if (postRestore && fullRead) {
    const budget = Math.min(POST_RESTORE_DELETE_CAP, cap - runNow.length);
    const swept = postRestore.sweep
      ? budget > 0 &&
        (await sweepOrphans(db, client, calendarId, env.APP_URL, listResult.items as RawGoogleEvent[], stats, budget))
      : true;
    await patchAccountState(db, userId, {
      calendarReconcile: swept && !stats.capped ? null : { phase: "sweeping", sweep: postRestore.sweep && !swept },
    });
  }

  if (listResult.nextSyncToken && !stats.capped) {
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
): Promise<Set<string>> {
  const now = nowInstant();
  // The workouts whose op did not land this run (`opsThisRun` puts them behind the rest next time).
  const failed = new Set<string>();
  for (const op of ops) {
    try {
      await executeOneOp(db, userId, client, calendarId, op, prefs, stats, now);
    } catch (e) {
      failed.add(op.workoutId);
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
  return failed;
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
        // AN UNLINKED EVENT OF OURS IS ADOPTED HERE (re-review C-2b). A run killed between Google's insert and the
        // link's insert leaves an event that carries this workout's id and no link; the reconcile reads it as ours
        // and patches it. The link write used to be an UPDATE, which matched no row — so the event stayed unlinked
        // and was patched again on every run, for ever. One statement either way: the link is written if missing.
        await db
          .insert(calendarEventLinks)
          .values({
            id: newId(),
            workoutId: op.workoutId,
            calendarId,
            eventId: op.eventId,
            state: "synced",
            lastWrittenFingerprint: fp,
            lastWrittenAt: now,
            userNotes: op.op === "preserve_notes_update" ? op.userNotes : null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: calendarEventLinks.workoutId,
            set: {
              lastWrittenFingerprint: fp,
              lastWrittenAt: now,
              state: "synced",
              userNotes: op.op === "preserve_notes_update" ? op.userNotes : undefined,
              updatedAt: now,
            },
          });
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
        const zoned = localClockFormat(prefs.timezone).formatToParts(local);
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

/** One formatter per zone for the moves' local clock: building one costs far more than using it, and a run can
 * adopt many moves. */
const clockFormats = new Map<string, Intl.DateTimeFormat>();
function localClockFormat(timezone: string): Intl.DateTimeFormat {
  let format = clockFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    clockFormats.set(timezone, format);
  }
  return format;
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
 *     the row is already linked to an event that is still there. Only an
 *     event stamped with THIS app's origin qualifies, or an unstamped one the
 *     file itself already linked (B10, M7): the same ids in another
 *     deployment's events (a local stack restoring prod's file into prod's
 *     calendar) are that deployment's, and adopting them would let the
 *     ordinary path delete an archived row's event it never wrote. Without this
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
    appUrl: string;
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
  const origin = appOrigin(input.appUrl);
  const linkedInFile = new Set(input.links.map((l) => l.eventId));
  const ours = (e: RawGoogleEvent): boolean => {
    const stamped = originFromEvent(e.extendedProperties);
    return stamped === undefined ? linkedInFile.has(e.id) : origin !== undefined && stamped === origin;
  };
  const eventByWorkout = new Map<string, RawGoogleEvent>();
  for (const e of input.items) {
    const wid = workoutIdFromEvent(e.extendedProperties);
    if (wid && liveEvent(e) && ours(e) && !eventByWorkout.has(wid)) eventByWorkout.set(wid, e);
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

  // A link the file holds to an event stamped by ANOTHER app (m2) is not
  // this app's to keep: left in place, the ordinary pass — which does not
  // see that event — would read it as deleted by the athlete and suppress
  // the session for good, or delete that app's event for an archived row.
  // Dropped, the session gets its own event.
  const foreignIds = new Set(
    input.items
      .filter((e) => {
        const stamped = originFromEvent(e.extendedProperties);
        return stamped !== undefined && stamped !== origin;
      })
      .map((e) => e.id),
  );
  for (const l of input.links) {
    if (!foreignIds.has(l.eventId)) continue;
    await db.delete(calendarEventLinks).where(eq(calendarEventLinks.id, l.id));
    input.stats.recreated = (input.stats.recreated ?? 0) + 1;
  }
  const kept = input.links.filter((l) => !foreignIds.has(l.eventId));

  // (b)
  const deletedInFile = new Set(
    input.suppressions
      .filter((s) => s.reason === "user_deleted" && (!input.restoreFinishedAt || s.createdAt <= input.restoreFinishedAt))
      .map((s) => s.workoutId),
  );
  const linkBy = new Map(kept.map((l) => [l.workoutId, l]));
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
 * deployment writing into the same calendar. At most `cap` (at most
 * POST_RESTORE_DELETE_CAP, less what the run's ordinary ops spent of
 * CALENDAR_OPS_PER_RUN) deletions per sync; returns true once none remain.
 */
async function sweepOrphans(
  db: Db,
  client: GoogleCalendarClient,
  calendarId: string,
  appUrl: string,
  items: RawGoogleEvent[],
  stats: CalendarSyncStats,
  cap: number,
): Promise<boolean> {
  const origin = appOrigin(appUrl);
  if (!origin) return true;
  const stamped = items.filter(
    (e) => liveEvent(e) && originFromEvent(e.extendedProperties) === origin && workoutIdFromEvent(e.extendedProperties),
  );
  const named = await workoutIdsWithRows(db, stamped.map((e) => workoutIdFromEvent(e.extendedProperties)!));
  const orphans = stamped.filter((e) => !named.has(workoutIdFromEvent(e.extendedProperties)!));
  for (const e of orphans.slice(0, cap)) {
    try {
      await client.deleteEvent(calendarId, e.id);
      stats.deleted += 1;
      stats.orphansDeleted = (stats.orphansDeleted ?? 0) + 1;
    } catch {
      stats.opErrors = (stats.opErrors ?? 0) + 1;
      return false; // tried again on the next full read
    }
  }
  return orphans.length <= cap;
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
