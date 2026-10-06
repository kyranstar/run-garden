/**
 * LOGGED SETS FROM WATCH STRENGTH SESSIONS (Phase 2a+, spec
 * 2026-10-04-phase-2a-plus-watch-strength-sets-design.md).
 *
 * A COROS strength activity's detail carries one lap item per set and per
 * rest. The importer used to keep only their durations; this turns them into
 * one performed session (`source = 'watch'`) and one `performed_sets` row per
 * set, so Activity, the lift graphs and the session engine's history see what
 * was actually lifted on the watch.
 *
 * What the wire means was settled by six masked probe runs on the owner's
 * account (counts only; docs/reports/2026-10-04-coros-spikes.md §1):
 *
 *  - R1  `weight` is kg × 1000 (grams), the program wire's own scale.
 *  - R2  The athlete typed either kg or lb on the watch, and the watch stored
 *        grams either way. A weight that is within 0.02 lb of a whole pound or
 *        a 2.5 lb step, and is NOT a whole kg, was typed in pounds: it is kept
 *        as pounds. Everything else is kept as kg. `load_kg` is always the
 *        wire's grams ÷ 1000.
 *  - R3  Every item appears twice, once per lap type; only the lowest lap
 *        type code is read. Within it, items group by (exerciseIndex,
 *        setIndex) in list order. Every item with reps > 0 or weight > 0 is a
 *        set (a group holding two is two sets — one per side); a no-data item
 *        after it is its rest. A group with no data item at all is one timed
 *        set (a hold) from its FIRST item; the rest of that group is rest.
 *  - R4  `time` is 1/100 s.
 *
 * Identity is `exerciseNameKey` (the COROS i18n key, e.g. "T1041" — the same
 * key COROS_EXERCISE_NAMES and the `coros_exercises.name` column use);
 * `exerciseId` takes only a handful of values across many exercises and is
 * not an identity. A key the library's reverse COROS mapping knows becomes
 * the library id; any other stays `coros:<key>`, a stable id the display
 * layer humanizes once (activity DTO).
 */
import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import {
  activities,
  activityLaps,
  activitySourceLinks,
  corosExercises,
  performedSessions,
  performedSets,
  providerConnections,
  workoutCompletionMatches,
} from "@rg/database";
import { fingerprint, LB_TO_KG, nowInstant, SPORTS } from "@rg/domain";
import { CorosApiError } from "@rg/coros";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import type { RawCorosActivityDetail, RawCorosLapItem } from "@rg/providers";
import { fixtureModeEnabled, type Env } from "../env.js";
import { restoreInProgress } from "./account-state.js";
import { corosClient } from "./coros-connection.js";
import { chunkedInsert, chunkIds, type Db } from "./db.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { isRuntimeLimit } from "./runtime-limit.js";

/** `performed_sessions.source` of a session derived from a watch activity. Never on the save wire. */
export const WATCH_SOURCE = "watch";
/** The prefix of an exercise id the library does not map: `coros:<exerciseNameKey>`. */
export const COROS_EXERCISE_PREFIX = "coros:";

/** What the derivation needs to know about the activity the laps belong to. */
export interface WatchActivityFacts {
  /** `activities.id`. */
  activityId: string;
  /** The COROS activity id (labelId) — the session's `source_ref`. */
  providerActivityId: string;
  /** UTC instant. */
  startTime: string;
  /** Wall-clock start where the activity happened; its date is the session's local date. */
  startTimeLocal?: string | null;
  durationSeconds: number;
  elapsedSeconds?: number | null;
}

export interface DeriveWatchOptions {
  now: string;
  /** The planned workout the activity completed, if any. */
  workoutId?: string | null;
  /** An exerciseNameKey → library exercise id, where the reverse COROS mapping knows one. */
  libraryIdFor?: (nameKey: string) => string | null | undefined;
}

export type WatchSessionRow = typeof performedSessions.$inferInsert & {
  id: string;
  payloadHash: string;
  movesDone: Array<{ exerciseId: string; seconds: number }>;
};
export type WatchSetRow = typeof performedSets.$inferInsert & { id: string };

export interface WatchSession {
  session: WatchSessionRow;
  sets: WatchSetRow[];
}

export interface WatchLoad {
  /** As the athlete most likely typed it. */
  value: number;
  unit: "lb" | "kg";
  /** The wire's grams ÷ 1000, exactly. */
  kg: number;
}

/** A finite number, numeric strings included (the probe saw some fields arrive as strings). */
function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Pounds within this of a grid point were typed as that many pounds (ruling 2a+-R2). */
const LB_TOLERANCE = 0.02;

const nearMultiple = (x: number, step: number): boolean => Math.abs(x / step - Math.round(x / step)) * step <= LB_TOLERANCE;

/** A lap item's `weight` (kg × 1000) → the load as typed, or null for bodyweight (rulings 2a+-R1, R2). */
export function watchLoad(weight: unknown): WatchLoad | null {
  const grams = num(weight);
  if (grams === undefined || grams <= 0) return null;
  const kg = grams / 1000;
  const wholeKg = Math.abs(kg - Math.round(kg)) < 1e-9;
  const lb = kg / LB_TO_KG;
  if (!wholeKg && nearMultiple(lb, 1)) return { value: Math.round(lb), unit: "lb", kg };
  if (!wholeKg && nearMultiple(lb, 2.5)) return { value: Math.round(lb / 2.5) * 2.5, unit: "lb", kg };
  return { value: Number(kg.toFixed(3)), unit: "kg", kg };
}

const hasData = (i: RawCorosLapItem): boolean => (num(i.reps) ?? 0) > 0 || (num(i.weight) ?? 0) > 0;
const nameKeyOf = (i: RawCorosLapItem): string | null =>
  typeof i.exerciseNameKey === "string" && i.exerciseNameKey.trim() !== "" ? i.exerciseNameKey.trim() : null;
const centis = (i: RawCorosLapItem): number => Math.max(0, num(i.time) ?? 0);

/** The items of the one lap type that is read: the lowest code present (ruling 2a+-R3). */
function readLapType(detail: Pick<RawCorosActivityDetail, "lapList">): RawCorosLapItem[] {
  const all: RawCorosLapItem[] = [];
  for (const lap of Array.isArray(detail.lapList) ? detail.lapList : []) {
    for (const raw of Array.isArray(lap?.lapItemList) ? lap.lapItemList : []) {
      if (raw && typeof raw === "object") all.push(raw);
    }
  }
  const codes = all.map((i) => i.lapType).filter((t): t is number => typeof t === "number" && Number.isInteger(t));
  if (codes.length === 0) return all;
  const lowest = Math.min(...codes);
  return all.filter((i) => i.lapType === lowest);
}

interface Slot {
  nameKey: string;
  /** Groups by setIndex, in list order. */
  groups: Map<string, RawCorosLapItem[]>;
  centis: number;
}

/**
 * One activity's lap items → its watch session and sets, or null when nothing
 * is there to log. Pure: the ids are derived from the user and the COROS
 * activity, so a re-derivation of the same activity reproduces them.
 */
export function deriveWatchSession(
  detail: Pick<RawCorosActivityDetail, "lapList">,
  activity: WatchActivityFacts,
  userId: string,
  opts: DeriveWatchOptions,
): WatchSession | null {
  const slots = new Map<string, Slot>();
  for (const item of readLapType(detail)) {
    const nameKey = nameKeyOf(item);
    if (nameKey === null) continue; // an item that names no exercise cannot be logged
    const slotKey = JSON.stringify(item.exerciseIndex ?? `key:${nameKey}`);
    const slot = slots.get(slotKey) ?? { nameKey, groups: new Map(), centis: 0 };
    const groupKey = JSON.stringify(item.setIndex ?? null);
    slot.groups.set(groupKey, [...(slot.groups.get(groupKey) ?? []), item]);
    slot.centis += centis(item);
    slots.set(slotKey, slot);
  }

  const sessionId = `${WATCH_SOURCE}:${userId}:${activity.providerActivityId}`;
  const sets: WatchSetRow[] = [];
  const moves = new Map<string, number>();
  let entryIndex = 0;
  for (const slot of slots.values()) {
    const exerciseId = opts.libraryIdFor?.(slot.nameKey) || `${COROS_EXERCISE_PREFIX}${slot.nameKey}`;
    const logged: Array<{ reps: number | null; seconds: number | null; load: WatchLoad | null }> = [];
    for (const group of slot.groups.values()) {
      if (group.some(hasData)) {
        for (const i of group.filter(hasData)) {
          const reps = Math.round(num(i.reps) ?? 0);
          const time = centis(i);
          logged.push({
            reps: reps > 0 ? reps : null,
            // A rep set is counted in reps; only a set with no reps is held for a time.
            seconds: reps > 0 || time <= 0 ? null : Math.round(time / 100),
            load: watchLoad(i.weight),
          });
        }
      } else {
        const time = centis(group[0]!);
        if (time > 0) logged.push({ reps: null, seconds: Math.round(time / 100), load: null });
      }
    }
    if (logged.length === 0) continue;
    logged.forEach((l, setIndex) => {
      sets.push({
        id: `${sessionId}:${entryIndex}:${setIndex}`,
        performedSessionId: sessionId,
        entryIndex,
        exerciseId,
        implement: null,
        format: null,
        perSide: false,
        setIndex,
        side: null,
        reps: l.reps,
        seconds: l.seconds,
        loadValue: l.load?.value ?? null,
        loadUnit: l.load?.unit ?? null,
        loadKg: l.load?.kg ?? null,
        done: true,
        flags: [],
      });
    });
    moves.set(exerciseId, (moves.get(exerciseId) ?? 0) + slot.centis);
    entryIndex += 1;
  }
  if (sets.length === 0) return null;

  const movesDone = [...moves.entries()].map(([exerciseId, c]) => ({ exerciseId, seconds: Math.round(c / 100) }));
  const startMs = Date.parse(activity.startTime);
  const span = activity.elapsedSeconds ?? activity.durationSeconds;
  const endedAt = Number.isFinite(startMs) && span > 0 ? new Date(startMs + span * 1000).toISOString() : null;
  const localDate = (activity.startTimeLocal ?? activity.startTime).slice(0, 10);
  const seconds = Math.max(0, Math.round(activity.durationSeconds));
  // The content only: when it was derived and which workout it matched are not part of what was lifted.
  const payloadHash = fingerprint({
    v: 1,
    activityId: activity.activityId,
    localDate,
    startedAt: activity.startTime,
    endedAt,
    seconds,
    movesDone,
    sets: sets.map((s) => [s.entryIndex, s.setIndex, s.exerciseId, s.reps, s.seconds, s.loadValue, s.loadUnit, s.loadKg]),
  });

  return {
    session: {
      id: sessionId,
      userId,
      workoutId: opts.workoutId ?? null,
      activityId: activity.activityId,
      buildId: null,
      source: WATCH_SOURCE,
      sourceRef: activity.providerActivityId,
      localDate,
      startedAt: activity.startTime,
      endedAt,
      seconds,
      plannedSeconds: null,
      minutes: null,
      mode: null,
      theme: null,
      locationId: null,
      blockRef: null,
      blockNumber: null,
      completed: true,
      stepsTotal: null,
      stepsDone: null,
      movesDone,
      note: null,
      newMove: null,
      payloadHash,
      createdAt: opts.now,
      updatedAt: opts.now,
    },
    sets,
  };
}

// ── Storing it ────────────────────────────────────────────────────────────────

export interface UpsertWatchInput {
  userId: string;
  activity: WatchActivityFacts;
  detail: Pick<RawCorosActivityDetail, "lapList">;
  /**
   * The planned workout the activity completed: a string or null to set it,
   * undefined to keep what a stored session already says.
   */
  workoutId?: string | null;
  /** The ingest adopted an app-recorded row for this activity (the app+watch merge). */
  adoptedFromApp?: boolean;
  now?: string;
}

export type UpsertWatchResult = {
  status:
    | "written"
    /** Already stored exactly so — nothing written. */
    | "unchanged"
    /** A stored watch session had nothing left to log and is gone. */
    | "removed"
    | "no_sets"
    /** The app (or a watch review) logged this activity: its session is the authority (spec §2.3). */
    | "app_owned"
    /** A restore is replacing the account (ruling B2). */
    | "restoring";
};

/** The library's exact COROS mappings, originId → library id; an originId two records claim maps to neither. */
function reverseMapping(library: readonly ExerciseRecord[]): Map<string, string> {
  const claims = new Map<string, string[]>();
  for (const e of library) {
    const coros = e.providers?.coros;
    if (!coros || coros.confidence !== "exact") continue;
    claims.set(coros.originId, [...(claims.get(coros.originId) ?? []), e.id]);
  }
  const out = new Map<string, string>();
  for (const [originId, ids] of claims) if (ids.length === 1) out.set(originId, ids[0]!);
  return out;
}

let libraryReverse: Map<string, string> | null = null;

/** The library's exact COROS mappings (originId → library id); the shipped library when none is given. */
export function libraryIdsByOrigin(library?: readonly ExerciseRecord[]): Map<string, string> {
  return library ? reverseMapping(library) : (libraryReverse ??= reverseMapping(EXERCISES));
}

/**
 * exerciseNameKey → library id for the keys in this detail: the catalog row
 * named by the key gives its originId, the library's exact mapping of that
 * originId the library id. No library mapping at all → no catalog read.
 */
async function libraryResolver(
  db: Db,
  detail: Pick<RawCorosActivityDetail, "lapList">,
  library: readonly ExerciseRecord[] | undefined,
): Promise<(nameKey: string) => string | null> {
  const byOrigin = libraryIdsByOrigin(library);
  if (byOrigin.size === 0) return () => null;
  const keys = [...new Set(readLapType(detail).map(nameKeyOf).filter((k): k is string => k !== null))];
  const originsByKey = new Map<string, Set<string>>();
  for (const batch of chunkIds(keys)) {
    const rows = await db
      .select({ id: corosExercises.id, name: corosExercises.name })
      .from(corosExercises)
      .where(inArray(corosExercises.name, batch));
    for (const r of rows) originsByKey.set(r.name, (originsByKey.get(r.name) ?? new Set()).add(r.id));
  }
  return (nameKey) => {
    const origins = [...(originsByKey.get(nameKey) ?? [])];
    return origins.length === 1 ? (byOrigin.get(origins[0]!) ?? null) : null;
  };
}

async function removeWatchSession(db: Db, sessionId: string): Promise<void> {
  await db.delete(performedSets).where(eq(performedSets.performedSessionId, sessionId));
  await db.delete(performedSessions).where(eq(performedSessions.id, sessionId));
}

/** The derived rows re-keyed onto a stored session whose id differs (a restored file's, say). */
function rekey(derived: WatchSession, sessionId: string): WatchSession {
  if (derived.session.id === sessionId) return derived;
  return {
    session: { ...derived.session, id: sessionId },
    sets: derived.sets.map((s) => ({
      ...s,
      id: `${sessionId}:${s.entryIndex}:${s.setIndex}`,
      performedSessionId: sessionId,
    })),
  };
}

/**
 * The ingest logs an activity's watch session before it matches activities to
 * planned workouts; a match made afterwards names its workout here.
 */
export async function linkWatchSessionsToWorkouts(
  db: Db,
  userId: string,
  links: ReadonlyArray<{ activityId: string; workoutId: string }>,
  now: string = nowInstant(),
): Promise<void> {
  for (const l of links) {
    await db
      .update(performedSessions)
      .set({ workoutId: l.workoutId, updatedAt: now })
      .where(
        and(
          eq(performedSessions.userId, userId),
          eq(performedSessions.source, WATCH_SOURCE),
          eq(performedSessions.activityId, l.activityId),
        ),
      );
  }
}

/** Marks a session whose sets are mid-write: never equal to a real hash, so the next refresh redoes it. */
const PENDING_HASH = "pending";

/**
 * Writes one activity's watch session, idempotent by (user, 'watch', COROS
 * activity id). A refresh replaces the sets under the same session id; a
 * refresh with the same content writes nothing. Crash-safe in the order it
 * writes: the session row carries `pending` until its sets have landed (the
 * ingest's commit-marker pattern, audit#3 D4), the new sets are upserted
 * before the stale ones go, and every statement stays under D1's bind cap.
 */
export async function upsertWatchSession(
  db: Db,
  input: UpsertWatchInput,
  deps: { library?: readonly ExerciseRecord[] } = {},
): Promise<UpsertWatchResult> {
  const { userId, activity } = input;
  if (await restoreInProgress(db, userId)) return { status: "restoring" };
  const now = input.now ?? nowInstant();

  const [existing] = await db
    .select({ id: performedSessions.id, payloadHash: performedSessions.payloadHash, workoutId: performedSessions.workoutId })
    .from(performedSessions)
    .where(
      and(
        eq(performedSessions.userId, userId),
        eq(performedSessions.source, WATCH_SOURCE),
        eq(performedSessions.sourceRef, activity.providerActivityId),
      ),
    )
    .limit(1);

  // One physical session is logged once: the app's own record (or a watch
  // review) of this activity wins, and a watch copy made before it existed goes.
  const owned =
    input.adoptedFromApp === true ||
    (
      await db
        .select({ id: performedSessions.id })
        .from(performedSessions)
        .where(
          and(
            eq(performedSessions.userId, userId),
            eq(performedSessions.activityId, activity.activityId),
            ne(performedSessions.source, WATCH_SOURCE),
          ),
        )
        .limit(1)
    ).length > 0;
  if (owned) {
    if (existing) await removeWatchSession(db, existing.id);
    return { status: "app_owned" };
  }

  const workoutId = input.workoutId === undefined ? (existing?.workoutId ?? null) : input.workoutId;
  const libraryIdFor = await libraryResolver(db, input.detail, deps.library);
  const fresh = deriveWatchSession(input.detail, activity, userId, { now, workoutId, libraryIdFor });
  if (!fresh) {
    if (!existing) return { status: "no_sets" };
    await removeWatchSession(db, existing.id);
    return { status: "removed" };
  }
  const derived = existing ? rekey(fresh, existing.id) : fresh;
  const { session, sets } = derived;

  if (existing && existing.payloadHash === session.payloadHash) {
    if (existing.workoutId === workoutId) return { status: "unchanged" };
    await db
      .update(performedSessions)
      .set({ workoutId, updatedAt: now })
      .where(eq(performedSessions.id, session.id));
    return { status: "written" };
  }

  const { id: _id, userId: _user, createdAt: _created, ...changed } = session;
  await db
    .insert(performedSessions)
    .values({ ...session, payloadHash: PENDING_HASH })
    .onConflictDoUpdate({ target: performedSessions.id, set: { ...changed, payloadHash: PENDING_HASH } });
  await chunkedInsert(sets, (batch) =>
    db
      .insert(performedSets)
      .values(batch)
      .onConflictDoUpdate({
        target: performedSets.id,
        set: {
          entryIndex: sql`excluded.entry_index`,
          exerciseId: sql`excluded.exercise_id`,
          implement: sql`excluded.implement`,
          format: sql`excluded.format`,
          perSide: sql`excluded.per_side`,
          setIndex: sql`excluded.set_index`,
          side: sql`excluded.side`,
          reps: sql`excluded.reps`,
          seconds: sql`excluded.seconds`,
          loadValue: sql`excluded.load_value`,
          loadUnit: sql`excluded.load_unit`,
          loadKg: sql`excluded.load_kg`,
          done: sql`excluded.done`,
          flags: sql`excluded.flags`,
        },
      }),
  );
  const keep = new Set(sets.map((s) => s.id));
  const stored = await db
    .select({ id: performedSets.id })
    .from(performedSets)
    .where(eq(performedSets.performedSessionId, session.id));
  for (const batch of chunkIds(stored.map((r) => r.id).filter((id) => !keep.has(id)))) {
    await db.delete(performedSets).where(inArray(performedSets.id, batch));
  }
  // Commit marker: the sets are all there.
  await db
    .update(performedSessions)
    .set({ payloadHash: session.payloadHash })
    .where(eq(performedSessions.id, session.id));
  return { status: "written" };
}

// ── The backfill ──────────────────────────────────────────────────────────────

//
// Strength activities stored before the ingest kept sets have their laps but
// no session, and the read-now never re-reads a stored activity's detail
// (it fetches details for unseen activities only). This pass fills them: the
// stored strength activities that have laps (so their detail had lap items)
// and no settled session of any source, newest first, a few per call. It is
// idempotent — a filled activity drops out — and walks back through history
// by a cursor, so an activity that turns out to have nothing to log is passed
// once, not retried forever.
//
// Budget (Workers Free): at most WATCH_BACKFILL_BATCH detail reads, each at
// worst three COROS calls (the read, a re-login on an expired token, the
// retry), well inside 50 external subrequests; D1 statements count against
// the separate 1,000 internal ceiling. CPU is one detail's JSON and a pure
// derivation per activity — the same work the read-now does per new activity.

/** Details read per call. */
export const WATCH_BACKFILL_BATCH = 4;
/** COROS calls one call may make; a detail read costs at most three. */
export const WATCH_BACKFILL_SUBREQUEST_BUDGET = 36;
const DETAIL_WORST_CASE = 3;
/** The activity sportType a strength activity's detail is read with. */
const STRENGTH_SPORT_TYPE = SPORTS.find((s) => s.id === "strength")!.corosCodes[0]!;

export type WatchBackfillResult =
  | { status: "fixture_mode" | "not_connected" | "restoring" | "busy" | "runtime_limit" }
  | { status: "coros_error"; code?: string }
  | {
      status: "ok";
      /** Activities whose sets were logged. */
      filled: number;
      /** Activities whose detail had nothing to log. */
      nothingToLog: number;
      /** Activities the app's own session turned out to own. */
      appOwned: number;
      /** Details COROS failed to send; a later walk from the top retries them. */
      failures: number;
      /** Pass as `before` to go on; null when nothing older is left. */
      next: string | null;
      subrequests: number;
    };

/** The planned workout an activity's live completion match names, if any. */
export async function matchedWorkoutId(db: Db, activityId: string): Promise<string | null> {
  const [row] = await db
    .select({ matchId: activities.completionMatchId })
    .from(activities)
    .where(eq(activities.id, activityId))
    .limit(1);
  if (!row?.matchId) return null;
  const [match] = await db
    .select({ workoutId: workoutCompletionMatches.workoutId })
    .from(workoutCompletionMatches)
    .where(and(eq(workoutCompletionMatches.id, row.matchId), isNull(workoutCompletionMatches.undoneAt)))
    .limit(1);
  return match?.workoutId ?? null;
}

export async function backfillWatchSets(
  db: Db,
  env: Env,
  userId: string,
  opts: { before?: string; fetchImpl?: typeof fetch } = {},
): Promise<WatchBackfillResult> {
  // Fixture mode never talks to real providers (repo-wide convention).
  if (fixtureModeEnabled(env)) return { status: "fixture_mode" };
  if (await restoreInProgress(db, userId)) return { status: "restoring" };
  const [conn] = await db
    .select({ status: providerConnections.status })
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")))
    .limit(1);
  if (!conn || conn.status === "disconnected") return { status: "not_connected" };

  const rows = await db
    .select({
      id: activities.id,
      labelId: activitySourceLinks.providerActivityId,
      startTime: activities.startTime,
      startTimeLocal: activities.startTimeLocal,
      durationSeconds: activities.durationSeconds,
      elapsedSeconds: activities.elapsedSeconds,
    })
    .from(activities)
    .innerJoin(
      activitySourceLinks,
      and(eq(activitySourceLinks.activityId, activities.id), eq(activitySourceLinks.provider, "coros")),
    )
    .where(
      and(
        eq(activities.userId, userId),
        eq(activities.sport, "strength"),
        opts.before ? lt(activities.startTime, opts.before) : undefined,
        sql`exists (select 1 from ${activityLaps} where ${activityLaps.activityId} = ${activities.id})`,
        sql`not exists (select 1 from ${performedSessions} where ${performedSessions.userId} = ${activities.userId} and ${performedSessions.activityId} = ${activities.id} and ${performedSessions.payloadHash} <> ${PENDING_HASH})`,
      ),
    )
    .orderBy(desc(activities.startTime))
    .limit(WATCH_BACKFILL_BATCH + 1);
  const done = { filled: 0, nothingToLog: 0, appOwned: 0, failures: 0 };
  if (rows.length === 0) return { status: "ok", ...done, next: null, subrequests: 0 };

  const lock = await claimUserLock(db, userId, "coros_read", 5);
  if (!lock) return { status: "busy" };
  let subrequests = 0;
  const base = opts.fetchImpl ?? fetch;
  const counted: typeof fetch = (input, init) => {
    subrequests += 1;
    return base(input, init);
  };
  try {
    const client = await corosClient(db, env, userId, counted);
    if (!client) return { status: "not_connected" };
    let last: string | null = null;
    let processed = 0;
    for (const row of rows.slice(0, WATCH_BACKFILL_BATCH)) {
      if (subrequests + DETAIL_WORST_CASE > WATCH_BACKFILL_SUBREQUEST_BUDGET) break;
      processed += 1;
      last = row.startTime;
      let detail: RawCorosActivityDetail;
      try {
        detail = await client.getActivityDetail(row.labelId, STRENGTH_SPORT_TYPE);
      } catch (e) {
        if (isRuntimeLimit(e)) throw e;
        done.failures += 1;
        continue;
      }
      const res = await upsertWatchSession(db, {
        userId,
        activity: {
          activityId: row.id,
          providerActivityId: row.labelId,
          startTime: row.startTime,
          startTimeLocal: row.startTimeLocal,
          durationSeconds: row.durationSeconds,
          elapsedSeconds: row.elapsedSeconds,
        },
        detail,
        workoutId: await matchedWorkoutId(db, row.id),
      });
      if (res.status === "restoring") return { status: "restoring" };
      if (res.status === "written" || res.status === "unchanged") done.filled += 1;
      else if (res.status === "app_owned") done.appOwned += 1;
      else done.nothingToLog += 1;
    }
    const more = rows.length > processed;
    return { status: "ok", ...done, next: more ? last : null, subrequests };
  } catch (e) {
    if (isRuntimeLimit(e)) return { status: "runtime_limit" };
    // Result code only — nothing from the account leaves.
    return { status: "coros_error", ...(e instanceof CorosApiError && e.resultCode ? { code: e.resultCode } : {}) };
  } finally {
    await releaseUserLock(db, userId, "coros_read", lock).catch(() => undefined);
  }
}
