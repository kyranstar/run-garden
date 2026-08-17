/**
 * ONE-SHOT REPAIR for live `planned_workouts` rows the mirror dedupe archived
 * and nothing was ever able to un-archive. Same shape and the same house rules
 * as `services/plan-repair.ts` and `POST /api/studio/plans/:id/
 * repair-exercise-ids`: `dryRun` is REQUIRED and never defaulted, the
 * pre-change rows go into `audit_events` BEFORE any write, and the caller gets
 * a per-row account of exactly what would change.
 *
 * THE DAMAGE. COROS serves the applied plan twice — the plan definition and its
 * materialized instances under a second plan id — so every pushed lift day
 * arrived as two rows. The importer's dedupe archived the newer twin with
 * `archive_reason = 'duplicate_mirror'` and a matching suppression, which is
 * correct: the athlete must see each session once. Then the older keeper stopped
 * appearing on the wire and rule 8's absence sweep archived IT, releasing the
 * mirror's suppression so presence-healing could take the mirror over on the
 * next read — also correct. But the healing gate re-derived the block from the
 * mirror's own `archive_reason`, which the release does not clear, so the
 * release could never win. Both copies of the session stayed archived while
 * COROS went on serving one of them. Fifteen strength days, live.
 *
 * `import-plan.ts` no longer reads that reason as a standing instruction, so the
 * bug cannot recur. This repairs what it already did, because healing only fires
 * on a row the importer MATCHES, and it can only match a row COROS still serves
 * at the address the row records — which for a mirror archived months ago is not
 * something local data can promise.
 *
 * CANDIDACY, AND WHAT IT ASSUMES. A candidate is an ORPHANED MIRROR: archived
 * `duplicate_mirror`, still `scheduled`, with no live row claiming its COROS
 * address, and no live row holding its session — `mirrorGroupKey`, imported from
 * the importer so the repair and the dedupe cannot drift. That test is decidable
 * from local rows alone and says exactly one thing — *the app archived this row
 * in favour of another copy, and that other copy is gone, so this row is the
 * only record the athlete has of a session that was never cancelled*. It does
 * NOT claim COROS still serves the slot; nothing local can, and reading COROS to
 * find out is not this repair's job.
 *
 * IDENTITY IS NOT THE TITLE, and the first version of this file learned that the
 * near-expensive way. It compared raw `(date, title, sport)` — but `POST
 * /api/plan/repair-fidelity` strips the ownership stamp off LIVE rows and skips
 * archived ones, so a repaired keeper and its unrepaired mirror stopped matching
 * and seven sessions that are ALREADY on the athlete's calendar were reported as
 * orphans: 22 candidates where the truth was 15. Caught in review, before the
 * repair ran. Hence two checks, stable one first: the COROS address, which no
 * title rewrite can touch, and then the session key with both titles normalised
 * through the same `coros-stamp.ts` strip the fidelity repair itself uses.
 *
 * So the assumption is stated rather than hidden: un-archiving returns each row
 * to the state the import path would have left it in had the release worked, and
 * hands it back to evidence-based absence detection. `missing_reads` is left
 * exactly as found and never reset — if COROS really has dropped the slot, rule
 * 8 re-archives the row after the usual two consecutive absent reads, and the
 * athlete sees a session that is not on their watch for at most those two reads.
 * That is the whole downside, and it is bounded and self-correcting; the
 * alternative, leaving fifteen sessions the athlete IS training archived, is
 * neither.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *  - It does not touch rows that are not `scheduled`. A completed or skipped
 *    mirror is history, and history is not rewritten to tidy a duplicate.
 *  - It does not touch a mirror whose twin is still live, whatever the two rows
 *    are currently CALLED. That row is doing its job: the athlete sees the
 *    session exactly once, through the other copy.
 *  - It does not write to COROS or Google Calendar. Both re-derive from these
 *    rows — the calendar mirror creates the event on its next sync, which is why
 *    a stranded suppression has to go with the un-archive (audit#2 #4) and why
 *    the row is left `pending` rather than `synced`.
 *  - It does not invent `archive_reason` history anywhere else, and it does not
 *    clear `absence_confirmed` or `user_removed` rows. Those left for reasons
 *    that are still true.
 */

import { and, eq, inArray } from "drizzle-orm";
import { auditEvents, calendarEventSuppressions, plannedWorkouts } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";
import { loadOwnProgramNames } from "./coros-stamp.js";
// The importer's OWN definition of one session, imported rather than restated:
// this repair reverses the mirror dedupe, so it has to agree with the dedupe
// about what a mirror is, permanently and by construction.
import { mirrorGroupKey } from "./import-plan.js";

/** `audit_events.kind` for the pre-change backup written by a live repair. */
export const MIRROR_REPAIR_BACKUP_KIND = "orphaned_mirror_unarchived";

type WorkoutRow = typeof plannedWorkouts.$inferSelect;

export interface OrphanedMirrorReport {
  workoutId: string;
  effectiveDate: string;
  title: string;
  sport: string;
  /** `repair` — would be un-archived; `skipped` — see reason. */
  action: "repair" | "skipped";
  reason?: string;
  /** What COROS last confirmed about this row, for the operator's judgement. */
  lastVerifiedCorosDate: string;
  archivedAt: string | null;
  /** Left exactly as found; stated so the two-read re-archive is predictable. */
  missingReads: number;
  changes: Array<{ column: string; from: unknown; to: unknown }>;
  /** Suppression rows that would be deleted so the calendar event can exist. */
  suppressionsCleared: string[];
}

export interface MirrorRepairReport {
  dryRun: boolean;
  mirrors: OrphanedMirrorReport[];
  totals: {
    unarchived: number;
    skipped: number;
    suppressionsCleared: number;
  };
  /** Stated in the report so the operator reads it with the numbers. */
  assumes: string;
  backup: { auditEventId: string; kind: string; table: "audit_events" } | null;
}

export interface MirrorRepairOptions {
  dryRun: boolean;
  /**
   * Restrict the repair to these ids. Omitted, every archived `duplicate_mirror`
   * row of the athlete's is examined — which is the set the bug could have
   * touched. Named ids are still checked against the orphan test; a mirror whose
   * twin is alive is reported as skipped and is not written.
   */
  workoutIds?: string[];
}

const ASSUMES =
  "Candidacy is decided from local rows only: archived duplicate_mirror, still scheduled, no " +
  "live row claiming the same COROS address, and no live row holding the same session " +
  "(date + stamp-normalised title + sport, the importer's own mirrorGroupKey). It does NOT " +
  "verify that COROS still serves the slot — that needs a COROS read. A row COROS has " +
  "genuinely dropped re-archives through rule 8 after two consecutive absent reads; " +
  "missing_reads is left as found so that happens at the earliest honest opportunity.";

/**
 * Plan the repair, and — unless `dryRun` — commit it behind a backup.
 *
 * Ordered so the only possible half-state is a backup with no change applied
 * (harmless), never an un-archived row with no way back. `audit_events.detail`
 * carries the complete pre-change rows and the suppression rows removed, so a
 * restore is a re-insert of the JSON with no reconstruction step.
 */
export async function repairOrphanedMirrors(
  db: Db,
  userId: string,
  opts: MirrorRepairOptions,
): Promise<MirrorRepairReport> {
  const all = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));

  // EXHAUSTIVE over history, like `plan-repair.ts`'s own load and for the same
  // reason: the damaged rows are months out, well past any import window, and a
  // stamp this read misses is a twin this repair fails to see.
  const ownProgramNames = await loadOwnProgramNames(db, userId);

  // The orphan test's other half — what is LIVE right now, asked two ways:
  //
  //  · BY ADDRESS. `sourceWorkoutId` is the stable one. If a live row already
  //    claims this row's COROS address, un-archiving would put two rows at one
  //    address; the address survives every title rewrite, so this check cannot
  //    be knocked out by a repair that renames things.
  //  · BY SESSION. `mirrorGroupKey` — the importer's own grouping, titles
  //    normalised through the ownership stamp so a live row `repair-fidelity`
  //    has stripped and an archived mirror it skipped still compare equal.
  const liveAddresses = new Set(all.filter((w) => !w.archivedAt).map((w) => w.sourceWorkoutId));
  const liveKeys = new Set(
    all.filter((w) => !w.archivedAt).map((w) => mirrorGroupKey(w, ownProgramNames)),
  );

  const named = opts.workoutIds ? new Set(opts.workoutIds) : null;
  const candidates = all
    .filter((w) => (named ? named.has(w.id) : w.archivedAt !== null && w.archiveReason === "duplicate_mirror"))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));

  // Suppressions still standing on the candidates — the release deletes these,
  // but a mirror orphaned by any other route (keeper removed by hand, keeper
  // archived while outside the snapshot window) still carries one, and an
  // un-archived row behind a live suppression is a plan entry with no calendar
  // event (audit#2 #4).
  const suppressionsByWorkout = new Map<string, Array<{ id: string; reason: string }>>();
  for (const batch of chunkIds(candidates.map((c) => c.id))) {
    for (const s of await db
      .select({ id: calendarEventSuppressions.id, workoutId: calendarEventSuppressions.workoutId, reason: calendarEventSuppressions.reason })
      .from(calendarEventSuppressions)
      .where(
        and(
          inArray(calendarEventSuppressions.workoutId, batch),
          inArray(calendarEventSuppressions.reason, ["duplicate_mirror", "workout_removed"]),
        ),
      )) {
      const list = suppressionsByWorkout.get(s.workoutId) ?? [];
      list.push({ id: s.id, reason: s.reason });
      suppressionsByWorkout.set(s.workoutId, list);
    }
  }

  const mirrors: OrphanedMirrorReport[] = [];
  const toWrite: Array<{ row: WorkoutRow; suppressionIds: string[] }> = [];
  for (const row of candidates) {
    const suppressions = suppressionsByWorkout.get(row.id) ?? [];
    const base = {
      workoutId: row.id,
      effectiveDate: row.effectiveDate,
      title: row.title,
      sport: row.sport,
      lastVerifiedCorosDate: row.lastVerifiedCorosDate,
      archivedAt: row.archivedAt,
      missingReads: row.missingReads,
      suppressionsCleared: [] as string[],
    };
    const skip = (reason: string): void => {
      mirrors.push({ ...base, action: "skipped", reason, changes: [] });
    };
    if (row.archivedAt === null) {
      skip("row is not archived — nothing to un-archive");
      continue;
    }
    if (row.archiveReason !== "duplicate_mirror") {
      skip(
        `archive_reason is ${row.archiveReason ?? "null"}, not duplicate_mirror — this repair ` +
          "only reverses the dedupe, never an absence or a removal",
      );
      continue;
    }
    if (row.completionState !== "scheduled") {
      skip(`row is ${row.completionState} — history is not rewritten`);
      continue;
    }
    if (liveAddresses.has(row.sourceWorkoutId)) {
      skip("a live row already claims this COROS address — un-archiving would double-claim it");
      continue;
    }
    if (liveKeys.has(mirrorGroupKey(row, ownProgramNames))) {
      skip("a live row still holds this session — the mirror is doing its job");
      continue;
    }
    mirrors.push({
      ...base,
      action: "repair",
      changes: [
        { column: "archivedAt", from: row.archivedAt, to: null },
        // Cleared WITH the un-archive, not left behind: a live row carrying
        // "why it left" is the exact half-state that re-armed the healing gate.
        { column: "archiveReason", from: row.archiveReason, to: null },
        ...(row.calendarSyncState === "user_deleted"
          ? []
          : [{ column: "calendarSyncState", from: row.calendarSyncState, to: "pending" }]),
      ],
      suppressionsCleared: suppressions.map((s) => `${s.reason} (${s.id})`),
    });
    toWrite.push({ row, suppressionIds: suppressions.map((s) => s.id) });
  }

  const report: MirrorRepairReport = {
    dryRun: opts.dryRun,
    mirrors,
    totals: {
      unarchived: toWrite.length,
      skipped: mirrors.filter((m) => m.action === "skipped").length,
      suppressionsCleared: toWrite.reduce((n, w) => n + w.suppressionIds.length, 0),
    },
    assumes: ASSUMES,
    backup: null,
  };

  if (opts.dryRun || toWrite.length === 0) return report;

  // ── BACKUP FIRST, then the writes.
  const now = nowInstant();
  const backupId = newId();
  await db.insert(auditEvents).values({
    id: backupId,
    userId,
    kind: MIRROR_REPAIR_BACKUP_KIND,
    detail: {
      workoutIds: toWrite.map((w) => w.row.id),
      mirrors: report.mirrors,
      totals: report.totals,
      assumes: ASSUMES,
      previousWorkouts: toWrite.map((w) => w.row),
      previousSuppressionIds: toWrite.flatMap((w) => w.suppressionIds),
    },
    createdAt: now,
  });

  for (const { row, suppressionIds } of toWrite) {
    await db
      .update(plannedWorkouts)
      .set({
        archivedAt: null,
        archiveReason: null,
        // `user_deleted` is the athlete having deleted the event; that survives.
        ...(row.calendarSyncState === "user_deleted" ? {} : { calendarSyncState: "pending" }),
        updatedAt: now,
      })
      .where(and(eq(plannedWorkouts.id, row.id), eq(plannedWorkouts.userId, userId)));
    for (const batch of chunkIds(suppressionIds)) {
      await db.delete(calendarEventSuppressions).where(inArray(calendarEventSuppressions.id, batch));
    }
  }

  report.backup = { auditEventId: backupId, kind: MIRROR_REPAIR_BACKUP_KIND, table: "audit_events" };
  return report;
}

/**
 * Read-only census of the damage — how many archived mirrors the athlete has and
 * how many are orphans — for deciding whether to run the repair at all.
 *
 * IT IS THE REPAIR'S OWN DRY RUN, not a second implementation of the candidacy
 * test. This is the number an operator reads to decide whether to write to the
 * athlete's live rows, and a census that can disagree with the thing it is a
 * census OF is worse than no census: it is a number that looks like evidence.
 * The first version of this function did re-state the test, and it was wrong in
 * exactly the way the repair was — 22 where the truth was 15.
 *
 * It therefore costs what the dry run costs: the athlete's `planned_workouts`
 * rows and the stamp registry, one user-scoped read each. Deliberately not
 * optimised into a second, cheaper, drifting copy. `skipped` is reported
 * alongside, because on these rows the skipped count IS the damage avoided.
 */
export async function countOrphanedMirrors(
  db: Db,
  userId: string,
): Promise<{ archivedMirrors: number; orphaned: number; dates: string[]; skipped: number }> {
  const report = await repairOrphanedMirrors(db, userId, { dryRun: true });
  const repairing = report.mirrors.filter((m) => m.action === "repair");
  return {
    archivedMirrors: report.mirrors.length,
    orphaned: repairing.length,
    dates: [...new Set(repairing.map((m) => m.effectiveDate))].sort(),
    skipped: report.totals.skipped,
  };
}
