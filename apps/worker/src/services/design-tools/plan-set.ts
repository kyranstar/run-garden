/**
 * plan_set(briefs[]) — the main coach plans a set: one brief per workout, each started as a designer sub-run (Stage 3
 * spec §4, §6; principles §6.9; design-orchestrate.ts holds the mechanism). Main only, for a week or the next N only:
 * for now or later today the main coach designs the one workout itself.
 *
 * A brief is `{ key, date, time?, purpose, emphasis, constraints, why, sameDayWhy?, note? }`. Refused, teachably and with
 * every problem at once, writing nothing:
 *  - a date before today in the athlete's zone, or after the scope's last day (this week's, or the next N's horizon);
 *  - more briefs than the set holds (SET_MAX_WORKOUTS, or N), or a key used twice;
 *  - a second brief on a date without `sameDayWhy`, and a date that holds a programme session or a session already
 *    done, skipped or missed (read from the plan) without one — with it, the brief stands and its designer is told why.
 *  - a `note` on a first plan (a note is a redo's).
 * And in a fit-in run, before anything is read: a brief whose purpose, emphasis or constraints names a move the athlete
 * skipped in its batch — by id, or by name in any case (`skipped_move`; the saves flow, §12.5): the run's skip set.
 * Once more at most (SET_REDO_ROUNDS): a REDO names keys of the first plan only, each brief with a `note` on what to
 * change; its designer is told where the first version went, may revise the same workout (propose_workout lets it:
 * `ToolContext.replaces`), and its reviewed workout replaces the first version. A day held by a workout dropped or left
 * out is free again.
 *
 * SIZED TO THE BUDGET: the designers at the estimate's cost per workout (on a redo, the larger of it and this set's own
 * measured average per designer) and the main coach's work still to come (the larger of SET_MAIN_RESERVE_MICROS and
 * what its average run has left to spend) must fit what the set's ceiling has left — read from the step's tree, no
 * statement — and what the WEEK has left less one call's worst case (Task 13's fix wave, §2.11: `SetHooks.week`, the
 * step's own weekly read, or one read in a step that called no model), or the call is refused (`over_budget`), naming
 * the tighter limit and how many workouts fit. A replay is not checked again.
 *
 * The call answers `control: "set"` — the main run waits (`waiting_set`) until every designer is over, and the call's
 * result for the model is then the set's outcome (design-orchestrate.ts `settleSet`). Its data is the loop's: the
 * round, and on the first plan the set's estimated cost (stored in the run's state).
 *
 * Four statements at most: the athlete with the plan on the briefs' dates and the proposal's ops (one read), the
 * estimate (the first plan only), the week's spend (only in a step that made no model call), and the designers' one
 * insert (the loop's `SetHooks.start`, keyed per designer, so a replay starts none twice).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { plannedWorkouts } from "@rg/database";
import { SET_MAIN_RESERVE_MICROS, SET_MAX_WORKOUTS, SET_REDO_ROUNDS } from "../design-limits.js";
import { dayLabel } from "@rg/domain";
import {
  briefText,
  DEFAULT_SET_MAIN_COST_MICROS,
  DEFAULT_WORKOUT_COST_MICROS,
  designerRunId,
  estimateSetCost,
  isSetScope,
  setLastDay,
  setLimit,
  type SetEstimate,
} from "../design-orchestrate.js";
import { FROZEN_STATES } from "../workout-doc-store.js";
import { LLM_BUDGET } from "../llm.js";
import { capInWords, isErr, parseAct, prose, skippedErr } from "./act-common.js";
import { designProposalId, type DocWorkoutOp } from "./propose.js";
import { dateField, DATE_SCHEMA, jsonList, parsedArray, readAthlete, refuse } from "./read-common.js";
import type { DesignTool, SavesSkip, SetBrief, SetRound } from "./types.js";

const KEY = /^[A-Za-z0-9_-]{1,24}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const LIMITS = { purpose: 200, emphasis: 200, constraints: 300, why: 300, sameDayWhy: 200, note: 300 } as const;

/** A brief's words are free text only models read (Task 13's fix wave, §2.1): kept whole up to four times the cap. */
const text = (max: number) => prose(max);
const brief = z
  .object({
    key: z.string().regex(KEY, "letters, digits, - or _ (at most 24)"),
    date: dateField,
    time: z.string().regex(CLOCK, "must be a time like 17:30").optional(),
    purpose: text(LIMITS.purpose),
    emphasis: text(LIMITS.emphasis),
    constraints: text(LIMITS.constraints),
    why: text(LIMITS.why),
    sameDayWhy: text(LIMITS.sameDayWhy).optional(),
    note: text(LIMITS.note).optional(),
  })
  .strict();
const input = z.object({ briefs: z.array(brief).min(1).max(SET_MAX_WORKOUTS) }).strict();

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;
const str = (max: number, description: string) => ({ type: "string", minLength: 1, description: `${description.replace(/\.$/, "")} — ${capInWords(max)}.` });

const FIELDS = "briefs: one per workout, each { key, date, time?, purpose, emphasis, constraints, why, sameDayWhy?, note? }";

/** The skipped moves (the run's skip set) a brief's purpose, emphasis or constraints names — by id, or by name in any
 * case — each once, in the skip set's order. A move with no name is matched by its id alone. */
function skippedIn(briefs: ReadonlyArray<z.infer<typeof brief>>, skip: readonly SavesSkip[] | undefined): SavesSkip[] {
  if (!skip || skip.length === 0) return [];
  const words = briefs.map((b) => [b.purpose, b.emphasis, b.constraints].join("\n")).join("\n").toLowerCase();
  return skip.filter((s) => [s.id, s.name.trim()].some((w) => w !== "" && words.includes(w.toLowerCase())));
}

export const planSet: DesignTool = {
  name: "plan_set",
  description:
    "The main coach, for a week, the next few workouts or more than one workout: one brief per workout. Each brief starts a designer; this run waits, and the result says what each produced or why it was left out. Once more at most, with briefs for keys to redo, each with a note.",
  inputSchema: {
    type: "object",
    properties: {
      briefs: {
        type: "array",
        minItems: 1,
        maxItems: SET_MAX_WORKOUTS,
        items: {
          type: "object",
          properties: {
            key: { type: "string", pattern: KEY.source, description: "Your name for this workout of the set; a redo names it." },
            date: DATE_SCHEMA,
            time: { type: "string", description: "HH:MM, the athlete's local time (optional)." },
            purpose: str(LIMITS.purpose, "What this workout is for."),
            emphasis: str(LIMITS.emphasis, "The qualities it leans on."),
            constraints: str(LIMITS.constraints, "Time, place, what to avoid."),
            why: str(LIMITS.why, "Why it sits here in the set."),
            sameDayWhy: str(LIMITS.sameDayWhy, "Why a second session that day: needed when another brief, a programme session or a session already over holds the date."),
            note: str(LIMITS.note, "A redo's: what to change from the first version, and why."),
          },
          required: ["key", "date", "purpose", "emphasis", "constraints", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["briefs"],
    additionalProperties: false,
  },
  statementCost: 4,
  cpuWeight: 0.3,
  roles: ["main"],
  async run(ctx, raw) {
    const p = parseAct(input, raw, FIELDS);
    if (isErr(p)) return p;
    // An auto run (the new shape §5) may plan a set too: the coach chose one from the athlete's words.
    if (!isSetScope(ctx.run.scope) && ctx.run.scope.kind !== "auto") {
      return refuse(
        "not_for_scope",
        "plan_set plans a set — the next 7 days, or the next few workouts; this run designs one workout.",
        "Design it yourself: validate_workout until no error remains, then propose_workout.",
      );
    }
    if (!ctx.set) return refuse("unavailable", "plan_set runs only in the main coach's run.", "Finish with what you have.");
    const toolUseId = ctx.toolUseId ?? `call-${ctx.now.toISOString()}`;
    const earlier = ctx.set.rounds().filter((r) => r.toolUseId !== toolUseId);
    if (earlier.length > SET_REDO_ROUNDS) {
      return refuse(
        "set_done",
        `The set was planned and redone ${SET_REDO_ROUNDS === 1 ? "once" : `${SET_REDO_ROUNDS} times`}: no more designers can be started.`,
        "Judge the set with read_set, take a workout out with drop_workout if it must go, then call finish.",
      );
    }
    // A fit-in run's (the saves flow, §12.5): a move the athlete skipped stays out of every brief — before any read.
    const skipped = skippedIn(p.briefs, ctx.run.savesSkip);
    if (skipped.length > 0) return skippedErr(skipped, "Leave it out of every brief; the athlete chose to skip it.");
    const first = earlier[0];
    const redo = first !== undefined;
    const proposalId = designProposalId(ctx.run.id);
    const dates = [...new Set(p.briefs.map((b) => b.date))];
    const pw = plannedWorkouts;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      plan: sql`(select json_group_array(json_object('date', ${pw.effectiveDate}, 'origin', ${pw.origin}, 'state', ${pw.completionState}))
        from ${pw} where ${pw.userId} = ${ctx.userId} and ${pw.archivedAt} is null and ${pw.effectiveDate} in ${jsonList(dates)})`,
      ops: redo ? sql`(select ops from coach_proposals where id = ${proposalId} and user_id = ${ctx.userId})` : sql`null`,
    });
    const today = athlete.today;
    const last = setLastDay(ctx.run.scope, today);
    const plan = parsedArray(extra.plan) as Array<{ date?: unknown; origin?: unknown; state?: unknown }>;
    const ops = redo ? (parsedArray(extra.ops) as DocWorkoutOp[]) : [];
    /** The workout the first plan's designer of `key` put in the proposal: none once dropped or left out. */
    const firstOpOf = (key: string): DocWorkoutOp | undefined => {
      const runId = first?.designers.find((d) => d.key === key)?.runId;
      return runId ? ops.find((o) => o.by?.runId === runId) : undefined;
    };

    const problems: string[] = [];
    const seen = new Set<string>();
    for (const b of p.briefs) {
      if (seen.has(b.key)) problems.push(`"${b.key}": the key is used twice — each workout of the set needs its own`);
      seen.add(b.key);
    }
    // (A redo names keys of the first plan only, so it never holds more.)
    const limit = setLimit(ctx.run.scope);
    if (p.briefs.length > limit) {
      problems.push(`${p.briefs.length} briefs: this set holds at most ${limit} workout${limit === 1 ? "" : "s"}`);
    }
    const firstKeys = new Map((first?.briefs ?? []).map((b) => [b.key, b]));
    if (redo) {
      for (const b of p.briefs) {
        if (!firstKeys.has(b.key)) problems.push(`"${b.key}": a redo names a workout of the first plan (${[...firstKeys.keys()].map((k) => `"${k}"`).join(", ")})`);
        else if (!b.note) problems.push(`"${b.key}": a redo needs its note — what to change from the first version, and why`);
      }
    } else {
      for (const b of p.briefs) {
        if (b.note) problems.push(`"${b.key}": a note is a redo's (plan_set's second call) — say it in why or constraints`);
      }
    }
    const scopeEnd = ctx.run.scope.kind === "next_n" ? "the set's last day" : "the last of the next 7 days";
    // The dates already briefed: on a redo, the first plan's other workouts that still stand (one dropped or left out
    // holds no day).
    const held: SetBrief[] = redo ? (first?.briefs ?? []).filter((b) => !p.briefs.some((r) => r.key === b.key) && firstOpOf(b.key)) : [];
    for (const b of p.briefs) {
      if (b.date < today) problems.push(`"${b.key}": ${b.date} is before today (${today})`);
      else if (b.date > last) problems.push(`"${b.key}": ${b.date} is after ${scopeEnd} (${last})`);
      const before = [...held, ...p.briefs.slice(0, p.briefs.indexOf(b))].filter((x) => x.date === b.date);
      const rows = plan.filter((r) => r.date === b.date);
      const programme = rows.some((r) => r.origin === "program");
      const over = rows.some((r) => (FROZEN_STATES as readonly unknown[]).includes(r.state));
      if (b.sameDayWhy) continue;
      if (before.length > 0) problems.push(`"${b.key}": ${b.date} already has another brief ("${before[0]!.key}") — give sameDayWhy to plan two that day`);
      else if (programme) problems.push(`"${b.key}": ${b.date} holds a programme session — give sameDayWhy for a second session that day, or choose another day`);
      else if (over) problems.push(`"${b.key}": ${b.date} holds a session already done, skipped or missed — give sameDayWhy, or choose another day`);
    }
    if (problems.length > 0) {
      return refuse("invalid_briefs", `The set can't be planned as briefed: ${problems.slice(0, 10).join("; ")}.`, `Call plan_set again with every brief fixed (${FIELDS}).`);
    }

    const estimate: SetEstimate | null = redo ? null : await estimateSetCost(ctx.db, ctx.userId, p.briefs.length, ctx.now);
    // SIZED TO THE BUDGET (from the step's tree, no statement): the designers at the estimate's cost per workout — on a
    // redo, the larger of it and what this set's own designers have cost — and the main coach's work still to come: the
    // larger of its reserve and what its average run has left to spend. A replay of a call whose designers already
    // started is not checked again: they are under way.
    const ids = p.briefs.map((b, i) => designerRunId(ctx.run.id, toolUseId, i, b.key));
    if (!ctx.set.started(ids)) {
      // (An auto run's set is weighed against the set's ceiling it would rise to: `SetHooks.budget`.)
      const budget = ctx.set.budget();
      const stored = estimate ?? budget.estimate;
      const perWorkout = Math.max(stored?.perWorkoutMicros ?? DEFAULT_WORKOUT_COST_MICROS, redo ? (budget.perDesignerMicros ?? 0) : 0);
      const mainNeed = Math.max(SET_MAIN_RESERVE_MICROS, (stored?.mainMicros ?? DEFAULT_SET_MAIN_COST_MICROS) - budget.mainSpentMicros);
      const runLeft = budget.ceilingMicros - budget.spentMicros;
      // The week too (§2.11): what it has left, less one call's worst case — the next call is checked against it.
      const week = ctx.set.week ? await ctx.set.week() : null;
      // Its lane's cutoff: a rehearsal's is the rehearsal lane's cap (audit C1).
      const weekLeft = week ? (week.cutoffMicros ?? LLM_BUDGET.cutoffMicros) - week.spentMicros - week.callWorstMicros : Number.POSITIVE_INFINITY;
      const left = Math.min(runLeft, weekLeft);
      const n = p.briefs.length;
      if (perWorkout * n + mainNeed > left) {
        const fit = Math.max(0, Math.floor((left - mainNeed) / perWorkout));
        const limit =
          weekLeft < runLeft
            ? `this week's AI budget has ${usd(Math.max(0, weekLeft))} left`
            : `${usd(Math.max(0, runLeft))} of this design's ${usd(budget.ceilingMicros)} is left`;
        return refuse(
          "over_budget",
          `${n} workout${n === 1 ? " is" : "s are"} estimated at ${usd(perWorkout * n)}, and the coach keeps ${usd(mainNeed)} to judge and finish the set: ${limit} — enough for ${fit} workout${fit === 1 ? "" : "s"}.`,
          fit > 0
            ? `Plan ${fit} or fewer: the sessions the week needs most, around the runs.`
            : "No workout fits what is left: call finish, and say the set couldn't be designed within its limit.",
        );
      }
    }
    // An auto run that plans a set (the new shape §5) rises to the set's ceiling and window only now — once the set fits
    // (or its designers are already under way: a replay) — never on a refusal, which leaves it one workout's.
    ctx.set.raise?.();
    const firstOrder = [...firstKeys.keys()];
    const designers = p.briefs.map((b, i) => {
      const firstOp = redo ? firstOpOf(b.key) : undefined;
      const replaces = redo ? first?.designers.find((d) => d.key === b.key)?.runId : undefined;
      return {
        key: b.key,
        runId: ids[i]!,
        date: b.date,
        ...(replaces ? { replaces } : {}),
        brief: briefText(b, {
          index: redo ? firstOrder.indexOf(b.key) : i,
          count: redo ? firstOrder.length : p.briefs.length,
          redo,
          first: firstOp ? { title: firstOp.doc.title, mustFix: firstOp.review?.mustFix ?? [], target: firstOp.target, date: firstOp.date } : null,
        }),
      };
    });
    const started = await ctx.set.start(designers);
    const replaces = redo
      ? Object.fromEntries(p.briefs.flatMap((b) => {
          const id = first?.designers.find((d) => d.key === b.key)?.runId;
          return id ? [[b.key, id]] : [];
        }))
      : undefined;
    const round: SetRound = {
      toolUseId,
      redo,
      briefs: p.briefs,
      designers: designers.map(({ key, runId }) => ({ key, runId })),
      ...(replaces ? { replaces } : {}),
    };
    // The trail's line, in the athlete's words (fix wave 3B, B-I3): the days as the app names them, no machinery.
    const days = p.briefs.map((b) => dayLabel(b.date)).join(", ");
    return {
      data: { round, ...(estimate ? { estimate } : {}) },
      summary: redo
        ? `Asked again for ${p.briefs.length === 1 ? "one workout" : `${p.briefs.length} workouts`}: ${days}`
        : `Planned ${p.briefs.length} workout${p.briefs.length === 1 ? "" : "s"} — a workout for each day: ${days}`,
      receipt: { keys: p.briefs.map((b) => b.key), dates: p.briefs.map((b) => b.date), started: started.length, redo, ...(estimate ? { estimate } : {}) },
      control: "set",
    };
  },
};
