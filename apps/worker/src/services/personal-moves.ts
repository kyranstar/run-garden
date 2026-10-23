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
import type { ExerciseRecord } from "@rg/exercise-library";
import { personalMoveId, type ExtractedMove } from "@rg/saves";
import type { Db } from "./db.js";
import { toPersonalRecord, validatePersonalRecord } from "./personal-records.js";

const { personalMoves } = schema;

/** What matching needs of a personal move: never the record itself. */
export type PersonalMatchRow = Pick<PersonalMoveRow, "id" | "status" | "mergedInto"> & { name: string | null };

/** The account's personal moves, every status, for matching. ONE statement; the name is read out of the record by SQLite. */
export async function loadPersonalForMatch(db: Db, userId: string): Promise<PersonalMatchRow[]> {
  return db
    .select({
      id: personalMoves.id,
      status: personalMoves.status,
      mergedInto: personalMoves.mergedInto,
      name: sql<string | null>`json_extract(${personalMoves.record}, '$.name')`,
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
 * The record for a new personal move, or why it can't be stored. The draft must be one `extractedMoveSchema` parsed
 * (every profile's rating present); a build that throws anyway is reported, never thrown. Issues are the validator's
 * own words with the id taken off (the id is built from the model's name).
 */
export function buildPersonalRecord(id: string, draft: ExtractedMove): { ok: true; record: ExerciseRecord } | { ok: false; issues: string[] } {
  let record: ExerciseRecord;
  try {
    record = toPersonalRecord(id, draft);
  } catch {
    return { ok: false, issues: ["the move could not be built into a record"] };
  }
  const problems = validatePersonalRecord(record);
  if (problems.length) return { ok: false, issues: problems.map((p) => safeIssue(id, p)) };
  return { ok: true, record };
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
