/**
 * finish(summary) — the run's end, with one plain line for the athlete (Stage 3 spec §4; principles §2.9, §6.5): what
 * was proposed, or why not, without restating what the proposal card computes. Its control is `finish`: the loop ends
 * the run, writes the line as the run's last event (its result: the run view and the thread read it there) with this
 * call's receipt, and makes `data.proposalId` the run's proposal — the main run's design proposal when it has one, or
 * for a designer, when it added a workout to it.
 *
 * Review comes before the athlete sees anything (spec §5): a proposal that still has an unreviewed workout stays
 * `unreviewed` — never listed — and the line says it is kept back. One statement: the proposal.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { coachProposals } from "@rg/database";
import type { DesignTool } from "./types.js";
import { isErr, mainRunIdOf, parseAct } from "./act-common.js";
import { designProposalId, type DocWorkoutOp } from "./propose.js";

const LINE_MAX = 300;
const KEPT_BACK = " (Not reviewed yet — kept back until it is.)";

const input = z.object({ summary: z.string().trim().min(1).max(LINE_MAX) }).strict();

export const finish: DesignTool = {
  name: "finish",
  description:
    "End the run with one plain line for the athlete: what was proposed, or why not — never restating what the proposal card shows (minutes, dates, counts).",
  inputSchema: {
    type: "object",
    properties: { summary: { type: "string", minLength: 1, maxLength: LINE_MAX } },
    required: ["summary"],
    additionalProperties: false,
  },
  statementCost: 1,
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
    const ops = (Array.isArray(row?.ops) ? row.ops : []) as DocWorkoutOp[];
    const mine = row && (ctx.run.role === "main" ? ops.length > 0 : ops.some((o) => o.by?.runId === ctx.run.id));
    if (!row || !mine || !proposalId) return { data: {}, summary: p.summary, receipt: { final: true } };
    const unreviewed = row.status === "unreviewed";
    const line = unreviewed
      ? `${p.summary.length + KEPT_BACK.length > LINE_MAX ? `${p.summary.slice(0, LINE_MAX - KEPT_BACK.length - 1)}…` : p.summary}${KEPT_BACK}`
      : p.summary;
    return {
      data: { proposalId, ...(unreviewed ? { unreviewed: true } : {}) },
      summary: line,
      receipt: { final: true, proposal: { id: proposalId, status: row.status, workouts: ops.length } },
    };
  },
};
