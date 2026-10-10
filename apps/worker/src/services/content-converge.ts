/**
 * ONE-SHOT CONVERGENCE BACKFILL for live sessions whose COROS copy is stale.
 *
 * The content-write job kind (`coach_update_workout`) stops NEW divergences.
 * This closes the ones already on the athlete's watch, and it exists because
 * those rows will otherwise never heal: `ease` was the only writer that could
 * create this state, and nothing re-runs an ease.
 *
 * Same shape and the same house rules as `POST /api/plan/repair-fidelity` and
 * `POST /api/sync/repair-orphaned-mirrors`: `dryRun` is REQUIRED and never
 * defaulted, the pre-change state goes into `audit_events` BEFORE any write, the
 * caller gets a per-row account of exactly what would happen, and a read-only
 * census answers "is there anything to converge" by CALLING this in dry run
 * rather than reimplementing its test.
 *
 * WHAT COUNTS AS PROOF OF DIVERGENCE. Two signals, each exact, neither a guess:
 *
 *  (A) AN OPEN `content` INTENT on a row with a proven COROS address. That intent
 *      is the direct record of an approved ease landing on a session COROS had
 *      already been given — it is written by `ease` itself and, before today,
 *      could never be resolved by anything. Live: the two eased sessions (today
 *      and 22 Aug) whose COROS copies are the pre-ease workouts.
 *
 *  (B) A VERIFIED PUSH THAT RECORDED `pace_targets_owed`, on an account that now
 *      HAS a threshold pace. The create executor reports how many blocks went to
 *      the watch as bare timers because no pace band could be derived, and the
 *      write consumer stores that on the job row. Nothing re-pushes when a
 *      threshold later arrives, so those sessions sit on the watch permanently
 *      target-less while every pace band in the app is derived from a reading
 *      that exists. Live: the coach-created sessions whose pace bands were never
 *      pushed.
 *
 * WHAT IT REFUSES TO DO
 *
 *  - IT DOES NOT INVENT A PRESCRIPTION. The session it pushes is reconstructed
 *    from the app's OWN stored structure — stage rows for a run, `structured_json`
 *    for a lift or mobility session — and from nothing else. Today's eased row is
 *    the case that makes this load-bearing: an earlier repair deleted its stale
 *    stage rows (correctly — they described the pre-ease workout), so the app's
 *    own copy is now a bare summary string, "35min easy", and there is no
 *    structure to send. Converging it would mean writing a one-block session
 *    parsed out of prose, which is a guess wearing a prescription's clothes. It is
 *    reported `unfixable`, with the remedy that actually works: re-ease the
 *    session, which stores a real body and converges it on the spot.
 *  - IT DOES NOT TOUCH ROWS THAT ARE NOT `scheduled`, or archived rows. A
 *    finished session's story already happened and its watch copy is history.
 *  - IT DOES NOT REWRITE `planned_workouts` CONTENT. The app's copy is the one
 *    that is right; this pushes it. The only row columns it can change are the
 *    ones the write consumer stamps when the wire confirms.
 *  - IT NEVER WRITES ON A MAYBE. No proven address, or NEITHER ownership proof,
 *    and the row is reported skipped or unfixable — `enqueueContentConvergence`
 *    refuses for the same reasons and this reports its refusal rather than
 *    second-guessing it.
 *
 * WHAT CHANGED WHEN THE SECOND PROOF ARRIVED (2026-08-17). This shipped able to
 * converge only the sessions THIS APP CREATED, because ownership could only be
 * proven by a stamp we had written — and the athlete's plan is mostly IMPORTED.
 * Their two eased sessions (17 and 22 Aug) came back `unfixable`,
 * `no_recorded_stamp`, permanently: the coach had eased workouts COROS authored,
 * so no create job of ours ever named them. `ownershipProofFor` now offers the
 * second proof (address + day + the import's own content fingerprint,
 * re-checked on the wire before anything is written), so those rows report
 * `rewrite` and the backfill queues real jobs for them.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  auditEvents,
  corosWriteJobs,
  dailyHealth,
  plannedWorkoutStages,
  plannedWorkouts,
  syncIntents,
} from "@rg/database";
import {
  appAuthoredRow,
  coachSessionSchema,
  COACH_STAMPING_JOB_KINDS,
  newId,
  nowInstant,
  paceBandFor,
  sessionSummaryLine,
  todayInZone,
  watchAddressOf,
  type CoachSession,
  type PaceIntensity,
  type UserPreferences,
} from "@rg/domain";
import { RUN_PACE_WIRE } from "@rg/coros";
import { chunkIds, type Db } from "./db.js";
import { loadPreferences } from "./calendar-sync.js";
import { enqueueContentConvergence, ownershipProofFor, watchPushable } from "./coach-apply.js";

/** `audit_events.kind` for the pre-change backup written by a live run. */
export const CONTENT_CONVERGE_BACKUP_KIND = "coach_content_convergence_backfilled";

type WorkoutRow = typeof plannedWorkouts.$inferSelect;
type StageRow = typeof plannedWorkoutStages.$inferSelect;

/** Why this row is believed to hold something COROS does not. */
export type DivergenceEvidence =
  /** An approved ease rewrote it after COROS was given it (open content intent). */
  | "open_content_intent"
  /** Its push recorded blocks that went to the watch with no pace band, and the
   *  athlete's threshold pace has since arrived. */
  | "pace_targets_never_pushed"
  /** An upcoming run whose latest verified write carried pace targets in the encoding before 2c1ee96 — bounds the
   *  watch reads as SECONDS per km ("78'59 – 722'43" per mile, live 2026-10-09). See `outdatedPaceEncoding`. */
  | "pace_encoding_outdated";

export interface ContentConvergeRowReport {
  workoutId: string;
  effectiveDate: string;
  title: string;
  evidence: DivergenceEvidence[];
  /**
   * `rewrite`   — a `coach_update_workout` would be (or was) queued;
   * `unpush`    — the app's own copy cannot cross the wire, so the watch's stale
   *               copy is removed rather than left prescribing withdrawn work;
   * `skipped`   — nothing to converge, or nothing that can be proven;
   * `unfixable` — provably divergent and provably not fixable from here.
   */
  action: "rewrite" | "unpush" | "skipped" | "unfixable";
  reason?: string;
  /** What the app's own copy prescribes, as the operator needs to read it —
   * so what would be written is visible before it is written. */
  prescription: string | null;
  /**
   * The claim a rewrite would be aimed at, and HOW IT WOULD BE PROVEN. Every
   * field is re-proven by the executor; it is shown so an operator can see what
   * is being claimed before it is written.
   *
   * `proof` is the interesting half. `stamp` is a session this app created and
   * can name; `imported` is one COROS authored, where ownership is re-proven by
   * re-reading the address and comparing the content fingerprint the import
   * recorded (`content-executor.ts` THE SECOND PROOF). The census used to call
   * every imported row `unfixable` because it only knew the first.
   */
  address:
    | {
        corosPlanId: string;
        idInPlan: string;
        programId: string;
        happenDay: string;
        proof: "stamp";
        stamp: string;
      }
    | {
        corosPlanId: string;
        idInPlan: string;
        programId: string;
        happenDay: string;
        proof: "imported";
        importedProgramId: string;
        importedFingerprint: string;
      }
    | null;
  /** Set on a live run. */
  jobId?: string;
}

export interface ContentConvergeReport {
  dryRun: boolean;
  rows: ContentConvergeRowReport[];
  totals: {
    candidates: number;
    rewrites: number;
    unpushes: number;
    skipped: number;
    unfixable: number;
  };
  backup: { auditEventId: string; kind: string; table: "audit_events" } | null;
}

/**
 * THE APP'S OWN COPY, as a session — or `null` when the app has no structure to
 * send.
 *
 * A faithful projection, not a reconstruction: a run's blocks come from its stage
 * rows (the durations and intensities the ease itself wrote) and a lift's or
 * mobility session's steps come from `structured_json` verbatim. Nothing is
 * derived from prose, and `null` here is the honest answer that stops the caller
 * inventing one.
 *
 * `category` is derived from the row's SPORT rather than copied from
 * `planned_workouts.category`, which speaks `classifyWorkout`'s vocabulary rather
 * than the coach's. It is genuinely inert — neither wire builder reads it, and its
 * only other consumer is `sessionSport`, which the sport already decided — so
 * translating between two category vocabularies here would add a classifier to a
 * projection for no gain.
 *
 * ROLES ARE NOT CARRIED, and do not need to be. `coachRunBlockSchema` has no
 * `role` field, so a stage row's `kind` is dropped on the way in — and re-derived
 * identically by `runBlockRoles` from the intensities, which is where it came
 * from. Since the same derivation now writes the stage rows too (`writeStages`),
 * the round trip is closed.
 */
export function sessionFromRow(row: WorkoutRow, stages: StageRow[]): CoachSession | null {
  const minutes = Math.round((row.calendarBlockDurationSeconds ?? 0) / 60);
  if (row.sport === "run") {
    if (stages.length === 0) return null;
    const blocks = [...stages]
      .sort((a, b) => a.ord - b.ord)
      .map((s) => ({
        kind: s.durationType === "time" ? ("duration" as const) : ("distance" as const),
        // A duration block's `value` is MINUTES; the column is whole seconds.
        value: s.durationType === "time" ? (s.durationSeconds ?? 0) / 60 : (s.distanceMeters ?? 0),
        ...(s.label ? { intensity: s.label } : {}),
      }));
    const parsed = coachSessionSchema.safeParse({
      category: "easy",
      title: row.title,
      durationMinutes: minutes,
      run: { blocks },
    });
    return parsed.success ? parsed.data : null;
  }
  const structured = row.structuredJson as { exercises?: unknown[]; rounds?: number } | null;
  if (!structured || !Array.isArray(structured.exercises) || structured.exercises.length === 0) {
    return null;
  }
  const body = {
    ...(structured.rounds ? { rounds: structured.rounds } : {}),
    exercises: structured.exercises,
  };
  const parsed = coachSessionSchema.safeParse({
    category: row.sport === "yoga" ? "yoga" : "strength",
    title: row.title,
    durationMinutes: minutes,
    ...(row.sport === "yoga" ? { mobility: body } : { lift: body }),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The app's copy in one line, for the operator's report.
 *
 * `sessionSummaryLine` — the SAME renderer the approval card, the stored
 * `stage_summary` and the coach's dossier all use. Not a convenience: this string
 * is what an operator reads before authorising a write to the athlete's watch,
 * and a report with its own formatter is a report that can describe a different
 * session than the one about to be sent. Three formatters for one prescription is
 * the bug that was just closed; this is not the place to open a fourth.
 *
 * With no session to project, the row's own stored summary is the honest
 * fallback — it is exactly the prose that makes the row unfixable, so the report
 * shows the operator what there is instead of a structure.
 */
function describePrescription(session: CoachSession | null, row: WorkoutRow): string | null {
  return session ? sessionSummaryLine(session) : row.stageSummary;
}

export interface ConvergeOptions {
  dryRun: boolean;
  /**
   * Restrict to these ids. Omitted, every row either proof identifies is
   * examined. A named row still has to pass the same evidence test — being asked
   * for explicitly is not evidence.
   */
  workoutIds?: string[];
  /**
   * Examine this evidence alone, and pay for no other signal's reads — the hourly pace heal asks for
   * `pace_encoding_outdated` only. Omitted, every signal is examined.
   */
  only?: DivergenceEvidence;
  /** Queue at most this many writes, soonest effective date first (the hourly heal: one a run). */
  maxWrites?: number;
  /** The athlete's today, for `pace_encoding_outdated`; read from their preferences when omitted. */
  today?: string;
}

/** A coach job that has not finished: a rewrite for its row is already on its way, or another write is in flight. */
const OPEN_JOB_STATUSES = ["queued", "claimed", "in_progress", "verifying"] as const;

/**
 * EVIDENCE (C): THE COACH RUNS ON THE WATCH WITH THE OLD PACE ENCODING — each mapped to the threshold its write
 * carried.
 *
 * Until 2c1ee96 `buildRunProgram` sent pace bounds in ms/km with intensityMultiplier 0, and the watch read them as
 * SECONDS per km: threshold reps showed "78'59 – 722'43" per mile. The fix changed two fields the program fingerprint
 * does not cover, so the import sees nothing on the old copies and they stay wrong until rewritten. Since the fix the
 * lane stamps every run build it verifies with `paceWire` (`RUN_PACE_WIRE`, coros-write-cloud.ts), so this is exact:
 *
 *  - the row's LATEST verified coach write (a create, a rewrite, or an unpush — after an unpush the watch holds
 *    nothing to fix) is a create or a rewrite with no `paceWire`;
 *  - and it CARRIED PACE TARGETS: a numeric `thresholdPaceSecPerKm` and a run block that threshold gives a band. A run
 *    with no targets, a lift and a mobility session have no pace on the wire to have encoded wrongly;
 *  - and no coach write for the row is still open — one is already on its way, and a second enqueue would supersede
 *    it (`enqueueContentConvergence` supersedes an open rewrite before inserting, and the id collides);
 *  - and the row is UPCOMING: effective date on or after the athlete's today, and a run. Every coach run written
 *    before the fix is old-encoded; a past one's watch copy is history, and counting it would flood the census and
 *    hand the operator path sessions already run.
 *
 * One read, over the upcoming run rows' coach jobs only — the hourly heal pays exactly this when nothing is left.
 */
async function outdatedPaceEncoding(db: Db, userId: string, today: string): Promise<Map<string, number>> {
  const jobs = await db
    .select({
      workoutId: corosWriteJobs.workoutId,
      status: corosWriteJobs.status,
      verifiedAt: corosWriteJobs.verifiedAt,
      completedAt: corosWriteJobs.completedAt,
      updatedAt: corosWriteJobs.updatedAt,
      payload: corosWriteJobs.payload,
    })
    .from(corosWriteJobs)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, corosWriteJobs.workoutId))
    .where(
      and(
        eq(corosWriteJobs.userId, userId),
        inArray(corosWriteJobs.kind, [...COACH_STAMPING_JOB_KINDS, "coach_delete_workout"]),
        inArray(corosWriteJobs.status, ["verified", ...OPEN_JOB_STATUSES]),
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.sport, "run"),
        gte(plannedWorkouts.effectiveDate, today),
      ),
    );
  const open = new Set<string>();
  const latest = new Map<string, (typeof jobs)[number]>();
  const at = (j: (typeof jobs)[number]): string => j.verifiedAt ?? j.completedAt ?? j.updatedAt;
  for (const j of jobs) {
    if (j.status !== "verified") {
      open.add(j.workoutId);
      continue;
    }
    const seen = latest.get(j.workoutId);
    if (!seen || at(j) > at(seen)) latest.set(j.workoutId, j);
  }
  const out = new Map<string, number>();
  for (const [workoutId, j] of latest) {
    // An unpush's payload carries no session and no threshold, so a row whose latest write took it off the watch
    // falls out below.
    if (open.has(workoutId)) continue;
    const p = (j.payload ?? {}) as {
      paceWire?: unknown;
      thresholdPaceSecPerKm?: unknown;
      session?: { run?: { blocks?: Array<{ intensity?: PaceIntensity }> } };
    };
    if (p.paceWire !== undefined || typeof p.thresholdPaceSecPerKm !== "number") continue;
    const threshold = p.thresholdPaceSecPerKm;
    if (!(p.session?.run?.blocks ?? []).some((b) => paceBandFor(b.intensity, threshold))) continue;
    out.set(workoutId, threshold);
  }
  return out;
}

/**
 * Plan the convergence, and — unless `dryRun` — commit it behind a backup.
 *
 * Ordered so the only possible half-state is a backup with no jobs queued
 * (harmless), never queued jobs with no record of what they were aimed at.
 */
export async function convergeDivergedContent(
  db: Db,
  userId: string,
  opts: ConvergeOptions,
): Promise<ContentConvergeReport> {
  const wants = (e: DivergenceEvidence): boolean => opts.only === undefined || opts.only === e;

  // ── Evidence (A): rows an approved ease claims and COROS was never told about.
  const claimedIds = new Set(
    wants("open_content_intent")
      ? (
          await db
            .select({ targetId: syncIntents.targetId })
            .from(syncIntents)
            .where(
              and(
                eq(syncIntents.userId, userId),
                eq(syncIntents.targetKind, "workout"),
                eq(syncIntents.kind, "content"),
                isNull(syncIntents.resolvedAt),
                isNull(syncIntents.supersededBy),
              ),
            )
        ).map((r) => r.targetId)
      : [],
  );

  // ── Evidence (B): pushes that told us they owed pace targets — but only once
  // the athlete HAS a threshold, because a rewrite with nothing newer to say
  // would write the same target-less program a second time.
  const [threshold] = wants("pace_targets_never_pushed")
    ? await db
        .select({ v: dailyHealth.thresholdPaceSecPerKm })
        .from(dailyHealth)
        .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
        .orderBy(desc(dailyHealth.date))
        .limit(1)
    : [];
  const thresholdPaceSecPerKm = threshold?.v ?? undefined;
  const paceDebtIds = new Set<string>();
  if (thresholdPaceSecPerKm) {
    for (const row of await db
      .select({ workoutId: corosWriteJobs.workoutId })
      .from(corosWriteJobs)
      .where(
        and(
          eq(corosWriteJobs.userId, userId),
          inArray(corosWriteJobs.kind, [...COACH_STAMPING_JOB_KINDS]),
          eq(corosWriteJobs.status, "verified"),
          eq(corosWriteJobs.lastErrorCategory, "pace_targets_owed"),
        ),
      )) {
      paceDebtIds.add(row.workoutId);
    }
  }

  // ── Evidence (C): upcoming runs on the watch with the old pace encoding (`outdatedPaceEncoding`), each with the
  // threshold its write carried — the rewrite's fallback when no reading is on file (the lane prefers the latest).
  const outdatedPace = wants("pace_encoding_outdated")
    ? await outdatedPaceEncoding(
        db,
        userId,
        opts.today ?? todayInZone((await loadPreferences(db, userId)).timezone),
      )
    : new Map<string, number>();

  const evidenceFor = (id: string): DivergenceEvidence[] => {
    const out: DivergenceEvidence[] = [];
    if (claimedIds.has(id)) out.push("open_content_intent");
    if (paceDebtIds.has(id)) out.push("pace_targets_never_pushed");
    if (outdatedPace.has(id)) out.push("pace_encoding_outdated");
    return out;
  };

  // Candidates: every row any signal names, narrowed to the caller's ids when
  // they gave any. Read whole — the reconstruction needs every session column.
  const named = (id: string): boolean => claimedIds.has(id) || paceDebtIds.has(id) || outdatedPace.has(id);
  const candidateIds = opts.workoutIds
    ? opts.workoutIds.filter(named)
    : [...new Set([...claimedIds, ...paceDebtIds, ...outdatedPace.keys()])];
  const rows: WorkoutRow[] = [];
  for (const ids of chunkIds(candidateIds)) {
    rows.push(
      ...(await db
        .select()
        .from(plannedWorkouts)
        .where(and(eq(plannedWorkouts.userId, userId), inArray(plannedWorkouts.id, ids)))),
    );
  }
  rows.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));

  const stagesByWorkout = new Map<string, StageRow[]>();
  for (const ids of chunkIds(rows.map((r) => r.id))) {
    for (const s of await db
      .select()
      .from(plannedWorkoutStages)
      .where(inArray(plannedWorkoutStages.workoutId, ids))
      .orderBy(asc(plannedWorkoutStages.ord))) {
      const list = stagesByWorkout.get(s.workoutId) ?? [];
      list.push(s);
      stagesByWorkout.set(s.workoutId, list);
    }
  }

  const reports: ContentConvergeRowReport[] = [];
  const toWrite: Array<{ row: WorkoutRow; session: CoachSession; report: ContentConvergeRowReport }> = [];

  for (const row of rows) {
    // Soonest first (`rows` is in date order): the rest wait for the next run, and are not reported on this one.
    if (opts.maxWrites !== undefined && toWrite.length >= opts.maxWrites) break;
    const stages = stagesByWorkout.get(row.id) ?? [];
    const session = sessionFromRow(row, stages);
    const base: ContentConvergeRowReport = {
      workoutId: row.id,
      effectiveDate: row.effectiveDate,
      title: row.title,
      evidence: evidenceFor(row.id),
      action: "skipped",
      prescription: describePrescription(session, row),
      address: null,
    };

    if (row.archivedAt !== null || row.completionState !== "scheduled") {
      reports.push({
        ...base,
        reason: `row is ${row.archivedAt ? "archived" : row.completionState} — its watch copy is history, not a plan`,
      });
      continue;
    }

    // A program or on-demand slot's watch copy is its locked build, sent by the athlete (Phase 3, spec §4.5): never
    // rewritten or unpushed from here — its only writes are a Send and the cleanup of that send.
    if (appAuthoredRow(row)) {
      reports.push({
        ...base,
        reason: "an app-built session: its watch copy is the build the athlete sent, and only Send or Take off writes it",
      });
      continue;
    }

    const address = watchAddressOf(row);
    if (!address) {
      reports.push({
        ...base,
        reason:
          "no proven COROS address (no wire id, or COROS never confirmed a date) — " +
          "the watch is not holding this session, so there is nothing to converge",
      });
      continue;
    }
    const proof = await ownershipProofFor(db, userId, row);
    if (typeof proof === "string") {
      reports.push({
        ...base,
        action: "unfixable",
        reason:
          proof === "not_athlete_approved"
            ? "COROS authored this session and the athlete has not approved a change to it — " +
              "an imported session is only ever rewritten to carry an approved edit"
            : proof === "stale_local_fingerprint"
              ? "COROS authored this session, and the record of what COROS holds for it was " +
                "overwritten by the ease itself (a local hash, not an observation of the wire) — " +
                "so ownership cannot be re-proven yet. THE NEXT COROS READ REPAIRS THIS: import " +
                "rule 7's content-intent branch re-records the upstream fingerprint without " +
                "touching the athlete's approved edit, and this row becomes a rewrite. Run a sync " +
                "first, then this backfill"
              : "COROS holds this session but neither ownership proof is available: no program-name " +
                "stamp this account wrote, and no recorded import fingerprint to re-read against — " +
                "ownership cannot be re-proven, and nothing is rewritten on a maybe",
      });
      continue;
    }
    const located =
      proof.kind === "stamp"
        ? ({ ...address, proof: "stamp", stamp: proof.recordedName } as const)
        : ({
            ...address,
            proof: "imported",
            importedProgramId: proof.importedProgramId,
            importedFingerprint: proof.importedFingerprint,
          } as const);

    // AN IMPORTED SESSION IS NEVER UNPUSHED — the same refusal
    // `enqueueContentConvergence` makes, reported rather than second-guessed.
    // Deleting a workout out of a COROS-authored plan makes it absent upstream,
    // and import rule 8 then archives the athlete's own approved session out of
    // the app two reads later. That turns a divergence into a deletion.
    if (proof.kind === "imported" && session && !watchPushable(session)) {
      reports.push({
        ...base,
        action: "unfixable",
        address: located,
        reason:
          "the app's own copy cannot cross the wire, and this session is COROS-authored — removing " +
          "it from the athlete's own COROS plan would make it absent upstream, which import rule 8 " +
          "turns into an archive of the very session they approved. The app's copy stays " +
          "authoritative; the watch keeps COROS's original until the athlete resolves it there",
      });
      continue;
    }

    if (!session) {
      reports.push({
        ...base,
        action: "unfixable",
        address: located,
        reason:
          `the app's own copy has no structure to send (${row.sport === "run" ? "no stage rows" : "no structured_json"}` +
          `) — only the summary "${row.stageSummary ?? row.title}", which is prose. Re-ease this session in the app:` +
          " the ease stores a real prescription and converges it on the spot. Nothing is guessed here.",
      });
      continue;
    }

    const action = watchPushable(session) ? ("rewrite" as const) : ("unpush" as const);
    const report: ContentConvergeRowReport = {
      ...base,
      action,
      address: located,
      ...(action === "unpush"
        ? {
            reason:
              "the app's own copy cannot cross the wire (a distance-measured block, or a movement" +
              " COROS has no id for), so the watch's stale copy is REMOVED rather than left" +
              " prescribing work the app has withdrawn",
          }
        : {}),
    };
    reports.push(report);
    toWrite.push({ row, session, report });
  }

  const report: ContentConvergeReport = {
    dryRun: opts.dryRun,
    rows: reports,
    totals: {
      candidates: reports.length,
      rewrites: reports.filter((r) => r.action === "rewrite").length,
      unpushes: reports.filter((r) => r.action === "unpush").length,
      skipped: reports.filter((r) => r.action === "skipped").length,
      unfixable: reports.filter((r) => r.action === "unfixable").length,
    },
    backup: null,
  };

  if (opts.dryRun || toWrite.length === 0) return report;

  // ── BACKUP FIRST. The rows themselves are not rewritten here, but the write
  // consumer will stamp them when the wire confirms, and there is no history
  // table — so the pre-change rows, their stage rows and the exact plan go into
  // `audit_events` whole, before a single job is queued. Restoring is a re-insert
  // of `detail.previousWorkouts` / `detail.previousStages`.
  const now = nowInstant();
  const backupId = newId();
  await db.insert(auditEvents).values({
    id: backupId,
    userId,
    kind: CONTENT_CONVERGE_BACKUP_KIND,
    detail: {
      workoutIds: toWrite.map((w) => w.row.id),
      plan: report.rows,
      totals: report.totals,
      previousWorkouts: toWrite.map((w) => w.row),
      previousStages: toWrite.flatMap((w) => stagesByWorkout.get(w.row.id) ?? []),
    },
    createdAt: now,
  });

  for (const { row, session, report: rowReport } of toWrite) {
    // The SAME enqueue the live `ease` path uses, so a backfilled convergence and
    // an approved one cannot be two different things. It re-derives the address
    // and the stamp itself; a refusal here means the row changed under us between
    // the plan and the write, and it is reported rather than forced.
    const anchor = thresholdPaceSecPerKm ?? outdatedPace.get(row.id);
    const outcome = await enqueueContentConvergence(db, {
      // An operator asked for this run explicitly, so a job that failed before
      // is retried rather than silently colliding — see `reviveFailed`.
      reviveFailed: true,
      userId,
      workout: row,
      session,
      now,
      corosWritesEnabled: true,
      ...(anchor ? { thresholdPaceSecPerKm: anchor } : {}),
      // The heal re-sends unchanged content, so its id needs its own tag (see `idTag`).
      ...(outdatedPace.has(row.id) ? { idTag: `pace${RUN_PACE_WIRE}` } : {}),
    });
    if (outcome.jobId) {
      rowReport.jobId = outcome.jobId;
      rowReport.action = outcome.kind === "coach_delete_workout" ? "unpush" : "rewrite";
    } else {
      rowReport.action = "skipped";
      rowReport.reason = `the enqueue refused: ${outcome.refused ?? "unknown"}`;
    }
  }
  report.totals = {
    candidates: report.rows.length,
    rewrites: report.rows.filter((r) => r.action === "rewrite").length,
    unpushes: report.rows.filter((r) => r.action === "unpush").length,
    skipped: report.rows.filter((r) => r.action === "skipped").length,
    unfixable: report.rows.filter((r) => r.action === "unfixable").length,
  };

  report.backup = { auditEventId: backupId, kind: CONTENT_CONVERGE_BACKUP_KIND, table: "audit_events" };
  return report;
}

/**
 * THE HOURLY PACE HEAL (owner-approved 2026-10-10): rewrite the coach runs on the watch with the old pace encoding,
 * one a run, soonest first, until none are left.
 *
 * This is `convergeDivergedContent` for `pace_encoding_outdated` alone — the same backup-first path and the same
 * enqueue the operator route runs, so the cron and the operator cannot heal two different ways. It QUEUES the
 * rewrite; the hourly's COROS write step right after it executes one job, and that write is the run's one heavy step
 * (cron reliability, part 2). When none are left it costs one read. Watch writes off, it does nothing at all.
 *
 * Returns the queued job's id, or null when nothing was queued.
 */
export async function healOutdatedPaceEncoding(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<string | null> {
  if (!prefs.corosWritesEnabled) return null;
  const report = await convergeDivergedContent(db, userId, {
    dryRun: false,
    only: "pace_encoding_outdated",
    maxWrites: 1,
    today: todayInZone(prefs.timezone),
  });
  return report.rows.find((r) => r.jobId)?.jobId ?? null;
}

/**
 * READ-ONLY census: "is there anything diverged, and can it be fixed".
 *
 * It CALLS the planner in dry run rather than reimplementing its test — a census
 * that can disagree with what it previews is decoration (the lesson from
 * 2d7e414's orphan census).
 */
export async function countDivergedContent(
  db: Db,
  userId: string,
): Promise<ContentConvergeReport["totals"] & { unfixableIds: string[] }> {
  const report = await convergeDivergedContent(db, userId, { dryRun: true });
  return {
    ...report.totals,
    unfixableIds: report.rows.filter((r) => r.action === "unfixable").map((r) => r.workoutId),
  };
}
