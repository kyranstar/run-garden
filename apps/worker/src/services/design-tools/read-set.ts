/**
 * read_set() — the main coach's view of its set so far, to judge it as a whole (Stage 3 spec §6; principles §6.9;
 * design-orchestrate.ts): the proposal's workouts in date order, each with its key and op id, what is derived from its
 * document (minutes, discipline, category, mode, balance, top regions), its effort and intent, and its review in
 * summary (the mean, the low scores, the must-fix items, the rounds); the set's combined balance (`deriveDoc` over the
 * documents, summed, in read_balance's units — what the set adds, beside what read_balance says was done); and hard
 * days in a row (two workouts of the set that develop or peak on consecutive days). Runs and programme sessions around
 * them are read_plan's. Main only.
 *
 * Small by contract: one statement (the proposal), and an answer within RESULT_BUDGET_BYTES — the details give way, in
 * order, before any workout does (the intent sentences, then the must-fix wording, then the regions).
 */
import { z } from "zod";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc, type BalanceProfile } from "@rg/workout";
import { REVIEW_DIMENSIONS } from "../design-prompt.js";
import { balanceInUnits, hardPairs, opIdOf, readSetProposal, reviewMeanOf } from "../design-orchestrate.js";
import { isErr, parseAct } from "./act-common.js";
import { designProposalId, type DocWorkoutOp } from "./propose.js";
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

/** How much of each workout is shown: 0 all; 1 without the intent; 2 the must-fix items counted only; 3 no regions. */
type Detail = 0 | 1 | 2 | 3;

function workoutOf(op: DocWorkoutOp, key: string | null, detail: Detail): Record<string, unknown> {
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
  return {
    opId: opIdOf(op),
    key,
    date: op.date,
    ...(op.time ? { time: op.time } : {}),
    title: untrusted(cut(op.doc.title, TITLE_MAX)),
    ...(detail < 1 ? { intent: untrusted(cut(op.doc.intent.summary, INTENT_MAX)) } : {}),
    effort: op.doc.intent.effort,
    minutes: d.minutes ?? null,
    discipline: d.discipline ?? null,
    category: d.category ?? null,
    mode: d.mode ?? null,
    balance: balanceInUnits(d.balance as Record<string, unknown> | undefined),
    ...(detail < 3 ? { regions } : {}),
    review: r
      ? {
          mean: reviewMeanOf(op),
          low,
          ...(detail < 2 ? { mustFix: r.mustFix.slice(0, MUST_FIX_SHOWN).map((m) => untrusted(cut(m, MUST_FIX_MAX))) } : {}),
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

export const readSet: DesignTool = {
  name: "read_set",
  description:
    "The main coach's view of the set so far: each workout in date order with its op id, derived fields and review, the set's combined balance, and hard days in a row.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  statementCost: 1,
  roles: ["main"],
  async run(ctx, raw) {
    const p = parseAct(input, raw, "no fields");
    if (isErr(p)) return p;
    const rounds = ctx.set?.rounds() ?? [];
    const source = "this run's proposal: the set's designed workouts, each with its independent review";
    if (ctx.run.role !== "main" || rounds.length === 0) {
      return answer({
        source,
        now: ctx.now,
        missing: ["no set planned yet: call plan_set first"],
        data: { workouts: [], combined: null, hardDaysInARow: { count: 0, pairs: [] }, notes: [] },
        summary: "No set planned yet",
      });
    }
    const keyOf = new Map(rounds.flatMap((r) => r.designers.map((d) => [d.runId, d.key] as const)));
    const { ops, flags } = await readSetProposal(ctx.db, ctx.userId, designProposalId(ctx.run.id));
    const ordered = [...ops].sort((a, b) => (a.date === b.date ? (a.time ?? "").localeCompare(b.time ?? "") : a.date < b.date ? -1 : 1));
    const pairs = hardPairs(ordered);
    const rest = {
      combined: combinedOf(ordered),
      hardDaysInARow: { count: pairs.length, pairs, counts: "the set's own workouts that develop or peak, on consecutive days (read_plan for the runs and sessions around them)" },
      notes: flags.slice(-NOTES_SHOWN).map((f) => cut(f, NOTE_MAX)),
    };
    let result = answer({ source, now: ctx.now, missing: ops.length === 0 ? ["no workout in the set's proposal yet"] : [], data: {}, summary: "" });
    for (const detail of [0, 1, 2, 3] as Detail[]) {
      const workouts = ordered.map((op) => workoutOf(op, keyOf.get(opIdOf(op)) ?? null, detail));
      result = answer({
        source,
        now: ctx.now,
        missing: ops.length === 0 ? ["no workout in the set's proposal yet"] : [],
        data: { workouts, ...rest },
        summary: `Read the set: ${ops.length} workout${ops.length === 1 ? "" : "s"}${pairs.length > 0 ? `, ${pairs.length} pair${pairs.length === 1 ? "" : "s"} of hard days in a row` : ""}`,
      });
      const { summary: _s, ...forModel } = result;
      if (bytesOf(forModel) <= RESULT_BUDGET_BYTES) break;
    }
    return result;
  },
};
