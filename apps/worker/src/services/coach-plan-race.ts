import { and, eq, isNull } from "drizzle-orm";
import { coachPlans, plannedWorkouts } from "@rg/database";
import { dayLabel, isLocalDate, nowInstant } from "@rg/domain";
import { isLoosePlan } from "./coach-plans.js";
import type { Db } from "./db.js";

/**
 * A COACH PLAN'S RACE DAY CAN CHANGE (stream G, 2026-10-19). A race was cancelled, and the coach plan still named it:
 * the coach's "needs you" chip offered to get the athlete ready for race day, and the plan read as aiming at a race that
 * would not happen. Nothing in the app could change a coach plan's race — `/api/plan/race-conflict/resolve` settles
 * Settings' race day against a planned race row, never a plan's own race.
 *
 * `setCoachPlanRace` writes `coach_plans.race_date` and nothing of Settings. When the race is cleared or moved, the
 * plan's own race sessions still to come on the old day stop claiming to be the race: their category becomes
 * `quality`, as `resolveRaceConflict`'s keep-settings does — the hard session it is. Their title, days, and copies on
 * the watch and the calendar are as they were. The demotion is written before the plan, so a request cut off between
 * the two is finished by the next (the plan still names the old day); the same answer twice writes nothing.
 *
 * Statements: the plan's read, then the demotion (only with an old race) and the plan's write (only on a change).
 */
export type PlanRaceOutcome =
  | { kind: "ok"; raceDate: string | null; demoted: number }
  | { kind: "not_found" }
  | { kind: "bad_date"; why: string };

/** Said for anything that is not a day. */
export const NOT_A_DAY = "That isn't a day. Pick one from the calendar, or No race.";

export async function setCoachPlanRace(db: Db, userId: string, planId: string, raceDate: unknown): Promise<PlanRaceOutcome> {
  if (raceDate !== null && (typeof raceDate !== "string" || !isLocalDate(raceDate))) return { kind: "bad_date", why: NOT_A_DAY };
  const [plan] = await db
    .select({ id: coachPlans.id, startDate: coachPlans.startDate, raceDate: coachPlans.raceDate })
    .from(coachPlans)
    .where(and(eq(coachPlans.id, planId), eq(coachPlans.userId, userId)))
    .limit(1);
  // A bucket of one-offs is no plan: it has no span, and no race of its own.
  if (!plan || isLoosePlan(plan)) return { kind: "not_found" };
  if (raceDate !== null && raceDate < plan.startDate) {
    return { kind: "bad_date", why: `Race day can't be before the plan starts, ${dayLabel(plan.startDate)}.` };
  }
  if (plan.raceDate === raceDate) return { kind: "ok", raceDate, demoted: 0 };

  const now = nowInstant();
  const demoted = plan.raceDate
    ? await db
        .update(plannedWorkouts)
        .set({ category: "quality", updatedAt: now })
        .where(
          and(
            eq(plannedWorkouts.userId, userId),
            eq(plannedWorkouts.planId, plan.id),
            eq(plannedWorkouts.category, "race"),
            eq(plannedWorkouts.effectiveDate, plan.raceDate),
            eq(plannedWorkouts.completionState, "scheduled"),
            isNull(plannedWorkouts.archivedAt),
          ),
        )
        .returning({ id: plannedWorkouts.id })
    : [];
  await db
    .update(coachPlans)
    .set({ raceDate, updatedAt: now })
    .where(and(eq(coachPlans.id, plan.id), eq(coachPlans.userId, userId)));
  return { kind: "ok", raceDate, demoted: demoted.length };
}
