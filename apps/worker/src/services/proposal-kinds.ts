/**
 * Kinds of op that share `coach_proposals.ops` (Stage 3 Task 6, Task 8b): the thread coach's `CoachOp`s, and the coach
 * designer's two — `doc_workout`, a designed workout (design-tools/propose.ts), and `plan_adjust`, a change to a session
 * already on the plan (design-tools/adjust-plan.ts), holding the thread coach's own `CoachOp` of that kind. The thread
 * coach's readers — its state route, the wake's supersede step and context, the race hub — were written for the first;
 * each reads a designed op through these, so it ignores or describes it and never throws on it. A designed proposal is
 * approved on its own surface (Task 8); until then the thread's approve and decline answer it 409 `not_yet`.
 */
import { dayLabel, describeOps, type CoachOp } from "@rg/domain";

/** The thread coach's ops a designed proposal may carry as a change to the plan (Task 8b; ruling I6): never ease, swap,
 * remove, add or a programme-level op — those stay the thread coach's. */
export type PlanChange = Extract<CoachOp, { kind: "skip" | "move" | "adjust" }>;

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

/** A change's op id: one per session per proposal. */
export const planAdjustId = (workoutId: string): string => `adj-${workoutId}`;

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
    [p.op.workoutId, { date: p.row.date, summary: p.row.title, ...(p.row.minutes !== null ? { durationMinutes: p.row.minutes } : {}), ...(p.row.onWatch ? { onWatch: true } : {}) }],
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

/** Whether an op is the coach designer's — a designed workout or a change — never one of the thread coach's. */
export const isDesignedOp = (op: unknown): boolean => isDocWorkoutOp(op) || isPlanAdjustOp(op);

/**
 * An op's id: a designed workout's is the run that designed it — each run holds ONE op of its main run's proposal,
 * whatever its target (design-tools/propose.ts), so the run names the op through every revision round; a change's is
 * its own (`planAdjustId`). Approve and decline (Task 8) and a main run's lever over its set (Task 7) name an op by it.
 */
export function opIdOf(op: { by: { runId: string } } | PlanAdjustOp): string {
  return isPlanAdjustOp(op) ? op.id : (op as { by: { runId: string } }).by.runId;
}

/** Whether a proposal's ops hold a designed workout. */
export const hasDocWorkout = (ops: unknown): boolean => Array.isArray(ops) && ops.some(isDocWorkoutOp);

/** Whether a proposal is the coach designer's: it holds a designed workout or a change — one of changes alone too. */
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
