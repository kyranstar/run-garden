/**
 * THE QUICK REVIEW AFTER A WATCH SESSION (Phase 3 Task 9; spec §5; rulings 3-R7, 3-R8).
 *
 * The athlete did a program session on the watch; its COROS activity imported and matched the slot. Today offers
 * "Log your session": the post-check, the sets and a note, prefilled from the sets the watch logged (the activity's
 * `watch` performed session, Phase 2a+), falling back to the locked build's targets where the watch logged nothing.
 * The save is one `watch_review` performed session ON the watch's activity — no new activity, no new match — and it
 * replaces the derived `watch` session, so the one physical session is counted once.
 *
 *  - `pairWatchSets` (pure): the watch's entries paired with the build's — by library id, then by order only when the
 *    unmapped ones left on each side number the same (3-R7). One watch lap per side (audit 3-A W-1): a one-sided move
 *    reaches the watch as a Left then a Right step per set, so its laps alternate left, right.
 *  - `watchReviewBasis`: what the sheet opens with, offered only for a program or on-demand slot an ACTIVE
 *    `coros_plan_link` or `scored_auto` match gave a COROS activity, with a locked build, no app and no review session
 *    (of the slot, or of the activity), on the session's day or the next. The session's day is the build's — or, for a
 *    sent build COROS moved, the slot's own (the import adopted the move, Task 7).
 *  - `saveWatchReview`: `PUT /api/sessions/performed/:id` with `source: "watch_review"` (session-save.ts dispatches),
 *    idempotent by id + payload hash as the app save is, one transaction with the `pending` marker first and the commit
 *    marker last, under the merge locks the app save takes. A slot holds one `app` or `watch_review` session: the
 *    second is refused `slot_done` (3-R8).
 *
 * THE BUDGET (ruling 3-R11, Workers Free): every request here stays ≤ 45 D1 statements (no COROS call). The save
 * records the garden's replay in its own transaction and leaves the walk to the next garden read (the record is the
 * guarantee, ruling 2b-R7): a strength review changes no day input, and a mobility one only its activity's sport.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import {
  activities,
  conditionChecks,
  corosWriteJobs,
  performedSessions,
  performedSets,
  plannedWorkouts,
  programBlocks,
  programs,
  sessionBuilds,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  isLocalDate,
  SESSION_FORMATS,
  sessionModeSchema,
  type PerformedSessionWire,
  type PerformedSet,
  type SessionFormat,
  type WeightUnit,
} from "@rg/domain";
import { restoreInProgress } from "./account-state.js";
import { activeProfileIds, conditionView, type ConditionView } from "./condition-views.js";
import { insertBatches, runAtomically, type AtomicStatement, type Db } from "./db.js";
import { exerciseDisplayName } from "./logged-sets.js";
import { gardenChangeStatement } from "./garden-sync.js";
import { corosKeyOf, libraryIdsByKey } from "./coros-exercise-map.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { pushJobId, SessionNotFoundError, SETTLED_PUSH, type BuildPayload } from "./session-build.js";
import {
  claimMergeLocks,
  InvalidSaveError,
  prefStatements,
  releaseMergeLocks,
  savedByAnother,
  setRows,
  type SaveCtx,
  type SaveOutcome,
} from "./session-save.js";
import { PENDING_HASH, WATCH_SOURCE } from "./watch-sets.js";

export interface WatchReviewEntry {
  exerciseId: string;
  perSide: boolean;
  format: SessionFormat | null;
  implement: string | null;
  /** As the sheet prefills them: what the watch logged, else the build's target (not done). */
  sets: Array<PerformedSet & { from: "watch" | "target" }>;
}

export interface WatchReviewBasis {
  workoutId: string;
  buildId: string;
  activityId: string;
  /** The COROS activity id: the save's `sourceRef`. */
  sourceRef: string;
  localDate: string;
  startedAt: string;
  endedAt: string | null;
  seconds: number;
  /** The build's new move, if any: the save records its first day as the app's does. */
  newMove: string | null;
  /** Each entry with the name the athlete reads (the build's move, the library's, or COROS's English name). */
  entries: Array<WatchReviewEntry & { name: string }>;
  /** The post-check's grid: the account's switched-on profiles. */
  profiles: ConditionView[];
  /** The session's pre-check, per profile, as it was built with ("Before 1"). */
  before: Record<string, { pre: number | null; feelingOff: boolean }>;
  /** The athlete's weight unit: a weight typed where the watch logged none. */
  unit: WeightUnit;
}

/** The matches the review follows: the ones the import makes by itself (a manual match is the athlete's own call). */
export const REVIEWED_MATCHES = ["coros_plan_link", "scored_auto"] as const;

// ── Pairing (pure) ────────────────────────────────────────────────────────────────────────────────────────────────

type WatchEntry = { exerciseId: string; sets: PerformedSet[] };
type Lap = { side: PerformedSet["side"]; reps: number | null; seconds: number | null; load: PerformedSet["load"] };

/** An exercise id the watch's logged set could not map to the library (the derivation's `coros:<T-code>`). */
const unmapped = (id: string): boolean => id.startsWith("coros:");

const whole = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);

const sideOf = (s: "Left" | "Right" | null | undefined): PerformedSet["side"] => (s === "Left" ? "left" : s === "Right" ? "right" : null);

/** A build entry: its move, and its target laps as the watch got them (`watchStepsFromBuild`'s sides). */
function buildEntries(build: BuildPayload): Array<{ exerciseId: string; perSide: boolean; format: SessionFormat | null; laps: Lap[] }> {
  const formats = new Set<string>(SESSION_FORMATS);
  return build.items.map((item) => {
    const perSide = build.exercises[item.exerciseId]?.laterality === "unilateral";
    const laps: Lap[] = [];
    for (const s of build.steps) {
      if (s.kind === "rest" || s.slotKey !== item.slotKey || s.exerciseId !== item.exerciseId) continue;
      const w = s.target?.w;
      const load = w && typeof w.v === "number" && w.v > 0 && (w.u === "lb" || w.u === "kg") ? { v: w.v, u: w.u } : null;
      const reps = s.kind === "set" ? whole(s.target?.reps) || null : null;
      const seconds = s.kind === "timed" ? whole(s.seconds) : reps ? null : whole(s.target?.secs) || null;
      // A one-sided set with no side went to the watch as a Left then a Right step (audit W-1): one lap each.
      const sides = s.kind === "set" && s.side === null && perSide ? (["left", "right"] as const) : [sideOf(s.side)];
      for (const side of sides) laps.push({ side, reps, seconds, load: s.kind === "timed" ? null : load });
    }
    return { exerciseId: item.exerciseId, perSide, format: formats.has(item.format) ? (item.format as SessionFormat) : null, laps };
  });
}

/**
 * A build move whose laps come back from the watch under its OWN library id: it reaches the watch by its T-code, and
 * that T-code resolves back to it (`libraryIdsByKey`, the derivation's own map). Such a move never comes back as a
 * `coros:` entry — skipped on the watch, it simply has no laps.
 */
export function mappedOnWatch(exerciseId: string): boolean {
  const key = corosKeyOf(exerciseId);
  return key !== null && libraryIdsByKey().get(key) === exerciseId;
}

/**
 * RULING 3-R7. The watch's entries paired with the build's: by library id first; then, for what is left, by order —
 * only when the build's FREE-TEXT entries left and the watch's UNMAPPED entries left (`coros:<T-code>`: a free-text
 * step's laps) number the same. A mapped build move left over was skipped on the watch (it could only have come back
 * under its own id), so it takes no part in the count: one skipped mapped move no longer un-pairs every free-text move
 * (audit 3-B S-7). A mapped watch entry the build does not hold is a move added on the watch: never paired by order,
 * kept as its own entry. A paired entry shows what the watch logged — one lap per set, or per side of a one-sided move
 * (left, right, alternating), each pair answering one build set — and only where the watch logged fewer, the build's
 * remaining targets (not done). An entry with nothing logged shows its targets, not done (a skipped move).
 *
 * Order: the paired entries in the build's order, then the watch's own, then the build's with nothing logged.
 */
export function pairWatchSets(
  build: BuildPayload,
  watch: ReadonlyArray<WatchEntry>,
  mapped: (exerciseId: string) => boolean = mappedOnWatch,
): WatchReviewEntry[] {
  const entries = buildEntries(build);
  const pairedWith = new Map<number, number>();
  const used = new Set<number>();
  entries.forEach((e, b) => {
    const w = watch.findIndex((x, i) => !used.has(i) && x.exerciseId === e.exerciseId);
    if (w >= 0) {
      pairedWith.set(b, w);
      used.add(w);
    }
  });
  const buildLeft = entries.map((_, b) => b).filter((b) => !pairedWith.has(b) && !mapped(entries[b]!.exerciseId));
  const watchLeft = watch.map((_, w) => w).filter((w) => !used.has(w) && unmapped(watch[w]!.exerciseId));
  if (buildLeft.length > 0 && buildLeft.length === watchLeft.length) {
    buildLeft.forEach((b, i) => {
      pairedWith.set(b, watchLeft[i]!);
      used.add(watchLeft[i]!);
    });
  }

  const numbered = (sets: Array<Omit<PerformedSet, "setIndex"> & { from: "watch" | "target" }>) => sets.map((s, setIndex) => ({ ...s, setIndex }));
  const target = (l: Lap) => ({ side: l.side, reps: l.reps, seconds: l.seconds, load: l.load, done: false, flags: [] as string[], from: "target" as const });
  const out: WatchReviewEntry[] = [];
  entries.forEach((e, b) => {
    const w = pairedWith.get(b);
    if (w === undefined) return;
    const logged = watch[w]!.sets.map((s, i) => ({
      side: e.perSide ? (i % 2 === 0 ? ("left" as const) : ("right" as const)) : s.side,
      reps: s.reps,
      seconds: s.seconds,
      load: s.load,
      done: s.done,
      flags: [...s.flags],
      from: "watch" as const,
    }));
    out.push({
      exerciseId: e.exerciseId,
      perSide: e.perSide,
      format: e.format,
      implement: null,
      sets: numbered([...logged, ...e.laps.slice(logged.length).map(target)]),
    });
  });
  watch.forEach((x, w) => {
    if (used.has(w) || x.sets.length === 0) return;
    out.push({
      exerciseId: x.exerciseId,
      perSide: false,
      format: null,
      implement: null,
      sets: numbered(x.sets.map((s) => ({ side: s.side, reps: s.reps, seconds: s.seconds, load: s.load, done: s.done, flags: [...s.flags], from: "watch" as const }))),
    });
  });
  entries.forEach((e, b) => {
    if (pairedWith.has(b) || e.laps.length === 0) return;
    out.push({ exerciseId: e.exerciseId, perSide: e.perSide, format: e.format, implement: null, sets: numbered(e.laps.map(target)) });
  });
  return out;
}

// ── What the review is of ─────────────────────────────────────────────────────────────────────────────────────────

type SlotRow = typeof plannedWorkouts.$inferSelect;

interface Reviewed {
  slot: SlotRow;
  activity: { id: string; corosActivityId: string; startTime: string; startTimeLocal: string | null; durationSeconds: number; elapsedSeconds: number | null };
  build: { id: string; date: string };
}

/** The user's live program / on-demand slot; `SessionNotFoundError` otherwise. */
async function reviewSlot(db: Db, userId: string, workoutId: string): Promise<SlotRow> {
  const [slot] = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.id, workoutId), eq(plannedWorkouts.userId, userId), isNull(plannedWorkouts.archivedAt)))
    .limit(1);
  if (!slot || (slot.origin !== "program" && slot.origin !== "on_demand")) throw new SessionNotFoundError();
  return slot;
}

/**
 * The slot's watch activity and locked build, in ONE read: the active match the import made (`REVIEWED_MATCHES`) to a
 * COROS activity, and the slot's locked build with the day it was built for. Null when either is missing.
 */
async function reviewedOf(db: Db, userId: string, slot: SlotRow): Promise<Reviewed | null> {
  const [row] = await db
    .select({
      activityId: activities.id,
      corosActivityId: activities.corosActivityId,
      startTime: activities.startTime,
      startTimeLocal: activities.startTimeLocal,
      durationSeconds: activities.durationSeconds,
      elapsedSeconds: activities.elapsedSeconds,
      buildId: sessionBuilds.id,
      buildDate: sql<string | null>`json_extract(${sessionBuilds.payload}, '$.build.date')`,
    })
    .from(workoutCompletionMatches)
    .innerJoin(activities, and(eq(activities.id, workoutCompletionMatches.activityId), eq(activities.userId, userId)))
    .innerJoin(sessionBuilds, and(eq(sessionBuilds.workoutId, slot.id), eq(sessionBuilds.userId, userId), isNotNull(sessionBuilds.lockedAt)))
    .where(
      and(
        eq(workoutCompletionMatches.workoutId, slot.id),
        isNull(workoutCompletionMatches.undoneAt),
        inArray(workoutCompletionMatches.method, [...REVIEWED_MATCHES]),
        isNotNull(activities.corosActivityId),
      ),
    )
    .orderBy(desc(sessionBuilds.version))
    .limit(1);
  if (!row || !row.corosActivityId || typeof row.buildDate !== "string" || !isLocalDate(row.buildDate)) return null;
  return {
    slot,
    activity: {
      id: row.activityId,
      corosActivityId: row.corosActivityId,
      startTime: row.startTime,
      startTimeLocal: row.startTimeLocal,
      durationSeconds: row.durationSeconds,
      elapsedSeconds: row.elapsedSeconds,
    },
    build: { id: row.buildId, date: row.buildDate },
  };
}

/** Is the locked build the one the athlete SENT (a live push names it)? Then COROS may have moved its day. */
async function sentBuild(db: Db, buildId: string): Promise<boolean> {
  const [push] = await db
    .select({ id: corosWriteJobs.id })
    .from(corosWriteJobs)
    .where(and(eq(corosWriteJobs.id, pushJobId(buildId)), eq(corosWriteJobs.kind, "program_session_push"), notInArray(corosWriteJobs.status, [...SETTLED_PUSH])))
    .limit(1);
  return push !== undefined;
}

/**
 * The session's days: the build's, and — for a sent build COROS moved (the import adopted the move) — the slot's own.
 * The review is offered, and a save taken, on one of them or the day after.
 */
async function sessionDays(db: Db, r: Reviewed): Promise<string[]> {
  if (r.slot.effectiveDate === r.build.date) return [r.build.date];
  return (await sentBuild(db, r.build.id)) ? [r.build.date, r.slot.effectiveDate].sort() : [r.build.date];
}

const within = (date: string, days: readonly string[]): boolean => days.some((d) => date >= d && date <= addDays(d, 1));

/**
 * Another session of the slot — or of its watch activity — is the app's own or a review already (3-R8): none to offer,
 * and none to save. The save asks it too, with its own id left out (audit 3-B S-3): asking the slot alone let an
 * outbox review land on an activity another slot's app session had joined — one physical session counted twice.
 */
async function claimedAlready(db: Db, userId: string, slotId: string, activityId: string, except?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: performedSessions.id })
    .from(performedSessions)
    .where(
      and(
        eq(performedSessions.userId, userId),
        or(eq(performedSessions.workoutId, slotId), eq(performedSessions.activityId, activityId)),
        inArray(performedSessions.source, ["app", "watch_review"]),
        ne(performedSessions.payloadHash, PENDING_HASH),
        ...(except !== undefined ? [ne(performedSessions.id, except)] : []),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** A non-negative number read out of a stored payload, rounded whole; null for anything else. */
const wholeOrNull = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);

/** A UTC instant as the save's wire takes it. */
const instant = (iso: string): string => new Date(iso).toISOString();

/**
 * `GET /api/sessions/:workoutId/watch-review`: the review's basis — the watch's sets paired with the locked build's
 * entries, the activity's times, the post-check's profiles. `SessionNotFoundError` (404) whenever it is not offered.
 */
export async function watchReviewBasis(
  db: Db,
  userId: string,
  workoutId: string,
  ctx: { today: string; unit?: WeightUnit },
): Promise<WatchReviewBasis> {
  const slot = await reviewSlot(db, userId, workoutId);
  const r = await reviewedOf(db, userId, slot);
  if (!r) throw new SessionNotFoundError();
  if (!within(ctx.today, await sessionDays(db, r))) throw new SessionNotFoundError();
  if (await claimedAlready(db, userId, slot.id, r.activity.id)) throw new SessionNotFoundError();

  // The build itself (its steps pair with the watch's sets), and the watch's own logged sets — the derived `watch`
  // session of the activity, committed (never one mid-write).
  const [stored] = await db.select({ payload: sessionBuilds.payload }).from(sessionBuilds).where(eq(sessionBuilds.id, r.build.id)).limit(1);
  const build = (stored?.payload as { build?: BuildPayload } | undefined)?.build;
  if (!build) throw new SessionNotFoundError();
  const rows = await db
    .select({
      entryIndex: performedSets.entryIndex,
      exerciseId: performedSets.exerciseId,
      setIndex: performedSets.setIndex,
      side: performedSets.side,
      reps: performedSets.reps,
      seconds: performedSets.seconds,
      loadValue: performedSets.loadValue,
      loadUnit: performedSets.loadUnit,
      done: performedSets.done,
    })
    .from(performedSets)
    .innerJoin(performedSessions, eq(performedSessions.id, performedSets.performedSessionId))
    .where(
      and(
        eq(performedSessions.userId, userId),
        eq(performedSessions.activityId, r.activity.id),
        eq(performedSessions.source, WATCH_SOURCE),
        ne(performedSessions.payloadHash, PENDING_HASH),
      ),
    )
    .orderBy(asc(performedSets.entryIndex), asc(performedSets.setIndex));
  const watch: WatchEntry[] = [];
  const byEntry = new Map<number, WatchEntry>();
  for (const s of rows) {
    let entry = byEntry.get(s.entryIndex);
    if (!entry) {
      entry = { exerciseId: s.exerciseId, sets: [] };
      byEntry.set(s.entryIndex, entry);
      watch.push(entry);
    }
    entry.sets.push({
      setIndex: s.setIndex,
      side: s.side === "left" || s.side === "right" ? s.side : null,
      reps: s.reps,
      seconds: s.seconds,
      load: s.loadValue !== null && s.loadValue > 0 && (s.loadUnit === "lb" || s.loadUnit === "kg") ? { v: s.loadValue, u: s.loadUnit } : null,
      done: s.done,
      flags: [],
    });
  }
  const span = r.activity.elapsedSeconds ?? r.activity.durationSeconds;
  const startMs = Date.parse(r.activity.startTime);
  return {
    workoutId: slot.id,
    buildId: r.build.id,
    activityId: r.activity.id,
    sourceRef: r.activity.corosActivityId,
    localDate: (r.activity.startTimeLocal ?? `${r.build.date}T`).slice(0, 10),
    startedAt: instant(r.activity.startTime),
    endedAt: Number.isFinite(startMs) && span > 0 ? new Date(startMs + Math.round(span) * 1000).toISOString() : null,
    seconds: Math.max(0, Math.round(r.activity.durationSeconds)),
    newMove: build.newMove,
    entries: pairWatchSets(build, watch).map((e) => ({ ...e, name: build.exercises[e.exerciseId]?.name ?? exerciseDisplayName(e.exerciseId) })),
    profiles: (await activeProfileIds(db, userId)).map(conditionView),
    before: Object.fromEntries(
      Object.entries(build.params?.checks ?? {}).map(([id, c]) => [id, { pre: c?.pre ?? null, feelingOff: Boolean(c?.feelingOff) }]),
    ),
    unit: ctx.unit ?? "lb",
  };
}

// ── Today's list ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface WatchReviewOffer {
  workoutId: string;
  /** The program's name (the slot's title without its theme). */
  title: string;
  /** The session's day. */
  date: string;
  /** How long the watch session ran. */
  seconds: number;
  /** The slot's category: Today's dot. */
  category: string;
}

/**
 * TODAY'S "LOG YOUR SESSION" (spec §5): the slots whose review is offered today — the session's day today or
 * yesterday — in ONE read, no UNION: the slot, its active import match to a COROS activity, its locked build, and
 * none of its (or its activity's) app or review sessions saved. A sent build COROS moved takes the slot's day.
 */
export async function watchReviewOffers(db: Db, userId: string, today: string): Promise<WatchReviewOffer[]> {
  const yesterday = addDays(today, -1);
  const buildDate = sql<string>`json_extract(${sessionBuilds.payload}, '$.build.date')`;
  const sent = sql`exists (select 1 from ${corosWriteJobs} where ${corosWriteJobs.id} = 'push:' || ${sessionBuilds.id} and ${corosWriteJobs.kind} = 'program_session_push' and ${corosWriteJobs.status} not in ('superseded', 'cancelled', 'restored'))`;
  const rows = await db
    .select({
      workoutId: plannedWorkouts.id,
      title: sql<string>`coalesce(${programs.name}, ${plannedWorkouts.title})`,
      effectiveDate: plannedWorkouts.effectiveDate,
      category: plannedWorkouts.category,
      buildDate,
      sent: sql<number>`${sent}`,
      seconds: activities.durationSeconds,
    })
    .from(plannedWorkouts)
    .innerJoin(
      workoutCompletionMatches,
      and(
        eq(workoutCompletionMatches.workoutId, plannedWorkouts.id),
        isNull(workoutCompletionMatches.undoneAt),
        inArray(workoutCompletionMatches.method, [...REVIEWED_MATCHES]),
      ),
    )
    .innerJoin(activities, and(eq(activities.id, workoutCompletionMatches.activityId), isNotNull(activities.corosActivityId)))
    .innerJoin(sessionBuilds, and(eq(sessionBuilds.workoutId, plannedWorkouts.id), eq(sessionBuilds.userId, userId), isNotNull(sessionBuilds.lockedAt)))
    .leftJoin(programs, eq(programs.id, plannedWorkouts.planId))
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        isNull(plannedWorkouts.archivedAt),
        inArray(plannedWorkouts.origin, ["program", "on_demand"]),
        or(inArray(buildDate, [today, yesterday]), and(inArray(plannedWorkouts.effectiveDate, [today, yesterday]), sent)),
        sql`not exists (select 1 from ${performedSessions} where ${performedSessions.userId} = ${userId} and (${performedSessions.workoutId} = ${plannedWorkouts.id} or ${performedSessions.activityId} = ${activities.id}) and ${performedSessions.source} in ('app', 'watch_review') and ${performedSessions.payloadHash} <> ${PENDING_HASH})`,
      ),
    )
    .orderBy(asc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.effectiveTime));
  const seen = new Set<string>();
  const out: WatchReviewOffer[] = [];
  for (const r of rows) {
    if (seen.has(r.workoutId)) continue;
    seen.add(r.workoutId);
    const days = r.sent && r.effectiveDate !== r.buildDate ? [r.buildDate, r.effectiveDate] : [r.buildDate];
    const date = days.filter((d) => d === today || d === yesterday).sort().at(-1) ?? r.buildDate;
    out.push({ workoutId: r.workoutId, title: r.title, date, seconds: Math.max(0, Math.round(r.seconds)), category: r.category });
  }
  return out;
}

// ── The save ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `PUT /api/sessions/performed/:id` with `source: "watch_review"` (session-save.ts has parsed the body, hashed it as
 * sent, and answered a settled id). Throws `InvalidSaveError` (422) — the slot holds no reviewable watch session, the
 * `sourceRef` is not its activity's COROS id, the `buildId` not its locked build, the day not the session's or the
 * next — and `SessionNotFoundError` (404).
 */
export async function saveWatchReview(db: Db, userId: string, p: PerformedSessionWire, hash: string, ctx: SaveCtx & { today: string }): Promise<SaveOutcome> {
  if (p.workoutId === null) throw new InvalidSaveError([{ message: "a watch review names its slot", path: ["workoutId"] }]);
  if (p.sourceRef === null) throw new InvalidSaveError([{ message: "a watch review names the COROS activity", path: ["sourceRef"] }]);
  const slot = await reviewSlot(db, userId, p.workoutId);
  // Ruling 3-R8, answered before anything else: an app session (or another review) of the slot is saved already.
  if (await savedByAnother(db, userId, slot.id, p.id)) return { status: "slot_done" };
  const r = await reviewedOf(db, userId, slot);
  if (!r) throw new InvalidSaveError([{ message: "the slot holds no watch session to review", path: ["workoutId"] }]);
  if (r.activity.corosActivityId !== p.sourceRef) {
    throw new InvalidSaveError([{ message: "the sourceRef is not the slot's matched COROS activity", path: ["sourceRef"] }]);
  }
  if (p.buildId !== r.build.id) throw new InvalidSaveError([{ message: "the buildId is not the slot's locked build", path: ["buildId"] }]);
  const days = await sessionDays(db, r);
  if (!within(p.localDate, days) || p.localDate > addDays(ctx.today, 1)) {
    throw new InvalidSaveError([{ message: `the session's day must be ${days.join(" or ")} or the next`, path: ["localDate"] }]);
  }
  if (await restoreInProgress(db, userId)) return { status: "restoring" };

  const lockKind = `save:${p.id}`;
  const token = await claimUserLock(db, userId, lockKind, 1);
  if (!token) return { status: "busy" };
  try {
    // What another request committed while this one waited for the lock is the answer.
    const [existing] = await db
      .select({ userId: performedSessions.userId, payloadHash: performedSessions.payloadHash })
      .from(performedSessions)
      .where(eq(performedSessions.id, p.id))
      .limit(1);
    if (existing && existing.payloadHash !== PENDING_HASH) {
      return existing.userId === userId && existing.payloadHash === hash ? { status: "same_payload" } : { status: "conflict" };
    }
    const merge = await claimMergeLocks(db, userId, p.localDate, ctx.today);
    if (!merge) return { status: "busy" };
    try {
      if (await restoreInProgress(db, userId)) return { status: "restoring" };
      if (await claimedAlready(db, userId, slot.id, r.activity.id, p.id)) return { status: "slot_done" };
      await runAtomically(db, await reviewStatements(db, userId, p, hash, r, ctx.now));
    } finally {
      await releaseMergeLocks(db, userId, merge);
    }
  } finally {
    await releaseUserLock(db, userId, lockKind, token);
  }
  return { status: "saved", performedId: p.id, activityId: r.activity.id, matched: true, notes: [] };
}

/**
 * The save's one transaction: the session (`pending` first), its sets and checks, the watch's derived session gone,
 * the activity named by the slot and the build's discipline, the slot done, the new move's first day, the garden's
 * replay on record — and the commit marker last. The match is left as it is (it is already this activity's).
 */
async function reviewStatements(db: Db, userId: string, p: PerformedSessionWire, hash: string, r: Reviewed, now: string): Promise<AtomicStatement[]> {
  // §9.2 from the locked build: a core lift → strength, else yoga (the watch files a mobility session as Strength).
  // And in the same read, what the session WAS, from the locked build the review is of — never from the client, whose
  // sheet has none of it (audit 3-B S-6): the engine reads mode (the 48-hour rule), theme (the rotation) and block
  // (block awards) from history, and a watch build-day stored null proposed `build` again the next day.
  const built = (path: string) => sql`json_extract(${sessionBuilds.payload}, ${path})`;
  const [locked] = await db
    .select({
      core: sql<number>`exists (select 1 from json_each(${sessionBuilds.payload}, '$.build.items') where json_extract(value, '$.block') = 'core')`,
      mode: sql<string | null>`${built("$.build.mode")}`,
      theme: sql<string | null>`${built("$.build.theme")}`,
      minutes: sql<number | null>`${built("$.build.minutes")}`,
      plannedSeconds: sql<number | null>`${built("$.build.plannedSeconds")}`,
      locationId: sql<string | null>`${built("$.build.locationId")}`,
      blockRef: sql<string | null>`${built("$.build.blockRef")}`,
      blockNumber: sql<number | null>`(select ${programBlocks.number} from ${programBlocks} where ${programBlocks.id} = ${built("$.build.blockRef")})`,
    })
    .from(sessionBuilds)
    .where(eq(sessionBuilds.id, r.build.id))
    .limit(1);
  const discipline = locked?.core ? "strength" : "yoga";
  const mode = sessionModeSchema.safeParse(locked?.mode);
  const prefs = await prefStatements(db, userId, p, now);
  const statements: AtomicStatement[] = [];
  const row = {
    id: p.id,
    userId,
    workoutId: r.slot.id,
    activityId: r.activity.id,
    buildId: p.buildId,
    source: "watch_review",
    sourceRef: p.sourceRef,
    localDate: p.localDate,
    startedAt: p.startedAt,
    endedAt: p.endedAt,
    seconds: p.seconds,
    plannedSeconds: wholeOrNull(locked?.plannedSeconds),
    minutes: wholeOrNull(locked?.minutes),
    mode: mode.success ? mode.data : null,
    theme: locked?.theme ?? null,
    locationId: locked?.locationId ?? null,
    blockRef: locked?.blockRef ?? null,
    blockNumber: locked?.blockRef ? wholeOrNull(locked.blockNumber) : null,
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
  const { id: _id, userId: _u, createdAt: _c, ...changed } = row;
  statements.push(db.insert(performedSessions).values(row).onConflictDoUpdate({ target: performedSessions.id, set: changed }));
  // Its sets and checks — a retry clears what an earlier attempt left first.
  statements.push(db.delete(performedSets).where(eq(performedSets.performedSessionId, p.id)));
  statements.push(db.delete(conditionChecks).where(and(eq(conditionChecks.userId, userId), eq(conditionChecks.performedSessionId, p.id))));
  for (const batch of insertBatches(setRows(p.id, p))) statements.push(db.insert(performedSets).values(batch));
  const checks = p.checks.map((c) => ({
    id: `${p.id}:${c.kind}:${c.profileId}`,
    userId,
    profileId: c.profileId,
    kind: c.kind,
    value: c.value,
    feelingOff: c.feelingOff,
    localDate: p.localDate,
    at: c.at,
    performedSessionId: p.id,
    workoutId: r.slot.id,
  }));
  for (const batch of insertBatches(checks)) statements.push(db.insert(conditionChecks).values(batch));
  // The watch's own derived session of the activity goes: the review owns its sets (one session, counted once).
  const watchCopies = db
    .select({ id: performedSessions.id })
    .from(performedSessions)
    .where(and(eq(performedSessions.userId, userId), eq(performedSessions.activityId, r.activity.id), eq(performedSessions.source, WATCH_SOURCE)));
  statements.push(db.delete(performedSets).where(inArray(performedSets.performedSessionId, watchCopies)));
  statements.push(
    db
      .delete(performedSessions)
      .where(and(eq(performedSessions.userId, userId), eq(performedSessions.activityId, r.activity.id), eq(performedSessions.source, WATCH_SOURCE))),
  );
  // The activity takes the slot's title and the build's discipline; the import keeps them (completion.ts).
  statements.push(db.update(activities).set({ title: r.slot.title, sport: discipline, updatedAt: now }).where(eq(activities.id, r.activity.id)));
  // The slot is done (its match completed it already).
  statements.push(db.update(plannedWorkouts).set({ contentState: "done", updatedAt: now }).where(and(eq(plannedWorkouts.id, r.slot.id), eq(plannedWorkouts.userId, userId))));
  statements.push(...prefs);
  const activityDay = (r.activity.startTimeLocal ?? p.localDate).slice(0, 10);
  statements.push(gardenChangeStatement(db, userId, [r.slot.effectiveDate, p.localDate, activityDay].sort()[0]!));
  // Commit marker: everything above lands with it, or none of it does.
  statements.push(db.update(performedSessions).set({ payloadHash: hash, updatedAt: now }).where(eq(performedSessions.id, p.id)));
  return statements;
}
