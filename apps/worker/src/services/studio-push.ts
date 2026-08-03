/**
 * PLAN STUDIO PUSH ORCHESTRATION — the state machine that decides what gets
 * created and deleted on the user's real COROS calendar.
 *
 * Spec: docs/superpowers/specs/2026-08-03-plan-studio-design.md §5.
 *
 * The bridge's create-executor is the safety core: it refuses ambiguity, never
 * writes outside the target container plan, and never deletes anything whose
 * program-name stamp it cannot re-prove. It fails CLOSED. This module decides
 * what to ask it to do, so its own rules are what keep a well-behaved executor
 * from being pointed at the wrong thing:
 *
 *  1. IDENTITY IS (planId, happenDay, sessionTitle). Rows are UPSERTed on that
 *     triple, never inserted — the unique index would reject a re-push after a
 *     delete, and a second row for one session would double-write to COROS.
 *  2. STAMPS ARE UNIQUE PLAN-WIDE, NOT PER DAY. Two workouts sharing a name
 *     make BOTH undeletable, because ownership stops being decidable. Titles
 *     are validated against every live push row of the user before anything is
 *     enqueued; a collision fails locally and reaches no wire.
 *  3. A CHANGED SESSION IS DELETE-THEN-CREATE, CHAINED. The create rides on
 *     the delete job and is enqueued only once the delete has terminally gone.
 *     Enqueuing both up front would let a refused delete be followed by a
 *     create that adopts the stale workout via `already_present` and reports a
 *     content change that never happened.
 *  4. DRIFT IS NEVER CLOBBERED. A verified row whose observed workout has been
 *     renamed, moved or deleted on COROS by something other than the app
 *     itself is ADOPTED (`status: "adopted"`, spec §2) and excluded from both
 *     the delete batch and any recreate — never silently overwritten, and
 *     never left unmanaged forever: an undo route offers to re-push it.
 *  5. STRUCTURED CODES ONLY. Nothing an executor produced as prose is ever
 *     written to a row or shown to a user — executor messages can name
 *     workouts the user authored.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  auditEvents,
  corosExercises,
  corosWriteAttempts,
  corosWriteJobs,
  plannedWorkouts,
  studioPlanPushes,
  studioPlans,
} from "@rg/database";
import {
  addDays,
  compareLocalDates,
  createScheduledWorkoutJobSchema,
  deleteScheduledWorkoutJobSchema,
  fingerprint,
  isStudioJobKind,
  liftingPlanSchema,
  newId,
  nowInstant,
  startOfIsoWeek,
  type CorosWriteResult,
  type CreateScheduledWorkoutJob,
  type DeleteScheduledWorkoutJob,
  type LiftingPlan,
  type LocalDate,
  type StudioJobResult,
  type StudioPlanPushStatus,
  type StudioSession,
} from "@rg/domain";
import { chunkIds, type Db } from "./db.js";
import { appRequestedDates } from "./sync-intents.js";
import { postSyncNote } from "./sync-notes.js";

// ── The plan grid → calendar days ───────────────────────────────────────────

/**
 * Where week `weekIndex`, ISO weekday `weekday` (1 = Mon … 7 = Sun) lands.
 *
 *     happenDay = startOfIsoWeek(startDate) + weekIndex × 7 + (weekday − 1)
 *
 * The grid is anchored to the ISO week CONTAINING startDate, not to startDate
 * itself, because `preferredDays` are weekdays: "Mondays and Thursdays" has to
 * mean the same two columns in every week of the plan, including the first.
 * Anchoring to startDate would rotate week 0 and make its weekdays disagree
 * with every later week.
 *
 * A consequence, deliberate and handled: when startDate falls mid-week, week
 * 0 sessions earlier in that week compute to days BEFORE startDate — possibly
 * before today. Those are refused individually (`day_in_past`) rather than
 * shifted, because silently moving a session to a different day is a worse
 * surprise than a visible refusal, and shifting would collide with whatever
 * already occupies the target day.
 */
export function sessionHappenDay(
  startDate: LocalDate,
  weekIndex: number,
  weekday: number,
): LocalDate {
  return addDays(startOfIsoWeek(startDate), weekIndex * 7 + (weekday - 1));
}

/**
 * The workout name written to COROS — and the ownership stamp that is the ONLY
 * thing authorizing a later delete. The week number is part of it because the
 * stamp must be unique across the whole container plan, and a plan repeating
 * "Upper A" every week would otherwise emit one name many times.
 */
export function sessionStamp(title: string, weekIndex: number): string {
  return `${title} — wk ${weekIndex + 1}`;
}

export interface DesiredSession {
  weekIndex: number;
  happenDay: LocalDate;
  /** The stamp. Also the third element of the push row's identity. */
  sessionTitle: string;
  session: StudioSession;
  /** Deep-content fingerprint; the diff's "changed" test compares this. */
  fingerprint: string;
}

/** Every session of a draft plan, expanded onto concrete calendar days. */
export function desiredSessions(plan: LiftingPlan): DesiredSession[] {
  const out: DesiredSession[] = [];
  plan.weeks.forEach((week, weekIndex) => {
    for (const session of week.sessions) {
      out.push({
        weekIndex,
        happenDay: sessionHappenDay(plan.brief.startDate, weekIndex, session.weekday),
        sessionTitle: sessionStamp(session.title, weekIndex),
        session,
        fingerprint: fingerprint(session),
      });
    }
  });
  return out;
}

// ── Drift detection ─────────────────────────────────────────────────────────

/** The fields of a push row this module reasons over. */
export interface PushRow {
  id: string;
  planId: string;
  happenDay: LocalDate;
  sessionTitle: string;
  sessionFingerprint: string | null;
  corosIdInPlan: string | null;
  corosProgramId: string | null;
  corosPlanId: string | null;
  /**
   * Where the workout ACTUALLY is, when the server filed it somewhere other
   * than `happenDay`. `happenDay` is half the row's identity and never moves;
   * this is what a delete has to be addressed at.
   */
  corosHappenDay: string | null;
  /** pending | verified | failed | deleted | adopted (spec §2). */
  status: string;
  /** The structured failure code, when the row is in a failed state. */
  error: string | null;
}

/**
 * The day a delete for this row must target: where the workout actually is,
 * falling back to the day the plan asked for. Addressing the requested day for
 * a workout the server filed elsewhere gets `stamp_mismatch` — which would
 * mislabel this app's own stray as a user edit and make it permanently
 * untouchable.
 */
export function deleteTargetDay(row: PushRow): string {
  return row.corosHappenDay ?? row.happenDay;
}

/**
 * LEGACY. A row the studio no longer provably owns, written by an older
 * build directly into `error` on a `failed` row. Superseded by the
 * `status === "adopted"` transition (spec §2) — a genuine external edit is
 * now ADOPTED rather than parked as a permanent failure, with an undo route
 * offering to re-push the original. Kept only so rows a pre-Task-7 push
 * already marked this way stay untouchable until Task 8's healing migrates
 * them; every NEW discovery of the same fact uses `"adopted"` instead.
 */
export const CHANGED_ON_COROS = "changed_on_coros";

/** One workout as the last snapshot left it in `planned_workouts`. */
export interface ObservedWorkout {
  /** `${corosPlanId}:${idInPlan}` — plan-scoped, since id counters overlap. */
  sourceWorkoutId: string;
  title: string;
  /** What COROS last reported, NOT the locally-moved effective date. */
  corosDate: LocalDate;
  /**
   * Why the source workout is archived, or `null` if it is not. Only
   * `"absence_confirmed"` (the importer confirmed it gone from COROS over two
   * consecutive reads) means COROS-side drift; `"user_removed"` and
   * `"duplicate_mirror"` are the app's own bookkeeping and never drift.
   */
  archiveReason: string | null;
}

export type DriftKind = "missing" | "renamed" | "moved" | "app_moved";
export interface DriftFinding {
  pushId: string;
  kind: DriftKind;
  /** Where the workout was actually observed, when the kind carries one. */
  observedDay?: string;
}

/**
 * Compare verified push rows against the last snapshot's container-plan
 * contents. A mismatch means the user edited COROS directly, and the row must
 * not be clobbered by a push — UNLESS the app itself is the one that moved
 * it, recognized via `appMoves` (the intent ledger's record of every date the
 * app asked a workout to move to), in which case it is `"app_moved"`: still
 * ours, not a user edit.
 *
 * ABSENCE IS NOT DRIFT. A row the snapshot has no opinion about (outside its
 * window, or not yet synced) is left alone; only an ARCHIVED observation —
 * which the importer writes after two consecutive reads confirmed the workout
 * gone — counts as deleted-on-COROS. Treating plain absence as drift would
 * mark every session beyond the snapshot window on the first push. And an
 * archive reason that is the app's OWN bookkeeping (`user_removed`,
 * `duplicate_mirror`) is not a COROS-side deletion either — only
 * `absence_confirmed` is.
 */
export function detectDrift(
  rows: PushRow[],
  observed: Map<string, ObservedWorkout>,
  appMoves: Map<string, Set<string>>,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const row of rows) {
    if (row.status !== "verified") continue;
    if (!row.corosIdInPlan || !row.corosPlanId) continue;
    const key = `${row.corosPlanId}:${row.corosIdInPlan}`;
    const seen = observed.get(key);
    if (!seen) continue;
    if (seen.archiveReason === "absence_confirmed") {
      findings.push({ pushId: row.id, kind: "missing" });
    } else if (seen.archiveReason) {
      // user_removed / duplicate_mirror: the app's own bookkeeping, not a
      // COROS-side deletion. Not drift.
    } else if (seen.title !== row.sessionTitle) {
      findings.push({ pushId: row.id, kind: "renamed", observedDay: seen.corosDate });
    } else if (seen.corosDate !== row.happenDay) {
      findings.push(
        appMoves.get(key)?.has(seen.corosDate)
          ? { pushId: row.id, kind: "app_moved", observedDay: seen.corosDate }
          : { pushId: row.id, kind: "moved", observedDay: seen.corosDate },
      );
    }
  }
  return findings;
}

// ── The diff ────────────────────────────────────────────────────────────────

/** Refusals decided locally; none of these ever reaches the wire. */
export type PushFailureCode =
  | "duplicate_title"
  | "day_in_past"
  | "no_exercises"
  | "unknown_exercise"
  | "unaddressable";

export interface PlannedCreate {
  desired: DesiredSession;
  /** The existing row for this identity, when there is one. */
  row?: PushRow;
}

export interface PlannedDelete {
  row: PushRow;
  /** Present when this delete is the first half of a CHANGED session. */
  followUp?: DesiredSession;
}

export interface PlannedFailure {
  /** Absent when no row exists for this identity yet. */
  pushId?: string;
  happenDay: LocalDate;
  sessionTitle: string;
  error: PushFailureCode;
}

export interface PushBatch {
  creates: PlannedCreate[];
  deletes: PlannedDelete[];
  /** Rows to mark `deleted` locally: nothing addressable exists to remove. */
  localDeletes: string[];
  failures: PlannedFailure[];
  /** Ids of verified rows the draft still matches exactly. */
  unchanged: string[];
  /**
   * Ids skipped because they are `adopted` (or, legacy, `changed_on_coros`):
   * this push would have acted on them and deliberately did not. Counted so
   * the UI can say "3 sessions changed on COROS" rather than silently doing
   * less than asked.
   */
  blocked: string[];
}

export interface PlanPushInput {
  desired: DesiredSession[];
  /** Existing push rows for THIS studio plan. */
  rows: PushRow[];
  /** Stamps committed by live (non-deleted) rows of the user's OTHER plans. */
  otherLiveTitles: string[];
  /**
   * Rows drifted on COROS THIS pass. Rows already `status === "adopted"` (or,
   * legacy, carrying the `changed_on_coros` code) are excluded automatically —
   * a push that discovered drift last week must not delete the workout this
   * week.
   */
  driftedPushIds: Set<string>;
  /** originIds present in the synced COROS catalog. */
  catalogIds: Set<string>;
  today: LocalDate;
}

/**
 * The push-row identity key. `happenDay` is fixed-width (YYYY-MM-DD), so a
 * plain space cannot make two different (day, title) pairs collide.
 */
const identity = (happenDay: string, sessionTitle: string): string =>
  `${happenDay} ${sessionTitle}`;

/** A row can only be deleted if we recorded the whole address to delete by. */
function addressable(row: PushRow): boolean {
  return Boolean(row.corosIdInPlan && row.corosProgramId && row.corosPlanId);
}

/**
 * Draft-vs-pushed diff. Pure: everything it needs is in the input, so every
 * transition is unit-testable without a database.
 *
 * Deletes are emitted before creates by construction, and the caller enqueues
 * them in that order — the container plan must never hold two workouts under
 * one stamp, even transiently.
 */
export function planPush(input: PlanPushInput): PushBatch {
  const batch: PushBatch = {
    creates: [],
    deletes: [],
    localDeletes: [],
    failures: [],
    unchanged: [],
    blocked: [],
  };

  const rowByKey = new Map(input.rows.map((r) => [identity(r.happenDay, r.sessionTitle), r]));
  const desiredKeys = new Set(input.desired.map((d) => identity(d.happenDay, d.sessionTitle)));
  // Drift found now, plus drift found by any earlier push. Without the second
  // half, the row's status would have moved off `verified`, `detectDrift`
  // would skip it, and the NEXT push would happily delete the workout the
  // user had taken over.
  const untouchable = new Set([
    ...input.driftedPushIds,
    ...input.rows.filter((r) => r.status === "adopted" || r.error === CHANGED_ON_COROS).map((r) => r.id),
  ]);

  // ── 1. Removals: rows the draft no longer contains ────────────────────────
  for (const row of input.rows) {
    if (row.status === "deleted") continue;
    if (desiredKeys.has(identity(row.happenDay, row.sessionTitle))) continue;
    // Drift is surfaced, never clobbered: the user's own edit wins.
    if (untouchable.has(row.id)) {
      batch.blocked.push(row.id);
      continue;
    }

    if (addressable(row)) {
      batch.deletes.push({ row });
    } else if (row.status === "pending") {
      // A create that never reported. It MAY have landed, and there is no
      // address to remove it by — say so rather than claim it is gone.
      batch.failures.push({
        pushId: row.id,
        happenDay: row.happenDay,
        sessionTitle: row.sessionTitle,
        error: "unaddressable",
      });
    } else {
      // Failed before anything materialized: nothing exists on COROS.
      batch.localDeletes.push(row.id);
    }
  }

  // ── 2. Group the draft by identity; collapse and refuse duplicates ────────
  const groups = new Map<string, DesiredSession[]>();
  for (const d of input.desired) {
    const key = identity(d.happenDay, d.sessionTitle);
    const group = groups.get(key);
    if (group) group.push(d);
    else groups.set(key, [d]);
  }

  // Titles already committed to the container plan, minus (a) the rows this
  // push is removing, which free their names, and (b) the row that IS the
  // session being re-pushed.
  const freed = new Set([...batch.deletes.map((d) => d.row.id), ...batch.localDeletes]);
  const liveTitles = new Set<string>(input.otherLiveTitles);
  for (const row of input.rows) {
    if (row.status === "deleted") continue;
    if (freed.has(row.id)) continue;
    if (desiredKeys.has(identity(row.happenDay, row.sessionTitle))) continue;
    liveTitles.add(row.sessionTitle);
  }

  // A stamp used by more than one identity in this batch cannot be created at
  // all: whichever went first would make the other undeletable. Neither is
  // arbitrarily preferred — both are refused.
  const titleCounts = new Map<string, number>();
  for (const [, group] of groups) {
    const title = group[0]!.sessionTitle;
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }

  // ── 3. Per-identity decision ──────────────────────────────────────────────
  for (const [key, group] of groups) {
    const first = group[0]!;
    const row = rowByKey.get(key);
    if (row && untouchable.has(row.id)) {
      batch.blocked.push(row.id); // adopted (or legacy changed_on_coros): not ours to touch
      continue;
    }

    const fail = (error: PushFailureCode): void => {
      batch.failures.push({
        ...(row ? { pushId: row.id } : {}),
        happenDay: first.happenDay,
        sessionTitle: first.sessionTitle,
        error,
      });
    };

    // Nothing already verified and identical needs any work.
    if (row && row.status === "verified" && row.sessionFingerprint === first.fingerprint) {
      batch.unchanged.push(row.id);
      continue;
    }

    // Refusal order is fixed so the reported reason is deterministic.
    if (group.length > 1 || (titleCounts.get(first.sessionTitle) ?? 0) > 1 || liveTitles.has(first.sessionTitle)) {
      fail("duplicate_title");
      continue;
    }
    if (compareLocalDates(first.happenDay, input.today) < 0) {
      fail("day_in_past");
      continue;
    }
    if (first.session.exercises.length === 0) {
      fail("no_exercises");
      continue;
    }
    const unknown = first.session.exercises.find((e) => !input.catalogIds.has(e.originId));
    if (unknown) {
      fail("unknown_exercise");
      continue;
    }

    // An addressable row means something with this stamp is (or may be) on
    // COROS: remove it first, then recreate. That covers both a changed
    // session and a failed create that left a stray behind.
    if (row && addressable(row)) batch.deletes.push({ row, followUp: first });
    else batch.creates.push({ desired: first, ...(row ? { row } : {}) });
  }

  return batch;
}

// ── Result → row transitions ────────────────────────────────────────────────

export interface PushTransition {
  status: StudioPlanPushStatus;
  /** A structured code, never a message. `null` clears any previous one. */
  error: string | null;
  /** Copy the result's server ids onto the row. */
  persistIds: boolean;
  /** Null the recorded ids: they no longer address anything. */
  clearIds: boolean;
  job: "verified" | "failed" | "retry";
}

/**
 * Create outcome → row transition.
 *
 * Two rules worth stating out loud:
 *
 *  - `reason: "error"` is RETRYABLE with the same spec. It covers a network
 *    failure mid-create as well as a local build failure, and a retry is safe
 *    because a create whose response was lost comes back `already_present` —
 *    the executor's idempotency guarantee. Treating it as terminal would strand
 *    sessions on a single flaky request.
 *  - ids are persisted for `wrong_date`, `rejected` and `error` as well as for
 *    success, because in all three something may have materialized and the
 *    user must be able to remove it. They are NOT persisted for a cross-day
 *    `already_present`: the executor deliberately strips them there, and
 *    reconstructing an address would aim a later delete at the wrong day.
 */
export function mapCreateResult(
  result: StudioJobResult,
  attemptsExhausted: boolean,
): PushTransition {
  const terminal = (error: string, persistIds = false): PushTransition => ({
    status: "failed",
    error,
    persistIds,
    clearIds: false,
    job: "failed",
  });
  const retryable = (error: string, persistIds: boolean): PushTransition =>
    attemptsExhausted
      ? terminal(error, persistIds)
      : { status: "pending", error: null, persistIds, clearIds: false, job: "retry" };

  if (result.ok) {
    return { status: "verified", error: null, persistIds: true, clearIds: false, job: "verified" };
  }
  switch (result.reason) {
    case "error":
      return retryable("create_failed", true);
    case "slot_occupied":
      return retryable("slot_occupied", false);
    case "already_present":
      // ok:false + already_present = the same stamp on ANOTHER day: the user
      // moved it in COROS. Same "the user took this over" fact drift
      // detection surfaces elsewhere — ADOPTED, not a permanent failure.
      return { status: "adopted", error: null, persistIds: false, clearIds: false, job: "failed" };
    case "no_target_plan":
      // The account's active plan is not the one this row was written against.
      // Retrying would loop against a moving target — surface it instead.
      return terminal("plan_identity_changed");
    case "out_of_span":
      return terminal("out_of_span");
    case "rejected":
      return terminal("rejected", true);
    case "wrong_date":
      return terminal("wrong_date", true);
    case "not_visible":
      return terminal("not_visible");
    default:
      return terminal("create_failed");
  }
}

/**
 * Delete outcome → row transition.
 *
 * Asymmetric with creates on purpose: a delete that came back `ok: false` with
 * NO refusal means the executor could not PROVE the delete was safe or
 * complete (including its plan-wide "did this remove something I did not
 * create?" check). A destructive path whose safety is unproven is never looped
 * automatically — it is surfaced for a person to look at.
 */
export function mapDeleteResult(
  result: StudioJobResult,
  _attemptsExhausted: boolean,
): PushTransition {
  const gone = (): PushTransition => ({
    status: "deleted",
    error: null,
    persistIds: false,
    clearIds: true,
    job: "verified",
  });
  const terminal = (error: string): PushTransition => ({
    status: "failed",
    error,
    persistIds: false,
    clearIds: false,
    job: "failed",
  });

  if (result.ok) return gone();
  switch (result.refused) {
    case "not_found":
      // Nothing carrying the stamp is in the plan and the address is free:
      // no delete was sent because there was nothing to send one for.
      return gone();
    case "stamp_mismatch":
      // Same "the user took this over" fact as create's cross-day
      // already_present, discovered here at write time instead — ADOPTED.
      return { status: "adopted", error: null, persistIds: false, clearIds: false, job: "failed" };
    case "ambiguous":
      return terminal("delete_ambiguous");
    default:
      return terminal("delete_unverified");
  }
}

// ── Job payloads ────────────────────────────────────────────────────────────

/** The stored delete payload: bridge-facing fields plus the chained create. */
export interface StoredDeletePayload extends DeleteScheduledWorkoutJob {
  followUpCreate?: CreateScheduledWorkoutJob;
}

/**
 * The subset of a stored payload the bridge is handed. A delete's follow-up
 * create never leaves the worker: the bridge has no use for it, and the whole
 * point of chaining is that the worker decides whether it happens.
 */
export function bridgeJobPayload(job: {
  kind: string;
  payload: unknown;
}): Record<string, unknown> | undefined {
  if (job.kind === "create_scheduled_workout") {
    const parsed = createScheduledWorkoutJobSchema.safeParse(job.payload);
    return parsed.success ? parsed.data : undefined;
  }
  if (job.kind === "delete_scheduled_workout") {
    const { followUpCreate: _dropped, ...rest } = (job.payload ?? {}) as StoredDeletePayload;
    const parsed = deleteScheduledWorkoutJobSchema.safeParse(rest);
    return parsed.success ? parsed.data : undefined;
  }
  return undefined;
}

// ── DB orchestration ────────────────────────────────────────────────────────

export interface PushSummary {
  ok: boolean;
  error?: "plan_not_found" | "invalid_plan";
  creates: number;
  deletes: number;
  failures: number;
  unchanged: number;
  /** Rows found to have drifted on COROS during THIS push. */
  drifted: number;
  /** Rows skipped because they are already `adopted` (incl. `drifted`). */
  blocked: number;
}

const IN_FLIGHT = ["queued", "claimed", "in_progress", "verifying"] as const;

async function loadObserved(db: Db, userId: string): Promise<Map<string, ObservedWorkout>> {
  const rows = await db
    .select({
      sourceWorkoutId: plannedWorkouts.sourceWorkoutId,
      title: plannedWorkouts.title,
      corosDate: plannedWorkouts.lastVerifiedCorosDate,
      archivedAt: plannedWorkouts.archivedAt,
      archiveReason: plannedWorkouts.archiveReason,
    })
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.userId, userId));
  return new Map(
    rows.map((r) => [
      r.sourceWorkoutId,
      {
        sourceWorkoutId: r.sourceWorkoutId,
        title: r.title,
        corosDate: r.corosDate,
        // Legacy archived rows written before Task 3's reasons existed carry
        // no `archiveReason`; today's semantics (archived at all ⇒ confirmed
        // gone) are preserved for them until Task 8's healing backfills one.
        archiveReason: r.archiveReason ?? (r.archivedAt ? "absence_confirmed" : null),
      },
    ]),
  );
}

/**
 * Compute the draft-vs-pushed diff and enqueue the COROS work it implies.
 *
 * Order of operations matters and is deliberate:
 *   1. validate the stored plan (zod) — an LLM-authored plan is never trusted;
 *   2. supersede this plan's in-flight jobs, so a re-push cannot race itself;
 *   3. detect drift and mark it BEFORE diffing, so drifted rows drop out of
 *      both the delete batch and any recreate;
 *   4. plan the batch purely, then write rows, then enqueue jobs with strictly
 *      increasing `requestedAt` so deletes are claimed before creates.
 *
 * `today` decides which days count as past and is REQUIRED — there is no UTC
 * default, because a silent UTC fallback misjudges a late-evening push by a
 * day. Callers pass `todayInZone(prefs.timezone)`; the compiler enforces it.
 *
 * Retrying failures needs no separate entry point: a failed row is re-planned
 * by the next push (deleted first if it left an addressable stray, then
 * recreated), so a per-session retry is a push of the same plan.
 */
export async function pushStudioPlan(
  db: Db,
  opts: {
    userId: string;
    studioPlanId: string;
    today: LocalDate;
    /**
     * Overrides `desiredSessions(plan)` with a caller-supplied desired set —
     * added for the "retire a superseded plan" path (`/api/studio/generate`
     * with `replace: true`): passing `[]` makes every existing row of the
     * plan look removed, so the diff's already-guarded removal machinery
     * (addressable → delete; pending-without-id → `unaddressable`;
     * failed-without-id → local delete) enqueues deletes for every live
     * session WITHOUT mutating the plan's own stored content (which stays
     * exactly as it was pushed, for history). Omitted by every other caller,
     * which keeps computing the desired set from the stored plan as before.
     */
    desiredOverride?: DesiredSession[];
    /**
     * An undo in flight: the caller has planned a corrective delete+create for
     * this row; re-adopting it mid-flight would cancel the correction.
     */
    suppressDriftPushIds?: Set<string>;
  },
): Promise<PushSummary> {
  const now = nowInstant();
  const today = opts.today;
  const empty: PushSummary = {
    ok: false,
    creates: 0,
    deletes: 0,
    failures: 0,
    unchanged: 0,
    drifted: 0,
    blocked: 0,
  };

  const planRow = (
    await db
      .select()
      .from(studioPlans)
      .where(and(eq(studioPlans.id, opts.studioPlanId), eq(studioPlans.userId, opts.userId)))
      .limit(1)
  )[0];
  if (!planRow) return { ...empty, error: "plan_not_found" };

  // The stored plan is re-validated rather than trusted: it was authored by an
  // LLM, may have been edited by a patch path, and is about to become writes
  // against the user's real calendar.
  const parsed = liftingPlanSchema.safeParse(planRow.plan);
  if (!parsed.success) return { ...empty, error: "invalid_plan" };
  const plan = parsed.data as LiftingPlan;

  const rows: PushRow[] = await db
    .select()
    .from(studioPlanPushes)
    .where(eq(studioPlanPushes.planId, opts.studioPlanId));

  // A re-push replaces whatever is in flight for these rows; otherwise an
  // older job's result would land on a row that has since been re-planned.
  for (const ids of chunkIds(rows.map((r) => r.id))) {
    await db
      .update(corosWriteJobs)
      .set({ status: "superseded", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(corosWriteJobs.userId, opts.userId),
          inArray(corosWriteJobs.studioPushId, ids),
          inArray(corosWriteJobs.status, [...IN_FLIGHT]),
        ),
      );
  }

  // ── Drift, before anything is planned ─────────────────────────────────────
  const drift = detectDrift(
    rows,
    await loadObserved(db, opts.userId),
    await appRequestedDates(db, opts.userId),
  );
  const driftedPushIds = new Set<string>();
  for (const finding of drift) {
    // An undo in flight: the caller has planned a corrective delete+create for
    // this row; re-adopting it mid-flight would cancel the correction.
    if (opts.suppressDriftPushIds?.has(finding.pushId)) continue;
    const row = rows.find((r) => r.id === finding.pushId)!;
    if (finding.kind === "app_moved") {
      // Our own move, recognized from the intent ledger: still ours. Record
      // where the workout actually is so a future delete is addressed right.
      await db
        .update(studioPlanPushes)
        .set({ corosHappenDay: finding.observedDay, updatedAt: now })
        .where(eq(studioPlanPushes.id, finding.pushId));
      continue;
    }
    // A genuine external edit is ADOPTED (spec §2): COROS's version becomes
    // the truth, the studio stops managing the session, and an undo note
    // offers to re-push the original. Never a permanent unmanaged state.
    driftedPushIds.add(finding.pushId);
    await db
      .update(studioPlanPushes)
      .set({
        status: "adopted",
        error: null,
        ...(finding.observedDay ? { corosHappenDay: finding.observedDay } : {}),
        updatedAt: now,
      })
      .where(eq(studioPlanPushes.id, finding.pushId));
    await postSyncNote(db, {
      userId: opts.userId,
      kind: finding.kind === "missing" ? "adopted_coros_removal" : "adopted_coros_edit",
      payload: {
        pushId: row.id,
        studioPlanId: opts.studioPlanId,
        sessionTitle: row.sessionTitle,
        happenDay: row.happenDay,
      },
    });
  }

  // Live stamps committed by the user's OTHER studio plans. Scoped to the user
  // because the container plan is theirs; "regardless of planId" within that.
  const otherPlanIds = (
    await db.select({ id: studioPlans.id }).from(studioPlans).where(eq(studioPlans.userId, opts.userId))
  )
    .map((p) => p.id)
    .filter((id) => id !== opts.studioPlanId);
  const otherLiveTitles: string[] = [];
  for (const ids of chunkIds(otherPlanIds)) {
    const found = await db
      .select({ title: studioPlanPushes.sessionTitle, status: studioPlanPushes.status })
      .from(studioPlanPushes)
      .where(inArray(studioPlanPushes.planId, ids));
    for (const r of found) if (r.status !== "deleted") otherLiveTitles.push(r.title);
  }

  const catalogIds = new Set(
    (await db.select({ id: corosExercises.id }).from(corosExercises)).map((r) => r.id),
  );

  const batch = planPush({
    desired: opts.desiredOverride ?? desiredSessions(plan),
    rows,
    otherLiveTitles,
    driftedPushIds,
    catalogIds,
    today,
  });

  const catalogNames = new Map(
    (await db.select().from(corosExercises)).map((r) => [r.id, r.name] as const),
  );
  const catalogFor = (session: StudioSession): Array<{ id: string; name: string }> =>
    session.exercises.map((e) => ({ id: e.originId, name: catalogNames.get(e.originId) ?? e.name }));

  // ── Rows ──────────────────────────────────────────────────────────────────
  for (const id of batch.localDeletes) {
    await db
      .update(studioPlanPushes)
      .set({ status: "deleted", error: null, updatedAt: now })
      .where(eq(studioPlanPushes.id, id));
  }
  for (const failure of batch.failures) {
    await upsertPushRow(db, {
      planId: opts.studioPlanId,
      planVersion: planRow.version,
      happenDay: failure.happenDay,
      sessionTitle: failure.sessionTitle,
      status: "failed",
      error: failure.error,
      now,
    });
  }

  // ── Jobs. Deletes first: the plan must never hold two workouts under one
  //    stamp, even for the moment between a delete and its recreate. ─────────
  const baseMs = Date.parse(now);
  let seq = 0;
  const stamped = (): string => new Date(baseMs + seq++).toISOString();

  for (const del of batch.deletes) {
    const followUp = del.followUp;
    if (followUp) {
      // Mid-change: the row is no longer "verified as pushed", and its
      // fingerprint moves to the new content now so a concurrent push does not
      // re-plan the same change.
      await db
        .update(studioPlanPushes)
        .set({
          status: "pending",
          error: null,
          planVersion: planRow.version,
          sessionFingerprint: followUp.fingerprint,
          updatedAt: now,
        })
        .where(eq(studioPlanPushes.id, del.row.id));
    }
    const payload: StoredDeletePayload = {
      pushId: del.row.id,
      happenDay: deleteTargetDay(del.row),
      name: del.row.sessionTitle,
      idInPlan: del.row.corosIdInPlan!,
      programId: del.row.corosProgramId!,
      corosPlanId: del.row.corosPlanId!,
      ...(followUp
        ? {
            followUpCreate: {
              pushId: del.row.id,
              happenDay: followUp.happenDay,
              name: followUp.sessionTitle,
              session: followUp.session,
              catalog: catalogFor(followUp.session),
            },
          }
        : {}),
    };
    await enqueueStudioJob(db, {
      userId: opts.userId,
      kind: "delete_scheduled_workout",
      pushId: del.row.id,
      happenDay: del.row.happenDay,
      payload: payload as unknown as Record<string, unknown>,
      requestedAt: stamped(),
      now,
    });
  }

  for (const create of batch.creates) {
    const pushId = await upsertPushRow(db, {
      planId: opts.studioPlanId,
      planVersion: planRow.version,
      happenDay: create.desired.happenDay,
      sessionTitle: create.desired.sessionTitle,
      sessionFingerprint: create.desired.fingerprint,
      status: "pending",
      error: null,
      now,
    });
    const payload: CreateScheduledWorkoutJob = {
      pushId,
      happenDay: create.desired.happenDay,
      name: create.desired.sessionTitle,
      session: create.desired.session,
      catalog: catalogFor(create.desired.session),
    };
    await enqueueStudioJob(db, {
      userId: opts.userId,
      kind: "create_scheduled_workout",
      pushId,
      happenDay: create.desired.happenDay,
      payload: payload as unknown as Record<string, unknown>,
      requestedAt: stamped(),
      now,
    });
  }

  // `app_moved` is the app recognizing its OWN move — not a genuine adoption
  // — so it must not inflate the reported/audited `drifted` count the way it
  // would if this just counted every `detectDrift` finding.
  const drifted = drift.filter((d) => d.kind !== "app_moved").length;

  await db.insert(auditEvents).values({
    id: newId(),
    userId: opts.userId,
    kind: "studio_plan_pushed",
    detail: {
      studioPlanId: opts.studioPlanId,
      planVersion: planRow.version,
      creates: batch.creates.length,
      deletes: batch.deletes.length,
      failures: batch.failures.length,
      unchanged: batch.unchanged.length,
      drifted,
      blocked: batch.blocked.length,
    },
    createdAt: now,
  });

  return {
    ok: true,
    creates: batch.creates.length,
    deletes: batch.deletes.length,
    failures: batch.failures.length,
    unchanged: batch.unchanged.length,
    drifted,
    blocked: batch.blocked.length,
  };
}

/**
 * UPSERT on the (planId, happenDay, sessionTitle) identity — never a bare
 * insert. The unique index would reject a re-push of a session that was
 * deleted and re-added, and two rows for one session would double-write.
 */
async function upsertPushRow(
  db: Db,
  v: {
    planId: string;
    planVersion: number;
    happenDay: string;
    sessionTitle: string;
    sessionFingerprint?: string;
    status: StudioPlanPushStatus;
    error: string | null;
    now: string;
  },
): Promise<string> {
  await db
    .insert(studioPlanPushes)
    .values({
      id: newId(),
      planId: v.planId,
      planVersion: v.planVersion,
      happenDay: v.happenDay,
      sessionTitle: v.sessionTitle,
      sessionFingerprint: v.sessionFingerprint ?? null,
      status: v.status,
      error: v.error,
      updatedAt: v.now,
    })
    .onConflictDoUpdate({
      target: [studioPlanPushes.planId, studioPlanPushes.happenDay, studioPlanPushes.sessionTitle],
      set: {
        planVersion: v.planVersion,
        ...(v.sessionFingerprint !== undefined ? { sessionFingerprint: v.sessionFingerprint } : {}),
        status: v.status,
        error: v.error,
        updatedAt: v.now,
      },
    });
  const row = (
    await db
      .select({ id: studioPlanPushes.id })
      .from(studioPlanPushes)
      .where(
        and(
          eq(studioPlanPushes.planId, v.planId),
          eq(studioPlanPushes.happenDay, v.happenDay),
          eq(studioPlanPushes.sessionTitle, v.sessionTitle),
        ),
      )
      .limit(1)
  )[0]!;
  return row.id;
}

async function enqueueStudioJob(
  db: Db,
  v: {
    userId: string;
    kind: "create_scheduled_workout" | "delete_scheduled_workout";
    pushId: string;
    happenDay: string;
    payload: Record<string, unknown>;
    requestedAt: string;
    now: string;
  },
): Promise<string> {
  // The payload is validated at the moment it becomes a queued instruction, so
  // an unwritable job is never persisted. The bridge re-validates on receipt;
  // this catches it a hop earlier, where the push can still report why.
  if (!bridgeJobPayload({ kind: v.kind, payload: v.payload })) {
    throw new Error(`invalid_${v.kind}_payload`);
  }
  const id = newId();
  await db.insert(corosWriteJobs).values({
    id,
    userId: v.userId,
    // `workoutId` is NOT NULL and means "the row this job acts on"; for studio
    // kinds that row is the push row. Code reads `studioPushId`.
    workoutId: v.pushId,
    studioPushId: v.pushId,
    kind: v.kind,
    // A studio job has no upstream fingerprint to guard; the ownership stamp
    // plays that role and lives in the payload.
    expectedContentFingerprint: "",
    originalDate: v.happenDay,
    destinationDate: v.happenDay,
    payload: v.payload,
    requestedAt: v.requestedAt,
    status: "queued",
    updatedAt: v.now,
  });
  return id;
}

/**
 * Ingest one studio job result: move the push row, settle the job, and — for a
 * delete that terminally removed a CHANGED session — enqueue the create that
 * was riding on it.
 */
export async function applyStudioJobResult(
  db: Db,
  userId: string,
  result: CorosWriteResult,
): Promise<{ jobStatus: string; pushStatus: string }> {
  const now = nowInstant();
  const job = (
    await db
      .select()
      .from(corosWriteJobs)
      .where(and(eq(corosWriteJobs.id, result.jobId), eq(corosWriteJobs.userId, userId)))
      .limit(1)
  )[0];
  if (!job) throw new Error("job_not_found");
  if (!isStudioJobKind(job.kind)) throw new Error("not_a_studio_job");
  if (["verified", "failed", "superseded", "cancelled"].includes(job.status)) {
    return { jobStatus: job.status, pushStatus: "unchanged" };
  }
  const studio = result.studio;
  if (!studio) {
    // The bridge could not act at all (it refused a payload that did not
    // validate, or is too old to know these kinds). There is no executor
    // outcome to map, and retrying the same payload would fail identically —
    // so the row fails terminally and is surfaced.
    await db
      .update(studioPlanPushes)
      .set({ status: "failed", error: "bridge_rejected", updatedAt: now })
      .where(eq(studioPlanPushes.id, job.studioPushId ?? ""));
    await db
      .update(corosWriteJobs)
      .set({
        status: "failed",
        attemptCount: job.attemptCount + 1,
        lastErrorCategory: "bridge_rejected",
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(corosWriteJobs.id, job.id));
    return { jobStatus: "failed", pushStatus: "failed" };
  }
  // The device reports which row it acted on; it must be the row this job was
  // issued for, or the state machine would move an unrelated session.
  if (studio.pushId !== job.studioPushId) throw new Error("push_id_mismatch");

  await db
    .update(corosWriteAttempts)
    .set({
      finishedAt: now,
      outcome: result.outcome,
      errorCategory: result.errorCategory ?? null,
      signatureValid: true,
    })
    .where(
      and(eq(corosWriteAttempts.jobId, job.id), eq(corosWriteAttempts.deviceId, result.deviceId)),
    );

  const attemptCount = job.attemptCount + 1;
  const exhausted = attemptCount >= job.maxAttempts;
  const transition =
    studio.kind === "create_scheduled_workout"
      ? mapCreateResult(studio, exhausted)
      : mapDeleteResult(studio, exhausted);

  // A delete that terminally removed a CHANGED session hands over to the
  // create that was chained onto it. Only here — a refused delete never lets
  // a create run, or the create would adopt the stale workout.
  // The stored payload is re-validated: it is about to become a write.
  const chained =
    studio.kind === "delete_scheduled_workout" && transition.status === "deleted"
      ? createScheduledWorkoutJobSchema.safeParse(job.payload?.["followUpCreate"])
      : undefined;
  const followUp = chained?.success ? chained.data : undefined;

  const rowUpdate: Record<string, unknown> = {
    status: followUp ? "pending" : transition.status,
    error: transition.error,
    updatedAt: now,
  };
  if (transition.persistIds) {
    if (studio.serverIdInPlan) rowUpdate.corosIdInPlan = studio.serverIdInPlan;
    if (studio.serverProgramId) rowUpdate.corosProgramId = studio.serverProgramId;
    if (studio.serverEntityId) rowUpdate.corosEntityId = studio.serverEntityId;
    if (studio.serverPlanId) rowUpdate.corosPlanId = studio.serverPlanId;
  }
  // Recorded WHENEVER the executor located the stamp — including the cross-day
  // `already_present` refusal, which withholds ids but still tells us where the
  // workout is. `happenDay` (half the row's identity) never moves; this is the
  // day a later delete must target, and without it that delete would be aimed
  // at an empty date and come back `stamp_mismatch`.
  if (studio.ok) {
    // Success means the workout is where it was asked to be, so ANY previously
    // recorded cross-day address is now stale. Assigned from the result rather
    // than only overwritten when present, so a bridge too old to report the
    // field clears the stale day instead of leaving a delete aimed at it.
    rowUpdate.corosHappenDay = studio.serverHappenDay ?? null;
  } else if (studio.serverHappenDay) {
    // On a failure the field is additive only: a retryable outcome carries no
    // day, and clearing one recorded by an earlier attempt would lose the
    // address of a stray that attempt may have left behind.
    rowUpdate.corosHappenDay = studio.serverHappenDay;
  }
  if (transition.clearIds) {
    rowUpdate.corosIdInPlan = null;
    rowUpdate.corosProgramId = null;
    rowUpdate.corosEntityId = null;
    rowUpdate.corosPlanId = null;
    rowUpdate.corosHappenDay = null;
  }
  await db.update(studioPlanPushes).set(rowUpdate).where(eq(studioPlanPushes.id, studio.pushId));

  const jobStatus = transition.job === "retry" ? "queued" : transition.job;
  await db
    .update(corosWriteJobs)
    .set({
      status: jobStatus,
      attemptCount,
      verifiedAt: jobStatus === "verified" ? now : job.verifiedAt,
      // Structured only: a job-level code, never an executor sentence.
      lastErrorCategory: transition.error ?? job.lastErrorCategory,
      completedAt: jobStatus === "queued" ? null : now,
      claimedByDeviceId: jobStatus === "queued" ? null : job.claimedByDeviceId,
      claimedAt: jobStatus === "queued" ? null : job.claimedAt,
      updatedAt: now,
    })
    .where(eq(corosWriteJobs.id, job.id));

  if (followUp) {
    await enqueueStudioJob(db, {
      userId,
      kind: "create_scheduled_workout",
      pushId: followUp.pushId,
      happenDay: followUp.happenDay,
      payload: followUp as unknown as Record<string, unknown>,
      requestedAt: now,
      now,
    });
  }

  await db.insert(auditEvents).values({
    id: newId(),
    userId,
    kind: "studio_push_result",
    detail: {
      jobId: job.id,
      pushId: studio.pushId,
      studioKind: studio.kind,
      ok: studio.ok,
      reason: studio.reason ?? studio.refused ?? null,
      pushStatus: rowUpdate.status,
      jobStatus,
      followUpEnqueued: Boolean(followUp),
    },
    createdAt: now,
  });

  return { jobStatus, pushStatus: String(rowUpdate.status) };
}
