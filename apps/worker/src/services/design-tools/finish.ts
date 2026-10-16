/**
 * finish(summary) — the run's end, with one plain line for the athlete (Stage 3 spec §4; principles §2.9, §6.5): what
 * was proposed, or why not, without restating what the proposal card computes. Its control is `finish`: the loop ends
 * the run, writes the line as the run's last event (its result: the run view and the thread read it there) with this
 * call's receipt, and makes `data.proposalId` the run's proposal — the main run's design proposal when it has one, or
 * for a designer, when it added a workout to it.
 *
 * Review comes before the athlete sees anything (spec §5): the loop's finish makes the main run's proposal `pending`
 * only when every workout in it carries its review; one that still has an unreviewed workout stays `unreviewed` —
 * never listed — and the line says it is kept back. A change to a session already on the plan (adjust_plan, Task 8b)
 * is never reviewed: the rule counts the designed workouts only, so a proposal of changes alone is the athlete's too. One statement: the proposal — and its cost declares one more, the
 * loop's own once the proposal is made pending: the older plans' days it covers superseded (design-orchestrate.ts
 * `supersedeOlderPlans`).
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { coachProposals } from "@rg/database";
import type { DesignTool } from "./types.js";
import { isErr, mainRunIdOf, parseAct } from "./act-common.js";
import { reviewRunning } from "../design-review.js";
import { designProposalId, type DocWorkoutOp } from "./propose.js";
import { isDocWorkoutOp, isPlanAdjustOp } from "../proposal-kinds.js";

const LINE_MAX = 300;
const KEPT_BACK = " (Not reviewed yet — kept back until it is.)";

const input = z.object({ summary: z.string().trim().min(1).max(LINE_MAX) }).strict();

export const finish: DesignTool = {
  name: "finish",
  description:
    "The main coach and designers (a reviewer ends with submit_review): end the run with one plain line for the athlete — what was proposed, or why not — never restating what the proposal card shows (minutes, dates, times, counts).",
  inputSchema: {
    type: "object",
    properties: { summary: { type: "string", minLength: 1, maxLength: LINE_MAX } },
    required: ["summary"],
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.1,
  roles: ["main", "designer"],
  control: "finish",
  async run(ctx, raw) {
    const p = parseAct(input, raw, `summary: one plain line (at most ${LINE_MAX} characters)`);
    if (isErr(p)) return p;
    const mainRunId = mainRunIdOf(ctx);
    const proposalId = mainRunId ? designProposalId(mainRunId) : null;
    const [row] = proposalId
      ? await ctx.db
          .select({ status: coachProposals.status, ops: coachProposals.ops })
          .from(coachProposals)
          .where(and(eq(coachProposals.id, proposalId), eq(coachProposals.userId, ctx.userId)))
      : [];
    const all = (Array.isArray(row?.ops) ? row.ops : []) as unknown[];
    // The designed workouts: what review is about. The changes ride beside them, never reviewed.
    const ops = all.filter(isDocWorkoutOp) as DocWorkoutOp[];
    const changes = all.filter(isPlanAdjustOp).length;
    const mine = row && (ctx.run.role === "main" ? all.length > 0 : ops.some((o) => o.by?.runId === ctx.run.id));
    if (!row || !mine || !proposalId) return { data: {}, summary: p.summary, receipt: { final: true } };
    // Kept back while any workout lacks its review, or has one under way: the loop's finish makes the rest pending
    // (coach-runs.ts, the same guard).
    const unreviewed = row.status === "unreviewed" && (ops.some((o) => !o.review) || reviewRunning(ops));
    const line = unreviewed
      ? `${p.summary.length + KEPT_BACK.length > LINE_MAX ? `${p.summary.slice(0, LINE_MAX - KEPT_BACK.length - 1)}…` : p.summary}${KEPT_BACK}`
      : p.summary;
    // What the proposal is once this finish lands: the loop's finish makes a main run's fully reviewed one pending.
    const promoted = ctx.run.role === "main" && row.status === "unreviewed" && all.length > 0 && ops.every((o) => o.review) && !reviewRunning(ops);
    return {
      data: { proposalId, ...(unreviewed ? { unreviewed: true } : {}) },
      summary: line,
      receipt: { final: true, proposal: { id: proposalId, status: promoted ? "pending" : row.status, workouts: ops.length, ...(changes > 0 ? { changes } : {}) } },
    };
  },
};
