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
 * MIRROR_RETRY_BACKOFF_MS, three times at most (M3). Writes off (`prefs.corosWritesEnabled`) or the switch off
 * (`WATCH_PUSH_ENABLED`): nothing is read and nothing is queued; the owed marks stay open, so the sweep catches up when
 * they come back on.
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
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { accountState, corosWriteJobs, plannedWorkouts, sessionBuilds, syncIntents } from "@rg/database";
import {
  addDays,
  appAuthoredRow,
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
  type BuildCtx,
  type StoredBuild,
} from "./session-build.js";
import {
  NO_CATALOG,
  pushPayloadFor,
  queuePushJob,
  unlockSentBuild,
  watchStepsAsSent,
  watchStepsFromBuild,
  type PushableBuild,
} from "./watch-push.js";

/** The mirror's window: today … today + 28 days (§3.2). */
export const MIRROR_WINDOW_DAYS = 28;

/** A failed push's re-queues (M3): after 1 h, then 6 h, then 24 h; a fourth failure stops. */
export const MIRROR_RETRY_BACKOFF_MS = [3_600_000, 21_600_000, 86_400_000] as const;

/** The one owed mark a workout has: `sync_intents.id`. */
export const mirrorIntentId = (workoutId: string): string => `mirror-${workoutId}`;

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
  // ── On the day (`mirrorOnDayBuild`, `queueReplacement` of a day's build) ──
  /** A day's build of a row whose day is ahead. */
  | "not_today"
  /** A session the mirror does not hold on its day: not the app's, a run, a rest day, a race, or started at once (M5). */
  | "not_mirrored"
  /** Not the row's day build (a preview, a provisional record, another day's, another row's). */
  | "not_day_build"
  /** The day's pre-check is not answered yet: the copy stays as it is until it is. */
  | "precheck"
  /** No longer the build the day shows, or the slot no longer holds it to be locked (`lockRefusal`, `lockForWatch`). */
  | "stale"
  /** The steps the watch holds already: the sent build stays (§3.3, a later build with nothing new for the watch). */
  | "same"
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
}

/** The row fields the current-copy test reads. */
export type MirrorRow = typeof plannedWorkouts.$inferSelect;

/**
 * What the mirror remembers of a session it could not push for a reason only making the copy shows — on its owed mark's
 * payload, for that revision and day, so the sweep does not make the record again every run, and one session never holds
 * the window up. A new owed mark, a revision or a move forgets it.
 *  - `too_long`, `not_document`: for good (for that revision and day).
 *  - `error` (an unexpected throw while the copy was prepared; its message's first 120 characters): for a while — `at`
 *    the last one, `count` how many in a row — on MIRROR_RETRY_BACKOFF_MS (1 h, 6 h, 24 h, then `gave_up`), so a
 *    transient failure heals and a persistent one cannot stall the account.
 */
export interface MirrorMemory {
  refused: "too_long" | "not_document" | "error";
  rev: number | null;
  day: string;
  message?: string;
  at?: string;
  count?: number;
}

// Spelled out, never derived from session-build.ts's constants at load: that module will import this one (Task 5), and
// a cycle can leave an imported constant uninitialised while this module loads.
const SETTLED = ["superseded", "cancelled", "restored"] as const;
const IN_FLIGHT = ["queued", "claimed", "in_progress", "verifying"] as const;
/** A push the mirror re-queues on its backoff (M3): failed for good, or neutralised by a restore (its stamp kept). */
const RETRYABLE = ["failed", "needs_attention", "restored"] as const;
const isOneOf = (list: readonly string[], status: string): boolean => list.includes(status);

/**
 * IS THE COPY ON THE WATCH THE SESSION AS IT STANDS? (A7) Pure. A push (not settled) for the row's document revision
 * and the row's day that is on its way, or verified with the row still holding a COROS address on its day. So:
 *  - another revision → not current (the copy is the old one);
 *  - the same revision on another day (a move in the app) → not current: an in-flight push is for the old day, and a
 *    verified copy's address still names the old day until its delete verifies;
 *  - verified, but the address cleared (the import found the copy gone, §3.8) → not current, so it is pushed again;
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
    return p.status === "verified" && address !== null && address.happenDay === row.effectiveDate;
  });
}

/**
 * Mark the workout's copy owed (M2): one INSERT into `sync_intents` (`mirror-<workoutId>`, kind `mirror`). Idempotent:
 * marked again while open, it stays one open mark (its time refreshed, so a sweep that read the row before it does not
 * resolve it); marked again after the mirror resolved it, it is open again. `coros_sync_state` is not touched.
 */
export async function markMirrorOwed(db: Db, userId: string, workoutId: string, now: string): Promise<void> {
  await db
    .insert(syncIntents)
    .values({ id: mirrorIntentId(workoutId), userId, targetKind: "workout", targetId: workoutId, kind: "mirror", payload: {}, source: "mirror", createdAt: now })
    .onConflictDoUpdate({ target: syncIntents.id, set: { resolvedAt: null, createdAt: now, payload: {} } });
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

function memoryOf(payload: unknown): MirrorMemory | null {
  const m = payload as Partial<MirrorMemory> | null;
  if (!m || (m.refused !== "too_long" && m.refused !== "not_document" && m.refused !== "error") || typeof m.day !== "string") return null;
  return {
    refused: m.refused,
    rev: typeof m.rev === "number" ? m.rev : null,
    day: m.day,
    ...(typeof m.at === "string" ? { at: m.at } : {}),
    ...(typeof m.count === "number" ? { count: m.count } : {}),
  };
}

/** The memory of this row's revision and day, if `memory` is one (a revision or a move forgets it). */
const memoryFor = (memory: MirrorMemory | null | undefined, row: Pick<MirrorRow, "workoutDocRev" | "effectiveDate">): MirrorMemory | null =>
  memory && memory.rev === row.workoutDocRev && memory.day === row.effectiveDate ? memory : null;

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
  /** The pushed build: its version, lock, provisional mark and day; null when it is not a program push's, or gone. */
  build: { version: number; lockedAt: string | null; marked: boolean; date: string | null } | null;
  /** The job's payload, when the read asked for it (`mirrorJobs`' `payloads`: the day's comparison reads the copy's). */
  payload?: unknown;
}

const payloadField = <T>(path: string) => sql<T>`json_extract(${corosWriteJobs.payload}, ${path})`;

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
      provisional: payloadField<number | null>("$.provisional"),
      fromDocRev: payloadField<number | null>("$.fromDocRev"),
      retries: payloadField<number | null>("$.mirrorRetries"),
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
  return rows.map(({ buildId, buildVersion, buildLockedAt, buildMarked, buildDate, payload, ...r }) => ({
    ...r,
    ...(opts.payloads ? { payload: typeof payload === "string" ? JSON.parse(payload) : payload } : {}),
    happenDay: r.happenDay ?? "",
    provisional: Boolean(r.provisional),
    fromDocRev: typeof r.fromDocRev === "number" ? r.fromDocRev : null,
    retries: typeof r.retries === "number" ? r.retries : 0,
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

/** The refusals the row alone answers (no read): the switch, the writes, kept off, not a document, resolved, the window. */
function rowRefusal(row: MirrorRow, env: Env, ctx: BuildCtx): MirrorSkip | null {
  if (!watchPushEnabled(env)) return "switch_off";
  if (!ctx.prefs.corosWritesEnabled) return "writes_off";
  if (row.watchOff) return "kept_off";
  // A run is never a document workout's (the Studio refuses one), nor a rest day or a race; a designed run is the coach
  // lane's (origin null) and mirrors there.
  if (!docOriginRow(row) || row.workoutDoc === null || row.workoutDocRev === null || row.sport === "run" || row.category === "rest" || row.category === "race") {
    return "not_document";
  }
  // Done, skipped, missed or under way: the copy stays as it is (a done session's is what the athlete did).
  if (row.archivedAt !== null || row.completionState !== "scheduled" || row.contentState === "started" || row.contentState === "done") {
    return "resolved";
  }
  if (row.effectiveDate < ctx.today) return "past";
  if (row.effectiveDate > addDays(ctx.today, MIRROR_WINDOW_DAYS)) return "beyond_window";
  return null;
}

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
    const wait = MIRROR_RETRY_BACKOFF_MS[(known.count ?? 1) - 1];
    if (wait === undefined) return { skip: "gave_up" };
    if (Date.parse(known.at ?? "") + wait > Date.parse(ctx.now)) return { skip: "error" };
  } else if (known) {
    return { skip: known.refused };
  }
  const failed = pushes
    .filter((p) => isOneOf(RETRYABLE, p.status) && p.happenDay === row.effectiveDate && (p.fromDocRev === null || p.fromDocRev === row.workoutDocRev))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (failed) {
    const wait = MIRROR_RETRY_BACKOFF_MS[failed.retries];
    if (wait === undefined) return { skip: "gave_up" };
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
 * nothing; a failed push of this revision and day is re-queued on its backoff (M3) rather than replaced; else the record
 * is made (`prepareProvisionalRecord`), and — unless it is too long for the watch, when nothing is written — the
 * previous copy's delete is queued, the record stored, and `push:<recordId>` queued with `provisional: true`.
 *
 * TWO PHASES. The preparation (the reads, the record made, the payload, its check) writes nothing: a throw there is
 * remembered on the row's mark (`error`, on the backoff ladder) and answered `skipped:error`. The writes (the delete, the
 * record, the push) are not caught: a throw there propagates, and nothing is remembered — the next run finds the copy
 * not current and makes it again (the delete already queued is not queued twice).
 *
 * The owed mark is resolved whatever the answer, except with the switch or the writes off or a restore running (they
 * keep it open, so the catch-up finds it). `known` is what the sweep has read already (the jobs, the mark, the restore)
 * and how it settles the marks (`settle`: together, at its end): nothing is read twice. 11 statements for a first copy;
 * a replacement adds the previous copy's delete (`unpushBuild`, 4).
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
 * THE CALLER PROVES THE REST OF A DAY BUILD'S PRECONDITIONS (made with the day's inputs as they hash now, the pre-check
 * answered, not blocked: `mirrorOnDayBuild` asks `lockRefusal` and `checksAnswered`). Here: the row's own refusals — a
 * day's build `dayRowRefusal` (the switch, the writes, kept off, a session the mirror holds on its day — an engine slot
 * among them — resolved or under way or archived, its day), a provisional record `rowRefusal` (… not a document
 * workout, a day gone, beyond the window) — a restore running, `current` when the build is the sent copy already,
 * `already_pushed` when its own push is on its way or verified (nothing written, nothing locked; if another request
 * queues it between that read and the write, the answer is the same, the delete queued and the build locked — the push
 * is the build's), `stale` when the lock is refused (nothing written), `too_long`. Throws when the build is not this
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
  const next: NextCopy = {
    build: { buildId: b.id, ...stored.build },
    version: b.version,
    inputsHash: b.inputsHash,
    provisional: isProvisionalBuild(b),
    fromDocRev: stored.build.fromDoc?.rev ?? null,
    taken: takenOn(jobs, row.effectiveDate, pushJobId(b.id)),
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

// Spelled out (doc-workouts.ts imports this module's importer): a workout started at once — Start now, played offline.
const STARTED_AT_ONCE = ["app_only", "app_only_offline"] as const;

/**
 * The refusals the row alone answers for its day's build (no read): the switch, the writes, kept off; not a session the
 * mirror holds on its day (`not_mirrored`: not the app's — the coach's sessions and designed runs mirror in their own
 * lane — a run, a rest day, a race, or a workout started at once, M5); done, skipped, missed, under way or archived
 * (`resolved`); a day other than today. A document workout and an engine slot alike.
 */
function dayRowRefusal(row: MirrorRow, env: Env, ctx: BuildCtx): MirrorSkip | null {
  if (!watchPushEnabled(env)) return "switch_off";
  if (!ctx.prefs.corosWritesEnabled) return "writes_off";
  if (row.watchOff) return "kept_off";
  if (!appAuthoredRow(row) || row.sport === "run" || row.category === "rest" || row.category === "race" || isOneOf(STARTED_AT_ONCE, row.calendarSyncState)) {
    return "not_mirrored";
  }
  if (row.archivedAt !== null || row.completionState !== "scheduled" || row.contentState === "started" || row.contentState === "done") {
    return "resolved";
  }
  if (row.effectiveDate < ctx.today) return "past";
  if (row.effectiveDate > ctx.today) return "not_today";
  return null;
}

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
 *  - the copy on the watch (`sentOf`): this build's already → `current`; this build's own push live → `already_pushed`;
 *  - none → the build pushed (`pushing`; an adopted row's held copy deleted first — `replacing` then);
 *  - else the build's watch steps, resolved as the copy's were (`watchStepsAsSent`), compared with the copy's
 *    (`sameWatchSteps`; never `pushDigest`, never COROS's fingerprints):
 *     · the same, and the copy is a provisional one verified on the watch at the row's address → HANDED OVER in D1, no
 *       COROS write (`handOver`);
 *     · the same, and the copy is a day build's (a later build with nothing new for the watch) → `same`: it stays;
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
  if (sent === dayBuild.id) return "skipped:current";
  const own = jobs.find((j) => j.id === pushJobId(dayBuild.id));
  if (own && (isOneOf(IN_FLIGHT, own.status) || own.status === "verified")) return "skipped:already_pushed";
  const held = sent === null ? undefined : jobs.find((j) => j.id === pushJobId(sent));
  const copy = held ? programSessionPushJobSchema.safeParse(held.payload) : null;
  if (held && copy?.success) {
    const same = sameWatchSteps((await watchStepsAsSent(db, userId, stored.build, copy.data)).steps, copy.data.session.steps);
    if (same) {
      const provisional = held.build?.marked === true;
      if (!provisional) return "skipped:same";
      const address = watchAddressOf(row);
      const landed = held.status === "verified" && copy.data.happenDay === row.effectiveDate && address?.happenDay === row.effectiveDate;
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
 * THE HAND-OVER (A3): the provisional copy on the watch is the day's build step for step, so the day's build takes it
 * over in D1, with no COROS write, in the only order that keeps one stamp claimed throughout (the import's
 * `pushByStamp`, `verifiedPushOf` by the latest verification; the delete executor supersedes verified pushes by name):
 *  1. the day's build locked (`lockForWatch`: still the slot's newest day build, the slot built, no restore running);
 *  2. `push:<dayBuild>` written `verified` — the copy's payload, its `buildId` and revision the day build's, never
 *     provisional — so it carries the copy's stamp, its day, what its push observed (and noticed), and a rename;
 *  3. the provisional record's marker cleared (`unlockSentBuild`): it is no longer the copy on the watch;
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
 * THE MIRROR SWEEP (§3.7, A5): the hourly's heavy step. The owed sessions first (an open mark, soonest day first), then
 * the window's document workouts (today … today + 28, scheduled, not archived, not kept off, soonest first): each
 * judged (`verdictOf`) with no statement of its own; the first that needs a copy gets ONE `queueProvisionalPush` (or
 * its failed push's re-queue) — `opts.cap` attempts a run, one by design (A5). The owed marks of the sessions it will
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
): Promise<{ queued: number; skipped: Record<string, number> }> {
  if (!watchPushEnabled(env)) return { queued: 0, skipped: { switch_off: 1 } };
  if (!prefs.corosWritesEnabled) return { queued: 0, skipped: { writes_off: 1 } };
  const runCtx: BuildCtx = { ...ctx, prefs };
  const horizon = addDays(ctx.today, MIRROR_WINDOW_DAYS);
  const pw = plannedWorkouts;
  const owedMark = and(eq(syncIntents.id, sql`'mirror-' || ${pw.id}`), eq(syncIntents.userId, userId));
  // `rowRefusal`'s rules, as far as SQL says them: what it would refuse is not read at all, unless it is owed.
  const inWindow = and(
    isNull(pw.archivedAt),
    eq(pw.completionState, "scheduled"),
    inArray(pw.origin, [...DOC_ORIGINS]),
    isNotNull(pw.workoutDoc),
    eq(pw.watchOff, false),
    gte(pw.effectiveDate, ctx.today),
    lte(pw.effectiveDate, horizon),
    sql`coalesce(${pw.sport}, '') <> 'run'`,
    sql`coalesce(${pw.category}, '') not in ('rest', 'race')`,
  );
  const open = and(sql`${syncIntents.id} is not null`, isNull(syncIntents.resolvedAt));
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
    .where(and(eq(pw.userId, userId), or(open, inWindow)))
    .orderBy(sql`case when ${open} then 0 else 1 end`, asc(pw.effectiveDate), asc(pw.effectiveTime), asc(pw.id))
    .limit(SWEEP_ROWS);
  if (candidates.length === 0) return { queued: 0, skipped: {} };
  if (candidates[0]!.restoring) return { queued: 0, skipped: { restoring: 1 } };
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
    const verdict = verdictOf(c.row, pushesOf(jobs, c.row.id), env, runCtx, memory);
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
  return { queued, skipped };
}
