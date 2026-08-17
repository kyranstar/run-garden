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
 *  6. A RECORDED ADDRESS IS A CLAIM, NOT AN IDENTITY. COROS RECYCLES a plan's
 *     `idInPlan` slots after deletes, and has been observed re-filing a fresh
 *     create under an id of its own choosing after the read-after-write
 *     reported another. So `${corosPlanId}:${corosIdInPlan}` goes stale on a
 *     workout that never moved, and the slot it vacated fills with somebody
 *     else's workout. The import path has known this for a while (see
 *     "Recycled wire id" in import-plan.ts); this module learned it the
 *     expensive way — a stale key made `detectDrift` read a stranger's
 *     archived run as our session being deleted on COROS, adopted 19 live
 *     rows on that false finding, and left every undo of them looping.
 *     Therefore: NEVER identify a workout by its id alone. Identity is the
 *     ownership stamp plus the day (`resolveObservation`), the same pair the
 *     create/delete executors themselves re-prove before writing, and a row
 *     whose ids disagree with what the snapshot says is HEALED
 *     (`healPushAddresses`) before anything is planned against it.
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
  userPreferences,
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
import { appRequestedDates, recordIntent } from "./sync-intents.js";
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

/** The plan half of a `${corosPlanId}:${idInPlan}` source workout id. */
function corosPlanIdOf(sourceWorkoutId: string): string {
  const cut = sourceWorkoutId.lastIndexOf(":");
  return cut < 0 ? sourceWorkoutId : sourceWorkoutId.slice(0, cut);
}

/** The address a row currently claims, or `null` if it claims none. */
export function recordedAddress(row: PushRow): string | null {
  return row.corosPlanId && row.corosIdInPlan ? `${row.corosPlanId}:${row.corosIdInPlan}` : null;
}

/**
 * WHICH observed workout is this push row's, given that COROS recycles slots
 * (module rule 6)? Three questions, in this order, because each later one is
 * only reached when the earlier one has nothing to say:
 *
 *  1. Does the recorded address still hold a LIVE workout under our stamp?
 *     Then it is ours and the address is fine — the overwhelmingly common case,
 *     and the only one that costs nothing.
 *  2. Otherwise, is our stamp live on exactly ONE other observed workout of the
 *     same container plan? Then the slot was recycled underneath us: that
 *     workout is ours, at a new address. Exactly one, never "the first of
 *     several" — a stamp on two live workouts makes ownership undecidable, and
 *     this module's whole safety story is that it refuses ambiguity.
 *  3. Otherwise fall back to whatever sits at the recorded address, which is
 *     what tells apart the two remaining truths: our own copy archived there
 *     (`absence_confirmed` ⇒ COROS deleted it) from a differently-named workout
 *     there (⇒ renamed). `undefined` when there is nothing at all — absence
 *     proves nothing.
 *
 * Never matches on `idInPlan` alone, which is the bug this exists to prevent.
 */
export function resolveObservation(
  row: PushRow,
  observed: Map<string, ObservedWorkout>,
): ObservedWorkout | undefined {
  const key = recordedAddress(row);
  const atAddress = key ? observed.get(key) : undefined;
  if (atAddress && atAddress.archiveReason === null && atAddress.title === row.sessionTitle) {
    return atAddress;
  }
  let live: ObservedWorkout | undefined;
  let liveCount = 0;
  for (const candidate of observed.values()) {
    if (candidate.archiveReason !== null) continue;
    if (candidate.title !== row.sessionTitle) continue;
    // Scoped to the container plan the row was written against, when it
    // records one: stamps are unique per plan, not per account.
    if (row.corosPlanId && corosPlanIdOf(candidate.sourceWorkoutId) !== row.corosPlanId) continue;
    live = candidate;
    liveCount += 1;
  }
  if (liveCount === 1) return live;
  return atAddress;
}

/** A row's recorded ids, corrected to where the snapshot says the workout is. */
export interface HealedAddress {
  pushId: string;
  corosPlanId: string;
  corosIdInPlan: string;
  corosProgramId: string;
}

/**
 * Re-resolve every row's COROS address from the last snapshot, and report the
 * ones whose recorded ids have gone stale (module rule 6).
 *
 * DELIBERATELY NARROW. A heal fires only when the workout carrying our stamp is
 * exactly WHERE WE ALREADY BELIEVE IT TO BE (`deleteTargetDay`) — same day, new
 * slot. A stamp that turns up on a DIFFERENT day is not an address to quietly
 * adopt: it is the "the user moved it in COROS" fact, and re-addressing the row
 * to it here would let the next push delete the user's edit without ever
 * surfacing it. That case is left to `detectDrift`, which reports `moved` (or
 * `app_moved`) and records the day; once the day is recorded, the SAME row
 * heals on the next pass, because by then `deleteTargetDay` is the observed
 * day. Two passes, and the moved finding is still told.
 */
export function healPushAddresses(
  rows: PushRow[],
  observed: Map<string, ObservedWorkout>,
): HealedAddress[] {
  const healed: HealedAddress[] = [];
  for (const row of rows) {
    if (row.status === "deleted") continue;
    const seen = resolveObservation(row, observed);
    // Only a live observation is an address. An archived one is the record of
    // a workout that is gone; pointing a delete at it would be a lie.
    if (!seen || seen.archiveReason !== null) continue;
    if (seen.title !== row.sessionTitle) continue;
    if (seen.corosDate !== deleteTargetDay(row)) continue;
    if (seen.sourceWorkoutId === recordedAddress(row)) continue;
    const corosPlanId = corosPlanIdOf(seen.sourceWorkoutId);
    const corosIdInPlan = seen.sourceWorkoutId.slice(corosPlanId.length + 1);
    if (!corosPlanId || !corosIdInPlan) continue;
    healed.push({
      pushId: row.id,
      corosPlanId,
      corosIdInPlan,
      // The delete triple's third element. The snapshot records the COROS
      // *program* id, which is a different number from the entity's
      // `planProgramId`; the executors read that as `planProgramId ?? idInPlan`
      // and our own creates set it TO the idInPlan, so the idInPlan is the
      // value that actually addresses a workout this module wrote.
      corosProgramId: corosIdInPlan,
    });
  }
  return healed;
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
 *
 * WHICH observation belongs to a row is `resolveObservation`'s job, not a map
 * lookup on the recorded ids: COROS recycles slots (module rule 6), so a stale
 * key both misses our workout AND lands on a stranger's — which is how a
 * healthy session came to be reported as deleted-on-COROS and adopted.
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
    const seen = resolveObservation(row, observed);
    if (!seen) continue;
    // Keyed by where the workout ACTUALLY is, not by what the row recorded —
    // the intent ledger indexes moves by the source workout id the importer
    // saw, which is the healed address, not the stale one.
    const key = seen.sourceWorkoutId;
    if (seen.archiveReason === "absence_confirmed") {
      // An ARCHIVED observation only proves OUR workout is gone if it carries
      // our stamp. When it does not, the recorded slot was recycled (module
      // rule 6) and what COROS confirmed gone is its new occupant — somebody
      // else's workout, about which absence proves nothing. Adoption is
      // permanent-until-undone, so it is never granted on that evidence.
      if (seen.title !== row.sessionTitle) continue;
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
 *
 * `requestedDay` — the day this create asked for — is what separates the two
 * things `already_present` can mean. Read the doc on that case below.
 */
export function mapCreateResult(
  result: StudioJobResult,
  attemptsExhausted: boolean,
  requestedDay?: string,
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
      // ok:false + already_present normally means the same stamp on ANOTHER
      // day: the user moved it in COROS. Same "the user took this over" fact
      // drift detection surfaces elsewhere — ADOPTED, not a permanent failure.
      //
      // But when the executor reports the stamp on the very day this create
      // asked for, nobody moved anything: our own workout is already sitting
      // there and this row simply did not know its address (module rule 6 —
      // the recycled slot). Calling that adoption is what latched 19 live rows
      // permanently: `planPush` treats `adopted` as untouchable, so the row
      // could never be deleted, corrected, or undone. It fails instead, with a
      // structured code, which leaves it re-plannable: the next push heals the
      // address off the snapshot and plans the delete+create that actually
      // replaces the stale content.
      if (requestedDay !== undefined && result.serverHappenDay === requestedDay) {
        return {
          status: "failed",
          error: "address_stale",
          persistIds: true,
          clearIds: false,
          job: "failed",
        };
      }
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
  error?: "plan_not_found" | "invalid_plan" | "writes_disabled";
  creates: number;
  deletes: number;
  failures: number;
  unchanged: number;
  /** Rows found to have drifted on COROS during THIS push. */
  drifted: number;
  /** Rows skipped because they are already `adopted` (incl. `drifted`). */
  blocked: number;
  /** Rows whose recorded COROS address was stale and was re-resolved. */
  healed: number;
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
    healed: 0,
  };

  // "Write date changes back to COROS" is the only switch claiming to stop
  // writes — studio pushes must obey it too (audit#2 #14). Direct table read:
  // loadPreferences lives in calendar-sync, which is an import cycle from
  // here (see UndoStudioAdoptionResult's doc note).
  const [prefRow] = await db
    .select({ prefs: userPreferences.prefs })
    .from(userPreferences)
    .where(eq(userPreferences.userId, opts.userId))
    .limit(1);
  if ((prefRow?.prefs as { corosWritesEnabled?: boolean } | undefined)?.corosWritesEnabled !== true) {
    return { ...empty, error: "writes_disabled" };
  }

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
  // Chunk of 80, not the default 90: this statement also binds `userId` and
  // the four IN_FLIGHT statuses, so a full 90-id chunk would sit at 95 of
  // D1's ~100 — too close to spend the headroom the default assumes.
  for (const ids of chunkIds(rows.map((r) => r.id), 80)) {
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

  // ── Addresses, before drift is even looked at ─────────────────────────────
  // COROS recycles idInPlan slots (module rule 6), so a row's recorded address
  // can name a workout that was never ours while ours sits one slot over. Every
  // later step here — drift detection, addressability, the delete payload's
  // triple — reads that address, so it is re-resolved from the snapshot FIRST
  // and the correction is persisted, not just used for this pass.
  const observed = await loadObserved(db, opts.userId);
  const heals = healPushAddresses(rows, observed);
  for (const heal of heals) {
    const row = rows.find((r) => r.id === heal.pushId)!;
    row.corosPlanId = heal.corosPlanId;
    row.corosIdInPlan = heal.corosIdInPlan;
    row.corosProgramId = heal.corosProgramId;
    await db
      .update(studioPlanPushes)
      .set({
        corosPlanId: heal.corosPlanId,
        corosIdInPlan: heal.corosIdInPlan,
        corosProgramId: heal.corosProgramId,
        // The entity id addressed the slot we just learned was not ours. No
        // caller reads it, and a stale one is worse than none.
        corosEntityId: null,
        updatedAt: now,
      })
      .where(eq(studioPlanPushes.id, heal.pushId));
  }

  // ── Drift, before anything is planned ─────────────────────────────────────
  const drift = detectDrift(rows, observed, await appRequestedDates(db, opts.userId));
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
      healed: heals.length,
      // The corrections themselves, so a stale-address incident is diagnosable
      // after the fact without re-deriving it from two snapshots.
      healedAddresses: heals.map((h) => ({
        pushId: h.pushId,
        to: `${h.corosPlanId}:${h.corosIdInPlan}`,
      })),
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
    healed: heals.length,
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
      ? // `destinationDate` is the day this create asked for (both date columns
        // are set to the session's happenDay when a studio job is enqueued) —
        // the only thing that tells a genuine cross-day `already_present` from
        // our own workout already sitting on the requested day under an address
        // this row had wrong.
        mapCreateResult(studio, exhausted, job.destinationDate)
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

// ── Adoption undo ────────────────────────────────────────────────────────────

/**
 * An "adopted" row (spec §2) is never a permanent unmanaged state: this
 * figures out WHICH of three cases produced the adoption, by re-examining the
 * last snapshot of the source workout, and handles each on its own terms
 * rather than a single generic "flip it back" state transition:
 *
 *  - MISSING: COROS confirmed the workout gone. Nothing to delete — a plain
 *    recreate suffices.
 *  - MOVED: the workout is still there, still carrying our stamp, just on a
 *    different day. Re-verifying the row and staling its fingerprint makes
 *    the next push plan exactly delete (at the day it's actually on) then
 *    recreate (at the day the plan wants).
 *  - RENAMED: the workout no longer carries our stamp at all, so nothing here
 *    can prove a delete of it is ours to make. Refused outright.
 *
 * WHICH case holds is decided from a stamp+day resolution, never from the
 * recorded ids (module rule 6): COROS recycles slots, and an id-keyed lookup
 * that misses reads as MISSING — the wrong case, and a self-perpetuating one,
 * since MISSING clears the ids and plans a create, the create finds our own
 * stamp already there, and the row re-adopts. The address is HEALED first, so
 * MISSING means the workout is genuinely gone.
 *
 * Once the row is repositioned, the whole plan is re-pushed so every other
 * row's diff is re-derived exactly as `pushStudioPlan` already knows how to
 * do it — no separate row-scoped code path to keep in sync with the real one.
 *
 * Shared by two callers (studio-transparency Task 10): the studio route
 * itself (`POST /api/studio/adoption/:pushId/undo`) and the sync-notes undo
 * route (`POST /api/sync/notes/:id/undo`, for `adopted_coros_edit` /
 * `adopted_coros_removal` notes) — one state transition, two entry points.
 *
 * `today` is a required parameter, not loaded here, to avoid a circular
 * import: `loadPreferences` lives in `calendar-sync.ts`, which imports
 * `applyMove` from `jobs.ts`, which imports this module — callers load
 * preferences themselves and pass `todayInZone(prefs.timezone)`, the same
 * "no silent UTC default" discipline `pushStudioPlan`'s own `today` param
 * already documents.
 */
export type UndoStudioAdoptionResult =
  | { ok: true; summary: PushSummary }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "undo_unsupported_rename" }
  | { ok: false; error: "writes_disabled" };

export async function undoStudioAdoption(
  db: Db,
  userId: string,
  pushId: string,
  today: LocalDate,
): Promise<UndoStudioAdoptionResult> {
  // Same write gate as pushStudioPlan (audit#2 #14) — an undo plans
  // delete+create corrections against the real COROS calendar.
  const [undoPrefRow] = await db
    .select({ prefs: userPreferences.prefs })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if ((undoPrefRow?.prefs as { corosWritesEnabled?: boolean } | undefined)?.corosWritesEnabled !== true) {
    return { ok: false, error: "writes_disabled" };
  }
  // A single query, joined through studioPlans and scoped by userId: an
  // unknown pushId, one belonging to another user's plan, and one that exists
  // but isn't "adopted" all fall through to the SAME `not_found` result —
  // distinguishing them would let a caller enumerate other users' (or their
  // own non-adopted) push ids by shape alone.
  // The whole `PushRow` shape, not just the ids: address healing and
  // `resolveObservation` below reason over the stamp, the identity day and the
  // recorded actual day as well.
  const row: PushRow | undefined = (
    await db
      .select({
        id: studioPlanPushes.id,
        planId: studioPlanPushes.planId,
        happenDay: studioPlanPushes.happenDay,
        sessionTitle: studioPlanPushes.sessionTitle,
        sessionFingerprint: studioPlanPushes.sessionFingerprint,
        corosIdInPlan: studioPlanPushes.corosIdInPlan,
        corosProgramId: studioPlanPushes.corosProgramId,
        corosPlanId: studioPlanPushes.corosPlanId,
        corosHappenDay: studioPlanPushes.corosHappenDay,
        status: studioPlanPushes.status,
        error: studioPlanPushes.error,
      })
      .from(studioPlanPushes)
      .innerJoin(studioPlans, eq(studioPlanPushes.planId, studioPlans.id))
      .where(and(eq(studioPlanPushes.id, pushId), eq(studioPlans.userId, userId)))
      .limit(1)
  )[0];
  if (!row || row.status !== "adopted") return { ok: false, error: "not_found" };

  const now = nowInstant();

  // The last snapshot's opinion of the source workout — resolved by STAMP AND
  // DAY, not by the recorded ids. COROS recycles idInPlan slots (module rule
  // 6), so a lookup keyed on the recorded address can miss a workout that is
  // sitting right there, and "no observation" is exactly what this function
  // reads as MISSING. That misread is what made undo unfixable: it cleared the
  // ids and planned a CREATE, the create found our own stamp already on the
  // day, and the row latched to `adopted` and could never be undone again.
  // Healing first means `missing` can only be reached by a workout that really
  // is gone.
  const observed = await loadObserved(db, userId);
  for (const heal of healPushAddresses([row], observed)) {
    row.corosPlanId = heal.corosPlanId;
    row.corosIdInPlan = heal.corosIdInPlan;
    row.corosProgramId = heal.corosProgramId;
    await db
      .update(studioPlanPushes)
      .set({
        corosPlanId: heal.corosPlanId,
        corosIdInPlan: heal.corosIdInPlan,
        corosProgramId: heal.corosProgramId,
        corosEntityId: null,
        updatedAt: now,
      })
      .where(eq(studioPlanPushes.id, pushId));
  }
  const observation = resolveObservation(row, observed);

  const missing = !observation || observation.archiveReason === "absence_confirmed";
  const renamed = !missing && observation!.title !== row.sessionTitle;

  if (renamed) {
    // A renamed workout no longer carries our ownership stamp; the safety
    // core cannot prove a delete of it is ours. The honest answer is refusal
    // — if the user deletes the renamed copy in COROS, absence confirms and
    // undo becomes the recreate path.
    return { ok: false, error: "undo_unsupported_rename" };
  }

  if (missing) {
    // COROS already removed it: nothing addressable to delete, so a plain
    // recreate suffices. Clears the stale ids so the diff sees an
    // unaddressable row and plans a create, not a delete.
    await db
      .update(studioPlanPushes)
      .set({
        status: "failed",
        error: null,
        corosIdInPlan: null,
        corosProgramId: null,
        corosEntityId: null,
        corosPlanId: null,
        corosHappenDay: null,
        sessionFingerprint: "undo-forced",
        updatedAt: now,
      })
      .where(eq(studioPlanPushes.id, pushId));
  } else {
    // MOVED: still there, still ours — at the day recorded on the row, which
    // after the heal above is an address that actually resolves (it may be the
    // identity day itself, when the only thing that ever drifted was the slot
    // number). Re-pushing will delete the workout wherever it actually is and
    // recreate the original: force the fingerprint stale so the diff plans
    // exactly that.
    await db
      .update(studioPlanPushes)
      .set({ status: "verified", error: null, sessionFingerprint: "undo-forced", updatedAt: now })
      .where(eq(studioPlanPushes.id, pushId));
  }

  await recordIntent(db, {
    userId,
    targetKind: "studio_session",
    targetId: pushId,
    kind: "restore",
    source: "undo",
  });

  const summary = await pushStudioPlan(db, {
    userId,
    studioPlanId: row.planId,
    today,
    // MOVED puts the row back to "verified" with its old (corosIdInPlan,
    // corosPlanId) address still on it, which `detectDrift` would otherwise
    // re-examine on this very push and re-adopt mid-flight — cancelling the
    // correction this route just planned before it ever reaches COROS.
    // (MISSING sets the row to "failed", which `detectDrift` already skips,
    // so suppression is a no-op there — passed only for the MOVED case.)
    ...(missing ? {} : { suppressDriftPushIds: new Set([pushId]) }),
  });
  return { ok: true, summary };
}
