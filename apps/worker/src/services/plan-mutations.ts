import { and, eq, inArray, type SQL } from "drizzle-orm";
import { calendarEventSuppressions, corosWriteJobs, plannedWorkouts, scheduleOverrides } from "@rg/database";
import { newId, watchAddressOf, type ArchiveReason, type UserPreferences } from "@rg/domain";
import type { Db } from "./db.js";
import { recordedStampFor } from "./coros-stamp.js";
import { openIntentFor, recordIntent, resolveIntent, type IntentSource } from "./sync-intents.js";

/**
 * The athlete's own plan mutations, as services — so the coach's ops and the
 * manual routes cannot drift apart on side effects (suppression, intent
 * ledger, unpush). Routes add their own calendar sync / resimulation.
 */

export interface RemoveResult {
  removed: boolean;
  effectiveDate: string | null;
}

/**
 * The job kinds that would still PUT this session on the watch (or rewrite or
 * re-date it there) once they run. A removal is not among them: a queued unpush
 * is the archive's own aftermath, never a competing claim.
 */
const WATCH_PLACING_KINDS = [
  "coach_create_workout",
  "move_scheduled_workout",
  "coach_update_workout",
  // A sent program session (Phase 3): a queued push of a removed slot never runs.
  "program_session_push",
] as const;

/**
 * AN ARCHIVED ROW'S QUEUED WATCH WRITES ARE SETTLED, NOT LEFT TO RUN (audit 1,
 * coach finding 1).
 *
 * An approve drains three writes and the hourly cron three more, so a session
 * removed while its create was still queued used to be created on the watch
 * anyway — and nothing ever unpushed an archived row afterwards. The watch kept
 * a session the app no longer shows. The same held for a queued move (it
 * re-dated the session the unpush was aimed at) and a queued content rewrite.
 *
 * QUEUED only. A claimed job is mid-flight under the executor's lock, and
 * flipping its status here would be overwritten by the executor's own verdict a
 * moment later; the executor re-reads the row instead (`coros-write-cloud.ts`),
 * and the unpush addresses the session where COROS holds it when the delete runs.
 *
 * Cancelling a create that never ran is not a watch removal: the session was
 * never on the watch. Idempotent — a second call finds nothing queued.
 */
export async function settleWatchJobsOnArchive(
  db: Db,
  userId: string,
  workoutId: string,
  now: string,
): Promise<void> {
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: now })
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        eq(corosWriteJobs.workoutId, workoutId),
        eq(corosWriteJobs.status, "queued"),
        inArray(corosWriteJobs.kind, [...WATCH_PLACING_KINDS]),
      ),
    );
}

/**
 * Remove a workout from the plan: archived locally, calendar event suppressed,
 * its queued watch writes settled — and, for a session the APP pushed (a
 * verified create stamp plus a COROS address), an unpush so the watch follows
 * the plan (Ruling A1, option b: the athlete's remove and the coach's are one
 * mutation, on the watch too). An IMPORTED COROS session is never touched on
 * the watch: it has no stamp, so `enqueueUnpushIfOurs` declines, and the
 * archived row keeps its sourceWorkoutId so future imports update it in place
 * without resurrecting it into the visible plan. No-op (removed: false) for a
 * missing, foreign or already-archived row.
 *
 * `archiveReason` records WHY the row left (default `user_removed`, a hand
 * removal). An adaptive program's re-placement passes `program_replaced`; the
 * calendar suppression stays `user_removed` either way, because what it
 * instructs is the same: the app took this session off the plan, and nothing an
 * import observes brings it back.
 *
 * `onlyIf` (optional) is a condition the row must still meet AS IT IS ARCHIVED:
 * it joins the archive's UPDATE … WHERE, and when no row changed nothing else
 * happens (removed: false). An adaptive program's re-placement passes its
 * "still flexible" rule, so a slot the athlete moved or touched between the
 * pass's read and this write stays (audit 2a-model M4). Without it the archive
 * is exactly as it always was.
 */
export async function removeFromPlan(
  db: Db,
  userId: string,
  workoutId: string,
  opts: { now: string; source: IntentSource; prefs: UserPreferences; archiveReason?: ArchiveReason; onlyIf?: SQL },
): Promise<RemoveResult> {
  const [w] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!w || w.archivedAt) return { removed: false, effectiveDate: null };
  const { now } = opts;
  const archive = db
    .update(plannedWorkouts)
    .set({ archivedAt: now, updatedAt: now, archiveReason: opts.archiveReason ?? "user_removed" });
  if (opts.onlyIf) {
    const archived = await archive
      .where(and(eq(plannedWorkouts.id, w.id), opts.onlyIf))
      .returning({ id: plannedWorkouts.id });
    if (archived.length === 0) return { removed: false, effectiveDate: null };
  } else {
    await archive.where(eq(plannedWorkouts.id, w.id));
  }
  await settleWatchJobsOnArchive(db, userId, w.id, now);
  await db.insert(calendarEventSuppressions).values({
    id: newId(),
    workoutId: w.id,
    eventId: null,
    // "user_removed" (not the absence-detector's "workout_removed"): a hand
    // removal is a decision, and import's presence-healing must never undo it.
    reason: "user_removed",
    createdAt: now,
  });
  await recordIntent(db, {
    userId,
    targetKind: "workout",
    targetId: w.id,
    kind: "remove_local",
    source: opts.source,
  });
  // Close out any open move intent for this workout too — once it's removed
  // from the plan there's nothing left to sync, and leaving the move intent
  // open behind an archived workout would strand a permanent, uncloseable
  // sync_issue (emitPendingWork resolves it too, but this closes the gap
  // immediately rather than waiting for the next bridge sync).
  const openMove = await openIntentFor(db, userId, w.id, "move");
  if (openMove) await resolveIntent(db, openMove.id, now);
  // Last, from the row as it stood BEFORE the archive: its address is where
  // COROS holds the session. Declines for anything the app did not push.
  await enqueueUnpushIfOurs(db, userId, w, now, opts.prefs);
  return { removed: true, effectiveDate: w.effectiveDate };
}

/**
 * The unpush half of an archive: verified watch-pushed sessions get a delete
 * job so the watch stops scheduling the retired session.
 */
export async function enqueueUnpushIfOurs(
  db: Db,
  userId: string,
  w: typeof plannedWorkouts.$inferSelect,
  now: string,
  prefs: UserPreferences,
): Promise<void> {
  if (!prefs.corosWritesEnabled) return;
  // ADDRESS, NOT SYNC STATE. This gate used to read `corosSyncState !==
  // "synced"`, and that column is not a statement about whether COROS holds
  // the row — it is a statement about whether the two agree. An eased session
  // is `calendar_only` (correctly: COROS has the OLD body) while still sitting
  // on the athlete's watch, so archiving one skipped the unpush and left the
  // pre-ease intervals scheduled on the watch permanently, inside the very
  // code path that exists to stop exactly that (audit#3 D2). `content_stale`
  // and `sync_issue` had the same hole. The address is the durable fact.
  const address = watchAddressOf(w);
  if (!address) return;
  // The delete triple's stamp is the exact program name we last wrote, which
  // is never persisted on the row — read it back off this account's own
  // settled write jobs (a rewrite renames, so the newest one wins).
  const stamp = await recordedStampFor(db, userId, w.id);
  if (!stamp) return;
  const [createJob] = await db
    .select({ expectedContentFingerprint: corosWriteJobs.expectedContentFingerprint })
    .from(corosWriteJobs)
    .where(eq(corosWriteJobs.id, `${w.id}-push`))
    .limit(1);
  await db
    .insert(corosWriteJobs)
    .values({
      id: `${w.id}-unpush`,
      userId,
      workoutId: w.id,
      kind: "coach_delete_workout",
      expectedContentFingerprint: createJob?.expectedContentFingerprint ?? "",
      originalDate: w.effectiveDate,
      destinationDate: w.effectiveDate,
      payload: {
        workoutId: w.id,
        happenDay: address.happenDay,
        name: stamp,
        idInPlan: address.idInPlan,
        programId: address.programId,
        corosPlanId: address.corosPlanId,
      },
      requestedAt: now,
      status: "queued",
      updatedAt: now,
    })
    .onConflictDoNothing();
}

export interface UnskipResult {
  restored: boolean;
  resolvedOn: string | null;
  reason?: "not_found" | "not_skipped";
}

/**
 * Reverse a skip: only valid while still `skipped` (a completed/matched
 * workout has moved on and isn't "un-skippable"). Back to scheduled, the
 * skip's resolutionDate and sanction cleared, and a `restore` override
 * recorded. `resolvedOn` is the date the skip fed the garden sim — the caller
 * resimulates from it so the garden forgets the miss.
 */
export async function unskipWorkout(
  db: Db,
  userId: string,
  workoutId: string,
  opts: { now: string; source: "app" | "coach" },
): Promise<UnskipResult> {
  const [w] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!w) return { restored: false, resolvedOn: null, reason: "not_found" };
  if (w.completionState !== "skipped") return { restored: false, resolvedOn: null, reason: "not_skipped" };
  const { now } = opts;
  // THE DAY THE SKIP COUNTED ON: the later of the session's date and its
  // resolution date — the same expression as garden-sync's
  // `resolutionLandedOn`, which is what fed the miss into the sim (audit 1,
  // coach finding 8). The resolution date alone reached back weeks for a
  // session skipped early, replaying days no skip ever touched.
  const resolvedOn =
    w.resolutionDate && w.resolutionDate > w.effectiveDate ? w.resolutionDate : w.effectiveDate;
  // `sanctionedBy` clears with the skip: the garden's mercy was granted for a
  // rest day that is no longer being taken.
  await db
    .update(plannedWorkouts)
    .set({ completionState: "scheduled", resolutionDate: null, sanctionedBy: null, updatedAt: now })
    .where(and(eq(plannedWorkouts.id, w.id), eq(plannedWorkouts.userId, userId)));
  await db.insert(scheduleOverrides).values({
    id: newId(),
    workoutId: w.id,
    kind: "restore",
    fromDate: resolvedOn,
    source: opts.source,
    createdAt: now,
  });
  return { restored: true, resolvedOn };
}
