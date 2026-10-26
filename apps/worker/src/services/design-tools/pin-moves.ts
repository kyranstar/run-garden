/**
 * pin_moves(pin?, unpin?, batchId?, title, summary, lines, why) — the main coach puts moves in the pool the engine plans
 * from, or takes them out (saved-posts import, Task 18): what the Studio's pin does (`exercise_prefs.pinned`) — a pinned
 * core lift stays in its block; a pinned personal move joins the engine's pool (`account-library.ts` `engine`) and gets
 * the saved-link bonus in the slots its role fills; a pin schedules nothing — as one card the athlete approves. When the
 * athlete asks to fit in the moves from their saves, the coach places them inside what they already do: it revises the
 * one workout its run holds, pins a move with this, and names `batchId` (read_saves') so the batch is marked fitted in
 * once approved — however many it pinned: with a batch and no move at all, the card is its lines alone (each saved move
 * left out, and why), and approving it closes the batch. With a batch, every new move of it the athlete is offered must
 * be accounted for — pinned, unpinned, or named by its id in a line — else `incomplete`, naming the missing ids; a line's
 * ids are stored as the moves' names, so the card reads names (coach-context audit I5).
 *
 * STORED as one op of kind `move_pins` (proposal-kinds.ts `MovePinsOp`) in the main run's proposal, as change_programme
 * stores its own: the moves, the batch, the coach's own words for the card — its title, its line, a line a placement and
 * a line a saved move left out, and why — and today. One per proposal: a second call replaces the first (`replaces`);
 * a replay of a call answers what it stored. Never reviewed: approved with one tap.
 *
 * REFUSED, each teachable, nothing written: a role other than the main coach's (`not_for_role`); no move to pin or unpin
 * and no batch, a move named in both, more than PINS_MAX in either, a line too many (`invalid_input`); an id that isn't a
 * move the athlete is offered — the public library and their active moves: a move still waiting in a batch not yet saved,
 * an archived or merged one, an unknown one, another account's (`not_a_move`); a move to pin the athlete set aside as not
 * for them (`exercise_prefs.excluded`: the engine leaves it out whatever its pin — only the athlete puts it back:
 * `set_aside`); a batch that isn't a saved batch of the athlete's — another account's, one not saved, one nobody has, all
 * in the same words (`bad_batch`); a card with a batch that leaves one of its offered new moves unaccounted for — not
 * pinned, not unpinned, its id in no line (`incomplete`, naming the ids); a proposal already with the athlete
 * (`proposal_pending`) or closed; a restore under way (`restoring`).
 *
 * Statements: the athlete with the account's library, the moves set aside, the proposal, the restore marker, the batch
 * and its new moves (one read); the proposal's guarded upsert.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachProposals, exercisePrefs, personalMoves, saveBatches } from "@rg/database";
import type { ExerciseRecord } from "@rg/exercise-library";
import { isPersonalId } from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";
import { accountLibraryFrom, personalMovesSql } from "../account-library.js";
import { markUntrusted } from "../design-prompt.js";
import { OPEN_PROPOSAL_STATUSES } from "../design-review.js";
import { clipProse } from "../design-prose.js";
import { isMovePinsOp, PINS_LINES_MAX, PINS_MAX, pinsId, type MovePinsOp } from "../proposal-kinds.js";
import { capInWords, isErr, mainRunIdOf, parseAct, prose } from "./act-common.js";
import { designProposalId, upsertProposal } from "./propose.js";
import { parsedJson, plural, readAthlete, refuse } from "./read-common.js";
import type { DesignTool, ToolOk } from "./types.js";

const TITLE_MAX = 60;
const SUMMARY_MAX = 120;
const LINE_MAX = 160;
const WHY_MAX = 300;

const moveIds = z.array(z.string().min(1).max(80)).max(PINS_MAX);

const input = z
  .object({
    pin: moveIds.optional(),
    unpin: moveIds.optional(),
    batchId: z.string().min(1).max(200).optional(),
    title: prose(TITLE_MAX),
    summary: prose(SUMMARY_MAX),
    lines: z.array(prose(LINE_MAX)).min(1).max(PINS_LINES_MAX),
    why: prose(WHY_MAX),
  })
  .strict();

/** A personal id as a line may carry one (PERSONAL_ID_RE's shape, inside prose). */
const PERSONAL_ID_IN_TEXT = /\bmy[A-Z][A-Za-z0-9]{1,60}\b/g;

/** A line as the card shows it: each of the account's personal ids it names as that move's name (the athlete knows moves
 * by name; the coach named them by id to account for them). An id the library doesn't hold stays as written. */
function namesFor(line: string, all: readonly ExerciseRecord[]): string {
  const find = makeLibraryIndex(all);
  return line.replace(PERSONAL_ID_IN_TEXT, (id) => find(id)?.name ?? id);
}

/** What a stored change answers: the moves, never the coach's own words back. */
function storedAnswer(proposalId: string, op: MovePinsOp, o: { replaced?: boolean } = {}): ToolOk {
  return {
    data: {
      stored: true,
      proposalId,
      opId: op.id,
      ...(o.replaced ? { replaced: true } : {}),
      pin: op.pin,
      unpin: op.unpin,
      ...(op.batchId ? { batchId: op.batchId } : {}),
      next: "It goes to the athlete as one card — Approve or Not now — never reviewed. A second pin_moves replaces it. Call finish when the rest is done.",
    },
    summary: `Moves for the engine's pool: ${op.pin.length} to pin, ${op.unpin.length} to unpin`,
    receipt: { proposalId, opId: op.id },
  };
}

export const pinMoves: DesignTool = {
  name: "pin_moves",
  description:
    "The main coach: put moves in the pool the engine plans from (pin: a core lift stays; other moves become eligible) or take them out (unpin), as one card. batchId: the read_saves batch you fit in — each new move of it pinned or named by its id in a line; with no move, the lines alone close it. A second call replaces it.",
  inputSchema: {
    type: "object",
    properties: {
      pin: { type: "array", items: { type: "string" }, maxItems: PINS_MAX, description: "Move ids (read_saves, search_library)." },
      unpin: { type: "array", items: { type: "string" }, maxItems: PINS_MAX },
      batchId: { type: "string" },
      title: { type: "string", description: `The card's title: ${capInWords(TITLE_MAX)}.` },
      summary: { type: "string", description: `One line under it: ${capInWords(SUMMARY_MAX)}.` },
      lines: { type: "array", items: { type: "string" }, maxItems: PINS_LINES_MAX, description: "One per placement and one per saved move left out, each with why; a batch's new move by its id." },
      why: { type: "string", description: `Why, in one plain line: ${capInWords(WHY_MAX)}.` },
    },
    required: ["title", "summary", "lines", "why"],
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.5,
  roles: ["main"],
  async run(ctx, raw) {
    const parsed = parseAct(input, raw, "pin and/or unpin (move ids), batchId when fitting in a saves batch, and the card's title, summary, lines and why");
    if (isErr(parsed)) return parsed;
    const mainRunId = mainRunIdOf(ctx);
    if (ctx.run.role !== "main" || !mainRunId) return refuse("not_for_role", "Only the main coach changes the moves in the engine's pool.", "Say in your finish line what you would pin.");
    const pin = [...new Set(parsed.pin ?? [])];
    const unpin = [...new Set(parsed.unpin ?? [])];
    // A lines-only card closes its batch (every saved move left out, each line saying why); with no batch, nothing to do.
    if (pin.length + unpin.length === 0 && !parsed.batchId) {
      return refuse("invalid_input", "No move to pin or unpin.", "Name the moves: pin to put them in the engine's pool, unpin to take them out — or, fitting in a batch with none, its batchId.");
    }
    const both = pin.filter((id) => unpin.includes(id));
    if (both.length > 0) {
      return refuse("invalid_input", `${both.map((id) => JSON.stringify(id)).join(", ")} is in both pin and unpin.`, "Name each move once: pin to put it in the engine's pool, unpin to take it out.");
    }

    const proposalId = designProposalId(mainRunId);
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      library: personalMovesSql(ctx.userId),
      propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
      batch: parsed.batchId
        ? sql`(select ${saveBatches.status} from ${saveBatches} where ${saveBatches.id} = ${parsed.batchId} and ${saveBatches.userId} = ${ctx.userId})`
        : sql`null`,
      // The new moves the batch brought, still active: each must be accounted for (coach-context audit I5).
      batchNew: parsed.batchId
        ? sql`(select json_group_array(${personalMoves.id}) from ${personalMoves} where ${personalMoves.userId} = ${ctx.userId}
            and ${personalMoves.batchId} = ${parsed.batchId} and ${personalMoves.status} = 'active')`
        : sql`null`,
      setAside:
        pin.length > 0
          ? sql`(select json_group_array(${exercisePrefs.exerciseId}) from ${exercisePrefs} where ${exercisePrefs.userId} = ${ctx.userId}
              and ${exercisePrefs.excluded} = 1 and ${exercisePrefs.exerciseId} in (${sql.join(pin.map((id) => sql`${id}`), sql`, `)}))`
          : sql`null`,
    });
    const library = await accountLibraryFrom(ctx.db, ctx.userId, extra.library);
    const opsText = typeof extra.propOps === "string" ? extra.propOps : null;
    const all = ((opsText ? parsedJson(opsText) : null) as unknown[] | null) ?? [];
    const opId = pinsId(mainRunId);
    const held = all.find((o) => isMovePinsOp(o) && o.id === opId) as MovePinsOp | undefined;
    // A replay of this very call: what it stored, or that a later one replaced it.
    if (ctx.toolUseId && held) {
      if (held.toolUseId === ctx.toolUseId) return storedAnswer(proposalId, held);
      if (held.replaces?.includes(ctx.toolUseId)) return { data: { stored: true, proposalId, superseded: true, note: "a later pin_moves replaced this one" }, summary: "An earlier change to the engine's pool, already replaced" };
    }
    const status = typeof extra.propStatus === "string" ? extra.propStatus : null;
    if (status === "pending") return refuse("proposal_pending", "Your proposal is already with the athlete.", "Call finish.");
    if (status !== null && !(OPEN_PROPOSAL_STATUSES as readonly string[]).includes(status)) {
      return refuse("proposal_closed", `This design's proposal is already ${status}.`, "Finish: say what you would pin, and the athlete can ask again.");
    }
    if (typeof extra.restoring === "string" && extra.restoring.length > 0) {
      return refuse("restoring", "The athlete's account is being restored right now.", "Finish, and say the moves can be fitted in once the restore is done.");
    }
    if (parsed.batchId && extra.batch !== "saved") {
      return refuse("bad_batch", `No saved batch of the athlete's has id ${JSON.stringify(parsed.batchId)}.`, "Use the batch id read_saves gives, or leave batchId out.");
    }
    // A move the athlete is offered: the public library and their active moves — never one waiting in a batch not yet
    // saved, an archived or merged one, or one nobody has.
    const offered = new Set(library.offered.map((e) => e.id));
    const unknown = [...pin, ...unpin].filter((id) => !offered.has(id));
    if (unknown.length > 0) {
      return refuse(
        "not_a_move",
        `${unknown.map((id) => JSON.stringify(id)).join(", ")} isn't a move in the athlete's library: one still waiting in a batch not yet saved, archived, merged or unknown.`,
        "Use the ids read_saves or search_library gives — a move waiting for the athlete's review can't be pinned until they save its batch.",
      );
    }
    // A move the athlete set aside as not for them: never put back behind their back (the engine leaves it out anyway).
    const asideIds = new Set(((parsedJson(extra.setAside) as unknown[] | null) ?? []).filter((x): x is string => typeof x === "string"));
    const aside = pin.filter((id) => asideIds.has(id));
    if (aside.length > 0) {
      const find = makeLibraryIndex(library.all);
      // A personal move's name is a post's reading: marked.
      const name = (id: string) => (isPersonalId(id) ? markUntrusted("saved post", find(id)?.name ?? id) : (find(id)?.name ?? id));
      return refuse("set_aside", `${aside.map(name).join(", ")} ${aside.length === 1 ? "is" : "are"} set aside as not for you — ask before putting it back.`, "Leave it out of pin — or ask the athlete with ask_athlete; only they put it back, in the Studio.");
    }
    // Every new move of the batch the athlete is offered, accounted for: pinned, unpinned, or named by its id in a line —
    // so a move left out is left out with a reason the card shows (coach-context audit I5).
    const fresh = ((parsedJson(extra.batchNew) as unknown[] | null) ?? []).filter((x): x is string => typeof x === "string" && offered.has(x));
    const unaccounted = fresh.filter((id) => !pin.includes(id) && !unpin.includes(id) && !parsed.lines.some((l) => l.includes(id)));
    if (unaccounted.length > 0) {
      return refuse(
        "incomplete",
        `${plural(unaccounted.length, "new move")} of this batch ${unaccounted.length === 1 ? "is" : "are"} not accounted for: ${unaccounted.map((id) => JSON.stringify(id)).join(", ")}.`,
        "Pin each new move, or name it by its id in a line saying why it was left out (the card shows its name).",
      );
    }

    const at = ctx.now.toISOString();
    const toolUseId = ctx.toolUseId ?? `call-${at}`;
    const op: MovePinsOp = {
      kind: "move_pins",
      id: opId,
      pin,
      unpin,
      ...(parsed.batchId ? { batchId: parsed.batchId } : {}),
      why: clipProse(parsed.why, WHY_MAX),
      title: clipProse(parsed.title, TITLE_MAX),
      summary: clipProse(parsed.summary, SUMMARY_MAX),
      lines: parsed.lines.map((l) => clipProse(namesFor(l, library.all), LINE_MAX)),
      date: athlete.today,
      toolUseId,
      ...(held ? { replaces: [...(held.replaces ?? []), held.toolUseId] } : {}),
      at,
    };
    const ops = held ? all.map((o) => (o === held ? op : o)) : [...all, op];
    if (!(await upsertProposal(ctx, proposalId, ops, opsText, at))) {
      return refuse("proposal_changed", "The proposal changed while the moves were being stored.", "Call pin_moves again with the same moves.");
    }
    return storedAnswer(proposalId, op, { replaced: !!held });
  },
};
