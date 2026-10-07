/**
 * SAVING A PERFORMED SESSION, EXACTLY ONCE (Phase 2 spec §2b "Review and save"; programme spec §9.2, §10.6;
 * rulings 2b-R3 and the Phase 0 audit 1 ingest #3 merge rule). `PUT /api/sessions/performed/:id` lands here, from the
 * player's outbox, as often as the outbox needs.
 *
 *  1. Idempotent by the client's id and the payload's hash (sha256 of its canonical JSON — the hash the outbox keys
 *     its entry by): the same id with the same hash → `same_payload`, nothing written; with another hash →
 *     `conflict`, nothing written. Only the app's own saves come here (`source = 'app'`), always for a slot of this
 *     user's (an app session always has a row: on-demand sessions have one too).
 *  2. `performed_sessions` first, marked `pending` (every reader treats such a row as absent, and the watch ingest
 *     already yields to it), then `performed_sets` (weights as typed + kg) and the session's checks (`post`, and a
 *     `pre` the sheet has not already recorded for the slot and day), then everything below, and the real hash last
 *     as the commit marker. A save that dies part-way leaves `pending`, and the retry redoes it from the top. A lock
 *     per session id makes a second request for the same session wait (`busy`) instead of interleaving.
 *  3. The activity: normally a new `activities` row with `id = performedId`, `source = 'app'`, the sport of §9.2 (the
 *     locked build holds a core lift → strength, else yoga), the start in UTC and on the athlete's clock, the slot's
 *     title, plus an `app` source link. When the watch's copy of the same session arrived first (a COROS row within an
 *     hour, the same session by the adoption scorer, a mobility session the watch filed as Strength included), the
 *     save joins that activity instead — one physical session, one activity: COROS keeps its metrics and its id, the
 *     row takes the app's title and sport, and the watch's own performed session for it is deleted (ruling 2b-R3).
 *  4. The slot's match (`app_session`, confidence 1) unless the slot already has one (the save still lands; the match
 *     is skipped and said); the slot → `completed` on the session's day, `content_state = 'done'`, its discipline the
 *     build's.
 *  5. The review: ratings and "not for me" → `exercise_prefs`, the new move's first day; an accepted graduation →
 *     the block's lift (once: a retried save finds the lift already switched).
 *  6. The garden replays from the session's own day.
 *
 * Never writes to COROS (an app session is never pushed to the watch in 2b). Every write waits for the restore
 * marker to be clear. Every statement stays under D1's 100 bound variables.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  activities,
  activitySourceLinks,
  conditionChecks,
  exercisePrefs,
  performedSessions,
  performedSets,
  plannedWorkouts,
  sessionBuilds,
  workoutCompletionMatches,
} from "@rg/database";
import {
  canonicalJson,
  performedSessionSaveSchema,
  toKg,
  type PerformedSessionWire,
  type SourceActivity,
  type UserPreferences,
} from "@rg/domain";
import { ORPHAN_ADOPTION_FLOOR, scoreAgainstStoredRow } from "@rg/providers";
import { Blocks } from "@rg/session-engine";
import type { ZodIssue } from "zod";
import { sha256Hex } from "../auth/crypto.js";
import { restoreInProgress } from "./account-state.js";
import { chunkedInsert, chunkIds, type Db } from "./db.js";
import { loadEngineContext, loadProgramState, saveProgramState } from "./engine-inputs.js";
import { resimulateFrom } from "./garden-sync.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { engineDataFor, SessionNotFoundError } from "./session-build.js";
import { PENDING_HASH, removeWatchSession, WATCH_SOURCE } from "./watch-sets.js";

/** What a save says beside the session, when something did not go the usual way. */
export type SaveNote = "slot_already_matched" | "activity_matched_elsewhere" | "slot_gone" | "graduation_skipped";

export type SaveOutcome =
  | { status: "saved"; performedId: string; activityId: string; matched: boolean; notes: SaveNote[] }
  | { status: "same_payload" }
  | { status: "conflict" }
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
}

type SlotRow = typeof plannedWorkouts.$inferSelect;
type ActivityRow = typeof activities.$inferSelect;

/** sha256 (hex) of the payload's canonical JSON: what `performed_sessions.payload_hash` holds once committed. */
export function performedPayloadHash(payload: PerformedSessionWire): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}

/** A UTC instant as activity rows store it (`2026-10-06T19:05:00Z`), and the athlete's wall clock then. */
function startOf(p: PerformedSessionWire, timezone: string): { startTime: string; startTimeLocal: string; elapsedSeconds: number | null } {
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
function setRows(performedId: string, p: PerformedSessionWire) {
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

/**
 * The review's preferences: each touched exercise's row as it will be (ratings, "not for me", the new move's first
 * day), upserted whole so one statement serves every field.
 */
async function applyPrefs(db: Db, userId: string, p: PerformedSessionWire, now: string): Promise<void> {
  const ids = [...new Set([...Object.keys(p.review.ratings), ...Object.keys(p.review.excluded), ...(p.newMove ? [p.newMove] : [])])].sort();
  if (ids.length === 0) return;
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
  await chunkedInsert(rows, (batch) =>
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
 * place's gear, as the review offered them.
 */
async function applyGraduations(db: Db, userId: string, slot: SlotRow, p: PerformedSessionWire, now: string): Promise<boolean> {
  if (p.review.graduations.length === 0) return true;
  let block = await loadProgramState(db, slot.planId);
  if (!block || (p.blockRef !== null && block.id !== p.blockRef)) return false;
  const pending = p.review.graduations.filter((g) => block!.core[g.family] !== g.to);
  if (pending.length === 0) return true;
  const context = await loadEngineContext(db, userId, slot.planId, p.locationId ? { locationId: p.locationId } : {});
  const data = engineDataFor(context.activeProfiles, context.careProfiles);
  let applied = true;
  for (const g of pending) {
    const next = Blocks.graduate(data, block, g.family, g.to, p.localDate, context.location.equipment);
    if (next === block) applied = false;
    block = next;
  }
  await saveProgramState(db, slot.planId, block, now);
  return applied;
}

/** `PUT /api/sessions/performed/:id`. Throws `InvalidSaveError` (422) and `SessionNotFoundError` (404). */
export async function savePerformedSession(db: Db, userId: string, performedId: string, body: unknown, ctx: SaveCtx): Promise<SaveOutcome> {
  const parsed = performedSessionSaveSchema.safeParse(body);
  if (!parsed.success) throw new InvalidSaveError(parsed.error.issues);
  const p = parsed.data;
  if (p.id !== performedId) throw new InvalidSaveError([{ message: "the payload's id is not the address's", path: ["id"] }]);
  if (p.source !== "app") throw new InvalidSaveError([{ message: "only the app's own sessions are saved here", path: ["source"] }]);
  if (p.workoutId === null) throw new InvalidSaveError([{ message: "an app session names its slot", path: ["workoutId"] }]);
  const hash = await performedPayloadHash(p);

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

  const [slot] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, p.workoutId), eq(plannedWorkouts.userId, userId)))
    .limit(1);
  if (!slot || (slot.origin !== "program" && slot.origin !== "on_demand")) throw new SessionNotFoundError();
  if (await restoreInProgress(db, userId)) return { status: "restoring" };

  const lockKind = `save:${performedId}`;
  const token = await claimUserLock(db, userId, lockKind, 1);
  if (!token) return { status: "busy" };
  let outcome: SaveOutcome;
  try {
    // What another request committed while this one waited for the lock is the answer.
    const existing = await stored();
    const decided = settled(existing);
    if (decided) return decided;
    // A restore can begin while this one read; checked again just before the first write.
    if (await restoreInProgress(db, userId)) return { status: "restoring" };
    outcome = await write(db, userId, p, hash, slot, existing?.activityId ?? null, ctx);
  } finally {
    await releaseUserLock(db, userId, lockKind, token);
  }
  // The garden replays from the session's own day (it stands down by itself while a restore runs).
  await resimulateFrom(db, userId, p.localDate, ctx.prefs, new Date(ctx.now)).catch(() => undefined);
  return outcome;
}

async function write(
  db: Db,
  userId: string,
  p: PerformedSessionWire,
  hash: string,
  slot: SlotRow,
  priorActivityId: string | null,
  ctx: SaveCtx,
): Promise<SaveOutcome> {
  const performedId = p.id;
  const notes: SaveNote[] = [];
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
  await db.insert(performedSessions).values(sessionRow).onConflictDoUpdate({ target: performedSessions.id, set: changed });

  // 2. Its sets and checks — a retry clears what an earlier attempt left first.
  await db.delete(performedSets).where(eq(performedSets.performedSessionId, performedId));
  await db.delete(conditionChecks).where(and(eq(conditionChecks.userId, userId), eq(conditionChecks.performedSessionId, performedId)));
  await chunkedInsert(setRows(performedId, p), (batch) => db.insert(performedSets).values(batch));
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
  await chunkedInsert(checkRows, (batch) => db.insert(conditionChecks).values(batch));

  // 3. The activity. The watch's own copy of the session's sets goes: the app's session owns them (ruling 2b-R3).
  for (const w of await db
    .select({ id: performedSessions.id })
    .from(performedSessions)
    .where(and(eq(performedSessions.userId, userId), eq(performedSessions.activityId, activityId), eq(performedSessions.source, WATCH_SOURCE)))) {
    await removeWatchSession(db, w.id);
  }
  if (joined) {
    // COROS keeps its metrics and its id; the row takes the app's title and discipline (they last: completion.ts).
    await db.update(activities).set({ title, sport: discipline, updatedAt: now }).where(eq(activities.id, activityId));
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
    await db
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
      });
  }
  await db
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
    .onConflictDoUpdate({ target: [activitySourceLinks.provider, activitySourceLinks.providerActivityId], set: { activityId, contentFingerprint: hash, lastSeenAt: now } });

  // 4. The slot's match, unless something else completed it first.
  let matched = false;
  if (slot.archivedAt !== null) {
    notes.push("slot_gone");
  } else {
    const [held] = await db
      .select({ id: workoutCompletionMatches.id, activityId: workoutCompletionMatches.activityId })
      .from(workoutCompletionMatches)
      .where(and(eq(workoutCompletionMatches.workoutId, slot.id), isNull(workoutCompletionMatches.undoneAt)))
      .limit(1);
    const [act] = await db.select({ completionMatchId: activities.completionMatchId }).from(activities).where(eq(activities.id, activityId)).limit(1);
    if (held && held.activityId !== activityId) {
      notes.push("slot_already_matched");
    } else if (!held && act?.completionMatchId) {
      notes.push("activity_matched_elsewhere");
    } else {
      if (!held) {
        const matchId = `app:${performedId}`;
        await db
          .insert(workoutCompletionMatches)
          .values({ id: matchId, workoutId: slot.id, activityId, confidence: 1, method: "app_session", matchedAt: now })
          .onConflictDoNothing();
        await db.update(activities).set({ completionMatchId: matchId, updatedAt: now }).where(eq(activities.id, activityId));
      }
      matched = true;
    }
  }
  await db
    .update(plannedWorkouts)
    .set(
      matched
        ? { completionState: "completed", resolutionDate: p.localDate, contentState: "done", category: discipline, sport: discipline, updatedAt: now }
        : { contentState: "done", updatedAt: now },
    )
    .where(and(eq(plannedWorkouts.id, slot.id), eq(plannedWorkouts.userId, userId)));

  // 5. The review's decisions.
  await applyPrefs(db, userId, p, now);
  if (!(await applyGraduations(db, userId, slot, p, now))) notes.push("graduation_skipped");

  // Commit marker: everything above has landed.
  await db.update(performedSessions).set({ payloadHash: hash, updatedAt: now }).where(eq(performedSessions.id, performedId));
  return { status: "saved", performedId, activityId, matched, notes };
}
