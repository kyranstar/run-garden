import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  activities,
  coachMessages,
  coachPlans,
  coachPlanWeeks,
  coachReads,
  coachTriggers,
  dailyHealth,
  plannedWorkouts,
  sleepRecords,
} from "@rg/database";
import { addDays, newId, nowInstant, type LocalDate, type UserPreferences } from "@rg/domain";
import type { Db } from "./db.js";

/**
 * The coach's free layer (spec §1): six deterministic rules that MARK — a
 * fired trigger is a cheap row, never a thought. The next wake consumes all
 * pending rows in one LLM call. Dedupe: a kind stays quiet while an
 * unconsumed row exists, and for 72h after one was consumed.
 */

export type CoachTriggerKind =
  | "sleep_deficit"
  | "missed_workout"
  | "plan_horizon"
  | "plan_ending"
  | "race_proximity"
  | "comeback"
  | "notable_read";

const REFIRE_WINDOW_MS = 72 * 3600 * 1000;
const SLEEP_DEFICIT_HOURS = 6;
const HRV_Z_THRESHOLD = -1;
const FIRM_HORIZON_DAYS = 14;
const PLAN_ENDING_DAYS = 21;
const RACE_WINDOW_DAYS = 14;
const COMEBACK_GAP_DAYS = 7;

export interface PendingTrigger {
  id: string;
  kind: CoachTriggerKind;
  evidence: Record<string, unknown>;
  firedAt: string;
}

export async function pendingTriggers(db: Db, userId: string): Promise<PendingTrigger[]> {
  const rows = await db
    .select()
    .from(coachTriggers)
    .where(and(eq(coachTriggers.userId, userId), isNull(coachTriggers.consumedAt)));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as CoachTriggerKind,
    evidence: r.evidence,
    firedAt: r.firedAt,
  }));
}

export async function consumeTriggers(
  db: Db,
  userId: string,
  ids: string[],
  at: string,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(coachTriggers)
    .set({ consumedAt: at })
    .where(and(eq(coachTriggers.userId, userId), inArray(coachTriggers.id, ids)));
}

/** Kinds currently blocked by dedupe (unconsumed, or consumed <72h ago). */
async function blockedKinds(db: Db, userId: string, now: string): Promise<Set<string>> {
  const rows = await db
    .select({ kind: coachTriggers.kind, consumedAt: coachTriggers.consumedAt })
    .from(coachTriggers)
    .where(eq(coachTriggers.userId, userId));
  const cutoff = Date.parse(now) - REFIRE_WINDOW_MS;
  const blocked = new Set<string>();
  for (const r of rows) {
    if (r.consumedAt === null || Date.parse(r.consumedAt) > cutoff) blocked.add(r.kind);
  }
  return blocked;
}

export async function evaluateTriggers(
  db: Db,
  userId: string,
  _prefs: UserPreferences,
  today: LocalDate,
): Promise<CoachTriggerKind[]> {
  const now = nowInstant();
  const blocked = await blockedKinds(db, userId, now);
  const fired: Array<{ kind: CoachTriggerKind; evidence: Record<string, unknown> }> = [];

  // sleep_deficit — 3-night avg under 6h, or HRV 3d avg z < −1 vs 30d.
  if (!blocked.has("sleep_deficit")) {
    const nights = await db
      .select()
      .from(sleepRecords)
      .where(and(eq(sleepRecords.userId, userId), gte(sleepRecords.date, addDays(today, -3))))
      .orderBy(desc(sleepRecords.date))
      .limit(3);
    const avgH =
      nights.length === 3
        ? nights.reduce((a, n) => a + n.durationSeconds, 0) / 3 / 3600
        : null;
    let hrvZ: number | null = null;
    const hrvRows = await db
      .select({ date: dailyHealth.date, hrv: dailyHealth.hrv })
      .from(dailyHealth)
      .where(and(eq(dailyHealth.userId, userId), gte(dailyHealth.date, addDays(today, -30))));
    const hrvs = hrvRows.filter((r) => r.hrv != null).map((r) => r.hrv!) as number[];
    if (hrvs.length >= 10) {
      const mean = hrvs.reduce((a, b) => a + b, 0) / hrvs.length;
      const sd = Math.sqrt(hrvs.reduce((a, b) => a + (b - mean) ** 2, 0) / hrvs.length);
      const recent = hrvRows
        .filter((r) => r.hrv != null && r.date > addDays(today, -4))
        .map((r) => r.hrv!) as number[];
      if (sd > 0 && recent.length >= 2) {
        hrvZ = (recent.reduce((a, b) => a + b, 0) / recent.length - mean) / sd;
      }
    }
    if ((avgH !== null && avgH < SLEEP_DEFICIT_HOURS) || (hrvZ !== null && hrvZ < HRV_Z_THRESHOLD)) {
      fired.push({
        kind: "sleep_deficit",
        evidence: { avgSleepH: avgH === null ? null : Math.round(avgH * 10) / 10, hrvZ },
      });
    }
  }

  // missed_workout — a skip/missed resolution in the last 3 days.
  if (!blocked.has("missed_workout")) {
    const rows = await db
      .select({
        id: plannedWorkouts.id,
        title: plannedWorkouts.title,
        state: plannedWorkouts.completionState,
        date: plannedWorkouts.effectiveDate,
        resolutionDate: plannedWorkouts.resolutionDate,
      })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          inArray(plannedWorkouts.completionState, ["skipped", "missed"]),
          gte(plannedWorkouts.effectiveDate, addDays(today, -3)),
        ),
      );
    if (rows.length > 0) {
      fired.push({
        kind: "missed_workout",
        evidence: { workouts: rows.map((r) => ({ id: r.id, title: r.title, state: r.state, date: r.date })) },
      });
    }
  }

  const plans = await db
    .select()
    .from(coachPlans)
    .where(and(eq(coachPlans.userId, userId), eq(coachPlans.status, "active")));

  // plan_horizon — firm detail runs out inside 14 days while shape weeks wait.
  if (!blocked.has("plan_horizon")) {
    for (const plan of plans) {
      const weeks = await db
        .select()
        .from(coachPlanWeeks)
        .where(eq(coachPlanWeeks.planId, plan.id));
      const firmEnds = weeks.filter((w) => w.state === "firm").map((w) => addDays(w.weekStart, 6));
      const hasShape = weeks.some((w) => w.state === "shape");
      const firmEnd = firmEnds.sort().at(-1);
      if (hasShape && firmEnd !== undefined && firmEnd < addDays(today, FIRM_HORIZON_DAYS)) {
        fired.push({
          kind: "plan_horizon",
          evidence: { planId: plan.id, name: plan.name, firmDetailEnds: firmEnd },
        });
        break;
      }
    }
  }

  // plan_ending — an active plan ends within 21 days.
  if (!blocked.has("plan_ending")) {
    const ending = plans.find((p) => p.endDate <= addDays(today, PLAN_ENDING_DAYS));
    if (ending) {
      fired.push({
        kind: "plan_ending",
        evidence: { planId: ending.id, name: ending.name, endDate: ending.endDate },
      });
    }
  }

  // race_proximity — a race inside 14 days.
  if (!blocked.has("race_proximity")) {
    const racing = plans.find(
      (p) => p.raceDate && p.raceDate >= today && p.raceDate <= addDays(today, RACE_WINDOW_DAYS),
    );
    if (racing) {
      fired.push({
        kind: "race_proximity",
        evidence: { planId: racing.id, raceDate: racing.raceDate },
      });
    }
  }

  // comeback — most recent activity is fresh AND follows a ≥7 day gap.
  if (!blocked.has("comeback")) {
    const recent = await db
      .select({ startTimeLocal: activities.startTimeLocal, startTime: activities.startTime })
      .from(activities)
      .where(and(eq(activities.userId, userId), lte(activities.startTime, `${addDays(today, 1)}T00:00:00Z`)))
      .orderBy(desc(activities.startTime))
      .limit(2);
    if (recent.length === 2) {
      const d1 = (recent[0]!.startTimeLocal ?? recent[0]!.startTime).slice(0, 10);
      const d2 = (recent[1]!.startTimeLocal ?? recent[1]!.startTime).slice(0, 10);
      const gapDays = Math.round((Date.parse(d1) - Date.parse(d2)) / 86_400_000);
      if (d1 >= addDays(today, -2) && gapDays >= COMEBACK_GAP_DAYS) {
        fired.push({ kind: "comeback", evidence: { lastActive: d2, backOn: d1, gapDays } });
      }
    }
  }

  // notable_read — a flagged ambient read the athlete hasn't been briefed on
  // (rework spec §3). This is what closes the perception→briefing loop with
  // zero user intervention: the read marks, the mark wakes, the wake speaks.
  if (!blocked.has("notable_read")) {
    const reads = await db
      .select()
      .from(coachReads)
      .where(and(eq(coachReads.userId, userId), eq(coachReads.status, "done")));
    const [lastBriefing] = await db
      .select()
      .from(coachMessages)
      .where(
        and(
          eq(coachMessages.userId, userId),
          eq(coachMessages.role, "coach"),
          sql`json_extract(${coachMessages.refs}, '$.kind') IS NULL`,
        ),
      )
      .orderBy(desc(coachMessages.at))
      .limit(1);
    const since = lastBriefing?.at ?? "";
    const notable = reads.find((r) => (r.completedAt ?? "") > since && r.flags.length > 0);
    if (notable) {
      fired.push({
        kind: "notable_read",
        evidence: { activityId: notable.activityId, glance: notable.glance, flags: notable.flags },
      });
    }
  }

  if (fired.length > 0) {
    await db.insert(coachTriggers).values(
      fired.map((f) => ({
        id: newId(),
        userId,
        kind: f.kind,
        evidence: f.evidence,
        firedAt: now,
      })),
    );
  }
  return fired.map((f) => f.kind);
}
