/**
 * PERSONAL MOVES, AS MATCHING SEES THEM (saved-posts import, Task 8). A personal move is a move from the owner's saves
 * that the public library doesn't have, stored per account (`personal_moves`) as an ExerciseRecord. Matching reads only
 * what it compares (id, status, merge target, name: one statement, no record parsed), and builds a new move's record
 * from its schema-parsed draft, held to the library's own validation before anything is written.
 *
 * Status: `pending` (in an unsaved batch: only the review reads it) → `active` → `archived` | `merged` (`merged_into`).
 * A move the owner has edited (`edited_by_owner`) is never rewritten by an import: matching only ever adds links.
 */
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import type { PersonalMoveRow } from "@rg/database";
import { moveProblems, plyometricWord, type ExerciseRecord } from "@rg/exercise-library";
import { personalMoveId, type ExtractedMove } from "@rg/saves";
import type { Db } from "./db.js";
import { doseOriginOf, toPersonalRecord, validatePersonalRecord, repairDraft, type DoseOrigin } from "./personal-records.js";

const { personalMoves } = schema;

/**
 * What matching needs of a personal move: never the record itself. `patterns` and `regions` are the record's lists as
 * JSON text, parsed only for a move offered to the judge; `load` and `doseType` (the record's `load` and `dose.type`)
 * are what tells two like-named moves apart (`nearDuplicateOf`, `sameMoveType`).
 */
export type PersonalMatchRow = Pick<PersonalMoveRow, "id" | "status" | "mergedInto"> & {
  name: string | null;
  patterns?: string | null;
  regions?: string | null;
  load?: string | null;
  doseType?: string | null;
};

/** The account's personal moves, every status, for matching. ONE statement; the fields are read out of the record by SQLite. */
export async function loadPersonalForMatch(db: Db, userId: string): Promise<PersonalMatchRow[]> {
  return db
    .select({
      id: personalMoves.id,
      status: personalMoves.status,
      mergedInto: personalMoves.mergedInto,
      name: sql<string | null>`json_extract(${personalMoves.record}, '$.name')`,
      patterns: sql<string | null>`json_extract(${personalMoves.record}, '$.patterns')`,
      regions: sql<string | null>`json_extract(${personalMoves.record}, '$.regions')`,
      load: sql<string | null>`json_extract(${personalMoves.record}, '$.load')`,
      doseType: sql<string | null>`json_extract(${personalMoves.record}, '$.dose.type')`,
    })
    .from(personalMoves)
    .where(eq(personalMoves.userId, userId));
}

/**
 * A new move's id: its name's words and a hash of where it was first seen (account, post, position). The same post
 * matched again makes the same id, so a re-run inserts nothing new.
 */
export const newPersonalMoveId = (userId: string, postId: string, position: number, name: string): string =>
  personalMoveId(name, `${userId}:${postId}:${position}`);

/**
 * A reading whose words say it jumps, stored as a jump (the safety audit, 2026-11-06, S2): the condition gates see a jump
 * only through its plyometric contraction, which the reader model wrote — an imported "Pogo hops" read as isotonic went
 * past every gate. When the move's name, or its summary and steps, say it hops, jumps, bounds or lands
 * (@rg/exercise-library `plyometricWord`) and the reading's contraction doesn't, it is forced to plyometric (as the
 * library's own jumps are), its purposes read again from it (power, never a primer), and the reason is returned: a repair
 * line, so the trail's check stage shows it and the link is flagged "check this". The owner's word can take it back
 * (correct_import's contraction).
 */
function asJump(draft: ExtractedMove): { draft: ExtractedMove; reason: string } | null {
  if (draft.contraction.includes("plyometric")) return null;
  const inName = plyometricWord(draft.name);
  const word = inName ?? plyometricWord("", [draft.summary, ...draft.steps].join(" "));
  if (!word) return null;
  const read = draft.contraction.length > 0 ? draft.contraction.join(", ") : "nothing";
  return {
    draft: { ...draft, contraction: ["plyometric"] },
    reason: `contraction read as ${read}, but ${inName ? "its name says" : "its words say"} "${word}": stored as plyometric — a jump the condition rules gate`,
  };
}

/**
 * The record for a new personal move, or why it can't be stored. The draft must be one `extractedMoveSchema` parsed
 * (every profile's rating present); a build that throws anyway is reported, never thrown. Issues are the validator's
 * own words with the id taken off (the id is built from the model's name). A reading whose words say jump is stored as
 * one (`asJump`): `reclassified` is why, also among the repairs.
 */
export function buildPersonalRecord(
  id: string,
  draft: ExtractedMove,
): { ok: true; record: ExerciseRecord; repairs: string[]; doseOrigin: DoseOrigin; reclassified?: string } | { ok: false; issues: string[] } {
  const repaired = repairDraft(draft);
  const jump = asJump(repaired.draft);
  const built = jump ? jump.draft : repaired.draft;
  let record: ExerciseRecord;
  try {
    record = toPersonalRecord(id, built);
  } catch {
    return { ok: false, issues: ["the move could not be built into a record"] };
  }
  const problems = validatePersonalRecord(record);
  if (problems.length) return { ok: false, issues: problems.map((p) => safeIssue(id, p)) };
  // What repair couldn't settle isn't worth refusing a paid reading over: it flags the move "check this" with the repairs.
  return {
    ok: true,
    record,
    repairs: [...repaired.repairs, ...(jump ? [jump.reason] : []), ...moveProblems(record)],
    doseOrigin: doseOriginOf(repaired.draft),
    ...(jump ? { reclassified: jump.reason } : {}),
  };
}

/**
 * One validator line without anything the model wrote: the id prefix goes, and a rating key the profile doesn't have
 * (a key the model chose) is not repeated.
 */
function safeIssue(id: string, problem: string): string {
  const text = problem.startsWith(`${id}: `) ? problem.slice(id.length + 2) : problem.replace(/^[^:]*: /, "");
  const stray = /^conditions\.([a-z0-9-]+)\.\S+ is not an attribute of .*$/.exec(text);
  if (stray) return `conditions.${stray[1]}: has a rating the profile does not have`;
  return text.slice(0, 200);
}
