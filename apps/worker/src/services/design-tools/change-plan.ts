/**
 * change_plan(planId, purpose?, brief?, onEnd?, objectiveIds?, pausedUntil?, easeNext?, why) — the main coach proposes
 * ONE change to a plan's own words and ending (plans with a purpose, Stage 1): what the plan is for (`purpose`), the
 * longer account (`brief`), how it ends (`onEnd`: ask, continue or finish), the objectives it serves, a pause (`pausedUntil`,
 * its last day; null lifts it) and, for a course, whether its next session is eased.
 *
 * A SIBLING OF change_programme, NOT A KIND OF IT: change_programme edits an adaptive programme's days, goal and minutes
 * (the settings sheet's own fields, placed again); this edits what any plan says of itself, as `PATCH /api/plans/:id`
 * does, and writes no session. Its checks are that route's (`planPatchSchema`, `onEndAllowed`, a pause not already over),
 * said to the model in words before anything is stored, and it is applied at approval through the same function
 * (plan-registry.ts `applyPlanPatch`: one write, one `program_versions` row). It sits in a proposal beside a
 * `plan_structure`, so a new phase and the plan's updated brief are approved together.
 *
 * THE PLAN is found by its `programs` id, which is what read_plans gives a programme and a watch plan; a coach block's
 * id (its plan is the line's) and a Studio plan's id name their plan too — the answer says which plan it changed.
 *
 * STORED as one op of kind `plan_change` (proposal-kinds.ts `PlanChangeOp`) in the main run's proposal: only the fields it
 * changes (`change`), what they were (`base`, for the approve's stale check), the coach's `why`, and what the card
 * shows — the plan's name, a title ("Base block: new purpose and brief"), the plan's ending in one line, and a line per
 * field ("When it ends: Ask me → Continue"). One per plan: a second call for it replaces the first. Never reviewed: the
 * finish makes it the athlete's, approved with one tap. Nothing is written to the plan until then.
 *
 * REFUSED, each teachable, nothing written: a role other than the main coach's (`not_for_role`); no field given, or one
 * the plan would not take — a text too long, an ending its kind cannot have (`onEndAllowed`: a course or a programme
 * never asks), a pause already over, objectives that are not the athlete's or are done or dropped, easing a plan that is no course
 * (`invalid_input`); a plan that isn't the athlete's, or is archived (`not_your_plan`); fields it already has
 * (`no_change`); a proposal already with the athlete (`proposal_pending`) or closed; a restore under way.
 *
 * Statements: the athlete with the plan, the objectives named, the proposal and the restore marker (one read); the
 * proposal's guarded upsert.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachPlans, coachProposals, objectives, programs } from "@rg/database";
import { clipWords, dayLabel, isLocalDate, onEndAllowed, PLAN_ON_END, planOnEndSchema, type PlanOnEnd, type ProgramKind } from "@rg/domain";
import { OPEN_PROPOSAL_STATUSES } from "../design-review.js";
import { clipProse } from "../design-prose.js";
import { LIVE_OBJECTIVE } from "../objective-changes.js";
import { BRIEF_MAX, isPlanKind, OBJECTIVES_MAX, PURPOSE_MAX } from "../plan-summaries.js";
import {
  isPlanChangeOp,
  PLAN_CHANGE_FIELDS,
  planChangeId,
  planFieldsOfRow,
  type PlanChangeFields,
  type PlanChangeOp,
} from "../proposal-kinds.js";
import { capInWords, isErr, mainRunIdOf, parseAct, prose } from "./act-common.js";
import { designProposalId, upsertProposal } from "./propose.js";
import { parsedArray, parsedJson, plural, readAthlete, refuse, untrusted } from "./read-common.js";
import type { DesignTool, ToolOk } from "./types.js";

const WHY_MAX = 300;
/** A text's words on a card line: the card holds a line, not the brief. */
const LINE_TEXT_MAX = 100;

const input = z
  .object({
    planId: z.string().min(1).max(200),
    purpose: z.string().trim().min(1).max(PURPOSE_MAX).nullable().optional(),
    brief: z.string().trim().min(1).max(BRIEF_MAX).nullable().optional(),
    onEnd: planOnEndSchema.optional(),
    objectiveIds: z.array(z.string().min(1).max(200)).max(OBJECTIVES_MAX).optional(),
    pausedUntil: z.string().refine(isLocalDate, { message: "must be a YYYY-MM-DD calendar date" }).nullable().optional(),
    easeNext: z.boolean().optional(),
    why: prose(WHY_MAX),
  })
  .strict();

/** The endings as the card says them. */
export const ONEND_WORDS: Record<PlanOnEnd, string> = { ask: "Ask me", continue: "Continue", finish: "Finish" };
/** A plan of a kind, as a refusal says it. */
const KIND_WORDS: Record<string, string> = { adaptive: "a programme", course: "a course", coach: "a plan", coros_import: "a watch plan", studio: "a Studio plan" };

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const changedKeys = (from: PlanChangeFields, to: PlanChangeFields): (keyof PlanChangeFields)[] => PLAN_CHANGE_FIELDS.filter((k) => !sameValue(from[k], to[k]));

/** What the card says changes, a line each, in the plan sheet's order — each in plain words, a text clipped to a line. */
export function planSettingLines(from: PlanChangeFields, to: PlanChangeFields): string[] {
  const out: string[] = [];
  for (const k of changedKeys(from, to)) {
    switch (k) {
      case "purpose":
        out.push(to.purpose === null ? "Purpose cleared" : `Purpose: ${clipWords(to.purpose, LINE_TEXT_MAX)}`);
        break;
      case "brief":
        out.push(to.brief === null ? "Brief cleared" : `Brief: ${clipWords(to.brief, LINE_TEXT_MAX)}`);
        break;
      case "onEnd":
        out.push(`When it ends: ${ONEND_WORDS[from.onEnd]} → ${ONEND_WORDS[to.onEnd]}`);
        break;
      case "pausedUntil":
        out.push(to.pausedUntil === null ? "Pause lifted" : `Paused until ${dayLabel(to.pausedUntil)}`);
        break;
      case "objectiveIds":
        out.push(`Objectives ${from.objectiveIds.length} → ${plural(to.objectiveIds.length, "objective")}`);
        break;
      case "easeNext":
        out.push(to.easeNext ? "Next session eased" : "Next session not eased");
        break;
    }
  }
  return out;
}

/** The card's title: "Base block: new purpose", "… new purpose and brief", "… new purpose, ending and pause", "… new
 * settings" (four or more). */
export function planChangeTitle(name: string, changed: readonly (keyof PlanChangeFields)[]): string {
  const WORD: Record<keyof PlanChangeFields, string> = { purpose: "purpose", brief: "brief", onEnd: "ending", pausedUntil: "pause", objectiveIds: "objectives", easeNext: "easing" };
  const named = PLAN_CHANGE_FIELDS.filter((k) => changed.includes(k)).map((k) => WORD[k]);
  const what = named.length <= 3 ? `${named.slice(0, -1).join(", ")}${named.length > 1 ? " and " : ""}${named.at(-1)}` : "settings";
  return `${name}: new ${what}`;
}

/** The plan after the change, in one line: "Ending: Continue · paused until Wed 21 Oct". */
export const planChangeSummary = (c: PlanChangeFields): string => `Ending: ${ONEND_WORDS[c.onEnd]}${c.pausedUntil ? ` · paused until ${dayLabel(c.pausedUntil)}` : ""}`;

/** The fields named, as a refusal's "that purpose and that ending". */
function namedWords(keys: readonly (keyof PlanChangeFields)[]): string {
  const WORD: Record<keyof PlanChangeFields, string> = { purpose: "that purpose", brief: "that brief", onEnd: "that ending", pausedUntil: "that pause", objectiveIds: "those objectives", easeNext: "that easing" };
  const words = PLAN_CHANGE_FIELDS.filter((k) => keys.includes(k)).map((k) => WORD[k]);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What a stored change answers. */
function storedAnswer(proposalId: string, op: PlanChangeOp, o: { replaced?: boolean } = {}): ToolOk {
  return {
    data: {
      stored: true,
      proposalId,
      opId: op.id,
      ...(o.replaced ? { replaced: true } : {}),
      planId: op.planId,
      title: untrusted(op.title),
      summary: op.summary,
      lines: op.lines,
      why: untrusted(op.why),
      issues: op.issues,
      next: "It goes to the athlete as one card — Approve or Not now — never reviewed; nothing changes until they approve. A second change_plan for this plan replaces it. Call finish when the rest is done.",
    },
    summary: `Plan: ${op.title}`,
    receipt: { proposalId, opId: op.id, planId: op.planId },
  };
}

/** The plan as the read gives it. */
interface PlanRow {
  id: string;
  name: string;
  kind: string;
  disciplines: unknown;
  purpose: string | null;
  brief: string | null;
  onEnd: string | null;
  pausedUntil: string | null;
  objectiveIds: unknown;
  config: unknown;
  archivedAt: string | null;
}

const idList = (xs: readonly string[]) => (xs.length ? sql.join(xs.map((x) => sql`${x}`), sql`, `) : sql`null`);

export const changePlan: DesignTool = {
  name: "change_plan",
  description: "The main coach: one change to a plan's purpose, brief, ending, objectives or pause (read_plans), as one card. A second call for it replaces it.",
  inputSchema: {
    type: "object",
    properties: {
      planId: { type: "string" },
      purpose: { type: ["string", "null"], description: `At most ${PURPOSE_MAX} characters; null clears.` },
      brief: { type: ["string", "null"], description: `At most ${BRIEF_MAX} characters; null clears.` },
      onEnd: { enum: [...PLAN_ON_END], description: "A course or programme never asks." },
      objectiveIds: { type: "array", items: { type: "string" } },
      pausedUntil: { type: ["string", "null"], description: "Last day, YYYY-MM-DD, today or later; null lifts." },
      easeNext: { type: "boolean", description: "A course's." },
      why: { type: "string", description: `Why, in one plain line the athlete reads on the card: ${capInWords(WHY_MAX)}.` },
    },
    required: ["planId", "why"],
    additionalProperties: false,
  },
  statementCost: 1 + 1,
  cpuWeight: 0.3,
  roles: ["main"],
  async run(ctx, raw) {
    const parsed = parseAct(input, raw, "planId, the fields to change (purpose, brief, onEnd, objectiveIds, pausedUntil, easeNext) and why");
    if (isErr(parsed)) return parsed;
    const mainRunId = mainRunIdOf(ctx);
    if (ctx.run.role !== "main" || !mainRunId) return refuse("not_for_role", "Only the main coach changes a plan.", "Say in your finish line what you would change.");
    const given = PLAN_CHANGE_FIELDS.filter((k) => parsed[k] !== undefined);
    if (given.length === 0) return refuse("invalid_input", "No field to change.", "Name what changes: purpose, brief, onEnd, objectiveIds, pausedUntil or easeNext.");

    const proposalId = designProposalId(mainRunId);
    const wantedIds = parsed.objectiveIds ?? [];
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      plan: sql`(select json_object('id', pr.id, 'name', pr.name, 'kind', pr.kind, 'disciplines', json(pr.disciplines), 'purpose', pr.purpose, 'brief', pr.brief,
          'onEnd', pr.on_end, 'pausedUntil', pr.paused_until, 'objectiveIds', json(case when json_valid(pr.objective_ids) then pr.objective_ids end),
          'config', json(pr.config), 'archivedAt', pr.archived_at)
        from ${programs} pr where pr.user_id = ${ctx.userId} and (pr.id = ${parsed.planId}
          or (json_valid(pr.source) and json_extract(pr.source, '$.studioPlanId') = ${parsed.planId})
          or pr.id = (select cp.program_id from ${coachPlans} cp where cp.id = ${parsed.planId} and cp.user_id = ${ctx.userId}))
        order by (pr.id = ${parsed.planId}) desc limit 1)`,
      ownObjectives: sql`(select json_group_array(json_array(o.id, o.status)) from ${objectives} o where o.user_id = ${ctx.userId} and o.id in (${idList(wantedIds)}))`,
      propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
    });
    const plan = parsedJson(extra.plan) as PlanRow | null;
    if (!plan || plan.archivedAt !== null || !isPlanKind(plan.kind)) {
      return refuse("not_your_plan", `${JSON.stringify(parsed.planId)} isn't one of the athlete's plans.`, "Use a plan id from read_plans (a block's id names its plan too).");
    }

    const opsText = typeof extra.propOps === "string" ? extra.propOps : null;
    const all = ((opsText ? parsedJson(opsText) : null) as unknown[] | null) ?? [];
    const opId = planChangeId(plan.id);
    const held = all.find((o) => isPlanChangeOp(o) && o.id === opId) as PlanChangeOp | undefined;
    // A replay of this very call: what it stored, or that a later one replaced it.
    if (ctx.toolUseId && held) {
      if (held.toolUseId === ctx.toolUseId) return storedAnswer(proposalId, held);
      if (held.replaces?.includes(ctx.toolUseId)) return { data: { stored: true, proposalId, superseded: true, note: "a later change to this plan replaced this one" }, summary: "An earlier plan change, already replaced" };
    }

    // The plan's own rules, said in its words, before anything is stored (the route's: `applyPlanPatch`).
    const kind = plan.kind as ProgramKind;
    const wrong: string[] = [];
    let fix = "Call it again with fields the plan takes.";
    if (parsed.onEnd !== undefined && !onEndAllowed(kind, parsed.onEnd)) {
      const allowed = PLAN_ON_END.filter((e) => onEndAllowed(kind, e));
      wrong.push(`onEnd: ${KIND_WORDS[kind] ?? "this plan"} cannot end by "${parsed.onEnd}"`);
      fix = `Call it again with onEnd ${allowed.map((e) => JSON.stringify(e)).join(" or ")}, or leave onEnd out.`;
    }
    if (typeof parsed.pausedUntil === "string" && parsed.pausedUntil < athlete.today) wrong.push(`pausedUntil: a pause cannot end before today (${athlete.today})`);
    if (parsed.easeNext !== undefined && kind !== "course") wrong.push("easeNext: only a course can ease its next session");
    const own = new Map(parsedArray(extra.ownObjectives).flatMap((x) => (Array.isArray(x) && typeof x[0] === "string" ? [[x[0], String(x[1])] as const] : [])));
    for (const id of wantedIds) {
      const status = own.get(id);
      if (status === undefined) wrong.push(`objectiveIds: ${JSON.stringify(id)} is none of the athlete's objectives`);
      // Done or dropped: a plan serves it no more (read_plans leaves it out), so it isn't linked anew.
      else if (!(LIVE_OBJECTIVE as readonly string[]).includes(status)) wrong.push(`objectiveIds: ${JSON.stringify(id)} is ${status}, so a plan can't serve it`);
    }
    if (wrong.length > 0) return refuse("invalid_input", wrong.join("; "), fix);

    const status = typeof extra.propStatus === "string" ? extra.propStatus : null;
    if (status === "pending") return refuse("proposal_pending", "Your proposal is already with the athlete.", "Call finish.");
    if (status !== null && !(OPEN_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would change, and the athlete can ask again.");
    }
    if (typeof extra.restoring === "string" && extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the change can be asked for again once the restore is done.");
    }

    const from = planFieldsOfRow({ ...plan, objectiveIds: parsedArray(plan.objectiveIds) });
    const wanted: PlanChangeFields = {
      purpose: parsed.purpose === undefined ? from.purpose : parsed.purpose,
      brief: parsed.brief === undefined ? from.brief : parsed.brief,
      onEnd: parsed.onEnd ?? from.onEnd,
      pausedUntil: parsed.pausedUntil === undefined ? from.pausedUntil : parsed.pausedUntil,
      objectiveIds: parsed.objectiveIds ?? from.objectiveIds,
      easeNext: parsed.easeNext ?? from.easeNext,
    };
    const changed = changedKeys(from, wanted);
    if (changed.length === 0) return refuse("no_change", `${plan.name} already has ${namedWords(given)}.`, "Change something it doesn't have.");
    const change = Object.fromEntries(changed.map((k) => [k, wanted[k]])) as Partial<PlanChangeFields>;
    const base = Object.fromEntries(changed.map((k) => [k, from[k]])) as Partial<PlanChangeFields>;

    const at = ctx.now.toISOString();
    const toolUseId = ctx.toolUseId ?? `call-${at}`;
    const op: PlanChangeOp = {
      kind: "plan_change",
      id: opId,
      planId: plan.id,
      change,
      base,
      why: clipProse(parsed.why, WHY_MAX),
      issues: [],
      title: planChangeTitle(plan.name, changed),
      summary: planChangeSummary(wanted),
      lines: planSettingLines(from, wanted),
      date: athlete.today,
      toolUseId,
      ...(held ? { replaces: [...(held.replaces ?? []), held.toolUseId] } : {}),
      at,
    };
    const ops = held ? all.map((o) => (o === held ? op : o)) : [...all, op];
    if (!(await upsertProposal(ctx, proposalId, ops, opsText, at))) {
      return refuse("proposal_changed", "The proposal changed while the change was being stored.", "Call change_plan again with the same fields.");
    }
    return storedAnswer(proposalId, op, { replaced: !!held });
  },
};
