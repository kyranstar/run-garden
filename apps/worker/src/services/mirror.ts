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
 * Every write here is a no-op during a restore (B2): `restoreInProgress` before the record, and the owed marks are
 * resolved by an UPDATE that itself refuses while a restore runs.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
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
  type WatchAddressFields,
} from "@rg/domain";
import { watchPushEnabled, type Env } from "../env.js";
import type { Db } from "./db.js";
import { restoreInProgress } from "./account-state.js";
import { SPENT_STAMP_STATUSES } from "./coros-stamp.js";
import { enqueueUnpushIfOurs } from "./plan-mutations.js";
import {
  DocTooLargeRefusal,
  isProvisionalBuild,
  prepareProvisionalRecord,
  pushJobId,
  sentBuildIdOf,
  type BuildCtx,
  type StoredBuild,
} from "./session-build.js";
import { NO_CATALOG, pushPayloadFor, queuePushJob, watchStepsFromBuild, type PushableBuild } from "./watch-push.js";

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
  | "gave_up";

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
 * What the mirror remembers of a session it could not push for a reason only the record shows (too long for the watch, a
 * document that does not parse) — on its owed mark's payload, for that revision and day, so the sweep does not make the
 * record again every run, and a session too long never holds the window up. A new owed mark, a revision or a move forgets it.
 */
interface MirrorMemory {
  refused: "too_long" | "not_document";
  rev: number | null;
  day: string;
}

// Spelled out, never derived from session-build.ts's constants at load: that module will import this one (Task 5), and
// a cycle can leave an imported constant uninitialised while this module loads.
const SETTLED = ["superseded", "cancelled", "restored"] as const;
const IN_FLIGHT = ["queued", "claimed", "in_progress", "verifying"] as const;
const FAILED = ["failed", "needs_attention"] as const;
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

/** No restore is running for the account: the guard every owed-mark write carries in its own WHERE. */
const notRestoring = (userId: string): SQL =>
  sql`not exists (select 1 from ${accountState} where ${accountState.userId} = ${userId} and coalesce(${accountState.restoreId}, '') <> '')`;

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
  if (!m || (m.refused !== "too_long" && m.refused !== "not_document") || typeof m.day !== "string") return null;
  return { refused: m.refused, rev: typeof m.rev === "number" ? m.rev : null, day: m.day };
}

// ── The jobs the mirror reads ────────────────────────────────────────────────────────────────────────────────────

/** A stamping job, as the mirror reads it: a row's pushes for the current-copy test, a day's stamps for the new one. */
export interface MirrorJob extends PushRow {
  workoutId: string;
  kind: string;
  name: string | null;
}

const payloadField = <T>(path: string) => sql<T>`json_extract(${corosWriteJobs.payload}, ${path})`;

/**
 * ONE READ for both the current-copy test and the new copy's stamp: every stamping job of the account (both lanes) whose
 * stamp is not spent (`takenStampsOn`'s rule), within `scope` — the row's own pushes, and the jobs on the days a new copy
 * may take a stamp on.
 */
async function mirrorJobs(db: Db, userId: string, scope: SQL): Promise<MirrorJob[]> {
  const rows = await db
    .select({
      id: corosWriteJobs.id,
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
    })
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.kind, [...STAMPING_JOB_KINDS]),
        notInArray(corosWriteJobs.status, [...SPENT_STAMP_STATUSES]),
        scope,
      ),
    );
  return rows.map((r) => ({
    ...r,
    happenDay: r.happenDay ?? "",
    provisional: Boolean(r.provisional),
    fromDocRev: typeof r.fromDocRev === "number" ? r.fromDocRev : null,
    retries: typeof r.retries === "number" ? r.retries : 0,
  }));
}

/** The row's own program pushes, settled ones aside. */
const pushesOf = (jobs: readonly MirrorJob[], workoutId: string): PushRow[] =>
  jobs.filter((j) => j.workoutId === workoutId && j.kind === "program_session_push" && !isOneOf(SETTLED, j.status));

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
 * What the mirror does for this row now, from the row, its pushes and its memory (pure): a refusal; the re-queue of its
 * failed push (M3: same revision and day, its backoff over, fewer than three re-queues); or a new copy.
 */
function verdictOf(row: MirrorRow, pushes: readonly PushRow[], env: Env, ctx: BuildCtx, memory: MirrorMemory | null): Verdict {
  const refused = rowRefusal(row, env, ctx);
  if (refused) return { skip: refused };
  if (currentCopy(row, pushes, ctx.today)) return { skip: "current" };
  if (memory && memory.rev === row.workoutDocRev && memory.day === row.effectiveDate) return { skip: memory.refused };
  const failed = pushes
    .filter((p) => isOneOf(FAILED, p.status) && p.happenDay === row.effectiveDate && (p.fromDocRev === null || p.fromDocRev === row.workoutDocRev))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (failed) {
    const wait = MIRROR_RETRY_BACKOFF_MS[failed.retries];
    if (wait === undefined) return { skip: "gave_up" };
    if (Date.parse(failed.updatedAt) + wait > Date.parse(ctx.now)) return { skip: "backoff" };
    return { retry: failed };
  }
  return { push: true };
}

/** The failed push queued afresh (M3): the same job, payload and stamp; the executor's retries reset, the re-queue counted. */
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
    .where(and(eq(corosWriteJobs.id, push.id), inArray(corosWriteJobs.status, [...FAILED])))
    .returning({ id: corosWriteJobs.id });
  return done.length > 0;
}

// ── The copy replaced ────────────────────────────────────────────────────────────────────────────────────────────

interface NextCopy {
  build: PushableBuild;
  inputsHash: string;
  provisional: boolean;
  fromDocRev: number | null;
  /** The day's stamps when the caller read them (with its jobs); read by `pushPayloadFor` otherwise. */
  taken?: ReadonlySet<string>;
  /** The build's push as the caller knows it (null: none); read by `pushPayloadFor` otherwise. */
  earlier?: null;
  /** The row's sent build when the caller knows it (none: the row has no live push); read otherwise. */
  sent?: string | null;
  /** The record's insert, made after the previous copy's delete is queued (a provisional record not yet stored). */
  store?: () => Promise<unknown>;
  /** A day's build is locked as Send locks it (the watch holds what was played); a provisional record never is. */
  lock: boolean;
}

/**
 * THE PREVIOUS COPY'S DELETE, THEN THE NEW PUSH (one copy per session). Nothing is written when the build cannot go to
 * the watch (`too_long`: more steps than it holds, or none). Then the payload (the steps against today's catalog, the
 * day's free stamp), the previous copy's delete (`enqueueUnpushIfOurs`: an adopted row's held copy, the sent build's
 * unpush — or, for a push still queued, its supersede), the record, the lock, the push.
 */
async function replaceCopy(db: Db, userId: string, row: MirrorRow, next: NextCopy, ctx: BuildCtx): Promise<"queued" | "skipped:too_long"> {
  if (watchStepsFromBuild(next.build, NO_CATALOG).refusal) return "skipped:too_long";
  const made = await pushPayloadFor(db, userId, row, next.build, next.earlier, {
    ...(next.taken ? { taken: next.taken } : {}),
    provisional: next.provisional,
    fromDocRev: next.fromDocRev,
  });
  // As Send checks it: a payload the lane would fail as malformed is never queued (nor anything before it written).
  const payload = programSessionPushJobSchema.parse(made.payload);
  await enqueueUnpushIfOurs(db, userId, row, ctx.now, ctx.prefs, next.sent !== undefined ? { sent: next.sent } : undefined);
  await next.store?.();
  if (next.lock) {
    await db
      .update(sessionBuilds)
      .set({ lockedAt: ctx.now })
      .where(and(eq(sessionBuilds.id, next.build.buildId), isNull(sessionBuilds.lockedAt)));
  }
  await queuePushJob(db, userId, row, next.build.buildId, next.inputsHash, payload, ctx.now);
  return "queued";
}

/**
 * QUEUE THE ROW'S PROVISIONAL COPY (§3.2): the refusals first, in this order — the switch (`switch_off`), the writes
 * (`writes_off`), kept off, not a document workout (or a run, a rest day, a race), resolved (done, skipped, missed, under
 * way, archived), a day gone (`past`), beyond the window, and a copy already current (A7) — then, a restore running,
 * nothing; a failed push of this revision and day is re-queued on its backoff (M3) rather than replaced; else the record
 * is made (`prepareProvisionalRecord`), and — unless it is too long for the watch, when nothing is written — the
 * previous copy's delete is queued, the record stored, and `push:<recordId>` queued with `provisional: true`.
 *
 * The owed mark is resolved whatever the answer, except with the switch or the writes off or a restore running (they
 * keep it open, so the catch-up finds it). `known` is what the sweep has read already (the jobs, the mark): nothing is
 * read twice. At most 12 statements for a first copy; a replacement adds the previous copy's delete (`unpushBuild`).
 */
export async function queueProvisionalPush(
  db: Db,
  env: Env,
  userId: string,
  row: MirrorRow,
  ctx: BuildCtx,
  known: { jobs?: readonly MirrorJob[]; owed?: boolean; memory?: MirrorMemory | null } = {},
): Promise<MirrorAnswer> {
  const finish = async (answer: MirrorAnswer, memory?: MirrorMemory): Promise<MirrorAnswer> => {
    if (answer === "skipped:switch_off" || answer === "skipped:writes_off" || answer === "skipped:restoring") return answer;
    if (memory) await remember(db, userId, row.id, ctx.now, memory);
    else if (known.owed !== false) await resolveOwed(db, userId, [row.id], ctx.now);
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
  if (await restoreInProgress(db, userId)) return "skipped:restoring";
  // Re-queued — or, when another request changed the push since it was read (queued or claimed it), on its way already.
  if ("retry" in verdict) return finish((await requeueFailed(db, verdict.retry, ctx.now)) ? "queued" : "skipped:current");

  const rev = row.workoutDocRev!;
  const memory = (why: MirrorMemory["refused"]): MirrorMemory => ({ refused: why, rev, day: row.effectiveDate });
  const doc = parseStoredWorkoutDoc(row.workoutDoc);
  if (!doc || isRunDoc(doc)) return finish("skipped:not_document", memory("not_document"));
  let record: Awaited<ReturnType<typeof prepareProvisionalRecord>>;
  try {
    record = await prepareProvisionalRecord(db, userId, row, doc, rev, ctx);
  } catch (e) {
    if (e instanceof DocTooLargeRefusal) return finish("skipped:too_long", memory("too_long"));
    throw e;
  }
  const answer = await replaceCopy(
    db,
    userId,
    row,
    {
      build: { buildId: record.buildId, ...record.stored.build },
      inputsHash: record.stored.build.inputsHash,
      provisional: true,
      fromDocRev: rev,
      taken: takenOn(jobs, row.effectiveDate, pushJobId(record.buildId)),
      earlier: null,
      // No live push: nothing is sent (`sentBuildIdOf` names only a build with one), so it is not read again.
      ...(pushes.length === 0 ? { sent: null } : {}),
      store: record.insert,
      lock: false,
    },
    ctx,
  );
  return answer === "queued" ? finish(answer) : finish(answer, memory("too_long"));
}

/**
 * REPLACE THE COPY ON THE WATCH WITH `newBuildId` (§3.3; Task 5 calls it with a day's build): the current sent copy's
 * delete (`enqueueUnpushIfOurs`: the sent build's unpush — a queued push superseded — or an adopted row's held copy), then
 * the new build's push, the build locked first when it is a day's build (a provisional record never is). Refused with
 * the switch or the writes off, kept off, a restore running, a build too long for the watch; `current` when the build
 * is the sent copy already. Throws when the build is not this row's.
 */
export async function queueReplacement(db: Db, env: Env, userId: string, row: MirrorRow, newBuildId: string, ctx: BuildCtx): Promise<MirrorAnswer> {
  if (!watchPushEnabled(env)) return "skipped:switch_off";
  if (!ctx.prefs.corosWritesEnabled) return "skipped:writes_off";
  if (row.watchOff) return "skipped:kept_off";
  if (await restoreInProgress(db, userId)) return "skipped:restoring";
  const [b] = await db
    .select()
    .from(sessionBuilds)
    .where(and(eq(sessionBuilds.id, newBuildId), eq(sessionBuilds.userId, userId), eq(sessionBuilds.workoutId, row.id)))
    .limit(1);
  if (!b) throw new Error(`queueReplacement: build ${newBuildId} is not this session's`);
  if ((await sentBuildIdOf(db, row.id)) === b.id) return "skipped:current";
  const stored = b.payload as unknown as StoredBuild;
  return replaceCopy(
    db,
    userId,
    row,
    {
      build: { buildId: b.id, ...stored.build },
      inputsHash: b.inputsHash,
      provisional: isProvisionalBuild(b),
      fromDocRev: stored.build.fromDoc?.rev ?? null,
      lock: b.version > 0,
    },
    ctx,
  );
}

// ── The sweep ────────────────────────────────────────────────────────────────────────────────────────────────────

/** At most this many sessions are judged a run (bound variables; the window's farthest days wait for a later run). */
const SWEEP_ROWS = 60;

/**
 * THE MIRROR SWEEP (§3.7, A5): the hourly's heavy step. The owed sessions first (an open mark, soonest day first), then
 * the window's document workouts (today … today + 28, scheduled, not archived, not kept off, soonest first): each
 * judged (`verdictOf`) with no statement of its own; the first that needs a copy gets ONE `queueProvisionalPush` (or
 * its failed push's re-queue) — `opts.cap` attempts a run, one by design (A5). The owed marks of the sessions it will
 * never push (kept off, resolved, beyond the window, current, …) are resolved together, in one statement. Writes off or
 * the switch off: nothing read, nothing queued, the marks kept. ≤ 15 statements for one record.
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
    .select({ row: pw, intentResolvedAt: syncIntents.resolvedAt, intentId: syncIntents.id, intentPayload: syncIntents.payload })
    .from(pw)
    .leftJoin(syncIntents, owedMark)
    .where(and(eq(pw.userId, userId), or(open, inWindow)))
    .orderBy(sql`case when ${open} then 0 else 1 end`, asc(pw.effectiveDate), asc(pw.effectiveTime), asc(pw.id))
    .limit(SWEEP_ROWS);
  if (candidates.length === 0) return { queued: 0, skipped: {} };
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
    const answer = await queueProvisionalPush(db, env, userId, c.row, runCtx, { jobs, owed, memory });
    if (answer === "queued") queued += 1;
    else count(answer.slice("skipped:".length));
  }
  await resolveOwed(db, userId, settle, ctx.now);
  return { queued, skipped };
}
