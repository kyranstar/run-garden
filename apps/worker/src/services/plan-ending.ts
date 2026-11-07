import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { programs } from "@rg/database";
import { PLAN_PROMPT_KINDS, type LocalDate, type PlanPrompt, type ProgramKind, type TrainingLine } from "@rg/domain";
import type { Db } from "./db.js";
import { lastPhaseOf } from "./coach-plans.js";
import { DISCIPLINE_WORD, plansSuperseded, promptOfPlan, type PlanEndingRow } from "./plan-summaries.js";

/**
 * WHEN A PLAN ENDS, AS THE WORKER READS IT (plans with a purpose §4). The rule is `planPrompt` (@rg/domain), and the one
 * reading of a plan for it is `promptOfPlan` (plan-summaries.ts): the "needs you" chip, the plan's row in Your Plans and the
 * coach's dormant `plan_ending` trigger all go through it, so a plan's words and its end are the same everywhere. This file
 * reads the plans for it.
 *
 * A PLAN'S LAST DAY IS COMPUTED, NEVER STORED (`planLastDaySql`). While the plan is live it is the latest of: its running
 * blocks' last day; an outline week that begins after its block's end (one inside the block reaches no further than the
 * block); and a live session — scheduled or unresolved, not archived — filed under the plan or under one of its blocks
 * (spec §3.2: a coach session is filed under its block). A skipped, missed or finished session never holds a plan open. A
 * plan with a phase, an outline week or a live session still ahead is not ending. Once nothing live remains the plan has
 * run out, and "ended" means a date already past (R49): its last day is the latest of its non-stopped blocks' end and its
 * non-skipped, non-archived sessions' date, each up to today, so nothing ahead can make an ended plan read as running. A
 * coach or COROS plan with nothing to read at all is ended too (null), never running for ever; a programme and a course
 * have no end. So "has it ended" (where-you-stand), "is it ending" (the prompt) and "how long ago" (the prompt's run-out
 * words) read one expression. Every read of the sessions is pinned to `(user_id, plan_id)` (`PW`), so it costs the plan's
 * own sessions and never the athlete's lifetime of them.
 *
 * A run-out plan that a running plan of its sport has followed (a later last day) stops asking, on the chip and the row
 * (`plansSuperseded`), as a phase placed after it would have.
 */

/**
 * The sessions, always read by the plan they're filed under. `indexed by` pins the planner to `(user_id, plan_id)`: left to
 * choose, it walked the athlete's whole history through the state index (20 ms at 1k sessions, 100 ms at 16k, against under
 * 0.4 ms), and the repo never runs ANALYZE to teach it better. The unary plus keeps the other terms from tempting it. A
 * test explains the expression and fails on any other index.
 */
const PW = sql.raw("planned_workouts pw indexed by planned_workouts_source_unique");

/**
 * A plan's last day, as one scalar subquery on the `programs` row in scope (named `programs`, undecorated); `today` is the
 * athlete's local date. Null: nothing to read, which reads as ended.
 *
 * LIVE: the latest of the running blocks' end, the end of an outline week that begins after its block's end, and a live
 * session (scheduled or unresolved, not archived) under the plan or under its non-stopped blocks.
 * RUN OUT, once nothing live remains (R49: "ended" means a date already past): the latest of the non-stopped blocks' end
 * and the non-skipped, non-archived sessions' date, each up to today. Nothing ahead can make an ended plan read as running.
 */
export function planLastDaySql(today: string): SQL<string | null> {
  return sql<string | null>`coalesce(
    (select max(d) from (
      select cp.end_date as d from coach_plans cp where cp.program_id = programs.id and cp.user_id = programs.user_id and cp.status = 'active'
      union all
      select date(w.week_start, '+6 days') from coach_plan_weeks w join coach_plans cp on cp.id = w.plan_id
        where cp.program_id = programs.id and cp.user_id = programs.user_id and cp.status = 'active' and w.state = 'shape' and w.week_start > cp.end_date
      union all
      select pw.effective_date from ${PW}
        where pw.user_id = programs.user_id and pw.plan_id = programs.id and +pw.archived_at is null and +pw.completion_state in ('scheduled', 'unresolved')
      union all
      select pw.effective_date from coach_plans cp cross join ${PW} on pw.user_id = cp.user_id and pw.plan_id = cp.id
        where cp.program_id = programs.id and cp.user_id = programs.user_id and cp.status <> 'retired' and +pw.archived_at is null and +pw.completion_state in ('scheduled', 'unresolved'))),
    (select max(d) from (
      select cp.end_date as d from coach_plans cp where cp.program_id = programs.id and cp.user_id = programs.user_id and cp.status <> 'retired' and cp.end_date <= ${today}
      union all
      select pw.effective_date from ${PW}
        where pw.user_id = programs.user_id and pw.plan_id = programs.id and +pw.archived_at is null and +pw.completion_state <> 'skipped' and +pw.effective_date <= ${today}
      union all
      select pw.effective_date from coach_plans cp cross join ${PW} on pw.user_id = cp.user_id and pw.plan_id = cp.id
        where cp.program_id = programs.id and cp.user_id = programs.user_id and cp.status <> 'retired' and +pw.archived_at is null and +pw.completion_state <> 'skipped' and +pw.effective_date <= ${today})))`;
}

/** The kinds that can ask, as an SQL list (`'coach', 'coros_import'`): named once, in @rg/domain. */
export const PROMPT_KIND_LIST = sql.raw(PLAN_PROMPT_KINDS.map((k) => `'${k}'`).join(", "));

/** The disciplines of a plan's blocks that aren't stopped, as one text ("run,lift") in a scalar subquery on `programs`. */
export const blockDisciplinesSql = (): SQL<string | null> =>
  sql<string | null>`(select group_concat(distinct cp.discipline) from coach_plans cp where cp.program_id = programs.id and cp.user_id = programs.user_id and cp.status <> 'retired')`;

/** A plan with the block that ends it, as the chip names it (`ending:<block>`) and the trigger's evidence does. */
export interface PlanEnding extends PlanEndingRow {
  lastBlockId: string | null;
  lastBlockName: string | null;
}

/**
 * The account's plans that can ask — a coach plan or a COROS plan, running or stopped (a stopped one is read so its blocks
 * are not taken for a plan with no row), as of the athlete's `today` — in one statement, each with its computed last day (running ones only). The
 * chip and the trigger read it; the plans list reads the same columns with its own rows.
 */
export async function readPlanEndings(db: Db, userId: string, today: string): Promise<PlanEnding[]> {
  const rows = await db
    .select({
      id: programs.id,
      kind: programs.kind,
      name: programs.name,
      status: programs.status,
      onEnd: programs.onEnd,
      pausedUntil: programs.pausedUntil,
      disciplines: programs.disciplines,
      blockDisciplines: blockDisciplinesSql(),
      lastDay: sql<string | null>`case when programs.status = 'active' then ${planLastDaySql(today)} end`,
      lastBlockId: sql<string | null>`(select cp.id from coach_plans cp where cp.program_id = programs.id and cp.user_id = programs.user_id and cp.status <> 'retired' order by cp.end_date desc, cp.start_date desc, cp.id desc limit 1)`,
      lastBlockName: sql<string | null>`(select cp.name from coach_plans cp where cp.program_id = programs.id and cp.user_id = programs.user_id and cp.status <> 'retired' order by cp.end_date desc, cp.start_date desc, cp.id desc limit 1)`,
    })
    .from(programs)
    .where(and(eq(programs.userId, userId), inArray(programs.kind, [...PLAN_PROMPT_KINDS]), sql`${programs.archivedAt} is null`, inArray(programs.status, ["active", "retired"])));
  return rows.map((r) => ({ ...r, kind: r.kind as ProgramKind, blockDisciplines: r.blockDisciplines ? r.blockDisciplines.split(",") : [] }));
}

/** A training line with no plan row (not backfilled) as a plan: a running one that ends by its sport's own default. */
function lineAsPlan(line: TrainingLine): PlanEnding {
  const last = lastPhaseOf(line);
  return {
    id: line.key,
    kind: "coach",
    name: line.name,
    status: "active",
    onEnd: null,
    pausedUntil: null,
    disciplines: [DISCIPLINE_WORD[line.discipline]],
    blockDisciplines: [line.discipline],
    lastDay: line.endDate,
    lastBlockId: last.id,
    lastBlockName: last.name,
  };
}

export interface EndingChoice {
  plan: PlanEnding;
  prompt: PlanPrompt;
  /** The block the chip is keyed by, else the plan. */
  keyId: string;
}

/**
 * The plan "Plan what comes after" is about: of the plans the rule gives a question, the one to end soonest, today or
 * later; else the one that ran out most recently. `plans`: `readPlanEndings`; `lines`: the training lines of the active
 * blocks, of which those with no plan row (or one this account didn't read) stand in as plans of their own.
 * `ranOut: false` leaves the plans that have run out to the chip and the row: the trigger wakes the coach only for one
 * that is about to end.
 */
export function endingPlan(plans: readonly PlanEnding[], lines: readonly TrainingLine[], today: LocalDate, opts: { ranOut?: boolean } = {}): EndingChoice | undefined {
  const known = new Set(plans.map((p) => p.id));
  const all = [...plans, ...lines.filter((l) => !l.programId || !known.has(l.programId)).map(lineAsPlan)];
  const superseded = plansSuperseded(all, today);
  let best: EndingChoice | undefined;
  for (const plan of all) {
    const prompt = promptOfPlan(plan, today, superseded);
    if (prompt?.kind !== "whats_next" || plan.lastDay === null) continue;
    if (plan.lastDay < today && opts.ranOut === false) continue;
    const candidate = { plan, prompt, keyId: plan.lastBlockId ?? plan.id };
    if (!best || before(candidate.plan.lastDay!, best.plan.lastDay!, today)) best = candidate;
  }
  return best;
}

/** Whether a plan ending on `a` comes before one ending on `b`: those still to end by their date, then those run out, latest first. */
function before(a: string, b: string, today: string): boolean {
  const aAhead = a >= today;
  const bAhead = b >= today;
  if (aAhead !== bAhead) return aAhead;
  return aAhead ? a < b : a > b;
}
