import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { coachPlans, plannedWorkouts } from "@rg/database";
import type { Db } from "./db.js";

/**
 * Block adherence (fairness spec §4): completed ÷ (completed + skipped +
 * missed) over the plan's non-rest workouts — with coach-sanctioned skips
 * EXCLUDED from the denominator, so mercy never tanks the block.
 * Deterministic from resolution rows; replay-stable.
 */
export const COACHED_BLOCK_ADHERENCE = 0.85;

export async function coachBlockAdherence(
  db: Db,
  userId: string,
  planId: string,
  startDate: string,
  endDate: string,
): Promise<number | null> {
  const rows = await db
    .select({
      state: plannedWorkouts.completionState,
      category: plannedWorkouts.category,
      sanctionedBy: plannedWorkouts.sanctionedBy,
    })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.planId, planId),
        gte(plannedWorkouts.effectiveDate, startDate),
        lte(plannedWorkouts.effectiveDate, endDate),
      ),
    );
  const resolved = rows.filter(
    (r) => r.category !== "rest" && ["completed", "skipped", "missed"].includes(r.state),
  );
  const denom = resolved.filter((r) => r.state === "completed" || r.sanctionedBy !== "coach");
  if (denom.length === 0) return null;
  const done = denom.filter((r) => r.state === "completed").length;
  return done / denom.length;
}

/** Coached plans whose final day was exactly `endDate` (any live status —
 * deterministic regardless of when the status-flip cron ran). */
export async function plansEndedOn(
  db: Db,
  userId: string,
  endDate: string,
): Promise<Array<{ id: string; name: string; startDate: string; endDate: string }>> {
  return db
    .select({
      id: coachPlans.id,
      name: coachPlans.name,
      startDate: coachPlans.startDate,
      endDate: coachPlans.endDate,
    })
    .from(coachPlans)
    .where(
      and(
        eq(coachPlans.userId, userId),
        eq(coachPlans.endDate, endDate),
        inArray(coachPlans.status, ["active", "completed"]),
      ),
    );
}
