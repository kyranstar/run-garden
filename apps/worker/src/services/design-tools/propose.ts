/**
 * propose_workout(doc, target, changeNote?) — a validated draft into the run's ONE proposal (Stage 3 spec §4, §5, §8;
 * principles §6.1, §6.2, §6.4). A designer proposes its workout; the main coach proposes only for now or later today
 * (for a week or the next few, designers do: ruling 4). The reviewer never proposes.
 *
 * FATAL ONLY WHEN WRONG — each refusal is teachable (what, why, how to fix) and writes nothing:
 *  - a day gone, in the athlete's own zone (`past_date`);
 *  - a revision of a workout that isn't there (`not_found`: unknown, archived, another athlete's), that can't change
 *    (`not_editable`: a programme's session — the programme's engine builds it — a completed, skipped or missed one, one
 *    under way), or from a stale base (`stale_base`, saying the current revision);
 *  - any error the validator raises for the day (`invalid_workout`): an unknown exercise, a condition's refusal, a
 *    malformed document. A move the day closes is refused even in a revision whose alternate the day allows: a
 *    proposal states what will be played, so the designer swaps it in this revision (the Studio's save lets the
 *    alternate stand in; a proposal never leans on that);
 *  - a document whose discipline is a run (`run_unsupported`: the app can't play one yet, so it could never be
 *    approved);
 *  - a revision of a workout another run of this design already revises (`target_taken`).
 * Everything else — the validator's warnings — goes with the draft as its costs.
 *
 * THE PROPOSAL. One per main run, its id derived from the run's (`designProposalId`), so a designer appends to its main
 * run's without asking for it. Each workout is one op of kind `doc_workout` (`DocWorkoutOp`): its target, date and
 * time, the document (written by the coach, `source.ref` the run), the change note, the review (null until one is
 * had), the validator's warnings and what is derived from the document — the manifest is computed from these, never
 * from prose (Task 8 applies them through the Studio's create / revise path). A run's later draft REPLACES its earlier
 * op, whatever its target (each run designs one workout; a second draft is a revision round). The call's tool-use id
 * is on its op: a replay — a step that died after this wrote — finds it and answers what it stored, writing nothing.
 *
 * Its status (`proposalStatusOf`): `rehearsal` for a rehearsal run, never listed; `unreviewed` while any op has no
 * review — never shown to the athlete (`pending` is the only status the app lists); `pending` once every op is reviewed.
 *
 * REVIEW (Task 6 fills the seam): with `ctx.reviewDraft`, the draft is reviewed before it is stored and the review is
 * the result; without one — or when the reviewer has no verdict — it is stored unreviewed and says so.
 *
 * Seven statements: the athlete (with the gear, set-aside moves, recent sessions' ids, the target row, the proposal and
 * the restore marker), the moves done cleanly, the recent sessions (four), then one write — an upsert guarded by the
 * ops it read, so a write that raced another is refused rather than lost.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachProposals, plannedWorkouts } from "@rg/database";
import { docOriginRow, type WorkoutDoc } from "@rg/domain";
import type { DocIssue } from "@rg/workout";
import { FROZEN_STATES } from "../workout-doc-store.js";
import type { DesignReview, DesignTool, DraftForReview, ToolContext, ToolOk } from "./types.js";
import {
  coachDoc,
  derivedSummary,
  docPlaceId,
  docValidateCtx,
  errorsLine,
  isErr,
  issueOut,
  judge,
  mainRunIdOf,
  objectField,
  parseAct,
  readDocAthlete,
  WARNINGS_SHOWN,
} from "./act-common.js";
import { dateField, DATE_SCHEMA, parsedJson, refuse } from "./read-common.js";

/** The one proposal of a main run's design. */
export const designProposalId = (mainRunId: string): string => `dp-${mainRunId}`;

export type DocWorkoutTarget = { kind: "new"; date: string; time?: string } | { kind: "revise"; workoutId: string; baseRev: number };

/** One designed workout of a proposal (spec §8). Task 8 applies it; the run view and the manifest read it. */
export interface DocWorkoutOp {
  kind: "doc_workout";
  target: DocWorkoutTarget;
  /** The day it is for: the new workout's, or the revised workout's own. */
  date: string;
  time?: string;
  doc: WorkoutDoc;
  changeNote?: string;
  /** The independent review; null until one is had. */
  review: DesignReview | null;
  /** The validator's warnings for the day: the costs shown beside Approve. */
  issues: Array<ReturnType<typeof issueOut>>;
  derived: Record<string, unknown>;
  /** The run that designed it. */
  by: { runId: string; role: "main" | "designer" };
  /** The model's call that proposed it: a replay of the call finds it. */
  toolUseId: string;
  at: string;
}

export type DesignProposalStatus = "unreviewed" | "pending" | "rehearsal";

/** A proposal's status from its ops (see the module comment). */
export function proposalStatusOf(ops: readonly DocWorkoutOp[], rehearsal: boolean): DesignProposalStatus {
  if (rehearsal) return "rehearsal";
  return ops.length > 0 && ops.every((o) => o.review !== null) ? "pending" : "unreviewed";
}

/** Statuses a design's proposal is still open in: a later draft may still change it. */
const OPEN = ["unreviewed", "pending", "rehearsal"] as const;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), date: dateField, time: z.string().regex(CLOCK, "must be a time like 17:30").optional() }).strict(),
  z.object({ kind: z.literal("revise"), workoutId: z.string().min(1).max(120), baseRev: z.number().int().min(0) }).strict(),
]);
const input = z.object({ doc: objectField, target, changeNote: z.string().trim().min(1).max(200).optional() }).strict();

const CHANGE_NOTE_SHOWN = 500;

/** The guidance for a draft the validator refused. */
function invalidFix(errors: readonly DocIssue[], today: boolean): string {
  const gated = errors.some((e) => e.code === "condition_gate" || e.code === "condition_pattern" || e.code === "condition_never");
  if (gated && today) {
    return "Swap each move the day closes for one it allows, in this draft (an alternate doesn't stand in on a proposal), then validate and propose again.";
  }
  return "Fix each error (validate_workout lists them all, with fixes), then propose again.";
}

interface TargetRow {
  date: string;
  time: string;
  origin: string | null;
  completion: string;
  content: string | null;
  rev: number | null;
  archived: string | null;
}

export const proposeWorkout: DesignTool = {
  name: "propose_workout",
  description:
    "Submit a validated draft and where it goes: a new workout on a date (today or later), or a revision of one that can still change, from its current revision. It is reviewed independently before the athlete sees it. Call again with a revised draft to replace yours.",
  inputSchema: {
    type: "object",
    properties: {
      // The document's full schema is validate_workout's (sent once, so the cached tool list carries it once).
      doc: { type: "object", description: "The validated draft: a workout document exactly as validate_workout takes it." },
      target: {
        anyOf: [
          {
            type: "object",
            properties: { kind: { const: "new" }, date: DATE_SCHEMA, time: { type: "string", description: "HH:MM, the athlete's local time (optional)." } },
            required: ["kind", "date"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "revise" },
              workoutId: { type: "string", description: "The workout's id (list_workouts, read_plan)." },
              baseRev: { type: "integer", minimum: 0, description: "The revision you read (get_workout's rev)." },
            },
            required: ["kind", "workoutId", "baseRev"],
            additionalProperties: false,
          },
        ],
      },
      changeNote: { type: "string", maxLength: 200, description: "What changed from your last draft, and why (a revision round)." },
    },
    required: ["doc", "target"],
    additionalProperties: false,
  },
  statementCost: 7,
  roles: ["main", "designer"],
  async run(ctx, raw) {
    const p = parseAct(input, raw, "doc (a workout document), target ({ kind: new, date, time? } or { kind: revise, workoutId, baseRev }) and optionally changeNote");
    if (isErr(p)) return p;
    if (ctx.run.role === "main" && ctx.run.scope.kind !== "now" && ctx.run.scope.kind !== "later_today") {
      return refuse(
        "not_for_scope",
        "For a week or the next few workouts, each workout's designer proposes it; the main coach plans the set.",
        "Call plan_set with one brief per workout, then judge the set and finish.",
      );
    }
    const mainRunId = mainRunIdOf(ctx);
    if (!mainRunId) return refuse("no_main_run", "This designer run has no main run to propose into.", "Finish with what you have.");
    const proposalId = designProposalId(mainRunId);
    const doc = coachDoc(p.doc, mainRunId);
    const pw = plannedWorkouts;
    const a = await readDocAthlete(ctx, {
      placeId: docPlaceId(doc),
      extras: {
        propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
        propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
        restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
        targetRow:
          p.target.kind === "revise"
            ? sql`(select json_object('date', ${pw.effectiveDate}, 'time', ${pw.effectiveTime}, 'origin', ${pw.origin}, 'completion', ${pw.completionState},
                'content', ${pw.contentState}, 'rev', ${pw.workoutDocRev}, 'archived', ${pw.archivedAt})
                from ${pw} where ${pw.id} = ${p.target.workoutId} and ${pw.userId} = ${ctx.userId})`
            : sql`null`,
      },
    });
    if (isErr(a)) return a;
    const today = a.athlete.today;
    const opsText = typeof a.extra.propOps === "string" ? a.extra.propOps : null;
    const ops = ((opsText ? parsedJson(opsText) : null) as DocWorkoutOp[] | null) ?? [];
    const status = typeof a.extra.propStatus === "string" ? a.extra.propStatus : null;

    // A replay of this very call: what it stored, again.
    const replayed = ctx.toolUseId ? ops.find((o) => o.toolUseId === ctx.toolUseId) : undefined;
    if (replayed) return storedAnswer(proposalId, replayed, false);

    if (status !== null && !(OPEN as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would change, and the athlete can ask again.");
    }
    if (typeof a.extra.restoring === "string" && a.extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the design can be asked for again once the restore is done.");
    }

    let date: string;
    let time: string | undefined;
    if (p.target.kind === "new") {
      date = p.target.date;
      time = p.target.time;
      if (date < today) return refuse("past_date", `${date} is before today (${today}) where the athlete is.`, "Propose it for today or a later day.");
    } else {
      const row = parsedJson(a.extra.targetRow) as TargetRow | null;
      if (!row || row.archived) {
        return refuse("not_found", `No workout of the athlete's has id ${JSON.stringify(p.target.workoutId)}.`, "Use an id from list_workouts or read_plan, or propose a new workout.");
      }
      const editable = whyNotEditable(row);
      if (editable) return refuse("not_editable", editable, "Propose a new workout instead, or leave this one as it is.");
      if ((row.rev ?? 0) !== p.target.baseRev) {
        return refuse(
          "stale_base",
          `The workout is at revision ${row.rev ?? 0}, not ${p.target.baseRev}: it changed since it was read.`,
          "Read it again with get_workout, revise from that revision, and propose again.",
        );
      }
      if (row.date < today) return refuse("past_date", `That workout is on ${row.date}, before today (${today}).`, "Propose a new workout for today or later instead.");
      const workoutId = p.target.workoutId;
      if (ops.some((o) => o.by.runId !== ctx.run.id && o.target.kind === "revise" && o.target.workoutId === workoutId)) {
        return refuse("target_taken", "Another workout of this design already revises that workout.", "Propose a new workout, or revise a different one.");
      }
      date = row.date;
      time = row.time;
    }

    const judged = judge(doc, await docValidateCtx(ctx, a, date));
    if (judged.errors.length > 0 || !judged.doc || !judged.derived) {
      return refuse("invalid_workout", errorsLine(judged.errors), invalidFix(judged.errors, date === today));
    }
    if (judged.derived.discipline === "run") {
      return refuse(
        "run_unsupported",
        "This draft is mostly running, and the app can't play a run document yet, so it could never be approved.",
        "Keep runs on the plan as they are; propose strength, mobility or care work around them.",
      );
    }

    const draftTarget: DocWorkoutTarget =
      p.target.kind === "new" ? { kind: "new", date, ...(time ? { time } : {}) } : { kind: "revise", workoutId: p.target.workoutId, baseRev: p.target.baseRev };
    const derived = derivedSummary(judged.derived);
    const draft: DraftForReview = {
      proposalId,
      target: draftTarget,
      date,
      doc: judged.doc,
      issues: judged.warnings,
      derived,
      ...(p.changeNote ? { changeNote: p.changeNote } : {}),
    };
    const review = ctx.reviewDraft ? await reviewOrNull(ctx, draft) : null;

    const at = ctx.now.toISOString();
    const op: DocWorkoutOp = {
      kind: "doc_workout",
      target: draftTarget,
      date,
      ...(time ? { time } : {}),
      doc: judged.doc,
      ...(p.changeNote ? { changeNote: p.changeNote } : {}),
      review,
      issues: judged.warnings.slice(0, WARNINGS_SHOWN).map(issueOut),
      derived,
      by: { runId: ctx.run.id, role: ctx.run.role === "designer" ? "designer" : "main" },
      toolUseId: ctx.toolUseId ?? `call-${at}`,
      at,
    };
    const replaced = ops.some((o) => o.by.runId === ctx.run.id);
    const next = [...ops.filter((o) => o.by.runId !== ctx.run.id), op];
    const written = await upsertProposal(ctx, proposalId, next, opsText, at);
    if (!written) {
      return refuse("proposal_changed", "The proposal changed while this draft was being stored.", "Call propose_workout again with the same draft.");
    }
    return storedAnswer(proposalId, op, replaced);
  },
};

/** Why a workout can't be revised, or null when it can (doc-workouts.ts `reviseDocWorkout`'s own rules). */
function whyNotEditable(row: TargetRow): string | null {
  if (!docOriginRow(row)) {
    return row.origin === "program"
      ? "It is a programme's session: the programme's engine designs it, so its content can't be proposed."
      : "It isn't a Studio or template workout, so its content can't be proposed.";
  }
  if ((FROZEN_STATES as readonly string[]).includes(row.completion)) return `It is already ${row.completion}.`;
  if (row.content === "started" || row.content === "done") return "Its session is already under way.";
  return null;
}

async function reviewOrNull(ctx: ToolContext, draft: DraftForReview): Promise<DesignReview | null> {
  try {
    return (await ctx.reviewDraft!(ctx, draft)) ?? null;
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "propose_workout: review failed", error: e instanceof Error ? e.message : "unknown" }));
    return null;
  }
}

/**
 * Write the proposal with `ops`: made, or updated while it is still open and still holds the ops this call read
 * (`readOps`, null for none). One statement; false when nothing was written (another write came between).
 */
async function upsertProposal(ctx: ToolContext, id: string, ops: DocWorkoutOp[], readOps: string | null, at: string): Promise<boolean> {
  const status = proposalStatusOf(ops, ctx.run.rehearsal);
  const title = ops.length === 1 ? ops[0]!.doc.title : `${ops.length} workouts`;
  const rationale = ops
    .map((o) => o.changeNote ?? o.doc.intent.summary)
    .join(" · ")
    .slice(0, CHANGE_NOTE_SHOWN);
  const expiresAt = ops.map((o) => o.date).sort().at(-1)!;
  const json = JSON.stringify(ops);
  const rows = (await ctx.db.all(sql`
    INSERT INTO coach_proposals (id, user_id, plan_id, title, evidence, rationale, flags, ops, status, created_at, expires_at)
    VALUES (${id}, ${ctx.userId}, NULL, ${title}, '', ${rationale}, '[]', ${json}, ${status}, ${at}, ${expiresAt})
    ON CONFLICT (id) DO UPDATE SET title = excluded.title, rationale = excluded.rationale, ops = excluded.ops,
      status = excluded.status, expires_at = excluded.expires_at
    WHERE coach_proposals.user_id = excluded.user_id AND coach_proposals.status IN ('unreviewed', 'pending', 'rehearsal')
      AND coach_proposals.ops IS ${readOps}
    RETURNING id
  `)) as Array<{ id: string }>;
  return rows.length > 0;
}

function storedAnswer(proposalId: string, op: DocWorkoutOp, replaced: boolean): ToolOk {
  const minutes = op.derived.minutes as number;
  return {
    data: {
      stored: true,
      proposalId,
      ...(replaced ? { replaced: true } : {}),
      review: op.review,
      ...(op.review ? {} : { note: "not reviewed yet" }),
      date: op.date,
      ...(op.time ? { time: op.time } : {}),
      warnings: op.issues,
      derived: op.derived,
    },
    summary: `Draft — "${op.doc.title}": ${minutes} min${op.review ? "" : " (not reviewed yet)"}`,
    receipt: { proposalId, title: op.doc.title, date: op.date, ...(op.time ? { time: op.time } : {}), minutes, reviewed: op.review !== null },
  };
}
