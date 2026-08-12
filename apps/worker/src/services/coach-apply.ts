import { and, eq, gte, inArray, lte } from "drizzle-orm";
import {
  coachPlanWeeks,
  coachPlans,
  corosWriteJobs,
  plannedWorkouts,
} from "@rg/database";
import {
  addDays,
  nowInstant,
  todayInZone,
  type CoachOp,
  type CoachSession,
  type UserPreferences,
} from "@rg/domain";
import type { Db } from "./db.js";
import { applyMove } from "./jobs.js";

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
  if (s.lift) {
    return s.lift.exercises.map((e) => `${e.name} ${e.sets}×${e.reps}`).join(" · ");
  }
  return s.title;
}

/** A session the create executor can put on the watch today: a run whose
 * blocks are all DURATION-based (distance targets are not spike-verified on
 * the wire — create-executor.ts refuses them). */
export function watchPushable(session: CoachSession): boolean {
  return (
    !!session.run &&
    session.run.blocks.length > 0 &&
    session.run.blocks.every((b) => b.kind === "duration")
  );
}

async function insertSession(
  db: Db,
  userId: string,
  planId: string,
  id: string,
  date: string,
  session: CoachSession,
  now: string,
  opts: { corosWritesEnabled?: boolean } = {},
): Promise<void> {
  await db
    .insert(plannedWorkouts)
    .values({
      id,
      userId,
      planId,
      sourceWorkoutId: id,
      title: session.title,
      category: session.category,
      sport: session.lift ? "strength" : "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      sourceContentFingerprint: fingerprint(session),
      calendarBlockDurationSeconds: session.durationMinutes * 60,
      stageSummary: stageSummary(session),
      // Lift structure survives apply (rework spec §5): the exercises array
      // is what lets plan-detail graph a coached progression; the flattened
      // stageSummary above stays as the display string.
      structuredJson: session.lift ? { exercises: session.lift.exercises } : null,
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // Coach adds reach the WATCH (user requirement 2026-08-12): duration-block
  // run sessions ride the same verified create pipeline as studio pushes.
  // The stored state stays calendar_only until the executor verifies; the
  // pending job already renders as "syncing" through deriveWorkoutSync.
  if (opts.corosWritesEnabled && watchPushable(session)) {
    await db.insert(corosWriteJobs).values({
      id: `${id}-push`,
      userId,
      workoutId: id,
      kind: "coach_create_workout",
      expectedContentFingerprint: fingerprint(session),
      originalDate: date,
      destinationDate: date,
      payload: { workoutId: id, happenDay: date, name: session.title, session },
      requestedAt: now,
      status: "queued",
      updatedAt: now,
    });
  }
}

/** Archive this plan-week's unstarted sessions (calendar suppression only —
 * COROS untouched, the documented remove contract). */
async function archiveWeek(
  db: Db,
  userId: string,
  planId: string,
  weekStart: string,
  now: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: plannedWorkouts.id })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.planId, planId),
        gte(plannedWorkouts.effectiveDate, weekStart),
        lte(plannedWorkouts.effectiveDate, addDays(weekStart, 6)),
        eq(plannedWorkouts.completionState, "scheduled"),
      ),
    );
  if (rows.length > 0) {
    await db
      .update(plannedWorkouts)
      .set({ archivedAt: now, archiveReason: "user_removed", updatedAt: now })
      .where(inArray(plannedWorkouts.id, rows.map((r) => r.id)));
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
            sport: op.session.lift ? "strength" : "run",
            calendarBlockDurationSeconds: op.session.durationMinutes * 60,
            stageSummary: stageSummary(op.session),
            sourceContentFingerprint: fingerprint(op.session),
            corosSyncState: "calendar_only",
            updatedAt: now,
          })
          .where(and(eq(plannedWorkouts.id, op.workoutId), eq(plannedWorkouts.userId, userId)));
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
        const planId = (await activeCoachPlanId(db, userId, op.session)) ?? "coach-adhoc";
        const id = opId(0);
        await insertSession(db, userId, planId, id, op.date, op.session, now, {
          corosWritesEnabled: prefs.corosWritesEnabled,
        });
        out.created.push(id);
        break;
      }
      case "reshapeWeek": {
        out.archived.push(...(await archiveWeek(db, userId, op.planId, op.weekStart, now)));
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, op.planId, id, s.date, s.session, now, {
            corosWritesEnabled: prefs.corosWritesEnabled,
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
          out.archived.push(...(await archiveWeek(db, userId, op.planId, monday, now)));
        }
        for (const [n, s] of op.sessions.entries()) {
          const id = opId(n);
          await insertSession(db, userId, op.planId, id, s.date, s.session, now);
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
          await insertSession(db, userId, planId, id, s.date, s.session, now);
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
        const rows = await db
          .select({ id: plannedWorkouts.id })
          .from(plannedWorkouts)
          .where(
            and(
              eq(plannedWorkouts.userId, userId),
              eq(plannedWorkouts.planId, op.planId),
              gte(plannedWorkouts.effectiveDate, today),
              eq(plannedWorkouts.completionState, "scheduled"),
            ),
          );
        if (rows.length > 0) {
          await db
            .update(plannedWorkouts)
            .set({ archivedAt: now, archiveReason: "user_removed", updatedAt: now })
            .where(inArray(plannedWorkouts.id, rows.map((r) => r.id)));
          out.archived.push(...rows.map((r) => r.id));
        }
        await db
          .update(coachPlans)
          .set({ status: "retired", updatedAt: now })
          .where(and(eq(coachPlans.id, op.planId), eq(coachPlans.userId, userId)));
        out.updated.push(op.planId);
        break;
      }
    }
  }
  return out;
}

/** The active coach plan matching the session's discipline, if any. */
async function activeCoachPlanId(
  db: Db,
  userId: string,
  session: CoachSession,
): Promise<string | null> {
  const discipline = session.lift ? "lift" : "run";
  const [plan] = await db
    .select({ id: coachPlans.id })
    .from(coachPlans)
    .where(
      and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active"), eq(coachPlans.discipline, discipline)),
    )
    .limit(1);
  return plan?.id ?? null;
}
