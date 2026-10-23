import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { coachPlans, plannedWorkouts } from "@rg/database";
import { nowInstant, type UserPreferences } from "@rg/domain";
import { savePreferences } from "./calendar-sync.js";
import { setCoachPlanRace } from "./coach-plan-race.js";
import type { Db } from "./db.js";

/**
 * Two race truths must never coexist silently (audit#2 #3) — and once
 * surfaced, they must be resolvable in one step (live-observed 2026-08-13:
 * the athlete told the coach the real date and the banner sat there anyway,
 * because neither the banner nor the coach could touch either datum).
 *
 * The conflict is singular by construction: the first live race-category row
 * (by its day) whose date disagrees with the athlete's stated race day — never
 * whichever race row the table happens to hold first, which could be one that
 * agrees and hide the one that doesn't (B6). Both resolution paths (brief
 * banner, coach op) converge the underlying data, so the banner can only
 * reappear for a genuinely new divergence.
 */

export interface RaceConflict {
  workoutId: string;
  plannedDate: string;
  title: string;
  raceDate: string;
}

/** The conflict and the plan its race row is filed under. */
async function conflictRow(db: Db, userId: string, prefs: UserPreferences): Promise<{ conflict: RaceConflict; planId: string } | null> {
  if (!prefs.raceDate) return null;
  const [row] = await db
    .select({
      id: plannedWorkouts.id,
      planId: plannedWorkouts.planId,
      date: plannedWorkouts.effectiveDate,
      title: plannedWorkouts.title,
    })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.category, "race"),
        isNull(plannedWorkouts.archivedAt),
        eq(plannedWorkouts.completionState, "scheduled"),
        ne(plannedWorkouts.effectiveDate, prefs.raceDate),
      ),
    )
    .orderBy(asc(plannedWorkouts.effectiveDate), asc(plannedWorkouts.id))
    .limit(1);
  return row
    ? { conflict: { workoutId: row.id, plannedDate: row.date, title: row.title, raceDate: prefs.raceDate }, planId: row.planId }
    : null;
}

export async function findRaceConflict(
  db: Db,
  userId: string,
  prefs: UserPreferences,
): Promise<RaceConflict | null> {
  return (await conflictRow(db, userId, prefs))?.conflict ?? null;
}

/**
 * keep "settings" — the athlete's stated day wins: the plan's mislabeled row
 * stays on the calendar as the hard session it is, it just stops claiming to
 * be the race; and a coach plan whose own race (`coach_plans.race_date`) is
 * that row's day follows the stated day — or names no race, when the stated
 * day is before the plan starts (`setCoachPlanRace`, B6). keep "plan" — the
 * plan was right: race day in Settings moves to the plan's date. Returns the
 * conflict that was resolved, or null if none existed (idempotent — a second
 * click or a stale coach op is a no-op).
 */
export async function resolveRaceConflict(
  db: Db,
  userId: string,
  prefs: UserPreferences,
  keep: "settings" | "plan",
): Promise<RaceConflict | null> {
  const found = await conflictRow(db, userId, prefs);
  if (!found) return null;
  const { conflict, planId } = found;
  if (keep === "settings") {
    await db
      .update(plannedWorkouts)
      .set({ category: "quality", updatedAt: nowInstant() })
      .where(and(eq(plannedWorkouts.id, conflict.workoutId), eq(plannedWorkouts.userId, userId)));
    const [plan] = await db
      .select({ startDate: coachPlans.startDate, raceDate: coachPlans.raceDate })
      .from(coachPlans)
      .where(and(eq(coachPlans.id, planId), eq(coachPlans.userId, userId)))
      .limit(1);
    if (plan && plan.raceDate === conflict.plannedDate) {
      await setCoachPlanRace(db, userId, planId, conflict.raceDate >= plan.startDate ? conflict.raceDate : null);
    }
  } else {
    await savePreferences(db, userId, { ...prefs, raceDate: conflict.plannedDate });
  }
  return conflict;
}
