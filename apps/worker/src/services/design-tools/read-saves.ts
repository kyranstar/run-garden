/**
 * read_saves — what came in from the athlete's saves (saved-posts import, Task 17). Task 16's opening brings a released
 * batch with "Fit these in", which saves it and asks the coach to fit its new moves in; this is how the coach sees them.
 *
 * THE BATCH: the newest the athlete saved in the last SAVES_WINDOW_DAYS that nothing has fitted in yet (`fitted_at`
 * null) — or the saved batch `batchId` names, whatever its age or fit. Its moves come from the links the owner kept
 * (`saved`; a removed one never), each move once, new ones first and then in the order the posts showed them:
 *  - `name`, `summary`: a personal move's are a model's reading of a creator's post (or the owner's edit of it), marked;
 *    a library move's are the library's own words;
 *  - `new`: the batch brought it (`personal_moves.batch_id`, not merged since); else the athlete had it already;
 *  - `pinned` (`exercise_prefs.pinned`) and `groups` (the notice's grouping: @rg/saves `moveGroup`);
 *  - `posts`: how many of the batch's posts show it; `links`: the first LINKS_MAX of them, the url (plain: an address,
 *    not prose), the creator (the handle, else the name: marked) and the note (spec §17: what the post says the move is
 *    for, or when to do it — the post's reading of it, `purpose`: marked); `fromPost`: the first post's reading
 *    (`extraction.summary`: marked).
 * And `routines` (at most ROUTINES_MAX): the batch's routine posts, each its reading (marked) and its moves' ids in the
 * post's order. And `insights` (at most SAVES_INSIGHTS_MAX, spec §17): what the batch's kept posts say about when, why
 * or how often to do something, in the posts' order (marked) — Save kept them in the coach's memory too. A move merged
 * since reads as the move it went into (the account's library, Task 12); a move the library no longer offers —
 * archived since, or merged into an archived move — is left out of both and named in `missing` (an archived move is
 * resolvable but never offered).
 *
 * Nothing to read — no such batch — is an answer that says so (`missing`), never an error. A batchId that is not a saved
 * batch of the athlete's — another account's, one not saved, one nobody has — is refused alike (`not_found`), so nothing
 * says another account's batch exists.
 *
 * SIZE. At most SAVES_MOVES_MAX moves a read (`limit`), from `offset` in the batch's one order, and of those as many as
 * fit RESULT_BUDGET_BYTES beside the insights (on every page, room kept for them first), with the routines; `missing`
 * says how many moves are left and the offset that reads them (a batch stays readable by id once it is fitted in), and
 * how many routines the cap or the room left out.
 *
 * COST. Two statements: the athlete (the step's shared read, which carries the account's library: `athleteOf`) and the
 * batch with the account's pins. `savesBatchSql` and `savedMovesOf` are the opening context's too (design-context.ts,
 * "From the athlete's saves"), so the two say the same moves.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { dayLabel } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { isPersonalId, moveGroup } from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";
import { loadAccountLibrary, type AccountLibrary } from "../account-library.js";
import { insightsJsonSql, insightsOf, type BatchInsight } from "../saves-batches.js";
import { utf8Bytes } from "../utf8.js";
import type { DesignTool } from "./types.js";
import {
  answer,
  athleteOf,
  byBytes,
  isErr,
  limitField,
  localDateOf,
  parsedArray,
  parsedJson,
  parseInput,
  plural,
  READ_ROLES,
  refuse,
  RESULT_BUDGET_BYTES,
  untrusted,
  untrustedOrNull,
  type Untrusted,
} from "./read-common.js";

/** How far back a saved batch still waits to be fitted in, in days. */
export const SAVES_WINDOW_DAYS = 14;
/** The most moves one read lists, and the opening context's section shows. */
export const SAVES_MOVES_MAX = 12;
/** The posts a move's links name, at most (`posts` counts them all). */
const LINKS_MAX = 3;
/** The routines one read lists, at most. */
const ROUTINES_MAX = 5;
/** The insights of the batch's kept posts one read lists, and the opening context's section shows, at most. */
export const SAVES_INSIGHTS_MAX = 5;

const SOURCE = "the athlete's saves";
const NONE_WAITING = `no saved batch waiting to be fitted in: none saved in the last ${SAVES_WINDOW_DAYS} days, or each one is fitted in already`;

/** One link the owner kept: a post's move at a position. `born`: the batch brought the move (and it isn't merged). */
export interface SavedLink {
  moveId: string;
  postId: string;
  position: number;
  born: boolean;
  /** When the post was first seen: the order the posts came in. */
  seen: string;
  /** The post's reading of the move's purpose (read_saves' only: `posts`): a model's words. */
  note?: string | null;
}

/** A post of the batch, as read_saves shows it (the context reads none). Every string but the url is from outside. */
export interface SavedPost {
  url: string | null;
  creator: string | null;
  kind: string | null;
  summary: string | null;
}

export interface SavedBatch {
  id: string;
  savedAt: string;
  links: SavedLink[];
  posts: Map<string, SavedPost>;
  /** The first SAVES_INSIGHTS_MAX insights of its kept posts, in the posts' order (saves-batches.ts `insightsOf`). */
  insights: BatchInsight[];
}

/** A move of the batch: its record in the account's library, whether the batch brought it, the posts showing it in order. */
export interface SavedMove {
  record: ExerciseRecord;
  new: boolean;
  postIds: string[];
  /** Each post's note on the move (its first link's), beside `postIds`: null with none or unread. */
  notes: Array<string | null>;
}

/**
 * The batch as ONE JSON value — a scalar subquery, so it rides in a statement that reads something else (the opening
 * context's counts): `{ id, savedAt, links: [[moveId, postId, position, born, seen]], posts? }`, or null with no batch.
 * Without `batchId`: the newest saved batch from the last SAVES_WINDOW_DAYS not fitted in; with it, that saved batch of
 * the athlete's. `insights`: the first SAVES_INSIGHTS_MAX of its kept posts (`insightsJsonSql`). `posts` adds each
 * post's url, creator, kind and reading, and each link's note (read_saves'). Its tables go by their own aliases, so it
 * reads the same inside any select.
 */
export function savesBatchSql(userId: string, o: { now: Date; batchId?: string; posts?: boolean }): SQL {
  const since = new Date(o.now.getTime() - SAVES_WINDOW_DAYS * 86_400_000).toISOString();
  const which = o.batchId !== undefined ? sql`sv_b.id = ${o.batchId}` : sql`sv_b.fitted_at is null and sv_b.saved_at >= ${since}`;
  const posts = o.posts
    ? sql`, 'posts', json((select json_group_array(json_array(sv_q.id, sv_q.url, coalesce(nullif(sv_q.creator_handle, ''), sv_q.creator_name),
          case when json_valid(sv_q.extraction) then json_extract(sv_q.extraction, '$.kind') end,
          case when json_valid(sv_q.extraction) then json_extract(sv_q.extraction, '$.summary') end))
        from saved_posts sv_q where sv_q.user_id = ${userId} and sv_q.id in (
          select sv_k.post_id from saved_post_moves sv_k where sv_k.user_id = ${userId} and sv_k.batch_id = sv_b.id and sv_k.status = 'saved')))`
    : sql``;
  // A link's note: the post's reading of the move at its position (`purpose`), when it is words.
  const doc = sql`case when json_valid(sv_p.extraction) then sv_p.extraction end`;
  const path = sql`'$.moves[' || sv_l.position || '].purpose'`;
  const note = o.posts ? sql`, case when json_type(${doc}, ${path}) = 'text' then nullif(trim(json_extract(${doc}, ${path})), '') end` : sql``;
  const keptPosts = sql`select sv_n.post_id from saved_post_moves sv_n where sv_n.user_id = ${userId} and sv_n.batch_id = sv_b.id and sv_n.status = 'saved'`;
  return sql`(select json_object('id', sv_b.id, 'savedAt', sv_b.saved_at,
      'links', json((select json_group_array(json_array(sv_l.move_id, sv_l.post_id, sv_l.position,
          coalesce(sv_m.batch_id = sv_b.id and sv_m.status != 'merged', 0), coalesce(sv_p.first_seen_at, '')${note}))
        from saved_post_moves sv_l
        left join saved_posts sv_p on sv_p.user_id = sv_l.user_id and sv_p.id = sv_l.post_id
        left join personal_moves sv_m on sv_m.user_id = sv_l.user_id and sv_m.id = sv_l.move_id
        where sv_l.user_id = ${userId} and sv_l.batch_id = sv_b.id and sv_l.status = 'saved')),
      'insights', json(${insightsJsonSql(userId, keptPosts, SAVES_INSIGHTS_MAX)})${posts})
    from save_batches sv_b where sv_b.user_id = ${userId} and sv_b.status = 'saved' and ${which}
    order by sv_b.saved_at desc, sv_b.id desc limit 1)`;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `savesBatchSql`'s value, read; null with no batch (or one that doesn't read). */
export function savedBatchOf(raw: unknown): SavedBatch | null {
  const b = parsedJson(raw) as { id?: unknown; savedAt?: unknown; links?: unknown; posts?: unknown; insights?: unknown } | null;
  if (!b || typeof b !== "object" || typeof b.id !== "string" || typeof b.savedAt !== "string" || !Number.isFinite(Date.parse(b.savedAt))) return null;
  const links = parsedArray(b.links).flatMap((x): SavedLink[] => {
    const [moveId, postId, position, born, seen, note] = Array.isArray(x) ? (x as unknown[]) : [];
    return typeof moveId === "string" && typeof postId === "string" && typeof position === "number"
      ? [{ moveId, postId, position, born: born === 1 || born === true, seen: str(seen) ?? "", note: str(note) }]
      : [];
  });
  const posts = new Map(
    parsedArray(b.posts).flatMap((x): Array<[string, SavedPost]> => {
      const [id, url, creator, kind, summary] = Array.isArray(x) ? (x as unknown[]) : [];
      return typeof id === "string" ? [[id, { url: str(url), creator: str(creator), kind: str(kind), summary: str(summary) }]] : [];
    }),
  );
  return { id: b.id, savedAt: b.savedAt, links, posts, insights: insightsOf(b.insights).slice(0, SAVES_INSIGHTS_MAX) };
}

/** The links in the order the posts showed them: the posts as they came in, each post's by position. */
const inPostOrder = (links: readonly SavedLink[]): SavedLink[] =>
  [...links].sort((a, b) => byBytes(a.seen, b.seen) || byBytes(a.postId, b.postId) || a.position - b.position);

/** The personal moves a library offers, by id, made once an array (`offered` is the public library and the active moves). */
const OFFERED_OWN = new WeakMap<readonly ExerciseRecord[], ReadonlySet<string>>();
function offeredOwn(offered: readonly ExerciseRecord[]): ReadonlySet<string> {
  let ids = OFFERED_OWN.get(offered);
  if (!ids) OFFERED_OWN.set(offered, (ids = new Set(offered.flatMap((r) => (isPersonalId(r.id) ? [r.id] : [])))));
  return ids;
}

/** What a link names, as the coach may offer it: the move it is in the account's library (`all`: a merged move as its
 * target), when the library still offers it — an archived move, or one merged into an archived move, is never offered. */
export interface SavedResolver {
  /** The offered move a link names; null for one the library no longer holds or doesn't offer. */
  find(moveId: string): ExerciseRecord | null;
}

function resolverOf(library: Pick<AccountLibrary, "all" | "offered">): SavedResolver & { archived(moveId: string): string | null } {
  const inAll = makeLibraryIndex(library.all);
  const own = offeredOwn(library.offered);
  const offered = (r: ExerciseRecord) => !isPersonalId(r.id) || own.has(r.id);
  return {
    find: (moveId) => {
      const r = inAll(moveId);
      return r && offered(r) ? r : null;
    },
    archived: (moveId) => {
      const r = inAll(moveId);
      return r && !offered(r) ? r.id : null;
    },
  };
}

/**
 * The batch's moves the coach may offer, each once — by the move it is in the account's library (a merged move as its
 * target) — new ones first, then in the order the posts showed them. `archived`: the moves left out because the
 * library no longer offers them (archived since, or merged into an archived move), by id; `unread`: how many it no
 * longer holds at all. `find` resolves a link the same way (for a routine's order).
 */
export function savedMovesOf(
  batch: SavedBatch,
  library: Pick<AccountLibrary, "all" | "offered">,
): { moves: SavedMove[]; archived: string[]; unread: number; find: SavedResolver["find"] } {
  const resolve = resolverOf(library);
  const byId = new Map<string, SavedMove>();
  const archived = new Set<string>();
  const unread = new Set<string>();
  for (const l of inPostOrder(batch.links)) {
    const record = resolve.find(l.moveId);
    if (!record) {
      const gone = resolve.archived(l.moveId);
      if (gone) archived.add(gone);
      else unread.add(l.moveId);
      continue;
    }
    let move = byId.get(record.id);
    if (!move) byId.set(record.id, (move = { record, new: false, postIds: [], notes: [] }));
    if (l.born) move.new = true;
    if (!move.postIds.includes(l.postId)) {
      move.postIds.push(l.postId);
      move.notes.push(l.note ?? null);
    }
  }
  // New first; each part in the posts' order (the sort is stable).
  const moves = [...byId.values()].sort((a, b) => Number(b.new) - Number(a.new));
  return { moves, archived: [...archived], unread: unread.size, find: resolve.find };
}

/** A move's words: a personal move's, marked (a model's reading of a post, or the owner's edit); the library's, as they are. */
const wordsOf = (record: ExerciseRecord, text: string): string | Untrusted => (isPersonalId(record.id) ? untrusted(text) : text);

const bytesOf = (value: unknown): number => utf8Bytes(JSON.stringify(value));

const input = z
  .object({ batchId: z.string().min(1).max(100).optional(), limit: limitField(SAVES_MOVES_MAX).optional(), offset: z.number().int().min(0).max(10_000).optional() })
  .strict();

export const readSaves: DesignTool = {
  name: "read_saves",
  description:
    "What came in from the athlete's saves: the newest saved batch not yet fitted in (or batchId's). Each move new or theirs already, pinned or not, its posts and their reading; the routines in post order.",
  inputSchema: {
    type: "object",
    properties: {
      batchId: { type: "string", description: "A saved batch's id; default the newest not yet fitted in." },
      limit: { type: "integer", minimum: 1, maximum: SAVES_MOVES_MAX, description: `Default ${SAVES_MOVES_MAX}, the most.` },
      offset: { type: "integer", minimum: 0, description: "Moves to skip: the offset missing gives." },
    },
    additionalProperties: false,
  },
  statementCost: 2,
  // Measured (design-cpu-bench.test.ts 8.read_saves: 40 posts, 120 links, 36 moves): 0.97–1.09 ms scaled p50 on a loaded
  // runner; declared with room, as its peers are.
  cpuWeight: 1.2,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally batchId, limit and offset");
    if (isErr(p)) return p;
    const limit = p.limit ?? SAVES_MOVES_MAX;
    const [athlete, rows] = await Promise.all([
      athleteOf(ctx),
      ctx.db.all(sql`select ${savesBatchSql(ctx.userId, { now: ctx.now, batchId: p.batchId, posts: true })} as batch,
          (select json_group_array(sv_e.exercise_id) from exercise_prefs sv_e where sv_e.user_id = ${ctx.userId} and sv_e.pinned = 1) as pins`) as Promise<
        Array<{ batch: unknown; pins: unknown }>
      >,
    ]);
    const batch = savedBatchOf(rows[0]?.batch);
    if (!batch) {
      if (p.batchId !== undefined) {
        return refuse(
          "not_found",
          `No saved batch of the athlete's has id ${JSON.stringify(p.batchId)}.`,
          "Leave batchId out to read the newest saved batch not yet fitted in.",
        );
      }
      return answer({
        source: SOURCE, now: ctx.now, missing: [...athlete.missing, NONE_WAITING], data: { batch: null, moves: [], routines: [], insights: [] }, summary: "Nothing new from your saves",
      });
    }

    // The athlete's read carried the account's library: this costs no statement.
    const library = await loadAccountLibrary(ctx.db, ctx.userId);
    const pins = new Set(parsedArray(rows[0]?.pins).filter((id): id is string => typeof id === "string"));
    const { moves, archived, unread, find } = savedMovesOf(batch, library);
    const offset = p.offset ?? 0;
    if (offset > 0 && offset >= moves.length) {
      return refuse(
        "bad_offset",
        `The batch lists ${plural(moves.length, "move")}; offset ${offset} is past them.`,
        "Pass the offset a previous answer's missing gave, or leave it out to start from the first move.",
      );
    }
    const postOf = (id: string): SavedPost | undefined => batch.posts.get(id);

    // This page's moves, in the batch's one order.
    const listed = moves.slice(offset, offset + limit).map((m) => ({
      id: m.record.id,
      name: wordsOf(m.record, m.record.name),
      summary: wordsOf(m.record, m.record.text?.summary ?? ""),
      new: m.new,
      pinned: pins.has(m.record.id),
      groups: moveGroup(m.record),
      posts: m.postIds.length,
      links: m.postIds
        .slice(0, LINKS_MAX)
        .map((id, k) => ({ url: postOf(id)?.url ?? null, creator: untrustedOrNull(postOf(id)?.creator), note: untrustedOrNull(m.notes[k]) })),
      fromPost: untrustedOrNull(postOf(m.postIds[0]!)?.summary),
    }));
    // The routine posts, as they came in: each its reading and its kept, offered moves in the post's order.
    const byPost = new Map<string, string[]>();
    for (const l of inPostOrder(batch.links)) {
      if (postOf(l.postId)?.kind !== "routine") continue;
      const id = find(l.moveId)?.id;
      if (!id) continue;
      const order = byPost.get(l.postId);
      if (order) order.push(id);
      else byPost.set(l.postId, [id]);
    }
    const routines = [...byPost].map(([postId, order]) => ({ post: untrustedOrNull(postOf(postId)?.summary), order }));
    // What the kept posts say about when, why or how often (a model's reading): on every page, room kept for them first.
    const insights = batch.insights.map((i) => untrusted(i.text));

    const head = { id: batch.id, savedAt: localDateOf(athlete.tz, batch.savedAt) };
    const fixed = [
      ...athlete.missing,
      ...(archived.length > 0 ? [`${plural(archived.length, "move")} of this batch archived since, not offered: ${archived.join(", ")}`] : []),
      ...(unread > 0 ? [`${plural(unread, "move")} of this batch no longer in the library`] : []),
      ...(moves.length === 0 ? ["the batch holds no move the athlete kept and the library offers"] : []),
    ];
    /** The moves after this page: how many, and the offset that reads them. */
    const movesLeft = (kept: number): string[] => {
      const left = moves.length - (offset + kept);
      return left > 0 ? [`${plural(left, "more move", "more moves")} — pass offset: ${offset + kept}`] : [];
    };
    /** The routines left out: by the cap when it alone cut them, else for room. */
    const routinesLeft = (kept: number): string[] => {
      const left = routines.length - kept;
      if (left <= 0) return [];
      return kept === Math.min(routines.length, ROUTINES_MAX)
        ? [`${plural(left, "more routine", "more routines")}, at most ${ROUTINES_MAX} a read`]
        : [`${plural(left, "more routine", "more routines")} not shown for room`];
    };
    const sizeOf = (missing: string[], ms: unknown[], rs: unknown[]): number =>
      bytesOf(answer({ source: SOURCE, now: ctx.now, missing, data: { batch: head, moves: ms, routines: rs, insights }, summary: "" }));

    // A page that fits: every listed move and routine (up to the cap) when they fit with the lines that say what is
    // left; else as many moves as fit (at least one), then routines, with room kept for the longest such lines.
    const capped = routines.slice(0, ROUTINES_MAX);
    let kept = listed.length;
    let keptRoutines = capped.length;
    if (sizeOf([...fixed, ...movesLeft(kept), ...routinesLeft(keptRoutines)], listed, capped) > RESULT_BUDGET_BYTES) {
      const longestLeft = [`${moves.length} more moves — pass offset: ${moves.length}`, `${routines.length} more routines not shown for room`];
      let total = sizeOf([...fixed, ...longestLeft], [], []);
      kept = 0;
      for (const item of listed) {
        const add = bytesOf(item) + (kept > 0 ? 1 : 0);
        if (kept > 0 && total + add > RESULT_BUDGET_BYTES) break;
        total += add;
        kept += 1;
      }
      keptRoutines = 0;
      for (const item of capped) {
        const add = bytesOf(item) + (keptRoutines > 0 ? 1 : 0);
        if (total + add > RESULT_BUDGET_BYTES) break;
        total += add;
        keptRoutines += 1;
      }
    }
    const missing = [...fixed, ...movesLeft(kept), ...routinesLeft(keptRoutines)];
    const shown = listed.slice(0, kept);
    const fresh = shown.filter((m) => m.new).length;
    const when = head.savedAt ? ` (saved ${dayLabel(head.savedAt)})` : "";
    return answer({
      source: SOURCE,
      now: ctx.now,
      missing,
      data: { batch: head, moves: shown, routines: routines.slice(0, keptRoutines), insights },
      summary: shown.length ? `Read ${plural(shown.length, "move")} from your saves, ${fresh} new${when}` : `Nothing to fit in from your saves${when}`,
    });
  },
};
