import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import {
  calendarEventSuppressions,
  coachPlanWeeks,
  coachPlans,
  corosWriteJobs,
  dailyHealth,
  plannedWorkoutStages,
  plannedWorkouts,
} from "@rg/database";
import {
  addDays,
  formatExerciseBlock,
  newId,
  nowInstant,
  paceBandFor,
  sessionExercises,
  sessionSport,
  todayInZone,
  type CoachOp,
  type CoachSession,
  type UserPreferences,
} from "@rg/domain";
import { chunkedInsert, type Db } from "./db.js";
import { applyMove } from "./jobs.js";
import { recordIntent } from "./sync-intents.js";
import { resolveRaceConflict } from "./race-conflict.js";

/**
 * Approval → deterministic mutations (spec §7). No LLM here, ever. All row
 * ids derive from the proposal id, so re-applying (crash, retry, double
 * click) is idempotent. Watch mirroring stays honest: rows the coach
 * creates/rewrites are `calendar_only` until a push lane verifies them
 * (writes-OFF era default; the push generalization rides Task A10+).
 */

export interface ApplyResult {
  created: string[];
  updated: string[];
  archived: string[];
}

function fingerprint(v: unknown): string {
  const s = JSON.stringify(v);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `coach-${(h >>> 0).toString(16)}`;
}

function stageSummary(s: CoachSession): string {
  if (s.run) {
    return s.run.blocks
      .map((b) => `${b.kind === "duration" ? `${b.value}min` : `${(b.value / 1000).toFixed(1)}km`}${b.intensity ? ` ${b.intensity}` : ""}`)
      .join(" · ");
  }
  // One formatter, shared with the session sheet (domain/coach.ts) — a hold
  // must never render as "Wall sit 3×undefined", which is what the old
  // `${e.sets}×${e.reps}` produced the moment reps became optional.
  const block = s.lift ?? s.mobility;
  if (block) return formatExerciseBlock(block);
  return s.title;
}

/** A session the create executor can put on the watch today: a run whose
 * blocks are all DURATION-based (distance targets are not spike-verified on
 * the wire — create-executor.ts refuses them).
 *
 * Lift and mobility sessions are app-only regardless of catalog resolution:
 * the coach create executor builds a structured RUN program and nothing
 * else (coros-write-cloud.ts → buildRunProgram). Resolving an exercise to a
 * catalog originId is what would MAKE a strength push possible later; it is
 * not what makes one happen today, and this predicate must not claim
 * otherwise. `offCatalogExercises` carries the per-exercise truth. */
export function watchPushable(session: CoachSession): boolean {
  return (
    !!session.run &&
    session.run.blocks.length > 0 &&
    session.run.blocks.every((b) => b.kind === "duration")
  );
}

/** `coach_plans.discipline` for the bucket a session belongs in. Mobility
 * gets its own bucket rather than stretching the running plan's dates —
 * `routes/coach.ts` only special-cases "lift", so a mobility plan reads as
 * a generic block (no lift progressions), which is the honest render. */
function planDisciplineOf(session: CoachSession): "run" | "lift" | "mobility" {
  if (session.lift) return "lift";
  if (session.mobility) return "mobility";
  return "run";
}

async function insertSession(
  db: Db,
  userId: string,
  planId: string,
  id: string,
  date: string,
  session: CoachSession,
  now: string,
  opts: { corosWritesEnabled?: boolean; prefs?: UserPreferences; thresholdPaceSecPerKm?: number } = {},
): Promise<void> {
  // Land in the athlete's own slot, not a hardcoded dawn (audit#2 #15).
  const window = session.category === "long" || session.category === "race" ? "morning" : (opts.prefs?.defaultWindow ?? "morning");
  const isWeekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const effectiveTime = opts.prefs
    ? window === "evening"
      ? opts.prefs.weekdayEveningTime
      : isWeekend
        ? opts.prefs.weekendMorningTime
        : opts.prefs.weekdayMorningTime
    : "07:00";
  await db
    .insert(plannedWorkouts)
    .values({
      id,
      userId,
      planId,
      sourceWorkoutId: id,
      title: session.title,
      category: session.category,
      sport: sessionSport(session),
      originalPlanDate: date,
      // "" = COROS has never verified this row (audit#2 #1): the absence
      // sweep must skip it and the sync pill must not read "synced". The
      // create's verify stamps the real date.
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      effectiveTime,
      sourceContentFingerprint: fingerprint(session),
      calendarBlockDurationSeconds: session.durationMinutes * 60,
      // The coach's own stated duration IS the estimate — without this every
      // consumer fell back to a fictitious 45 minutes (audit#2 #15).
      fallbackEstimatedDurationSeconds: session.durationMinutes * 60,
      stageSummary: stageSummary(session),
      // Lift/mobility structure survives apply (rework spec §5): the
      // exercises array is what lets plan-detail graph a coached
      // progression AND what tells the session sheet which movements the
      // watch's catalog doesn't know; the flattened stageSummary above
      // stays as the display string. `rounds` rides along so a circuit
      // still reads as a circuit after a round trip.
      structuredJson: session.lift ?? session.mobility
        ? {
            exercises: sessionExercises(session),
            ...((session.lift ?? session.mobility)!.rounds ? { rounds: (session.lift ?? session.mobility)!.rounds } : {}),
          }
        : null,
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // Structured stages so the app's session detail shows the prescription
  // (incl. pace bands) immediately — a later COROS re-import replaces these
  // with the wire's own truth, which matches because pace round-trips
  // exactly (2026-08-14).
  if (session.run) {
    const stageRows = session.run.blocks.map((b, i) => {
      const band = paceBandFor(b.intensity, opts.thresholdPaceSecPerKm);
      return {
        id: `${id}:${i}`,
        workoutId: id,
        parentStageId: null,
        ord: i,
        kind: i === 0 && session.run!.blocks.length >= 2 ? "warmup" : "work",
        repeatCount: null,
        durationType: b.kind === "duration" ? "time" : "distance",
        durationSeconds: b.kind === "duration" ? b.value * 60 : null,
        distanceMeters: b.kind === "distance" ? b.value : null,
        targetType: band ? "pace" : "none",
        targetLow: band?.fastSecPerKm ?? null,
        targetHigh: band?.slowSecPerKm ?? null,
        paceZone: null,
        hrZone: null,
        label: b.intensity ?? null,
      };
    });
    await db
      .delete(plannedWorkoutStages)
      .where(eq(plannedWorkoutStages.workoutId, id));
    await chunkedInsert(stageRows, 15, (batch) => db.insert(plannedWorkoutStages).values(batch));
  }

  // Coach adds reach the WATCH (user requirement 2026-08-12): duration-block
  // run sessions ride the same verified create pipeline as studio pushes.
  // The stored state stays calendar_only until the executor verifies; the
  // pending job already renders as "syncing" through deriveWorkoutSync.
  if (opts.corosWritesEnabled && watchPushable(session)) {
    await db
      .insert(corosWriteJobs)
      .values({
        id: `${id}-push`,
        userId,
        workoutId: id,
        kind: "coach_create_workout",
        expectedContentFingerprint: fingerprint(session),
        originalDate: date,
        destinationDate: date,
        // The name is the OWNERSHIP STAMP on COROS and must be unique per
        // plan — raw titles ("Long Run" ×6) refuse every create after the
        // first (audit#2 #7).
        payload: {
          workoutId: id,
          happenDay: date,
          name: `${session.title} — ${date}`,
          session,
          ...(opts.thresholdPaceSecPerKm ? { thresholdPaceSecPerKm: opts.thresholdPaceSecPerKm } : {}),
        },
        requestedAt: now,
        status: "queued",
        updatedAt: now,
      })
      // Re-applying an approve must be idempotent (audit#2 #13) — the
      // deterministic id makes skip-on-conflict exactly right.
      .onConflictDoNothing();
  }
}

/**
 * Archive aftermath (audit#3 D2): every coach-archived row needs the same
 * "user_removed" suppression a hand removal gets — import's presence-healing
 * keys on suppressions, and without one the next 90-day COROS read
 * un-archives the row right next to its replacement. Verified watch-pushed
 * sessions additionally get an unpush job so the watch stops scheduling the
 * retired plan (imported COROS-plan rows are never touched here — archiveWeek
 * and retirePlan operate on coach-authored plans only).
 */
async function suppressAndUnpush(
  db: Db,
  userId: string,
  rows: Array<typeof plannedWorkouts.$inferSelect>,
  now: string,
  prefs: UserPreferences,
): Promise<void> {
  for (const w of rows) {
    await db
      .insert(calendarEventSuppressions)
      .values({ id: newId(), workoutId: w.id, eventId: null, reason: "user_removed", createdAt: now });
    if (!prefs.corosWritesEnabled) continue;
    const wire = /^\d+:\d+$/.test(w.sourceWorkoutId ?? "");
    if (!wire || w.corosSyncState !== "synced" || !w.sourceIdInPlan || !w.sourceProgramId) continue;
    // The delete triple's stamp is the create payload's exact name — it was
    // never persisted on the row, so read it back off the verified push job.
    const [createJob] = await db
      .select()
      .from(corosWriteJobs)
      .where(eq(corosWriteJobs.id, `${w.id}-push`))
      .limit(1);
    const stamp = (createJob?.payload as { name?: string } | null)?.name;
    if (!stamp) continue;
    await db
      .insert(corosWriteJobs)
      .values({
        id: `${w.id}-unpush`,
        userId,
        workoutId: w.id,
        kind: "coach_delete_workout",
        expectedContentFingerprint: createJob?.expectedContentFingerprint ?? "",
        originalDate: w.effectiveDate,
        destinationDate: w.effectiveDate,
        payload: {
          workoutId: w.id,
          happenDay: w.lastVerifiedCorosDate || w.effectiveDate,
          name: stamp,
          idInPlan: w.sourceIdInPlan,
          programId: w.sourceProgramId,
          corosPlanId: w.sourceWorkoutId!.split(":")[0]!,
        },
        requestedAt: now,
        status: "queued",
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}

/** Archive this plan-week's unstarted sessions (calendar suppression; watch
 * unpush for verified coach-pushed rows — the documented remove contract for
 * imported plans never applies here because planId is coach-authored). */
async function archiveWeek(
  db: Db,
  userId: string,
  planId: string,
  weekStart: string,
  now: string,
  prefs: UserPreferences,
): Promise<string[]> {
  // An LLM-supplied planId must be a plan the coach authored: pointed at the
  // imported COROS plan's id this would bulk-archive imported rows.
  const [plan] = await db
    .select({ id: coachPlans.id })
    .from(coachPlans)
    .where(and(eq(coachPlans.id, planId), eq(coachPlans.userId, userId)))
    .limit(1);
  if (!plan) return [];
  const rows = await db
    .select()
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.planId, planId),
        gte(plannedWorkouts.effectiveDate, weekStart),
        lte(plannedWorkouts.effectiveDate, addDays(weekStart, 6)),
        eq(plannedWorkouts.completionState, "scheduled"),
        // Re-applying an approved proposal must be a no-op — already-archived
        // rows would otherwise collect a second suppression row.
        isNull(plannedWorkouts.archivedAt),
      ),
    );
  if (rows.length > 0) {
    await db
      .update(plannedWorkouts)
      .set({ archivedAt: now, archiveReason: "user_removed", updatedAt: now })
      .where(inArray(plannedWorkouts.id, rows.map((r) => r.id)));
    await suppressAndUnpush(db, userId, rows, now, prefs);
  }
  return rows.map((r) => r.id);
}

export async function applyOps(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  proposalId: string,
  ops: CoachOp[],
): Promise<ApplyResult> {
  const now = nowInstant();
  const today = todayInZone(prefs.timezone);
  // One read for the whole proposal: the athlete's latest COROS threshold
  // anchors every pace band this apply writes (2026-08-14).
  const [thresholdRow] = await db
    .select({ v: dailyHealth.thresholdPaceSecPerKm })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), isNotNull(dailyHealth.thresholdPaceSecPerKm)))
    .orderBy(desc(dailyHealth.date))
    .limit(1);
  const thresholdPaceSecPerKm = thresholdRow?.v ?? undefined;
  const out: ApplyResult = { created: [], updated: [], archived: [] };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const opId = (n: number | string) => `cw-${proposalId}-${i}-${n}`;
    switch (op.kind) {
      case "ease": {
        await db
          .update(plannedWorkouts)
          .set({
            title: op.session.title,
            category: op.session.category,
            sport: sessionSport(op.session),
            calendarBlockDurationSeconds: op.session.durationMinutes * 60,
            stageSummary: stageSummary(op.session),
            sourceContentFingerprint: fingerprint(op.session),
            corosSyncState: "calendar_only",
            updatedAt: now,
          })
          .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId)));
        // The approved edit is the app's permanent claim on this session's
        // content — without it, import rule 7 hands the row back to the
        // COROS snapshot within one pull (audit#3 D1).
        await recordIntent(db, {
          userId,
          targetKind: "workout",
          targetId: op.workoutId,
          kind: "content",
          payload: { fingerprint: fingerprint(op.session) },
          source: "coach_ease",
        });
        out.updated.push(op.workoutId);
        break;
      }
      case "move": {
        const [w] = await db
          .select()
          .from(plannedWorkouts)
          .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId)))
          .limit(1);
        if (w && w.effectiveDate !== op.toDate) {
          await applyMove(db, {
            userId,
            workoutId: op.workoutId,
            toDate: op.toDate,
            toTime: w.effectiveTime,
            source: "app",
            corosWritesEnabled: prefs.corosWritesEnabled ?? false,
          });
        }
        out.updated.push(op.workoutId);
        break;
      }
      case "swap": {
        const days = await db
          .select()
          .from(plannedWorkouts)
          .where(
            and(
              eq(plannedWorkouts.userId, userId),
              inArray(plannedWorkouts.effectiveDate, [op.dayA, op.dayB]),
              eq(plannedWorkouts.completionState, "scheduled"),
            ),
          );
        for (const w of days) {
          const target = w.effectiveDate === op.dayA ? op.dayB : op.dayA;
          await applyMove(db, {
            userId,
            workoutId: w.id,
            toDate: target,
            toTime: w.effectiveTime,
            source: "app",
            corosWritesEnabled: prefs.corosWritesEnabled ?? false,
          });
          out.updated.push(w.id);
        }
        break;
      }
      case "skip": {
        // Coach-sanctioned: the garden treats it as agreed rest (spec §1).
        await db
          .update(plannedWorkouts)
          .set({ completionState: "skipped", resolutionDate: today, sanctionedBy: "coach", updatedAt: now })
          .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId)));
        out.updated.push(op.workoutId);
        break;
      }
      case "add": {
        const planId =
          (await activeCoachPlanId(db, userId, op.session)) ??
          (await ensureAdhocPlan(db, userId, op.session, op.date, now));
        const id = opId(0);
        await insertSession(db, userId, planId, id, op.date, op.session, now, {
          corosWritesEnabled: prefs.corosWritesEnabled,
          prefs,
          thresholdPaceSecPerKm,
        });
        out.created.push(id);
        break;
      }
      case "reshapeWeek": {
        out.archived.push(...(await archiveWeek(db, userId, op.planId, op.weekStart, now, prefs)));
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, op.planId, id, s.date, s.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
            prefs,
            thresholdPaceSecPerKm,
          });
          out.created.push(id);
        }
        break;
      }
      case "firmUp": {
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, op.planId, id, s.date, s.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
            prefs,
            thresholdPaceSecPerKm,
          });
          out.created.push(id);
        }
        await db
          .insert(coachPlanWeeks)
          .values({ id: opId("wk"), planId: op.planId, weekStart: op.weekStart, state: "firm", shape: null })
          .onConflictDoUpdate({
            target: [coachPlanWeeks.planId, coachPlanWeeks.weekStart],
            set: { state: "firm", shape: null },
          });
        break;
      }
      case "extendPlan": {
        for (const wk of op.shapeWeeks) {
          await db
            .insert(coachPlanWeeks)
            .values({
              id: `cw-${proposalId}-${i}-${wk.weekStart}`,
              planId: op.planId,
              weekStart: wk.weekStart,
              state: "shape",
              shape: { volumeTarget: wk.volumeTarget, keySessions: wk.keySessions },
            })
            .onConflictDoNothing();
        }
        const lastEnd = addDays(op.shapeWeeks.map((w) => w.weekStart).sort().at(-1)!, 6);
        const [plan] = await db.select().from(coachPlans).where(eq(coachPlans.id, op.planId)).limit(1);
        if (plan && plan.endDate < lastEnd) {
          await db.update(coachPlans).set({ endDate: lastEnd, updatedAt: now }).where(eq(coachPlans.id, op.planId));
        }
        out.updated.push(op.planId);
        break;
      }
      case "windDown": {
        // Taper: clear the affected weeks' unstarted sessions, then insert
        // the gentler replacements.
        const mondays = [...new Set(op.sessions.map((s) => {
          const dow = (new Date(`${s.date}T12:00:00Z`).getUTCDay() + 6) % 7;
          return addDays(s.date, -dow);
        }))];
        for (const monday of mondays) {
          out.archived.push(...(await archiveWeek(db, userId, op.planId, monday, now, prefs)));
        }
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, op.planId, id, s.date, s.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
            prefs,
            thresholdPaceSecPerKm,
          });
          out.created.push(id);
        }
        break;
      }
      case "createPlan": {
        const planId = `cp-${proposalId}-${i}`;
        await db
          .insert(coachPlans)
          .values({
            id: planId,
            userId,
            discipline: op.discipline,
            name: op.name,
            status: "active",
            startDate: op.startDate,
            endDate: op.endDate,
            raceDate: op.raceDate ?? null,
            stampPrefix: op.name,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
        for (const [n, s] of op.firmSessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, planId, id, s.date, s.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
            prefs,
            thresholdPaceSecPerKm,
          });
          out.created.push(id);
        }
        for (const wk of op.shapeWeeks) {
          await db
            .insert(coachPlanWeeks)
            .values({
              id: `cw-${proposalId}-${i}-${wk.weekStart}`,
              planId,
              weekStart: wk.weekStart,
              state: "shape",
              shape: { volumeTarget: wk.volumeTarget, keySessions: wk.keySessions },
            })
            .onConflictDoNothing();
        }
        out.created.push(planId);
        break;
      }
      case "retirePlan": {
        // Same authorship guard as archiveWeek: retiring may only ever
        // target a coach-authored plan.
        const [plan] = await db
          .select({ id: coachPlans.id })
          .from(coachPlans)
          .where(and(eq(coachPlans.id, op.planId), eq(coachPlans.userId, userId)))
          .limit(1);
        if (!plan) break;
        const rows = await db
          .select()
          .from(plannedWorkouts)
          .where(
            and(
              eq(plannedWorkouts.userId, userId),
              eq(plannedWorkouts.planId, op.planId),
              gte(plannedWorkouts.effectiveDate, today),
              eq(plannedWorkouts.completionState, "scheduled"),
              isNull(plannedWorkouts.archivedAt),
            ),
          );
        if (rows.length > 0) {
          await db
            .update(plannedWorkouts)
            .set({ archivedAt: now, archiveReason: "user_removed", updatedAt: now })
            .where(inArray(plannedWorkouts.id, rows.map((r) => r.id)));
          await suppressAndUnpush(db, userId, rows, now, prefs);
          out.archived.push(...rows.map((r) => r.id));
        }
        await db
          .update(coachPlans)
          .set({ status: "retired", updatedAt: now })
          .where(and(eq(coachPlans.id, op.planId), eq(coachPlans.userId, userId)));
        out.updated.push(op.planId);
        break;
      }
      case "resolveRaceConflict": {
        const resolved = await resolveRaceConflict(db, userId, prefs, op.keep);
        // Approving a proposal after the banner button already converged the
        // dates is a clean no-op — resolveRaceConflict re-checks the data.
        if (resolved) out.updated.push(resolved.workoutId);
        break;
      }
    }
  }
  return out;
}

/**
 * A REAL plan row for coach adds that land outside any active plan — the old
 * phantom "coach-adhoc" id existed in no table and orphaned every join that
 * resolves plan name/status (audit#3 D8). One bucket per discipline per user;
 * its endDate stretches to cover whatever gets added.
 */
async function ensureAdhocPlan(
  db: Db,
  userId: string,
  session: CoachSession,
  date: string,
  now: string,
): Promise<string> {
  // Plan buckets follow the session's discipline, so a mobility one-off
  // never lands in (and stretches) the running plan.
  const discipline = planDisciplineOf(session);
  const id = `adhoc-${discipline}-${userId.slice(0, 8)}`;
  const [existing] = await db
    .select()
    .from(coachPlans)
    .where(and(eq(coachPlans.id, id), eq(coachPlans.userId, userId)))
    .limit(1);
  if (existing) {
    if (existing.endDate < date || existing.status !== "active") {
      await db
        .update(coachPlans)
        .set({ endDate: existing.endDate < date ? date : existing.endDate, status: "active", updatedAt: now })
        .where(eq(coachPlans.id, id));
    }
    return id;
  }
  await db
    .insert(coachPlans)
    .values({
      id,
      userId,
      discipline,
      name: "Coach one-offs",
      status: "active",
      startDate: date,
      endDate: date,
      stampPrefix: "Coach one-offs",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  return id;
}

/** The active coach plan matching the session's discipline, if any. */
async function activeCoachPlanId(
  db: Db,
  userId: string,
  session: CoachSession,
): Promise<string | null> {
  // Plan buckets follow the session's discipline, so a mobility one-off
  // never lands in (and stretches) the running plan.
  const discipline = planDisciplineOf(session);
  const [plan] = await db
    .select({ id: coachPlans.id })
    .from(coachPlans)
    .where(
      and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active"), eq(coachPlans.discipline, discipline)),
    )
    .limit(1);
  return plan?.id ?? null;
}
