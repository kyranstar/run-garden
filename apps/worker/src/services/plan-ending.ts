import { sql, type SQL } from "drizzle-orm";
import { programs } from "@rg/database";
import {
  defaultOnEnd,
  planOnEndSchema,
  planPrompt,
  type LocalDate,
  type LineBlock,
  type PlanOnEnd,
  type PlanPrompt,
  type ProgramKind,
  type TrainingLine,
} from "@rg/domain";
import { lastPhaseOf } from "./coach-plans.js";

/**
 * WHEN A PLAN ENDS, AS THE WORKER READS IT (plans with a purpose §4). The rule itself is `planPrompt` (@rg/domain), and
 * everything that asks "is this plan ending?" goes through it: today's "needs you" chip, the plan's row in Your Plans
 * (`planSummaryOf`) and the coach's dormant `plan_ending` trigger. This file reads a plan's facts for it.
 *
 * A PLAN'S LAST DAY IS COMPUTED, NEVER STORED (`planLastDaySql`): the later of its running blocks' last day, its
 * outline weeks' last day (a week's Monday and six days) and its latest session filed under it, whichever of these it
 * has. A plan with a phase or an outline week still ahead is not ending. Coach plans' and COROS plans' dates aren't on
 * `programs`, so it reads the blocks, the weeks and the sessions; where-you-stand's "has it ended" reads the same
 * expression, so the two never disagree about a plan's end.
 */

/** A plan's last day, as one scalar subquery on the `programs` row in scope (named `programs`, undecorated). */
export function planLastDaySql(userId: string): SQL<string | null> {
  return sql<string | null>`(select max(d) from (
      select cp.end_date as d from coach_plans cp where cp.program_id = programs.id and cp.user_id = ${userId} and cp.status = 'active'
      union all
      select date(w.week_start, '+6 days') from coach_plan_weeks w join coach_plans cp on cp.id = w.plan_id
        where cp.program_id = programs.id and cp.user_id = ${userId} and cp.status = 'active' and w.state = 'shape'
      union all
      select pw.effective_date from planned_workouts pw where pw.plan_id = programs.id and pw.user_id = ${userId} and pw.archived_at is null))`;
}

/**
 * The columns of a block's plan (its `programs` row, left-joined on `coach_plans.program_id`) the rule reads, so a
 * read of the blocks answers it in the same statement.
 */
export const planFactColumns = (userId: string) => ({
  planKind: programs.kind,
  planOnEnd: programs.onEnd,
  planStatus: programs.status,
  planPausedUntil: programs.pausedUntil,
  planLastDay: planLastDaySql(userId),
});

/** What the rule needs of a plan, as a block's row carries it (all null with no plan row yet). */
export interface PlanFacts {
  kind: ProgramKind;
  onEnd: string | null;
  status: string;
  pausedUntil: string | null;
  lastDay: string | null;
}

/** The facts of a block's plan, from the columns `planFactColumns` adds; undefined while the block has no plan row. */
export function factsOf(row: { planKind: string | null; planOnEnd: string | null; planStatus: string | null; planPausedUntil: string | null; planLastDay: string | null }): PlanFacts | undefined {
  if (row.planKind === null || row.planStatus === null) return undefined;
  return { kind: row.planKind as ProgramKind, onEnd: row.planOnEnd, status: row.planStatus, pausedUntil: row.planPausedUntil, lastDay: row.planLastDay };
}

const DISCIPLINE_WORD = { run: "run", lift: "strength", mobility: "yoga" } as const;

/**
 * The line "Plan what comes after" is about (training lines §3.7) — the soonest to end, with its last phase and the
 * prompt the rule gives it. `facts`: each line's plan by the id its blocks carry (none for a line with no plan row yet:
 * its sport's own ending, running and nothing paused). A line's last day is the later of its last phase's end and the
 * plan's computed last day. Ties go to the line listed first.
 */
export function endingPlan(
  lines: readonly TrainingLine[],
  facts: ReadonlyMap<string, PlanFacts>,
  today: LocalDate,
): { line: TrainingLine; last: LineBlock; prompt: PlanPrompt; lastSessionDate: string } | undefined {
  let best: { line: TrainingLine; last: LineBlock; prompt: PlanPrompt; lastSessionDate: string } | undefined;
  for (const line of lines) {
    const f = line.programId ? facts.get(line.programId) : undefined;
    const lastSessionDate = f?.lastDay && f.lastDay > line.endDate ? f.lastDay : line.endDate;
    const stored = planOnEndSchema.safeParse(f?.onEnd);
    const onEnd: PlanOnEnd = stored.success ? stored.data : defaultOnEnd(f?.kind ?? "coach", [DISCIPLINE_WORD[line.discipline]]);
    const prompt = planPrompt(
      {
        kind: f?.kind ?? "coach",
        onEnd,
        status: f?.status === "retired" || f?.status === "archived" ? "retired" : "active",
        pausedUntil: f?.pausedUntil ?? null,
        name: line.name,
        discipline: line.discipline,
        lastSessionDate,
        hasDraft: false,
      },
      today,
    );
    if (!prompt) continue;
    if (!best || lastSessionDate < best.lastSessionDate) best = { line, last: lastPhaseOf(line), prompt, lastSessionDate };
  }
  return best;
}
