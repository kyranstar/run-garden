/**
 * THE ACCOUNT'S LIBRARY (saved-posts import, Task 12): the public library (`EXERCISES`) and the account's personal moves
 * (`personal_moves`, each a stored ExerciseRecord), as each reader needs them:
 *
 *  - `all` — what a workout's moves resolve against wherever the Worker validates, builds or derives one: the public
 *    library, the active and archived personal moves, and each merged move's id as its target's (`legacyIds` on the
 *    target, a personal move's or a public one's). So an old document holding an archived or merged move still
 *    validates and builds (Review Focus 4).
 *  - `offered` — what search, the coach and ⇄ offer: the public library and the active moves. An archived move is never
 *    offered.
 *  - `engine` — what the engine plans from: the public library and the active moves the athlete pinned
 *    (`exercise_prefs.pinned`).
 *
 * A pending move (in a batch not yet saved) is in none of them: only the review reads it. With no personal moves, each
 * view is `EXERCISES` itself, so every index made once per library array (`makeLibraryIndex`, the engine's, the
 * validator's) is the public library's own.
 *
 * COST. One statement — the moves with their pins (`loadAccountLibrary`), made once a request (memoised on the request's
 * `Db`); a read that already spends one statement on the athlete carries it as a column instead (`personalMovesSql`,
 * then `accountLibraryFrom`), and the request's later reads find it; a read that needs it only for the personal moves it
 * meets (a history, a stored document's minutes) asks `libraryFor` with their ids, and pays nothing when none is one.
 * The views are made once an isolate for a set of personal moves, found again by `personalHash` (a hash of the rows as
 * read: status, merge target, pin and the record's own text), so a request whose set is unchanged parses no record, and
 * every index made per array is found again too.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { schema } from "@rg/database";
import type { WorkoutDoc } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { isPersonalId } from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";
import { sha256Hex } from "../auth/crypto.js";
import type { Db } from "./db.js";

const { personalMoves, exercisePrefs } = schema;

export interface AccountLibrary {
  /** The public library, the active and archived personal moves (a merged move's id among its target's `legacyIds`). */
  all: readonly ExerciseRecord[];
  /** The public library and the active personal moves. */
  offered: readonly ExerciseRecord[];
  /** The public library and the active personal moves the athlete pinned. */
  engine: readonly ExerciseRecord[];
  /** A hash of the account's personal moves as read (empty when it has none): a build that reads them is made again when it changes. */
  personalHash: string;
}

/** An account with no personal moves: every view the public library itself. */
export const PUBLIC_LIBRARY: AccountLibrary = Object.freeze({ all: EXERCISES, offered: EXERCISES, engine: EXERCISES, personalHash: "" });

/** The statuses a library holds (a pending move is the review's alone). */
const RESOLVED = ["active", "archived", "merged"] as const;
/** The most merges followed from a merged move to its target (as matching follows them, saves-match.ts `personalIndex`). */
const MAX_MERGE_HOPS = 5;
/** The most sets of views an isolate keeps (one per account whose moves it has met, and per edit since). */
const MAX_KEPT = 16;

/** A personal move as the library reads it. */
interface Row {
  id: string;
  status: string;
  mergedInto: string | null;
  /** The record's own JSON text; null for a merged move (only its target is read). */
  record: string | null;
  pinned: boolean;
}

/** The views made in this isolate, by `personalHash`, least recently used first. */
const kept = new Map<string, AccountLibrary>();
/** Each request's libraries, by account: the request's `Db` is made for it (`withDb`), and dropped with it. */
const perRequest = new WeakMap<Db, Map<string, Promise<AccountLibrary>>>();

/** This request's library for the account, or `make()`'s, kept for the rest of the request (a failed one is not kept). */
function memoised(db: Db, userId: string, make: () => Promise<AccountLibrary>): Promise<AccountLibrary> {
  let mine = perRequest.get(db);
  if (!mine) perRequest.set(db, (mine = new Map()));
  const had = mine.get(userId);
  if (had) return had;
  const made = make();
  mine.set(userId, made);
  const byUser = mine;
  made.catch(() => {
    if (byUser.get(userId) === made) byUser.delete(userId);
  });
  return made;
}

/** The account's library (see the header). One statement, once a request. */
export function loadAccountLibrary(db: Db, userId: string): Promise<AccountLibrary> {
  return memoised(db, userId, async () => {
    const rows = await db
      .select({
        id: personalMoves.id,
        status: personalMoves.status,
        mergedInto: personalMoves.mergedInto,
        record: sql<string | null>`CASE WHEN ${personalMoves.status} = 'merged' THEN NULL ELSE ${personalMoves.record} END`,
        pinned: sql<number>`coalesce(${exercisePrefs.pinned}, 0)`,
      })
      .from(personalMoves)
      .leftJoin(exercisePrefs, and(eq(exercisePrefs.userId, personalMoves.userId), eq(exercisePrefs.exerciseId, personalMoves.id)))
      .where(and(eq(personalMoves.userId, userId), inArray(personalMoves.status, [...RESOLVED])))
      .orderBy(asc(personalMoves.id));
    return libraryOf(rows.map((r) => ({ ...r, pinned: Boolean(r.pinned) })));
  });
}

/**
 * The account's personal moves as one column of a read that spends its statement on the athlete anyway (`readAthlete`'s
 * extras): a JSON array of `[id, status, merged into, record text, pinned]`. `accountLibraryFrom` reads it. Its tables
 * go by their own aliases, so it reads the same as a column of a query builder's select over another table (whose
 * columns a builder names bare: an `id` there would be ambiguous).
 */
export function personalMovesSql(userId: string): SQL {
  return sql`(select json_group_array(json_array(pm_lib.id, pm_lib.status, pm_lib.merged_into,
      case when pm_lib.status = 'merged' then null else pm_lib.record end, coalesce(ep_lib.pinned, 0)))
    from personal_moves pm_lib left join exercise_prefs ep_lib
      on ep_lib.user_id = pm_lib.user_id and ep_lib.exercise_id = pm_lib.id
    where pm_lib.user_id = ${userId} and pm_lib.status in ('active', 'archived', 'merged'))`;
}

/**
 * The account's library from `personalMovesSql`'s column (`raw`), kept as this request's: the request's later reads find
 * it with no statement. The rows just read stand over any the request read before.
 */
export function accountLibraryFrom(db: Db, userId: string, raw: unknown): Promise<AccountLibrary> {
  forgetAccountLibrary(db, userId);
  return memoised(db, userId, () => libraryOf(rowsOf(raw)));
}

/**
 * The account's library when any of `ids` is a personal id (`loadAccountLibrary`: one statement, once a request), else
 * the public library at no cost: a read that names only library moves stays as it was, and one that names a personal
 * move resolves it — a merged one as its target.
 */
export function libraryFor(db: Db, userId: string, ids: Iterable<string>): Promise<AccountLibrary> {
  for (const id of ids) if (isPersonalId(id)) return loadAccountLibrary(db, userId);
  return Promise.resolve(PUBLIC_LIBRARY);
}

/** Every move id a document names: its moves' and their alternates'. */
export function docMoveIds(doc: WorkoutDoc | null | undefined): string[] {
  if (!doc) return [];
  return doc.parts.flatMap((p) =>
    p.items.flatMap((i) => (i.kind === "exercise" ? [i.libraryId, ...(i.alternates ?? []).map((a) => a.libraryId)] : [])),
  );
}

/** `libraryFor` the moves these documents name. */
export function libraryForDocs(db: Db, userId: string, docs: Iterable<WorkoutDoc | null | undefined>): Promise<AccountLibrary> {
  return libraryFor(db, userId, [...docs].flatMap(docMoveIds));
}

/**
 * Forget what this request read of an account's library (every account's, with no `userId`): a write that changes it —
 * a batch saved, a pin — so a later read in the same request sees the write.
 */
export function forgetAccountLibrary(db: Db, userId?: string): void {
  if (userId === undefined) perRequest.delete(db);
  else perRequest.get(db)?.delete(userId);
}

/** `personalMovesSql`'s rows; a row that doesn't read is left out. */
function rowsOf(raw: unknown): Row[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((r): Row[] => {
    if (!Array.isArray(r)) return [];
    const [id, status, mergedInto, record, pinned] = r as unknown[];
    if (typeof id !== "string" || typeof status !== "string") return [];
    return [{ id, status, mergedInto: typeof mergedInto === "string" ? mergedInto : null, record: typeof record === "string" ? record : null, pinned: pinned === 1 || pinned === true }];
  });
}

/** The library of these rows: the views this isolate made for the same rows, else new ones. */
async function libraryOf(read: readonly Row[]): Promise<AccountLibrary> {
  if (read.length === 0) return PUBLIC_LIBRARY;
  // In id order, however they were read: the same moves hash the same.
  const rows = [...read].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const personalHash = (
    await sha256Hex(rows.map((r) => `${r.id}\u0000${r.status}\u0000${r.mergedInto ?? ""}\u0000${r.pinned ? 1 : 0}\u0000${r.record ?? ""}`).join("\u0001"))
  ).slice(0, 16);
  let views = kept.get(personalHash);
  if (views) {
    kept.delete(personalHash);
  } else {
    views = viewsOf(rows, personalHash);
    if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value!);
  }
  kept.set(personalHash, views);
  return views;
}

/** The three views of an account's moves (rows in id order). */
function viewsOf(rows: readonly Row[], personalHash: string): AccountLibrary {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const publicMove = makeLibraryIndex(EXERCISES);
  /** A merged move's target: through merges, to an active or archived move of the account or a public move; else none. */
  const targetOf = (row: Row): string | null => {
    let at = row.mergedInto;
    for (let hop = 0; at; hop++) {
      if (hop >= MAX_MERGE_HOPS) return null;
      const next = byId.get(at);
      if (!next) return publicMove(at)?.id ?? null;
      if (next.status !== "merged") return next.id;
      at = next.mergedInto;
    }
    return null;
  };
  const aliases = new Map<string, string[]>();
  for (const row of rows) {
    if (row.status !== "merged" || !isPersonalId(row.id)) continue;
    const target = targetOf(row);
    if (target) aliases.set(target, [...(aliases.get(target) ?? []), row.id]);
  }

  const mine: ExerciseRecord[] = [];
  const active: ExerciseRecord[] = [];
  const pinned: ExerciseRecord[] = [];
  for (const row of rows) {
    if (row.status === "merged") continue;
    const rec = recordOf(row, aliases.get(row.id) ?? []);
    if (!rec) continue;
    mine.push(rec);
    if (row.status !== "active") continue;
    active.push(rec);
    if (row.pinned) pinned.push(rec);
  }
  // A move merged into a public one: that move with the merged ids among its legacy ids (in `all` alone).
  const intoPublic = new Map([...aliases].filter(([id]) => !byId.has(id)));
  const base = intoPublic.size > 0 ? EXERCISES.map((e) => (intoPublic.has(e.id) ? { ...e, legacyIds: [...e.legacyIds, ...intoPublic.get(e.id)!] } : e)) : EXERCISES;
  return {
    all: base === EXERCISES && mine.length === 0 ? EXERCISES : [...base, ...mine],
    offered: active.length > 0 ? [...EXERCISES, ...active] : EXERCISES,
    engine: pinned.length > 0 ? [...EXERCISES, ...pinned] : EXERCISES,
    personalHash,
  };
}

/**
 * A stored move's record, its id the row's and its legacy ids the merged moves' (a personal id only: a personal move
 * never answers for a public one); null when its text doesn't read as a record, which leaves it out.
 */
function recordOf(row: Row, merged: readonly string[]): ExerciseRecord | null {
  if (!isPersonalId(row.id) || row.record === null) return null;
  let rec: ExerciseRecord | null = null;
  try {
    rec = JSON.parse(row.record) as ExerciseRecord;
  } catch {
    rec = null;
  }
  if (!rec || typeof rec !== "object" || typeof rec.name !== "string") {
    console.error(`personal move ${row.id}: its stored record does not read as a record; left out of the library`);
    return null;
  }
  const own = Array.isArray(rec.legacyIds) ? rec.legacyIds.filter((id) => typeof id === "string" && isPersonalId(id)) : [];
  return { ...rec, id: row.id, legacyIds: [...new Set([...own, ...merged])] };
}
