/**
 * A STOPPED PLAN SAYS SO (plans with a purpose, ruling R31). The `programs` row is what the list shows and what Stop acts on,
 * but a coach plan is stopped a block at a time, or through the Studio's own route. So every path that stops one runs this in
 * the same batch as its own write: the plan's row goes `retired` once none of its blocks has anything left to run, that is
 * none that isn't retired and hasn't ended. Stopping one phase of a line still running matches no row, so the plan stays as
 * it is, and so does a call for a plan that's already stopped. Only a `coach` plan: a programme and a course write their own
 * status.
 *
 * It says nothing about whether anyone stopped the plan. That's the caller's to know: each path here is someone stopping it,
 * and the registry's backfill looks for that itself (its last-ending block retired), because a line that simply ran to its end
 * matches the same condition and isn't stopped.
 */
import { and, eq, sql } from "drizzle-orm";
import { programs } from "@rg/database";
import type { Db } from "./db.js";

export function planStoppedIfNoBlockLeft(
  db: Db,
  at: { userId: string; today: string; now: string },
  which: { block: string } | { plan: string } | { studioPlan: string },
) {
  const { userId, today, now } = at;
  const named =
    "block" in which
      ? sql`${programs.id} = (select b.program_id from coach_plans b where b.id = ${which.block} and b.user_id = ${userId})`
      : "plan" in which
        ? eq(programs.id, which.plan)
        : sql`json_valid(${programs.source}) and json_extract(${programs.source}, '$.studioPlanId') = ${which.studioPlan}`;
  return db
    .update(programs)
    .set({ status: "retired", updatedAt: now })
    .where(
      and(
        eq(programs.userId, userId),
        eq(programs.kind, "coach"),
        eq(programs.status, "active"),
        named,
        sql`not exists (select 1 from coach_plans o where o.program_id = ${programs.id} and o.user_id = ${userId} and o.status <> 'retired' and o.end_date >= ${today})`,
      ),
    );
}
