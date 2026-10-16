/**
 * Two kinds of op share `coach_proposals.ops` (Stage 3 Task 6): the thread coach's `CoachOp`s, and the coach
 * designer's `doc_workout` (design-tools/propose.ts). The thread coach's readers — its state route, the wake's
 * supersede step and context, the race hub — were written for the first; each reads a designed workout's op through
 * these, so it ignores or describes it and never throws on it. A designed workout's proposal is approved on its own
 * surface (Task 8); until then the thread's approve and decline answer it 409 `not_yet`.
 */
import type { CoachOp } from "@rg/domain";

/** Whether an op is a designed workout's. */
export const isDocWorkoutOp = (op: unknown): boolean => !!op && typeof op === "object" && (op as { kind?: unknown }).kind === "doc_workout";

/**
 * A designed workout's op id: the run that designed it. Each run holds ONE op of its main run's proposal, whatever its
 * target (design-tools/propose.ts), so the run names the op through every revision round. Approve and decline (Task 8)
 * and a main run's lever over its set (Task 7) name an op by it.
 */
export const opIdOf = (op: { by: { runId: string } }): string => op.by.runId;

/** Whether a proposal's ops hold a designed workout. */
export const hasDocWorkout = (ops: unknown): boolean => Array.isArray(ops) && ops.some(isDocWorkoutOp);

/** A proposal's thread-coach ops: a designed workout's are left out. */
export const coachOpsOf = (ops: unknown): CoachOp[] => (Array.isArray(ops) ? (ops.filter((o) => !isDocWorkoutOp(o)) as CoachOp[]) : []);

/** An op the athlete has decided — approved, declined, or superseded by a newer plan (design-approve.ts); a refused one
 * is still theirs to decide. */
const decided = (op: unknown): boolean => ["applied", "declined", "superseded"].includes(String((op as { outcome?: { status?: unknown } }).outcome?.status));

/** The days a proposal's designed workouts still to decide are for, in order: one decided is named no more. */
export function docWorkoutDates(ops: unknown): string[] {
  if (!Array.isArray(ops)) return [];
  const dates = ops.filter((o) => isDocWorkoutOp(o) && !decided(o)).map((o) => (o as { date?: unknown }).date);
  return [...new Set(dates.filter((d): d is string => typeof d === "string"))].sort();
}
