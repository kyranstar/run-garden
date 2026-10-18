/**
 * propose_plan(change, why) — the main coach proposes ONE change to the shape of the athlete's plans (§8 §5, stream W):
 * a new block (`createPlan`), more weeks for one (`extendPlan`), a week filled in (`firmUp`) or reworked
 * (`reshapeWeek`), a wind-down (`windDown`) or its end (`retirePlan`). Not a new authority: each is the thread coach's
 * own `CoachOp`, parsed by its schema (`coachOpSchema`), judged by its own guardrails (`validateOps` over
 * `guardrailCtx`, coach-wake.ts) and applied at approval by its own appliers, chunk by chunk (design-approve.ts). A
 * plan's sessions are the thread coach's session specs, never reviewed documents (the design's §2.4: cost).
 *
 * STORED as one op of kind `plan_structure` (proposal-kinds.ts `PlanStructureOp`) in the main run's proposal: the op,
 * the coach's `why`, the guardrails' advisories (`issues`) and what the card shows — its title, one line, the manifest's
 * lines (@rg/domain `describeOps`, at most PLAN_LINES_MAX, then "and N more"). A proposal holds one: a second call
 * replaces the first (a whole plan is one intention, approved with one tap). Never reviewed: the finish makes it the
 * athlete's.
 *
 * REFUSED, each teachable, nothing written:
 *  - a role other than the main coach's (`not_for_role`); a kind that isn't a plan's shape (`not_a_plan_change`: one
 *    session is adjust_plan's); a change its schema refuses (`invalid_input`);
 *  - more than MAX_PLAN_SESSIONS sessions (`too_many_sessions`) or sessions over more than MAX_FIRM_WEEKS weeks
 *    (`too_many_weeks`): fill in one or two weeks and leave the rest as shape weeks;
 *  - a week that doesn't start on a Monday, a session outside its week, a plan that ends before it starts
 *    (`bad_dates`);
 *  - a plan that isn't a block of the coach's still running (`not_your_block`, `not_running`: read_plans says which);
 *  - any fatal finding of the thread coach's guardrails (`plan_refused`, each in its own words) — a past date, a
 *    session that isn't there, a watch plan's structure;
 *  - a proposal already with the athlete (`proposal_pending`) or closed, a restore under way.
 *
 * THE CEILING. The first plan stored in an auto run raises the run's spending ceiling to a set's, once (the loop's
 * `SetHooks.raisePlan`; as plan_set does, without making the run a set's).
 *
 * Statements: the athlete with the proposal, the restore marker and the plan it names (one read); the thread coach's
 * guardrail context (`guardrailCtx`: the plan's rows, four weeks of activities, the rows' matches — one read per
 * IN_ARRAY_CHUNK rows of the window it reads, GUARDRAIL_MATCH_CHUNKS at most counted — the coach's plans and memory);
 * the athlete's COROS catalog when a session names exercises (their watch identity, as the wake resolves them); and the
 * proposal's guarded upsert. A window holding more than GUARDRAIL_MATCH_CHUNKS × IN_ARRAY_CHUNK planned rows breaks the
 * count; a real athlete's is far below it.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachPlans, coachProposals } from "@rg/database";
import { addDays, coachOpSchema, dayLabel, daysBetween, describeOps, isoWeekday, validateOps, type CoachOp, type OpLine } from "@rg/domain";
import { guardrailCtx } from "../coach-wake.js";
import { loadExerciseIndex, resolveOpsExercises } from "../exercise-catalog.js";
import { OPEN_PROPOSAL_STATUSES } from "../design-review.js";
import { clipProse } from "../design-prose.js";
import {
  isPlanStructureOp,
  PLAN_LINES_MAX,
  PLAN_STRUCTURE_ID,
  PLAN_STRUCTURE_KINDS,
  type PlanStructureChange,
  type PlanStructureOp,
} from "../proposal-kinds.js";
import { capInWords, isErr, mainRunIdOf, parseAct, prose } from "./act-common.js";
import { designProposalId, upsertProposal } from "./propose.js";
import { parsedJson, readAthlete, refuse, untrusted } from "./read-common.js";
import type { DesignTool, ToolOk } from "./types.js";

const WHY_MAX = 300;
/** The most sessions one plan change writes (§8 §5). */
export const MAX_PLAN_SESSIONS = 40;
/** The most weeks one plan change fills in: the rest are shape weeks, firmed up as they come (§8 §2.4). */
export const MAX_FIRM_WEEKS = 2;
/** The guardrail context's match reads counted (`guardrailCtx` reads one per IN_ARRAY_CHUNK planned rows of its window). */
export const GUARDRAIL_MATCH_CHUNKS = 5;
/** `guardrailCtx` beside its match reads: the planned rows, the activities, the coach's plans, the memory. */
const GUARDRAIL_READS = 4;

/**
 * The change as the model is shown it: compact — the cached prefix carries it on every call — its fields named, its
 * shapes said in words; the thread coach's own schema (`coachOpSchema`) checks it whole, and says what is wrong.
 */
const DATED = {
  type: "array",
  items: {
    type: "object",
    properties: {
      date: { type: "string" },
      session: {
        type: "object",
        description:
          "{ category: easy|long|quality|recovery|race|rest|strength|yoga (mobility), title, durationMinutes, and one body at most: run { blocks: [{ kind: duration|distance, value: minutes|metres, intensity?: easy|steady|threshold|interval|rest }] }, or lift / mobility { rounds?, exercises: [{ name, sets, reps? or holdSeconds?, perSide?, note? }] } }",
      },
    },
    required: ["date", "session"],
  },
};
const CHANGE_SCHEMA = {
  type: "object",
  description:
    "createPlan { discipline: run|lift, name, startDate, endDate, raceDate?, firmSessions, shapeWeeks }; extendPlan { planId, shapeWeeks }; firmUp or reshapeWeek { planId, weekStart, sessions } (a week filled in, or its sessions replaced); windDown { planId, sessions } (easier sessions in place of what is planned in their weeks); retirePlan { planId } (its sessions still to come come off).",
  properties: {
    kind: { enum: [...PLAN_STRUCTURE_KINDS] },
    planId: { type: "string" },
    discipline: { enum: ["run", "lift"] },
    name: { type: "string" },
    startDate: { type: "string" },
    endDate: { type: "string" },
    raceDate: { type: "string" },
    weekStart: { type: "string", description: "A Monday." },
    firmSessions: DATED,
    sessions: DATED,
    shapeWeeks: {
      type: "array",
      items: {
        type: "object",
        properties: { weekStart: { type: "string", description: "A Monday." }, volumeTarget: { type: "string" }, keySessions: { type: "array", items: { type: "string" } } },
        required: ["weekStart", "volumeTarget", "keySessions"],
      },
    },
  },
  required: ["kind"],
};

const input = z.object({ change: z.record(z.string(), z.unknown()), why: prose(WHY_MAX) }).strict();

/** The sessions a change writes. */
export function sessionsOf(op: PlanStructureChange): Array<{ date: string }> {
  switch (op.kind) {
    case "createPlan":
      return op.firmSessions;
    case "firmUp":
    case "reshapeWeek":
    case "windDown":
      return op.sessions;
    default:
      return [];
  }
}

/** A day's Monday. */
export const mondayOf = (date: string): string => addDays(date, 1 - isoWeekday(date));

/** The first day a change puts work on — a new block's start, a new week's Monday — or `today` for one that writes
 * none (a retirement). */
export function firstDateOf(op: PlanStructureChange, today: string): string {
  const dates = sessionsOf(op).map((s) => s.date).sort();
  if (op.kind === "createPlan") return [op.startDate, ...dates].sort()[0]!;
  if (op.kind === "extendPlan") return op.shapeWeeks.map((w) => w.weekStart).sort()[0] ?? today;
  if (op.kind === "firmUp" || op.kind === "reshapeWeek") return [op.weekStart, ...dates].sort()[0]!;
  return dates[0] ?? today;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The plan change's card: its title and one line, in plain words (`name`: the plan's, for a change to one). */
export function planCardWords(op: PlanStructureChange, name: string | null): { title: string; summary: string } {
  const plan = name ?? "your plan";
  const sessions = sessionsOf(op).length;
  switch (op.kind) {
    case "createPlan": {
      const weeks = Math.max(1, Math.ceil((daysBetween(op.startDate, op.endDate) + 1) / 7));
      const parts = [plural(weeks, "week"), sessions > 0 ? `${plural(sessions, "session")} to start` : "shape weeks only", op.raceDate ? `race ${dayLabel(op.raceDate)}` : null];
      return { title: op.name, summary: parts.filter(Boolean).join(" · ") };
    }
    case "extendPlan": {
      const end = addDays(op.shapeWeeks.map((w) => w.weekStart).sort().at(-1)!, 6);
      return { title: `Extend ${plan}`, summary: `${plural(op.shapeWeeks.length, "more week")} · to ${dayLabel(end)}` };
    }
    case "firmUp":
      return { title: `${plan}: week of ${dayLabel(op.weekStart)}`, summary: plural(sessions, "session") };
    case "reshapeWeek":
      return { title: `Rework ${plan}: week of ${dayLabel(op.weekStart)}`, summary: `${plural(sessions, "session")} in place of what's there` };
    case "windDown": {
      const first = sessionsOf(op).map((s) => s.date).sort()[0];
      return { title: `Wind down ${plan}`, summary: `${plural(sessions, "easier session")}${first ? ` · from ${dayLabel(first)}` : ""}` };
    }
    case "retirePlan":
      return { title: `Retire ${plan}`, summary: "Its sessions still to come come off" };
  }
}

/** One manifest line in words: "Mon 18 May · Easy run · 40 min", "Week of Mon 25 May — about 35 km — sketched: …" — its
 * day said once (a line that names it already goes without the prefix). */
export function lineWords(l: OpLine): string {
  const day = l.date ? dayLabel(l.date) : null;
  return `${day && !l.summary.includes(day) ? `${day} · ` : ""}${l.summary}${l.change ? ` — ${l.change}` : ""}`;
}

/** The manifest's lines for a change (the thread coach's own `describeOps`), at most PLAN_LINES_MAX, then "and N more". */
export function planLines(op: PlanStructureChange): string[] {
  const all = describeOps([op as CoachOp]).map(lineWords);
  return all.length <= PLAN_LINES_MAX ? all : [...all.slice(0, PLAN_LINES_MAX), `and ${all.length - PLAN_LINES_MAX} more`];
}

/** Why a change's dates don't hold together, in words; null when they do (the guardrails judge the rest). */
function badDates(op: PlanStructureChange): string | null {
  const weeks = [
    ...(op.kind === "createPlan" || op.kind === "extendPlan" ? op.shapeWeeks.map((w) => w.weekStart) : []),
    ...(op.kind === "firmUp" || op.kind === "reshapeWeek" ? [op.weekStart] : []),
  ];
  const notMonday = weeks.find((w) => isoWeekday(w) !== 1);
  if (notMonday) return `${notMonday} is a ${dayLabel(notMonday).slice(0, 3)}: a week starts on its Monday (${mondayOf(notMonday)}).`;
  if (op.kind === "createPlan" && op.endDate < op.startDate) return `The plan ends (${op.endDate}) before it starts (${op.startDate}).`;
  if (op.kind === "firmUp" || op.kind === "reshapeWeek") {
    const out = op.sessions.find((s) => s.date < op.weekStart || s.date > addDays(op.weekStart, 6));
    if (out) return `${out.date} is outside the week of ${op.weekStart}.`;
  }
  return null;
}

const KINDS_WORDS = "createPlan, extendPlan, windDown, retirePlan, firmUp or reshapeWeek";

/** What a stored plan change answers. */
function storedAnswer(proposalId: string, op: PlanStructureOp, o: { replaced?: boolean } = {}): ToolOk {
  return {
    data: {
      stored: true,
      proposalId,
      opId: op.id,
      ...(o.replaced ? { replaced: true } : {}),
      change: op.op.kind,
      title: untrusted(op.title),
      summary: untrusted(op.summary),
      lines: op.lines.map(untrusted),
      why: untrusted(op.why),
      issues: op.issues,
      next: "It goes to the athlete as one card — Approve plan or Not now — never reviewed. A second propose_plan replaces it. Call finish when the rest is done.",
    },
    summary: `Plan: ${op.title}`,
    receipt: { proposalId, opId: op.id, change: op.op.kind },
  };
}

/** The plan a change names, as the read gives it. */
interface PlanRow {
  id: string;
  name: string;
  status: string;
  discipline: string;
}

export const proposePlan: DesignTool = {
  name: "propose_plan",
  description:
    "The main coach: one change to the shape of the athlete's plans, in your proposal — createPlan, extendPlan, firmUp, reshapeWeek, windDown or retirePlan (a block of yours: read_plans). Checked by the plan guardrails; approved as one card. A second call replaces it.",
  inputSchema: {
    type: "object",
    properties: {
      change: CHANGE_SCHEMA,
      why: { type: "string", description: `Why, in one plain line the athlete reads on the card: ${capInWords(WHY_MAX)}.` },
    },
    required: ["change", "why"],
    additionalProperties: false,
  },
  statementCost: 1 + GUARDRAIL_READS + GUARDRAIL_MATCH_CHUNKS + 1 + 1,
  cpuWeight: 3,
  roles: ["main"],
  async run(ctx, raw) {
    const parsed = parseAct(input, raw, `change ({ kind: ${KINDS_WORDS}, … }) and why`);
    if (isErr(parsed)) return parsed;
    const mainRunId = mainRunIdOf(ctx);
    if (ctx.run.role !== "main" || !mainRunId) return refuse("not_for_role", "Only the main coach changes a plan's shape.", "Say in your finish line what you would change.");
    const kind = parsed.change.kind;
    if (typeof kind !== "string" || !(PLAN_STRUCTURE_KINDS as readonly string[]).includes(kind)) {
      return refuse(
        "not_a_plan_change",
        `change.kind ${JSON.stringify(kind ?? null)} isn't a change to a plan's shape (${KINDS_WORDS}).`,
        "One session — a skip, a move, an ease — is adjust_plan's; one workout is propose_workout's.",
      );
    }
    const schema = coachOpSchema.safeParse(parsed.change);
    if (!schema.success) {
      const issues = schema.error.issues.slice(0, 4).map((i) => `${["change", ...i.path].join(".")}: ${i.message}`);
      return refuse("invalid_input", issues.join("; "), `Call it again with a ${kind} the schema takes.`);
    }
    const op = schema.data as PlanStructureChange;
    const why = clipProse(parsed.why, WHY_MAX);
    const sessions = sessionsOf(op);
    if (sessions.length > MAX_PLAN_SESSIONS) {
      return refuse("too_many_sessions", `It writes ${sessions.length} sessions; one plan change writes at most ${MAX_PLAN_SESSIONS}.`, "Fill in one or two weeks and leave the rest as shape weeks: they are filled in as they come.");
    }
    const weeks = new Set(sessions.map((s) => mondayOf(s.date)));
    if (weeks.size > MAX_FIRM_WEEKS) {
      return refuse("too_many_weeks", `Its sessions fill ${weeks.size} weeks; one plan change fills in at most ${MAX_FIRM_WEEKS}.`, "Keep sessions for the first one or two weeks and sketch the rest as shape weeks.");
    }
    const dates = badDates(op);
    if (dates) return refuse("bad_dates", dates, "Fix the dates and call it again.");

    const proposalId = designProposalId(mainRunId);
    const planId = "planId" in op ? op.planId : null;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
      plan: planId
        ? sql`(select json_object('id', ${coachPlans.id}, 'name', ${coachPlans.name}, 'status', ${coachPlans.status}, 'discipline', ${coachPlans.discipline})
            from ${coachPlans} where ${coachPlans.id} = ${planId} and ${coachPlans.userId} = ${ctx.userId})`
        : sql`null`,
    });
    const opsText = typeof extra.propOps === "string" ? extra.propOps : null;
    const all = ((opsText ? parsedJson(opsText) : null) as unknown[] | null) ?? [];
    const held = all.find(isPlanStructureOp);
    // A replay of this very call: what it stored, or that a later one replaced it.
    if (ctx.toolUseId && held) {
      if (held.toolUseId === ctx.toolUseId) return storedAnswer(proposalId, held);
      if (held.replaces?.includes(ctx.toolUseId)) return { data: { stored: true, proposalId, superseded: true, note: "a later plan change replaced this one" }, summary: "An earlier plan change, already replaced" };
    }
    const status = typeof extra.propStatus === "string" ? extra.propStatus : null;
    if (status === "pending") return refuse("proposal_pending", "Your proposal is already with the athlete.", "Call finish.");
    if (status !== null && !(OPEN_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would change, and the athlete can ask again.");
    }
    if (typeof extra.restoring === "string" && extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the plan can be asked for again once the restore is done.");
    }
    const plan = (parsedJson(extra.plan) as PlanRow | null) ?? null;
    if (planId !== null) {
      if (!plan || plan.id.startsWith("adhoc-")) {
        return refuse("not_your_block", `${JSON.stringify(planId)} isn't a block of yours: only a plan you wrote can change its shape.`, "Use a plan id read_plans marks coachMayChange — or adjust_plan for one of its sessions.");
      }
      if (plan.status !== "active" && plan.status !== "draft") {
        return refuse("not_running", `That block has ended (${plan.status}).`, "Plan what comes after it as a new plan (createPlan).");
      }
    }

    // The thread coach's own guardrails, against the athlete's today: fatal findings refuse, advisories ride along.
    const gctx = await guardrailCtx(ctx.db, ctx.userId, athlete.prefs, athlete.today);
    const verdict = validateOps([op as CoachOp], gctx);
    if (verdict.fatal.length > 0) {
      return refuse(
        "plan_refused",
        `The plan checks refuse it: ${verdict.fatal.map((f) => f.detail).join("; ")}.`,
        "Fix what they name — a date still to come, a session on the plan, a block of yours — and call it again.",
      );
    }
    // A lift's exercises get their watch identity, as the wake gives them (one read, only when a session names one).
    if (sessions.some((s) => "session" in s && ((s as { session: { lift?: unknown; mobility?: unknown } }).session.lift || (s as { session: { mobility?: unknown } }).session.mobility))) {
      resolveOpsExercises([op as CoachOp], await loadExerciseIndex(ctx.db));
    }
    const words = planCardWords(op, plan?.name ?? null);
    const at = ctx.now.toISOString();
    const toolUseId = ctx.toolUseId ?? `call-${at}`;
    const next: PlanStructureOp = {
      kind: "plan_structure",
      id: PLAN_STRUCTURE_ID,
      op,
      why,
      issues: [...verdict.advisory, ...verdict.soft].map((v) => ({ code: v.rule, message: v.detail })),
      title: words.title,
      summary: words.summary,
      lines: planLines(op),
      planKey: planId !== null ? `plan:${planId}` : `new:${(op as Extract<PlanStructureChange, { kind: "createPlan" }>).discipline}`,
      date: firstDateOf(op, athlete.today),
      toolUseId,
      ...(held ? { replaces: [...(held.replaces ?? []), held.toolUseId] } : {}),
      at,
    };
    const ops = held ? all.map((o) => (o === held ? next : o)) : [...all, next];
    if (!(await upsertProposal(ctx, proposalId, ops, opsText, at))) {
      return refuse("proposal_changed", "The proposal changed while the plan was being stored.", "Call propose_plan again with the same change.");
    }
    // An auto run that plans a whole plan may spend a set's ceiling (once; the loop records it).
    ctx.set?.raisePlan?.();
    return storedAnswer(proposalId, next, { replaced: !!held });
  },
};
