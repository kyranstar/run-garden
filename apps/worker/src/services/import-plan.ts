import { and, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import {
  calendarEventSuppressions,
  corosWriteJobs,
  plannedWorkoutStages,
  plannedWorkouts,
  syncIntents,
  trainingPlanVersions,
  trainingPlans,
  workoutCompletionMatches,
} from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { classifyWorkout, estimateDuration, summarizeStages } from "@rg/scheduling";
import type { SourcePlannedWorkout, TrainingPlanInfo } from "@rg/providers";
import { chunkedInsert, type Db } from "./db.js";
import { separateDayCollisions, windowTimeFor } from "./day-placement.js";
import { loadOwnProgramNames, unstampTitle } from "./coros-stamp.js";
import { openMoveIntents, resolveIntent } from "./sync-intents.js";
import { postSyncNote } from "./sync-notes.js";
import { reconcileWorkout } from "./reconcile.js";

/**
 * Plan import + COROS reconciliation (rules 1–11 of the sync spec, see
 * docs/SYNC_AND_RECONCILIATION.md). Idempotent: re-importing the same snapshot
 * is a no-op.
 */

export interface ImportInput {
  userId: string;
  plan: TrainingPlanInfo;
  workouts: SourcePlannedWorkout[];
  /** The date range this snapshot covers (for absence detection). */
  rangeStart: string;
  rangeEnd: string;
  source: "bridge" | "fixture" | "official";
}

export interface ImportStats {
  planId: string;
  created: number;
  updatedDates: number;
  updatedContent: number;
  archivedMissing: number;
  /** Rows resurrected because COROS demonstrably still schedules them. */
  unarchived: number;
  /** Workouts skipped because their plan is a COROS template/sample plan. */
  skippedForeignWorkouts: number;
  /** Rows rewritten in place because COROS recycled their idInPlan slot. */
  replacedRecycled: number;
  /** Mirror copies archived so each real session shows exactly once. */
  dedupedMirrors: number;
  verifiedJobs: number;
  conflicts: number;
  /** Rows whose stage_summary was re-derived because the FORMATTER changed,
   * not the workout. Never counts as a content change (no plan version, no
   * sync note, no calendar state flip) — see the heal below. */
  rewordedSummaries: number;
  /** Sessions given a non-colliding time because their day was double-booked. */
  separatedTimes: number;
  /** Wire workouts whose stored address was claimed by more than one row. */
  contestedAddresses: number;
  unchanged: number;
}

type StoredWorkout = typeof plannedWorkouts.$inferSelect;

/**
 * WHEN ARE TWO ROWS THE SAME SESSION? The one answer — used by the mirror
 * dedupe, by the healing gate that decides whether a deduped mirror may come
 * back, by rule 8's release, and by `mirror-repair.ts`, which imports it from
 * here precisely so the repair cannot drift from the rule it reverses.
 *
 * THE TITLE IS NORMALISED, and that is the whole point of this function
 * existing rather than an inline template string. A raw title is MUTABLE: `POST
 * /api/plan/repair-fidelity` strips the COROS ownership stamp off LIVE rows and
 * deliberately skips archived ones, so on 2026-08-17 seven days held
 *
 *     LIVE  "W2 Wed - Vacation Placeholder - hips & glutes"
 *     arch  "W2 Wed - Vacation Placeholder - hips & glutes — wk 2"
 *
 * — the same session, wearing two names, because one copy had been repaired and
 * the other had not. Keyed on the raw title they stop being twins: the gate
 * frees a mirror that is still perfectly well represented, the dedupe no longer
 * groups them so nothing catches it afterwards, and the athlete gets a duplicate
 * session. Both sides therefore go through `unstampTitle`, the same proven strip
 * the fidelity repair itself uses — a stamped copy and a stripped copy compare
 * equal, and an already-stripped title passes through unchanged.
 *
 * Not a regex over anything that looks stamped: `coros-stamp.ts` strips a title
 * only when it is character-for-character a program name this account emitted.
 */
export function mirrorGroupKey(
  w: { effectiveDate: string; title: string; sport: string },
  ownProgramNames: Map<string, string>,
): string {
  return `${w.effectiveDate}|${unstampTitle(w.title, ownProgramNames)}|${w.sport}`;
}

/**
 * WHICH stored row is this wire workout, given that its address may be claimed
 * by several (`existingByAddress` above)?
 *
 * The order below is the order the evidence is worth, strongest first, and it is
 * the same discipline `studio-push.ts` arrived at the expensive way: the
 * OWNERSHIP STAMP plus the day is the identity, an address is only a claim.
 *
 *  1. A LIVE row beats an ARCHIVED one. An archived row is the record of a
 *     workout that left; a live row is a workout that is here. When both claim
 *     one address, COROS is talking about the live one — resolving to the
 *     archived one resurrects a stranger's record and strands the real session.
 *     Archived rows stay candidates, though, and deliberately: presence-healing
 *     an archived row back into the plan is the whole point of rule 8's
 *     counterpart, and refusing them would also mean inserting a second row at
 *     an address the unique index already holds.
 *  2. The TITLE matching is the stamp: same session name, same session.
 *  3. The DAY agreeing (either side of it — what COROS last said, or where the
 *     row sits now).
 *  4. Filed under the plan row this wire workout belongs to. Last, not first,
 *     because a coach-created session that COROS verified keeps its coach plan
 *     while gaining a wire address in the COROS plan — plan agreement is
 *     ordinary evidence, not the key.
 *  5. Oldest `createdAt`, then id. Never D1's row order.
 */
function resolveClaimant(
  candidates: StoredWorkout[],
  wire: { title: string; date: string; planId: string },
): StoredWorkout | undefined {
  if (candidates.length <= 1) return candidates[0];
  const score = (w: StoredWorkout): number[] => [
    w.archivedAt ? 1 : 0,
    w.title === wire.title ? 0 : 1,
    w.lastVerifiedCorosDate === wire.date || w.effectiveDate === wire.date ? 0 : 1,
    w.planId === wire.planId ? 0 : 1,
  ];
  return [...candidates].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return sa[i]! - sb[i]!;
    }
    return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);
  })[0];
}

export async function importPlanSnapshot(
  db: Db,
  input: ImportInput,
  prefs: UserPreferences,
): Promise<ImportStats> {
  const now = nowInstant();
  const stats: ImportStats = {
    planId: "",
    created: 0,
    updatedDates: 0,
    updatedContent: 0,
    archivedMissing: 0,
    unarchived: 0,
    skippedForeignWorkouts: 0,
    replacedRecycled: 0,
    dedupedMirrors: 0,
    verifiedJobs: 0,
    conflicts: 0,
    rewordedSummaries: 0,
    separatedTimes: 0,
    contestedAddresses: 0,
    unchanged: 0,
  };

  // ── Foreign-plan filter ────────────────────────────────────────────────────
  // The merged read also carries COROS's own demo plans, and those are the
  // ONLY junk observed on the wire — every entity in them is literally
  // titled "… - Sample Workout". Everything else is the user's: the
  // top-level plan, studio-stamped sessions, and the second plan COROS
  // materializes the applied schedule into. An earlier heuristic ("admit
  // non-primary plans only if they overlap the primary") backfired
  // live when COROS moved ALL the runs into that second plan and left the
  // top-level holding only lifting — the real run schedule scored zero
  // overlap and got archived. Admission is therefore permissive: skip a
  // non-primary plan only when it is majority sample-titled; skipped plans'
  // stale rows age out through absence detection, and a wrongly skipped
  // plan self-heals via presence-based un-archiving the moment it's
  // admitted again.
  const SAMPLE_TITLE_RE = /sample workout/i;
  const admittedPlanIds = new Set<string>([input.plan.sourcePlanId]);
  for (const sourcePlanId of new Set(input.workouts.map((w) => w.sourcePlanId))) {
    if (admittedPlanIds.has(sourcePlanId)) continue;
    const group = input.workouts.filter((w) => w.sourcePlanId === sourcePlanId);
    const sampleShare =
      group.length > 0 ? group.filter((w) => SAMPLE_TITLE_RE.test(w.title)).length / group.length : 0;
    if (sampleShare > 0.5) stats.skippedForeignWorkouts += group.length;
    else admittedPlanIds.add(sourcePlanId);
  }
  const admitted = input.workouts.filter((w) => admittedPlanIds.has(w.sourcePlanId));

  // ── Plan rows — one per COROS plan present in this (merged) snapshot ──────
  // schedule/query merges every plan on the account (research §3): the run
  // plan, COROS template plans, and the account's own container plan that
  // studio-pushed lifting sessions live in. Each workout arrives tagged with
  // its own sourcePlanId; a plan row is upserted per distinct id. A plan that
  // stops appearing is left active — its workouts age out via absence
  // detection (rule 8), which is evidence-based, unlike the old "archive
  // every other active plan" rule that mass-archived good workouts whenever
  // the merged response's top-level plan flipped.
  const activePlans = await db
    .select()
    .from(trainingPlans)
    .where(and(eq(trainingPlans.userId, input.userId), eq(trainingPlans.status, "active")));
  const planRowsBySourceId = new Map(activePlans.map((p) => [p.sourcePlanId, p]));

  for (const sourcePlanId of admittedPlanIds) {
    const isPrimary = sourcePlanId === input.plan.sourcePlanId;
    const existing = planRowsBySourceId.get(sourcePlanId);
    if (!existing) {
      const group = admitted.filter((w) => w.sourcePlanId === sourcePlanId);
      const allStrength = group.length > 0 && group.every((w) => w.sport === "strength");
      const id = newId();
      await db.insert(trainingPlans).values({
        id,
        userId: input.userId,
        provider: "coros",
        sourcePlanId,
        // Only the top-level plan's metadata is present in the response; other
        // plans get an honest generic name rather than a leaked i18n code.
        name: isPrimary ? input.plan.name : allStrength ? "Lifting plan" : "COROS plan",
        startDate: isPrimary ? (input.plan.startDate ?? null) : null,
        endDate: isPrimary ? (input.plan.endDate ?? null) : null,
        status: "active",
        pbVersion: isPrimary ? (input.plan.pbVersion ?? null) : null,
        sourceVersion: isPrimary ? (input.plan.sourceVersion ?? null) : null,
        createdAt: now,
        updatedAt: now,
      });
      planRowsBySourceId.set(
        sourcePlanId,
        (await db.select().from(trainingPlans).where(eq(trainingPlans.id, id)))[0]!,
      );
    } else if (
      isPrimary &&
      (existing.name !== input.plan.name || existing.pbVersion !== (input.plan.pbVersion ?? null))
    ) {
      await db
        .update(trainingPlans)
        .set({
          name: input.plan.name,
          pbVersion: input.plan.pbVersion ?? null,
          endDate: input.plan.endDate ?? existing.endDate,
          updatedAt: now,
        })
        .where(eq(trainingPlans.id, existing.id));
    }
  }
  stats.planId = planRowsBySourceId.get(input.plan.sourcePlanId)!.id;

  const existing = await db
    .select()
    .from(plannedWorkouts)
    .where(eq(plannedWorkouts.userId, input.userId));

  // A STORED `${corosPlanId}:${idInPlan}` IS A CLAIM ON AN ADDRESS, NOT AN
  // IDENTITY. This map used to be keyed on `sourceWorkoutId` alone, under the
  // comment "sourceWorkoutIds are globally unique". They are not, twice over:
  // the unique index is `(userId, planId, sourceWorkoutId)`, and COROS RECYCLES
  // a plan's `idInPlan` slots after deletes, so one address is claimed over time
  // by every row that ever occupied it (`studio-push.ts` module rule 6 — a
  // stale address there read a stranger's archived run as our session going
  // missing and adopted 19 healthy rows on that finding). Prod holds ten
  // addresses claimed by both a pushed lift day and an archived run row, and two
  // claimed by an archived run row AND a live coach row; which one a
  // last-row-wins map returned was decided by D1's row order, and would resolve
  // the wrong row the moment the 90-day window rolls onto November.
  //
  // So every claimant is kept and the wire workout picks its own — by the same
  // evidence the rest of this codebase identifies a workout with.
  const existingByAddress = new Map<string, Array<typeof existing[number]>>();
  for (const w of existing) {
    const list = existingByAddress.get(w.sourceWorkoutId) ?? [];
    list.push(w);
    existingByAddress.set(w.sourceWorkoutId, list);
  }
  const existingById = new Map(existing.map((w) => [w.id, w]));

  // Our own ownership stamp is plumbing, not a session name (`coros-stamp.ts`).
  // COROS serves a program's name back verbatim and `normalize.ts` reads it as
  // the workout's title, so without this the discriminator we append to make a
  // create provable — "Legs-back jog — 2026-10-26" — lands in the row's title
  // and becomes what the athlete sees on the watch, in the app and in Google
  // Calendar. Loaded once for the window, never queried per row.
  //
  // Loaded HERE, before anything reads a title, rather than just before the
  // wire loop: `mirrorGroupKey` needs it too, and a session-identity test that
  // ran on raw titles was one repair away from putting duplicates on the
  // athlete's calendar.
  const ownProgramNames = await loadOwnProgramNames(db, input.userId, {
    start: input.rangeStart,
    end: input.rangeEnd,
  });

  // ── Why a row left vs. whether it may come back ─────────────────────────────
  //
  // Two different facts, and this file used to keep them in one place:
  //
  //   EVIDENCE — `archive_reason`, and the suppression row beside it. WHY the
  //     row left. History. It never stops being true.
  //   A STANDING INSTRUCTION — may this row come back if COROS still serves it?
  //     An instruction can be withdrawn; a piece of history cannot.
  //
  // Reading the evidence as the instruction cost the athlete fifteen strength
  // sessions (2026-08-17). After the 08-14 re-push each lift day held two rows:
  // the dedupe archived the newer twin `duplicate_mirror`, then rule 8's absence
  // sweep archived the older keeper and RELEASED the mirror by deleting its
  // suppression — exactly as designed. But the belt then re-derived the block
  // from the mirror's own `archive_reason`, which the release does not clear, so
  // the release could never win and the only surviving copy of each session
  // stayed archived forever while COROS went on serving it.
  //
  // The instruction is therefore re-derived here, every import, from what is
  // true NOW. Neither reason is special-cased away; each is asked what it
  // actually says:
  //
  //   user_removed     — a person decided. Nothing an import observes can
  //                      withdraw that; only a restore, which clears the reason.
  //   duplicate_mirror — "show the OTHER copy, not this one". Conditional by
  //                      construction: it says nothing at all once the other
  //                      copy is gone. When no live row still holds the session,
  //                      this mirror is the only copy left and must be free to
  //                      heal — whether the release ran, ran early, or never ran
  //                      at all (a keeper removed by hand, or archived while
  //                      outside the snapshot window, releases nothing today).
  //
  // "The other copy" is `mirrorGroupKey` — the dedupe's own definition of one
  // session, titles normalised through the ownership stamp so a repaired live
  // row and an unrepaired archived mirror are still recognised as twins.
  const liveCountByMirrorKey = new Map<string, number>();
  for (const w of existing) {
    if (w.archivedAt) continue;
    const key = mirrorGroupKey(w, ownProgramNames);
    liveCountByMirrorKey.set(key, (liveCountByMirrorKey.get(key) ?? 0) + 1);
  }
  /** Does another LIVE row still hold this row's session? */
  const liveTwinExists = (w: typeof existing[number]): boolean => {
    const total = liveCountByMirrorKey.get(mirrorGroupKey(w, ownProgramNames)) ?? 0;
    return total - (w.archivedAt ? 0 : 1) > 0;
  };

  // The evidence, from both places it is written. Only the two DECISION reasons
  // are collected: `absence_confirmed` is the opposite kind of fact — it says
  // COROS stopped serving the row, which presence in this very snapshot has just
  // disproved, and it is precisely what healing exists to reverse. The row's own
  // reason and the suppression row say the same thing when both exist; either
  // alone is enough (audit#3 D2: a row archived as a decision must stay out even
  // if its suppression row is ever swept).
  const DECISION_REASONS = ["user_removed", "duplicate_mirror"] as const;
  const archiveEvidence = new Map<string, string>();
  for (const w of existing) {
    if (w.archivedAt && (DECISION_REASONS as readonly string[]).includes(w.archiveReason ?? "")) {
      archiveEvidence.set(w.id, w.archiveReason!);
    }
  }
  for (const s of await db
    .select({ workoutId: calendarEventSuppressions.workoutId, reason: calendarEventSuppressions.reason })
    .from(calendarEventSuppressions)
    .where(inArray(calendarEventSuppressions.reason, [...DECISION_REASONS]))) {
    if (!archiveEvidence.has(s.workoutId)) archiveEvidence.set(s.workoutId, s.reason);
  }

  const healingBlocked = new Set<string>();
  for (const [workoutId, reason] of archiveEvidence) {
    const row = existingById.get(workoutId);
    // Not this user's row (the suppression table is not user-scoped) or gone
    // entirely: nothing to reason about, so nothing is unblocked.
    if (!row) {
      healingBlocked.add(workoutId);
      continue;
    }
    if (reason === "duplicate_mirror" && !liveTwinExists(row)) continue;
    healingBlocked.add(workoutId);
  }

  const pendingJobs = await db
    .select()
    .from(corosWriteJobs)
    .where(
      and(
        eq(corosWriteJobs.userId, input.userId),
        inArray(corosWriteJobs.status, ["queued", "claimed", "in_progress", "verifying"]),
      ),
    );
  const pendingJobByWorkout = new Map(pendingJobs.map((j) => [j.workoutId, j]));

  // Bulk-loaded once — never queried per row inside the loop below.
  const intentByWorkout = new Map(
    (await openMoveIntents(db, input.userId)).flatMap((i) => {
      const toDate = i.payload?.["toDate"];
      return typeof toDate === "string" ? [[i.targetId, { id: i.id, toDate }] as const] : [];
    }),
  );

  // Approved coach edits are the app's permanent claim on a session's
  // CONTENT (audit#3 D1): rule 7 and the recycled-slot rewrite must never
  // hand these rows back to the COROS snapshot. Content intents deliberately
  // never resolve — nothing on COROS can confirm them.
  const contentIntentIds = new Set(
    (
      await db
        .select({ targetId: syncIntents.targetId })
        .from(syncIntents)
        .where(
          and(
            eq(syncIntents.userId, input.userId),
            eq(syncIntents.kind, "content"),
            isNull(syncIntents.resolvedAt),
            isNull(syncIntents.supersededBy),
          ),
        )
    ).map((r) => r.targetId),
  );

  const seenSourceIds = new Set<string>();

  for (const src of admitted) {
    seenSourceIds.add(src.sourceWorkoutId);
    // The athlete-facing title for this wire workout: ours un-stamped, anyone
    // else's exactly as COROS serves it. Resolved before classification, so a
    // stamp can never influence how the session is filed either.
    const title = unstampTitle(src.title, ownProgramNames);
    const classification = classifyWorkout({
      title,
      sport: src.sport,
      stages: src.stages,
      plannedDurationSeconds: src.estimatedDurationSeconds,
      plannedDistanceMeters: src.estimatedDistanceMeters,
    });
    const category = src.isRestDay ? "rest" : classification.category;
    const estimate = estimateDuration({
      sourceEstimatedDurationSeconds: src.estimatedDurationSeconds,
      stages: src.stages,
      category,
      paceContext: { defaultPaceSecPerKm: 390 },
      bufferBeforeMinutes: prefs.bufferBeforeMinutes,
      bufferAfterMinutes: prefs.bufferAfterMinutes,
    });
    const stageSummary = src.stages.length > 0 ? summarizeStages(src.stages) : undefined;

    const claimants = existingByAddress.get(src.sourceWorkoutId) ?? [];
    if (claimants.length > 1) stats.contestedAddresses += 1;
    const current = resolveClaimant(claimants, {
      title,
      date: src.date,
      planId: planRowsBySourceId.get(src.sourcePlanId)!.id,
    });

    // A row whose CONTENT the app claims and COROS has not got is
    // `calendar_only`, whatever the DATES say (2026-08-17). `ease` writes
    // exactly that state, correctly, and every branch below that flipped it
    // back to `synced` on date agreement alone was writing a false statement
    // into the database eleven minutes later — the two sides agreeing about
    // WHEN is not the two sides agreeing about WHAT.
    const syncedUnlessClaimed = (): string =>
      current && contentIntentIds.has(current.id) ? "calendar_only" : "synced";

    // Recycled wire id: COROS reuses a plan's idInPlan slots after deletes,
    // so the same `${planId}:${idInPlan}` can suddenly mean a different
    // workout (live-observed: lifting creates landing in slots freed by
    // removed runs, which content-updated run rows into lifting titles while
    // keeping sport "run"). A sport flip is the tell — this is replacement,
    // not an edit. The row is rewritten in place as the new workout (the
    // unique index owns the slot); completed history is the one thing never
    // rewritten — those rows keep their story and the slot's new occupant
    // stays out of the app until the row ages out.
    if (
      current &&
      current.sport !== src.sport &&
      current.completionState === "completed"
    ) {
      stats.skippedForeignWorkouts += 1;
      continue;
    }
    if (current && current.sport !== src.sport && contentIntentIds.has(current.id)) {
      // Not a recycled slot: the coach's approved ease flipped this row's
      // sport locally. Same content claim as rule 7 — the app wins.
      stats.unchanged += 1;
      continue;
    }
    if (current && current.sport !== src.sport) {
      // The athlete's window. Whether this session can actually HAVE it — or
      // has to queue up behind what already occupies the day — is settled once
      // for the whole snapshot by `separateDayCollisions` below, which can see
      // the coach's rows as well as the wire's.
      const effectiveTime = windowTimeFor({ category, date: src.date }, prefs);
      await db
        .update(plannedWorkouts)
        .set({
          title,
          category,
          qualitySubtype: classification.qualitySubtype ?? null,
          sport: src.sport,
          originalPlanDate: src.date,
          lastVerifiedCorosDate: src.date,
          effectiveDate: src.date,
          effectiveTime,
          sourceProgramId: src.sourceProgramId ?? null,
          sourceContentFingerprint: src.contentFingerprint,
          sourceVersion: src.sourceVersion ?? null,
          sourceEstimatedDurationSeconds: src.estimatedDurationSeconds ?? null,
          fallbackEstimatedDurationSeconds:
            estimate.source === "coros_native" ? null : estimate.workoutSeconds,
          calendarBlockDurationSeconds: estimate.calendarSeconds,
          durationEstimate: estimate as unknown as Record<string, unknown>,
          expectedDistanceMeters: src.estimatedDistanceMeters ?? null,
          stageSummary: stageSummary ?? null,
          calendarSyncState:
            current.calendarSyncState === "user_deleted"
              ? "user_deleted"
              : category === "rest"
                ? "not_created"
                : "pending",
          corosSyncState: "synced",
          completionState: "scheduled",
          archivedAt: null,
          archiveReason: null,
          missingReads: 0,
          updatedAt: now,
        })
        .where(eq(plannedWorkouts.id, current.id));
      await replaceStages(db, current.id, src);
      stats.replacedRecycled += 1;
      continue;
    }

    if (!current) {
      // New workout from COROS.
      const id = newId();
      // The athlete's window. Whether this session can actually HAVE it — or
      // has to queue up behind what already occupies the day — is settled once
      // for the whole snapshot by `separateDayCollisions` below, which can see
      // the coach's rows as well as the wire's.
      const effectiveTime = windowTimeFor({ category, date: src.date }, prefs);
      await db.insert(plannedWorkouts).values({
        id,
        userId: input.userId,
        planId: planRowsBySourceId.get(src.sourcePlanId)!.id,
        sourceWorkoutId: src.sourceWorkoutId,
        sourceProgramId: src.sourceProgramId ?? null,
        sourceIdInPlan: src.sourceIdInPlan ?? null,
        title,
        category,
        qualitySubtype: classification.qualitySubtype ?? null,
        sport: src.sport,
        originalPlanDate: src.date,
        lastVerifiedCorosDate: src.date,
        effectiveDate: src.date,
        effectiveTime,
        sourceContentFingerprint: src.contentFingerprint,
        sourceVersion: src.sourceVersion ?? null,
        sourceEstimatedDurationSeconds: src.estimatedDurationSeconds ?? null,
        fallbackEstimatedDurationSeconds:
          estimate.source === "coros_native" ? null : estimate.workoutSeconds,
        calendarBlockDurationSeconds: estimate.calendarSeconds,
        durationEstimate: estimate as unknown as Record<string, unknown>,
        expectedDistanceMeters: src.estimatedDistanceMeters ?? null,
        stageSummary: stageSummary ?? null,
        calendarSyncState: category === "rest" ? "not_created" : "pending",
        // We just read this workout's date FROM COROS, so by construction the
        // two sides agree. `calendar_only` is reserved for a local date change
        // that couldn't be written back — never for freshly imported rows.
        corosSyncState: "synced",
        completionState: "scheduled",
        createdAt: now,
        updatedAt: now,
      });
      await replaceStages(db, id, src);
      stats.created += 1;
      continue;
    }

    // Completed history is immutable: when COROS reuses a slot for a NEW
    // same-sport workout (different date AND different content), rewriting a
    // completed row would silently turn last week's finished run into next
    // week's scheduled one while keeping its completion. Leave the history
    // alone; the recycled entity stays out of the app until the row ages out.
    if (
      current.completionState === "completed" &&
      src.date !== current.lastVerifiedCorosDate &&
      src.contentFingerprint !== current.sourceContentFingerprint
    ) {
      stats.skippedForeignWorkouts += 1;
      continue;
    }

    const updates: Record<string, unknown> = {};
    let touched = false;

    // Reset absence counter — it's present in this read.
    if (current.missingReads > 0) {
      updates.missingReads = 0;
      touched = true;
    }

    // Presence heals absence: a row archived by absence detection (or by the
    // old plan-switch rule) that COROS demonstrably still schedules comes
    // back, along with its calendar event. What may NOT come back is decided
    // above, by asking each archive reason what it still instructs — not by
    // reading the reason itself as a standing instruction.
    if (current.archivedAt && current.completionState === "scheduled" && !healingBlocked.has(current.id)) {
      updates.archivedAt = null;
      // Cleared together: an un-archived row carrying "why it left" is the
      // half-state that re-armed the belt and cost fifteen sessions.
      updates.archiveReason = null;
      updates.calendarSyncState = current.calendarSyncState === "user_deleted" ? "user_deleted" : "pending";
      stats.unarchived += 1;
      touched = true;
    }
    // Presence in the plan proves any removal-suppression wrong, whether or
    // not this snapshot is the one un-archiving the row (audit#2 #4: six
    // active future workouts — race week included — were barred from the
    // calendar by suppressions stranded when rows were unarchived earlier).
    // `duplicate_mirror` is in the list for the same reason: a mirror whose
    // keeper died can be the only copy left AND still carry the suppression
    // that hides its calendar event, when nothing released it.
    if (!healingBlocked.has(current.id)) {
      await db
        .delete(calendarEventSuppressions)
        .where(
          and(
            eq(calendarEventSuppressions.workoutId, current.id),
            inArray(calendarEventSuppressions.reason, ["workout_removed", "duplicate_mirror"]),
          ),
        );
    }

    const pendingJob = pendingJobByWorkout.get(current.id);
    const corosDate = src.date;

    const action = reconcileWorkout({
      workoutId: current.id,
      effectiveDate: current.effectiveDate,
      lastVerifiedCorosDate: current.lastVerifiedCorosDate,
      observedDate: corosDate,
      openIntent: intentByWorkout.get(current.id) ?? null,
      pendingJob: pendingJob
        ? { id: pendingJob.id, destinationDate: pendingJob.destinationDate }
        : null,
    });

    switch (action.act) {
      case "verify_job": {
        if (action.jobId) {
          await db
            .update(corosWriteJobs)
            .set({ status: "verified", verifiedAt: now, completedAt: now, updatedAt: now })
            .where(eq(corosWriteJobs.id, action.jobId));
        }
        if (action.intentId) await resolveIntent(db, action.intentId, now);
        updates.lastVerifiedCorosDate = corosDate;
        // The DATE landed. If the app also holds this session's content, the
        // row is still only on the calendar — see `syncedUnlessClaimed`.
        updates.corosSyncState = syncedUnlessClaimed();
        stats.verifiedJobs += 1;
        touched = true;
        break;
      }
      case "app_wins": {
        // Last-edit-wins, tie to the app (spec §2): the open intent is the
        // most recent thing the user did; COROS's displaced value becomes an
        // undo note, and emitPendingWork (run by the bridge/sync route right
        // after this import) re-derives the write against the new origin.
        updates.lastVerifiedCorosDate = corosDate;
        updates.corosSyncState = "calendar_only"; // until the re-emit lands
        if (action.supersedeJobId) {
          await db
            .update(corosWriteJobs)
            .set({ status: "superseded", updatedAt: now })
            .where(eq(corosWriteJobs.id, action.supersedeJobId));
        }
        await postSyncNote(db, {
          userId: input.userId,
          workoutId: current.id,
          kind: "kept_local_change",
          payload: { displacedDate: action.note.displacedDate, keptDate: action.keepDate },
        });
        stats.conflicts += 1;
        touched = true;
        break;
      }
      case "adopt_coros": {
        updates.lastVerifiedCorosDate = corosDate;
        updates.effectiveDate = corosDate;
        updates.originalPlanDate = current.originalPlanDate;
        updates.calendarSyncState =
          current.calendarSyncState === "user_deleted" ? "user_deleted" : "pending";
        updates.corosSyncState = syncedUnlessClaimed();
        if (current.completionState === "unresolved") updates.completionState = "scheduled";
        if (action.note) {
          await postSyncNote(db, {
            userId: input.userId,
            workoutId: current.id,
            kind: "adopted_coros_change",
            payload: { previousDate: action.note.previousDate, newDate: corosDate },
          });
        }
        stats.updatedDates += 1;
        touched = true;
        break;
      }
      case "none": {
        if (
          !pendingJob &&
          current.effectiveDate === corosDate &&
          (current.corosSyncState === "calendar_only" ||
            current.corosSyncState === "needs_attention" ||
            current.corosSyncState === "sync_issue")
        ) {
          const open = intentByWorkout.get(current.id);
          if (open && open.toDate === corosDate) await resolveIntent(db, open.id, now);
          // Healing: both sides provably agree about the DATE, so whatever
          // flagged this row's placement is over. It does NOT heal a row the
          // app holds the content of: the coach eased this session, `ease`
          // wrote `calendar_only` because COROS has the OLD body, and the very
          // next import used to overwrite that with "synced" — eleven minutes
          // later, on the athlete's real rows. Date agreement is not content
          // agreement, and the stored column has to stop saying otherwise.
          if (!contentIntentIds.has(current.id)) {
            updates.corosSyncState = "synced";
            touched = true;
          }
        }
        break;
      }
    }

    if (src.contentFingerprint !== current.sourceContentFingerprint && contentIntentIds.has(current.id)) {
      // Rule 7 exception (audit#3 D1): the coach eased this session and the
      // athlete approved — the app's content wins over the snapshot, every
      // snapshot, or the approval silently un-happens within one pull.
      stats.unchanged += 1;
    } else if (src.contentFingerprint !== current.sourceContentFingerprint) {
      // Rule 7: content changed upstream — update, preserve time of day.
      updates.title = title;
      updates.category = category;
      updates.qualitySubtype = classification.qualitySubtype ?? null;
      updates.sourceContentFingerprint = src.contentFingerprint;
      updates.sourceVersion = src.sourceVersion ?? null;
      updates.sourceEstimatedDurationSeconds = src.estimatedDurationSeconds ?? null;
      updates.fallbackEstimatedDurationSeconds =
        estimate.source === "coros_native" ? null : estimate.workoutSeconds;
      updates.calendarBlockDurationSeconds = estimate.calendarSeconds;
      updates.durationEstimate = estimate as unknown as Record<string, unknown>;
      updates.expectedDistanceMeters = src.estimatedDistanceMeters ?? null;
      updates.stageSummary = stageSummary ?? null;
      if (current.calendarSyncState === "synced") updates.calendarSyncState = "pending";
      await replaceStages(db, current.id, src);
      stats.updatedContent += 1;
      touched = true;
    } else if (
      stageSummary !== undefined &&
      current.stageSummary !== stageSummary &&
      !contentIntentIds.has(current.id)
    ) {
      // WORDING HEAL (2026-08-17). The fingerprints agree, so COROS is
      // serving the same workout this row already holds and the stored stage
      // rows are the ones this summary was built from — the only thing that
      // can have moved is how we WRITE it. Sub-minute stages used to round to
      // whole minutes, so every row imported before the fix says "4 × 0 min
      // Training / 1 min Rest" for a 15s-on/45s-off stride set, and would say
      // it forever: nothing else rewrites this column while a workout is
      // unchanged upstream. Today's card would then read "1 min" where the
      // sheet it opens reads "30s".
      //
      // Deliberately narrow. It writes one derived string and nothing else:
      // no dates, no state, no fingerprint, no `updatedContent`, so it can't
      // capture a plan version, post a sync note, or flip a calendar row to
      // pending. It is idempotent (second read: values equal, no write). And
      // it stands down when a `content` intent claims the row — that summary
      // was written by an approved coach edit from the session the athlete
      // said yes to, and re-deriving it from COROS's untouched snapshot is
      // exactly how audit#3 D1 silently reverted an ease.
      updates.stageSummary = stageSummary;
      stats.rewordedSummaries += 1;
      touched = true;
    }

    if (touched) {
      updates.updatedAt = now;
      await db.update(plannedWorkouts).set(updates).where(eq(plannedWorkouts.id, current.id));
    } else {
      stats.unchanged += 1;
    }
  }

  // ── Rule 8: workouts that disappeared upstream (double-read confirmation) ──
  for (const w of existing) {
    if (seenSourceIds.has(w.sourceWorkoutId)) continue;
    if (w.archivedAt) continue;
    if (w.completionState !== "scheduled") continue;
    // Provenance guard (audit#2 finding 1): a row COROS never verified —
    // coach/app-authored (sourceWorkoutId is its own row id) or one whose
    // create hasn't verified yet — can NEVER be "absent from COROS"; the
    // sweep was silently archiving coach-approved sessions within hours.
    if (w.sourceWorkoutId === w.id || w.lastVerifiedCorosDate === "") continue;
    if (w.lastVerifiedCorosDate < input.rangeStart || w.lastVerifiedCorosDate > input.rangeEnd) {
      continue; // outside this snapshot's window; absence proves nothing
    }
    const reads = w.missingReads + 1;
    if (reads >= 2) {
      await db
        .update(plannedWorkouts)
        .set({ archivedAt: now, missingReads: reads, updatedAt: now, archiveReason: "absence_confirmed" })
        .where(eq(plannedWorkouts.id, w.id));
      await db.insert(calendarEventSuppressions).values({
        id: newId(),
        workoutId: w.id,
        eventId: null,
        reason: "workout_removed",
        createdAt: now,
      });
      stats.archivedMissing += 1;
      // If this row had shadowed a mirror copy, release the mirror so the
      // next snapshot's presence-healing can take over seamlessly. It clears
      // the suppression only — the mirror's own `archive_reason` STAYS, because
      // it is the record of why that row left and remains true. What changed
      // (2026-08-17) is that the healing gate no longer reads that record as an
      // instruction, so this release can finally do what it always said it did.
      const partnerIds = existing
        .filter(
          (p) => p.id !== w.id && mirrorGroupKey(p, ownProgramNames) === mirrorGroupKey(w, ownProgramNames),
        )
        .map((p) => p.id);
      if (partnerIds.length > 0) {
        await db
          .delete(calendarEventSuppressions)
          .where(
            and(
              inArray(calendarEventSuppressions.workoutId, partnerIds),
              eq(calendarEventSuppressions.reason, "duplicate_mirror"),
            ),
          );
      }
    } else {
      await db
        .update(plannedWorkouts)
        .set({ missingReads: reads, updatedAt: now })
        .where(eq(plannedWorkouts.id, w.id));
    }
  }

  // ── Mirror de-duplication ──────────────────────────────────────────────────
  // COROS surfaces the applied plan twice: the plan definition AND its
  // materialized instances in a second plan (live-verified — the exact same
  // titles and dates under two plan ids). Whatever the wire says, the user
  // must see each session exactly once. Among active scheduled duplicates of
  // the same (date, title, sport), the oldest row keeps its history, links
  // and calendar event; newer copies are archived with a `duplicate_mirror`
  // suppression, which presence-healing respects until the keeper dies.
  const activeNow = await db
    .select()
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, input.userId), isNull(plannedWorkouts.archivedAt)));
  const byMirrorKey = new Map<string, typeof activeNow>();
  for (const w of activeNow) {
    // Same normalised key the healing gate uses, so the two can never disagree
    // about what one session is — the property the gate's safety rests on: a
    // mirror the gate wrongly frees is re-archived here, in the same import.
    const key = mirrorGroupKey(w, ownProgramNames);
    const list = byMirrorKey.get(key) ?? [];
    list.push(w);
    byMirrorKey.set(key, list);
  }
  // Resolution outranks scheduling: a completed/skipped/missed row is the
  // day's truth, and a scheduled mirror twin beside it is pure noise (it
  // would even re-ask "did this run happen?"). Among equals, oldest wins.
  const RESOLUTION_RANK: Record<string, number> = {
    completed: 0,
    skipped: 2,
    missed: 3,
    unresolved: 4,
    scheduled: 5,
  };
  for (const copies of byMirrorKey.values()) {
    if (copies.length < 2) continue;
    const sorted = [...copies].sort((a, b) => {
      const rank = (RESOLUTION_RANK[a.completionState] ?? 9) - (RESOLUTION_RANK[b.completionState] ?? 9);
      if (rank !== 0) return rank;
      return a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);
    });
    const keeper = sorted[0]!;
    // The keeper-holds-the-match probe is lazy: at most one query per group,
    // and only for the both-resolved exception below.
    let keeperHoldsMatch: boolean | null = null;
    for (const dup of sorted.slice(1)) {
      // Resolved rows carry history and are never dedupe casualties — with
      // one exception (audit#3 D3, live prod case 2026-07-29): a skipped or
      // missed twin beside a COMPLETED keeper that provably holds the day's
      // completion match is the same session double-materialized. The mirror
      // arrived after the first copy resolved, so the scheduled-only dedupe
      // could never clean it, and the day double-counts adherence forever.
      const scheduledCasualty =
        dup.completionState === "scheduled" || dup.completionState === "unresolved";
      const resolvedTwinOfCompletion =
        (dup.completionState === "skipped" || dup.completionState === "missed") &&
        keeper.completionState === "completed";
      if (!scheduledCasualty && !resolvedTwinOfCompletion) continue;
      if (resolvedTwinOfCompletion) {
        if (keeperHoldsMatch === null) {
          keeperHoldsMatch =
            (
              await db
                .select({ id: workoutCompletionMatches.id })
                .from(workoutCompletionMatches)
                .where(
                  and(
                    eq(workoutCompletionMatches.workoutId, keeper.id),
                    isNull(workoutCompletionMatches.undoneAt),
                  ),
                )
                .limit(1)
            ).length > 0;
        }
        if (!keeperHoldsMatch) continue;
      }
      await db
        .update(plannedWorkouts)
        .set({ archivedAt: now, updatedAt: now, archiveReason: "duplicate_mirror" })
        .where(eq(plannedWorkouts.id, dup.id));
      await db.insert(calendarEventSuppressions).values({
        id: newId(),
        workoutId: dup.id,
        eventId: null,
        reason: "duplicate_mirror",
        createdAt: now,
      });
      stats.dedupedMirrors += 1;
    }
  }

  // ── Placement: no two of a day's sessions at the same time ─────────────────
  // LAST, deliberately. By here every create, rewrite, adoption, un-archive and
  // dedupe has landed, so this is the only point in the import where the day is
  // whole — and the day includes the coach's own rows, which the wire loop above
  // never sees. `day-placement.ts` owns the rule; it touches a day only when
  // that day's calendar blocks actually collide, and re-derives the same times
  // from the same set, so it cannot churn the athlete's calendar hourly.
  const today = todayInZone(prefs.timezone);
  const windowDates: string[] = [];
  for (let d = input.rangeStart < today ? today : input.rangeStart; d <= input.rangeEnd; d = addDays(d, 1)) {
    windowDates.push(d);
  }
  stats.separatedTimes = (
    await separateDayCollisions(db, input.userId, windowDates, prefs, { from: today, now })
  ).length;

  // Plan version capture when the content fingerprint of the set changed.
  // Versions track the PRIMARY (top-level) plan — the one whose metadata the
  // merged response actually describes.
  const primaryPlanId = stats.planId;
  const versionCount = await db
    .select({ id: trainingPlanVersions.id })
    .from(trainingPlanVersions)
    .where(eq(trainingPlanVersions.planId, primaryPlanId));
  if (stats.created + stats.updatedContent + stats.archivedMissing > 0 || versionCount.length === 0) {
    await db.insert(trainingPlanVersions).values({
      id: newId(),
      planId: primaryPlanId,
      versionNum: versionCount.length + 1,
      capturedAt: now,
      contentFingerprint: `${input.plan.sourceVersion ?? ""}:${input.workouts.length}`,
      summary: {
        workouts: input.workouts.length,
        created: stats.created,
        updatedContent: stats.updatedContent,
        archived: stats.archivedMissing,
      },
    });
  }

  return stats;
}

async function replaceStages(db: Db, workoutId: string, src: SourcePlannedWorkout): Promise<void> {
  await db.delete(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, workoutId));
  if (src.stages.length === 0) return;
  const stageRows = src.stages.map((s) => ({
    id: `${workoutId}:${s.id}`,
    workoutId,
    parentStageId: s.parentStageId ? `${workoutId}:${s.parentStageId}` : null,
    ord: s.order,
    kind: s.kind,
    repeatCount: s.repeatCount ?? null,
    durationType: s.durationType,
    durationSeconds: s.durationSeconds ?? null,
    distanceMeters: s.distanceMeters ?? null,
    targetType: s.targetType ?? null,
    targetLow: s.targetLow ?? null,
    targetHigh: s.targetHigh ?? null,
    paceZone: s.paceZone ?? null,
    hrZone: s.hrZone ?? null,
    label: s.label ?? null,
    // ── THE STRENGTH PRESCRIPTION, PERSISTED (2026-08-17) ────────────────────
    //
    // The last link of a chain that was broken in three places at once: the push
    // path wrote a strength step's reps, load, rest and disclosure prose, the
    // normalizer discarded them, and there was nowhere to put them if it hadn't.
    // The athlete's Goblet Squat came home from the watch as a bare movement
    // name because of all three, and fixing two of them left the numbers
    // arriving here and going no further.
    //
    // `?? null` on each, and `null` means "the wire said nothing", never zero: a
    // step with no rest is COROS's own "skip rests", and a step with no load is
    // not a step loaded with nothing. `loadBodyweight` is its own column for
    // exactly that reason — bodyweight is `intensityCustom: 1` with the value
    // ABSENT, so it is unreachable from a nullable number.
    reps: s.reps ?? null,
    loadKg: s.loadKg ?? null,
    // One name, everywhere: `loadBodyweight` in `plannedStageSchema`, in
    // `NormalizedPlannedStage`, and in this column. It briefly had two — the
    // normalizer said `bodyweight` while the schema said `loadBodyweight` — and
    // reading only the schema's spelling compiled cleanly while dropping every
    // bodyweight step on the floor. That is the silent-loss shape this whole
    // pass exists to close, so it was renamed rather than bridged.
    loadBodyweight: s.loadBodyweight ?? null,
    restSeconds: s.restSeconds ?? null,
    note: s.note ?? null,
  }));
  await chunkedInsert(stageRows, 15, (batch) => db.insert(plannedWorkoutStages).values(batch));
}
