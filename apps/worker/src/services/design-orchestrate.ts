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
 *     what was reviewed, the rest left out with a line.
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
import { sql } from "drizzle-orm";
import { addDays, daysBetween, isoWeekday } from "@rg/domain";
import type { Db } from "./db.js";
import { horizonDays } from "./design-context.js";
import { SET_MAX_WORKOUTS } from "./design-limits.js";
import { applyDrop, meanScore, proposalFields } from "./design-review.js";
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

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "Saturday 16 May". */
export function dayWords(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${WEEKDAYS[isoWeekday(date) - 1]} ${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/**
 * A designer's brief as its opening context carries it (marked whole as the main coach's words: design-context.ts):
 * the brief's own fields, and on a redo what the first version was and what its review asked to change.
 */
export function briefText(b: SetBrief, o: { index: number; count: number; first?: { title: string; mustFix: string[] } | null }): string {
  return [
    `Workout "${b.key}", ${o.index + 1} of ${o.count} in the set${b.note ? " — a redo" : ""}.`,
    `Date: ${dayWords(b.date)} (${b.date})${b.time ? `, at ${b.time}` : ""}.`,
    `Purpose: ${b.purpose}`,
    `Emphasis: ${b.emphasis}`,
    `Constraints: ${b.constraints}`,
    `Why: ${b.why}`,
    ...(b.sameDayWhy ? [`A second session that day, because: ${b.sameDayWhy}`] : []),
    ...(b.note ? [`What to change from the first version: ${b.note}`] : []),
    ...(o.first
      ? [`The first version was "${o.first.title}"${o.first.mustFix.length > 0 ? `; its review's must-fix items: ${o.first.mustFix.join("; ")}` : ""}.`]
      : []),
  ].join("\n");
}

// ── The proposal ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A design proposal as stored: its ops (and their text, for a guarded write), status and lines. One statement. */
export async function readSetProposal(
  db: Db,
  userId: string,
  proposalId: string,
): Promise<{ opsText: string | null; ops: DocWorkoutOp[]; status: string | null; flags: string[] }> {
  const rows = (await db.all(sql`
    SELECT ops, status, flags FROM coach_proposals WHERE id = ${proposalId} AND user_id = ${userId}
  `)) as Array<{ ops: string | null; status: string; flags: string | null }>;
  const row = rows[0];
  const list = (text: string | null | undefined): unknown[] => {
    try {
      const v: unknown = text ? JSON.parse(text) : [];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return {
    opsText: row?.ops ?? null,
    ops: list(row?.ops) as DocWorkoutOp[],
    status: row?.status ?? null,
    flags: list(row?.flags).filter((f): f is string => typeof f === "string"),
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
    case null:
      return "it ended without a workout";
    default:
      return "the AI service refused the request";
  }
}

/** A proposed workout as plan_set's result gives it. */
function proposedEntry(op: DocWorkoutOp): Record<string, unknown> {
  const r = op.review;
  return {
    opId: opIdOf(op),
    title: untrusted(op.doc.title),
    minutes: op.derived?.minutes ?? null,
    balance: balanceInUnits(op.derived?.balance as Record<string, unknown> | undefined),
    reviewMean: reviewMeanOf(op),
    mustFix: r?.mustFix?.length ?? 0,
    rounds: r?.rounds ?? 0,
    ...(r?.note ? { reviewNote: r.note } : {}),
  };
}

const NEXT_WITH_REDO =
  "Judge the set as a whole: read_set shows each workout with its review, the set's combined balance and hard days in a row. Take one out with drop_workout (a plain reason for the athlete), or call plan_set once more with briefs for the keys to redo, each with a note. Then call finish with one plain line on how the set fits together.";
const NEXT_NO_REDO =
  "Judge the set as a whole (read_set). Take one out with drop_workout if it must go — no rounds of redo are left. Then call finish with one plain line on how the set fits together.";

/**
 * The set's outcome once every designer of `round` is over (the main run's own step; ≤ 2 statements: the proposal, and
 * the ops and lines written when anything changed). Each brief's workout is proposed — its draft still under review
 * dropped, the reviewed version kept — or left out with its reason: an unreviewed draft is taken out, and the
 * proposal's lines say why that day has no workout. A redo's reviewed workout replaces the first version; a redo that
 * couldn't be designed keeps it; a redo of a day left out takes back the line that said so. Answers plan_set's result
 * for the model and the trail's line.
 */
export async function settleSet(
  db: Db,
  userId: string,
  o: { proposalId: string; round: SetRound; earlier?: SetRound[]; designers: DesignerEnd[]; redoLeft: number },
): Promise<{ data: Record<string, unknown>; line: string }> {
  const { ops, opsText, status, flags } = await readSetProposal(db, userId, o.proposalId);
  let next = [...ops];
  let kept = [...flags];
  const lines: string[] = [];
  const out: Array<Record<string, unknown>> = [];
  const tally = { proposed: 0, replaced: 0, keptFirst: 0, leftOut: 0 };
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
    const base = { key: b.key, date: b.date };
    // A redo of a day the first plan left out: the line saying so no longer stands (a new one is written if it is left
    // out again).
    const was = (o.earlier ?? []).flatMap((r) => r.briefs).find((x) => x.key === b.key);
    if (was && !first) kept = kept.filter((f) => !f.startsWith(noWorkoutFor(was.date)));
    if (op && op.review) {
      if (first) next = next.filter((x) => x !== first);
      const stopped = d && d.status !== "finished" ? { note: `${keptWhy(d)} after a draft was reviewed: the reviewed version stands` } : {};
      out.push({ ...base, outcome: first ? "replaced" : "proposed", ...proposedEntry(op), ...stopped });
      tally[first ? "replaced" : "proposed"] += 1;
      continue;
    }
    // Never shown unreviewed: the draft is taken out.
    if (op) next = next.filter((x) => x !== op);
    const reason = leftOutWhy(d, op);
    const said = d?.final ? { designerSaid: untrusted(d.final) } : {};
    if (first) {
      out.push({ ...base, outcome: "kept_first", opId: opIdOf(first), reason: `the redo couldn't be designed: ${reason}`, ...said });
      tally.keptFirst += 1;
    } else {
      out.push({ ...base, outcome: "left_out", reason, ...said });
      lines.push(`${noWorkoutFor(b.date)} ${reason}.`);
      tally.leftOut += 1;
    }
  }
  const changed = next.length !== ops.length || next.some((x, i) => x !== ops[i]) || lines.length > 0 || kept.length !== flags.length;
  if (changed && status !== null) await writeSetOps(db, userId, o.proposalId, next, opsText, [...kept, ...lines]);
  const parts = o.round.redo
    ? [
        ...(tally.replaced ? [`${tally.replaced} replaced`] : []),
        ...(tally.proposed ? [`${tally.proposed} proposed`] : []),
        ...(tally.keptFirst ? [`${tally.keptFirst} kept as first designed`] : []),
        ...(tally.leftOut ? [`${tally.leftOut} left out`] : []),
      ]
    : [`${tally.proposed} proposed`, ...(tally.leftOut ? [`${tally.leftOut} left out`] : [])];
  return {
    data: {
      set: out,
      proposed: tally.proposed + tally.replaced,
      leftOut: tally.leftOut,
      ...(o.round.redo ? { keptFirst: tally.keptFirst } : {}),
      workoutsInProposal: next.length,
      redoLeft: o.redoLeft,
      next: o.redoLeft > 0 ? NEXT_WITH_REDO : NEXT_NO_REDO,
    },
    line: `${o.round.redo ? "The redo is in" : "The set is designed"}: ${parts.join(", ")}.`,
  };
}

// ── A set stopped with what it has ──────────────────────────────────────────────────────────────────────────────────

const STOPPED_CHANGE = "not reviewed: the coach stopped before its review was in.";

/**
 * A set's main run that stopped at a spending limit or its step cap proposes what was reviewed (spec §2; Task 6's
 * `promoteWithWhatItHas`, for a set): a draft still under review is dropped, the held reviewed version staying; a
 * workout with no review is left out, and a line says which; the stop's note goes in the proposal's lines. Pending
 * under the finish's own guard — still `unreviewed` (a rehearsal stays one), the ops it read — and only with at least
 * one reviewed workout. Two statements (the read, the write; none written when nothing can be proposed).
 */
export async function promoteSetWithWhatItHas(db: Db, userId: string, proposalId: string, note: string): Promise<boolean> {
  const { ops, opsText, status, flags } = await readSetProposal(db, userId, proposalId);
  if (status !== "unreviewed" || ops.length === 0) return false;
  const settled = ops.map((op) => {
    const running = (op.reviewLog ?? []).find((r) => r.status === "reviewing");
    return running ? (applyDrop(op, running.toolUseId, STOPPED_CHANGE) ?? op) : op;
  });
  const kept = settled.filter((op) => op.review);
  const left = settled.filter((op) => !op.review);
  if (kept.length === 0) return false;
  const lines = [
    note,
    ...(left.length > 0 ? [`Not reviewed before the stop, so left out: ${left.map((op) => `“${op.doc.title}” (${dayWords(op.date)})`).join(", ")}.`] : []),
  ];
  const f = proposalFields(kept);
  const written = (await db.all(sql`
    UPDATE coach_proposals SET status = 'pending', ops = ${JSON.stringify(kept)}, flags = ${JSON.stringify([...flags, ...lines])},
      title = ${f.title}, rationale = ${f.rationale}, expires_at = ${f.expiresAt}
    WHERE id = ${proposalId} AND user_id = ${userId} AND status = 'unreviewed' AND ops IS ${opsText}
    RETURNING id
  `)) as Array<{ id: string }>;
  return written.length > 0;
}

// ── The estimate ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One workout's designer with its reviewers, before any is measured (micros; see the module comment). */
export const DEFAULT_WORKOUT_COST_MICROS = 700_000;
/** A set's main run's own calls, before any is measured (micros). */
export const DEFAULT_SET_MAIN_COST_MICROS = 400_000;
/** How far back measured runs count. */
export const ESTIMATE_WINDOW_DAYS = 60;
/** Finished designers needed before their average replaces the default. */
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
  const designers = sql`FROM coach_runs d WHERE d.user_id = ${userId} AND d.role = 'designer' AND d.status = 'finished' AND d.created_at >= ${since}`;
  const mains = sql`FROM coach_runs m WHERE m.user_id = ${userId} AND m.parent_id IS NULL AND m.status = 'finished' AND m.created_at >= ${since}
    AND json_valid(m.scope) AND json_extract(m.scope, '$.kind') IN ('week', 'next_n')`;
  const [row] = (await db.all(sql`
    SELECT
      (SELECT count(*) ${designers}) AS designers,
      (SELECT coalesce(sum(d.cost_usd + coalesce((SELECT sum(r.cost_usd) FROM coach_runs r WHERE r.user_id = ${userId} AND r.parent_id = d.id), 0)), 0) ${designers}) AS designerCost,
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
