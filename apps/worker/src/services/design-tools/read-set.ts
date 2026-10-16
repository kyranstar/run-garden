/**
 * read_set() — the set so far, read from the main run's ONE proposal (Stage 3 spec §6; principles §6.9;
 * design-orchestrate.ts): the proposal's workouts in date order, each with its op id, where it goes (`target`: a new
 * workout, or a revision of one), what is derived from its document (minutes, discipline, category, mode, balance, top
 * regions), its effort, intent, parts (their purposes, in order) and moves (library ids), and its review in summary (the
 * mean, the low scores, the must-fix items, the rounds); the set's combined balance (`deriveDoc` over the documents,
 * summed, in read_balance's units — what the set adds, beside what read_balance says was done); hard days in a row (two
 * workouts of the set that develop or peak on consecutive days); and the moves repeated on consecutive days
 * (progression and variety, and the same tissues two days running). Runs and programme sessions around them are
 * read_plan's. The proposal's lines (`notes`) carry model-written words — a title, a reason — so they come marked. The
 * main coach's changes to sessions already on the plan (adjust_plan's, Task 8b) are listed apart (`planChanges`: the
 * session, the change and the coach's why, marked): never a designer's work, never one of the set's workouts.
 *
 * Every role reads it (audit I7; the lead's ruling for 3A): the main coach judges its set (each workout with its key,
 * from its plan's rounds); a set's designer reads its siblings before it drafts, so it can vary from the days either
 * side (its parent's proposal; its own workout marked `yours`, and a redo's designer the first version it redoes marked
 * `firstVersion`); a reviewer reads the set of the draft it reviews (the proposal it reviews for; the workout under
 * review marked `underReview`, and shown as the draft under review — a revision, not the version the proposal holds).
 *
 * Small by contract: one statement (the proposal), and an answer within RESULT_BUDGET_BYTES — the details give way, in
 * order, before any workout does (the intent sentences, then the parts, then the moves, then the must-fix wording, then
 * the regions, then the repeated moves' names — counted instead).
 */
import { z } from "zod";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc, type BalanceProfile } from "@rg/workout";
import { REVIEW_DIMENSIONS } from "../design-prompt.js";
import { balanceInUnits, hardPairs, movesOf, opIdOf, readSetProposal, repeatsOnConsecutiveDays, reviewMeanOf } from "../design-orchestrate.js";
import { isErr, parseAct } from "./act-common.js";
import { designProposalId, type DocWorkoutOp } from "./propose.js";
import type { PlanAdjustOp } from "../proposal-kinds.js";
import { answer, RESULT_BUDGET_BYTES, untrusted } from "./read-common.js";
import type { DesignTool } from "./types.js";

const input = z.object({}).strict();

const TITLE_MAX = 80;
const INTENT_MAX = 160;
const MUST_FIX_SHOWN = 2;
const MUST_FIX_MAX = 120;
const NOTES_SHOWN = 6;
const NOTE_MAX = 200;
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** How much of each workout is shown: 0 all; 1 without the intent; 2 nor the parts; 3 nor the moves; 4 the must-fix
 * items counted only; 5 no regions; 6 the moves repeated on consecutive days counted, not listed. */
type Detail = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const DETAILS: readonly Detail[] = [0, 1, 2, 3, 4, 5, 6];

/**
 * Whose view it is (fix wave 3A round 2, B-M5): the main coach's (each workout with its key); a designer's (its own
 * workout marked `yours`, and a redo's designer the first version it redoes, `firstVersion`); a reviewer's (the
 * workout under review marked `underReview` — never `yours`: it designed none — and shown as the draft under review: a
 * revision's reviewer sees the revision, held beside the version the proposal keeps, never that version).
 */
type View =
  | { role: "main"; keyOf: ReadonlyMap<string, string> }
  | { role: "designer"; yours: string; firstVersion: string | null }
  | { role: "reviewer"; underReview: string | null; toolUseId: string | null };

/** The op as this view sees it: for a reviewer, the workout under review as the draft it reviews (its candidate, while
 * a revision is under review — read with the op, no statement more), its review not in yet. */
function asSeen(op: DocWorkoutOp, view: View): DocWorkoutOp {
  const c = op.candidate;
  if (view.role !== "reviewer" || op.by?.runId !== view.underReview || !c || c.toolUseId !== view.toolUseId) return op;
  const { time: _held, ...rest } = op;
  return { ...rest, target: c.target, date: c.date, ...(c.time ? { time: c.time } : {}), doc: c.doc, derived: c.derived, review: null };
}

/** The view's marks on a workout: the main coach's key; a designer's `yours` and `firstVersion`; a reviewer's
 * `underReview`. */
function marks(opId: string, view: View): Record<string, unknown> {
  if (view.role === "main") return { key: view.keyOf.get(opId) ?? null };
  if (view.role === "designer") return { yours: opId === view.yours, ...(view.firstVersion !== null && opId === view.firstVersion ? { firstVersion: true } : {}) };
  return { underReview: opId === view.underReview };
}

/** A workout's parts, by purpose, in order. */
const partsOf = (op: DocWorkoutOp): string[] => (op.doc?.parts ?? []).map((p) => p.purpose);

function workoutOf(op: DocWorkoutOp, view: View, detail: Detail): Record<string, unknown> {
  const d = op.derived ?? {};
  const r = op.review;
  const low = r
    ? Object.fromEntries(
        REVIEW_DIMENSIONS.flatMap((x): Array<[string, number]> => {
          const v = r.scores?.[x.id];
          return typeof v === "number" && v <= 3 ? [[x.id, v]] : [];
        })
          .sort((a, b) => a[1] - b[1])
          .slice(0, 3),
      )
    : {};
  const regions = Object.fromEntries(Object.entries((d.regions as Record<string, number> | undefined) ?? {}).slice(0, 3));
  const opId = opIdOf(op);
  return {
    opId,
    ...marks(opId, view),
    date: op.date,
    ...(op.time ? { time: op.time } : {}),
    target: op.target,
    title: untrusted(cut(op.doc.title, TITLE_MAX)),
    ...(detail < 1 ? { intent: untrusted(cut(op.doc.intent.summary, INTENT_MAX)) } : {}),
    ...(detail < 2 ? { parts: partsOf(op) } : {}),
    ...(detail < 3 ? { moves: movesOf(op) } : {}),
    effort: op.doc.intent.effort,
    minutes: d.minutes ?? null,
    discipline: d.discipline ?? null,
    category: d.category ?? null,
    mode: d.mode ?? null,
    balance: balanceInUnits(d.balance as Record<string, unknown> | undefined),
    ...(detail < 5 ? { regions } : {}),
    review: r
      ? {
          mean: reviewMeanOf(op),
          low,
          ...(detail < 4 ? { mustFix: r.mustFix.slice(0, MUST_FIX_SHOWN).map((m) => untrusted(cut(m, MUST_FIX_MAX))) } : {}),
          mustFixCount: r.mustFix.length,
          rounds: r.rounds,
          ...(r.note ? { note: r.note } : {}),
        }
      : null,
  };
}

/** The set's combined balance: each document derived again in full (the stored summary keeps a workout's top regions
 * only), summed; its minutes are the workouts' own (what the cards show). */
function combinedOf(ops: DocWorkoutOp[]): Record<string, unknown> {
  const balance: BalanceProfile = { isometricSec: 0, isotonicReps: 0, eccentricReps: 0, plyoContacts: 0, aerobicSec: 0, mobilitySec: 0, recoverySec: 0 };
  const regions = new Map<string, number>();
  for (const op of ops) {
    try {
      const d = deriveDoc(op.doc, EXERCISES);
      for (const k of Object.keys(balance) as Array<keyof BalanceProfile>) balance[k] += d.balance[k];
      for (const [k, v] of Object.entries(d.regionExposure)) regions.set(k, (regions.get(k) ?? 0) + v);
    } catch {
      // A document that can't be derived adds nothing; its minutes still count.
    }
  }
  return {
    minutes: ops.reduce((s, op) => s + (typeof op.derived?.minutes === "number" ? op.derived.minutes : 0), 0),
    balance: balanceInUnits(balance as unknown as Record<string, unknown>),
    regions: Object.fromEntries(
      [...regions.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([k, v]) => [k, Math.round(v * 10) / 10]),
    ),
  };
}

const EMPTY = { workouts: [], combined: null, hardDaysInARow: { count: 0, pairs: [] }, movesRepeatedOnConsecutiveDays: [], notes: [], planChanges: [] };

/** A change of the main coach's to a session already on the plan, as the set's reader sees it beside the workouts. */
function changeOf(c: PlanAdjustOp): Record<string, unknown> {
  return {
    opId: c.id,
    change: c.op.kind,
    workoutId: c.op.workoutId,
    date: c.date,
    title: untrusted(cut(c.row.title, TITLE_MAX)),
    ...(c.op.kind === "move" ? { to: c.op.toTime ? `${c.op.toDate} ${c.op.toTime}` : c.op.toDate } : {}),
    ...(c.op.kind === "adjust" ? { minutes: c.op.durationMinutes } : {}),
    why: untrusted(cut(c.why, NOTE_MAX)),
  };
}

export const readSet: DesignTool = {
  name: "read_set",
  description:
    "The set so far (a week or the next few), for the main coach, its designers and reviewers: each workout in date order with its op id, where it goes, parts, moves, derived fields and review; the combined balance; hard days in a row; the moves repeated on consecutive days; and the main coach's changes to sessions already planned, apart.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  statementCost: 1,
  roles: ["main", "designer", "reviewer"],
  async run(ctx, raw) {
    const p = parseAct(input, raw, "no fields");
    if (isErr(p)) return p;
    const source = "the main run's proposal: the set's designed workouts, each with its independent review";
    let view: View;
    let proposalId: string | null;
    if (ctx.run.role === "main") {
      const rounds = ctx.set?.rounds() ?? [];
      if (rounds.length === 0) {
        return answer({ source, now: ctx.now, missing: ["no set planned yet: call plan_set first"], data: EMPTY, summary: "No set planned yet" });
      }
      view = { role: "main", keyOf: new Map(rounds.flatMap((r) => r.designers.map((d) => [d.runId, d.key] as const))) };
      proposalId = designProposalId(ctx.run.id);
    } else if (ctx.run.role === "designer") {
      view = { role: "designer", yours: ctx.run.id, firstVersion: ctx.replaces ?? null };
      proposalId = ctx.run.parentId ? designProposalId(ctx.run.parentId) : null;
    } else {
      view = { role: "reviewer", underReview: ctx.reviewOf?.designerRunId ?? null, toolUseId: ctx.reviewOf?.toolUseId ?? null };
      proposalId = ctx.reviewOf?.proposalId ?? null;
    }
    if (!proposalId) return answer({ source, now: ctx.now, missing: ["no set to read: this run belongs to none"], data: EMPTY, summary: "No set to read" });
    const read = await readSetProposal(ctx.db, ctx.userId, proposalId);
    const ops = read.ops.map((op) => asSeen(op, view));
    const flags = read.flags;
    const none = ops.length === 0 ? [view.role === "main" ? "no workout in the set's proposal yet" : "no workout of the set is proposed yet"] : [];
    const ordered = [...ops].sort((a, b) => (a.date === b.date ? (a.time ?? "").localeCompare(b.time ?? "") : a.date < b.date ? -1 : 1));
    const pairs = hardPairs(ordered);
    const repeats = repeatsOnConsecutiveDays(ordered);
    const rest = {
      combined: combinedOf(ordered),
      hardDaysInARow: { count: pairs.length, pairs, counts: "the set's own workouts that develop or peak, on consecutive days (read_plan for the runs and sessions around them)" },
      notes: flags.slice(-NOTES_SHOWN).map((f) => untrusted(cut(f, NOTE_MAX))),
      planChanges: read.changes.map(changeOf),
    };
    let result = answer({ source, now: ctx.now, missing: none, data: {}, summary: "" });
    for (const detail of DETAILS) {
      const workouts = ordered.map((op) => workoutOf(op, view, detail));
      // Last of all, the repeated moves are counted rather than listed (each workout's own moves are gone by then).
      const movesRepeatedOnConsecutiveDays = detail < 6 ? repeats : repeats.map((r) => ({ days: r.days, count: r.moves.length }));
      result = answer({
        source,
        now: ctx.now,
        missing: none,
        data: { workouts, ...rest, movesRepeatedOnConsecutiveDays },
        summary: `Read the set: ${ops.length} workout${ops.length === 1 ? "" : "s"}${pairs.length > 0 ? `, ${pairs.length} pair${pairs.length === 1 ? "" : "s"} of hard days in a row` : ""}`,
      });
      const { summary: _s, ...forModel } = result;
      if (bytesOf(forModel) <= RESULT_BUDGET_BYTES) break;
    }
    return result;
  },
};
