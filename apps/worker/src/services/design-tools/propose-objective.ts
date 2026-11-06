/**
 * propose_objective(change, …, why, basis) — the main coach proposes a change to the athlete's objectives (audit fixes
 * 2026-11-06, E6; principles §2.8, §5.2; spec §7.2: a drift's diagnosis may "change the plan, the objective or the
 * approach — and propose it"): retarget a key result, re-date one (an objective's dates are its key results'), add a key
 * result, retire an objective (done, or let go) or a key result, add an objective with its key results. The Worker reads
 * `before` itself; the change is stored as one `objective_change` op in the run's proposal — shown before → after, applied
 * ONLY when the athlete taps Approve (objective-changes.ts), never before.
 *
 * WHY. On `basis: "stand"` the reason cites where the athlete stands — a figure from the opening's block or
 * read_objectives (it must name one: a number); on `basis: "owner"` it is the athlete's own word in this conversation
 * (their message; never a run they asked nothing in words).
 *
 * CHECKED AS THE BOARD CHECKS (objectives.ts): a key result added or an objective added passes the board's own schema
 * and library check, its unit and direction resolved as the board resolves them; a re-date is a day from today on.
 *
 * REFUSED, each teachable, nothing written: another role's call (`not_for_role`); an objective or key result that isn't
 * the athlete's (`not_found`); one that is done or dropped (`not_a_target`); a full objective (`full`); a value its shape
 * or the board's check refuses (`bad_after`); the value it already has (`same_value`); a reason with no figure on the
 * stand (`uncited`); the owner's word with no words of theirs (`not_their_word`); more than OBJECTIVE_CHANGES_MAX
 * (`too_many`); a proposal already with the athlete or closed; a restore under way. A second call for the same target
 * replaces the first; a replay answers what it stored.
 *
 * Statements: the athlete, the proposal, the restore marker, the objective and its key results, and the run's words (one
 * read); the proposal's guarded upsert.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachProposals } from "@rg/database";
import { GOAL_IDS, isLocalDate, keyResultCreateSchema, newId, objectiveCreateSchema } from "@rg/domain";
import { OPEN_PROPOSAL_STATUSES } from "../design-review.js";
import { clipProse } from "../design-prose.js";
import { askedWordsSql, currentOf, objectiveChangeLine, objectiveStateOf, objectiveStateSql } from "../objective-changes.js";
import { libraryIssues, resolvedKeyResult, type KeyResultInputParsed } from "../objectives.js";
import {
  isObjectiveChangeOp,
  OBJECTIVE_CHANGES,
  OBJECTIVE_CHANGES_MAX,
  objectiveChangeId,
  type ObjectiveChangeKind,
  type ObjectiveChangeOp,
  type ObjectiveKeyResultDraft,
} from "../proposal-kinds.js";
import { capInWords, isErr, mainRunIdOf, parseAct, prose } from "./act-common.js";
import { designProposalId, upsertProposal } from "./propose.js";
import { parsedJson, readAthlete, refuse, untrusted } from "./read-common.js";
import type { DesignTool, ToolOk } from "./types.js";

const WHY_MAX = 300;
const id = z.string().min(1).max(80);

const input = z
  .object({
    change: z.enum(OBJECTIVE_CHANGES),
    objectiveId: id.optional(),
    keyResultId: id.optional(),
    target: z.number().finite().optional(),
    dueDate: z.string().nullable().optional(),
    status: z.enum(["done", "dropped"]).optional(),
    keyResult: z.unknown().optional(),
    objective: z.unknown().optional(),
    why: prose(WHY_MAX),
    basis: z.enum(["stand", "owner"]),
  })
  .strict();

const NEXT = "It goes to the athlete as a card, before → after: applied only on Approve. A second propose_objective for the same target replaces it.";

/** A figure: a reason on where the athlete stands names the number it rests on. */
const FIGURE = /\d/;

function storedAnswer(proposalId: string, op: ObjectiveChangeOp, o: { replaced?: boolean } = {}): ToolOk {
  return {
    data: { stored: true, proposalId, opId: op.id, ...(o.replaced ? { replaced: true } : {}), said: untrusted(op.line), next: NEXT },
    summary: `A change to your objectives to suggest: ${op.line}`,
    receipt: { proposalId, opId: op.id },
  };
}

/** The zod issues as one line. */
const issuesWords = (issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>): string =>
  issues.slice(0, 3).map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");

export const proposeObjective: DesignTool = {
  name: "propose_objective",
  description:
    "The main coach: suggest a change to the athlete's objectives — retarget or re-date a key result, add one, retire an objective (done or dropped) or a key result, add an objective — with why, citing where they stand (a figure) or their word (owner). Applied only on Approve.",
  inputSchema: {
    type: "object",
    properties: {
      change: { type: "string", enum: [...OBJECTIVE_CHANGES] },
      objectiveId: { type: "string", description: "retire (an objective), add_key_result: the objective's id (read_objectives)." },
      keyResultId: { type: "string", description: "retarget, redate, retire (a key result): its id (read_objectives)." },
      target: { type: "number", description: "retarget: the new target, in the key result's unit." },
      dueDate: { type: ["string", "null"], description: "redate: YYYY-MM-DD from today on, or null for no date." },
      status: { type: "string", enum: ["done", "dropped"], description: "retire an objective: done (reached) or dropped (let go)." },
      keyResult: { type: "object", description: "add_key_result: { label, measure, target?, dueDate?, direction?, baseline?, unit? } — as read_objectives shows one." },
      objective: { type: "object", description: "add_objective: { title, why?, goalIds?, keyResults? }." },
      why: { type: "string", description: `${capInWords(WHY_MAX)}: on the stand, name the figure it rests on.` },
      basis: { type: "string", enum: ["stand", "owner"], description: "stand: the figures where they stand; owner: the athlete said so in their message." },
    },
    required: ["change", "why", "basis"],
    additionalProperties: false,
  },
  statementCost: 2,
  // Measured (design-cpu-bench 8.propose_objective: an objective added with ten key results, each checked as the board
  // checks it, beside the rich athlete's objectives): 0.09 ms scaled p50 on a loaded pass (×0.13 at load 233, 8 cores —
  // no quiet run to be had; correct_import's peer weight); declared at correct_import's 0.4 with room.
  cpuWeight: 0.4,
  roles: ["main"],
  async run(ctx, raw) {
    const parsed = parseAct(input, raw, "change, the objective or key result it changes, the new value, why and basis");
    if (isErr(parsed)) return parsed;
    const mainRunId = mainRunIdOf(ctx);
    if (ctx.run.role !== "main" || !mainRunId) return refuse("not_for_role", "Only the main coach suggests a change to the athlete's objectives.", "Say in your finish line what you would change.");
    const change = parsed.change as ObjectiveChangeKind;
    // What each change needs.
    const needs = (ok: boolean, what: string) => (ok ? null : refuse("invalid_input", `${change} needs ${what}.`, `Give ${what} (read_objectives names each).`));
    const missing =
      change === "retarget"
        ? needs(!!parsed.keyResultId && parsed.target !== undefined, "keyResultId and target")
        : change === "redate"
          ? needs(!!parsed.keyResultId && parsed.dueDate !== undefined, "keyResultId and dueDate")
          : change === "add_key_result"
            ? needs(!!parsed.objectiveId && !parsed.keyResultId && parsed.keyResult !== undefined, "objectiveId and keyResult (no keyResultId)")
            : change === "retire"
              ? needs(!!parsed.keyResultId !== !!parsed.objectiveId && (!parsed.objectiveId || !!parsed.status), "keyResultId — or objectiveId with status")
              : needs(parsed.objective !== undefined, "objective");
    if (missing) return missing;

    const proposalId = designProposalId(mainRunId);
    // The objective it reads: the one it names (an add, an objective retired), else its key result's.
    const ref =
      change === "add_key_result" || (change === "retire" && !parsed.keyResultId)
        ? { objectiveId: parsed.objectiveId! }
        : parsed.keyResultId
          ? { keyResultId: parsed.keyResultId }
          : null;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
      state: ref ? objectiveStateSql(ctx.userId, ref) : sql`null`,
      // What the athlete asked this run in words: basis owner is their word alone — never a "needs you" chip's request,
      // which is the app's text (its run's `diagnose`).
      asked: askedWordsSql(ctx.userId, mainRunId),
    });
    const opsText = typeof extra.propOps === "string" ? extra.propOps : null;
    const all = ((opsText ? parsedJson(opsText) : null) as unknown[] | null) ?? [];
    const status = typeof extra.propStatus === "string" ? extra.propStatus : null;
    // A replay of this very call: what it stored (an add's ids are made per call, so a replay finds its call).
    const replayed = ctx.toolUseId ? (all.find((o) => isObjectiveChangeOp(o) && o.toolUseId === ctx.toolUseId) as ObjectiveChangeOp | undefined) : undefined;
    if (replayed) return storedAnswer(proposalId, replayed);
    if (status === "pending") return refuse("proposal_pending", "Your proposal is already with the athlete.", "Call finish.");
    if (status !== null && !(OPEN_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would change, and the athlete can ask again.");
    }
    if (typeof extra.restoring === "string" && extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the change can be made once the restore is done.");
    }

    // What it is now, read by the Worker (never the coach's say).
    const state = objectiveStateOf(extra.state);
    // A retire names an objective or a key result; the state is that objective's either way.
    const current = currentOf({ change, ...(parsed.keyResultId ? { keyResultId: parsed.keyResultId } : {}), ...(parsed.objectiveId ? { objectiveId: parsed.objectiveId } : {}) }, change === "add_objective" ? null : state);
    if ("why" in current) {
      const what = parsed.keyResultId ? `Key result ${JSON.stringify(parsed.keyResultId)}` : parsed.objectiveId ? `Objective ${JSON.stringify(parsed.objectiveId)}` : "That";
      return refuse(current.code, `${what} ${current.why}.`, current.code === "full" ? "Retire one of its key results first, or add an objective." : "Use an id read_objectives gives — an active or paused objective's.");
    }

    // The new value, checked as the board checks it.
    const prefs = { weightUnit: athlete.prefs.weightUnit === "kg" ? ("kg" as const) : ("lb" as const), units: athlete.prefs.units === "mi" ? ("mi" as const) : ("km" as const) };
    const draftOf = (rawKr: unknown, path: string): ObjectiveKeyResultDraft | string => {
      const kr = keyResultCreateSchema.safeParse(rawKr);
      if (!kr.success) return `${path}: ${issuesWords(kr.error.issues)}`;
      const lib = libraryIssues([kr.data as KeyResultInputParsed]);
      if (lib.length) return `${path}: a move its measure names isn't the library's`;
      const r = resolvedKeyResult(kr.data as KeyResultInputParsed, prefs);
      return { id: newId(), ...r, measure: r.measure as unknown as Record<string, unknown> };
    };
    let after: unknown;
    let newIds: { objectiveId?: string; keyResultId?: string } = {};
    let title = state?.title ?? "";
    switch (change) {
      case "retarget":
        after = parsed.target;
        break;
      case "redate": {
        const d = parsed.dueDate ?? null;
        if (d !== null && (!isLocalDate(d) || d < athlete.today)) return refuse("bad_after", `dueDate ${JSON.stringify(d)} isn't a day from today (${athlete.today}) on.`, "Give a YYYY-MM-DD from today on, or null for no date.");
        after = d;
        break;
      }
      case "retire":
        after = parsed.keyResultId ? null : parsed.status;
        break;
      case "add_key_result": {
        const draft = draftOf(parsed.keyResult, "keyResult");
        if (typeof draft === "string") return refuse("bad_after", `${draft}.`, "Give the key result as read_objectives shows one: a label and a measure whose moves the library holds.");
        after = draft;
        newIds = { keyResultId: draft.id };
        break;
      }
      case "add_objective": {
        const o = objectiveCreateSchema.safeParse({ ...(parsed.objective && typeof parsed.objective === "object" ? parsed.objective : {}), status: "active" });
        if (!o.success) return refuse("bad_after", `objective: ${issuesWords(o.error.issues)}.`, "Give { title, why?, goalIds?, keyResults? } — goals from the profile's ids.");
        const drafts: ObjectiveKeyResultDraft[] = [];
        for (const [i, kr] of o.data.keyResults.entries()) {
          const d = draftOf(kr, `objective.keyResults.${i}`);
          if (typeof d === "string") return refuse("bad_after", `${d}.`, "Give each key result as read_objectives shows one: a label and a measure whose moves the library holds.");
          drafts.push(d);
        }
        const objectiveId = newId();
        after = { title: o.data.title, why: o.data.why ?? null, goalIds: o.data.goalIds.filter((g) => (GOAL_IDS as readonly string[]).includes(g)), status: "active", keyResults: drafts };
        newIds = { objectiveId };
        title = o.data.title;
        break;
      }
    }
    if (JSON.stringify(after ?? null) === JSON.stringify(current.value ?? null)) return refuse("same_value", "It already is that.", "Change only what should change; leave the rest.");

    // Why: the stand's figure, or the athlete's word in their own message.
    if (parsed.basis === "stand" && !FIGURE.test(parsed.why)) {
      return refuse("uncited", "A change on where they stand names the figure it rests on.", "Say the figure — the key result's current against its target and due day, or the planned against done — or give basis owner when it is the athlete's word.");
    }
    if (parsed.basis === "owner" && (ctx.run.savesBatchId || typeof extra.asked !== "string")) {
      return refuse("not_their_word", "basis owner is the athlete's own word — this run answers no message of theirs.", "Give basis stand with the figure it rests on — or ask them with ask_athlete.");
    }

    const objectiveId = newIds.objectiveId ?? state!.id;
    const keyResultId = newIds.keyResultId ?? parsed.keyResultId;
    const target = keyResultId && change !== "add_key_result" ? keyResultId : change === "add_key_result" ? keyResultId! : objectiveId;
    const opId = objectiveChangeId(change, target);
    const held = all.find((o) => isObjectiveChangeOp(o) && o.id === opId) as ObjectiveChangeOp | undefined;
    if (ctx.toolUseId && held?.replaces?.includes(ctx.toolUseId)) {
      return { data: { stored: true, proposalId, superseded: true, note: "a later propose_objective replaced this one" }, summary: "An earlier change, already replaced" };
    }
    const others = all.filter((o) => isObjectiveChangeOp(o) && o.id !== opId).length;
    if (others >= OBJECTIVE_CHANGES_MAX) return refuse("too_many", `This suggestion holds ${OBJECTIVE_CHANGES_MAX} changes to the objectives already.`, "Keep the ones that matter most; the athlete can ask again for the rest.");

    const kr = parsed.keyResultId ? state?.krs.find((k) => k.id === parsed.keyResultId) : undefined;
    const line = objectiveChangeLine({ change, title, before: current.value, after, ...(kr ? { kr: { label: kr.label, unit: kr.unit } } : {}) });
    const at = ctx.now.toISOString();
    const toolUseId = ctx.toolUseId ?? `call-${at}`;
    const op: ObjectiveChangeOp = {
      kind: "objective_change",
      id: opId,
      change,
      objectiveId,
      ...(keyResultId ? { keyResultId } : {}),
      before: current.value ?? null,
      after: after ?? null,
      why: clipProse(parsed.why, WHY_MAX),
      basis: parsed.basis,
      title,
      line,
      date: athlete.today,
      toolUseId,
      ...(held ? { replaces: [...(held.replaces ?? []), held.toolUseId] } : {}),
      at,
    };
    const ops = held ? all.map((o) => (o === held ? op : o)) : [...all, op];
    if (!(await upsertProposal(ctx, proposalId, ops, opsText, at))) {
      return refuse("proposal_changed", "The proposal changed while the change was being stored.", "Call propose_objective again with the same change.");
    }
    return storedAnswer(proposalId, op, { replaced: !!held });
  },
};
