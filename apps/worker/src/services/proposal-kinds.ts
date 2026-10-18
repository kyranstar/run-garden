/**
 * Kinds of op that share `coach_proposals.ops` (Stage 3 Task 6, Task 8b): the thread coach's `CoachOp`s, and the coach
 * designer's two — `doc_workout`, a designed workout (design-tools/propose.ts), and `plan_adjust`, a change to a session
 * already on the plan (design-tools/adjust-plan.ts), holding the thread coach's own `CoachOp` of that kind. The thread
 * coach's readers — its state route, the wake's supersede step and context, the race hub — were written for the first;
 * each reads a designed op through these, so it ignores or describes it and never throws on it. A designed proposal is
 * approved on its own surface (Task 8); until then the thread's approve and decline answer it 409 `not_yet`.
 */
import { dayLabel, describeOps, type CoachOp } from "@rg/domain";

/** The thread coach's ops a designed proposal may carry as a change to the plan (Task 8b; ruling I6), and since the new
 * shape §5 its proven single-session ones too: ease (a swap for an easier kind is an ease, its `verb` "swap"), remove
 * and restore — never a two-day swap, an add or a programme-level op: those stay the thread coach's. */
export type PlanChange = Extract<CoachOp, { kind: "skip" | "move" | "adjust" | "ease" | "remove" | "restore" }>;

/** A change as the coach asked for it (adjust_plan's kind): the op's own, or "swap" — an ease to an easier kind. */
export type ChangeVerb = PlanChange["kind"] | "swap";

/** What the plan held for a session when the coach proposed a change to it: the manifest's `PlannedRef`, as it was. */
export interface PlanRowSnapshot {
  date: string;
  time: string;
  /** The session's name as the app shows it. */
  title: string;
  /** Its planned length, or null when the row states none. */
  minutes: number | null;
  category: string;
  origin: string | null;
  /** COROS holds it at an address (the manifest's "watch unchanged"). */
  onWatch: boolean;
  /** The app put it on the watch (its address and its create job): a remove takes it back off (the thread coach's
   * manifest says so). */
  appPushed?: boolean;
}

/**
 * A change to a session already on the plan, inside a designed proposal (Task 8b): ONE thread-coach op, applied at
 * approval through coach-apply's own applier. Never reviewed: it is a plan change, not a document. Its `why` is model
 * text — data, marked wherever it is shown back to a model.
 */
export interface PlanAdjustOp {
  kind: "plan_adjust";
  /** Its op id (`planAdjustId`): one change per session per proposal — a second replaces the first. */
  id: string;
  op: PlanChange;
  /** A swap's (the new shape §5): an ease to an easier kind of session, as the coach asked for it. */
  verb?: "swap";
  why: string;
  /** Advisory notes for the athlete, as a workout's validator warnings are. */
  issues: Array<{ code: string; message: string }>;
  /** The session's day when the change was proposed. */
  date: string;
  row: PlanRowSnapshot;
  /** The model's call that proposed it: a replay of the call finds it. */
  toolUseId: string;
  /** The calls whose changes of this session this one replaced. */
  replaces?: string[];
  at: string;
}

/**
 * The thread coach's structural ops a designed proposal may carry as a whole plan change (§8 §5): a new block, its
 * extension, a week firmed up or reworked, its wind-down, its retirement — never `resolveRaceConflict`, which the athlete
 * settles from the race strip.
 */
export const PLAN_STRUCTURE_KINDS = ["createPlan", "extendPlan", "windDown", "retirePlan", "firmUp", "reshapeWeek"] as const;
export type PlanStructureChange = Extract<CoachOp, { kind: (typeof PLAN_STRUCTURE_KINDS)[number] }>;

/** A plan change's op id: a proposal holds one (a whole plan is one intention: a second propose_plan replaces it). */
export const PLAN_STRUCTURE_ID = "plan";

/**
 * A whole plan change inside a designed proposal (§8 §5; design-tools/propose-plan.ts): ONE thread-coach structural op,
 * judged by the thread coach's own guardrails when proposed and applied at approval in resumable chunks through
 * coach-apply's `applyStructuralChunk` (design-approve.ts). Never reviewed: its sessions are the thread coach's session
 * specs, not documents. What the card and the conversation show is computed when it is proposed (`title`, `summary`,
 * `lines`: the thread coach's own `describeOps` lines) so a read needs no plan. `why`, the title and the lines carry the
 * model's words: data, marked wherever they are shown back to a model.
 */
export interface PlanStructureOp {
  kind: "plan_structure";
  /** `PLAN_STRUCTURE_ID`. */
  id: string;
  op: PlanStructureChange;
  why: string;
  /** The guardrails' advisories, kept as a workout's validator warnings are. */
  issues: Array<{ code: string; message: string }>;
  /** "10K build", "Extend 10K build". */
  title: string;
  /** One line: "4 weeks · 6 sessions to start · race Sat 13 Jun". */
  summary: string;
  /** The manifest's lines, at most PLAN_LINES_MAX and then "and N more". */
  lines: string[];
  /** Which plan it shapes: `plan:<id>` for a block, `new:<discipline>` for a new one — a newer plan change for the same
   * plan covers this one (design-cover.ts). */
  planKey: string;
  /** The first day it puts work on, or (no session) the day it takes effect from. */
  date: string;
  /** The model's call that proposed it: a replay finds it. */
  toolUseId: string;
  /** The calls whose plan changes this one replaced. */
  replaces?: string[];
  at: string;
}

/** A plan change's manifest lines shown, at most; the rest are counted. */
export const PLAN_LINES_MAX = 8;

/** A change's op id: one per session per proposal. */
export const planAdjustId = (workoutId: string): string => `adj-${workoutId}`;

/** A change's kind as the coach asked for it: "swap" for an ease to an easier kind, else its op's. */
export const changeVerb = (c: Pick<PlanAdjustOp, "op" | "verb">): ChangeVerb => c.verb ?? c.op.kind;

/** A change in words: the thread coach's own manifest line for its op (@rg/domain `describeOps`), with the session as the
 * plan held it when the coach proposed the change. */
export interface ChangeWords {
  /** The day the line is under: a move's destination, else the session's day. */
  date: string | null;
  /** A move's time asked for, else null. */
  time: string | null;
  /** "Strength — skipped", "Easy run — 30 min", a moved session's name. */
  summary: string;
  /** What it replaced: a move's old day, a length's old minutes — only a real difference. */
  was: string | null;
  /** A sentence for what `was` can't say: a skip's reason. */
  effect: string | null;
  /** The change as a proposal's title names it ("Strength — moved to Sat 16 May": a move's line names only the session). */
  title: string;
}

export function describeChange(p: Pick<PlanAdjustOp, "op" | "row">): ChangeWords {
  const planned = new Map([
    [
      p.op.workoutId,
      {
        date: p.row.date,
        summary: p.row.title,
        ...(p.row.minutes !== null ? { durationMinutes: p.row.minutes } : {}),
        ...(p.row.onWatch ? { onWatch: true } : {}),
        ...(p.row.appPushed ? { appPushed: true } : {}),
      },
    ],
  ]);
  const [line] = describeOps([p.op], planned);
  return {
    date: line?.date ?? null,
    time: p.op.kind === "move" ? (p.op.toTime ?? null) : null,
    summary: line?.summary ?? p.row.title,
    was: line?.was ?? null,
    effect: line?.change ?? null,
    title: p.op.kind === "move" ? `${p.row.title} — moved to ${dayLabel(p.op.toDate)}` : (line?.summary ?? p.row.title),
  };
}

const kindOf = (op: unknown): unknown => (!!op && typeof op === "object" ? (op as { kind?: unknown }).kind : undefined);

/** Whether an op is a designed workout's. */
export const isDocWorkoutOp = (op: unknown): boolean => kindOf(op) === "doc_workout";

/** Whether an op is a change to a session already on the plan (Task 8b). */
export const isPlanAdjustOp = (op: unknown): op is PlanAdjustOp => kindOf(op) === "plan_adjust";

/** Whether an op is a whole plan change (§8 §5). */
export const isPlanStructureOp = (op: unknown): op is PlanStructureOp => kindOf(op) === "plan_structure";

/** Whether an op is the coach designer's — a designed workout, a change or a plan change — never one of the thread
 * coach's. */
export const isDesignedOp = (op: unknown): boolean => isDocWorkoutOp(op) || isPlanAdjustOp(op) || isPlanStructureOp(op);

/**
 * An op's id: a designed workout's is the run that designed it — each run holds ONE op of its main run's proposal,
 * whatever its target (design-tools/propose.ts), so the run names the op through every revision round; a change's is
 * its own (`planAdjustId`). Approve and decline (Task 8) and a main run's lever over its set (Task 7) name an op by it.
 */
export function opIdOf(op: { by: { runId: string } } | PlanAdjustOp | PlanStructureOp): string {
  return isPlanAdjustOp(op) || isPlanStructureOp(op) ? op.id : (op as { by: { runId: string } }).by.runId;
}

/** Whether a proposal's ops hold a designed workout. */
export const hasDocWorkout = (ops: unknown): boolean => Array.isArray(ops) && ops.some(isDocWorkoutOp);

/** Whether a proposal is the coach designer's: it holds a designed workout, a change or a plan change — one of changes
 * alone too. */
export const isDesignedProposal = (ops: unknown): boolean => Array.isArray(ops) && ops.some(isDesignedOp);

/** A proposal's thread-coach ops: the designer's are left out. */
export const coachOpsOf = (ops: unknown): CoachOp[] => (Array.isArray(ops) ? (ops.filter((o) => !isDesignedOp(o)) as CoachOp[]) : []);

/** An op the athlete has decided — approved, declined, or superseded by a newer plan (design-approve.ts); a refused one
 * is still theirs to decide. */
const decided = (op: unknown): boolean => ["applied", "declined", "superseded"].includes(String((op as { outcome?: { status?: unknown } }).outcome?.status));

/** The days a proposal's designed workouts still to decide are for, in order: one decided is named no more. */
export function docWorkoutDates(ops: unknown): string[] {
  if (!Array.isArray(ops)) return [];
  const dates = ops.filter((o) => isDocWorkoutOp(o) && !decided(o)).map((o) => (o as { date?: unknown }).date);
  return [...new Set(dates.filter((d): d is string => typeof d === "string"))].sort();
}

/** How many of a proposal's changes are still the athlete's to decide. */
export function openPlanChanges(ops: unknown): number {
  return Array.isArray(ops) ? ops.filter((o) => isPlanAdjustOp(o) && !decided(o)).length : 0;
}
