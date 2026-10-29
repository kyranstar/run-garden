/**
 * THE WATCH MIRRORS THE PLAN (design 2026-10-28-watch-mirrors-the-plan §3.2, §3.7; builder check A5, A6, A7, M2, M3).
 *
 * A document workout (`studio`, `template`, adopted) inside the window — today … today + MIRROR_WINDOW_DAYS — is on the
 * watch as a PROVISIONAL COPY: a record of the document materialised as the sheet's preview is (a negative version,
 * never locked: `prepareProvisionalRecord`) and its `program_session_push`, `provisional: true`, carrying the document
 * revision it was made from (`fromDocRev`). One copy per session: the previous copy's delete is queued before the push
 * (`enqueueUnpushIfOurs`: the adopted row's held copy, the sent build's `unpush:<id>`); either order of landing is safe
 * (A6), because the old copy's stamp stays claimed by its verified push until its delete verifies.
 *
 * WHERE THE WORK IS DONE (M2). A change to a session does only cheap writes — supersede, the old copy's delete, and
 * `markMirrorOwed` (one row in `sync_intents`, kind `mirror`) — and the drain or the sweep makes the record and its
 * payload (`queueProvisionalPush`), so approve, Studio save, calendar drags and switch-on keep their budgets.
 *
 * THE SWEEP (§3.7, A5) is the hourly's one heavy step: one record a run, the owed sessions first, then the window's,
 * soonest day first, for each the current-copy test (`currentCopy`, A7). A push that failed for good is re-queued on
 * MIRROR_RETRY_BACKOFF_MS, three times at most (M3). A replaced copy left on the watch — its delete failed for good, or
 * neutralised by a restore — has that delete queued again on the same ladder (`strandedCopyOf`, final review
 * Important 1), so one copy per session holds after a COROS outage too. Writes off (`prefs.corosWritesEnabled`) or the switch off
 * (`WATCH_PUSH_ENABLED`): nothing is read and nothing is queued; the owed marks stay open, so the sweep catches up when
 * they come back on.
 *
 * TODAY'S PROVISIONAL PUSH (M1): a session of today whose pre-check is answered is never sent a provisional copy — an
 * ungated one, where the day's reading may close a move — and waits for the day's gated build, which `mirrorOnDayBuild`
 * pushes on the next build (the sheet's open, Start); with no answer yet, the provisional copy goes as for any day.
 *
 * ON THE DAY (§3.3; owner §10.1; builder check A3, M1) the copy follows the day's build (`mirrorOnDayBuild`, called by
 * the build commit once a day's build is stored or found current): its watch steps compared with the copy's — the same
 * → handed over in D1 (no COROS write); different → the copy's delete and the build's push; blocked → the copy stays —
 * and every later change on the day replaces it again. An engine slot, which has no provisional copy, is pushed then.
 *
 * Every write here is a no-op during a restore (B2): `restoreInProgress` before the record (the sweep reads it with its
 * candidates, at its start, as the lane does a run), and the owed marks are resolved by an UPDATE that itself refuses
 * while a restore runs; a day's build is locked by an UPDATE that refuses while one runs (`lockForWatch`) before
 * anything else is written.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { accountState, corosWriteJobs, plannedWorkouts, sessionBuilds, syncIntents } from "@rg/database";
import {
  addDays,
  docOriginRow,
  DOC_ORIGINS,
  isRunDoc,
  parseStoredWorkoutDoc,
  programSessionPushJobSchema,
  STAMPING_JOB_KINDS,
  watchAddressOf,
  type ProgramSessionPushJob,
  type ProgramWatchStep,
  type WatchAddressFields,
} from "@rg/domain";
import { watchPushEnabled, type Env } from "../env.js";
import type { Db } from "./db.js";
import { restoreInProgress } from "./account-state.js";
import { SPENT_STAMP_STATUSES } from "./coros-stamp.js";
import { enqueueUnpushIfOurs } from "./plan-mutations.js";
import { mirrorIntentId } from "./mirror-owed.js";
import {
  dayRowRefusal,
  errorsGaveUp,
  memoryFor,
  memoryOf,
  MIRROR_RETRY_BACKOFF_MS,
  MIRROR_WINDOW_DAYS,
  pushOfRowNow,
  requeuesLeft,
  rowRefusal,
  type MirrorMemory,
  type MirrorRow as RulesRow,
} from "./mirror-rules.js";
import {
  activeProfilesOf,
  checksAnswered,
  DocTooLargeRefusal,
  isProvisionalBuild,
  lockForWatch,
  lockRefusal,
  pickSentBuild,
  prepareProvisionalRecord,
  provisionalRecord,
  pushJobId,
  slotPrechecked,
  type BuildCtx,
  type StoredBuild,
} from "./session-build.js";
import {
  NO_CATALOG,
  pushPayloadFor,
  queuePushJob,
  queueUnpush,
  unlockSentBuild,
  unpushJobId,
  watchStepsAsSent,
  watchStepsFromBuild,
  type PushableBuild,
} from "./watch-push.js";

// The owed mark lives in a leaf module (the hooks take it from there, mirror-owed.ts); the mirror's callers find it here.
export { markMirrorOwed, mirrorIntentId } from "./mirror-owed.js";

// The window and the row's own refusals live in a leaf (mirror-rules.ts): the sheet's watch state asks them too.
export { MIRROR_WINDOW_DAYS } from "./mirror-rules.js";

// The re-queue ladder (M3) and the memory of a row's refusals live in the leaf too: the sheet's watch state says whether
// the sweep will try again (`sweepRequeues`, `errorsGaveUp`) by the very rules it acts on.
export { MIRROR_RETRY_BACKOFF_MS } from "./mirror-rules.js";
export type { MirrorMemory } from "./mirror-rules.js";

export type MirrorSkip =
  | "switch_off"
  | "writes_off"
  | "kept_off"
  | "not_document"
  | "resolved"
  | "past"
  | "beyond_window"
  | "current"
  | "too_long"
  | "restoring"
  /** A failed push waiting out its backoff (M3). */
  | "backoff"
  /** A push that failed after its three re-queues: the mirror leaves it (the sheet's Retry stays the athlete's). */
  | "gave_up"
  /** The build's own push is on its way or verified already (`queueReplacement`): nothing to queue. */
  | "already_pushed"
  /** Preparing the copy threw: remembered on the backoff ladder, so it never stalls the account. */
  | "error"
  /** A session of today whose pre-check is answered: the day's gated build is its copy, on its next build (M1). */
  | "today_checked"
  // ── On the day (`mirrorOnDayBuild`, `queueReplacement` of a day's build) ──
  /** A day's build of a row whose day is ahead. */
  | "not_today"
  /** A session the mirror does not hold on its day: not the app's, a run, a rest day, a race, or started at once (M5). */
  | "not_mirrored"
  /** Not the row's day build (a preview, a provisional record, another day's, another row's). */
  | "not_day_build"
  /** The day's pre-check is not answered yet: the copy stays as it is until it is. */
  | "precheck"
  /** The day's reading closes a move no alternate stands in for (`lockRefusal`): the copy stays (`queueReplacement`). */
  | "blocked"
  /** No longer the build the day shows, or the slot no longer holds it to be locked (`lockRefusal`, `lockForWatch`). */
  | "stale"
  /** The copy is on the wire this moment, with the same steps: handed over by the next build once it has verified. */
  | "in_flight";

export type MirrorAnswer = "queued" | `skipped:${MirrorSkip}`;

/** A row's `program_session_push`, as the current-copy test reads it (A7). */
export interface PushRow {
  id: string;
  status: string;
  /** The day the push puts its copy on. */
  happenDay: string;
  provisional: boolean;
  /** The document revision the pushed build was made from; null on a push that does not say (a Send's, an engine build's). */
  fromDocRev: number | null;
  verifiedAt: string | null;
  /** When the job last changed: for a failed push, when it failed. */
  updatedAt: string;
  /** The mirror's re-queues of it after it failed (M3). */
  retries: number;
  /** The import saw its copy changed in the COROS app (`noticed` on its payload, §3.8): the app's version goes back. */
  noticed?: boolean;
  /**
   * Its copy's delete (`unpush:<buildId>`) was requested after this push verified, and is not settled — on its way, run,
   * or given up: a changed copy whose delete is queued is the mirror's in hand (its replacement follows, or the delete
   * failed for good and the copy stays the athlete's, as the import told them), so it is not judged again. A delete of
   * an earlier copy of the same build (put back since, or taken off and sent again) is not this copy's.
   */
  unpushed?: boolean;
}

/** The row fields the current-copy test reads. */
export type MirrorRow = RulesRow;

// Spelled out, never derived from session-build.ts's constants at load: that module will import this one (Task 5), and
// a cycle can leave an imported constant uninitialised while this module loads.
const SETTLED = ["superseded", "cancelled", "restored"] as const;
const IN_FLIGHT = ["queued", "claimed", "in_progress", "verifying"] as const;
/** A push the mirror re-queues on its backoff (M3): failed for good, or neutralised by a restore (its stamp kept). */
const RETRYABLE = ["failed", "needs_attention", "restored"] as const;
const isOneOf = (list: readonly string[], status: string): boolean => list.includes(status);

/**
 * IS THE COPY ON THE WATCH THE SESSION AS IT STANDS? (A7) Pure. A push (not settled) for the row's document revision
 * and the row's day that is on its way, or verified — and not seen changed in the COROS app — with the row still holding
 * a COROS address on its day. So:
 *  - another revision → not current (the copy is the old one);
 *  - the same revision on another day (a move in the app) → not current: an in-flight push is for the old day, and a
 *    verified copy's address still names the old day until its delete verifies;
 *  - verified, but the address cleared (the import found the copy gone, §3.8) → not current, so it is pushed again;
 *  - verified, but changed in the COROS app (the import's `noticed`, §3.8) → not current, so the app's copy replaces it
 *    (its replacement on its way, or landed, is current; so is the changed copy once its delete is queued — a day
 *    build's copy is put back after its delete, under the same push, A6);
 *  - a copy moved in the COROS app that the row followed (the stamp keeps the old date, the address the new) → current.
 * A push that does not say its revision (a day's build sent before the mirror) is judged by its day alone. A day gone
 * owes no copy: current.
 */
export function currentCopy(row: Pick<MirrorRow, "effectiveDate" | "workoutDocRev"> & WatchAddressFields, pushes: readonly PushRow[], today: string): boolean {
  if (row.effectiveDate < today) return true;
  const address = watchAddressOf(row);
  return pushes.some((p) => {
    if (isOneOf(SETTLED, p.status)) return false;
    if (p.fromDocRev !== null && p.fromDocRev !== row.workoutDocRev) return false;
    if (isOneOf(IN_FLIGHT, p.status)) return p.happenDay === row.effectiveDate;
    return p.status === "verified" && (p.noticed !== true || p.unpushed === true) && address !== null && address.happenDay === row.effectiveDate;
  });
}

/** A restore is running for the account (`restoreInProgress`, in SQL). */
const restoring = (userId: string): SQL =>
  sql`exists (select 1 from ${accountState} where ${accountState.userId} = ${userId} and coalesce(${accountState.restoreId}, '') <> '')`;

/** No restore is running: the guard every owed-mark write carries in its own WHERE. */
const notRestoring = (userId: string): SQL => sql`not ${restoring(userId)}`;

/** Resolve these owed marks — only those marked before `now` (a later mark is a later change) — in one statement. */
async function resolveOwed(db: Db, userId: string, workoutIds: readonly string[], now: string): Promise<void> {
  if (workoutIds.length === 0) return;
  await db
    .update(syncIntents)
    .set({ resolvedAt: now })
    .where(
      and(
        inArray(syncIntents.id, workoutIds.map(mirrorIntentId)),
        eq(syncIntents.userId, userId),
        isNull(syncIntents.resolvedAt),
        lte(syncIntents.createdAt, now),
        notRestoring(userId),
      ),
    );
}

/** Resolve the workout's owed mark with what the mirror learned (`MirrorMemory`): an upsert, so a window row has one too. */
async function remember(db: Db, userId: string, workoutId: string, now: string, memory: MirrorMemory): Promise<void> {
  const payload = { ...memory } as Record<string, unknown>;
  await db
    .insert(syncIntents)
    .values({ id: mirrorIntentId(workoutId), userId, targetKind: "workout", targetId: workoutId, kind: "mirror", payload, source: "mirror", createdAt: now, resolvedAt: now })
    .onConflictDoUpdate({ target: syncIntents.id, set: { resolvedAt: now, payload }, setWhere: lte(syncIntents.createdAt, now) });
}

/** An unexpected throw while the copy was prepared, remembered: the next in a row counts up from the row's last one. */
function errorMemory(e: unknown, row: Pick<MirrorRow, "workoutDocRev" | "effectiveDate">, previous: MirrorMemory | null | undefined, now: string): MirrorMemory {
  const last = memoryFor(previous, row);
  const message = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 120);
  return { refused: "error", rev: row.workoutDocRev, day: row.effectiveDate, message, at: now, count: last?.refused === "error" ? (last.count ?? 1) + 1 : 1 };
}

// ── The jobs the mirror reads ────────────────────────────────────────────────────────────────────────────────────

/**
 * A stamping job, as the mirror reads it: a row's pushes for the current-copy test, a day's stamps for the new one, and —
 * for a program push — its build as `sentBuildIdOf` judges one (so the sent copy is known with no read of its own).
 */
export interface MirrorJob extends PushRow {
  workoutId: string;
  kind: string;
  name: string | null;
  /** The name the athlete gave the copy in the COROS app (`$.renamed`, the import's record): the name COROS holds it by. */
  renamed: string | null;
  /** For a program push, its copy's delete (`unpush:<buildId>`) if there is one — what `strandedCopyOf` reads. */
  copyDelete: CopyDelete | null;
  /** The pushed build: its version, lock, provisional mark and day; null when it is not a program push's, or gone. */
  build: { version: number; lockedAt: string | null; marked: boolean; date: string | null } | null;
  /** The job's payload, when the read asked for it (`mirrorJobs`' `payloads`: the day's comparison reads the copy's). */
  payload?: unknown;
}

/** A program push's own delete (`unpush:<buildId>`), as the stranded-copy rule reads it (`strandedCopyOf`). */
export interface CopyDelete {
  status: string;
  requestedAt: string;
  /** When the job last changed: for a failed delete, when it failed. */
  updatedAt: string;
  /** Why it failed (`last_error_category`): a bare `error` is transient, a refusal is the lane's verdict. */
  error: string | null;
  /** The sweep's re-queues of it (`$.mirrorRetries`). */
  retries: number;
  /** The day the copy it deletes sits on. */
  happenDay: string;
}

const payloadField = <T>(path: string) => sql<T>`json_extract(${corosWriteJobs.payload}, ${path})`;

/**
 * The length of `push:` (`pushJobId`), which `unpush:` replaces: a push's job id to its build id. Spelled out, never
 * called at load: session-build.ts imports this module, and the cycle can leave its export unset while this one loads.
 */
const PUSH_PREFIX = "push:".length;

/** In SQL, for a program push (its job id): its copy's delete as `CopyDelete`'s JSON, or null — one sub-select. */
const copyDeleteOf = (pushId: SQL): SQL =>
  sql`(select json_object('status', d.status, 'requestedAt', d.requested_at, 'updatedAt', d.updated_at, 'error', d.last_error_category,
    'retries', json_extract(d.payload, '$.mirrorRetries'), 'happenDay', json_extract(d.payload, '$.happenDay'))
    from coros_write_jobs as d where d.id = 'unpush:' || substr(${pushId}, ${PUSH_PREFIX + 1}))`;

function parseCopyDelete(raw: unknown): CopyDelete | null {
  const v = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | null;
  if (!v || typeof v.status !== "string") return null;
  return {
    status: v.status,
    requestedAt: typeof v.requestedAt === "string" ? v.requestedAt : "",
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
    error: typeof v.error === "string" ? v.error : null,
    retries: typeof v.retries === "number" ? v.retries : 0,
    happenDay: typeof v.happenDay === "string" ? v.happenDay : "",
  };
}

/**
 * In SQL, for a push (`push:<buildId>`, its job id and verification time): its copy's delete (`unpush:<buildId>`) was
 * requested since the push verified — this copy's, not an earlier copy's of the same build — and is not settled.
 */
const unpushQueued = (pushId: SQL, pushVerifiedAt: SQL): SQL =>
  sql`exists (select 1 from coros_write_jobs as unpush where unpush.id = 'unpush:' || substr(${pushId}, ${pushJobId("").length + 1})
    and unpush.requested_at >= ${pushVerifiedAt} and unpush.status not in (${sql.join(SETTLED.map((x) => sql`${x}`), sql`, `)}))`;

/**
 * ONE READ for the current-copy test, the sent copy and the new copy's stamp: every stamping job of the account (both
 * lanes) whose stamp is not spent (`takenStampsOn`'s rule), within `scope` — the row's own pushes, and the jobs on the days
 * a new copy may take a stamp on — each program push beside its build (`push:<buildId>`).
 */
async function mirrorJobs(db: Db, userId: string, scope: SQL, opts: { payloads?: boolean } = {}): Promise<MirrorJob[]> {
  const sb = sessionBuilds;
  const rows = await db
    .select({
      id: corosWriteJobs.id,
      payload: opts.payloads ? sql<unknown>`${corosWriteJobs.payload}` : sql<unknown>`null`,
      workoutId: corosWriteJobs.workoutId,
      kind: corosWriteJobs.kind,
      status: corosWriteJobs.status,
      happenDay: payloadField<string | null>("$.happenDay"),
      name: payloadField<string | null>("$.name"),
      renamed: payloadField<string | null>("$.renamed"),
      copyDelete: sql<string | null>`case when ${corosWriteJobs.kind} = 'program_session_push' then ${copyDeleteOf(sql`${corosWriteJobs.id}`)} end`,
      provisional: payloadField<number | null>("$.provisional"),
      fromDocRev: payloadField<number | null>("$.fromDocRev"),
      retries: payloadField<number | null>("$.mirrorRetries"),
      noticed: sql<number>`json_extract(${corosWriteJobs.payload}, '$.noticed') is not null`,
      unpushed: sql<number>`${unpushQueued(sql`${corosWriteJobs.id}`, sql`${corosWriteJobs.verifiedAt}`)}`,
      verifiedAt: corosWriteJobs.verifiedAt,
      updatedAt: corosWriteJobs.updatedAt,
      buildId: sb.id,
      buildVersion: sb.version,
      buildLockedAt: sb.lockedAt,
      buildMarked: sql<number | null>`${provisionalRecord()}`,
      buildDate: sql<string | null>`json_extract(${sb.payload}, '$.build.date')`,
    })
    .from(corosWriteJobs)
    .leftJoin(sb, and(eq(corosWriteJobs.kind, "program_session_push"), eq(sb.id, sql`substr(${corosWriteJobs.id}, ${pushJobId("").length + 1})`)))
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.kind, [...STAMPING_JOB_KINDS]),
        notInArray(corosWriteJobs.status, [...SPENT_STAMP_STATUSES]),
        scope,
      ),
    );
  return rows.map(({ buildId, buildVersion, buildLockedAt, buildMarked, buildDate, payload, copyDelete, ...r }) => ({
    ...r,
    ...(opts.payloads ? { payload: typeof payload === "string" ? JSON.parse(payload) : payload } : {}),
    renamed: typeof r.renamed === "string" ? r.renamed : null,
    copyDelete: copyDelete === null || copyDelete === undefined ? null : parseCopyDelete(copyDelete),
    happenDay: r.happenDay ?? "",
    provisional: Boolean(r.provisional),
    fromDocRev: typeof r.fromDocRev === "number" ? r.fromDocRev : null,
    retries: typeof r.retries === "number" ? r.retries : 0,
    noticed: Boolean(r.noticed),
    unpushed: Boolean(r.unpushed),
    build: buildId !== null && buildVersion !== null ? { version: buildVersion, lockedAt: buildLockedAt, marked: Boolean(buildMarked), date: buildDate } : null,
  }));
}

/** The row's own program pushes (a spent one is not read; `currentCopy` sets the settled ones aside). */
const pushesOf = (jobs: readonly MirrorJob[], workoutId: string): MirrorJob[] =>
  jobs.filter((j) => j.workoutId === workoutId && j.kind === "program_session_push");

/**
 * `sentBuildIdOf` from the jobs already read: the row's builds that are locked or provisional and whose push is live,
 * chosen by `pickSentBuild` — the same candidates and the same choice, no statement.
 */
function sentOf(jobs: readonly MirrorJob[], row: Pick<MirrorRow, "id" | "effectiveDate">): string | null {
  return pickSentBuild(
    pushesOf(jobs, row.id)
      .filter((j) => !isOneOf(SETTLED, j.status) && j.build !== null && (j.build.lockedAt !== null || j.build.marked))
      .map((j) => ({ id: j.id.slice(pushJobId("").length), version: j.build!.version, lockedAt: j.build!.lockedAt, date: j.build!.date, day: row.effectiveDate })),
  );
}

/** `takenStampsOn` from the jobs already read: the stamps held on `day`, `exceptId` aside. */
function takenOn(jobs: readonly MirrorJob[], day: string, exceptId: string): Set<string> {
  return new Set(jobs.filter((j) => j.happenDay === day && j.id !== exceptId && typeof j.name === "string").map((j) => j.name!));
}

// ── The verdict ──────────────────────────────────────────────────────────────────────────────────────────────────

type Verdict = { skip: MirrorSkip } | { retry: PushRow } | { push: true };

/**
 * What the mirror does for this row now, from the row, its pushes and its memory (pure): a refusal (a remembered error
 * only until its backoff is over); the re-queue of its failed push (M3: same revision and day, its backoff over, fewer
 * than three re-queues — a push a restore neutralised likewise, under the stamp it may have landed a copy with); or a new
 * copy.
 */
function verdictOf(row: MirrorRow, pushes: readonly PushRow[], env: Env, ctx: BuildCtx, memory: MirrorMemory | null): Verdict {
  const refused = rowRefusal(row, env, ctx);
  if (refused) return { skip: refused };
  if (currentCopy(row, pushes, ctx.today)) return { skip: "current" };
  const known = memoryFor(memory, row);
  if (known?.refused === "error") {
    // An error while the copy was prepared: tried again once its backoff is over; after three, left (`gave_up`).
    if (errorsGaveUp(known, row)) return { skip: "gave_up" };
    const wait = MIRROR_RETRY_BACKOFF_MS[(known.count ?? 1) - 1]!;
    if (Date.parse(known.at ?? "") + wait > Date.parse(ctx.now)) return { skip: "error" };
  } else if (known) {
    return { skip: known.refused };
  }
  const failed = pushes
    .filter((p) => isOneOf(RETRYABLE, p.status) && pushOfRowNow(p, row))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (failed) {
    if (!requeuesLeft(failed.retries)) return { skip: "gave_up" };
    const wait = MIRROR_RETRY_BACKOFF_MS[failed.retries]!;
    if (Date.parse(failed.updatedAt) + wait > Date.parse(ctx.now)) return { skip: "backoff" };
    return { retry: failed };
  }
  return { push: true };
}

/** The failed (or restored) push queued afresh (M3): the same job, payload and stamp; the executor's retries reset, the re-queue counted. */
async function requeueFailed(db: Db, push: PushRow, now: string): Promise<boolean> {
  const done = await db
    .update(corosWriteJobs)
    .set({
      status: "queued",
      claimedByDeviceId: null,
      claimedAt: null,
      verifiedAt: null,
      completedAt: null,
      lastErrorCategory: null,
      lastErrorDetail: null,
      payload: sql`json_set(json_remove(${corosWriteJobs.payload}, '$.attempts'), '$.mirrorRetries', ${push.retries + 1})`,
      requestedAt: now,
      updatedAt: now,
    })
    .where(and(eq(corosWriteJobs.id, push.id), inArray(corosWriteJobs.status, [...RETRYABLE])))
    .returning({ id: corosWriteJobs.id });
  return done.length > 0;
}

// ── A replaced copy left on the watch (final review Important 1) ─────────────────────────────────────────────────

/**
 * A delete the sweep queues again: failed for good on a bare error (its three tries spent in an outage) — never a
 * refusal (`stamp_mismatch`, `ambiguous`: the copy edited, renamed or moved in COROS — the lane's verdict, for the
 * athlete to settle) — left needing attention, or neutralised by a restore (B3: it removed nothing).
 */
const redeletable = (d: Pick<CopyDelete, "status" | "error">): boolean =>
  d.status === "needs_attention" || d.status === "restored" || (d.status === "failed" && (d.error === null || d.error === "error"));

/**
 * THIS PUSH'S COPY IS NO LONGER THE ROW'S ON THE WATCH: its build let go — neither locked (a day build Send or the
 * mirror locked) nor a provisional record still marked (`unlockSentBuild` lets go of the old copy whenever its delete is
 * queued: a replacement, a move, a skip, Keep off, a removal), or gone — or the row kept off, skipped or removed. The
 * row's sent build (`sentOf`) is always locked or marked, so its copy — the live one — is never this.
 */
const notTheRowsCopy = (row: MirrorRow, push: MirrorJob): boolean =>
  push.build === null ||
  (push.build.lockedAt === null && !push.build.marked) ||
  row.watchOff ||
  row.archivedAt !== null ||
  row.completionState === "skipped";

/** A row whose copies the stranded rule may delete: not under way or done, completed or missed (a done session's copy stays). */
const strandable = (row: MirrorRow): boolean =>
  (row.completionState === "scheduled" || row.completionState === "skipped") && row.contentState !== "started" && row.contentState !== "done";

/**
 * A REPLACED COPY LEFT ON THE WATCH, ITS DELETE DUE AGAIN (final review Important 1; spec §3.2 "one copy per session",
 * §3.7). A revise, a move or a day's replacement queues the old copy's delete (`unpush:A`) and the new copy's push; a
 * COROS outage can spend the delete's three tries while the push lands (or a restore neutralise it, as it can Keep
 * off's), and nothing else ever queues that delete again — the watch would hold both copies. So: a verified program
 * push of the row whose copy is not the row's any more (`notTheRowsCopy`), of a row that is not under way or done, whose
 * own delete — requested since it verified (this copy's, not an earlier copy's of the same build) — is `redeletable`,
 * for a day not gone, with re-queues left on the M3 ladder (MIRROR_RETRY_BACKOFF_MS: 1 h, 6 h, 24 h after it last
 * failed, then left) and its backoff over. Pure: the first such push, or null. A delete still on its way is the lane's
 * and is never this; nor is the live copy (a changed copy's delete that failed for good stays the athlete's, as the import
 * told them).
 */
export function strandedCopyOf(row: MirrorRow, pushes: readonly MirrorJob[], ctx: Pick<BuildCtx, "today" | "now">): MirrorJob | null {
  if (!strandable(row)) return null;
  for (const p of pushes) {
    const d = p.copyDelete;
    if (p.kind !== "program_session_push" || p.status !== "verified" || !d || p.verifiedAt === null) continue;
    if (d.requestedAt < p.verifiedAt || !redeletable(d) || d.happenDay < ctx.today || !notTheRowsCopy(row, p)) continue;
    if (!requeuesLeft(d.retries)) continue;
    if (Date.parse(d.updatedAt) + MIRROR_RETRY_BACKOFF_MS[d.retries]! > Date.parse(ctx.now)) continue;
    return p;
  }
  return null;
}

/**
 * THE STRANDED COPY'S DELETE QUEUED AGAIN (`strandedCopyOf`): the same job (`unpush:<buildId>`), with its own address —
 * the three it was queued with, where the copy sits — and the name COROS holds the copy by now (the push's rename, else
 * its stamp: the push itself is left verified, so its stamp stays claimed until the delete verifies and settles it, A6;
 * never a new stamp on it). The executor's tries reset (`$.attempts`), the sweep's re-queue counted (`$.mirrorRetries`).
 * One UPDATE, only while it is still `redeletable` and no restore runs (another request may have queued it meanwhile).
 */
async function requeueStrandedDelete(db: Db, userId: string, push: MirrorJob, now: string): Promise<boolean> {
  const d = push.copyDelete!;
  const name = push.renamed ?? push.name;
  const base = sql`json_set(json_remove(${corosWriteJobs.payload}, '$.attempts'), '$.mirrorRetries', ${d.retries + 1})`;
  const done = await db
    .update(corosWriteJobs)
    .set({
      status: "queued",
      claimedByDeviceId: null,
      claimedAt: null,
      verifiedAt: null,
      completedAt: null,
      lastErrorCategory: null,
      lastErrorDetail: null,
      payload: name ? sql`json_set(${base}, '$.name', ${name})` : base,
      requestedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(corosWriteJobs.id, unpushJobId(push.id.slice(PUSH_PREFIX))),
        eq(corosWriteJobs.userId, userId),
        or(
          inArray(corosWriteJobs.status, ["needs_attention", "restored"]),
          and(eq(corosWriteJobs.status, "failed"), sql`coalesce(${corosWriteJobs.lastErrorCategory}, 'error') = 'error'`),
        ),
        notRestoring(userId),
      ),
    )
    .returning({ id: corosWriteJobs.id });
  return done.length > 0;
}

/**
 * `strandedCopyOf` in SQL, on the `planned_workouts` row in scope: what `mirrorNeedsRun` and the sweep's candidates ask
 * (the backoff aside — a delete waiting it out answers yes here, and the sweep leaves it, as a failed push's does).
 */
function strandedCopySql(userId: string, today: string): SQL {
  const pw = plannedWorkouts;
  const sb = sessionBuilds;
  return sql`(coalesce(${pw.contentState}, '') not in ('started', 'done') and ${pw.completionState} in ('scheduled', 'skipped')
    and exists (select 1 from coros_write_jobs as p
      join coros_write_jobs as d on d.id = 'unpush:' || substr(p.id, ${PUSH_PREFIX + 1})
      left join ${sb} on ${sb.id} = substr(p.id, ${PUSH_PREFIX + 1})
      where p.user_id = ${userId} and p.workout_id = ${pw.id} and p.kind = 'program_session_push' and p.status = 'verified'
        and d.requested_at >= p.verified_at
        and (d.status in ('needs_attention', 'restored') or (d.status = 'failed' and coalesce(d.last_error_category, 'error') = 'error'))
        and coalesce(json_extract(d.payload, '$.mirrorRetries'), 0) < ${MIRROR_RETRY_BACKOFF_MS.length}
        and json_extract(d.payload, '$.happenDay') >= ${today}
        and (${sb.id} is null or (${sb.lockedAt} is null and not coalesce(${provisionalRecord()}, 0))
          or ${pw.watchOff} = 1 or ${pw.archivedAt} is not null or ${pw.completionState} = 'skipped')))`;
}

// ── The copy replaced ────────────────────────────────────────────────────────────────────────────────────────────

interface NextCopy {
  build: PushableBuild;
  /** The build's version: a day's (≥ 1) is locked for the watch (`lockForWatch` asserts it the slot's newest). */
  version: number;
  inputsHash: string;
  provisional: boolean;
  fromDocRev: number | null;
  /** The day's stamps when the caller read them (with its jobs); read by `pushPayloadFor` otherwise. */
  taken?: ReadonlySet<string>;
  /** The build's push as the caller knows it (null: none); read by `pushPayloadFor` otherwise. */
  earlier?: null;
  /** The row's sent build (`sentOf`): its copy is the one deleted. */
  sent: string | null;
  /** The record's insert, made after the previous copy's delete is queued (a provisional record not yet stored). */
  store?: () => Promise<unknown>;
  /** A day's build is locked as Send locks it (the watch holds what was played); a provisional record never is. */
  lock: boolean;
}

/**
 * THE NEW COPY'S PAYLOAD, nothing written: `too_long` when the build cannot go to the watch (more steps than it holds,
 * or none); else the steps against today's catalog and the day's free stamp, checked as Send checks them (a payload the
 * lane would fail as malformed is never queued).
 */
async function prepareCopy(db: Db, userId: string, row: MirrorRow, next: NextCopy): Promise<ProgramSessionPushJob | "skipped:too_long"> {
  if (watchStepsFromBuild(next.build, NO_CATALOG).refusal) return "skipped:too_long";
  const made = await pushPayloadFor(db, userId, row, next.build, next.earlier, {
    ...(next.taken ? { taken: next.taken } : {}),
    provisional: next.provisional,
    fromDocRev: next.fromDocRev,
  });
  return programSessionPushJobSchema.parse(made.payload);
}

/**
 * THE PREVIOUS COPY'S DELETE, THEN THE NEW PUSH (one copy per session). A day's build is locked first, as Send locks
 * it — under `lockProven`'s preconditions (`lockForWatch`: still the slot's newest day build, the slot of today, built,
 * scheduled, no restore running) — and a build that is no longer the day's writes nothing (`stale`); the lock comes
 * before the push, so the lane never claims the push before its build is the sent one. Then the previous copy's delete
 * — an adopted row's held copy and the sent build's unpush (or, for a push still queued, its supersede), never the
 * address path: a copy whose build lost its sent mark has its delete already — then a provisional record's insert, the
 * push. When the push cannot be queued (another request has the build's own push on its way or verified) the answer is
 * `already_pushed`, and the lock stays: that live push is the build's, and its build is sent.
 */
async function writeCopy(
  db: Db,
  userId: string,
  row: MirrorRow,
  next: NextCopy,
  payload: ProgramSessionPushJob,
  ctx: BuildCtx,
): Promise<"queued" | "skipped:already_pushed" | "skipped:stale"> {
  if (next.lock && !(await lockForWatch(db, userId, row.id, { id: next.build.buildId, version: next.version }, ctx))) return "skipped:stale";
  await enqueueUnpushIfOurs(db, userId, row, ctx.now, ctx.prefs, { sent: next.sent, addressPath: false });
  await next.store?.();
  return (await queuePushJob(db, userId, row, next.build.buildId, next.inputsHash, payload, ctx.now)) ? "queued" : "skipped:already_pushed";
}

/**
 * QUEUE THE ROW'S PROVISIONAL COPY (§3.2): the refusals first, in this order — the switch (`switch_off`), the writes
 * (`writes_off`), kept off, not a document workout (or a run, a rest day, a race), resolved (done, skipped, missed, under
 * way, archived), a day gone (`past`), beyond the window, and a copy already current (A7) — then, a restore running,
 * nothing; a session of today whose pre-check is answered, nothing either (`today_checked`, M1: the day's gated build
 * is its copy, on its next build); a failed push of this revision and day is re-queued on its backoff (M3) rather than
 * replaced; else the record is made (`prepareProvisionalRecord`), and — unless it is too long for the watch, when
 * nothing is written — the previous copy's delete is queued, the record stored, and `push:<recordId>` queued with
 * `provisional: true`.
 *
 * TWO PHASES. The preparation (the reads, the record made, the payload, its check) writes nothing: a throw there is
 * remembered on the row's mark (`error`, on the backoff ladder) and answered `skipped:error`. The writes (the delete, the
 * record, the push) are not caught: a throw there propagates, and nothing is remembered — the next run finds the copy
 * not current and makes it again (the delete already queued is not queued twice).
 *
 * The owed mark is resolved whatever the answer, except with the switch or the writes off or a restore running (they
 * keep it open, so the catch-up finds it). `known` is what the sweep has read already (the jobs, the mark, the restore)
 * and how it settles the marks (`settle`: together, at its end): nothing is read twice. 11 statements for a first copy;
 * a replacement adds the previous copy's delete (`unpushBuild`, 4); a session of today adds the pre-check's read (1).
 */
export async function queueProvisionalPush(
  db: Db,
  env: Env,
  userId: string,
  row: MirrorRow,
  ctx: BuildCtx,
  known: {
    jobs?: readonly MirrorJob[];
    /** False: the row has no open mark (nothing to resolve). */
    owed?: boolean;
    memory?: MirrorMemory | null;
    /** False: the caller has just read that no restore is running. */
    restoring?: false;
    /** The caller resolves the marks together: the row's id is added here instead of resolved now. */
    settle?: string[];
  } = {},
): Promise<MirrorAnswer> {
  const finish = async (answer: MirrorAnswer, memory?: MirrorMemory): Promise<MirrorAnswer> => {
    if (answer === "skipped:switch_off" || answer === "skipped:writes_off" || answer === "skipped:restoring") return answer;
    if (memory) await remember(db, userId, row.id, ctx.now, memory);
    else if (known.owed === false) return answer;
    else if (known.settle) known.settle.push(row.id);
    else await resolveOwed(db, userId, [row.id], ctx.now);
    return answer;
  };
  const refused = rowRefusal(row, env, ctx);
  if (refused) return finish(`skipped:${refused}`);
  const jobs =
    known.jobs ??
    (await mirrorJobs(db, userId, or(eq(corosWriteJobs.workoutId, row.id), sql`json_extract(${corosWriteJobs.payload}, '$.happenDay') = ${row.effectiveDate}`)!));
  const pushes = pushesOf(jobs, row.id);
  const verdict = verdictOf(row, pushes, env, ctx, known.memory ?? null);
  if ("skip" in verdict) return finish(`skipped:${verdict.skip}`);
  if (known.restoring !== false && (await restoreInProgress(db, userId))) return "skipped:restoring";
  // Today, the pre-check answered (M1): the day's gated build is the copy — never an ungated provisional one, made or
  // re-queued (a failed day build's push is re-queued still). Remembered for this revision and day, so the sweep does
  // not spend its run on it again; the next build of the day pushes it (`mirrorOnDayBuild`). One read, for today only.
  const provisionalNext = "push" in verdict || verdict.retry.provisional;
  if (provisionalNext && row.effectiveDate === ctx.today && (await slotPrechecked(db, userId, row.id, row.effectiveDate, ctx.today)) === true) {
    // …unless the copy is the day's own build already — locked for the watch, of this revision — gone from the watch or
    // changed there (§3.8): the day's path puts it back now (`mirrorOnDayBuild`: its push again, or the changed copy's
    // delete first), so the hourly restores today's copy with the app closed (one read for the build). Anything else
    // that path answers is remembered as today's check, as before.
    const dayBuild = await lockedDayBuild(db, userId, row, ctx.today);
    if (dayBuild) {
      const answer = await mirrorOnDayBuild(db, env, userId, row, dayBuild, ctx, { inputsHash: dayBuild.inputsHash, version: dayBuild.engineVersion });
      if (answer === "pushing" || answer === "replacing") return finish("queued");
    }
    return finish("skipped:today_checked", { refused: "today_checked", rev: row.workoutDocRev, day: row.effectiveDate });
  }
  // Re-queued — or, when another request changed the push since it was read (queued or claimed it), on its way already.
  if ("retry" in verdict) return finish((await requeueFailed(db, verdict.retry, ctx.now)) ? "queued" : "skipped:current");

  const rev = row.workoutDocRev!;
  const memory = (why: "too_long" | "not_document"): MirrorMemory => ({ refused: why, rev, day: row.effectiveDate });

  // The preparation: nothing written.
  const prepare = async (): Promise<{ next: NextCopy; payload: ProgramSessionPushJob } | { refused: "too_long" | "not_document" }> => {
    const doc = parseStoredWorkoutDoc(row.workoutDoc);
    if (!doc || isRunDoc(doc)) return { refused: "not_document" };
    let record: Awaited<ReturnType<typeof prepareProvisionalRecord>>;
    try {
      record = await prepareProvisionalRecord(db, userId, row, doc, rev, ctx);
    } catch (e) {
      if (e instanceof DocTooLargeRefusal) return { refused: "too_long" };
      throw e;
    }
    const next: NextCopy = {
      build: { buildId: record.buildId, ...record.stored.build },
      // A provisional record's: negative (its own is taken at the insert) — never locked.
      version: -1,
      inputsHash: record.stored.build.inputsHash,
      provisional: true,
      fromDocRev: rev,
      taken: takenOn(jobs, row.effectiveDate, pushJobId(record.buildId)),
      earlier: null,
      sent: sentOf(jobs, row),
      store: record.insert,
      lock: false,
    };
    const payload = await prepareCopy(db, userId, row, next);
    return payload === "skipped:too_long" ? { refused: "too_long" } : { next, payload };
  };
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare();
  } catch (e) {
    const remembered = errorMemory(e, row, known.memory, ctx.now);
    console.error(`mirror: ${row.id} not mirrored (error ${remembered.count}) — ${remembered.message}`);
    return finish("skipped:error", remembered);
  }
  if ("refused" in prepared) return finish(`skipped:${prepared.refused}`, memory(prepared.refused));
  // The writes: a throw propagates (see above).
  return finish(await writeCopy(db, userId, row, prepared.next, prepared.payload, ctx));
}

/** A session build row (`session_builds`), as the day's mirror reads one. */
type SessionBuildRow = typeof sessionBuilds.$inferSelect;

/** The jobs the copy's replacement reads: the row's own, and the stamps of its day (for the new copy's). */
const rowScope = (row: Pick<MirrorRow, "id" | "effectiveDate">): SQL =>
  or(eq(corosWriteJobs.workoutId, row.id), sql`json_extract(${corosWriteJobs.payload}, '$.happenDay') = ${row.effectiveDate}`)!;

/**
 * REPLACE THE COPY ON THE WATCH WITH `newBuildId` (§3.3: a day's build — `mirrorOnDayBuild` replaces the copy through
 * the same `replaceCopy` — or a provisional record): the current sent copy's delete (the sent build's unpush — a queued
 * push superseded — or an adopted row's held copy), then the new build's push; a day's build locked first, under
 * `lockProven`'s preconditions (`lockForWatch`; a provisional record never is).
 *
 * In order: the row's own refusals — a day's build `dayRowRefusal` (the switch, the writes, kept off, a session the
 * mirror holds on its day — an engine slot among them — resolved or under way or archived, its day), a provisional
 * record `rowRefusal` (… not a document workout, a day gone, beyond the window); for a day's build, `lockProven`'s
 * preconditions as far as the build itself says them — the pre-check answered (`checksAnswered`, the account's active
 * profiles read: `precheck`) and not blocked (`lockRefusal`: `blocked`) — so it never locks a build the day's check
 * has not cleared; a restore running; `current` when the build is the sent copy already, `already_pushed` when its own
 * push is on its way or verified (nothing written, nothing locked; if another request queues it between that read and
 * the write, the answer is the same, the delete queued and the build locked — the push is the build's), `stale` when the
 * lock is refused (`lockForWatch`: no longer the slot's newest day build, the slot not built; nothing written),
 * `too_long`. That the build is the one the day's inputs make NOW is the build commit's to prove (it holds the inputs):
 * the day's own path is `mirrorOnDayBuild`, which calls `replaceCopy` with that proof. Throws when the build is not this
 * row's.
 */
export async function queueReplacement(db: Db, env: Env, userId: string, row: MirrorRow, newBuildId: string, ctx: BuildCtx): Promise<MirrorAnswer> {
  const [b] = await db
    .select()
    .from(sessionBuilds)
    .where(and(eq(sessionBuilds.id, newBuildId), eq(sessionBuilds.userId, userId), eq(sessionBuilds.workoutId, row.id)))
    .limit(1);
  if (!b) throw new Error(`queueReplacement: build ${newBuildId} is not this session's`);
  const refused = b.version > 0 ? dayRowRefusal(row, env, ctx) : rowRefusal(row, env, ctx);
  if (refused) return `skipped:${refused}`;
  if (b.version > 0) {
    const stored = b.payload as unknown as StoredBuild;
    if (!checksAnswered(await activeProfilesOf(db, userId), stored.build.params.checks)) return "skipped:precheck";
    const unlockable = lockRefusal(b, b.id, { inputsHash: b.inputsHash, version: b.engineVersion });
    if (unlockable) return `skipped:${unlockable}`;
  }
  if (await restoreInProgress(db, userId)) return "skipped:restoring";
  return replaceCopy(db, userId, row, b, await mirrorJobs(db, userId, rowScope(row)), ctx);
}

/** `queueReplacement` once the build and the jobs are read (`jobs`: `rowScope`'s). */
async function replaceCopy(db: Db, userId: string, row: MirrorRow, b: SessionBuildRow, jobs: readonly MirrorJob[], ctx: BuildCtx): Promise<MirrorAnswer> {
  const sent = sentOf(jobs, row);
  if (sent === b.id) return "skipped:current";
  const own = jobs.find((j) => j.id === pushJobId(b.id));
  if (own && (isOneOf(IN_FLIGHT, own.status) || own.status === "verified")) return "skipped:already_pushed";
  const stored = b.payload as unknown as StoredBuild;
  // The sent copy's push still queued never ran: `writeCopy` supersedes it (the copy's delete) before the new push is
  // queued, and the lane runs the account's jobs in order, so its stamp is the new copy's to take — never " (2)" beside a
  // copy that is not there.
  const sentPush = sent === null ? undefined : jobs.find((j) => j.id === pushJobId(sent));
  const stamps = sentPush?.status === "queued" ? jobs.filter((j) => j !== sentPush) : jobs;
  const next: NextCopy = {
    build: { buildId: b.id, ...stored.build },
    version: b.version,
    inputsHash: b.inputsHash,
    provisional: isProvisionalBuild(b),
    fromDocRev: stored.build.fromDoc?.rev ?? null,
    taken: takenOn(stamps, row.effectiveDate, pushJobId(b.id)),
    // A build never pushed has no stamp of its own to keep: no read for it.
    ...(own ? {} : { earlier: null }),
    sent,
    lock: b.version > 0,
  };
  const payload = await prepareCopy(db, userId, row, next);
  return payload === "skipped:too_long" ? payload : writeCopy(db, userId, row, next, payload, ctx);
}

// ── On the day (§3.3) ────────────────────────────────────────────────────────────────────────────────────────────

/** What the mirror did with a day's build (`mirrorOnDayBuild`). */
export type DayAnswer =
  /** The copy on the watch was the day's build already, step for step: it is the day build's now, in D1 alone (A3). */
  | "handed_over"
  /** The copy's delete and the day build's push are queued (two jobs). */
  | "replacing"
  /** The day build's push is queued — nothing to delete (no copy, or its push never ran and is superseded). */
  | "pushing"
  /** The day's reading closes a move no alternate stands in for: the copy stays, nothing queued. */
  | "blocked"
  | `skipped:${MirrorSkip}`;

/**
 * The mirror follows this row's day (`dayRowRefusal` refuses nothing): a change on the day may build past a lock held
 * only for the watch, since the copy will be replaced (session-build.ts `watchLocksOf`).
 */
export const mirrorFollowsDay = (row: MirrorRow, env: Env, ctx: BuildCtx): boolean => dayRowRefusal(row, env, ctx) === null;

/** A watch step as the day's comparison reads it — what the watch shows and does; never its catalog id or overview. */
const comparable = (s: ProgramWatchStep) => ({
  name: s.name,
  side: s.side,
  targetType: s.target.kind,
  targetValue: s.target.kind === "reps" ? s.target.reps : s.target.kind === "hold" ? s.target.seconds : null,
  grams: s.grams,
  restSec: s.restSeconds,
});

/** Two copies hold the same session on the watch: the same steps, step for step (`comparable`). Pure. */
export function sameWatchSteps(a: readonly ProgramWatchStep[], b: readonly ProgramWatchStep[]): boolean {
  return a.length === b.length && a.every((s, i) => JSON.stringify(comparable(s)) === JSON.stringify(comparable(b[i]!)));
}

/**
 * THE COPY FOLLOWS THE DAY'S BUILD (§3.3; owner §10.1; builder check A3, M1) — called by the build commit (session-build
 * `mirrorDay`) once a day's build is stored or found current, with what the commit proved of it (`day`: made with the
 * day's inputs as they hash now, for these active profiles). In order:
 *  - the row's refusals (`dayRowRefusal`); not the row's day build → `not_day_build`;
 *  - the pre-check unanswered (`checksAnswered`) → `precheck`: the copy stays as it is (a provisional copy, M1);
 *  - `lockProven`'s preconditions (`lockRefusal`): `blocked` — the day's reading closes a move no alternate stands in
 *    for: the copy stays, nothing queued — or `stale`;
 *  - the copy on the watch (`sentOf`): this build's already → `current` — unless, for a document workout, it is no
 *    longer current (`restoreDayCopy`, §3.8: gone from the watch → its push again; changed there → its delete first);
 *    this build's own push live → `already_pushed`;
 *  - none → the build pushed (`pushing`; an adopted row's held copy deleted first — `replacing` then);
 *  - else the build's watch steps, resolved as the copy's were (`watchStepsAsSent`), compared with the copy's
 *    (`sameWatchSteps`; never `pushDigest`, never COROS's fingerprints):
 *     · the same, and the copy verified on the watch at the row's address (a document workout's not changed in the
 *       COROS app) → HANDED OVER in D1, no COROS write
 *       (`handOver`) — from the provisional copy, or from an earlier day build (a later build with nothing new for the
 *       watch: the sent lock moves to the newest build, A9, so the sheet and Start play what the row now holds);
 *     · the same, its push on the wire this moment → `in_flight` (handed over by a later build once it verifies);
 *     · the same but never landed (queued, failed, gone from the watch), or different → REPLACED (`replaceCopy`): the
 *       copy's delete — a push that never ran superseded instead (`pushing`, Review Focus 2) — and the build's push, the
 *       build locked first (`lockForWatch`).
 * Every later change on the day (a new reading, a revision, another place or length) makes a new day build that comes
 * here again, and is replaced the same way. ≤ 5 statements for a hand-over (the jobs read and four writes).
 */
export async function mirrorOnDayBuild(
  db: Db,
  env: Env,
  userId: string,
  row: MirrorRow,
  dayBuild: SessionBuildRow,
  ctx: BuildCtx,
  day: { profiles?: readonly string[]; inputsHash: string; version: string },
): Promise<DayAnswer> {
  const refused = dayRowRefusal(row, env, ctx);
  if (refused) return `skipped:${refused}`;
  const stored = dayBuild.payload as unknown as StoredBuild;
  if (dayBuild.version <= 0 || dayBuild.workoutId !== row.id || dayBuild.userId !== userId || stored.build.date !== row.effectiveDate) {
    return "skipped:not_day_build";
  }
  const profiles = day.profiles ?? (await activeProfilesOf(db, userId));
  if (!checksAnswered(profiles, stored.build.params.checks)) return "skipped:precheck";
  const unlockable = lockRefusal(dayBuild, dayBuild.id, day);
  if (unlockable === "blocked") return "blocked";
  if (unlockable) return `skipped:${unlockable}`;

  const jobs = await mirrorJobs(db, userId, rowScope(row), { payloads: true });
  const sent = sentOf(jobs, row);
  if (sent === dayBuild.id) return restoreDayCopy(db, userId, row, dayBuild, jobs, ctx);
  const own = jobs.find((j) => j.id === pushJobId(dayBuild.id));
  if (own && (isOneOf(IN_FLIGHT, own.status) || own.status === "verified")) return "skipped:already_pushed";
  const held = sent === null ? undefined : jobs.find((j) => j.id === pushJobId(sent));
  const copy = held ? programSessionPushJobSchema.safeParse(held.payload) : null;
  if (held && copy?.success) {
    const same = sameWatchSteps((await watchStepsAsSent(db, userId, stored.build, copy.data)).steps, copy.data.session.steps);
    if (same) {
      const address = watchAddressOf(row);
      // A document workout's copy changed in the COROS app (the import's `noticed`, §3.8) is not handed over: the app's
      // version replaces it. (An engine slot's is, as before: the mirror never mends one.)
      const changed = docOriginRow(row) && held.noticed === true;
      const landed = held.status === "verified" && !changed && copy.data.happenDay === row.effectiveDate && address?.happenDay === row.effectiveDate;
      if (landed) return handOver(db, userId, row, dayBuild, held, copy.data, ctx);
      if (isOneOf(IN_FLIGHT, held.status) && held.status !== "queued") return "skipped:in_flight";
    }
  }
  const answer = await replaceCopy(db, userId, row, dayBuild, jobs, ctx);
  if (answer !== "queued") return answer;
  // Nothing on the watch to take off: no copy, or one whose push never ran (superseded) — unless an adopted row's.
  const deleted = (held !== undefined && held.status !== "queued") || row.watchCopyName !== null;
  return deleted ? "replacing" : "pushing";
}

/**
 * TODAY'S COPY IS THE DAY'S BUILD, BUT NOT CURRENT (the watch mirrors the plan §3.8, A7): a document workout's day build
 * is the copy on the watch (`sentOf`), its push verified for this revision — and the copy is gone from the watch (rule 8
 * cleared the address) or changed in the COROS app (the import's `noticed`). The app is the truth:
 *  - GONE (the address cleared — an address on another day proves nothing gone, and is left): the push is settled
 *    (`superseded`, only while still verified) and queued again for the same build
 *    (`replaceCopy`: the build's lock kept, `lockForWatch` coalescing it; the stamp its own again, spent once settled;
 *    nothing to delete) → `pushing`.
 *  - CHANGED, still on the watch at the row's address: its delete (`unpush:<buildId>`, under the name COROS holds it by
 *    and its address), the push left verified — its stamp stays claimed until the delete verifies (A6), when the delete
 *    executor settles it by name — and the build left locked, so the next pass (the sweep, or the next build) finds the
 *    locked build with no live push and pushes it again (`replaceCopy`). Never a fresh stamp on the still-verified job.
 *    → `replacing`. While the delete is queued the copy counts as current (`currentCopy`), so nothing is queued twice.
 * Both write only after the build's lock is asserted (`lockForWatch`, coalescing it; B2: a restore running, or the build
 * no longer the slot's newest, refuses it — `stale`, nothing written). Anything else — an engine slot (the mirror never
 * mends one), a push not verified (a failed one is the sweep's re-queue, M3), another revision, a copy current —
 * `current`, as before. A gone copy: the lock, the settle, `replaceCopy`'s lock and push; a changed copy: the lock and
 * its delete.
 */
async function restoreDayCopy(
  db: Db,
  userId: string,
  row: MirrorRow,
  dayBuild: SessionBuildRow,
  jobs: readonly MirrorJob[],
  ctx: BuildCtx,
): Promise<DayAnswer> {
  const own = jobs.find((j) => j.id === pushJobId(dayBuild.id));
  if (!docOriginRow(row) || !own || own.status !== "verified" || (own.fromDocRev !== null && own.fromDocRev !== row.workoutDocRev)) return "skipped:current";
  if (currentCopy(row, [own], ctx.today)) return "skipped:current";
  const address = watchAddressOf(row);
  const changedThere = address !== null && address.happenDay === row.effectiveDate;
  // Settled only when the copy is proven gone (the address cleared): a copy whose address names another day may be there.
  if (!changedThere && address !== null) return "skipped:current";
  // The build's lock asserted first, as every mirror write is (B2): it coalesces the lock it holds, and refuses — nothing
  // written — while a restore runs, or once the build is no longer the slot's newest, the slot not built.
  if (!(await lockForWatch(db, userId, row.id, dayBuild, ctx))) return "skipped:stale";
  if (changedThere) {
    const copy = programSessionPushJobSchema.safeParse(own.payload);
    if (!copy.success) return "skipped:current";
    await queueUnpush(
      db,
      userId,
      dayBuild.id,
      {
        workoutId: row.id,
        happenDay: address.happenDay,
        // A copy the athlete renamed in the COROS app is held under its new name (audit 3-A life L-5).
        name: copy.data.renamed ?? copy.data.name,
        idInPlan: address.idInPlan,
        programId: address.programId,
        corosPlanId: address.corosPlanId,
      },
      ctx.now,
    );
    return "replacing";
  }
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: ctx.now })
    .where(and(eq(corosWriteJobs.id, own.id), eq(corosWriteJobs.status, "verified")));
  const settled = jobs.map((j) => (j.id === own.id ? { ...j, status: "superseded" } : j));
  const answer = await replaceCopy(db, userId, row, dayBuild, settled, ctx);
  return answer === "queued" ? "pushing" : answer;
}

/**
 * The row's day build of `today` locked for the watch, of the row's document revision — the newest such (one read), or
 * null: the copy the day's path keeps on the watch (`mirrorOnDayBuild`), which the sweep asks to put back (§3.8).
 */
async function lockedDayBuild(db: Db, userId: string, row: MirrorRow, today: string): Promise<SessionBuildRow | null> {
  const sb = sessionBuilds;
  const [b] = await db
    .select()
    .from(sb)
    .where(and(eq(sb.userId, userId), eq(sb.workoutId, row.id), gt(sb.version, 0), isNotNull(sb.lockedAt), sql`json_extract(${sb.payload}, '$.build.date') = ${today}`))
    .orderBy(desc(sb.version))
    .limit(1);
  if (!b || (b.payload as unknown as StoredBuild).build.fromDoc?.rev !== row.workoutDocRev) return null;
  return b;
}

/**
 * THE HAND-OVER (A3, A9): the copy on the watch — the provisional copy, or an earlier day build's — is the day's build
 * step for step, so the day's build takes it over in D1, with no COROS write, in the only order that keeps one stamp
 * claimed throughout (the import's `pushByStamp`, `verifiedPushOf` by the latest verification; the delete executor
 * supersedes verified pushes by name):
 *  1. the day's build locked (`lockForWatch`: still the slot's newest day build, the slot built, no restore running);
 *  2. `push:<dayBuild>` written `verified` — the copy's payload, its `buildId` and revision the day build's, never
 *     provisional — so it carries the copy's stamp, its day, what its push observed (and noticed), and a rename;
 *  3. the copy's build let go (`unlockSentBuild`): a provisional record's marker cleared, an earlier day build unlocked
 *     (`$.unsentAt`) — it is no longer the copy on the watch;
 *  4. its push settled (`superseded`).
 * Four statements. A lock refused writes nothing (`stale`); a day push another request has on its way or verified
 * meanwhile stops before the copy is let go (`already_pushed`: that push is the build's).
 */
async function handOver(
  db: Db,
  userId: string,
  row: MirrorRow,
  dayBuild: SessionBuildRow,
  held: MirrorJob,
  copy: ProgramSessionPushJob,
  ctx: BuildCtx,
): Promise<DayAnswer> {
  if (!(await lockForWatch(db, userId, row.id, dayBuild, ctx))) return "skipped:stale";
  const rev = (dayBuild.payload as unknown as StoredBuild).build.fromDoc?.rev;
  const { provisional: _provisional, mirrorRetries: _retries, attempts: _attempts, fromDocRev: _rev, ...kept } = copy;
  const payload = programSessionPushJobSchema.parse({ ...kept, buildId: dayBuild.id, ...(typeof rev === "number" ? { fromDocRev: rev } : {}) });
  const verified = {
    status: "verified",
    expectedContentFingerprint: dayBuild.inputsHash,
    originalDate: copy.happenDay,
    destinationDate: copy.happenDay,
    payload: payload as unknown as Record<string, unknown>,
    requestedAt: ctx.now,
    claimedByDeviceId: null,
    claimedAt: null,
    verifiedAt: ctx.now,
    completedAt: ctx.now,
    lastErrorCategory: null,
    lastErrorDetail: null,
    updatedAt: ctx.now,
  };
  const put = await db
    .insert(corosWriteJobs)
    .values({ id: pushJobId(dayBuild.id), userId, workoutId: row.id, kind: "program_session_push", ...verified })
    .onConflictDoUpdate({ target: corosWriteJobs.id, set: verified, setWhere: notInArray(corosWriteJobs.status, [...IN_FLIGHT, "verified"]) })
    .returning({ id: corosWriteJobs.id });
  if (put.length === 0) return "skipped:already_pushed";
  await unlockSentBuild(db, row, held.id.slice(pushJobId("").length), ctx.now);
  await db
    .update(corosWriteJobs)
    .set({ status: "superseded", updatedAt: ctx.now })
    .where(and(eq(corosWriteJobs.id, held.id), eq(corosWriteJobs.status, "verified")));
  return "handed_over";
}

// ── The sweep ────────────────────────────────────────────────────────────────────────────────────────────────────

/** At most this many sessions are judged a run (bound variables; the window's farthest days wait for a later run). */
const SWEEP_ROWS = 60;

/**
 * What a sweep did: `queued` copies (a record and its push, or a failed push re-queued) and stranded copies' deletes
 * queued again (`strandedCopyOf`); `attempted` — the sessions it worked on (`queueProvisionalPush`, or a stranded copy's
 * delete; at most `opts.cap`), whatever the answer: the run's heavy step when > 0 (A5);
 * a sweep that attempted nothing only read — the caller's watch drain may still run in the same invocation; `skipped`,
 * the sessions it left, by reason.
 */
export interface MirrorSweepResult {
  queued: number;
  attempted: number;
  skipped: Record<string, number>;
}

/**
 * THE MIRROR'S TURN AT AN INVOCATION'S ONE WATCH JOB (§3.7, A5). The hourly and the app's drain request each have room
 * for one watch job — a push drain measures ≈31–34 of the 45 an invocation may spend, an unpush 29, the sweep's record
 * ≤15 — never two. With the switch and the writes on and work found (`mirrorNeedsRun`, one read), the sweep makes its
 * one attempt. True when it attempted (the invocation's watch job is spent: no drain after it); false when there was
 * nothing to make, or no work found — the caller drains one job as before (the reads, at most four statements, fit
 * beside it). A failed `mirrorNeedsRun` read is logged and answers false (the drain is never held up by it); a throw
 * from the sweep propagates — it may have spent the invocation's room.
 */
export async function mirrorTakesTurn(db: Db, env: Env, userId: string, prefs: BuildCtx["prefs"], ctx: BuildCtx): Promise<boolean> {
  if (!watchPushEnabled(env) || !prefs.corosWritesEnabled) return false;
  const needed = await mirrorNeedsRun(db, userId, ctx.today).catch((e: unknown) => {
    console.error(`mirror: the work read failed — ${e instanceof Error ? e.message : "unknown"}`);
    return false;
  });
  if (!needed) return false;
  return (await mirrorSweep(db, env, userId, prefs, ctx, { cap: 1 })).attempted > 0;
}

/**
 * `rowRefusal`'s rules, as far as SQL says them, on `planned_workouts`: a document workout (studio, template) still to
 * run in the window (today … `horizon`), not kept off, not a run, a rest day or a race. The sweep reads these rows (and
 * the owed ones); `mirrorNeedsRun` asks the same of them.
 */
function inWindowCondition(today: string, horizon: string): SQL {
  const pw = plannedWorkouts;
  return and(
    isNull(pw.archivedAt),
    eq(pw.completionState, "scheduled"),
    inArray(pw.origin, [...DOC_ORIGINS]),
    isNotNull(pw.workoutDoc),
    eq(pw.watchOff, false),
    gte(pw.effectiveDate, today),
    lte(pw.effectiveDate, horizon),
    sql`coalesce(${pw.sport}, '') <> 'run'`,
    sql`coalesce(${pw.category}, '') not in ('rest', 'race')`,
  )!;
}

/**
 * IS THERE WORK FOR THE SWEEP? (§3.7, A5) — what the hourly and the app's drain ask before they spend a run on the
 * sweep rather than on a watch job. ONE bounded read (LIMIT 1, nothing read back but a row's existence): an OPEN owed
 * mark (on a row the sweep reads: the mark of a row gone is never its), or a window document workout
 * (`inWindowCondition`, not under way or done, with a revision) WITH NO CURRENT COPY — `currentCopy` in SQL: no push of
 * its revision (or none said) that is on its way for its day, or verified (and not seen changed in the COROS app, or its
 * delete queued) with the row holding a COROS address on its day — and NOT REMEMBERED refused for its revision and day (too long, not a
 * document, today's check answered, an error past its backoff ladder; an error still on the ladder waits out its backoff
 * in the sweep, and is not read here) — or a replaced copy left on the watch whose delete the sweep will queue again
 * (`strandedCopySql`: re-queues left on its ladder; one waiting out its backoff answers yes, and the sweep leaves it).
 *
 * Never "no" when the sweep would make a copy (every condition here is one the sweep's verdict holds too), but "yes"
 * for some sessions it will leave — a failed push waiting out its backoff or given up on: the sweep then attempts
 * nothing, and its caller drains a job as before (`MirrorSweepResult.attempted`). The switch and the writes are the
 * caller's to check first.
 */
export async function mirrorNeedsRun(db: Db, userId: string, today: string): Promise<boolean> {
  const pw = plannedWorkouts;
  const si = syncIntents;
  const j = corosWriteJobs;
  const field = (path: string) => sql`json_extract(${j.payload}, ${path})`;
  const mark = (path: string) => sql`json_extract(${si.payload}, ${path})`;
  // `watchAddressOf`, exactly: "<digits>:<digits>", an id in the plan, a program id, a verified day.
  const address = sql`(${pw.sourceWorkoutId} glob '[0-9]*:[0-9]*' and ${pw.sourceWorkoutId} not glob '*[^0-9:]*'
    and length(${pw.sourceWorkoutId}) - length(replace(${pw.sourceWorkoutId}, ':', '')) = 1
    and coalesce(${pw.sourceIdInPlan}, '') <> '' and coalesce(${pw.sourceProgramId}, '') <> '' and coalesce(${pw.lastVerifiedCorosDate}, '') <> '')`;
  const current = sql`exists (select 1 from ${j} where ${j.userId} = ${userId} and ${j.workoutId} = ${pw.id}
    and ${j.kind} = 'program_session_push'
    and (${field("$.fromDocRev")} is null or ${field("$.fromDocRev")} = ${pw.workoutDocRev})
    and ((${j.status} in (${sql.join(IN_FLIGHT.map((x) => sql`${x}`), sql`, `)}) and ${field("$.happenDay")} = ${pw.effectiveDate})
      or (${j.status} = 'verified' and (${field("$.noticed")} is null or ${unpushQueued(sql`${j.id}`, sql`${j.verifiedAt}`)}) and ${address}
        and ${pw.lastVerifiedCorosDate} = ${pw.effectiveDate})))`;
  // Refused for good for this revision and day — or an error past its backoff ladder (`gave_up`, `verdictOf`). A mark that
  // remembers nothing (`{}`: settled, or marked again) compares NULL here, which `not` would keep NULL — no row: so 0.
  const remembered = sql`coalesce((${si.id} is not null and ${mark("$.rev")} = ${pw.workoutDocRev} and ${mark("$.day")} = ${pw.effectiveDate}
    and (${mark("$.refused")} in ('too_long', 'not_document', 'today_checked')
      or (${mark("$.refused")} = 'error' and coalesce(${mark("$.count")}, 1) > ${MIRROR_RETRY_BACKOFF_MS.length}))), 0)`;
  const uncovered = and(
    inWindowCondition(today, addDays(today, MIRROR_WINDOW_DAYS)),
    isNotNull(pw.workoutDocRev),
    sql`coalesce(${pw.contentState}, '') not in ('started', 'done')`,
    sql`not ${current}`,
    sql`not ${remembered}`,
  );
  const rows = await db
    .select({ id: pw.id })
    .from(pw)
    .leftJoin(si, and(eq(si.id, sql`'mirror-' || ${pw.id}`), eq(si.userId, userId)))
    .where(and(eq(pw.userId, userId), or(and(sql`${si.id} is not null`, isNull(si.resolvedAt)), uncovered, strandedCopySql(userId, today))))
    .limit(1);
  return rows.length > 0;
}

/**
 * THE MIRROR SWEEP (§3.7, A5): the hourly's heavy step. The owed sessions first (an open mark, soonest day first), then
 * the rows with a replaced copy left on the watch (`strandedCopySql`, whatever the row), then the window's document
 * workouts (today … today + 28, scheduled, not archived, not kept off, soonest first): each judged with no statement of
 * its own — a stranded copy whose delete is due again first (`strandedCopyOf`: that delete queued again, one UPDATE),
 * else `verdictOf`; the first that needs work gets it — ONE `queueProvisionalPush` (or its failed push's re-queue), or
 * the stranded copy's delete — `opts.cap` attempts a run, one by design (A5). The owed marks of the sessions it will
 * never push (kept off, resolved, beyond the window, current, …) are resolved together, in one statement, with the one
 * it pushed. A restore running (read with the candidates): nothing written. Preparing a copy that throws is remembered on
 * the row's mark (`error`, on the backoff ladder), so one session cannot stall the account every hour. Writes off or
 * the switch off: nothing read, nothing queued, the marks kept. ≤ 15 statements for one record, a replacement included.
 */
export async function mirrorSweep(
  db: Db,
  env: Env,
  userId: string,
  prefs: BuildCtx["prefs"],
  ctx: BuildCtx,
  opts: { cap: number },
): Promise<MirrorSweepResult> {
  if (!watchPushEnabled(env)) return { queued: 0, attempted: 0, skipped: { switch_off: 1 } };
  if (!prefs.corosWritesEnabled) return { queued: 0, attempted: 0, skipped: { writes_off: 1 } };
  const runCtx: BuildCtx = { ...ctx, prefs };
  const horizon = addDays(ctx.today, MIRROR_WINDOW_DAYS);
  const pw = plannedWorkouts;
  const owedMark = and(eq(syncIntents.id, sql`'mirror-' || ${pw.id}`), eq(syncIntents.userId, userId));
  // `rowRefusal`'s rules, as far as SQL says them: what it would refuse is not read at all, unless it is owed.
  const inWindow = inWindowCondition(ctx.today, horizon);
  const open = and(sql`${syncIntents.id} is not null`, isNull(syncIntents.resolvedAt));
  // A replaced copy left on the watch (Important 1): read whatever the row (kept off, skipped, removed, an engine slot).
  const stranded = strandedCopySql(userId, ctx.today);
  const candidates = await db
    .select({
      row: pw,
      intentResolvedAt: syncIntents.resolvedAt,
      intentId: syncIntents.id,
      intentPayload: syncIntents.payload,
      // A restore running (B2), read with the candidates: the run writes nothing then.
      restoring: sql<number>`${restoring(userId)}`,
    })
    .from(pw)
    .leftJoin(syncIntents, owedMark)
    .where(and(eq(pw.userId, userId), or(open, inWindow, stranded)))
    .orderBy(sql`case when ${open} then 0 when ${stranded} then 1 else 2 end`, asc(pw.effectiveDate), asc(pw.effectiveTime), asc(pw.id))
    .limit(SWEEP_ROWS);
  if (candidates.length === 0) return { queued: 0, attempted: 0, skipped: {} };
  if (candidates[0]!.restoring) return { queued: 0, attempted: 0, skipped: { restoring: 1 } };
  const jobs = await mirrorJobs(
    db,
    userId,
    or(
      inArray(
        corosWriteJobs.workoutId,
        candidates.map((c) => c.row.id),
      ),
      and(
        sql`json_extract(${corosWriteJobs.payload}, '$.happenDay') >= ${ctx.today}`,
        sql`json_extract(${corosWriteJobs.payload}, '$.happenDay') <= ${horizon}`,
      ),
    )!,
  );

  const skipped: Record<string, number> = {};
  const count = (reason: string): void => void (skipped[reason] = (skipped[reason] ?? 0) + 1);
  const settle: string[] = [];
  let queued = 0;
  let attempts = 0;
  for (const c of candidates) {
    const owed = c.intentId !== null && c.intentResolvedAt === null;
    const memory = c.intentId !== null ? memoryOf(c.intentPayload) : null;
    const pushes = pushesOf(jobs, c.row.id);
    // A REPLACED COPY LEFT ON THE WATCH (Important 1): its delete queued again — the run's one attempt, one UPDATE. The
    // owed mark stays as it is (the row's own copy may be owed still: a later run makes it).
    const stranded = strandedCopyOf(c.row, pushes, runCtx);
    if (stranded) {
      if (attempts >= opts.cap) continue;
      attempts += 1;
      if (await requeueStrandedDelete(db, userId, stranded, ctx.now)) queued += 1;
      else count("current");
      continue;
    }
    const verdict = verdictOf(c.row, pushes, env, runCtx, memory);
    if ("skip" in verdict) {
      count(verdict.skip);
      if (owed) settle.push(c.row.id);
      continue;
    }
    // `opts.cap` heavy attempts a run (the budget: one), queued or not: the rest wait for the next run.
    if (attempts >= opts.cap) continue;
    attempts += 1;
    // A throw while the copy is prepared is remembered by `queueProvisionalPush` itself (`error`); one while it is
    // written propagates — the owed marks stay open, and the next run makes the copy again.
    const answer = await queueProvisionalPush(db, env, userId, c.row, runCtx, { jobs, owed, memory, restoring: false, settle });
    if (answer === "queued") queued += 1;
    else count(answer.slice("skipped:".length));
  }
  await resolveOwed(db, userId, settle, ctx.now);
  return { queued, attempted: attempts, skipped };
}
