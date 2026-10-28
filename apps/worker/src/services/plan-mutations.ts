import { and, eq, inArray, isNull, notInArray, type SQL } from "drizzle-orm";
import { calendarEventSuppressions, corosWriteJobs, plannedWorkouts, scheduleOverrides } from "@rg/database";
import { appAuthoredRow, docOriginRow, newId, watchAddressOf, type ArchiveReason, type UserPreferences } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";
import { recordedStampFor } from "./coros-stamp.js";
import { openIntentFor, recordIntent, resolveIntent, type IntentSource } from "./sync-intents.js";
import { unpushBuild } from "./watch-push.js";
import { sentBuildIdOf } from "./session-build.js";
import { markMirrorOwed } from "./mirror-owed.js";
import { FROZEN_STATES, reopenedDocColumns } from "./workout-doc-store.js";

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
 * `settleWatchJobsOnArchive` for many rows at once, as statements for the caller's batch (§8 §4: a plan's archive
 * slice settles its rows' queued writes in the same batch that archives them) — one per 90 rows.
 */
export function settleWatchJobsOnArchiveStatements(db: Db, userId: string, workoutIds: readonly string[], now: string) {
  return chunkIds([...workoutIds]).map((ids) =>
    db
      .update(corosWriteJobs)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(corosWriteJobs.userId, userId),
          inArray(corosWriteJobs.workoutId, ids),
          eq(corosWriteJobs.status, "queued"),
          inArray(corosWriteJobs.kind, [...WATCH_PLACING_KINDS]),
        ),
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
 * without resurrecting it into the visible plan — unless a revise adopted it
 * (workout-editability §4): its old copy is then the row's, and comes off
 * (`adoptedCopyUnpush`). No-op (removed: false) for a
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
  prefs: Pick<UserPreferences, "corosWritesEnabled">,
  opts: {
    /** The row's sent build when the caller has read it (the mirror, with its own jobs read); read here otherwise. */
    sent?: string | null;
    /**
     * False: no `<id>-unpush` by the row's address and recorded stamp — the mirror's previous-copy delete is the adopted
     * copy's and the sent build's only. A copy whose build lost its sent mark already has its `unpush:<buildId>` (taken
     * off, owed and run, or deleted when the change was made), and a second delete of it would only spend that id.
     */
    addressPath?: boolean;
  } = {},
): Promise<void> {
  // AN ADOPTED ROW'S OLD COPY comes off (workout-editability §4): the copy it held when a revise took it over, beside —
  // never instead of — a build it has sent since. That old copy is the very one the stamp path below would address for
  // an adopted coach session (its recorded stamp is the name it is held under), so with it queued the stamp path is not
  // taken: one copy, one delete.
  const copy = adoptedCopyUnpush(db, userId, w, now, prefs);
  if (copy) await copy.insert;
  // A SENT PROGRAMME SLOT comes off through its sent build's unpush (`unpush:<buildId>`), writes on or off — the job
  // Take off and a move queue, and the one the client's targeted drain runs in a request of its own (ruling 3-R11,
  // re-review 3-B NEW-1). The address path below queued `<id>-unpush`, which that drain does not take, so a removed
  // copy waited for the hourly lane. Writes off: the unpush is recorded as owed on the sent build, as a Take off or a
  // move with writes off records it, and `runOwedUnpushes` queues it when writes come back on (re-review C-3a).
  const sent = appAuthoredRow(w) ? (opts.sent !== undefined ? opts.sent : await sentBuildIdOf(db, w.id)) : null;
  if (sent) {
    await unpushBuild(db, userId, w, sent, now, prefs);
    return;
  }
  if (copy || opts.addressPath === false) return;
  // (A coach row has no build to owe it on; that gap is older than this and stays as it was.)
  const unpush = await unpushInsertIfOurs(db, userId, w, now, prefs);
  if (unpush) await unpush.insert;
}

/** The one delete of an adopted row's old copy (`adoptedCopyUnpush`): its id, which the import reads as "in flight". */
export const ADOPTED_COPY_JOB_SUFFIX = "-unpush-copy";
export const adoptedCopyJobId = (workoutId: string): string => `${workoutId}${ADOPTED_COPY_JOB_SUFFIX}`;

/**
 * THE OLD COPY AN ADOPTED ROW HOLDS (workout-editability spec §4): a revise that took over a coach session or a
 * COROS-plan session kept its watch address and recorded the program name the watch holds the copy under
 * (`watch_copy_name`). That copy is the row's to take off — the Studio's Send replaces it, Remove and a plan archive
 * remove it — by the same stamp-checked delete the coach lane uses for its own sessions, addressed where the row
 * records it and proven by that name (for an imported session no stamp of ours proves it: its wire title does, which
 * is what the name holds). Its insert, as a statement for the caller (`{ insert }`, as `unpushInsertIfOurs` answers),
 * or null when there is nothing to take off: not an app-authored row, no name held, no address — or the athlete's
 * COROS writes off. Then nothing is queued and nothing is owed: the name stays on the row, so the copy stays accounted
 * for (the row reads older on watch) until the watch-sync project takes it off. No read: the row carries all of it.
 * The verified delete clears the name (`coros-write-cloud.ts`).
 */
export function adoptedCopyUnpush(
  db: Db,
  userId: string,
  row: typeof plannedWorkouts.$inferSelect,
  now: string,
  prefs: Pick<UserPreferences, "corosWritesEnabled">,
) {
  if (!prefs.corosWritesEnabled || !appAuthoredRow(row) || !row.watchCopyName) return null;
  const address = watchAddressOf(row);
  if (!address) return null;
  const insert = db
    .insert(corosWriteJobs)
    .values({
      id: adoptedCopyJobId(row.id),
      userId,
      workoutId: row.id,
      kind: "coach_delete_workout",
      expectedContentFingerprint: "",
      originalDate: row.effectiveDate,
      destinationDate: row.effectiveDate,
      payload: {
        workoutId: row.id,
        happenDay: address.happenDay,
        name: row.watchCopyName,
        idInPlan: address.idInPlan,
        programId: address.programId,
        corosPlanId: address.corosPlanId,
      },
      requestedAt: now,
      status: "queued",
      updatedAt: now,
    })
    .onConflictDoNothing();
  return { insert };
}

/**
 * `enqueueUnpushIfOurs`' own path for a row the app pushed (not a sent programme slot): its reads now, its job's insert
 * as a statement for the caller's batch (`{ insert }` — a bare query builder would run as the promise resolved) — or
 * null when there is nothing to take off (writes off, no address, no stamp).
 * A plan's archive slice (§8 §4; review-1) puts it in the batch that archives the row, so a request that dies between
 * the two never leaves a delete queued for a session still on the plan.
 */
export async function unpushInsertIfOurs(
  db: Db,
  userId: string,
  w: typeof plannedWorkouts.$inferSelect,
  now: string,
  prefs: Pick<UserPreferences, "corosWritesEnabled">,
) {
  if (!prefs.corosWritesEnabled) return null;
  // ADDRESS, NOT SYNC STATE. This gate used to read `corosSyncState !==
  // "synced"`, and that column is not a statement about whether COROS holds
  // the row — it is a statement about whether the two agree. An eased session
  // is `calendar_only` (correctly: COROS has the OLD body) while still sitting
  // on the athlete's watch, so archiving one skipped the unpush and left the
  // pre-ease intervals scheduled on the watch permanently, inside the very
  // code path that exists to stop exactly that (audit#3 D2). `content_stale`
  // and `sync_issue` had the same hole. The address is the durable fact.
  const address = watchAddressOf(w);
  if (!address) return null;
  // The delete triple's stamp is the exact program name we last wrote, which
  // is never persisted on the row — read it back off this account's own
  // settled write jobs (a rewrite renames, so the newest one wins).
  const stamp = await recordedStampFor(db, userId, w.id);
  if (!stamp) return null;
  const [createJob] = await db
    .select({ expectedContentFingerprint: corosWriteJobs.expectedContentFingerprint })
    .from(corosWriteJobs)
    .where(eq(corosWriteJobs.id, `${w.id}-push`))
    .limit(1);
  const insert = db
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
  return { insert };
}

/**
 * SKIP A SESSION — the one writer of a skip, the Plan's and the coach's alike (the watch mirrors the plan §3.4; owner
 * §10.2: "if I skip it it should remove it"). The row is resolved `skipped` on `today` — only a session still to resolve
 * (scheduled, or unresolved: the Plan's "did this happen? — Skip it"), never one done, skipped or missed already, nor one
 * removed — and the coach's skip is sanctioned (`sanctionedBy`: the garden reads it as agreed rest). Then, for a session
 * the app built whose day is today or ahead, its copy comes off the watch, even ahead of its day (`enqueueUnpushIfOurs`:
 * the adopted row's held copy, the sent build's unpush — or, for a push still queued, its supersede — never the address
 * path): the cheap writes alone (M2). A day gone (the Plan's "did this happen? — Skip it") leaves its copy: the watch's
 * history, as a missed session's is. With the athlete's COROS writes off the delete is owed on the sent build and runs when they come back on. A
 * session the app did not build (the coach's own, a COROS-plan import) keeps its lane: nothing more. `source` says who
 * skipped (the Plan, the coach), as `unskipWorkout`'s does. `skipped`: whether the row was skipped now. Statements: the
 * write; for an app-built session, its delete at its most — the held copy's insert, its sent build found (two), the push
 * superseded and read, the unpush queued (two) and the build unlocked (8: design-approve.ts `SKIP_UNPUSH_COST`).
 */
export async function skipWorkout(
  db: Db,
  userId: string,
  workoutId: string,
  opts: { now: string; today: string; source: "app" | "coach"; sanctionedBy?: "coach"; prefs: Pick<UserPreferences, "corosWritesEnabled"> },
): Promise<{ skipped: boolean }> {
  const [w] = await db
    .update(plannedWorkouts)
    .set({ completionState: "skipped", resolutionDate: opts.today, ...(opts.sanctionedBy ? { sanctionedBy: opts.sanctionedBy } : {}), updatedAt: opts.now })
    .where(
      and(
        eq(plannedWorkouts.id, workoutId),
        eq(plannedWorkouts.userId, userId),
        isNull(plannedWorkouts.archivedAt),
        notInArray(plannedWorkouts.completionState, [...FROZEN_STATES]),
      ),
    )
    .returning();
  if (!w) return { skipped: false };
  // The row as written: its address and copy name are as they were (a skip touches neither), and `unpushBuild` keeps
  // only a done session's copy.
  if (appAuthoredRow(w) && w.effectiveDate >= opts.today) await enqueueUnpushIfOurs(db, userId, w, opts.now, opts.prefs, { addressPath: false });
  return { skipped: true };
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
 * resimulates from it so the garden forgets the miss. A document workout whose
 * day is `today` or ahead is marked owed for the watch (the watch mirrors the
 * plan §3.4: the skip took its copy off, and the drain or the sweep puts it
 * back) — one statement more.
 */
export async function unskipWorkout(
  db: Db,
  userId: string,
  workoutId: string,
  opts: { now: string; today: string; source: "app" | "coach" },
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
  // rest day that is no longer being taken. The workout document, kept as it
  // was while skipped, is derived again from the row (`reopenedDocColumns`).
  await db
    .update(plannedWorkouts)
    .set({ completionState: "scheduled", resolutionDate: null, sanctionedBy: null, ...reopenedDocColumns(), updatedAt: now })
    .where(and(eq(plannedWorkouts.id, w.id), eq(plannedWorkouts.userId, userId)));
  await db.insert(scheduleOverrides).values({
    id: newId(),
    workoutId: w.id,
    kind: "restore",
    fromDate: resolvedOn,
    source: opts.source,
    createdAt: now,
  });
  if (docOriginRow(w) && w.effectiveDate >= opts.today) await markMirrorOwed(db, userId, w.id, now);
  return { restored: true, resolvedOn };
}
