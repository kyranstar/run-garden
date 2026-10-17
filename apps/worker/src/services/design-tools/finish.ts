/**
 * finish(summary) — the run's end, with one plain line for the athlete (Stage 3 spec §4; principles §2.9, §6.5): what
 * was proposed, or why not, without restating what the proposal card computes. Its control is `finish`: the loop ends
 * the run, writes the line as the run's last event (its result: the run view and the thread read it there) with this
 * call's receipt, and makes `data.proposalId` the run's proposal — the main run's design proposal when it has one, or
 * for a designer, when it added a workout to it.
 *
 * NEVER REFUSED FOR LENGTH (Task 13's fix wave, §2.1; audits 13b I1, 13c R3): the model can't count characters, and 15 of
 * the 16 live runs that called finish had their first refused for a line a little over its cap — on a last turn, a
 * refused finish ended a finished design as a stop. The line is clipped where the athlete reads it (design-prose.ts
 * `clipProse`: its last sentence end inside LINE_MAX, else a word and "…"), and the loop keeps the whole text in the
 * event's payload. The schema states the cap in words.
 *
 * A SET'S DESIGNER'S LINE IS INTERNAL (M3): its `summary` is optional and only the main coach reads it (the loop keeps it
 * as the designer's `final`, which its set's outcome quotes); the trail shows the workout it designed, by its title.
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
import { capInWords, isErr, mainRunIdOf, parseAct } from "./act-common.js";
import { refuse } from "./read-common.js";
import { reviewRunning } from "../design-review.js";
import { athleteText, clipProse } from "../design-prose.js";
import { designProposalId, type DocWorkoutOp } from "./propose.js";
import { isDocWorkoutOp, isPlanAdjustOp } from "../proposal-kinds.js";

/** The athlete's line, at most (characters): clipped to it, never refused. */
export const LINE_MAX = 300;
const KEPT_BACK = " (Not reviewed yet — kept back until it is.)";

const input = z.object({ summary: z.string().trim().min(1).optional() }).strict();

/** A set's designer's line on the trail: the workout it designed, by its title (M3). */
export const designedLine = (title: string | null): string => (title ? `Designed “${title}”.` : "Finished without a workout.");

export const finish: DesignTool = {
  name: "finish",
  description:
    "The main coach and designers (a reviewer ends with submit_review): end the run. The main coach: one plain line for the athlete — what was proposed, or why not — never restating what the proposal card shows (minutes, dates, times, counts). A set's designer: the line is optional and only the main coach reads it.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        minLength: 1,
        description: `The main coach's line for the athlete: ${capInWords(LINE_MAX)} — a longer one is cut at its last sentence that fits. A set's designer: optional, for the main coach only.`,
      },
    },
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.1,
  roles: ["main", "designer"],
  control: "finish",
  async run(ctx, raw) {
    const p = parseAct(input, raw, `summary: ${ctx.run.role === "main" ? "one plain line for the athlete" : "optional"} (${capInWords(LINE_MAX)})`);
    if (isErr(p)) return p;
    const designer = ctx.run.role === "designer";
    if (!designer && !p.summary) {
      return refuse("invalid_input", "summary: Required — the athlete's last line.", `Call it again with summary: one plain line for the athlete (${capInWords(LINE_MAX)}).`);
    }
    const said = p.summary ?? "";
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
    const own = designer ? ops.find((o) => o.by?.runId === ctx.run.id) : undefined;
    const mine = row && (ctx.run.role === "main" ? all.length > 0 : !!own);
    // A designer's line is its workout's title (M3); the main coach's, its own words clipped where the athlete reads them.
    // The athlete's words first (round 2, I1: a library id, a tool name, "validator" as the athlete says them), then the cut.
    const lineOf = (room: number): string => (designer ? designedLine(own?.doc.title ?? null) : clipProse(athleteText(said), room));
    if (!row || !mine || !proposalId) return { data: {}, summary: lineOf(LINE_MAX), receipt: { final: true } };
    // Kept back while any workout lacks its review, or has one under way: the loop's finish makes the rest pending
    // (coach-runs.ts, the same guard).
    const unreviewed = row.status === "unreviewed" && (ops.some((o) => !o.review) || reviewRunning(ops));
    const line = unreviewed && !designer ? `${lineOf(LINE_MAX - KEPT_BACK.length)}${KEPT_BACK}` : lineOf(LINE_MAX);
    // What the proposal is once this finish lands: the loop's finish makes a main run's fully reviewed one pending.
    const promoted = ctx.run.role === "main" && row.status === "unreviewed" && all.length > 0 && ops.every((o) => o.review) && !reviewRunning(ops);
    return {
      data: { proposalId, ...(unreviewed ? { unreviewed: true } : {}) },
      summary: line,
      receipt: { final: true, proposal: { id: proposalId, status: promoted ? "pending" : row.status, workouts: ops.length, ...(changes > 0 ? { changes } : {}) } },
    };
  },
};
