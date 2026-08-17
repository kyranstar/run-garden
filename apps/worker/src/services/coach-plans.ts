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

/**
 * `ensureAdhocPlan` mints one bucket per discipline with this id prefix, to
 * hold coach sessions that land outside any block. The prefix is the writer's
 * own tag, so it identifies the two rows already in production without a
 * migration or any data repair.
 */
export const LOOSE_PLAN_ID_PREFIX = "adhoc-";

/**
 * A container for loose sessions is NOT a training block.
 *
 * A block has a planned duration: a start, an end someone chose, and
 * `coach_plan_weeks` rows describing each week of it. Everything the app says
 * about a block — "week 3 of 4", a progress bar, "your plan is ending", "block
 * complete — 92% adherence", the garden's coached-block credit — is a statement
 * about that duration. A bucket has none of it; it has CONTENTS. Its dates are
 * wherever its sessions happen to fall, so a bucket holding one session was
 * rendering as a one-week plan at 100% progress in week 1 of 1, was winning the
 * weekly brief's week counter from the real four-week block underneath it, and
 * was earning a "block complete" receipt (plus the garden's Keystone credit)
 * the morning after a single one-off.
 *
 * So every surface that speaks in durations asks this question first.
 */
export function isLoosePlan(plan: { id: string }): boolean {
  return plan.id.startsWith(LOOSE_PLAN_ID_PREFIX);
}

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

/** Coached BLOCKS whose final day was exactly `endDate` (any live status —
 * deterministic regardless of when the status-flip cron ran). Loose-session
 * buckets are excluded: a bucket's last date is where its last one-off
 * happened, not a finish line, and the garden's coached-block credit is for
 * finishing a block. */
export async function plansEndedOn(
  db: Db,
  userId: string,
  endDate: string,
): Promise<Array<{ id: string; name: string; startDate: string; endDate: string }>> {
  const rows = await db
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
  return rows.filter((p) => !isLoosePlan(p));
}
