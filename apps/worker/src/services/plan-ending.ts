import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { programs } from "@rg/database";
import { PLAN_PROMPT_KINDS, type LocalDate, type PlanPrompt, type ProgramKind, type TrainingLine } from "@rg/domain";
import type { Db } from "./db.js";
import { lastPhaseOf } from "./coach-plans.js";
import { DISCIPLINE_WORD, draftFactsOf, plansSuperseded, promptOfPlan, type PlanEndingRow } from "./plan-summaries.js";

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
 *
 * WITH DRAFTS ON (plans with a purpose §4.2; plan-drafts.ts) the same statement reads, for each coach plan, what the hourly
 * draft has made of its endings (`planDraftsSql`): its keys on `audit_events` with the run each started and that run's
 * proposal, and whether a proposal naming the plan waits — scalar subqueries, no statement more. With drafts off none of it
 * is in the statement, and the rule reads every plan as it always has.
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

/** A plan draft's key's `audit_events.kind` (plan-drafts.ts). */
export const PLAN_DRAFT_KIND = "plan_draft";
/** A plan draft's key (plans with a purpose §4.2): the plan, and the last session's date of the ending it drafts for. Its
 * `audit_events` row's id, so one ending has one, whatever races. */
export const planDraftKey = (planId: string, lastSessionDate: string): string => `plan-draft:${planId}:${lastSessionDate}`;
/** The keys of one plan read with it, newest first, at most: one an ending. */
export const PLAN_DRAFT_KEYS_READ = 12;
/** A run still at work: coach-runs.ts `LIVE_STATUSES`, written out (the loop can't be imported here: it reaches back to
 * this module; a test pins the two). */
export const DRAFT_LIVE_STATUSES = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"] as const;
/** A design proposal the athlete never saw (coach-conversation.ts `UNSEEN`; a test pins the two). */
export const DRAFT_UNSEEN_STATUSES = ["unreviewed", "rehearsal", "cancelled"] as const;
/** A main run's design proposal's id, before the run's (design-tools/propose.ts `designProposalId`; a test pins the two). */
export const DRAFT_PROPOSAL_PREFIX = "dp-";
const list = (xs: readonly string[]) => sql.raw(xs.map((x) => `'${x}'`).join(", "));

/**
 * A design proposal `p` the athlete has still to decide, as the app shows one (coach-runs.ts `alsoOpenOf`): pending or
 * partly approved, not past its day, with an op of `kinds` still open — no outcome yet, refused, or being applied — dated
 * `today` or later, for which `also` holds (`o` the op).
 */
const proposalWaits = (today: string, kinds: readonly string[], also: SQL = sql`1`): SQL =>
  sql`(p.status in ('pending', 'partially_approved') and p.expires_at >= ${today} and exists (
    select 1 from json_each(case when json_valid(p.ops) then p.ops else '[]' end) o
    where json_extract(o.value, '$.kind') in (${list(kinds)})
      and (json_extract(o.value, '$.outcome') is null or json_extract(o.value, '$.outcome.status') in ('refused', 'applying'))
      and json_extract(o.value, '$.date') >= ${today} and ${also}))`;

/** The op kinds that make a plan's next sessions: a designed workout, a change to a plan's shape (propose_plan). */
const NAMING_KINDS = ["doc_workout", "plan_structure"] as const;
/** Every kind a design proposal's op can be: what a draft's own proposal may hold (coach-runs.ts `OPEN_OP`'s list). */
const DESIGNED_KINDS = ["doc_workout", "plan_adjust", "plan_structure", "programme_change", "plan_change", "move_pins", "import_correction", "objective_change"] as const;

/**
 * What the hourly draft has made of the coach plan in scope (`programs`, undecorated), as one JSON text for
 * `draftFactsOf` (plan-summaries.ts); null for any other kind. Read only with drafts on.
 *  - `keys`: its draft keys (`planDraftKey`, found by the id's range: the primary key's own index), newest first — each with
 *    its run's id or the outcome when none started, whether the run is live, and whether its proposal reached the athlete or
 *    still waits for them.
 *  - `waiting`: a proposal waits that names the plan — a designed workout filed under it or one of its blocks, a new block
 *    continuing it, or a change to one of its blocks (propose_plan; plan_set's workouts) — whichever run made it.
 */
export function planDraftsSql(today: string): SQL<string | null> {
  const prefix = sql`(${"plan-draft:"} || programs.id || ${":"})`;
  const blocks = sql`(select cp.id from coach_plans cp where cp.program_id = programs.id and cp.user_id = programs.user_id)`;
  const names = sql`(json_extract(o.value, '$.planId') = programs.id or json_extract(o.value, '$.op.continuesPlanId') = programs.id
      or json_extract(o.value, '$.planId') in ${blocks} or json_extract(o.value, '$.op.planId') in ${blocks})`;
  return sql<string | null>`case when programs.kind = 'coach' then json_object(
    'keys', json((select json_group_array(json_object('id', k.id, 'runId', k.runId, 'outcome', k.outcome, 'runLive', k.runLive,
        'proposalSeen', k.proposalSeen, 'proposalOpen', k.proposalOpen)) from (
      select a.id as id, json_extract(a.detail, '$.runId') as runId, json_extract(a.detail, '$.outcome') as outcome,
        coalesce(r.status in (${list(DRAFT_LIVE_STATUSES)}), 0) as runLive,
        coalesce(p.status not in (${list(DRAFT_UNSEEN_STATUSES)}), 0) as proposalSeen,
        coalesce(${proposalWaits(today, DESIGNED_KINDS)}, 0) as proposalOpen
      from audit_events a
        left join coach_runs r on r.id = json_extract(a.detail, '$.runId') and r.user_id = a.user_id
        left join coach_proposals p on p.id = ${DRAFT_PROPOSAL_PREFIX} || r.id and p.user_id = a.user_id
      where a.id > ${prefix} and a.id < ${prefix} || ${"\u{10FFFF}"} and length(a.id) = length(${prefix}) + 10
        and a.user_id = programs.user_id and a.kind = ${PLAN_DRAFT_KIND}
      order by a.id desc limit ${PLAN_DRAFT_KEYS_READ}) k)),
    'waiting', exists (select 1 from coach_proposals p where p.user_id = programs.user_id and ${proposalWaits(today, NAMING_KINDS, names)})) end`;
}

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
 * chip and the trigger read it; the plans list reads the same columns with its own rows. `drafts` (plan-drafts.ts
 * `planDraftsOn`): each coach plan's draft facts too, in the same statement.
 */
export async function readPlanEndings(db: Db, userId: string, today: string, o: { drafts?: boolean } = {}): Promise<PlanEnding[]> {
  const columns = {
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
  };
  const where = and(eq(programs.userId, userId), inArray(programs.kind, [...PLAN_PROMPT_KINDS]), sql`${programs.archivedAt} is null`, inArray(programs.status, ["active", "retired"]));
  const shape = (r: Omit<PlanEnding, "kind" | "blockDisciplines" | "drafts"> & { kind: string; blockDisciplines: string | null }) => ({
    ...r,
    kind: r.kind as ProgramKind,
    blockDisciplines: r.blockDisciplines ? r.blockDisciplines.split(",") : [],
  });
  // Drafts off: the statement as it always was, not a column more.
  if (!o.drafts) return (await db.select(columns).from(programs).where(where)).map(shape);
  const rows = await db
    .select({ ...columns, draftsText: planDraftsSql(today) })
    .from(programs)
    .where(where);
  return rows.map(({ draftsText, ...r }) => {
    const drafts = draftFactsOf(draftsText);
    return { ...shape(r), ...(drafts ? { drafts } : {}) };
  });
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

/**
 * The plans the rule reads, as the chip reads them: the account's (`readPlanEndings`), and the training lines with no plan
 * row (or one this account didn't read) standing in as plans of their own — with the ones a later plan of their sport has
 * followed (`plansSuperseded`). The chip, the trigger and the hourly draft (plan-drafts.ts) all read them so.
 */
export function plansAsRead(plans: readonly PlanEnding[], lines: readonly TrainingLine[], today: LocalDate): { all: PlanEnding[]; superseded: Set<string> } {
  const known = new Set(plans.map((p) => p.id));
  const all = [...plans, ...lines.filter((l) => !l.programId || !known.has(l.programId)).map(lineAsPlan)];
  return { all, superseded: plansSuperseded(all, today) };
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
  const { all, superseded } = plansAsRead(plans, lines, today);
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
