/**
 * ORCHESTRATION FOR A WEEK OR THE NEXT N WORKOUTS (Stage 3 spec §2, §4, §6; principles §6.9; Task 7).
 *
 * For a set, the main run plans before anything is designed, one designer sub-run designs each workout (each with its
 * own independent reviewer, design-review.ts), and the main run judges the set and finishes ONE proposal:
 *
 *  1. plan_set(briefs[]) — the main coach's, for a week or the next N only (design-tools/plan-set.ts). Each brief is
 *     `{ key, date, time?, purpose, emphasis, constraints, why, sameDayWhy?, note? }`, checked against the scope's
 *     horizon, today in the athlete's zone, the set's size (SET_MAX_WORKOUTS, or N), one brief a day unless it says why
 *     (`sameDayWhy`), and the plan: a day that holds a programme session or a session already over needs its reason
 *     too. Each brief starts one designer — role designer, parent the main run, its brief as the context's `brief`
 *     (marked as the main coach's words), the scope, the window, the clock and the rehearsal inherited, a workout's own
 *     ceiling (DESIGNER_CEILING_MICROS) — in ONE insert, each id keyed on the call and the brief's key
 *     (`designerRunId`), so a replay starts nothing twice. The call pauses the main run (`waiting_set`).
 *  2. The loop steps one due sub-run per step: designers in brief order, each designer's reviewer before the next
 *     designer (a parent waits for its live sub-runs). Never two model calls in one step.
 *  3. Once every designer is over (finished, failed, stopped, expired), the main run resumes (`settleSet`, its own step,
 *     no model call) with plan_set's result: per brief, `proposed` (the op's id, its minutes and balance, the review's
 *     mean) or `left_out` with its reason. FAILURE ISOLATION: a designer that failed, stopped at its ceiling or step
 *     cap, or whose review was dropped and never redone leaves its slot out; an unreviewed draft is taken out of the
 *     proposal (never shown) and the athlete's proposal says plainly why the day has no workout. The rest stands. A
 *     designer that stopped after its draft was reviewed keeps that reviewed version (as a main run that stops does:
 *     Task 6's "with what it has").
 *  4. The main coach judges the set — read_set (design-tools/read-set.ts), its read tools — and acts on its judgement:
 *     drop_workout takes one workout out with a plain reason for the athlete; plan_set once more (SET_REDO_ROUNDS)
 *     redoes specific keys with a note — each a new designer, whose reviewed workout replaces the first version (a redo
 *     that can't be designed keeps it). Then finish: the loop's finish makes the proposal pending only when every op
 *     left is reviewed.
 *  5. MONEY. Sub-run spend rolls up the tree (coach-runs.ts). A designer's own ceiling stops that designer alone; the
 *     main run's ceiling (the set's, $6 by default) stops the whole set — gracefully: `promoteSetWithWhatItHas` proposes
 *     what was reviewed, the rest left out with a line. So does every other stop of the set but the athlete's cancel
 *     (fix wave 3A, A2): the AI account or service failing it, its caps, an internal error, its window closing.
 *
 * THE ESTIMATE (`estimateSetCost`, stored in the main run's state and in plan_set's event for the run view): the
 * average designer's cost × the set's workouts + the average set main run's own cost. "A designer's cost" is a
 * finished designer run's own spend plus its reviewers' (their `cost_usd`), averaged over this athlete's finished
 * designers of the last ESTIMATE_WINDOW_DAYS; with fewer than ESTIMATE_MIN_DESIGNERS of them it is
 * DEFAULT_WORKOUT_COST_MICROS. The main run's is the average own spend of this athlete's finished week / next N main
 * runs over the same window, else DEFAULT_SET_MAIN_COST_MICROS. The defaults are reckoned from the model's prices (Opus
 * 5.5: $4 / $20 per million in / out, cache reads $0.20): a call with a cached prefix of ~20k tokens, ~3k new and ~2k
 * out is about $0.07; a designer makes ~6 calls and its reviewers ~4, the main coach ~5 — until measured runs replace
 * them (Task 13 measures the real ones).
 *
 * Every text a model wrote — the briefs, a designer's last line, a review's must-fix items, a workout's title — is data:
 * marked where it reaches another run, never followed.
 */
import { sql, type SQL } from "drizzle-orm";
import { addDays, daysBetween } from "@rg/domain";
import type { Db } from "./db.js";
import { horizonDays } from "./design-context.js";
import { SET_MAX_WORKOUTS } from "./design-limits.js";
import { applyDrop, dayWords, meanScore, pastDayLine, PROMOTE_TRIES, proposalFields, reviewRunning } from "./design-review.js";
import type { DocWorkoutOp } from "./design-tools/propose.js";
import { untrusted } from "./design-tools/read-common.js";
import type { RunScope, SetBrief, SetRound } from "./design-tools/types.js";
import { opIdOf } from "./proposal-kinds.js";

// ── The set's shape ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A scope a set is planned for. */
export const isSetScope = (scope: RunScope): boolean => scope.kind === "week" || scope.kind === "next_n";

/** The most workouts a set of this scope plans. */
export const setLimit = (scope: RunScope): number => (scope.kind === "next_n" ? Math.min(scope.n ?? 3, SET_MAX_WORKOUTS) : SET_MAX_WORKOUTS);

/** The last day a set's workouts may fall on: this week's last day, or the end of the next N's horizon (the plan the
 * main coach was shown reaches that far: design-context.ts `horizonDays`). */
export function setLastDay(scope: RunScope, today: string): string {
  const days = scope.kind === "week" ? 7 : horizonDays("next_n", scope.n ?? 3);
  return addDays(today, days - 1);
}

/** A designer of a set: keyed on the call that planned it and its brief (its place in the call first, so the ids sort
 * in brief order). Its id is its workout's op id. */
export const designerRunId = (mainRunId: string, toolUseId: string, index: number, key: string): string =>
  `ds-${mainRunId}-${toolUseId}-${String(index + 1).padStart(2, "0")}-${key}`;

/** An op's id: the run that designed it (proposal-kinds.ts, the one definition approve and decline name ops by too). */
export { opIdOf };

/** "Saturday 16 May" (design-review.ts). */
export { dayWords };

/** Where a workout goes, in words: "a new workout on Saturday 16 May" / "a revision of the workout w1 (from its
 * revision 2), on Saturday 16 May". */
export function targetWords(target: DocWorkoutOp["target"], date: string): string {
  return target.kind === "new"
    ? `a new workout on ${dayWords(date)}${target.time ? ` at ${target.time}` : ""}`
    : `a revision of the workout ${target.workoutId} (from its revision ${target.baseRev}), on ${dayWords(date)}`;
}

/**
 * A designer's brief as its opening context carries it (marked whole as the main coach's words: design-context.ts):
 * the brief's own fields, and on a redo (`redo`) what the first version was — where it goes, and what its review asked
 * to change — so the redo goes where the first version went unless the note says otherwise.
 */
export function briefText(
  b: SetBrief,
  o: { index: number; count: number; redo: boolean; first?: { title: string; mustFix: string[]; target: DocWorkoutOp["target"]; date: string } | null },
): string {
  return [
    `Workout "${b.key}", ${o.index + 1} of ${o.count} in the set${o.redo ? " — a redo" : ""}.`,
    `Date: ${dayWords(b.date)} (${b.date})${b.time ? `, at ${b.time}` : ""}.`,
    `Purpose: ${b.purpose}`,
    `Emphasis: ${b.emphasis}`,
    `Constraints: ${b.constraints}`,
    `Why: ${b.why}`,
    ...(b.sameDayWhy ? [`A second session that day, because: ${b.sameDayWhy}`] : []),
    ...(o.redo && b.note ? [`What to change from the first version: ${b.note}`] : []),
    ...(o.first
      ? [
          `The first version was "${o.first.title}", ${targetWords(o.first.target, o.first.date)}${o.first.mustFix.length > 0 ? `; its review's must-fix items: ${o.first.mustFix.join("; ")}` : ""}.`,
          "Propose yours for the same place unless the note says otherwise: once reviewed it replaces the first version.",
        ]
      : []),
  ].join("\n");
}

// ── The proposal ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A design proposal as stored: its ops (and their text, for a guarded write), status and lines — and, with
 * `designersOf` (a main run's id), that run's designers as they stand (`SetDesigner`), read in the same statement.
 * One statement.
 */
export async function readSetProposal(
  db: Db,
  userId: string,
  proposalId: string,
  o: { designersOf?: string } = {},
): Promise<{ opsText: string | null; ops: DocWorkoutOp[]; status: string | null; flags: string[]; designers: SetDesigner[] }> {
  const designers = o.designersOf
    ? sql`(SELECT json_group_array(json_object('runId', r.id, 'status', r.status,
        'day', CASE WHEN json_valid(r.state) THEN json_extract(r.state, '$.day') END,
        'replaces', CASE WHEN json_valid(r.state) THEN json_extract(r.state, '$.replaces') END))
        FROM coach_runs r WHERE r.user_id = ${userId} AND r.parent_id = ${o.designersOf} AND r.role = 'designer')`
    : sql`NULL`;
  const rows = (await db.all(sql`
    SELECT ops, status, flags, ${designers} AS designers FROM coach_proposals WHERE id = ${proposalId} AND user_id = ${userId}
  `)) as Array<{ ops: string | null; status: string; flags: string | null; designers: string | null }>;
  const row = rows[0];
  const list = (text: string | null | undefined): unknown[] => {
    try {
      const v: unknown = text ? JSON.parse(text) : [];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    opsText: row?.ops ?? null,
    ops: list(row?.ops) as DocWorkoutOp[],
    status: row?.status ?? null,
    flags: list(row?.flags).filter((f): f is string => typeof f === "string"),
    designers: list(row?.designers).flatMap((d) => {
      const x = d as Record<string, unknown> | null;
      const runId = str(x?.runId);
      return runId ? [{ runId, status: str(x?.status) ?? "missing", day: str(x?.day), replaces: str(x?.replaces) }] : [];
    }),
  };
}

/**
 * Write a set's ops and its lines (`flags`) while the proposal is still open — never pending: that is the finish's —
 * and still holds `readOps`. With no op left the title and expiry stay as they were. One statement; false when nothing
 * was written.
 */
export async function writeSetOps(db: Db, userId: string, proposalId: string, ops: DocWorkoutOp[], readOps: string | null, flags: string[]): Promise<boolean> {
  const f = ops.length > 0 ? proposalFields(ops) : null;
  const rows = (await db.all(sql`
    UPDATE coach_proposals SET ops = ${JSON.stringify(ops)}, flags = ${JSON.stringify(flags)},
      title = COALESCE(${f?.title ?? null}, title), rationale = COALESCE(${f?.rationale ?? null}, rationale),
      expires_at = COALESCE(${f?.expiresAt ?? null}, expires_at)
    WHERE id = ${proposalId} AND user_id = ${userId} AND status IN ('unreviewed', 'rehearsal') AND ops IS ${readOps}
    RETURNING id
  `)) as Array<{ id: string }>;
  return rows.length > 0;
}

/** A review's mean, or null when it couldn't be read (its scores are empty, its note says the validator's view stands). */
export function reviewMeanOf(op: DocWorkoutOp): number | null {
  const r = op.review;
  if (!r || Object.keys(r.scores ?? {}).length === 0) return null;
  return meanScore(r);
}

/** A derived balance (design-tools/act-common.ts `derivedSummary`: seconds and counts) in read_balance's units; what is
 * not trained is left out, never written as 0 (any time at all is at least a minute). */
export function balanceInUnits(b: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(b ?? {})) {
    if (typeof v !== "number" || v <= 0) continue;
    if (k.endsWith("Sec")) out[`${k.slice(0, -3)}Min`] = Math.max(1, Math.round(v / 60));
    else out[k] = Math.round(v * 10) / 10;
  }
  return out;
}

// ── The set settled: the main run resumed ───────────────────────────────────────────────────────────────────────────

/** How a designer of the set ended, from the step's tree. */
export interface DesignerEnd {
  key: string;
  runId: string;
  /** Its status (finished, failed, stopped_cap, expired, cancelled), or "missing" when it can't be found. */
  status: string;
  error: string | null;
  /** Its finish line, its own words (model-written). */
  final: string | null;
  ceilingMicros?: number;
}

/** The start of the proposal's line for a day of the set with no workout. */
const noWorkoutFor = (date: string): string => `No workout for ${dayWords(date)}:`;

/** The change line of a draft still under review when its designer ended. */
const NOT_REVIEWED = "not reviewed: its designer stopped before the review was in.";

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;
const dollars = (micros: number): number => Math.round(micros / 10_000) / 100;

/** Why a designer gave no reviewed workout, in plain words. */
function leftOutWhy(d: DesignerEnd | undefined, op: DocWorkoutOp | undefined): string {
  if (!d || d.status === "missing") return "its designer couldn't be found";
  if (d.status === "finished") {
    return op
      ? "its review couldn't be done, and it wasn't proposed again (a workout is never shown unreviewed)"
      : "the designer finished without proposing a workout";
  }
  if (d.status === "stopped_cap") return `${stoppedWhy(d)} before a workout was reviewed`;
  if (d.status === "expired") return "it ran out of time";
  if (d.status === "cancelled") return "it was cancelled";
  return `the designer couldn't finish: ${designerWhy(d.error)}`;
}

/** How a designer that stopped at a limit stopped, in plain words. */
function stoppedWhy(d: DesignerEnd): string {
  switch (d.error) {
    case "run_ceiling":
      return `the designer reached its spending limit${typeof d.ceilingMicros === "number" ? ` (${usd(d.ceilingMicros)})` : ""}`;
    case "step_cap":
      return "the designer reached its step limit";
    case "state_cap":
      return "the design grew too long";
    case "weekly_cap":
      return "the week's AI budget ran out";
    default:
      return "the designer stopped";
  }
}

/** A designer that stopped after its draft was reviewed: how, for the note beside the version it keeps. */
function keptWhy(d: DesignerEnd): string {
  return d.status === "stopped_cap" ? stoppedWhy(d) : `the designer couldn't finish: ${designerWhy(d.error)}`;
}

/** Why a designer failed, in plain words, from its error code. */
function designerWhy(error: string | null): string {
  switch (error) {
    case "retries":
      return "the AI service didn't answer";
    case "refusal":
      return "the model declined to design it";
    case "internal":
    case "bad_state":
      return "something went wrong in the coach";
    case "no_key":
    case "gateway_402":
      return "the AI account can't be reached";
    case "kept_stopping":
      return "it kept stopping partway through";
    case null:
      return "it ended without a workout";
    default:
      return "the AI service refused the request";
  }
}

/**
 * A set's designer that ended on its own — not a limit of the whole set, not its own ceiling (which has its own line):
 * its trail line says the workout stopped and the set goes on (the loop's own line says the coach stopped).
 */
export function designerStopLine(error: string | null): string {
  switch (error) {
    case "step_cap":
      return "This workout's design reached its step limit — the rest of the set goes on.";
    case "state_cap":
      return "This workout's design grew too long to continue — the rest of the set goes on.";
    default:
      return `This workout's design stopped: ${designerWhy(error)} — the rest of the set goes on.`;
  }
}

/** A proposed workout as plan_set's result gives it. */
function proposedEntry(op: DocWorkoutOp): Record<string, unknown> {
  const r = op.review;
  return {
    opId: opIdOf(op),
    target: op.target,
    title: untrusted(op.doc.title),
    minutes: op.derived?.minutes ?? null,
    balance: balanceInUnits(op.derived?.balance as Record<string, unknown> | undefined),
    reviewMean: reviewMeanOf(op),
    mustFix: r?.mustFix?.length ?? 0,
    rounds: r?.rounds ?? 0,
    ...(r?.note ? { reviewNote: r.note } : {}),
  };
}

/**
 * Between a workout's first version and its redo, both reviewed: Task 6's best-version rule (design-review.ts). A
 * version whose review couldn't be read never beats one with a score; the higher mean wins; a tie goes to the redo —
 * the main coach asked for it. Answers whether the redo is kept, and a few words on why.
 */
export function redoKept(redo: DocWorkoutOp, first: DocWorkoutOp): { redo: boolean; why: string } {
  const r = reviewMeanOf(redo);
  const f = reviewMeanOf(first);
  const fmt = (m: number) => m.toFixed(1);
  if (r === null && f === null) return { redo: true, why: "neither review could be read" };
  if (r === null) return { redo: false, why: "the redo's review couldn't be read" };
  if (f === null) return { redo: true, why: "the first version's review couldn't be read" };
  if (r > f) return { redo: true, why: `it scored ${fmt(r)} against ${fmt(f)}` };
  if (r === f) return { redo: true, why: `a tie at ${fmt(r)}, and the redo was asked for` };
  return { redo: false, why: `the first version scored ${fmt(f)} against ${fmt(r)}` };
}

/** A workout's day as plan_set's result gives it: where it went, and the brief's day when the designer chose another. */
const dayOf = (date: string, brief: SetBrief): Record<string, string> => ({ date, ...(date !== brief.date ? { briefDate: brief.date } : {}) });

const NEXT_WITH_REDO =
  "Judge the set as a whole: read_set shows each workout with its moves and review, moves repeated on consecutive days, the set's combined balance and hard days in a row. Take one out with drop_workout (a plain reason for the athlete), or call plan_set once more with briefs for the keys to redo, each with a note. Then call finish with one plain line on how the set fits together.";
const NEXT_NO_REDO =
  "Judge the set as a whole (read_set). Take one out with drop_workout if it must go — no rounds of redo are left. Then call finish with one plain line on how the set fits together.";

/** A line of the proposal's about one workout of the set, by its brief's key: a day left out, a workout taken out. */
export interface KeyLine {
  key: string;
  line: string;
}

/**
 * The set's outcome once every designer of `round` is over (the main run's own step; ≤ 2 statements: the proposal, and
 * the ops and lines written when anything changed). Each brief's workout is proposed — its draft still under review
 * dropped, the reviewed version kept — or left out with its reason: an unreviewed draft is taken out, and the
 * proposal's lines say why that day has no workout. A redo's reviewed workout replaces the first version when it is
 * the better by Task 6's rule (`redoKept`: a review read beats one that couldn't be, the higher mean wins, a tie goes to
 * the redo) — the set's line says which was kept, and why — and takes back what the proposal said about its key, never
 * another key's line; a redo that couldn't be designed, or lost, keeps the first.
 * When the write loses to another (the proposal closed or changed), nothing is claimed taken out. Answers plan_set's
 * result for the model (with the budget left), the trail's line, and the key lines as they now stand.
 */
export async function settleSet(
  db: Db,
  userId: string,
  o: {
    proposalId: string;
    round: SetRound;
    keyLines: KeyLine[];
    designers: DesignerEnd[];
    redoLeft: number;
    budget: { ceilingMicros: number; spentMicros: number };
  },
): Promise<{ data: Record<string, unknown>; line: string; keyLines: KeyLine[] }> {
  const { ops, opsText, status, flags } = await readSetProposal(db, userId, o.proposalId);
  let next = [...ops];
  let keyLines = [...o.keyLines];
  const takenBack: string[] = [];
  const added: KeyLine[] = [];
  const out: Array<Record<string, unknown>> = [];
  const tally = { proposed: 0, replaced: 0, keptFirst: 0, leftOut: 0 };
  /** Which version of each redone workout was kept, and why: the set's line says so. */
  const chosen: string[] = [];
  /** What the proposal said about a key no longer stands. */
  const takeBack = (key: string) => {
    takenBack.push(...keyLines.filter((k) => k.key === key).map((k) => k.line));
    keyLines = keyLines.filter((k) => k.key !== key);
  };
  for (const b of o.round.briefs) {
    const d = o.designers.find((x) => x.key === b.key);
    let op = d ? next.find((x) => x.by?.runId === d.runId) : undefined;
    const running = op?.reviewLog?.find((r) => r.status === "reviewing");
    if (op && running) {
      // Its designer is over, so no reviewer of its is live: a draft still under review was never reviewed.
      const dropped = applyDrop(op, running.toolUseId, NOT_REVIEWED);
      if (dropped) {
        next = next.map((x) => (x === op ? dropped : x));
        op = dropped;
      }
    }
    const firstId = o.round.replaces?.[b.key];
    const first = firstId ? next.find((x) => x.by?.runId === firstId) : undefined;
    const choice = op?.review && first ? redoKept(op, first) : null;
    if (op && op.review && choice && !choice.redo) {
      // The first version stays: the redo's reviewed draft is taken out.
      next = next.filter((x) => x !== op);
      out.push({ key: b.key, ...dayOf(first!.date, b), outcome: "kept_first", opId: opIdOf(first!), target: first!.target, kept: "first", reason: choice.why });
      chosen.push(`${dayWords(first!.date)}: the first version kept — ${choice.why}`);
      tally.keptFirst += 1;
      continue;
    }
    if (op && op.review) {
      if (first) next = next.filter((x) => x !== first);
      takeBack(b.key);
      if (choice) chosen.push(`${dayWords(op.date)}: the redo kept — ${choice.why}`);
      const stopped = d && d.status !== "finished" ? { note: `${keptWhy(d)} after a draft was reviewed: the reviewed version stands` } : {};
      out.push({ key: b.key, ...dayOf(op.date, b), outcome: first ? "replaced" : "proposed", ...(choice ? { kept: "redo", reason: choice.why } : {}), ...proposedEntry(op), ...stopped });
      tally[first ? "replaced" : "proposed"] += 1;
      continue;
    }
    // Never shown unreviewed: the draft is taken out.
    if (op) next = next.filter((x) => x !== op);
    const reason = leftOutWhy(d, op);
    const said = d?.final ? { designerSaid: untrusted(d.final) } : {};
    const draft = op ? { draftTakenOut: true } : {};
    if (first) {
      out.push({ key: b.key, ...dayOf(first.date, b), outcome: "kept_first", opId: opIdOf(first), target: first.target, reason: `the redo couldn't be designed: ${reason}`, ...draft, ...said });
      tally.keptFirst += 1;
    } else {
      takeBack(b.key);
      added.push({ key: b.key, line: `${noWorkoutFor(b.date)} ${reason}.` });
      out.push({ key: b.key, date: b.date, outcome: "left_out", reason, ...draft, ...said });
      tally.leftOut += 1;
    }
  }
  const flagsNext = flags.filter((f) => !takenBack.includes(f));
  // The key lines are what the proposal's lines must hold for the set's workouts, each as often as it is kept: one the
  // proposal doesn't hold (it had no row when it was written, or another key's line said the same words and went with
  // the line taken back) is written now.
  const keyLinesNext = [...keyLines, ...added];
  const want = new Map<string, number>();
  for (const k of keyLinesNext) want.set(k.line, (want.get(k.line) ?? 0) + 1);
  for (const [l, n] of want) for (let i = flagsNext.filter((f) => f === l).length; i < n; i++) flagsNext.push(l);
  const changed = next.length !== ops.length || next.some((x, i) => x !== ops[i]) || flagsNext.length !== flags.length || flagsNext.some((f, i) => f !== flags[i]);
  const stored = !changed || status === null || (await writeSetOps(db, userId, o.proposalId, next, opsText, flagsNext));
  if (!stored) {
    // Another write came between: nothing was taken out of the proposal, nor added to its lines.
    for (const e of out) if (e.draftTakenOut) e.draftTakenOut = false;
  }
  const parts = o.round.redo
    ? [
        ...(tally.replaced ? [`${tally.replaced} replaced`] : []),
        ...(tally.proposed ? [`${tally.proposed} proposed`] : []),
        ...(tally.keptFirst ? [`${tally.keptFirst} kept as first designed`] : []),
        ...(tally.leftOut ? [`${tally.leftOut} left out`] : []),
      ]
    : [`${tally.proposed} proposed`, ...(tally.leftOut ? [`${tally.leftOut} left out`] : [])];
  const left = Math.max(0, o.budget.ceilingMicros - o.budget.spentMicros);
  return {
    data: {
      set: out,
      proposed: tally.proposed + tally.replaced,
      leftOut: tally.leftOut,
      ...(o.round.redo ? { keptFirst: tally.keptFirst } : {}),
      workoutsInProposal: stored ? next.length : ops.length,
      ...(stored
        ? {}
        : { proposalNote: "The proposal changed while the set's outcome was being written: nothing was taken out of it or added to its lines. Read it with read_set before finishing." }),
      // What is left, rounded down: never more than there is.
      budget: { leftUsd: Math.floor(left / 10_000) / 100, ceilingUsd: dollars(o.budget.ceilingMicros) },
      redoLeft: o.redoLeft,
      next: o.redoLeft > 0 ? NEXT_WITH_REDO : NEXT_NO_REDO,
    },
    line: `${o.round.redo ? "The redo is in" : "The set is designed"}: ${parts.join(", ")}.${chosen.length > 0 ? ` ${chosen.join("; ")}.` : ""}${stored ? "" : " The proposal changed meanwhile, so nothing was written to it."}`,
    keyLines: stored ? keyLinesNext : o.keyLines,
  };
}

// ── A set stopped with what it has ──────────────────────────────────────────────────────────────────────────────────

const STOPPED_CHANGE = "not reviewed: the coach stopped before its review was in.";

/** A designer of the set as its proposal's read finds it (`readSetProposal`'s `designersOf`): its run, its status, its
 * brief's day, and — a redo's designer — the designer whose first version it replaces once reviewed. */
export interface SetDesigner {
  runId: string;
  status: string;
  day: string | null;
  replaces: string | null;
}

/**
 * A set's main run that stopped any way but a cancel proposes what was reviewed (spec §2; Task 6's
 * `promoteWithWhatItHas`, for a set; fix wave 3A, A2): a draft still under review is dropped, the held reviewed version
 * staying; a workout with no review is left out, and a line says which; the days of designers that never got a draft
 * in — never started, or stopped before proposing (one that finished has its own line already) — are named; with
 * `today` (an expiry), a workout dated before it is left out, and a line says which; the stop's note goes in the
 * proposal's lines. A workout a redo was designing (a redo's designer names its first version's: `replaces`) is
 * proposed in ONE version: the redo's when it was reviewed and is the better by Task 6's rule (`redoKept`; a tie to the
 * redo), else the first — the redo's draft going without a line, its workout's day still holding the first version.
 * The designers — the redos and the days not designed — come from the proposal's own read, every designer of the main
 * run `mainRunId` as it stands (fix wave 3A round 2, A-I1): never from what the caller holds, so a stop found by a step,
 * an expiry found by a create or by the sweep (which hold only the live runs) propose the same. Pending under the
 * finish's own guard — still `unreviewed` (a rehearsal stays one), no review under way, the ops it read — and only with
 * at least one reviewed workout. A read and a write (none written when nothing can be proposed), tried again once when
 * the write lost to another (design-review.ts PROMOTE_TRIES): four statements at most.
 */
export async function promoteSetWithWhatItHas(
  db: Db,
  userId: string,
  proposalId: string,
  note: string,
  opts: { mainRunId: string; today?: string },
): Promise<boolean> {
  for (let tries = 0; tries < PROMOTE_TRIES; tries++) {
    const out = await promoteSetOnce(db, userId, proposalId, note, opts);
    if (out !== "lost") return out;
  }
  return false;
}

/** One try of `promoteSetWithWhatItHas`: made pending, nothing to propose, or the write `lost` to another. */
async function promoteSetOnce(db: Db, userId: string, proposalId: string, note: string, opts: { mainRunId: string; today?: string }): Promise<boolean | "lost"> {
  const today = opts.today;
  const { ops, opsText, status, flags, designers } = await readSetProposal(db, userId, proposalId, { designersOf: opts.mainRunId });
  if (status !== "unreviewed" || ops.length === 0) return false;
  // A redo's designer → its first version's: one version of each workout is proposed.
  const redoOf: Record<string, string> = Object.fromEntries(designers.filter((d) => d.replaces).map((d) => [d.runId, d.replaces!]));
  let settled = ops.map((op) => {
    const running = (op.reviewLog ?? []).find((r) => r.status === "reviewing");
    return running ? (applyDrop(op, running.toolUseId, STOPPED_CHANGE) ?? op) : op;
  });
  // One version of each workout a redo was designing: the redo's when it was reviewed and is the better (a tie to the
  // redo: `redoKept`), else the first.
  for (const [redo, first] of Object.entries(redoOf)) {
    const redone = settled.find((op) => op.by?.runId === redo);
    const firstOp = settled.find((op) => op.by?.runId === first);
    if (!redone || !firstOp) continue;
    if (redone.review && redoKept(redone, firstOp).redo) settled = settled.filter((op) => op !== firstOp);
    else settled = settled.filter((op) => op !== redone);
  }
  // An expiry: a reviewed workout whose day has passed can't be proposed.
  const past = today ? settled.filter((op) => op.date < today && op.review) : [];
  const live = settled.filter((op) => !(today && op.date < today));
  const kept = live.filter((op) => op.review);
  const left = live.filter((op) => !op.review);
  if (kept.length === 0 || reviewRunning(kept)) return false;
  const undesigned = [
    ...new Set(
      designers
        .filter((d): d is SetDesigner & { day: string } => d.day !== null && d.status !== "finished" && !ops.some((op) => op.by?.runId === d.runId))
        .map((d) => d.day),
    ),
  ]
    .filter((day) => !kept.some((op) => op.date === day) && !(today && day < today))
    .sort();
  const lines = [
    note,
    ...(left.length > 0 ? [`Not reviewed before the stop, so left out: ${left.map((op) => `“${op.doc.title}” (${dayWords(op.date)})`).join(", ")}.`] : []),
    ...(past.length > 0 ? [pastDayLine(past)] : []),
    ...(undesigned.length > 0 ? [`Not designed before the stop: ${undesigned.map(dayWords).join(", ")}.`] : []),
  ];
  const f = proposalFields(kept);
  const written = (await db.all(sql`
    UPDATE coach_proposals SET status = 'pending', ops = ${JSON.stringify(kept)}, flags = ${JSON.stringify([...flags, ...lines])},
      title = ${f.title}, rationale = ${f.rationale}, expires_at = ${f.expiresAt}
    WHERE id = ${proposalId} AND user_id = ${userId} AND status = 'unreviewed' AND ops IS ${opsText}
    RETURNING id
  `)) as Array<{ id: string }>;
  return written.length > 0 || "lost";
}

// ── A newer plan supersedes an older one's days ─────────────────────────────────────────────────────────────────────

/** Why an older plan's workout gives way, in plain words (its op's outcome). */
export const SUPERSEDED_REASON = "a newer plan covers this session";

/** How far apart two sessions on one day start before they are two sessions, not one (minutes). */
export const SAME_SESSION_MINUTES = 180;

/**
 * A design proposal just made pending (`proposalId`; a finish, or a stop with what it has): every OLDER designed
 * proposal of the athlete's still theirs to decide (`pending`, `partially_approved`) with an OPEN op — no outcome yet, or
 * refused (a refused op stays open: design-approve.ts) — for a session the new one covers has that op's outcome set to
 * `{ status: "superseded", at, reason: SUPERSEDED_REASON, by: proposalId }`; its other ops are left alone. A session is
 * covered BY SESSION, NOT BY DAY (two sessions a day are legitimate): an older revision of a workout is covered by a
 * newer revision of the same workout; an older new workout by a newer NEW workout on its date whose time overlaps —
 * either has no time, or the two start within SAME_SESSION_MINUTES of each other. (A newer revision of a different
 * workout, already planned, is its own session: it never supersedes a new one near it.)
 *
 * Once every designed op of an older proposal is decided (applied, declined, superseded), its status follows
 * design-approve.ts `statusOfOps` (a test holds the two together): `approved` all applied, `partially_approved` some,
 * `declined` all declined, `superseded` none applied; while any op is open it keeps its status. `superseded_by` names
 * the new proposal only when the WHOLE proposal is superseded (status `superseded`): a proposal superseded in part is
 * still the athlete's, and each superseded op names its new proposal in its own outcome (`by`).
 *
 * ONE statement: each row's ops are read as that row is written, so an outcome written meanwhile is never lost.
 * Answers how many proposals it changed.
 */
export async function supersedeOlderPlans(db: Db, userId: string, proposalId: string, at: string): Promise<number> {
  const minutes = (time: SQL) => sql`(cast(substr(${time}, 1, 2) AS integer) * 60 + cast(substr(${time}, 4, 2) AS integer))`;
  /** An op this supersedes: a designed workout's, still open, for a session one of the new proposal's covers. */
  const covered = (value: SQL) => sql`(json_extract(${value}, '$.kind') = 'doc_workout'
    AND coalesce(json_extract(${value}, '$.outcome.status'), 'open') IN ('open', 'refused')
    AND EXISTS (SELECT 1 FROM coach_proposals np, json_each(np.ops) n
      WHERE np.id = ${proposalId} AND np.user_id = ${userId} AND np.status = 'pending' AND json_valid(np.ops)
        AND json_extract(n.value, '$.kind') = 'doc_workout'
        AND ((json_extract(${value}, '$.target.kind') = 'revise' AND json_extract(n.value, '$.target.kind') = 'revise'
              AND json_extract(${value}, '$.target.workoutId') = json_extract(n.value, '$.target.workoutId'))
          OR (json_extract(${value}, '$.target.kind') = 'new' AND json_extract(n.value, '$.target.kind') = 'new'
              AND json_extract(n.value, '$.date') = json_extract(${value}, '$.date')
              AND (json_extract(${value}, '$.time') IS NULL OR json_extract(n.value, '$.time') IS NULL
                OR abs(${minutes(sql`json_extract(${value}, '$.time')`)} - ${minutes(sql`json_extract(n.value, '$.time')`)}) <= ${SAME_SESSION_MINUTES})))))`;
  const outcome = sql`json_object('status', 'superseded', 'at', ${at}, 'reason', ${SUPERSEDED_REASON}, 'by', ${proposalId})`;
  // Each designed op's outcome once this is written.
  const after = sql`(SELECT CASE WHEN ${covered(sql`o.value`)} THEN 'superseded' ELSE coalesce(json_extract(o.value, '$.outcome.status'), 'open') END AS st
    FROM json_each(coach_proposals.ops) o WHERE json_extract(o.value, '$.kind') = 'doc_workout')`;
  const status = sql`(SELECT CASE
      WHEN sum(st IN ('applied', 'declined', 'superseded')) < count(*) THEN coach_proposals.status
      WHEN sum(st = 'applied') = count(*) THEN 'approved'
      WHEN sum(st = 'applied') > 0 THEN 'partially_approved'
      WHEN sum(st = 'declined') = count(*) THEN 'declined'
      ELSE 'superseded' END FROM ${after})`;
  const rows = (await db.all(sql`
    UPDATE coach_proposals SET
      ops = (SELECT json_group_array(CASE WHEN ${covered(sql`o.value`)} THEN json_set(o.value, '$.outcome', ${outcome}) ELSE json(o.value) END)
        FROM json_each(coach_proposals.ops) o),
      (status, resolved_at, superseded_by) = (SELECT s, CASE WHEN s = coach_proposals.status THEN coach_proposals.resolved_at ELSE ${at} END,
        CASE WHEN s = 'superseded' THEN ${proposalId} ELSE coach_proposals.superseded_by END FROM (SELECT ${status} AS s))
    WHERE user_id = ${userId} AND id <> ${proposalId} AND status IN ('pending', 'partially_approved') AND json_valid(ops)
      AND created_at < (SELECT created_at FROM coach_proposals WHERE id = ${proposalId} AND user_id = ${userId})
      AND EXISTS (SELECT 1 FROM json_each(coach_proposals.ops) o WHERE ${covered(sql`o.value`)})
    RETURNING id
  `)) as Array<{ id: string }>;
  return rows.length;
}

// ── The estimate ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One workout's designer with its reviewers, before any is measured (micros; see the module comment). */
export const DEFAULT_WORKOUT_COST_MICROS = 700_000;
/** A set's main run's own calls, before any is measured (micros). */
export const DEFAULT_SET_MAIN_COST_MICROS = 400_000;
/** How far back measured runs count. */
export const ESTIMATE_WINDOW_DAYS = 60;
/** Measured designers (finished, or stopped at their own ceiling) needed before their average replaces the default. */
export const ESTIMATE_MIN_DESIGNERS = 3;

export interface SetEstimate {
  /** The set's estimated cost: perWorkoutMicros × workouts + mainMicros. */
  micros: number;
  workouts: number;
  perWorkoutMicros: number;
  mainMicros: number;
  basis: { designer: "measured" | "default"; main: "measured" | "default" };
  samples: { designers: number; mains: number };
}

/** The set's estimated cost before its designers run (see the module comment). One statement. */
export async function estimateSetCost(db: Db, userId: string, workouts: number, now: Date): Promise<SetEstimate> {
  const since = new Date(now.getTime() - ESTIMATE_WINDOW_DAYS * 86_400_000).toISOString();
  // What a designer cost: its own spend and its reviewers'.
  const cost = sql`(d.cost_usd + coalesce((SELECT sum(r.cost_usd) FROM coach_runs r WHERE r.user_id = ${userId} AND r.parent_id = d.id), 0))`;
  // A designer that stopped at its OWN ceiling — its spend reached its limit, so it ran — spent what a workout can
  // cost: it counts (leaving it out would read low). One stopped by the set's limit before it ran (nothing spent), or
  // part way, doesn't.
  const designers = sql`FROM coach_runs d WHERE d.user_id = ${userId} AND d.role = 'designer' AND d.created_at >= ${since}
    AND (d.status = 'finished' OR (d.status = 'stopped_cap' AND d.error = 'run_ceiling'
      AND json_valid(d.state) AND ${cost} * 1000000 >= json_extract(d.state, '$.settings.ceilingMicros')))`;
  const mains = sql`FROM coach_runs m WHERE m.user_id = ${userId} AND m.parent_id IS NULL AND m.status = 'finished' AND m.created_at >= ${since}
    AND json_valid(m.scope) AND json_extract(m.scope, '$.kind') IN ('week', 'next_n')`;
  const [row] = (await db.all(sql`
    SELECT
      (SELECT count(*) ${designers}) AS designers,
      (SELECT coalesce(sum(${cost}), 0) ${designers}) AS designerCost,
      (SELECT count(*) ${mains}) AS mains,
      (SELECT coalesce(sum(m.cost_usd), 0) ${mains}) AS mainCost
  `)) as Array<{ designers: number; designerCost: number; mains: number; mainCost: number }>;
  const nd = Number(row?.designers ?? 0);
  const nm = Number(row?.mains ?? 0);
  const designerMeasured = nd >= ESTIMATE_MIN_DESIGNERS;
  const mainMeasured = nm >= 1;
  const perWorkoutMicros = designerMeasured ? Math.round((Number(row!.designerCost) * 1_000_000) / nd) : DEFAULT_WORKOUT_COST_MICROS;
  const mainMicros = mainMeasured ? Math.round((Number(row!.mainCost) * 1_000_000) / nm) : DEFAULT_SET_MAIN_COST_MICROS;
  return {
    micros: perWorkoutMicros * workouts + mainMicros,
    workouts,
    perWorkoutMicros,
    mainMicros,
    basis: { designer: designerMeasured ? "measured" : "default", main: mainMeasured ? "measured" : "default" },
    samples: { designers: nd, mains: nm },
  };
}

// ── Judging the set ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A workout as hard: its intent's effort develops or peaks. */
export const isHard = (op: DocWorkoutOp): boolean => op.doc?.intent?.effort === "develop" || op.doc?.intent?.effort === "peak";

/** Pairs of the set's hard workouts on consecutive days (two hard days in a row), by date. */
export function hardPairs(ops: DocWorkoutOp[]): Array<[string, string]> {
  const days = [...new Set(ops.filter(isHard).map((o) => o.date))].sort();
  const out: Array<[string, string]> = [];
  for (let i = 1; i < days.length; i++) if (daysBetween(days[i - 1]!, days[i]!) === 1) out.push([days[i - 1]!, days[i]!]);
  return out;
}

/** The moves a workout uses (library ids, each once, in order), at most MOVES_SHOWN. */
export const MOVES_SHOWN = 12;
export function movesOf(op: DocWorkoutOp): string[] {
  const out: string[] = [];
  for (const part of op.doc?.parts ?? []) {
    for (const item of part.items ?? []) if (item.kind === "exercise" && !out.includes(item.libraryId)) out.push(item.libraryId);
  }
  return out.slice(0, MOVES_SHOWN);
}

/** The moves two of the set's workouts on consecutive days share (variety, and the same tissues two days running). */
export function repeatsOnConsecutiveDays(ops: DocWorkoutOp[]): Array<{ days: [string, string]; moves: string[] }> {
  const byDay = new Map<string, Set<string>>();
  for (const op of ops) {
    const moves = byDay.get(op.date) ?? new Set<string>();
    for (const part of op.doc?.parts ?? []) for (const item of part.items ?? []) if (item.kind === "exercise") moves.add(item.libraryId);
    byDay.set(op.date, moves);
  }
  const days = [...byDay.keys()].sort();
  const out: Array<{ days: [string, string]; moves: string[] }> = [];
  for (let i = 1; i < days.length; i++) {
    if (daysBetween(days[i - 1]!, days[i]!) !== 1) continue;
    const later = byDay.get(days[i]!)!;
    const shared = [...byDay.get(days[i - 1]!)!].filter((m) => later.has(m)).sort();
    if (shared.length > 0) out.push({ days: [days[i - 1]!, days[i]!], moves: shared });
  }
  return out;
}
