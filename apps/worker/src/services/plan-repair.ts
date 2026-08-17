/**
 * ONE-SHOT FIDELITY REPAIR for live `planned_workouts` rows damaged by two
 * now-fixed bugs. Same shape and the same house rules as
 * `POST /api/studio/plans/:id/repair-exercise-ids`: `dryRun` is required and
 * never defaulted, the pre-change state goes into `audit_events` BEFORE any
 * write, and the caller gets a per-row account of exactly what would change.
 *
 * TWO INDEPENDENT REPAIRS, one call, because they were one root cause — a write
 * path that updated some of a row and left the rest describing a session that no
 * longer existed.
 *
 * (A) EASED ROWS THAT KEPT THEIR OLD BODY. `coach-apply.ts`'s `ease` used to
 *     update seven columns and nothing else. The row's title, category, block
 *     duration and `stage_summary` became the eased session; its stage rows,
 *     `structured_json`, `expected_distance_meters`, `quality_subtype`,
 *     `source_estimated_duration_seconds` and `duration_estimate` stayed with
 *     the workout it replaced. Live effect: a session titled "Easy first run
 *     back" / "35min easy" / 35-minute block whose sheet showed 6 × 643 m at
 *     4:49–5:13, whose plan card said 75 minutes, and whose Google Calendar
 *     event was 100 minutes long.
 *
 * (B) TITLES THAT ARE OWNERSHIP STAMPS. The program name we write to COROS to
 *     prove authorship — `${title} — ${date}` — comes back on the next read and
 *     `normalize.ts` reads it as the workout's title, so rows ended up literally
 *     named "Legs-back jog — 2026-10-26". See `coros-stamp.ts` for why the stamp
 *     must keep being emitted and is therefore stripped on the way in.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *  - It does not reconstruct the eased session's body. The approved ease was
 *    never stored as a session (`recordIntent` keeps only a fingerprint), so the
 *    only honest thing to do with stage rows describing the PRE-ease workout is
 *    to remove them. The row then renders from its stored `stage_summary` — the
 *    string the ease itself wrote — which is the athlete's approved
 *    prescription. Inventing stage rows to match it would be a guess presented
 *    as a prescription.
 *  - It does not touch COROS or Google Calendar. Both re-derive from the row:
 *    the calendar mirror diffs `eventContentFingerprint` against
 *    `calendar_event_links.lastWrittenFingerprint` and self-heals on the next
 *    sync, and `coros_sync_state` is already `calendar_only` on an eased row.
 *  - It does not touch rows that are not `scheduled`, or archived rows. A
 *    completed session's numbers are part of a story that already happened, and
 *    a rewritten `expected_distance_meters` cannot un-match its activity.
 *  - It does not clear `structured_json` on a lift or mobility row. For a run
 *    the correct value is provably `null`; for an exercise session the stored
 *    list may be the stale pre-ease one or may be right, and there is no
 *    evidence here to tell them apart. Reported as a warning instead.
 *  - It does not clear `source_version`. That records the version of COROS's
 *    copy, which a local ease does not change, and `jobs.ts` uses it as a move
 *    job's concurrency check.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { auditEvents, plannedWorkoutStages, plannedWorkouts, syncIntents } from "@rg/database";
import { formatExerciseBlock, newId, nowInstant } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";
import { loadOwnProgramNames } from "./coros-stamp.js";

/** `audit_events.kind` for the pre-change backup written by a live repair. */
export const FIDELITY_REPAIR_BACKUP_KIND = "planned_workout_fidelity_repaired";

type WorkoutRow = typeof plannedWorkouts.$inferSelect;
type StageRow = typeof plannedWorkoutStages.$inferSelect;

/** One column this repair would rewrite, in the athlete's row. */
export interface FieldChange {
  column: string;
  from: unknown;
  to: unknown;
}

export interface EasedRowReport {
  workoutId: string;
  effectiveDate: string;
  title: string;
  /** `repair` — changes listed; `clean` — already consistent; `skipped` — see reason. */
  action: "repair" | "clean" | "skipped";
  reason?: string;
  changes: FieldChange[];
  /** The pre-ease prescription that would be deleted, one line per stage row. */
  stagesRemoved: string[];
  warnings: string[];
}

export interface StampedTitleReport {
  workoutId: string;
  effectiveDate: string;
  action: "repair" | "skipped";
  reason?: string;
  from: string;
  to: string;
}

export interface FidelityRepairReport {
  dryRun: boolean;
  eased: EasedRowReport[];
  stampedTitles: StampedTitleReport[];
  totals: {
    easedRowsRepaired: number;
    easedRowsClean: number;
    easedRowsSkipped: number;
    stageRowsRemoved: number;
    titlesRepaired: number;
    warnings: number;
  };
  backup: { auditEventId: string; kind: string; table: "audit_events" } | null;
}

/** One stage row as the operator needs to read it in the report. */
function describeStage(s: StageRow): string {
  const amount =
    s.durationType === "time"
      ? `${s.durationSeconds ?? 0}s`
      : `${Math.round(s.distanceMeters ?? 0)}m`;
  const target =
    s.targetType === "pace" && s.targetLow != null && s.targetHigh != null
      ? ` @ ${s.targetLow}-${s.targetHigh}s/km`
      : "";
  return `#${s.ord} ${s.kind} ${amount}${target}${s.label ? ` (${s.label})` : ""}`;
}

/**
 * The columns an eased row still holds from the session it replaced, and what a
 * correctly-eased row would hold instead.
 *
 * `calendar_block_duration_seconds` is the anchor: `ease` DID write it, from the
 * approved session's own `durationMinutes`, so it is the one derived number on
 * the row that describes the eased session. Every other duration is realigned
 * to it rather than to anything COROS said.
 */
function easedRowChanges(row: WorkoutRow, stages: StageRow[]): FieldChange[] {
  const changes: FieldChange[] = [];
  const push = (column: string, from: unknown, to: unknown): void => {
    if (from !== to) changes.push({ column, from, to });
  };
  // The headline: every duration consumer reads `source ?? fallback`, so this
  // one column is what made the plan card say 75 minutes and the calendar book
  // 100 against a 35-minute block.
  push("sourceEstimatedDurationSeconds", row.sourceEstimatedDurationSeconds, null);
  push(
    "fallbackEstimatedDurationSeconds",
    row.fallbackEstimatedDurationSeconds,
    row.calendarBlockDurationSeconds,
  );
  push("expectedDistanceMeters", row.expectedDistanceMeters, null);
  push("qualitySubtype", row.qualitySubtype, null);
  if (row.durationEstimate !== null) {
    changes.push({ column: "durationEstimate", from: row.durationEstimate, to: null });
  }
  if (row.sport === "run" && row.structuredJson !== null) {
    changes.push({ column: "structuredJson", from: row.structuredJson, to: null });
  }
  if (stages.length > 0) {
    changes.push({ column: "stages", from: `${stages.length} rows`, to: "0 rows" });
  }
  return changes;
}

function easedRowWarnings(row: WorkoutRow): string[] {
  const warnings: string[] = [];
  if (row.sport === "run" || row.structuredJson === null) return warnings;
  // A lift/mobility row's exercise list may be the stale pre-ease one. The
  // stored `stage_summary` WAS written by the ease, so when the two disagree the
  // list is provably stale — but the eased list itself was never stored, so this
  // is a diagnosis for the human, not something to guess at.
  const stored = row.structuredJson as { exercises?: unknown[]; rounds?: number };
  const rendered = Array.isArray(stored.exercises)
    ? formatExerciseBlock({
        rounds: stored.rounds ?? undefined,
        exercises: stored.exercises as never,
      })
    : null;
  if (rendered !== null && row.stageSummary !== null && rendered !== row.stageSummary) {
    warnings.push(
      `structured_json renders as "${rendered}" but the ease wrote stage_summary ` +
        `"${row.stageSummary}" — the exercise list is stale and this repair cannot ` +
        `reconstruct it; re-ease the session to replace it`,
    );
  }
  return warnings;
}

export interface RepairOptions {
  dryRun: boolean;
  /**
   * Restrict the eased-row repair to these ids. Omitted, every row carrying an
   * open `coach_ease` content claim is examined — which is the set the bug could
   * have touched. Named ids are still checked for the damage signature; a clean
   * row is reported as clean and is not written.
   */
  workoutIds?: string[];
}

/**
 * Plan the repair, and — unless `dryRun` — commit it behind a backup.
 *
 * Ordered so the only possible half-state is a backup with no change applied
 * (harmless), never a rewritten row with no way back. `audit_events.detail`
 * carries the complete pre-change rows AND their stage rows, so a restore is a
 * re-insert of the JSON, not a reconstruction.
 */
export async function repairPlannedWorkoutFidelity(
  db: Db,
  userId: string,
  opts: RepairOptions,
): Promise<FidelityRepairReport> {
  // ── (A) candidates: rows an approved ease claims, still carrying COROS's
  // estimate for the body it replaced. That second half is the discriminator,
  // and it is exact: a correctly-eased row has
  // `source_estimated_duration_seconds` NULL by construction, so a row that has
  // one was eased by the broken writer.
  //
  // Authorship is proven two ways, either sufficient. The open `coach_ease`
  // content intent is the direct record of the approval (content intents never
  // resolve, so the latest ease's is always open). A `coach-` prefixed
  // `source_content_fingerprint` is the second: that prefix is minted by
  // `coach-apply.ts`'s own hash, and a row can only still be wearing it AND
  // carrying a COROS estimate by way of the broken ease — a coach CREATE has
  // no COROS estimate, and any import that gave the row one also overwrote the
  // fingerprint with the wire's.
  const COACH_FINGERPRINT_PREFIX = "coach-";
  const claimedIds = new Set(
    (
      await db
        .select({ targetId: syncIntents.targetId })
        .from(syncIntents)
        .where(
          and(
            eq(syncIntents.userId, userId),
            eq(syncIntents.kind, "content"),
            eq(syncIntents.source, "coach_ease"),
            isNull(syncIntents.resolvedAt),
            isNull(syncIntents.supersededBy),
          ),
        )
    ).map((r) => r.targetId),
  );
  const easedRows: WorkoutRow[] = [];
  if (opts.workoutIds) {
    for (const ids of chunkIds(opts.workoutIds)) {
      easedRows.push(
        ...(await db
          .select()
          .from(plannedWorkouts)
          .where(and(eq(plannedWorkouts.userId, userId), inArray(plannedWorkouts.id, ids)))),
      );
    }
  } else {
    // Unnamed: every row either proof identifies, so a damaged row cannot be
    // missed just because its intent row went missing.
    easedRows.push(
      ...(
        await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))
      ).filter(
        (r) =>
          claimedIds.has(r.id) || r.sourceContentFingerprint.startsWith(COACH_FINGERPRINT_PREFIX),
      ),
    );
  }
  const authored = (row: WorkoutRow): boolean =>
    claimedIds.has(row.id) || row.sourceContentFingerprint.startsWith(COACH_FINGERPRINT_PREFIX);
  easedRows.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));

  const stagesByWorkout = new Map<string, StageRow[]>();
  for (const ids of chunkIds(easedRows.map((r) => r.id))) {
    for (const s of await db
      .select()
      .from(plannedWorkoutStages)
      .where(inArray(plannedWorkoutStages.workoutId, ids))) {
      const list = stagesByWorkout.get(s.workoutId) ?? [];
      list.push(s);
      stagesByWorkout.set(s.workoutId, list);
    }
  }

  const eased: EasedRowReport[] = [];
  const easedToWrite: Array<{ row: WorkoutRow; changes: FieldChange[]; stages: StageRow[] }> = [];
  for (const row of easedRows) {
    const stages = (stagesByWorkout.get(row.id) ?? []).sort((a, b) => a.ord - b.ord);
    const base = {
      workoutId: row.id,
      effectiveDate: row.effectiveDate,
      title: row.title,
      stagesRemoved: [] as string[],
      warnings: [] as string[],
    };
    if (!authored(row)) {
      // A named id with no coach authorship behind it: the "damage" would be
      // ordinary imported content, and clearing it would delete real COROS
      // structure. Never guessed at, however explicitly it was asked for.
      eased.push({
        ...base,
        action: "skipped",
        reason:
          "no open coach_ease content claim and no coach-authored content fingerprint — " +
          "refusing to treat this as an eased row",
        changes: [],
      });
      continue;
    }
    if (row.sourceEstimatedDurationSeconds === null) {
      eased.push({ ...base, action: "clean", changes: [], warnings: easedRowWarnings(row) });
      continue;
    }
    if (row.archivedAt !== null || row.completionState !== "scheduled") {
      eased.push({
        ...base,
        action: "skipped",
        reason: `row is ${row.archivedAt ? "archived" : row.completionState} — history is not rewritten`,
        changes: [],
      });
      continue;
    }
    const changes = easedRowChanges(row, stages);
    const warnings = easedRowWarnings(row);
    eased.push({
      ...base,
      action: changes.length > 0 ? "repair" : "clean",
      changes,
      stagesRemoved: stages.map(describeStage),
      warnings,
    });
    if (changes.length > 0) easedToWrite.push({ row, changes, stages });
  }

  // ── (B) candidates: any live row whose title is character-for-character a
  // program name this account wrote. Exhaustive over history on purpose — the
  // damaged rows are months out, well past any import window.
  const ownNames = await loadOwnProgramNames(db, userId);
  const stampedTitles: StampedTitleReport[] = [];
  const titlesToWrite: Array<{ row: WorkoutRow; to: string }> = [];
  if (ownNames.size > 0) {
    const allRows = await db
      .select()
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.userId, userId));
    for (const row of allRows.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))) {
      const clean = ownNames.get(row.title);
      if (clean === undefined || clean === row.title) continue;
      if (row.archivedAt !== null) {
        stampedTitles.push({
          workoutId: row.id,
          effectiveDate: row.effectiveDate,
          action: "skipped",
          reason: "row is archived — it is not on the athlete's calendar",
          from: row.title,
          to: clean,
        });
        continue;
      }
      stampedTitles.push({
        workoutId: row.id,
        effectiveDate: row.effectiveDate,
        action: "repair",
        from: row.title,
        to: clean,
      });
      titlesToWrite.push({ row, to: clean });
    }
  }

  const report: FidelityRepairReport = {
    dryRun: opts.dryRun,
    eased,
    stampedTitles,
    totals: {
      easedRowsRepaired: eased.filter((r) => r.action === "repair").length,
      easedRowsClean: eased.filter((r) => r.action === "clean").length,
      easedRowsSkipped: eased.filter((r) => r.action === "skipped").length,
      stageRowsRemoved: easedToWrite.reduce((n, e) => n + e.stages.length, 0),
      titlesRepaired: titlesToWrite.length,
      warnings: eased.reduce((n, r) => n + r.warnings.length, 0),
    },
    backup: null,
  };

  if (opts.dryRun) return report;
  if (easedToWrite.length === 0 && titlesToWrite.length === 0) return report;

  // ── BACKUP FIRST, then the writes. `planned_workouts` has no history table,
  // so the pre-change rows and their stage rows go into `audit_events` whole —
  // the same durable store the studio repair backs up into. Restoring is a
  // re-insert of `detail.previousWorkouts` / `detail.previousStages`, with no
  // reconstruction step and nothing inferred.
  const now = nowInstant();
  const backupId = newId();
  const touchedIds = [...new Set([...easedToWrite.map((e) => e.row.id), ...titlesToWrite.map((t) => t.row.id)])];
  await db.insert(auditEvents).values({
    id: backupId,
    userId,
    kind: FIDELITY_REPAIR_BACKUP_KIND,
    detail: {
      workoutIds: touchedIds,
      eased: report.eased,
      stampedTitles: report.stampedTitles,
      totals: report.totals,
      previousWorkouts: [
        ...easedToWrite.map((e) => e.row),
        ...titlesToWrite.filter((t) => !easedToWrite.some((e) => e.row.id === t.row.id)).map((t) => t.row),
      ],
      previousStages: easedToWrite.flatMap((e) => e.stages),
    },
    createdAt: now,
  });

  for (const { row } of easedToWrite) {
    await db
      .update(plannedWorkouts)
      .set({
        sourceEstimatedDurationSeconds: null,
        fallbackEstimatedDurationSeconds: row.calendarBlockDurationSeconds,
        durationEstimate: null,
        expectedDistanceMeters: null,
        qualitySubtype: null,
        ...(row.sport === "run" ? { structuredJson: null } : {}),
        updatedAt: now,
      })
      .where(and(eq(plannedWorkouts.id, row.id), eq(plannedWorkouts.userId, userId)));
    // The pre-ease body. Deleted, not rewritten: see the module header.
    await db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, row.id));
  }

  for (const { row, to } of titlesToWrite) {
    await db
      .update(plannedWorkouts)
      .set({ title: to, updatedAt: now })
      .where(and(eq(plannedWorkouts.id, row.id), eq(plannedWorkouts.userId, userId)));
  }

  report.backup = { auditEventId: backupId, kind: FIDELITY_REPAIR_BACKUP_KIND, table: "audit_events" };
  return report;
}
