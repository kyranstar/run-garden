/**
 * drop_workout(opId, reason) — the main coach takes one workout out of its set's proposal (Stage 3 spec §6;
 * principles §6.9; design-orchestrate.ts): its judgement of the set acted on. Main only, once a set is planned. The
 * workout's id is its op's (plan_set's result and read_set give it); the reason is plain words for the athlete, kept
 * in the proposal's own lines ("Left out “…” (Saturday 16 May): …") — model-written, stored as data.
 *
 * Two statements: the proposal, and the ops and lines written, guarded by the ops it read.
 */
import { z } from "zod";
import { dayLabel } from "@rg/domain";
import { opIdOf, readSetProposal, writeSetOps } from "../design-orchestrate.js";
import { capInWords, isErr, parseAct, prose } from "./act-common.js";
import { clipProse } from "../design-prose.js";
import { designProposalId } from "./propose.js";
import { refuse, untrusted } from "./read-common.js";
import type { DesignTool } from "./types.js";

const REASON_MAX = 200;
/** The reason is free text the athlete reads (Task 13's fix wave, §2.1; round 2, Minor 8): kept up to four times its cap
 * and clipped where it is stored, refused only past that, in words. */
const input = z.object({ opId: z.string().min(1).max(200), reason: prose(REASON_MAX) }).strict();

export const dropWorkout: DesignTool = {
  name: "drop_workout",
  description:
    "The main coach takes one workout out of the set's proposal: its op id (from plan_set's result or read_set) and a plain reason the athlete will read.",
  inputSchema: {
    type: "object",
    properties: {
      opId: { type: "string", minLength: 1, maxLength: 200, description: "The workout's op id." },
      reason: { type: "string", minLength: 1, description: `Why it goes, in plain words for the athlete: ${capInWords(REASON_MAX)}.` },
    },
    required: ["opId", "reason"],
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.3,
  roles: ["main"],
  async run(ctx, raw) {
    const parsed = parseAct(input, raw, `opId (a workout's op id) and reason (plain words, ${capInWords(REASON_MAX)})`);
    if (isErr(parsed)) return parsed;
    const p = { ...parsed, reason: clipProse(parsed.reason, REASON_MAX) };
    const rounds = ctx.set?.rounds() ?? [];
    if (rounds.length === 0) {
      return refuse("no_set", "drop_workout takes a workout out of a planned set, and no set is planned in this run.", "Call plan_set first — or, for one workout, simply don't propose it.");
    }
    const proposalId = designProposalId(ctx.run.id);
    const { ops, changes, opsText, status, flags } = await readSetProposal(ctx.db, ctx.userId, proposalId);
    const op = ops.find((o) => opIdOf(o) === p.opId);
    if (!op) {
      const ids = ops.map(opIdOf);
      return refuse(
        "not_found",
        `No workout of this set's proposal has op id ${JSON.stringify(p.opId)}.`,
        ids.length > 0 ? `Use one of: ${ids.join(", ")} (read_set lists them).` : "The proposal holds no workout to take out: call finish.",
      );
    }
    if (status !== "unreviewed" && status !== "rehearsal") {
      return refuse("proposal_closed", `This set's proposal is already ${status ?? "gone"}.`, "Call finish.");
    }
    const key = rounds.flatMap((r) => r.designers).find((d) => d.runId === p.opId)?.key ?? null;
    const when = dayLabel(op.date);
    const line = `Left out “${op.doc.title}” (${when}): ${p.reason}`;
    const next = ops.filter((o) => o !== op);
    const written = await writeSetOps(ctx.db, ctx.userId, proposalId, next, changes, opsText, [...flags, line]);
    if (!written) return refuse("proposal_changed", "The proposal changed while the workout was being taken out.", "Call drop_workout again.");
    // Kept with its key: a redo of the key that is designed takes the line back.
    if (key) ctx.set?.keyLine(key, line);
    return {
      data: { dropped: true, opId: p.opId, key, date: op.date, title: untrusted(op.doc.title), workoutsLeft: next.length },
      summary: `Took out “${op.doc.title}” (${when}): ${p.reason}`,
      receipt: { proposalId, opId: p.opId, date: op.date },
    };
  },
};
