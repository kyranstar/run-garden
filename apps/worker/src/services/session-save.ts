/**
 * SAVING A PERFORMED SESSION, EXACTLY ONCE (Phase 2 spec §2b "Review and save"; programme spec §9.2, §10.6;
 * rulings 2b-R3 and the Phase 0 audit 1 ingest #3 merge rule). `PUT /api/sessions/performed/:id` lands here, from the
 * player's outbox, as often as the outbox needs.
 *
 *  1. Idempotent by the client's id and the payload's hash (sha256 of the canonical JSON of the body as sent — the
 *     hash the outbox keys its entry by, never this server's re-parse, audit 2b-A M-6): the same id with the same
 *     hash → `same_payload`, nothing written; with another hash →
 *     `conflict`, nothing written. Only the app's own saves come here (`source = 'app'`), always for a slot of this
 *     user's (an app session always has a row: on-demand sessions have one too) — and the quick review after a watch
 *     session (`source = 'watch_review'`, Phase 3), which takes the same idempotency and is saved by
 *     session-watch-review.ts on the watch's own activity.
 *  2. Everything is read and decided first; then every write lands in ONE transaction (D1's batch; audit 2b-A M-3):
 *     `performed_sessions` marked `pending`, `performed_sets` (weights as typed + kg) and the session's checks (`post`,
 *     and a `pre` the sheet has not already recorded for the slot and day), everything below, and the real hash last
 *     as the commit marker. A save that dies part-way leaves nothing; a row an older deploy left `pending` is redone
 *     by the retry. A lock per session id makes a second request for the same session wait (`busy`) instead of
 *     interleaving, and the COROS ingest's lock keeps a save and an ingest from both inserting the one session
 *     (audit 2b-A M-7).
 *  3. The activity: normally a new `activities` row with `id = performedId`, `source = 'app'`, the sport of §9.2 (the
 *     locked build holds a core lift → strength, else yoga), the start in UTC and on the athlete's clock, the slot's
 *     title, plus an `app` source link. When the watch's copy of the same session arrived first (a COROS row within an
 *     hour, the same session by the adoption scorer, a mobility session the watch filed as Strength included), the
 *     save joins that activity instead — one physical session, one activity: COROS keeps its metrics and its id, the
 *     row takes the app's title and sport, and the watch's own performed session for it is deleted (ruling 2b-R3).
 *  4. The slot's match (`app_session`, confidence 1). The app's save supersedes the matcher's automatic guesses —
 *     another activity on this slot, the joined watch activity on another slot — but never a manual match (ruling
 *     2b-R5, `planMatch`); when it cannot match, the save still lands and says why. The slot → `completed` on the
 *     session's day, `content_state = 'done'`, its discipline the build's.
 *  5. The review: ratings and "not for me" → `exercise_prefs`, the new move's first day; an accepted graduation →
 *     the block's lift (once: a retried save finds the lift already switched).
 *  6. The garden replays from the earliest day the save touched: the slot's, the session's, a displaced activity's
 *     or a reopened slot's. That day is recorded in the save's own transaction, and the replay is one capped catch-up
 *     step (ruling 2b-R7): a long walk finishes on later garden reads, and a replay killed after the commit is not
 *     lost (audit 2b-A M-5). The session's day must be a started build's — the locked one, or one un-started since
 *     (ruling 2b-R19); the payload's own when it names one (re-review 2b-B2 M-2) — (the slot's, when none was ever
 *     started) or the next, and not after tomorrow (422); a slot moved after Start still saves.
 *
 * Never writes to COROS (an app session is never pushed to the watch in 2b). Every write waits for the restore
 * marker to be clear. Every statement stays under D1's 100 bound variables.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  activities,
  activitySourceLinks,
  conditionChecks,
  exercisePrefs,
  performedSessions,
  performedSets,
  plannedWorkouts,
  programBlocks,
  sessionBuilds,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  canonicalJson,
  coreBlockIntentSchema,
  isLocalDate,
  performedSessionSaveSchema,
  todayInZone,
  toKg,
  type PerformedSessionWire,
  type SourceActivity,
  type UserPreferences,
} from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { ORPHAN_ADOPTION_FLOOR, scoreAgainstStoredRow } from "@rg/providers";
import { Blocks } from "@rg/session-engine";
import type { ZodIssue } from "zod";
import { sha256Hex } from "../auth/crypto.js";
import { restoreInProgress } from "./account-state.js";
import { ROLLING_WINDOW_DAYS } from "./backfill.js";
import { chunkIds, insertBatches, runAtomically, type AtomicStatement, type Db } from "./db.js";
import { loadEngineContext, loadProgramState } from "./engine-inputs.js";
import { gardenChangeStatement, resimulateFrom } from "./garden-sync.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { engineDataFor, sentBuildIdOf, SessionNotFoundError, UNSTARTED_AT_PATH } from "./session-build.js";
import { saveWatchReview } from "./session-watch-review.js";
import { PENDING_HASH, removeWatchSessionStatements, WATCH_SOURCE } from "./watch-sets.js";

/**
 * What a save says beside the session, when something did not go the usual way. `superseded_auto_match`: the matcher's
 * own guess — this slot completed by another activity, or the joined watch activity filed on another slot — gave way
 * to this session (ruling 2b-R5; the other activity counts as extra training, the other slot is open again).
 */
export type SaveNote = "slot_already_matched" | "activity_matched_elsewhere" | "slot_gone" | "graduation_skipped" | "superseded_auto_match";

export type SaveOutcome =
  | { status: "saved"; performedId: string; activityId: string; matched: boolean; notes: SaveNote[] }
  | { status: "same_payload" }
  | { status: "conflict" }
  /** Another app session of this slot is saved already — played on another device (ruling 2b-R18). */
  | { status: "slot_done" }
  | { status: "restoring" }
  | { status: "busy" };

export class InvalidSaveError extends Error {
  constructor(public readonly issues: ReadonlyArray<Pick<ZodIssue, "message"> & Partial<ZodIssue>>) {
    super("invalid_save");
  }
}

export interface SaveCtx {
  now: string;
  prefs: UserPreferences;
  /**
   * The watch switch (`WATCH_PUSH_ENABLED`) is on: a watch review (`source: "watch_review"`) may be saved. Off — or
   * absent — it is refused 422 as before Phase 3 (audit 3-B S-5); the outbox keeps the entry (Retry) for when it is on.
   */
  watchReviews?: boolean;
}

type SlotRow = typeof plannedWorkouts.$inferSelect;
type ActivityRow = typeof activities.$inferSelect;

/** A UTC instant as activity rows store it (`2026-10-06T19:05:00Z`), and the athlete's wall clock then. */
export function startOf(p: PerformedSessionWire, timezone: string): { startTime: string; startTimeLocal: string; elapsedSeconds: number | null } {
  const started = p.startedAt
    ? DateTime.fromISO(p.startedAt, { zone: "utc" })
    : p.endedAt
      ? DateTime.fromISO(p.endedAt, { zone: "utc" }).minus({ seconds: p.seconds })
      : DateTime.fromISO(`${p.localDate}T12:00`, { zone: timezone }).toUTC();
  const ended = p.endedAt ? DateTime.fromISO(p.endedAt, { zone: "utc" }) : null;
  return {
    startTime: started.toUTC().toISO({ suppressMilliseconds: true })!,
    startTimeLocal: started.setZone(timezone).toFormat("yyyy-LL-dd'T'HH:mm:ss"),
    elapsedSeconds: p.startedAt && ended ? Math.max(0, Math.round(ended.diff(started, "seconds").seconds)) : null,
  };
}

/**
 * The slot's STARTED builds and the days they were made for (`payload.build.date`, read in SQL): the locked one, and
 * builds started once and un-started since (`$.unstartedAt`, kept on record — ruling 2b-R19) — the days a session of
 * the slot was started, whatever day the slot shows now. Empty when no build of the slot was ever started (ruling 2b-R7
 * as amended).
 */
async function startedBuilds(db: Db, userId: string, workoutId: string): Promise<Array<{ id: string; date: string }>> {
  const rows = await db
    .select({ id: sessionBuilds.id, date: sql<string | null>`json_extract(${sessionBuilds.payload}, '$.build.date')` })
    .from(sessionBuilds)
    .where(
      and(
        eq(sessionBuilds.workoutId, workoutId),
        eq(sessionBuilds.userId, userId),
        or(isNotNull(sessionBuilds.lockedAt), sql`json_extract(${sessionBuilds.payload}, ${UNSTARTED_AT_PATH}) is not null`),
      ),
    );
  return rows.flatMap((r) => (typeof r.date === "string" && isLocalDate(r.date) ? [{ id: r.id, date: r.date }] : []));
}

/**
 * Ruling 2b-R18, extended by 3-R8: a slot holds at most one app session or watch review. Another one of it already saved — played on another device (a
 * device's own outbox holds one save per slot) — refuses this one: never a second performed session and activity for
 * one slot. Read under the merge locks every save of this user takes, so two devices' saves cannot both pass it. A
 * watch's or an import's session of the slot is not the app's, and leaves it to the save (ruling 2b-R3).
 */
export async function savedByAnother(db: Db, userId: string, workoutId: string, performedId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: performedSessions.id })
    .from(performedSessions)
    .where(
      and(
        eq(performedSessions.userId, userId),
        eq(performedSessions.workoutId, workoutId),
        inArray(performedSessions.source, ["app", "watch_review"]),
        ne(performedSessions.id, performedId),
        ne(performedSessions.payloadHash, PENDING_HASH),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** §9.2 from the locked build: a core lift → strength, else yoga; read in SQL, never parsing the payload here. */
async function disciplineOf(db: Db, userId: string, slot: SlotRow, buildId: string | null): Promise<"strength" | "yoga"> {
  if (buildId) {
    const [row] = await db
      .select({
        core: sql<number>`exists (select 1 from json_each(${sessionBuilds.payload}, '$.build.items') where json_extract(value, '$.block') = 'core')`,
      })
      .from(sessionBuilds)
      .where(and(eq(sessionBuilds.id, buildId), eq(sessionBuilds.userId, userId), eq(sessionBuilds.workoutId, slot.id)))
      .limit(1);
    if (row) return row.core ? "strength" : "yoga";
  }
  return slot.category === "strength" || slot.sport === "strength" ? "strength" : "yoga";
}

/**
 * The watch's copy of this session, when it arrived first: a COROS activity of this user within an hour of the start,
 * not imported, not already some other non-watch session's, that the adoption scorer calls the same session (the
 * watch files a mobility session as Strength: an app yoga session pairs with it). Null when there is none.
 */
async function watchCopy(
  db: Db,
  userId: string,
  performedId: string,
  startTime: string,
  seconds: number,
  discipline: "strength" | "yoga",
): Promise<ActivityRow | null> {
  const at = Date.parse(startTime);
  const near = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        gte(activities.startTime, new Date(at - 3_600_000).toISOString()),
        lte(activities.startTime, new Date(at + 3_600_000).toISOString()),
        isNotNull(activities.corosActivityId),
        ne(activities.source, "import"),
      ),
    );
  if (near.length === 0) return null;
  const owned = new Set(
    (
      await db
        .select({ activityId: performedSessions.activityId })
        .from(performedSessions)
        .where(
          and(
            eq(performedSessions.userId, userId),
            inArray(
              performedSessions.activityId,
              near.map((a) => a.id),
            ),
            ne(performedSessions.source, WATCH_SOURCE),
            ne(performedSessions.id, performedId),
          ),
        )
    ).map((r) => r.activityId),
  );
  let best: ActivityRow | null = null;
  let bestScore = 0;
  for (const a of near) {
    if (owned.has(a.id)) continue;
    const pairs = a.sport === discipline || (discipline === "yoga" && a.sport === "strength");
    if (!pairs) continue;
    const src: SourceActivity = {
      provider: "coros",
      providerActivityId: a.corosActivityId!,
      startTime: a.startTime,
      sport: a.sport,
      durationSeconds: a.durationSeconds,
      ...(a.distanceMeters != null ? { distanceMeters: a.distanceMeters } : {}),
      contentFingerprint: "",
    };
    const { score } = scoreAgainstStoredRow(src, { startTime, sport: a.sport, durationSeconds: seconds });
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best && bestScore >= ORPHAN_ADOPTION_FLOOR ? best : null;
}

/** The session's sets as `performed_sets` rows: weights exactly as typed plus kg. */
export function setRows(performedId: string, p: PerformedSessionWire) {
  return p.entries.flatMap((e, entryIndex) =>
    e.sets.map((s, i) => ({
      id: `${performedId}:${entryIndex}:${i}`,
      performedSessionId: performedId,
      entryIndex,
      exerciseId: e.exerciseId,
      implement: e.implement,
      format: e.format,
      perSide: e.perSide,
      setIndex: s.setIndex,
      side: s.side,
      reps: s.reps,
      seconds: s.seconds,
      loadValue: s.load?.v ?? null,
      loadUnit: s.load?.u ?? null,
      loadKg: s.load ? toKg(s.load) : null,
      done: s.done,
      flags: [...s.flags],
    })),
  );
}

let libraryIds: Set<string> | undefined;

/**
 * The review's preferences: each touched exercise's row as it will be (ratings, "not for me", the new move's first
 * day), upserted whole so one statement serves every field. Read now; the statements run with the rest of the save.
 */
export async function prefStatements(db: Db, userId: string, p: PerformedSessionWire, now: string): Promise<AtomicStatement[]> {
  // Only the library's exercises: a key it does not have is junk (a bug, a hand-made PUT), never a row (audit 2b-A M-4).
  libraryIds ??= new Set(EXERCISES.map((e) => e.id));
  const ids = [...new Set([...Object.keys(p.review.ratings), ...Object.keys(p.review.excluded), ...(p.newMove ? [p.newMove] : [])])]
    .filter((id) => libraryIds!.has(id))
    .sort();
  if (ids.length === 0) return [];
  const existing = new Map<string, typeof exercisePrefs.$inferSelect>();
  for (const batch of chunkIds(ids)) {
    for (const r of await db.select().from(exercisePrefs).where(and(eq(exercisePrefs.userId, userId), inArray(exercisePrefs.exerciseId, batch)))) {
      existing.set(r.exerciseId, r);
    }
  }
  const rows = ids.map((exerciseId) => {
    const cur = existing.get(exerciseId);
    return {
      id: `${userId}:${exerciseId}`,
      userId,
      exerciseId,
      rating: exerciseId in p.review.ratings ? p.review.ratings[exerciseId]! : (cur?.rating ?? null),
      excluded: exerciseId in p.review.excluded ? p.review.excluded[exerciseId]! : (cur?.excluded ?? false),
      pinned: cur?.pinned ?? false,
      introducedOn: cur?.introducedOn ?? (exerciseId === p.newMove ? p.localDate : null),
      updatedAt: now,
    };
  });
  return insertBatches(rows).map((batch) =>
    db
      .insert(exercisePrefs)
      .values(batch)
      .onConflictDoUpdate({
        target: exercisePrefs.id,
        set: {
          rating: sql`excluded.rating`,
          excluded: sql`excluded.excluded`,
          introducedOn: sql`excluded.introduced_on`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}

/**
 * Accepted graduations on the program's block — only the block the session belonged to, and only where its lift is not
 * already the one asked for (a retried save never doubles a rotation). The candidates are judged with the session's
 * place's gear, as the review offered them. Read and decided now; the block's update runs with the rest of the save.
 */
async function graduationStatements(
  db: Db,
  userId: string,
  slot: SlotRow,
  p: PerformedSessionWire,
  now: string,
): Promise<{ applied: boolean; statements: AtomicStatement[] }> {
  if (p.review.graduations.length === 0) return { applied: true, statements: [] };
  let block = await loadProgramState(db, slot.planId);
  if (!block || (p.blockRef !== null && block.id !== p.blockRef)) return { applied: false, statements: [] };
  const pending = p.review.graduations.filter((g) => block!.core[g.family] !== g.to);
  if (pending.length === 0) return { applied: true, statements: [] };
  const context = await loadEngineContext(db, userId, slot.planId, p.locationId ? { locationId: p.locationId } : {});
  const data = engineDataFor(context.activeProfiles, context.careProfiles);
  let applied = true;
  for (const g of pending) {
    const next = Blocks.graduate(data, block, g.family, g.to, p.localDate, context.location.equipment);
    if (next === block) applied = false;
    block = next;
  }
  // The block came from its stored row (loadProgramState), so this is saveProgramState's update of that row.
  const intent = coreBlockIntentSchema.parse({ core: block.core, rotations: block.rotations });
  return {
    applied,
    statements: [db.update(programBlocks).set({ intent, weeks: block.weeks, updatedAt: now }).where(eq(programBlocks.id, block.id))],
  };
}

/**
 * The COROS ingest's locks a save takes around its "is the watch's copy here yet?" look and its writes (audit 2b-A
 * M-7). The ingest looks for an app row to adopt, then inserts its own; the save looks for a COROS row to join, then
 * inserts its own. Run at the same moment, both would find nothing and the one session would stay two activities for
 * good (adoption only runs for a new source). The read-now, the hourly sweep and the heal ingest under `coros_read`
 * (the last 14 days); the deep backfill ingests older days under `coros_backfill`, so a session that old waits for that
 * too. Claims never wait (`claimUserLock` answers at once), so nothing can deadlock: a save that finds one held answers
 * `busy` and the outbox retries; a read that finds the save's claim answers `busy` and the next read or hourly sweep
 * reads it. The save holds them only for its look and its one transaction.
 */
const MERGE_LOCKS = { read: { kind: "coros_read", staleMinutes: 5 }, backfill: { kind: "coros_backfill", staleMinutes: 15 } } as const;

export async function claimMergeLocks(
  db: Db,
  userId: string,
  localDate: string,
  today: string,
): Promise<Array<{ kind: string; token: string }> | null> {
  // The backfill's newest chunk ends ROLLING_WINDOW_DAYS before today; a day's margin for the clock and the zone.
  const wanted = localDate <= addDays(today, -(ROLLING_WINDOW_DAYS - 1)) ? [MERGE_LOCKS.read, MERGE_LOCKS.backfill] : [MERGE_LOCKS.read];
  const held: Array<{ kind: string; token: string }> = [];
  for (const { kind, staleMinutes } of wanted) {
    const token = await claimUserLock(db, userId, kind, staleMinutes);
    if (!token) {
      await releaseMergeLocks(db, userId, held);
      return null;
    }
    held.push({ kind, token });
  }
  return held;
}

export async function releaseMergeLocks(db: Db, userId: string, held: ReadonlyArray<{ kind: string; token: string }>): Promise<void> {
  for (const { kind, token } of held) await releaseUserLock(db, userId, kind, token).catch(() => undefined);
}

/** `PUT /api/sessions/performed/:id`. Throws `InvalidSaveError` (422) and `SessionNotFoundError` (404). */
export async function savePerformedSession(db: Db, userId: string, performedId: string, body: unknown, ctx: SaveCtx): Promise<SaveOutcome> {
  const parsed = performedSessionSaveSchema.safeParse(body);
  if (!parsed.success) throw new InvalidSaveError(parsed.error.issues);
  const p = parsed.data;
  if (p.id !== performedId) throw new InvalidSaveError([{ message: "the payload's id is not the address's", path: ["id"] }]);
  if (p.source === "import") throw new InvalidSaveError([{ message: "an import is not saved here", path: ["source"] }]);
  if (p.workoutId === null) throw new InvalidSaveError([{ message: "an app session names its slot", path: ["workoutId"] }]);
  // The client's own hash: over the body as sent (the client sends its fully parsed payload), never over this server's
  // re-parse of it — a deploy that adds a defaulted field must not turn a retry of a committed save into a conflict
  // (audit 2b-A M-6).
  const hash = await sha256Hex(canonicalJson(body));
  const today = todayInZone(ctx.prefs.timezone, new Date(ctx.now));

  const stored = async () =>
    (
      await db
        .select({ userId: performedSessions.userId, payloadHash: performedSessions.payloadHash, activityId: performedSessions.activityId })
        .from(performedSessions)
        .where(eq(performedSessions.id, performedId))
        .limit(1)
    )[0];
  const settled = (row: Awaited<ReturnType<typeof stored>>): SaveOutcome | null => {
    if (!row) return null;
    if (row.userId !== userId) return { status: "conflict" };
    if (row.payloadHash === PENDING_HASH) return null;
    return row.payloadHash === hash ? { status: "same_payload" } : { status: "conflict" };
  };
  const early = settled(await stored());
  if (early) return early;
  // The quick review after a watch session (Phase 3, spec §5): a session on the watch's own activity. While the switch
  // is off, refused as every non-app session was before Phase 3 (audit 3-B S-5) — after the settled check, so a
  // review saved while on still answers `same_payload` to its own retry.
  if (p.source === "watch_review") {
    if (!ctx.watchReviews) throw new InvalidSaveError([{ message: "only the app's own sessions are saved here", path: ["source"] }]);
    return saveWatchReview(db, userId, p, hash, { ...ctx, today });
  }

  const [slot] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, p.workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!slot || (slot.origin !== "program" && slot.origin !== "on_demand")) throw new SessionNotFoundError();
  // Ruling 2b-R7 as amended (audit 2b-A I-4): the session's day is the day its LOCKED build was built and started for
  // — or the next, for a session that ran past midnight — and never after tomorrow. A build started once and
  // un-started since counts too (ruling 2b-R19): another device's save made from it may drain after the Discard and a
  // move. A save naming one of those builds takes THAT build's day only (re-review 2b-B2 M-2); any started build's day
  // answers only a save naming none. The slot's own date answers only when no build was ever started: a slot moved
  // between Start and the outbox's drain must still save. Anything else is a wrong clock or a bug, and would replay the
  // garden from wherever it says.
  const started = await startedBuilds(db, userId, slot.id);
  const own = p.buildId === null ? undefined : started.find((b) => b.id === p.buildId);
  // A SENT build COROS moved (Phase 3, spec §4.5): the import adopts the move, the build stays locked, and the
  // session's day is the slot's new one — the watch session happens there, and so may the app's.
  const sentId = started.length > 0 ? await sentBuildIdOf(db, slot.id) : null;
  const sentMoved = sentId !== null && (own === undefined || own.id === sentId);
  const days =
    started.length > 0
      ? [...new Set([...(own ? [own.date] : started.map((b) => b.date)), ...(sentMoved ? [slot.effectiveDate] : [])])].sort()
      : [slot.effectiveDate];
  const sessionDay = days.find((d) => p.localDate >= d && p.localDate <= addDays(d, 1));
  if (sessionDay === undefined || p.localDate > addDays(today, 1)) {
    const whose = own ? "its build's" : started.length > 0 ? "a started build's" : "its slot's";
    throw new InvalidSaveError([
      { message: `the session's day must be ${whose} (${days.join(", ")}) or the next, and not after tomorrow`, path: ["localDate"] },
    ]);
  }
  const builtOn = started.length > 0 ? sessionDay : null;
  if (await restoreInProgress(db, userId)) return { status: "restoring" };

  const lockKind = `save:${performedId}`;
  const token = await claimUserLock(db, userId, lockKind, 1);
  if (!token) return { status: "busy" };
  let written: Written;
  try {
    // What another request committed while this one waited for the lock is the answer.
    const existing = await stored();
    const decided = settled(existing);
    if (decided) return decided;
    const merge = await claimMergeLocks(db, userId, p.localDate, today);
    if (!merge) return { status: "busy" };
    try {
      // A restore can begin while this one read; checked again just before the first write.
      if (await restoreInProgress(db, userId)) return { status: "restoring" };
      if (await savedByAnother(db, userId, slot.id, performedId)) return { status: "slot_done" };
      written = await write(db, userId, p, hash, slot, builtOn, existing?.activityId ?? null, ctx);
    } finally {
      await releaseMergeLocks(db, userId, merge);
    }
  } finally {
    await releaseUserLock(db, userId, lockKind, token);
  }
  // The garden replays from the earliest day the save touched. That day went on record with the save (its
  // transaction), so this is one capped catch-up step (ruling 2b-R7): a long walk stops at SAVE_REPLAY_MAX_DAYS and
  // the next garden read or the hourly cron walks on; a step killed part-way leaves the record for the next one
  // (audit 2b-A M-5). It stands down by itself while a restore runs.
  await resimulateFrom(db, userId, written.replayFrom, ctx.prefs, new Date(ctx.now), { maxResimDays: SAVE_REPLAY_MAX_DAYS }).catch(
    () => undefined,
  );
  return written.outcome;
}

/**
 * The matches the ingest's matcher makes by itself (completion.ts): the only ones an app session supersedes (ruling
 * 2b-R5 — its "time-based" match is `scored_auto`). Anything else — `manual`, another `app_session`, a method this
 * code does not know — was someone's decision, and stands.
 */
const AUTOMATIC_MATCHES: ReadonlySet<string> = new Set(["scored_auto", "coros_plan_link"]);

/** The slot's match as the save will leave it: the decision, read now, and its statements. */
interface MatchPlan {
  matched: boolean;
  notes: SaveNote[];
  statements: AtomicStatement[];
  /** Days the garden must replay from as well: a displaced activity's day, a reopened slot's day (2b-R5, 2b-R7). */
  alsoFrom: string[];
}

const localDayOf = (a: Pick<ActivityRow, "startTime" | "startTimeLocal">) => (a.startTimeLocal ?? a.startTime).slice(0, 10);

/**
 * Ruling 2b-R5 and its extension (audit 2b-A I-3). The app's own save is the authority over what the matcher guessed:
 *  - the slot held by an AUTOMATIC match of another activity: that match is undone, its activity returns to unmatched
 *    (extra training on its day), and the slot becomes this session's (`superseded_auto_match`);
 *  - the session's activity (the watch's copy it joined) AUTOMATICALLY matched to another slot: that match is undone
 *    and that slot reopens (`unresolved`, as an unmatch leaves it), and the activity becomes this slot's;
 *  - the same activity already automatically matched to this slot: the match becomes the app session's
 *    (`app_session`, confidence 1), so nothing later reads it as a guess;
 *  - a manual match — on this slot, or of the activity elsewhere — is never superseded: the save lands, unmatched,
 *    and says which (`slot_already_matched`, `activity_matched_elsewhere`).
 * A retry finds its own `app:` match on the slot and changes nothing.
 */
async function planMatch(db: Db, userId: string, slot: SlotRow, performedId: string, activityId: string, now: string): Promise<MatchPlan> {
  if (slot.archivedAt !== null) return { matched: false, notes: ["slot_gone"], statements: [], alsoFrom: [] };
  const [held] = await db
    .select({ id: workoutCompletionMatches.id, activityId: workoutCompletionMatches.activityId, method: workoutCompletionMatches.method })
    .from(workoutCompletionMatches)
    .where(and(eq(workoutCompletionMatches.workoutId, slot.id), isNull(workoutCompletionMatches.undoneAt)))
    .limit(1);
  const [act] = await db.select({ completionMatchId: activities.completionMatchId }).from(activities).where(eq(activities.id, activityId)).limit(1);
  // The activity's own live match on ANOTHER slot (a pointer to an undone or vanished match is no match).
  const elsewhere =
    act?.completionMatchId && act.completionMatchId !== held?.id
      ? (
          await db
            .select({ id: workoutCompletionMatches.id, workoutId: workoutCompletionMatches.workoutId, method: workoutCompletionMatches.method })
            .from(workoutCompletionMatches)
            .where(and(eq(workoutCompletionMatches.id, act.completionMatchId), isNull(workoutCompletionMatches.undoneAt)))
            .limit(1)
        ).find((m) => m.workoutId !== slot.id)
      : undefined;

  const other = held && held.activityId !== activityId ? held : undefined;
  if (other && !AUTOMATIC_MATCHES.has(other.method)) return { matched: false, notes: ["slot_already_matched"], statements: [], alsoFrom: [] };
  if (elsewhere && !AUTOMATIC_MATCHES.has(elsewhere.method)) return { matched: false, notes: ["activity_matched_elsewhere"], statements: [], alsoFrom: [] };

  if (held && !other) {
    // Already this activity's: an automatic guess becomes the app session's own match.
    const statements = AUTOMATIC_MATCHES.has(held.method)
      ? [db.update(workoutCompletionMatches).set({ method: "app_session", confidence: 1 }).where(eq(workoutCompletionMatches.id, held.id))]
      : [];
    return { matched: true, notes: [], statements, alsoFrom: [] };
  }

  const statements: AtomicStatement[] = [];
  const alsoFrom: string[] = [];
  if (other) {
    const [displaced] = await db
      .select({ startTime: activities.startTime, startTimeLocal: activities.startTimeLocal })
      .from(activities)
      .where(eq(activities.id, other.activityId))
      .limit(1);
    if (displaced) alsoFrom.push(localDayOf(displaced));
    statements.push(
      db.update(workoutCompletionMatches).set({ undoneAt: now }).where(eq(workoutCompletionMatches.id, other.id)),
      db
        .update(activities)
        .set({ completionMatchId: null, updatedAt: now })
        .where(and(eq(activities.id, other.activityId), eq(activities.completionMatchId, other.id))),
      // Its watch session no longer performed this slot (the slot's pre-check is not its to carry).
      db
        .update(performedSessions)
        .set({ workoutId: null, updatedAt: now })
        .where(
          and(
            eq(performedSessions.userId, userId),
            eq(performedSessions.source, WATCH_SOURCE),
            eq(performedSessions.activityId, other.activityId),
            eq(performedSessions.workoutId, slot.id),
          ),
        ),
    );
  }
  if (elsewhere) {
    const [reopened] = await db
      .select({ effectiveDate: plannedWorkouts.effectiveDate })
      .from(plannedWorkouts)
      .where(and(eq(plannedWorkouts.id, elsewhere.workoutId), eq(plannedWorkouts.userId, userId)))
      .limit(1);
    if (reopened) alsoFrom.push(reopened.effectiveDate);
    statements.push(
      db.update(workoutCompletionMatches).set({ undoneAt: now }).where(eq(workoutCompletionMatches.id, elsewhere.id)),
      // As the athlete's own unmatch leaves a slot (routes/plan.ts).
      db
        .update(plannedWorkouts)
        .set({ completionState: "unresolved", resolutionDate: null, updatedAt: now })
        .where(and(eq(plannedWorkouts.id, elsewhere.workoutId), eq(plannedWorkouts.userId, userId))),
    );
  }
  const matchId = `app:${performedId}`;
  statements.push(
    db
      .insert(workoutCompletionMatches)
      .values({ id: matchId, workoutId: slot.id, activityId, confidence: 1, method: "app_session", matchedAt: now })
      // A match an older attempt left is this one: made live again, pointing where this save points.
      .onConflictDoUpdate({
        target: workoutCompletionMatches.id,
        set: { workoutId: slot.id, activityId, confidence: 1, method: "app_session", undoneAt: null },
      }),
    db.update(activities).set({ completionMatchId: matchId, updatedAt: now }).where(eq(activities.id, activityId)),
  );
  return { matched: true, notes: other || elsewhere ? ["superseded_auto_match"] : [], statements, alsoFrom };
}

/**
 * How many days the save's own garden step may walk. A day costs ~10–16 D1 statements: 30 keeps a save (~35) plus its
 * step well inside the 1,000-query budget of one invocation; a longer walk finishes on the next garden read or hourly
 * cron (the catch-up's own cap, 45 days a step).
 */
const SAVE_REPLAY_MAX_DAYS = 30;

/** What the write phase did, and the earliest day the garden must replay from. */
interface Written {
  outcome: SaveOutcome;
  replayFrom: string;
}

/**
 * The write phase: everything is read and decided first, then every write lands in ONE transaction (audit 2b-A M-3)
 * — a save killed part-way leaves nothing behind (no activity without its sets, no completed slot without its
 * session), and its retry starts clean. The `pending` marker and the commit marker stay as the batch's first and last
 * statements, so a row left `pending` by an older deploy is still redone by the retry.
 */
async function write(
  db: Db,
  userId: string,
  p: PerformedSessionWire,
  hash: string,
  slot: SlotRow,
  builtOn: string | null,
  priorActivityId: string | null,
  ctx: SaveCtx,
): Promise<Written> {
  const performedId = p.id;
  const now = ctx.now;
  const timezone = ctx.prefs.timezone;
  const discipline = await disciplineOf(db, userId, slot, p.buildId);
  const when = startOf(p, timezone);
  const title = slot.title;

  // The activity this session is: the one an earlier attempt chose, else the watch's copy, else its own new row.
  let joined: ActivityRow | null = null;
  if (priorActivityId && priorActivityId !== performedId) {
    joined = (await db.select().from(activities).where(and(eq(activities.id, priorActivityId), eq(activities.userId, userId))).limit(1))[0] ?? null;
  } else if (!priorActivityId) {
    joined = await watchCopy(db, userId, performedId, when.startTime, p.seconds, discipline);
  }
  const activityId = joined?.id ?? performedId;

  // ── Read and decide everything first. ──
  const sheetPre = new Set(
    (
      await db
        .select({ profileId: conditionChecks.profileId })
        .from(conditionChecks)
        .where(
          and(
            eq(conditionChecks.userId, userId),
            eq(conditionChecks.localDate, p.localDate),
            eq(conditionChecks.workoutId, slot.id),
            eq(conditionChecks.kind, "pre"),
            isNull(conditionChecks.performedSessionId),
          ),
        )
    ).map((r) => r.profileId),
  );
  const checkRows = p.checks
    .filter((c) => !(c.kind === "pre" && sheetPre.has(c.profileId)))
    .map((c) => ({
      id: `${performedId}:${c.kind}:${c.profileId}`,
      userId,
      profileId: c.profileId,
      kind: c.kind,
      value: c.value,
      feelingOff: c.feelingOff,
      localDate: p.localDate,
      at: c.at,
      performedSessionId: performedId,
      workoutId: slot.id,
    }));
  // The watch's own copy of the session's sets goes: the app's session owns them (ruling 2b-R3).
  const watchSessions = await db
    .select({ id: performedSessions.id })
    .from(performedSessions)
    .where(and(eq(performedSessions.userId, userId), eq(performedSessions.activityId, activityId), eq(performedSessions.source, WATCH_SOURCE)));
  const match = await planMatch(db, userId, slot, performedId, activityId, now);
  const prefs = await prefStatements(db, userId, p, now);
  const graduation = await graduationStatements(db, userId, slot, p, now);
  const notes: SaveNote[] = [...match.notes];
  if (!graduation.applied) notes.push("graduation_skipped");
  // The completed slot credits its own (current) day — buildDayInput keys it on effectiveDate — the session its day,
  // the build the day it was played for, and a displaced activity or a reopened slot theirs: the replay starts at the
  // earliest (rulings 2b-R5, 2b-R7 as amended).
  const replayFrom = [slot.effectiveDate, ...(builtOn ? [builtOn] : []), p.localDate, ...match.alsoFrom].reduce((a, b) => (b < a ? b : a));

  // ── Then write it all, as one transaction. ──
  const statements: AtomicStatement[] = [];
  // 1. The session, pending until everything below has landed.
  const sessionRow = {
    id: performedId,
    userId,
    workoutId: p.workoutId,
    activityId,
    buildId: p.buildId,
    source: "app",
    sourceRef: null,
    localDate: p.localDate,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    seconds: p.seconds,
    plannedSeconds: p.plannedSeconds,
    minutes: p.minutes,
    mode: p.mode,
    theme: p.theme,
    locationId: p.locationId,
    blockRef: p.blockRef,
    blockNumber: p.blockNumber,
    completed: p.completed,
    stepsTotal: p.stepsTotal,
    stepsDone: p.stepsDone,
    movesDone: p.movesDone,
    note: p.note,
    newMove: p.newMove,
    payloadHash: PENDING_HASH,
    createdAt: now,
    updatedAt: now,
  };
  const { id: _id, userId: _u, createdAt: _c, ...changed } = sessionRow;
  statements.push(db.insert(performedSessions).values(sessionRow).onConflictDoUpdate({ target: performedSessions.id, set: changed }));

  // 2. Its sets and checks — a retry clears what an earlier attempt left first.
  statements.push(db.delete(performedSets).where(eq(performedSets.performedSessionId, performedId)));
  statements.push(db.delete(conditionChecks).where(and(eq(conditionChecks.userId, userId), eq(conditionChecks.performedSessionId, performedId))));
  for (const batch of insertBatches(setRows(performedId, p))) statements.push(db.insert(performedSets).values(batch));
  for (const batch of insertBatches(checkRows)) statements.push(db.insert(conditionChecks).values(batch));

  // 3. The activity.
  for (const w of watchSessions) statements.push(...removeWatchSessionStatements(db, w.id));
  if (joined) {
    // COROS keeps its metrics and its id; the row takes the app's title and discipline (they last: completion.ts).
    statements.push(db.update(activities).set({ title, sport: discipline, updatedAt: now }).where(eq(activities.id, activityId)));
  } else {
    const row = {
      id: activityId,
      userId,
      corosActivityId: null,
      source: "app",
      startTime: when.startTime,
      startTimeLocal: when.startTimeLocal,
      timezone,
      sport: discipline,
      durationSeconds: p.seconds,
      elapsedSeconds: when.elapsedSeconds,
      title,
      sourceMergeConfidence: 1,
      createdAt: now,
      updatedAt: now,
    };
    // A retry rewrites its own row — unless COROS has adopted it meanwhile (then COROS's metrics stand).
    statements.push(
      db
        .insert(activities)
        .values(row)
        .onConflictDoUpdate({
          target: activities.id,
          set: {
            startTime: row.startTime,
            startTimeLocal: row.startTimeLocal,
            timezone,
            sport: discipline,
            durationSeconds: row.durationSeconds,
            elapsedSeconds: row.elapsedSeconds,
            title,
            updatedAt: now,
          },
          setWhere: eq(activities.source, "app"),
        }),
    );
  }
  statements.push(
    db
      .insert(activitySourceLinks)
      .values({
        id: `app:${performedId}`,
        activityId,
        provider: "app",
        providerActivityId: performedId,
        sourceCreatedAt: p.endedAt,
        sourceUpdatedAt: null,
        firstSeenAt: now,
        lastSeenAt: now,
        contentFingerprint: hash,
        normalizerVersion: "app-1",
        sourceVersion: null,
        rawSummary: null,
      })
      .onConflictDoUpdate({ target: [activitySourceLinks.provider, activitySourceLinks.providerActivityId], set: { activityId, contentFingerprint: hash, lastSeenAt: now } }),
  );

  // 4. The slot's match, and the slot.
  statements.push(...match.statements);
  statements.push(
    db
      .update(plannedWorkouts)
      .set(
        match.matched
          ? { completionState: "completed", resolutionDate: p.localDate, contentState: "done", category: discipline, sport: discipline, updatedAt: now }
          : { contentState: "done", updatedAt: now },
      )
      .where(and(eq(plannedWorkouts.id, slot.id), eq(plannedWorkouts.userId, userId))),
  );

  // 5. The review's decisions.
  statements.push(...prefs, ...graduation.statements);

  // 6. The garden's replay, on record with the save: whatever happens to the replay itself, the change is not lost.
  statements.push(gardenChangeStatement(db, userId, replayFrom));

  // Commit marker: everything above lands with it, or none of it does.
  statements.push(db.update(performedSessions).set({ payloadHash: hash, updatedAt: now }).where(eq(performedSessions.id, performedId)));
  await runAtomically(db, statements);
  return { outcome: { status: "saved", performedId, activityId, matched: match.matched, notes }, replayFrom };
}
