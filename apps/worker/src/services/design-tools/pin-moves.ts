/**
 * pin_moves(pin?, unpin?, batchId?, title, summary?, lines, why) — the main coach puts moves in the pool the engine plans
 * from, or takes them out (saved-posts import, Task 18): what the Studio's pin does (`exercise_prefs.pinned`) — a pinned
 * core lift stays in its block; a pinned personal move joins the engine's pool (`account-library.ts` `engine`) and gets
 * the saved-link bonus in the slots its role fills; a pin schedules nothing — as one card the athlete approves. When the
 * athlete asks to fit in the moves from their saves, the coach places them inside what they already do: it revises the
 * one workout its run holds, pins a move with this, and names `batchId` (read_saves') — a fit-in run's own batch when it
 * names none (`ctx.run.savesBatchId`, the saves flow §12.1) — so the batch is marked fitted in once approved, however
 * many it pinned: with a batch and no move at all, the card is its lines alone (each saved move left out, and why), and
 * approving it closes the batch.
 *
 * THE ATHLETE'S CHOICES (the saves flow redesigned, §3.4). With a batch, each of its new moves the athlete is offered
 * carries the athlete's choice (`personal_moves.fit_choice`): an included move is pinned, always — a card leaving one out
 * is refused, unless the athlete has set it aside since (theirs to put back: the set-aside refusal would refuse its
 * pin); a skipped one is never pinned nor given a line, and needs none; one on the coach's call is pinned, unpinned or
 * given a line by its moveId saying why it waits — else `incomplete`, naming the missing ids.
 *
 * A LINE A MOVE (§3.5): the coach writes `{ moveId, text }` — or `{ text }`, a general line — and never the name: the
 * card sets the move's name in bold, once, from the account's library. A text that repeats it anyway ("Name (id): …")
 * loses that leading copy and its separator; a personal id elsewhere in it reads as its move's name; and it is clipped
 * after the name is placed — name, ": " and text within PIN_LINE_MAX — at a sentence end wherever one fits. With a batch
 * the card's line counts its new moves (`pinsSummaryLine`: "Eight join the rotation. Name waits." — pinned, and left on
 * the coach's call); without one, the coach writes it (`summary`).
 *
 * STORED as one op of kind `move_pins` (proposal-kinds.ts `MovePinsOp`) in the main run's proposal, as change_programme
 * stores its own: the moves, the batch, the card's words — its title, its line, a line a placement and a line a saved
 * move left out, and why — and today. One per proposal: a second call replaces the first (`replaces`); a replay of a
 * call answers what it stored. Never reviewed: approved with one tap.
 *
 * REFUSED, each teachable, nothing written: a role other than the main coach's (`not_for_role`); no move to pin or unpin
 * and no batch, a move named in both, more than PINS_MAX in either, a line too many, no summary without a batch
 * (`invalid_input`); an id — to pin, to unpin, or a line's — that isn't a move the athlete is offered — the public
 * library and their active moves: a move still waiting in a batch not yet saved, an archived or merged one, an unknown
 * one, another account's (`not_a_move`); a move to pin the athlete set aside as not for them (`exercise_prefs.excluded`:
 * the engine leaves it out whatever its pin — only the athlete puts it back: `set_aside`); a batch that isn't a saved
 * batch of the athlete's — another account's, one not saved, one nobody has, all in the same words (`bad_batch`); a
 * move the athlete skipped, pinned or lined (`skipped`); an included move left out of pin (`include_left_out`); a new
 * move on the coach's call unaccounted for (`incomplete`); a proposal already with the athlete (`proposal_pending`) or
 * closed; a restore under way (`restoring`). A personal move's name in a refusal is a post's reading: marked.
 *
 * Statements: the athlete with the account's library, the moves set aside (and the batch's included moves set aside),
 * the proposal, the restore marker, the batch and its new moves with the athlete's choices (one read); the proposal's
 * guarded upsert.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { accountState, coachProposals, exercisePrefs, personalMoves, saveBatches } from "@rg/database";
import { isPersonalId, numberWord } from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";
import { accountLibraryFrom, personalMovesSql } from "../account-library.js";
import { markUntrusted } from "../design-prompt.js";
import { OPEN_PROPOSAL_STATUSES } from "../design-review.js";
import { clipProse } from "../design-prose.js";
import { isMovePinsOp, PINS_LINES_MAX, PINS_MAX, pinsId, type MovePinsOp, type PinsCardLine } from "../proposal-kinds.js";
import { capInWords, isErr, mainRunIdOf, parseAct, prose } from "./act-common.js";
import { designProposalId, upsertProposal } from "./propose.js";
import { parsedJson, plural, readAthlete, refuse } from "./read-common.js";
import type { DesignTool, ToolOk } from "./types.js";

const TITLE_MAX = 60;
const SUMMARY_MAX = 120;
/** A card line's most characters, its move's name and ": " counted (the saves flow redesigned, §3.5: 160 cut an ordinary
 * two-sentence line mid-sentence). */
export const PIN_LINE_MAX = 280;
const WHY_MAX = 300;

const moveId = z.string().min(1).max(80);
const moveIds = z.array(moveId).max(PINS_MAX);

const input = z
  .object({
    pin: moveIds.optional(),
    unpin: moveIds.optional(),
    batchId: z.string().min(1).max(200).optional(),
    title: prose(TITLE_MAX),
    summary: prose(SUMMARY_MAX).optional(),
    lines: z.array(z.object({ moveId: moveId.optional(), text: prose(PIN_LINE_MAX) }).strict()).min(1).max(PINS_LINES_MAX),
    why: prose(WHY_MAX),
  })
  .strict();

/** A personal id as a line may carry one (PERSONAL_ID_RE's shape, inside prose). */
const PERSONAL_ID_IN_TEXT = /\bmy[A-Z][A-Za-z0-9]{1,60}\b/g;

/** A line's text as the card shows it: each of the account's personal ids it names as that move's name (the athlete
 * knows moves by name). An id the library doesn't hold stays as written. */
function namesFor(text: string, find: (id: string) => { name: string } | undefined): string {
  return text.replace(PERSONAL_ID_IN_TEXT, (id) => find(id)?.name ?? id);
}

/** After a leading copy of the move: spaces, then perhaps a separator — ":", "–", "—", ",", ".", ";", or "-" before a
 * space (never a hyphen joining a word: "Plank-style") — then spaces. */
const AFTER_COPY = /^\s*(?:([:–—,.;]|-(?=\s)))?\s*/;
/** A letter or a digit: after a leading copy, one makes it a longer word ("Zorbex neck nods"), never a copy. */
const WORD_CHAR = /^[\p{L}\p{N}]/u;

/**
 * A move's line as stored (§3.5; review round 1): a leading copy of its name, of "(id)" or of the id, in any case —
 * "Name: …", "Name (id): …", "Name – (id) – …", "id — …" — gone with the separator after it, and its first letter a
 * capital. The name is a copy only when a separator follows it, or the "(id)" or id that does: a name opening an
 * ordinary sentence stays whole ("Plank's hold time goes up.", "Plank variations help your core."), as does a name
 * written twice with no separator (rare — the schema says never to write it). A "(id)", or a personal id (never a word:
 * PERSONAL_ID_RE), needs no separator after it, so no "(id)" is left to read back as a second name; any other bare id
 * needs one, as the name does — a library id may be an ordinary word ("Bridge the gap…", id `bridge`; review round 2).
 * Nothing but punctuation left: the text as written.
 */
function lineTextOf(text: string, id: string, name: string): string {
  const t = text.trim();
  // Longest first: an id never stops short at a name that begins it.
  const copies = [...new Set([name, `(${id})`, id])].filter((c) => c.length > 0).sort((a, b) => b.length - a.length);
  // The copies that are never a word: closed by nothing at all.
  const free = new Set([`(${id})`, ...(isPersonalId(id) ? [id] : [])]);
  const copyAt = (i: number): string | undefined =>
    copies.find((c) => t.slice(i, i + c.length).toLowerCase() === c.toLowerCase() && !WORD_CHAR.test(t.slice(i + c.length)));
  // Copy after copy, each with what follows it; the text starts after the last copy a separator (or, one never a word,
  // nothing) closes.
  let at = 0;
  let cut = -1;
  for (let copy = copyAt(at); copy !== undefined; copy = copyAt(at)) {
    at += copy.length;
    const after = AFTER_COPY.exec(t.slice(at))!;
    at += after[0].length;
    if (after[1] !== undefined || free.has(copy)) cut = at;
  }
  const rest = cut >= 0 ? t.slice(cut) : t;
  if (!/[\p{L}\p{N}]/u.test(rest)) return t;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const capital = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * A batch's card line (the saves flow redesigned, §3.5): how many join the rotation, then the one left on the coach's
 * call by name or how many — "Eight join the rotation. Zorbex neck nod waits.", "One joins the rotation. Two wait.",
 * "None join the rotation.".
 */
export function pinsSummaryLine(joined: number, waiting: readonly string[]): string {
  const head = joined === 0 ? "None join the rotation." : joined === 1 ? "One joins the rotation." : `${capital(numberWord(joined))} join the rotation.`;
  if (waiting.length === 0) return head;
  return `${head} ${waiting.length === 1 ? `${waiting[0]} waits.` : `${capital(numberWord(waiting.length))} wait.`}`;
}

/** A batch's new moves as the read gives them: `[id, fit_choice]` pairs (the choice null: the coach's call). */
function batchMovesOf(raw: unknown): Array<[string, string | null]> {
  const list = parsedJson(raw);
  return (Array.isArray(list) ? list : []).flatMap((x): Array<[string, string | null]> => {
    const [id, choice] = Array.isArray(x) ? (x as unknown[]) : [];
    return typeof id === "string" ? [[id, typeof choice === "string" ? choice : null]] : [];
  });
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
    "The main coach: put moves in the pool the engine plans from (pin: a core lift stays; other moves become eligible) or take them out (unpin), as one card. batchId: the read_saves batch you fit in (a fit-in run's by default) — each new move pinned or a line's moveId; include always pinned, skip never pinned nor lined; with no move, the lines alone close it. A second call replaces it.",
  inputSchema: {
    type: "object",
    properties: {
      pin: { type: "array", items: { type: "string" }, maxItems: PINS_MAX, description: "Move ids (read_saves, search_library)." },
      unpin: { type: "array", items: { type: "string" }, maxItems: PINS_MAX },
      batchId: { type: "string" },
      title: { type: "string", description: `The card's title: ${capInWords(TITLE_MAX)}.` },
      summary: { type: "string", description: `One line under it, without a batch (with one, the card counts): ${capInWords(SUMMARY_MAX)}.` },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            moveId: { type: "string", description: "The move it is about: the card names it, so never write the name." },
            text: { type: "string", description: `${capInWords(PIN_LINE_MAX)}.` },
          },
          required: ["text"],
          additionalProperties: false,
        },
        maxItems: PINS_LINES_MAX,
        description: "One per placement and one per saved move left out, each with why.",
      },
      why: { type: "string", description: `Why, in one plain line: ${capInWords(WHY_MAX)}.` },
    },
    required: ["title", "lines", "why"],
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.5,
  roles: ["main"],
  async run(ctx, raw) {
    const parsed = parseAct(input, raw, "pin and/or unpin (move ids), batchId when fitting in a saves batch, and the card's title, lines and why (its summary without a batch)");
    if (isErr(parsed)) return parsed;
    const mainRunId = mainRunIdOf(ctx);
    if (ctx.run.role !== "main" || !mainRunId) return refuse("not_for_role", "Only the main coach changes the moves in the engine's pool.", "Say in your finish line what you would pin.");
    const pin = [...new Set(parsed.pin ?? [])];
    const unpin = [...new Set(parsed.unpin ?? [])];
    // The batch it fits in: the one it names, else a fit-in run's own (the saves flow, §12.1).
    const batchId = parsed.batchId ?? ctx.run.savesBatchId;
    // A lines-only card closes its batch (every saved move left out, each line saying why); with no batch, nothing to do.
    if (pin.length + unpin.length === 0 && !batchId) {
      return refuse("invalid_input", "No move to pin or unpin.", "Name the moves: pin to put them in the engine's pool, unpin to take them out — or, fitting in a batch with none, its batchId.");
    }
    const both = pin.filter((id) => unpin.includes(id));
    if (both.length > 0) {
      return refuse("invalid_input", `${both.map((id) => JSON.stringify(id)).join(", ")} is in both pin and unpin.`, "Name each move once: pin to put it in the engine's pool, unpin to take it out.");
    }
    // With a batch the card counts what it does (§3.5); without one, its line is the coach's.
    if (!batchId && !parsed.summary) {
      return refuse("invalid_input", "summary is missing: with no batch, the card's line is yours.", "Give summary — one line under the title — or the batchId you fit in.");
    }
    const lineIds = [...new Set(parsed.lines.flatMap((l) => (l.moveId ? [l.moveId] : [])))];

    const proposalId = designProposalId(mainRunId);
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      library: personalMovesSql(ctx.userId),
      propOps: sql`(select ${coachProposals.ops} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      propStatus: sql`(select ${coachProposals.status} from ${coachProposals} where ${coachProposals.id} = ${proposalId} and ${coachProposals.userId} = ${ctx.userId})`,
      restoring: sql`(select ${accountState.restoreId} from ${accountState} where ${accountState.userId} = ${ctx.userId})`,
      batch: batchId
        ? sql`(select ${saveBatches.status} from ${saveBatches} where ${saveBatches.id} = ${batchId} and ${saveBatches.userId} = ${ctx.userId})`
        : sql`null`,
      // The new moves the batch brought, still active, each with the athlete's choice — `[id, fit_choice]`: each must be
      // accounted for as the athlete chose (coach-context audit I5; the saves flow redesigned, §3.4).
      batchNew: batchId
        ? sql`(select json_group_array(json_array(${personalMoves.id}, ${personalMoves.fitChoice})) from ${personalMoves}
            where ${personalMoves.userId} = ${ctx.userId} and ${personalMoves.batchId} = ${batchId} and ${personalMoves.status} = 'active')`
        : sql`null`,
      // The moves to pin the athlete set aside — and, with a batch, its included moves set aside since: never asked of
      // the coach (only the athlete puts one back).
      setAside:
        pin.length > 0 || batchId
          ? sql`(select json_group_array(${exercisePrefs.exerciseId}) from ${exercisePrefs} where ${exercisePrefs.userId} = ${ctx.userId}
              and ${exercisePrefs.excluded} = 1 and (${pin.length > 0 ? sql`${exercisePrefs.exerciseId} in (${sql.join(pin.map((id) => sql`${id}`), sql`, `)})` : sql`0`}
              ${batchId ? sql`or ${exercisePrefs.exerciseId} in (select ${personalMoves.id} from ${personalMoves} where ${personalMoves.userId} = ${ctx.userId}
                and ${personalMoves.batchId} = ${batchId} and ${personalMoves.fitChoice} = 'include')` : sql``}))`
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
    if (batchId && extra.batch !== "saved") {
      // The run's own batch (none named) is no longer saved: leaving batchId out can't help — this card can't close it.
      return parsed.batchId
        ? refuse("bad_batch", `No saved batch of the athlete's has id ${JSON.stringify(batchId)}.`, "Use the batch id read_saves gives, or leave batchId out.")
        : refuse("bad_batch", "This run's saves batch is no longer saved, so no card can close it now.", "Finish without pin_moves: say in your finish line what you would pin, and the athlete can fit the moves in again.");
    }
    // A move the athlete is offered: the public library and their active moves — never one waiting in a batch not yet
    // saved, an archived or merged one, or one nobody has. A line's move too: the card names it.
    const offered = new Set(library.offered.map((e) => e.id));
    const unknown = [...new Set([...pin, ...unpin, ...lineIds])].filter((id) => !offered.has(id));
    if (unknown.length > 0) {
      return refuse(
        "not_a_move",
        `${unknown.map((id) => JSON.stringify(id)).join(", ")} isn't a move in the athlete's library: one still waiting in a batch not yet saved, archived, merged or unknown.`,
        "Use the ids read_saves or search_library gives — a move waiting for the athlete's review can't be pinned until they save its batch.",
      );
    }
    const find = makeLibraryIndex(library.all);
    const nameOf = (id: string): string => find(id)?.name ?? id;
    // A personal move's name is a post's reading: marked.
    const named = (ids: readonly string[]): string => ids.map((id) => (isPersonalId(id) ? markUntrusted("saved post", nameOf(id)) : nameOf(id))).join(", ");
    // A move the athlete set aside as not for them: never put back behind their back (the engine leaves it out anyway).
    const asideIds = new Set(((parsedJson(extra.setAside) as unknown[] | null) ?? []).filter((x): x is string => typeof x === "string"));
    const aside = pin.filter((id) => asideIds.has(id));
    if (aside.length > 0) {
      return refuse("set_aside", `${named(aside)} ${aside.length === 1 ? "is" : "are"} set aside as not for you — ask before putting it back.`, "Leave it out of pin — or ask the athlete with ask_athlete; only they put it back, in the Studio.");
    }
    // The batch's new moves the athlete is offered, each with their choice (§3.4).
    const fresh = batchMovesOf(extra.batchNew).filter(([id]) => offered.has(id));
    const choice = new Map(fresh);
    // Skipped: never pinned, never lined.
    const skipped = [...new Set([...pin, ...lineIds])].filter((id) => choice.get(id) === "skip");
    if (skipped.length > 0) {
      return refuse("skipped", `the athlete skipped ${named(skipped)} — leave it out of pin and lines.`, "Take it out of pin and give it no line: it stays in their library, unpinned.");
    }
    // Included: pinned, always — one set aside since is the athlete's to put back.
    const leftOut = fresh.filter(([id, c]) => c === "include" && !pin.includes(id) && !asideIds.has(id)).map(([id]) => id);
    if (leftOut.length > 0) {
      return refuse("include_left_out", `${named(leftOut)} — the athlete chose to include it — pin it, with a line on where it goes.`, "Add it to pin, with a line by its moveId saying where it goes.");
    }
    // On the coach's call: pinned, unpinned, or a line's moveId — so a move left out is left out with a reason the card
    // shows (coach-context audit I5). A skipped one needs none.
    const unaccounted = fresh.filter(([id, c]) => c !== "skip" && !pin.includes(id) && !unpin.includes(id) && !lineIds.includes(id)).map(([id]) => id);
    if (unaccounted.length > 0) {
      return refuse(
        "incomplete",
        `${plural(unaccounted.length, "new move")} of this batch ${unaccounted.length === 1 ? "is" : "are"} not accounted for: ${unaccounted.map((id) => JSON.stringify(id)).join(", ")}.`,
        "Pin each new move, or give it a line with its moveId saying why it was left out (the card shows its name).",
      );
    }

    // A line a move: its name from the library, once; the coach's text without a copy of it, clipped after the name is
    // placed — at a sentence end wherever one fits (§3.5). A name past half the cap (never: names are 80 at most) keeps
    // half the cap for its text.
    const lines = parsed.lines.map((l): PinsCardLine => {
      if (!l.moveId) return { text: clipProse(namesFor(l.text, find), PIN_LINE_MAX, { atSentence: true }) };
      const name = nameOf(l.moveId);
      const room = Math.max(PIN_LINE_MAX - name.length - 2, PIN_LINE_MAX / 2);
      return { moveId: l.moveId, name, text: clipProse(namesFor(lineTextOf(l.text, l.moveId, name), find), room, { atSentence: true }) };
    });
    // With a batch, the card's line counts its new moves (review round 1): those pinned join — a pin of a move the athlete
    // had already is no joining — and those on the coach's call left out wait.
    const joined = fresh.filter(([id]) => pin.includes(id)).length;
    const waiting = fresh.filter(([id, c]) => c !== "include" && c !== "skip" && !pin.includes(id)).map(([id]) => nameOf(id));
    const at = ctx.now.toISOString();
    const toolUseId = ctx.toolUseId ?? `call-${at}`;
    const op: MovePinsOp = {
      kind: "move_pins",
      id: opId,
      pin,
      unpin,
      ...(batchId ? { batchId } : {}),
      why: clipProse(parsed.why, WHY_MAX),
      title: clipProse(parsed.title, TITLE_MAX),
      summary: clipProse(batchId ? pinsSummaryLine(joined, waiting) : parsed.summary!, SUMMARY_MAX),
      lines,
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
