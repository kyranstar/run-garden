/**
 * propose_workout(doc, target, changeNote?) — a validated draft into the run's ONE proposal (Stage 3 spec §4, §5, §8;
 * principles §6.1, §6.2, §6.4). A designer proposes its workout; the main coach proposes only for now or later today
 * (for a week or the next few, designers do: ruling 4). The reviewer never proposes.
 *
 * FATAL ONLY WHEN WRONG — each refusal is teachable (what, why, how to fix) and writes nothing:
 *  - a day gone, in the athlete's own zone (`past_date`); a time today gone by (`past_time`); for later today, the main
 *    coach's new workout with no time (`needs_time`) or one less than 15 minutes ahead (`time_too_soon`) — each names
 *    the earliest time that works (design-time.ts; fix wave 3B, B-I1). A "now" design's workout for today is ALWAYS
 *    marked `atNow` — the approve places it at its own moment — with a floor (`notBefore`): the time the coach gave it
 *    (the op's `time` too), else the propose-time clock rounded up as the approve rounds (round 2, I2: the supersede
 *    then reads a session, never the whole day); a time already gone by is dropped, never refused (Task 13's fix wave,
 *    R1);
 *  - a revision of a workout that isn't there (`not_found`: unknown, archived, another athlete's), that can't change
 *    (`not_editable`: a programme's session — the programme's engine builds it — a completed, skipped or missed one, one
 *    under way), or from a stale base (`stale_base`, saying the current revision);
 *  - any error the validator raises for the day (`invalid_workout`): an unknown exercise, a condition's refusal, a
 *    malformed document. A move the day closes is refused even in a revision whose alternate the day allows: a
 *    proposal states what will be played, so the designer swaps it in this revision (the Studio's save lets the
 *    alternate stand in; a proposal never leans on that);
 *  - a run as a revision of a Studio or template workout (`run_unsupported`: designed runs, §8 §3 — a new run is
 *    judged as a run, with the athlete's running read in the athlete's statement), and an objective or key result id
 *    that isn't the athlete's (`unknown_objective`) — validate_workout refuses both the same way (act-common.ts);
 *  - a proposal already with the athlete (`proposal_pending`: the main run's finish made it pending; "call finish");
 *  - a revision of a workout another run of this design already revises (`target_taken`) — but not the first version a
 *    set's redo replaces (`ctx.replaces`) — or that a change of the proposal's skips or moves (adjust_plan, Task 8b);
 *  - a third draft from one run, once two rounds of review are done (`rounds_done`: ruling 4);
 *  - a draft whose minutes run past its own `setting.targetMinutes` by more than max(TOO_LONG_MIN_OVER, 15%) — before
 *    any review, using no round (`too_long`; Task 13's fix wave, §2.4: two of thirteen first drafts were sent to review
 *    far over the asked length);
 *  - a full revision of a reviewed draft whose review asked for nothing (`nothing_to_fix`, using no round; §2.3) — unless
 *    its changeNote names an open validator note's code: a text fix is an amend;
 *  - a changeNote past PROSE_CEILING × its cap (act-common.ts `prose`: it is kept whole up to there, as only a model
 *    reads it), saying its length.
 * Everything else — the validator's warnings — goes with the draft as its costs.
 *
 * AN AMEND (Task 13's fix wave, §2.2; audit 13a, A3): `amend: true` fixes the text of the run's reviewed draft — its
 * title, intent summary and notes, and any part's or move's why or cue (and an alternate's why) — without a review
 * round: the validator runs again, no reviewer is started, the review stands, and the changeNote joins the review's
 * changes (an `amended` entry in the review log, which counts as no round). Any other difference is refused
 * (`amend_not_text`), naming the first path that differs; a run with no reviewed draft has nothing to amend.
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
 * round is logged (`reviewLog`). REVIEW_ROUNDS drafts are reviewed at most (the draft and two revisions); a round
 * dropped because its reviewer gave no review is not one of them. A reviewer that can't be started drops the round at
 * once (`review_unavailable`). A replay of a call whose draft is under review starts its reviewer only if it never was
 * (the sub-run's id is the call's); one whose reviewer is over without a review is settled as the resume would settle
 * it (design-review.ts `settleNoReview`); one whose review is in answers it. Without the hooks (tests of this tool
 * alone), a later draft replaces the earlier and nothing is reviewed: the proposal never becomes pending.
 *
 * Nine statements at most: the athlete (with the gear, set-aside moves, recent sessions' ids, the focus areas, the
 * objectives' and key results' ids, the target row, the proposal and the restore marker), the moves done cleanly, the
 * recent sessions (four), one write — an upsert guarded by the ops it read and by the status it was written with, so a
 * write that raced another is refused rather than lost, and a proposal made pending meanwhile is never moved back to
 * unreviewed — the reviewer sub-run's insert, and, when the reviewer can't be started, the round dropped.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachProposals, plannedWorkouts } from "@rg/database";
import { docOriginRow, parseStoredWorkoutDoc, type WorkoutDoc } from "@rg/domain";
import type { DocIssue } from "@rg/workout";
import { LOCKED_CONTENT } from "../doc-workouts.js";
import { FROZEN_STATES } from "../workout-doc-store.js";
import {
  applyDrop,
  countedRounds,
  designerResult,
  draftOf,
  NOTE_NOT_DONE,
  OPEN_PROPOSAL_STATUSES,
  proposalFields,
  REVIEW_ROUNDS,
  reviewerRunId,
  settleNoReview,
  unavailableWhy,
  updateOps,
} from "../design-review.js";
import type { DesignReview, DesignTool, DraftForReview, OpReview, ToolContext, ToolErr, ToolOk } from "./types.js";
import {
  ASK_FOR_CHECK,
  capInWords,
  coachDoc,
  derivedSummary,
  docPlaceId,
  docValidateCtx,
  errorsLine,
  freeTextRefusal,
  holdsRun,
  idsRefusal,
  isErr,
  issueOut,
  judge,
  mainRunIdOf,
  noCheckToday,
  objectField,
  parseAct,
  prose,
  readDocAthlete,
  runCtxExtra,
  runUnsupported,
  WARNINGS_SHOWN,
  withFocusRefs,
  type CoachIssue,
  type DocAthlete,
} from "./act-common.js";
import { dateField, DATE_SCHEMA, parsedJson, refuse } from "./read-common.js";
import { isDocWorkoutOp, isPlanAdjustOp } from "../proposal-kinds.js";
import { clockIn, laterTodayRefusal, NOW_ROUND_MIN, pastTime, slotAtOrAfter } from "../design-time.js";

/** The one proposal of a main run's design. */
export const designProposalId = (mainRunId: string): string => `dp-${mainRunId}`;

/** Where a draft goes: a new workout (`atNow`: a "now" design's for today — placed at the moment of the approve, fix wave
 * 3B, B-I1 — never before `notBefore`, the time the coach gave it: Task 13's fix wave, R1), or a revision of one from the
 * revision read. */
export type DocWorkoutTarget =
  | { kind: "new"; date: string; time?: string; atNow?: true; notBefore?: string }
  | { kind: "revise"; workoutId: string; baseRev: number };

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
  /** A follow-up's (the new shape §5: `replaces`): the open suggestion of its conversation this workout replaces — superseded
   * when this one is made pending (design-orchestrate.ts `supersedeOlderPlans`). Kept through the draft's revisions. */
  supersedes?: string;
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

/** One draft's round of review: under way; reviewed; over with the validator's view (its reviewer had its turns and
 * gave no review it could be read by); or dropped (its reviewer gave none at all, or the run stopped first) — a dropped
 * round counts against nothing. Or an AMEND of the version held (`amended`, Task 13's fix wave §2.2: its text fixed,
 * no review, no round): its `round` is the version it amended, its `change` the line the review's changes keep. */
export interface ReviewRound {
  round: number;
  toolUseId: string;
  reviewRunId: string;
  status: "reviewing" | "reviewed" | "unread" | "dropped" | "amended";
  /** A revision's: the version the op held when it was judged, and that version's mean. */
  against?: { round: number; mean: number | null };
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
/** A change note's cap: kept whole up to PROSE_CEILING × this (only a model reads it whole). */
export const CHANGE_NOTE_MAX = 200;
/** A draft is too long when its minutes pass its own target by more than this, or by 15% of the target if more. */
export const TOO_LONG_MIN_OVER = 5;
export const TOO_LONG_SHARE_OVER = 0.15;
const input = z
  .object({ doc: objectField, target, changeNote: prose(CHANGE_NOTE_MAX).optional(), amend: z.boolean().optional(), replaces: z.string().trim().min(1).max(200).optional() })
  .strict();

/** The guidance for a draft the validator refused: today, a move the day closes is swapped in the draft itself — or,
 * with no check logged yet, the main coach may ask for one (fix wave 3A round 2, B-M8). */
function invalidFix(errors: readonly CoachIssue[], today: boolean, noCheck: boolean): string {
  const closedToday = errors.some((e) => e.code === "condition_gate" || e.code === "condition_pattern");
  if ((closedToday || errors.some((e) => e.code === "condition_never")) && today) {
    return `Swap each move the day closes for one it allows, in this draft (an alternate doesn't stand in on a proposal), then propose again${closedToday && noCheck ? `; or, ${ASK_FOR_CHECK}` : ""}.`;
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
    "The main coach (now or later today) and designers: a draft and where it goes — a new workout on a date, or a revision of one from its current revision. Errors, or minutes well past its own targetMinutes, refuse it using no round; then an independent review, revisions too (the better-scoring version is kept). A text-only fix of a reviewed draft is amend: true — no new review.",
  inputSchema: {
    type: "object",
    properties: {
      // The document's full schema is validate_workout's (sent once, so the cached tool list carries it once).
      doc: { type: "object", description: "The draft: a workout document exactly as validate_workout takes it." },
      target: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "new" },
              date: DATE_SCHEMA,
              time: {
                type: "string",
                description: "HH:MM, the athlete's local time; never one already past (later today: required, 15+ minutes ahead). Now: leave it out unless the athlete named a time — a now workout is placed when it is approved, and a time given is only its earliest. Scope yours to choose: left out today is right now; a time today is 15+ minutes ahead.",
              },
            },
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
      changeNote: { type: "string", description: `What changed from your last draft, and why (a revision, or an amend): ${capInWords(CHANGE_NOTE_MAX)}.` },
      replaces: {
        type: "string",
        description:
          "The main coach's, in a conversation: the id of an open suggestion this one changes (the conversation so far lists them) — it is replaced once this one is ready.",
      },
      amend: {
        type: "boolean",
        description:
          "true: fix only the text of your reviewed draft — title, intent.summary, notes, a part's or a move's why or cue, an alternate's why — the same target, moves and doses. No review round: the review stands and changeNote joins its changes. Any other change needs a full revision.",
      },
    },
    required: ["doc", "target"],
    additionalProperties: false,
  },
  statementCost: 9,
  cpuWeight: 1.6,
  roles: ["main", "designer"],
  async run(ctx, raw) {
    const p = parseAct(input, raw, "doc (a workout document), target ({ kind: new, date, time? } or { kind: revise, workoutId, baseRev }) and optionally changeNote and amend");
    if (isErr(p)) return p;
    // An auto run's main coach (the new shape §5) designs one workout itself, as now or later today does.
    if (ctx.run.role === "main" && ctx.run.scope.kind !== "now" && ctx.run.scope.kind !== "later_today" && ctx.run.scope.kind !== "auto") {
      return refuse(
        "not_for_scope",
        "For a week or the next few workouts, each workout's designer proposes it; the main coach plans the set.",
        "Call plan_set with one brief per workout, then judge the set and finish.",
      );
    }
    // A follow-up's name is the main coach's: a set's designer drafts its brief, never another suggestion's change.
    if (p.replaces !== undefined && ctx.run.role !== "main") {
      return refuse("not_for_role", "replaces is the main coach's: a set's designer drafts its brief.", "Call propose_workout again without replaces.");
    }
    const mainRunId = mainRunIdOf(ctx);
    if (!mainRunId) return refuse("no_main_run", "This designer run has no main run to propose into.", "Finish with what you have.");
    const proposalId = designProposalId(mainRunId);
    const submitted = coachDoc(p.doc, mainRunId);
    // A run is a new workout, never a revision of a Studio or template one (designed runs, §8 §3).
    const run = holdsRun(submitted);
    if (run && p.target.kind === "revise") return runUnsupported();
    const pw = plannedWorkouts;
    const a = await readDocAthlete(ctx, {
      placeId: docPlaceId(submitted),
      extras: {
        ...(run && p.target.kind === "new" ? runCtxExtra(ctx, p.target.date) : {}),
        propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
        propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
        restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
        targetRow:
          p.target.kind === "revise"
            ? sql`(select json_object('date', ${pw.effectiveDate}, 'time', ${pw.effectiveTime}, 'origin', ${pw.origin}, 'completion', ${pw.completionState},
                'content', ${pw.contentState}, 'rev', ${pw.workoutDocRev}, 'archived', ${pw.archivedAt}, 'doc', ${pw.workoutDoc})
                from ${pw} where ${pw.id} = ${p.target.workoutId} and ${pw.userId} = ${ctx.userId})`
            : sql`null`,
        replaced: p.replaces !== undefined ? replacedSql(ctx.userId, p.replaces) : sql`null`,
      },
    });
    if (isErr(a)) return a;
    const today = a.athlete.today;
    const doc = withFocusRefs(submitted, a.focusAreas);
    const opsText = typeof a.extra.propOps === "string" ? a.extra.propOps : null;
    // Every op the proposal holds (a change by adjust_plan among them, Task 8b): this run's work is its designed workouts,
    // and every other op is written back as it was read.
    const all = ((opsText ? parsedJson(opsText) : null) as unknown[] | null) ?? [];
    const ops = all.filter(isDocWorkoutOp) as DocWorkoutOp[];
    const status = typeof a.extra.propStatus === "string" ? a.extra.propStatus : null;
    const mine = ops.find((o) => o.by.runId === ctx.run.id);

    // A replay of this very call: what it stored, or its review — or, when a later draft of the run's replaced it, that.
    if (ctx.toolUseId) {
      const replayed = await replay(ctx, proposalId, all, opsText, mine, ctx.toolUseId);
      if (replayed) return replayed;
    }

    // The main run's finish made it pending: it is the athlete's to approve now, and nothing this run drafts changes it.
    if (status === "pending") return refuse("proposal_pending", "Your proposal is already with the athlete.", "Call finish.");
    if (status !== null && !(OPEN as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would change, and the athlete can ask again.");
    }
    if (typeof a.extra.restoring === "string" && a.extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the design can be asked for again once the restore is done.");
    }
    // A round still `reviewing` when a NEW call comes is one whose reviewer never got going (its call failed after
    // storing the draft): this run is stepping, so no reviewer of its is live, and a review that ended was settled when
    // the run resumed. It is no round: dropped, its draft with it.
    // A follow-up's (the new shape §5): the suggestion it names must be one it may replace — read with the athlete.
    if (p.replaces !== undefined) {
      const refused = replacesRefusal(p.replaces, a.extra.replaced, { own: proposalId, conversationId: ctx.run.conversationId });
      if (refused) return refused;
    }
    const kept = mine ? withoutAbandoned(mine) : undefined;
    // An amend: the reviewed draft's text fixed, no round, no reviewer (§2.2) — whatever rounds are left.
    if (p.amend) return amendDraft(ctx, { a, doc, target: p.target, changeNote: p.changeNote, replaces: p.replaces, kept, all, opsText, proposalId, today });
    // The draft and two revisions at most (ruling 4): a further draft is never reviewed, so it is never proposed.
    const log = kept?.reviewLog ?? [];
    if (ctx.review && countedRounds(log) >= REVIEW_ROUNDS) {
      return refuse(
        "rounds_done",
        `${REVIEW_ROUNDS - 1} rounds of revision are done: ${REVIEW_ROUNDS} drafts were reviewed, and the proposal keeps the best-scoring one, with its review.`,
        "Call finish, with one plain line on what was proposed.",
      );
    }
    // A full revision of a reviewed draft costs a round: only when something must change (§2.3) — a must-fix of its
    // review, or an open validator note the changeNote names.
    const held = kept ? log.find((r) => r.toolUseId === kept.toolUseId) : undefined;
    if (ctx.review && kept?.review && held?.status === "reviewed" && kept.review.mustFix.length === 0 && !namesOpenNote(p.changeNote, kept.issues)) {
      const open = [...new Set(kept.issues.map((i) => i.code))];
      return refuse(
        "nothing_to_fix",
        "Nothing must change in the reviewed draft: call finish — or propose_workout with amend: true for text-only fixes. A full revision costs a review round; it is allowed when changeNote names an open validator note's code.",
        open.length > 0
          ? `Call finish; or amend the text; or name the note the revision fixes in changeNote (open: ${open.join(", ")}).`
          : "Call finish; or amend the text with amend: true.",
      );
    }

    let date: string;
    let time: string | undefined;
    let base: WorkoutDoc | null = null;
    /** A "now" design's workout for today: placed at the moment of the approve (B-I1), its time a floor (R1). */
    let atNow = false;
    /** A now design's floor (`notBefore`). */
    let nowFloor: string | undefined;
    if (p.target.kind === "new") {
      date = p.target.date;
      time = p.target.time;
      if (date < today) return refuse("past_date", `${date} is before today (${today}) where the athlete is.`, "Propose it for today or a later day.");
      // Never a time already past (fix wave 3B, B-I1; design-time.ts): later today's needs one 15 minutes ahead.
      const clock = clockIn(a.athlete.tz, ctx.now);
      // An auto run's (the new shape §5): today with no time is right now; a time it picks today is held as later today's.
      const auto = ctx.run.role === "main" && ctx.run.scope.kind === "auto";
      const later =
        ctx.run.role === "main" && (ctx.run.scope.kind === "later_today" || (auto && date === today && time !== undefined)) ? laterTodayRefusal(date, time, clock) : null;
      if (later) return refuse(later.error, later.why, later.fix);
      const gone = pastTime(date, time, clock);
      // A now design for today floats: placed when it is approved, its time (if still ahead) only a floor (R1).
      atNow = ctx.run.role === "main" && (ctx.run.scope.kind === "now" || (auto && time === undefined)) && date === today;
      if (atNow && gone) time = undefined;
      // Its floor always (round 2, I2): the coach's time, else this clock rounded up as the approve rounds — so the
      // supersede reads a session at a time, never a whole day (an evening one included).
      if (atNow) nowFloor = time ?? slotAtOrAfter(clock.minutes, NOW_ROUND_MIN) ?? undefined;
      if (!atNow && gone) return refuse("past_time", gone, "Give a time later today, or leave the time out: an untimed workout goes to the athlete's usual time, or the next free slot once that has passed.");
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
      // A set's redo may revise what the first version it replaces revises: that op stands only until this one is
      // reviewed (design-orchestrate.ts), so it never takes the workout from it.
      if (ops.some((o) => o.by.runId !== ctx.run.id && o.by.runId !== ctx.replaces && o.target.kind === "revise" && o.target.workoutId === workoutId)) {
        return refuse("target_taken", "Another workout of this design already revises that workout.", "Propose a new workout, or revise a different one.");
      }
      if (all.some((o) => isPlanAdjustOp(o) && o.op.workoutId === workoutId)) {
        return refuse("target_taken", "adjust_plan already changes that workout in this proposal.", "Revise a different workout, or propose a new one.");
      }
      date = row.date;
      time = row.time;
      base = parseStoredWorkoutDoc(row.doc);
    }

    const free = freeTextRefusal(doc, base);
    if (free) return free;
    const ids = idsRefusal(doc, a);
    if (ids) return ids;
    const vctx = await docValidateCtx(ctx, a, date);
    const judged = judge(doc, vctx, { keyResults: a.keyResultMeasures });
    if (judged.errors.length > 0 || !judged.doc || !judged.derived) {
      return refuse("invalid_workout", errorsLine(judged.errors), invalidFix(judged.errors, date === today, noCheckToday(vctx)));
    }
    // Well past its own target length: trimmed or explained before any review, using no round (§2.4).
    const long = tooLong(judged.derived.estimatedMinutes, judged.doc.setting?.targetMinutes);
    if (long) return long;

    const draftTarget: DocWorkoutTarget =
      p.target.kind === "new"
        ? atNow
          ? { kind: "new", date, atNow: true as const, ...(nowFloor ? { notBefore: nowFloor } : {}) }
          : { kind: "new", date, ...(time ? { time } : {}) }
        : { kind: "revise", workoutId: p.target.workoutId, baseRev: p.target.baseRev };
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
    const round = countedRounds(log) + 1;
    const reviewRunId = reviewerRunId(ctx.run.id, toolUseId);
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
    // The suggestion a follow-up replaces (the new shape §5): this call's name, else its earlier draft's — kept through
    // the revisions.
    const supersedes = p.replaces ?? mine?.supersedes;
    if (supersedes) op = { ...op, supersedes };
    const next = [...all.filter((o) => !isDocWorkoutOp(o) || (o as DocWorkoutOp).by.runId !== ctx.run.id), op];
    const written = await upsertProposal(ctx, proposalId, next, opsText, at);
    if (!written) {
      return refuse("proposal_changed", "The proposal changed while this draft was being stored.", "Call propose_workout again with the same draft.");
    }
    if (!ctx.review) return storedAnswer(proposalId, op, replaced);
    let started = false;
    try {
      started = await ctx.review.start({ reviewRunId, proposalId, round, toolUseId, draft });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "propose_workout: the reviewer could not be started", error: e instanceof Error ? e.message : "unknown" }));
    }
    if (!started) {
      // No reviewer (it couldn't be inserted, or one under this call's id is already there): the round is dropped now,
      // so it counts against nothing, and the draft — unreviewed — is never shown.
      const dropped = applyDrop(op, toolUseId);
      if (dropped) await updateOps(ctx.db, ctx.userId, proposalId, next.map((o) => (o === op ? dropped : o)), JSON.stringify(next));
      return notStarted();
    }
    return reviewingAnswer(proposalId, { ...version, round, reviewRunId });
  },
};

/**
 * The suggestion a follow-up names (the new shape §5), as one subquery of the athlete's read: its status, its designed
 * workouts and changes, the conversation its run is a turn of, and whether that run planned a set (a set's own scope,
 * or an auto run that raised its ceiling for one — design-orchestrate.ts `setRunSql`, written here: it imports this).
 */
function replacedSql(userId: string, id: string) {
  const kindIs = (k: string) => sql.raw(`json_extract(o.value, '$.kind') = '${k}'`);
  return sql`(select json_object('status', p.status,
      'workouts', (select count(*) from json_each(p.ops) o where ${kindIs("doc_workout")}),
      'changes', (select count(*) from json_each(p.ops) o where ${kindIs("plan_adjust")} or ${kindIs("plan_structure")}),
      'conversation', (select coalesce(case when json_valid(r.state) then json_extract(r.state, '$.settings.conversationId') end, r.id)
        from coach_runs r where r.id = substr(p.id, 4) and r.user_id = p.user_id),
      'set', (select count(*) from coach_runs r where r.id = substr(p.id, 4) and r.user_id = p.user_id and json_valid(r.scope)
        and (json_extract(r.scope, '$.kind') in ('week', 'next_n') or (json_extract(r.scope, '$.kind') = 'auto' and json_valid(r.state)
          and json_extract(r.state, '$.settings.raisedAt') is not null))))
    from ${coachProposals} p where p.id = ${id} and p.user_id = ${userId} and substr(p.id, 1, 3) = 'dp-' and json_valid(p.ops))`;
}

/**
 * Why a follow-up can't replace the suggestion it names, in words; null when it can: an open single-workout suggestion
 * of the athlete's in this conversation — pending (nothing in it decided), one designed workout and no change to the
 * plan, never a set's, never this design's own.
 */
function replacesRefusal(id: string, raw: unknown, o: { own: string; conversationId: string | undefined }): ToolErr | null {
  const r = parsedJson(raw) as { status?: unknown; workouts?: unknown; changes?: unknown; conversation?: unknown; set?: unknown } | null;
  const no = (why: string) =>
    refuse(
      "replaces_not_open",
      `replaces ${JSON.stringify(id)}: ${why}`,
      "Leave replaces out to suggest it beside what is open — or name an open suggestion of this conversation by its id (the conversation so far lists them).",
    );
  if (id === o.own) return no("that is this design's own suggestion — revise your draft instead.");
  if (!r) return no("no suggestion of the athlete's has that id.");
  if (r.status !== "pending") return no(`that suggestion is ${String(r.status)}: only one still open, nothing in it decided, is replaced.`);
  if (Number(r.set) > 0) return no("that is a week's plan: a set is changed by planning it again.");
  if (Number(r.workouts) !== 1 || Number(r.changes) > 0) return no("that suggestion isn't one workout alone: only a single workout with no change to the plan is replaced.");
  if (!o.conversationId || r.conversation !== o.conversationId) return no("that suggestion is from another conversation.");
  return null;
}

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
  /** Every op the proposal holds: what a write puts back. */
  ops: unknown[],
  opsText: string | null,
  mine: DocWorkoutOp | undefined,
  toolUseId: string,
): Promise<ToolOk | ToolErr | null> {
  const entry = mine?.reviewLog?.find((r) => r.toolUseId === toolUseId);
  // An amend this call made: what it stored (the op holds it) — nothing written twice.
  if (mine && entry?.status === "amended") return amendedAnswer(proposalId, mine);
  if (mine && entry) {
    if (entry.status === "reviewing") {
      const draft = draftOf(mine, toolUseId, proposalId);
      let started = false;
      if (ctx.review && draft) {
        try {
          started = await ctx.review.start({ reviewRunId: entry.reviewRunId, proposalId, round: entry.round, toolUseId, draft });
        } catch (e) {
          // As on the first call: a reviewer that can't be started drops the round, and the draft is never shown.
          console.error(JSON.stringify({ level: "error", msg: "propose_workout: the reviewer could not be started", error: e instanceof Error ? e.message : "unknown" }));
          const dropped = applyDrop(mine, toolUseId);
          if (dropped) await updateOps(ctx.db, ctx.userId, proposalId, ops.map((o) => (o === mine ? dropped : o)), opsText);
          return notStarted();
        }
      }
      if (started) {
        const v = mine.toolUseId === toolUseId ? mine : mine.candidate!;
        return reviewingAnswer(proposalId, { ...v, round: entry.round, reviewRunId: entry.reviewRunId });
      }
      // Its reviewer is over (this run is stepping, so it is not live) and left no review: settled as the resume would.
      const error = ctx.review?.ended(entry.reviewRunId)?.error ?? null;
      const settled = settleNoReview(mine, toolUseId, error);
      if (!settled) return null;
      const written = await updateOps(ctx.db, ctx.userId, proposalId, ops.map((o) => (o === mine ? settled.op : o)), opsText);
      if (!written) return refuse("proposal_changed", "The proposal changed while this draft's review was being settled.", "Call propose_workout again with the same draft.");
      return reviewedAnswer(settled.op, toolUseId, ctx.now, unavailableWhy(error));
    }
    return reviewedAnswer(mine, toolUseId, ctx.now);
  }
  const docs = ops.filter(isDocWorkoutOp) as DocWorkoutOp[];
  const stored = docs.find((o) => o.toolUseId === toolUseId);
  if (stored) return storedAnswer(proposalId, stored, false);
  if (docs.some((o) => o.replaces?.includes(toolUseId))) {
    return {
      data: { stored: true, proposalId, superseded: true, note: "a later draft from this run replaced this one" },
      summary: "An earlier draft, already replaced",
    };
  }
  return null;
}

/** A draft whose reviewer couldn't be started: its round dropped, the draft unreviewed and never shown. */
function notStarted(): ToolErr {
  return refuse(
    "review_unavailable",
    `The draft couldn't be sent for review (${unavailableWhy("not_started")}): it isn't reviewed and doesn't count as a round.`,
    "Call propose_workout again with the same draft — or finish: an unreviewed draft is never shown.",
  );
}

/** The review of a draft, as its propose_workout call answers it. */
function reviewedAnswer(op: DocWorkoutOp, toolUseId: string, now: Date, why?: string): ToolOk {
  return {
    data: designerResult(op, toolUseId, why) ?? { review: null, note: NOTE_NOT_DONE },
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
 * Write the proposal with `ops`: made, or updated while it still has the status this call writes — unreviewed (a
 * rehearsal's, rehearsal), never pending: the finish made that one the athlete's, and a draft never moves it back — and
 * still holds the ops this call read (`readOps`, null for none). One statement; false when nothing was written (another
 * write came between). adjust_plan writes its changes through it too (Task 8b).
 */
export async function upsertProposal(ctx: ToolContext, id: string, ops: readonly unknown[], readOps: string | null, at: string): Promise<boolean> {
  const status = proposalStatusOf(ctx.run.rehearsal);
  const { title, rationale, expiresAt } = proposalFields(ops);
  const json = JSON.stringify(ops);
  const rows = (await ctx.db.all(sql`
    INSERT INTO coach_proposals (id, user_id, plan_id, title, evidence, rationale, flags, ops, status, created_at, expires_at)
    VALUES (${id}, ${ctx.userId}, NULL, ${title}, '', ${rationale}, '[]', ${json}, ${status}, ${at}, ${expiresAt})
    ON CONFLICT (id) DO UPDATE SET title = excluded.title, rationale = excluded.rationale, ops = excluded.ops,
      expires_at = excluded.expires_at
    WHERE coach_proposals.user_id = excluded.user_id AND coach_proposals.status = excluded.status
      AND coach_proposals.ops IS ${readOps}
    RETURNING id
  `)) as Array<{ id: string }>;
  return rows.length > 0;
}

/** Whether a change note names the code of one of the held draft's open validator notes (§2.3: a revision that fixes
 * it may spend a round). */
function namesOpenNote(changeNote: string | undefined, issues: ReadonlyArray<{ code: string }>): boolean {
  if (!changeNote) return false;
  const said = changeNote.toLowerCase();
  return issues.some((i) => said.includes(i.code.toLowerCase()));
}

/** A draft whose minutes pass its own target by more than max(TOO_LONG_MIN_OVER, 15%): refused (§2.4); else null. */
export function tooLong(minutes: number, target: number | undefined): ToolErr | null {
  if (typeof target !== "number" || !(target > 0) || !Number.isFinite(minutes)) return null;
  if (minutes - target <= Math.max(TOO_LONG_MIN_OVER, target * TOO_LONG_SHARE_OVER)) return null;
  return refuse(
    "too_long",
    `${Math.round(minutes)} min against its target ${target}: trim it, or raise the target and say why in notes.`,
    `Trim parts, sets or holds until it is near ${target} min — or raise setting.targetMinutes and say why in notes. It used no round.`,
  );
}

/** The text an amend may change (§2.2), as document paths: the title, the intent's summary, the notes, a part's or a
 * move's why and cue, an alternate's why. */
const AMENDABLE: readonly RegExp[] = [
  /^title$/,
  /^intent\.summary$/,
  /^notes$/,
  /^parts\[\d+\]\.(why|cue)$/,
  /^parts\[\d+\]\.items\[\d+\]\.(why|cue)$/,
  /^parts\[\d+\]\.items\[\d+\]\.alternates\[\d+\]\.why$/,
];

/** The first path at which `b` differs from `a` other than in amendable text, or null when only text differs. */
export function firstNonTextDiff(a: unknown, b: unknown, path = ""): string | null {
  if (path && AMENDABLE.some((r) => r.test(path))) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) return `${path}[${i}]`;
      const d = firstNonTextDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstNonTextDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return Object.is(a, b) ? null : path || "doc";
}

/**
 * An amend (§2.2): the run's reviewed draft with its text fixed — judged again (an error refuses it as a draft's would),
 * no reviewer, no round; the review stands and the changeNote joins its changes. Beyond the athlete's read: the
 * validator's context (five at most) and the proposal's write — within propose's declared cost.
 */
async function amendDraft(
  ctx: ToolContext,
  o: {
    a: DocAthlete;
    doc: Record<string, unknown>;
    target: z.infer<typeof target>;
    changeNote: string | undefined;
    /** The suggestion it names (`replaces`, checked by the caller): kept on the op, as a draft's is (the review, M5). */
    replaces: string | undefined;
    kept: DocWorkoutOp | undefined;
    all: unknown[];
    opsText: string | null;
    proposalId: string;
    today: string;
  },
): Promise<ToolOk | ToolErr> {
  const { kept } = o;
  if (!kept || !kept.review) {
    return refuse(
      "nothing_to_amend",
      "There is no reviewed draft of yours to amend: an amend fixes the text of a draft that has its review.",
      "Propose the draft without amend: it is reviewed first.",
    );
  }
  const sameTarget =
    o.target.kind === "new"
      ? kept.target.kind === "new" && o.target.date === kept.date
      : kept.target.kind === "revise" && o.target.workoutId === kept.target.workoutId;
  if (!sameTarget) {
    return refuse("amend_not_text", "target differs from the reviewed draft's: an amend changes text only.", "Keep the reviewed draft's target — or propose a full revision without amend.");
  }
  const free = freeTextRefusal(o.doc, kept.doc);
  if (free) return free;
  const ids = idsRefusal(o.doc, o.a);
  if (ids) return ids;
  const vctx = await docValidateCtx(ctx, o.a, kept.date);
  const judged = judge(o.doc, vctx, { keyResults: o.a.keyResultMeasures });
  if (judged.errors.length > 0 || !judged.doc || !judged.derived) {
    return refuse("invalid_workout", errorsLine(judged.errors), invalidFix(judged.errors, kept.date === o.today, noCheckToday(vctx)));
  }
  const diff = firstNonTextDiff(kept.doc, judged.doc);
  if (diff) {
    return refuse(
      "amend_not_text",
      `${diff} differs from the reviewed draft: an amend changes only the title, intent.summary, notes, and a part's or a move's why or cue.`,
      "Put it back as reviewed and amend the text alone — or, if it must change, propose a full revision without amend (a review round).",
    );
  }
  const toolUseId = ctx.toolUseId ?? `call-${ctx.now.toISOString()}`;
  const note = o.changeNote ?? "Clearer wording.";
  const change = `${note.replace(/[\s.;:]+$/, "")}.`;
  const entry: ReviewRound = { round: kept.round ?? 1, toolUseId, reviewRunId: kept.reviewRunId ?? "", status: "amended", changeNote: note, change };
  const op: DocWorkoutOp = {
    ...kept,
    doc: judged.doc,
    issues: judged.warnings.slice(0, WARNINGS_SHOWN).map(issueOut),
    derived: derivedSummary(judged.derived),
    reviewLog: [...(kept.reviewLog ?? []), entry],
    review: { ...kept.review, changes: [...kept.review.changes, change] },
    ...(o.replaces ? { supersedes: o.replaces } : {}),
  };
  const next = [...o.all.filter((x) => !isDocWorkoutOp(x) || (x as DocWorkoutOp).by.runId !== ctx.run.id), op];
  const written = await upsertProposal(ctx, o.proposalId, next, o.opsText, ctx.now.toISOString());
  if (!written) return refuse("proposal_changed", "The proposal changed while this amend was being stored.", "Call propose_workout again with the same amend.");
  return amendedAnswer(o.proposalId, op);
}

/** An amend, as its call answers it: stored, with what the validator now says of the draft. */
function amendedAnswer(proposalId: string, op: DocWorkoutOp): ToolOk {
  return {
    data: { stored: true, amended: true, proposalId, derived: op.derived, issues: op.issues },
    summary: `Polished the wording — "${op.doc.title}"`,
    receipt: { proposalId, title: op.doc.title, date: op.date, ...(op.time ? { time: op.time } : {}), minutes: op.derived.minutes, amended: true },
  };
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
