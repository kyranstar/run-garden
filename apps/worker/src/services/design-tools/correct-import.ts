/**
 * correct_import(target, targetId, field, after, why, basis, cites?) — the main coach proposes a correction to imported
 * data (import trail phase 3; design 2026-11-05 §8.4, §3.5): a personal move's field, a post's reading of a move, an
 * insight, a link's match (import-corrections.ts names each). The Worker reads `before` itself; the correction is stored
 * as one `import_correction` op in the run's proposal, beside the pins card (the athlete approves once) or alone, and
 * applied on Approve with its `import_corrections` row and the post's trail event. Nothing changes before.
 *
 * EVIDENCE. On `basis: "evidence"` it cites what it rests on — quote ids the run read (read_saves' receipts), `history`,
 * `inferred:<field>` — and its target is one a read_saves page of the run showed (the move, or the post); on `basis:
 * "owner"` (the athlete insisted, the evidence against it or silent) it needs neither, and a later reader knows where it
 * came from. A dose correction rewrites the dose its move's pins line shows (the line says the dose it will run with).
 *
 * REFUSED, each teachable, nothing written: another role's call (`not_for_role`); a field the target doesn't take
 * (`bad_field`, "not the same" on a link to a personal move among them); a target that isn't the athlete's, is a
 * library move, archived or merged, or a position or index the post doesn't hold (`not_a_target`); a value its shape or
 * the library's validation refuses (`bad_after`); the value it already has (`same_value`); a target the run never read
 * (`not_read`), evidence with no cite (`uncited`) or a cite it never read (`unknown_cite`); plyometric taken from a move
 * whose name says it jumps (`still_a_jump`), or — on evidence — from one whose own words do (`owner_only`); more than CORRECTIONS_MAX
 * (`too_many`); a proposal already with the athlete or closed; a restore under way. A second call for the same field
 * replaces the first; a replay answers what it stored.
 *
 * Statements: the athlete with the account's library, the proposal, the restore marker, the target's state and the
 * run's reads (one read); the proposal's guarded upsert.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachProposals, coachRuns } from "@rg/database";
import { makeLibraryIndex } from "@rg/workout";
import { plyometricWord } from "@rg/exercise-library";
import { accountLibraryFrom, personalMovesSql } from "../account-library.js";
import { OPEN_PROPOSAL_STATUSES } from "../design-review.js";
import { clipProse } from "../design-prose.js";
import {
  checkedAfter,
  CORRECTION_FIELDS,
  CORRECTION_TARGETS,
  correctionLine,
  correctionStateOf,
  correctionStateSql,
  currentValue,
  insightParts,
  postRef,
} from "../import-corrections.js";
import {
  CORRECTIONS_MAX,
  correctionId,
  isImportCorrectionOp,
  isMovePinsOp,
  pinsCardLinesOf,
  type CorrectionTarget,
  type ImportCorrectionOp,
  type MovePinsOp,
} from "../proposal-kinds.js";
import { doseWords, type CiteRef } from "../saves-evidence.js";
import { capInWords, isErr, mainRunIdOf, parseAct, prose } from "./act-common.js";
import { CITES_MAX, workoutDosesOf } from "./pin-moves.js";
import { designProposalId, upsertProposal } from "./propose.js";
import { parsedJson, readAthlete, refuse, untrusted } from "./read-common.js";
import { citeRefOf, otherMovesQuote, savesReadsOf, savesReadsSql } from "./saves-reads.js";
import type { DesignTool, ToolOk } from "./types.js";

const WHY_MAX = 300;

const input = z
  .object({
    target: z.enum(CORRECTION_TARGETS),
    targetId: z.string().min(1).max(200),
    field: z.string().min(1).max(20),
    after: z.unknown(),
    why: prose(WHY_MAX),
    basis: z.enum(["evidence", "owner"]),
    cites: z.array(z.string().min(1).max(100)).max(CITES_MAX).optional(),
  })
  .strict();

const NEXT = "It goes to the athlete with the card, or alone: applied on Approve, logged with before, after, why and basis. A second correct_import of the same field replaces it.";

function storedAnswer(proposalId: string, op: ImportCorrectionOp, o: { replaced?: boolean } = {}): ToolOk {
  return {
    data: { stored: true, proposalId, opId: op.id, ...(o.replaced ? { replaced: true } : {}), said: untrusted(op.line), next: NEXT },
    summary: `A correction to suggest: ${op.line}`,
    receipt: { proposalId, opId: op.id },
  };
}

export const correctImport: DesignTool = {
  name: "correct_import",
  description:
    "The main coach: propose a fix to imported data — a saved move's field, a post's reading of a move (useWhen, skipWhen, why), an insight, a link's match — with why and its basis: evidence (cite it) or the athlete's insistence in their message (owner). Applied on Approve.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", enum: [...CORRECTION_TARGETS] },
      targetId: { type: "string", description: "A saved move's id; else <post>:<n> — a link's post and at, or an insight's ref (read_saves)." },
      field: {
        type: "string",
        description:
          "move: name, summary, purpose, dose, laterality, load, equipment, steps, cues, contraction, conditions (ratings by profile), regions, patterns, retire (no move at all); reading: useWhen, skipWhen, why; insight: drop, text, scope, move; link: same_as, not_same.",
      },
      after: { description: "The new value, in the field's own shape (a dose as {type, range, sets?}; conditions as {profile: {attribute: value}}; same_as: a move id; drop and retire: true; not_same: null)." },
      why: { type: "string", description: `${capInWords(WHY_MAX)}.` },
      basis: { type: "string", enum: ["evidence", "owner"] },
      cites: { type: "array", items: { type: "string" }, maxItems: CITES_MAX, description: "Evidence's: the move's quote ids from read_saves, history, stated:<field>, inferred:<field>." },
    },
    required: ["target", "targetId", "field", "why", "basis"],
    additionalProperties: false,
  },
  statementCost: 2,
  // Measured 0.33 ms scaled p50 (a long move's dose on the evidence, eight cites; ×0.78 at load 24.7 — not a quiet run):
  // declared with room. Re-measured 2026-11-06 (the controller's fix pass: the run's word read, the move's own quotes
  // checked, a dose merged): 0.29, 0.31 and 0.38 ms on three loaded passes — 0.4 still holds.
  cpuWeight: 0.4,
  roles: ["main"],
  async run(ctx, raw) {
    const parsed = parseAct(input, raw, "target, targetId, field, after, why, basis and (with evidence) cites");
    if (isErr(parsed)) return parsed;
    const mainRunId = mainRunIdOf(ctx);
    if (ctx.run.role !== "main" || !mainRunId) return refuse("not_for_role", "Only the main coach proposes a correction.", "Say in your finish line what you would correct.");
    const target = parsed.target as CorrectionTarget;
    if (!CORRECTION_FIELDS[target].includes(parsed.field)) {
      return refuse("bad_field", `A ${target} has no field ${JSON.stringify(parsed.field)}.`, `Use one of ${CORRECTION_FIELDS[target].join(", ")}.`);
    }
    const ref = target === "move" ? null : postRef(parsed.targetId);
    if (target !== "move" && !ref) return refuse("not_a_target", `${JSON.stringify(parsed.targetId)} isn't a post's <post>:<n>.`, "Name the post and the move's position (a link's post and at), or an insight's ref, as read_saves gives them.");

    const proposalId = designProposalId(mainRunId);
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      library: personalMovesSql(ctx.userId),
      propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
      state: correctionStateSql(ctx.userId, target, parsed.targetId, ctx.now.toISOString().slice(0, 10)),
      reads: savesReadsSql(ctx.userId, mainRunId),
      // What the athlete asked this run in words (the controller's fix pass, D6): basis owner is their word alone.
      asked: sql`(select nullif(trim(coalesce(${coachRuns.request}, '')), '') from ${coachRuns} where ${coachRuns.id} = ${mainRunId} and ${coachRuns.userId} = ${ctx.userId})`,
    });
    const library = await accountLibraryFrom(ctx.db, ctx.userId, extra.library);
    const find = makeLibraryIndex(library.all);
    const nameOf = (id: string): string => find(id)?.name ?? id;
    const opsText = typeof extra.propOps === "string" ? extra.propOps : null;
    const all = ((opsText ? parsedJson(opsText) : null) as unknown[] | null) ?? [];
    const opId = correctionId(target, parsed.targetId, parsed.field);
    const held = all.find((o) => isImportCorrectionOp(o) && o.id === opId) as ImportCorrectionOp | undefined;
    if (ctx.toolUseId && held) {
      if (held.toolUseId === ctx.toolUseId) return storedAnswer(proposalId, held);
      if (held.replaces?.includes(ctx.toolUseId)) return { data: { stored: true, proposalId, superseded: true, note: "a later correct_import replaced this one" }, summary: "An earlier correction, already replaced" };
    }
    const status = typeof extra.propStatus === "string" ? extra.propStatus : null;
    if (status === "pending") return refuse("proposal_pending", "Your proposal is already with the athlete.", "Call finish.");
    if (status !== null && !(OPEN_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would correct, and the athlete can ask again.");
    }
    if (typeof extra.restoring === "string" && extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the correction can be made once the restore is done.");
    }

    // What it is now, read by the Worker (never the coach's say).
    const state = correctionStateOf(extra.state);
    const current = currentValue(target, parsed.targetId, parsed.field, state);
    if ("why" in current) {
      const code = target === "link" && parsed.field === "not_same" && state?.kind === "post" && current.why.startsWith("isn't linked") ? "bad_field" : "not_a_target";
      return refuse(code, `${JSON.stringify(parsed.targetId)} ${current.why}.`, code === "bad_field" ? "Use same_as to say which move it is." : "Correct a move or post read_saves gave this run.");
    }
    const after = checkedAfter(target, parsed.field, parsed.after, state!);
    if ("why" in after) return refuse("bad_after", `after: ${after.why}.`, "Give the field's own shape, within the library's rules.");
    if (target === "link" && parsed.field === "same_as") {
      const offered = new Set(library.offered.map((e) => e.id));
      if (!offered.has(after.value as string)) return refuse("bad_after", `${JSON.stringify(after.value)} isn't a move the athlete is offered.`, "Name a library move or one of the athlete's active moves (search_library, read_saves).");
    }
    if (JSON.stringify(after.value) === JSON.stringify(current.value)) return refuse("same_value", `${parsed.field} is already that.`, "Correct only what is wrong; leave the rest.");

    // The athlete's insistence is their word in this conversation (the controller's fix pass, D6): a run answering their
    // message — never a "Fit them in" run (the app's request, not theirs), nor one they didn't ask in words.
    if (parsed.basis === "owner" && (ctx.run.savesBatchId || typeof extra.asked !== "string")) {
      return refuse(
        "not_their_word",
        ctx.run.savesBatchId ? "basis owner is the athlete's own word — this run fits their saves in; they haven't said anything about it." : "basis owner is the athlete's own word — this run answers no message of theirs.",
        "Give basis evidence with the cites you read — or, if only the athlete can say, ask them with ask_athlete.",
      );
    }
    // A jump stays a jump (the safety review of S2, I6): a move whose name says it jumps is read as one whatever its
    // contraction (account-library.ts), so taking plyometric away is refused — its name is what to correct; one whose own
    // words say it jumps loses it only on the athlete's word, never on a post's say-so.
    if (target === "move" && parsed.field === "contraction" && state!.kind === "move" && Array.isArray(after.value) && !(after.value as string[]).includes("plyometric")) {
      const rec = state!.record;
      if (plyometricWord(rec.name)) {
        return refuse("still_a_jump", "Its name says it jumps: the condition rules read it as a jump whatever its contraction says.", "If it isn't a jump, correct its name first (on the athlete's word, basis owner); its contraction can follow in a later suggestion.");
      }
      const words = [rec.text?.summary ?? "", ...(Array.isArray(rec.text?.steps) ? rec.text.steps : [])].join(" ");
      if (parsed.basis !== "owner" && plyometricWord("", words)) {
        return refuse("owner_only", "Its own words say it jumps: only the athlete's word takes the jump away.", "Leave it a jump — or, if the athlete says it isn't one, give basis owner.");
      }
    }
    // Evidence: the run read the target, and cites what it read.
    const reads = savesReadsOf(extra.reads);
    const link = state!.kind === "post" ? state!.links.find((l) => l.position === ref!.n && l.status === "saved") : undefined;
    const moveId = target === "move" ? parsed.targetId : target === "insight" ? (parsed.field === "move" && state!.kind === "post" ? state!.links.find((l) => l.position === after.value)?.moveId : undefined) : link?.moveId;
    if (parsed.basis === "evidence") {
      const read = target === "move" ? reads.moves.has(parsed.targetId) : reads.readAt.has(ref!.postId);
      if (!read) return refuse("not_read", `No read_saves page of this run showed ${target === "move" ? "that move" : "that post"}.`, "Read it with read_saves first: a correction rests on the evidence you read — or, if the athlete insists, give basis owner.");
      if (!parsed.cites?.length) return refuse("uncited", "A correction on the evidence cites it.", "Cite read_saves' quote ids, history or inferred:<field> — or give basis owner when it is the athlete's word.");
    }
    const cites: CiteRef[] = [];
    for (const c of [...new Set(parsed.cites ?? [])]) {
      const r = citeRefOf(c, reads, moveId);
      if (!r) return refuse("unknown_cite", `${JSON.stringify(c)} isn't a cite this run read.`, "Cite a quote id read_saves gave (q1.2), history, stated:<field> or inferred:<field>.");
      // A quote vouches for its own move alone (the controller's fix pass, D5).
      const other = otherMovesQuote(c, reads, moveId);
      if (other !== null) {
        return refuse("not_its_move", `${JSON.stringify(c)} is a quote about move ${other} of the batch, not the move this corrects.`, "Cite this move's own quotes, stated:<field> or inferred:<field>, or history.");
      }
      cites.push(r);
    }
    const others = all.filter((o) => isImportCorrectionOp(o) && o.id !== opId).length;
    if (others >= CORRECTIONS_MAX) return refuse("too_many", `This suggestion holds ${CORRECTIONS_MAX} corrections already.`, "Keep the ones that matter most; the athlete can ask again for the rest.");

    // What the card and the trail say.
    const linkName = (l: { moveId: string } | undefined) => (l ? nameOf(l.moveId) : null);
    const readingName = () => {
      const m = state!.kind === "post" && Array.isArray(state!.extraction?.moves) ? (state!.extraction!.moves as Array<{ name?: unknown }>)[ref!.n] : undefined;
      return typeof m?.name === "string" ? m.name : "the post's move";
    };
    const name =
      target === "move"
        ? state!.kind === "move" ? state!.record.name : nameOf(parsed.targetId)
        : target === "insight"
          ? parsed.field === "move" ? (moveId ? nameOf(moveId) : "the post's move") : "the post"
          : (linkName(link) ?? readingName());
    const insight = target === "insight" && state!.kind === "post" ? insightParts((state!.extraction?.insights as unknown[] | undefined)?.[ref!.n])?.text ?? null : null;
    const line = correctionLine({ target, field: parsed.field, before: current.value, after: after.value, name, insight }, nameOf);
    const at = ctx.now.toISOString();
    const toolUseId = ctx.toolUseId ?? `call-${at}`;
    const op: ImportCorrectionOp = {
      kind: "import_correction",
      id: opId,
      target,
      targetId: parsed.targetId,
      field: parsed.field,
      before: current.value,
      after: after.value,
      why: clipProse(parsed.why, WHY_MAX),
      basis: parsed.basis,
      cites,
      name,
      ...(target === "link" && parsed.field === "same_as" ? { toName: nameOf(after.value as string) } : {}),
      line,
      posts: state!.kind === "move" ? state!.posts : [ref!.postId],
      ...(moveId ? { moveId } : {}),
      date: athlete.today,
      toolUseId,
      ...(held ? { replaces: [...(held.replaces ?? []), held.toolUseId] } : {}),
      at,
    };
    // A dose correction: the pins line about its move shows the dose it will run with (§14.1) — unless a workout of this
    // suggestion holds it (its item's dose stands).
    const inWorkout = workoutDosesOf(all);
    const rewrite = (o: unknown): unknown => {
      if (!(target === "move" && parsed.field === "dose" && isMovePinsOp(o)) || inWorkout.has(parsed.targetId)) return o;
      const lines = pinsCardLinesOf((o as MovePinsOp).lines).map((l) => (l.moveId === parsed.targetId && l.decision === "in" ? { ...l, dose: doseWords(after.value as Parameters<typeof doseWords>[0]) } : l));
      return { ...(o as MovePinsOp), lines };
    };
    const ops = (held ? all.map((o) => (o === held ? op : o)) : [...all, op]).map(rewrite);
    if (!(await upsertProposal(ctx, proposalId, ops, opsText, at))) {
      return refuse("proposal_changed", "The proposal changed while the correction was being stored.", "Call correct_import again with the same correction.");
    }
    // A personal move's name in what comes back is a post's reading: the line goes back marked whole (`said`).
    return storedAnswer(proposalId, op, { replaced: !!held });
  },
};
