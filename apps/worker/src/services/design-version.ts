/**
 * WHAT THE OWNER IS APPROVING, EXACTLY (R1; the LifeOS migration's DESIGN-3 §3.4.4, §3.8; the lead's v0.20 rulings:
 * explicit operation and version approval, incomplete output never approvable).
 *
 *  - `proposalVersion`: the sha-256 of the proposal's status and ops, canonical (keys sorted, undefined dropped) — every
 *    decision on any op (an approve, a decline, a claim, a supersede) changes it. A phone's approve must send the version it
 *    was shown; any other is 409 `proposal_changed` with the fresh one, and the phone shows the ops again.
 *  - `opsSummaryOf`: each op as typed fields only — what it does (add, revise, move, skip, ease, other), its day and time,
 *    its minutes before and after, its category and how it ended. No title, no words of the coach's: what LifeOS's digest
 *    may carry with switch B on (DESIGN-3 §3.3.1 `results`), and what the phone's grouped card lists.
 *  - `completenessOf`: a designed proposal is complete only when its main run ended through `finish` (`finished`). One that
 *    stopped — at its step cap or its ceiling, the week's cap, a failure, a cancel, its window closing — proposes what had
 *    been reviewed, and is `complete: false` with why: a device may never approve it (409 `incomplete`). Cut-off output
 *    never became an op in the first place: a turn that stopped at `max_tokens` runs no tools (coach-runs.ts), and an op
 *    exists only once `propose_workout` validated and reviewed it. The laptop's approve is unchanged (DESIGN-3 §6.1).
 */
import { and, eq } from "drizzle-orm";
import { coachRuns } from "@rg/database";
import type { Db } from "./db.js";
import { endedLine, readRunState } from "./coach-runs.js";

/** What a phone says of a proposal whose run ended without its finish. */
export const UNFINISHED_LINE = "The coach stopped before it finished this: ask again, or open it on the laptop.";
import { designProposalId } from "./design-tools/propose.js";
import { allDesignedOps, type AnyDesignedOp } from "./design-approve.js";
import { isDocWorkoutOp, isPlanAdjustOp, opIdOf } from "./proposal-kinds.js";

export { canonicalJson, proposalVersion } from "./proposal-version.js";

export type SummaryOp = "add" | "revise" | "move" | "skip" | "ease" | "other";

/** One op, typed fields only (never a title or the coach's words). */
export interface OpSummary {
  opId: string;
  op: SummaryOp;
  workoutId?: string;
  day: string;
  start?: string;
  minutesBefore?: number;
  minutesAfter?: number;
  category?: string;
  outcome?: string;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const CLOCK = /^\d{2}:\d{2}$/;
const clock = (v: unknown): string | undefined => (typeof v === "string" && CLOCK.test(v) ? v : undefined);
/** Only the app's own vocabulary passes into the summary: a category the plan uses. */
const CATEGORIES = new Set(["recovery", "easy", "long", "quality", "race", "cross_training", "strength", "yoga", "rest", "unknown", "mobility"]);
const category = (v: unknown): string | undefined => (typeof v === "string" && CATEGORIES.has(v) ? v : undefined);

const compact = (o: OpSummary): OpSummary => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as unknown as OpSummary;

/** Each op of a designed proposal, typed (see the module comment). */
export function opsSummaryOf(ops: unknown): OpSummary[] {
  return allDesignedOps(ops).map((o: AnyDesignedOp) => {
    const outcome = str((o as { outcome?: { status?: unknown } }).outcome?.status);
    if (isDocWorkoutOp(o)) {
      const d = o as Extract<AnyDesignedOp, { kind: "doc_workout" }>;
      const applied = (d.outcome?.status === "applied" ? d.outcome : null) as { workoutId?: string } | null;
      return compact({
        opId: opIdOf(d),
        op: d.target.kind === "new" ? "add" : "revise",
        workoutId: d.target.kind === "revise" ? d.target.workoutId : applied?.workoutId,
        day: d.date,
        start: clock(d.target.kind === "new" ? d.target.time : d.time),
        minutesAfter: num(d.derived?.minutes),
        category: category(d.derived?.category),
        outcome,
      });
    }
    if (isPlanAdjustOp(o)) {
      const c = o as Extract<AnyDesignedOp, { kind: "plan_adjust" }>;
      const k = c.op.kind;
      const op: SummaryOp = k === "move" ? "move" : k === "skip" ? "skip" : k === "ease" || k === "adjust" ? "ease" : "other";
      const after = k === "adjust" ? num((c.op as { durationMinutes?: unknown }).durationMinutes) : k === "ease" ? num((c.op as { session?: { durationMinutes?: unknown } }).session?.durationMinutes) : undefined;
      return compact({
        opId: c.id,
        op,
        workoutId: c.op.workoutId,
        day: k === "move" ? (c.op as { toDate: string }).toDate : c.date,
        start: clock(k === "move" ? (c.op as { toTime?: unknown }).toTime : c.row?.time),
        minutesBefore: num(c.row?.minutes),
        minutesAfter: after,
        category: category(c.row?.category),
        outcome,
      });
    }
    return compact({ opId: opIdOf(o as never), op: "other", day: str((o as { date?: unknown }).date) ?? "", outcome });
  });
}

/** Whether a designed proposal came from a run that finished, and if not, why (its run's end). */
export async function completenessOf(db: Db, userId: string, proposalId: string): Promise<{ complete: boolean; missing?: { status: string; error: string | null; line: string | null } }> {
  const prefix = designProposalId("");
  const runId = proposalId.startsWith(prefix) ? proposalId.slice(prefix.length) : null;
  if (!runId) return { complete: false, missing: { status: "unknown", error: null, line: null } };
  const [run] = await db
    .select({ status: coachRuns.status, error: coachRuns.error, state: coachRuns.state })
    .from(coachRuns)
    .where(and(eq(coachRuns.id, runId), eq(coachRuns.userId, userId)))
    .limit(1);
  // POSITIVELY (review B-1): finished, AND through the finish tool. A run that ended `finished` in words — a words-only last
  // turn, or a tool refused on its last call (its step cap reached) — proposed what was reviewed, unfinished.
  const endedBy = run ? readRunState(run.state)?.endedBy : undefined;
  if (run?.status === "finished" && endedBy === "finish") return { complete: true };
  if (run?.status === "finished") return { complete: false, missing: { status: "unfinished", error: null, line: UNFINISHED_LINE } };
  const status = run?.status ?? "unknown";
  return { complete: false, missing: { status, error: run?.error ?? null, line: run ? endedLine(status, run.error ?? null, undefined) : null } };
}
