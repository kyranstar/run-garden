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
 *  - a revision of a workout another run of this design already revises (`target_taken`);
 *  - a third draft from one run, once two rounds of review are done (`rounds_done`: ruling 4).
 * Everything else — the validator's warnings — goes with the draft as its costs.
 *
 * THE PROPOSAL. One per main run, its id derived from the run's (`designProposalId`), so a designer appends to its main
 * run's without asking for it. Each workout is one op of kind `doc_workout` (`DocWorkoutOp`): its target, date and
 * time, the document (written by the coach, `source.ref` the run), the change note, the review (null until one is
 * had), the validator's warnings and what is derived from the document — the manifest is computed from these, never
 * from prose (Task 8 applies them through the Studio's create / revise path). Each run holds ONE op, whatever its
 * target (each run designs one workout; a second draft is a revision round). The call's tool-use id is on its op: a
 * replay — a step that died after this wrote — finds its id and answers what it stored, writing nothing new.
 *
 * A free-text move is refused (act-common.ts `freeTextRefusal`): no condition rule can judge it. A revision may keep
 * one its workout's current document already holds, unchanged.
 *
 * Its status: `rehearsal` for a rehearsal run, never listed; otherwise `unreviewed` — never shown to the athlete
 * (`pending` is the only status the app lists). propose never writes `pending`: the main run's finish does, once every
 * op carries its review (coach-runs.ts; Task 6 has the reviews written).
 *
 * REVIEW (design-review.ts; ruling 4). With the loop's review hooks (`ctx.review`), the draft is stored unreviewed, a
 * reviewer sub-run is started for it, and the call answers `control: "review"`: the run pauses, and the call's result
 * for the model is the review, once it is in. A first draft is the op itself; a revision of a reviewed draft waits
 * beside it (`candidate`) while its review runs, so the op always holds the best-scoring version so far, and each
 * round is logged (`reviewLog`). REVIEW_ROUNDS drafts are reviewed at most. A replay of a call whose draft is under
 * review starts its reviewer only if it never was (the sub-run's id is the round's); one whose reviewer is over without
 * a review settles the validator's view; one whose review is in answers it. Without the hooks (tests of this tool
 * alone), a later draft replaces the earlier and nothing is reviewed: the proposal never becomes pending.
 *
 * Eight statements: the athlete (with the gear, set-aside moves, recent sessions' ids, the target row, the proposal and
 * the restore marker), the moves done cleanly, the recent sessions (four), one write — an upsert guarded by the ops it
 * read, so a write that raced another is refused rather than lost — and the reviewer sub-run's insert.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachProposals, plannedWorkouts } from "@rg/database";
import { docOriginRow, parseStoredWorkoutDoc, type WorkoutDoc } from "@rg/domain";
import type { DocIssue } from "@rg/workout";
import { LOCKED_CONTENT } from "../doc-workouts.js";
import { FROZEN_STATES } from "../workout-doc-store.js";
import {
  applyVerdict,
  designerResult,
  draftOf,
  NOTE_NOT_DONE,
  OPEN_PROPOSAL_STATUSES,
  proposalFields,
  REVIEW_ROUNDS,
  reviewerRunId,
  updateOps,
} from "../design-review.js";
import type { DesignReview, DesignTool, DraftForReview, OpReview, ToolContext, ToolErr, ToolOk } from "./types.js";
import {
  coachDoc,
  derivedSummary,
  docPlaceId,
  docValidateCtx,
  errorsLine,
  freeTextRefusal,
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

/** One designed workout of a proposal (spec §8). Task 8 applies it; the run view and the manifest read it. Its
 * top-level fields are the version the proposal holds: the best-scoring one reviewed so far (design-review.ts). */
export interface DocWorkoutOp {
  kind: "doc_workout";
  target: DocWorkoutTarget;
  /** The day it is for: the new workout's, or the revised workout's own. */
  date: string;
  time?: string;
  doc: WorkoutDoc;
  changeNote?: string;
  /** The independent review of the version held, for the athlete — with the rounds and what changed; null until one
   * is had (a review that couldn't be read is one: its `note` says the validator's view stands). */
  review: OpReview | null;
  /** The validator's warnings for the day: the costs shown beside Approve. */
  issues: Array<ReturnType<typeof issueOut>>;
  derived: Record<string, unknown>;
  /** The run that designed it. */
  by: { runId: string; role: "main" | "designer" };
  /** The model's call that proposed it: a replay of the call finds it. */
  toolUseId: string;
  /** The calls whose drafts this one replaced, without review (a replay of one of them writes nothing). */
  replaces?: string[];
  at: string;
  /** The version held's round of review (1-based). */
  round?: number;
  /** The version held's reviewer sub-run. */
  reviewRunId?: string;
  /** A later draft of the run's, while its review runs: held apart, so the version above stays the best so far. */
  candidate?: DraftVersion;
  /** One entry per draft sent for review, in order. */
  reviewLog?: ReviewRound[];
}

/** A draft as an op holds it beside the version it keeps (`candidate`). */
export interface DraftVersion {
  round: number;
  toolUseId: string;
  reviewRunId: string;
  target: DocWorkoutTarget;
  date: string;
  time?: string;
  doc: WorkoutDoc;
  changeNote?: string;
  issues: Array<ReturnType<typeof issueOut>>;
  derived: Record<string, unknown>;
  at: string;
}

/** One draft's round of review: under way, reviewed, or over without a review that could be read. */
export interface ReviewRound {
  round: number;
  toolUseId: string;
  reviewRunId: string;
  status: "reviewing" | "reviewed" | "unread";
  review?: DesignReview;
  mean?: number | null;
  /** Why there is no review (the op's note). */
  note?: string;
  changeNote?: string;
  /** Whether this round's version is the one the op holds, once judged. */
  kept?: boolean;
  /** A revision's line in the op's change list, once judged: what changed, and why it wasn't kept if it wasn't. */
  change?: string;
}

export type DesignProposalStatus = "unreviewed" | "pending" | "rehearsal";

/** The status propose writes: never `pending` — the main run's finish promotes a fully reviewed proposal. */
export function proposalStatusOf(rehearsal: boolean): Exclude<DesignProposalStatus, "pending"> {
  return rehearsal ? "rehearsal" : "unreviewed";
}

/** Statuses a design's proposal is still open in: a later draft may still change it. */
const OPEN = OPEN_PROPOSAL_STATUSES;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), date: dateField, time: z.string().regex(CLOCK, "must be a time like 17:30").optional() }).strict(),
  z.object({ kind: z.literal("revise"), workoutId: z.string().min(1).max(120), baseRev: z.number().int().min(0) }).strict(),
]);
const input = z.object({ doc: objectField, target, changeNote: z.string().trim().min(1).max(200).optional() }).strict();

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
  /** The row's current document, as stored (JSON text). */
  doc: string | null;
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
  statementCost: 8,
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
                'content', ${pw.contentState}, 'rev', ${pw.workoutDocRev}, 'archived', ${pw.archivedAt}, 'doc', ${pw.workoutDoc})
                from ${pw} where ${pw.id} = ${p.target.workoutId} and ${pw.userId} = ${ctx.userId})`
            : sql`null`,
      },
    });
    if (isErr(a)) return a;
    const today = a.athlete.today;
    const opsText = typeof a.extra.propOps === "string" ? a.extra.propOps : null;
    const ops = ((opsText ? parsedJson(opsText) : null) as DocWorkoutOp[] | null) ?? [];
    const status = typeof a.extra.propStatus === "string" ? a.extra.propStatus : null;
    const mine = ops.find((o) => o.by.runId === ctx.run.id);

    // A replay of this very call: what it stored, or its review — or, when a later draft of the run's replaced it, that.
    if (ctx.toolUseId) {
      const replayed = await replay(ctx, proposalId, ops, opsText, mine, ctx.toolUseId);
      if (replayed) return replayed;
    }

    if (status !== null && !(OPEN as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would change, and the athlete can ask again.");
    }
    if (typeof a.extra.restoring === "string" && a.extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the design can be asked for again once the restore is done.");
    }
    // A round still `reviewing` when a NEW call comes is one whose reviewer never got going (its call failed after
    // storing the draft): this run is stepping, so no reviewer of its is live, and a review that ended was settled when
    // the run resumed. It is no round: dropped, its draft with it.
    const kept = mine ? withoutAbandoned(mine) : undefined;
    // Two rounds at most (ruling 4): a third draft is never reviewed, so it is never proposed.
    const log = kept?.reviewLog ?? [];
    if (ctx.review && log.length >= REVIEW_ROUNDS) {
      return refuse(
        "rounds_done",
        `Two rounds of revision are done: ${REVIEW_ROUNDS} drafts were reviewed, and the proposal keeps the best-scoring one, with its review.`,
        "Call finish, with one plain line on what was proposed.",
      );
    }

    let date: string;
    let time: string | undefined;
    let base: WorkoutDoc | null = null;
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
      base = parseStoredWorkoutDoc(row.doc);
    }

    const free = freeTextRefusal(doc, base);
    if (free) return free;
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
    const issues = judged.warnings.slice(0, WARNINGS_SHOWN).map(issueOut);
    const draft: DraftForReview = {
      proposalId,
      target: draftTarget,
      date,
      doc: judged.doc,
      issues,
      derived,
      ...(p.changeNote ? { changeNote: p.changeNote } : {}),
    };
    const at = ctx.now.toISOString();
    const toolUseId = ctx.toolUseId ?? `call-${at}`;
    const version = {
      target: draftTarget,
      date,
      ...(time ? { time } : {}),
      doc: judged.doc,
      ...(p.changeNote ? { changeNote: p.changeNote } : {}),
      issues,
      derived,
      toolUseId,
      at,
    };
    const by: DocWorkoutOp["by"] = { runId: ctx.run.id, role: ctx.run.role === "designer" ? "designer" : "main" };

    let op: DocWorkoutOp;
    let replaced = false;
    const round = log.length + 1;
    const reviewRunId = reviewerRunId(ctx.run.id, round);
    const entry: ReviewRound = { round, toolUseId, reviewRunId, status: "reviewing", ...(p.changeNote ? { changeNote: p.changeNote } : {}) };
    if (ctx.review && kept?.review) {
      // A revision of a reviewed draft: held apart while its review runs; the op keeps the best so far.
      op = { ...kept, candidate: { ...version, round, reviewRunId }, reviewLog: [...log, entry] };
    } else if (ctx.review) {
      op = { kind: "doc_workout", ...version, review: null, by, round, reviewRunId, reviewLog: [...log, entry] };
    } else {
      // No reviewer here: a later draft replaces the earlier, unreviewed.
      op = { kind: "doc_workout", ...version, review: null, by };
      replaced = !!mine;
      if (mine) op.replaces = [...(mine.replaces ?? []), mine.toolUseId];
    }
    const next = [...ops.filter((o) => o.by.runId !== ctx.run.id), op];
    const written = await upsertProposal(ctx, proposalId, next, opsText, at);
    if (!written) {
      return refuse("proposal_changed", "The proposal changed while this draft was being stored.", "Call propose_workout again with the same draft.");
    }
    if (!ctx.review) return storedAnswer(proposalId, op, replaced);
    try {
      await ctx.review.start({ reviewRunId, proposalId, round, toolUseId, draft });
    } catch (e) {
      // Stored, never shown: unreviewed, it is never pending. The next call drops this round and starts afresh.
      console.error(JSON.stringify({ level: "error", msg: "propose_workout: the reviewer could not be started", error: e instanceof Error ? e.message : "unknown" }));
      return refuse("review_unavailable", "The draft is stored, but its reviewer couldn't be started.", "Call propose_workout again with the same draft.");
    }
    return reviewingAnswer(proposalId, { ...version, round, reviewRunId });
  },
};

/** The op without a round whose reviewer never got going: its log entry, and its draft when that was a candidate. */
function withoutAbandoned(op: DocWorkoutOp): DocWorkoutOp {
  const log = op.reviewLog ?? [];
  if (!log.some((r) => r.status === "reviewing")) return op;
  const { candidate, ...rest } = op;
  const keepCandidate = candidate && !log.some((r) => r.toolUseId === candidate.toolUseId && r.status === "reviewing");
  return { ...rest, ...(keepCandidate ? { candidate } : {}), reviewLog: log.filter((r) => r.status !== "reviewing") };
}

/**
 * A replay of the call `toolUseId` (a step that died after it ran), or null when it is not one. Its draft under
 * review: its reviewer is started if it never was (and the run pauses again); a reviewer that is over without a review
 * (this run is stepping, so its reviewer is not live) leaves the validator's view, written now. Its draft reviewed:
 * the review. A draft stored without review: what was stored; one a later draft replaced: that.
 */
async function replay(
  ctx: ToolContext,
  proposalId: string,
  ops: DocWorkoutOp[],
  opsText: string | null,
  mine: DocWorkoutOp | undefined,
  toolUseId: string,
): Promise<ToolOk | ToolErr | null> {
  const entry = mine?.reviewLog?.find((r) => r.toolUseId === toolUseId);
  if (mine && entry) {
    if (entry.status === "reviewing") {
      const draft = draftOf(mine, toolUseId, proposalId);
      if (ctx.review && draft && (await ctx.review.start({ reviewRunId: entry.reviewRunId, proposalId, round: entry.round, toolUseId, draft }))) {
        const v = mine.toolUseId === toolUseId ? mine : mine.candidate!;
        return reviewingAnswer(proposalId, { ...v, round: entry.round, reviewRunId: entry.reviewRunId });
      }
      const settled = applyVerdict(mine, toolUseId, { note: NOTE_NOT_DONE });
      if (!settled) return null;
      const written = await updateOps(ctx.db, ctx.userId, proposalId, ops.map((o) => (o === mine ? settled : o)), opsText);
      if (!written) return refuse("proposal_changed", "The proposal changed while this draft's review was being settled.", "Call propose_workout again with the same draft.");
      return reviewedAnswer(settled, toolUseId, ctx.now);
    }
    return reviewedAnswer(mine, toolUseId, ctx.now);
  }
  const stored = ops.find((o) => o.toolUseId === toolUseId);
  if (stored) return storedAnswer(proposalId, stored, false);
  if (ops.some((o) => o.replaces?.includes(toolUseId))) {
    return {
      data: { stored: true, proposalId, superseded: true, note: "a later draft from this run replaced this one" },
      summary: "An earlier draft, already replaced",
    };
  }
  return null;
}

/** The review of a draft, as its propose_workout call answers it. */
function reviewedAnswer(op: DocWorkoutOp, toolUseId: string, now: Date): ToolOk {
  return {
    data: designerResult(op, toolUseId) ?? { review: null, note: NOTE_NOT_DONE },
    provenance: { source: "the independent reviewer's review of this draft", asOf: now.toISOString() },
    summary: "The draft's review, again",
  };
}

/** A draft stored and sent for review: the run pauses until the review is in (the call's result, then). */
function reviewingAnswer(
  proposalId: string,
  v: { doc: WorkoutDoc; derived: Record<string, unknown>; date: string; time?: string; round: number; reviewRunId: string },
): ToolOk {
  const minutes = v.derived.minutes as number;
  return {
    data: { stored: true, proposalId, round: v.round, reviewRunId: v.reviewRunId, reviewing: true },
    summary: `${v.round > 1 ? "Revised" : "Draft"} — "${v.doc.title}": ${minutes} min — sent for review`,
    receipt: { proposalId, title: v.doc.title, date: v.date, ...(v.time ? { time: v.time } : {}), minutes, round: v.round, reviewed: false },
    control: "review",
  };
}

/** Why a workout can't be revised, or null when it can (doc-workouts.ts `reviseDocWorkout`'s own rules). */
function whyNotEditable(row: TargetRow): string | null {
  if (!docOriginRow(row)) {
    return row.origin === "program"
      ? "It is a programme's session: the programme's engine designs it, so its content can't be proposed."
      : "It isn't a Studio or template workout, so its content can't be proposed.";
  }
  if ((FROZEN_STATES as readonly string[]).includes(row.completion)) return `It is already ${row.completion}.`;
  if ((LOCKED_CONTENT as readonly (string | null)[]).includes(row.content)) return "Its session is already under way.";
  return null;
}

/**
 * Write the proposal with `ops`: made, or updated while it is still open and still holds the ops this call read
 * (`readOps`, null for none). One statement; false when nothing was written (another write came between).
 */
async function upsertProposal(ctx: ToolContext, id: string, ops: DocWorkoutOp[], readOps: string | null, at: string): Promise<boolean> {
  const status = proposalStatusOf(ctx.run.rehearsal);
  const { title, rationale, expiresAt } = proposalFields(ops);
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
