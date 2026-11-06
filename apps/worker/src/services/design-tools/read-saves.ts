/**
 * read_saves — what came in from the athlete's saves (saved-posts import, Task 17). Task 16's opening brings a released
 * batch with "Fit these in", which saves it and asks the coach to fit its new moves in; this is how the coach sees them.
 *
 * THE BATCH: the saved batch `batchId` names, whatever its age or fit — else the one the run fits
 * (`ctx.run.savesBatchId`, the saves flow §12.1: "Fit them in" tells the run its batch), whatever its age too (§8.2) —
 * else the newest the athlete saved in the last SAVES_WINDOW_DAYS that nothing has fitted in yet (`fitted_at` null).
 * Its moves come from the links the owner kept (`saved`; a removed one never), each move once, new ones first and then
 * in the order the posts showed them:
 *  - `name`, `summary`: a personal move's are a model's reading of a creator's post (or the owner's edit of it), marked;
 *    a library move's are the library's own words;
 *  - `new`: the batch brought it (`personal_moves.batch_id`, not merged since); else the athlete had it already;
 *  - `choice` (§3.4): what the athlete chose for a new move before the fit (`personal_moves.fit_choice`) — `include`
 *    (pin it, always) or `skip` (never placed) — else `coach`, the coach's call; a move they had already is `coach`;
 *  - `like` (§12.4): the move a near-duplicate is like (`saved_post_moves.like_move_id`), as the account's library
 *    offers it — its id and name, a personal move's marked — or null;
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
 * THE EVIDENCE (import trail phase 3; design 2026-11-05 §8.1). Each move of the page carries `n` (its place in the batch:
 * its quotes' ids are `q<n>.<k>`, saves-evidence.ts), the dose its record runs with and where that came from, and the
 * corrections so far; each link its post's id and the move's position in it (`post`, `at`: correct_import's targets),
 * the match (new, yours or the library's; by name, the judge or new, with the match step's confidence and check), and
 * the post's reading as evidence — stated or inferred, the post's dose words, why, when to use it or not, and each
 * quote with its id and how it checked out (said, in the caption, heard, on screen, not in the post). Insights keep
 * their post (`ref`) and scope, every scope. The answer's receipt (never the model's) maps each move shown to its first
 * post and each quote id to where it points: pin_moves and correct_import read it from the run's trail.
 *
 * COST. Three statements: the athlete (the step's shared read, which carries the account's library: `athleteOf`), the
 * batch with the account's pins, and the page's evidence (none when the batch offers no move). `savesBatchSql` and `savedMovesOf` are the opening context's too (design-context.ts,
 * "From the athlete's saves"), so the two say the same moves.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { dayLabel } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { isPersonalId, moveGroup, type FitChoice } from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";
import { loadAccountLibrary, type AccountLibrary } from "../account-library.js";
import { doseOriginOf } from "../personal-records.js";
import { insightsJsonSql, scopedInsightsOf, type ScopedInsight } from "../saves-batches.js";
import { doseWords, readingEvidence, valueWords, type QuoteRef, type ReadingEvidence } from "../saves-evidence.js";
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
  /** The owner's fit choice for the move (`personal_moves.fit_choice`): null on the coach's call, or a library move's. */
  fitChoice: FitChoice | null;
  /** The move this link's move is like, flagged a near-duplicate (`saved_post_moves.like_move_id`); else null. */
  likeId: string | null;
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
  /** The first SAVES_INSIGHTS_MAX insights of its kept posts, in the posts' order (saves-batches.ts `scopedInsightsOf`):
   * every scope with `posts` (read_saves'), the general ones only without (the opening context's). */
  insights: ScopedInsight[];
}

/** Who decides whether a move of the batch joins (the saves flow, §3.4): the athlete (include, skip), or the coach. */
export type SavedChoice = FitChoice | "coach";

/** A move of the batch: its record in the account's library, whether the batch brought it, the posts showing it in order. */
export interface SavedMove {
  record: ExerciseRecord;
  new: boolean;
  /** The athlete's choice for a new move; `coach` with none, and for a move the athlete had already. */
  choice: SavedChoice;
  /** The move it is like (a near-duplicate, §12.4) as the library offers it; null with none, or one not offered. */
  like: ExerciseRecord | null;
  postIds: string[];
  /** Each post's note on the move (its first link's), beside `postIds`: null with none or unread. */
  notes: Array<string | null>;
  /** The move's position in each post (its first link's), beside `postIds`. */
  positions: number[];
}

/**
 * The batch as ONE JSON value — a scalar subquery, so it rides in a statement that reads something else (the opening
 * context's counts): `{ id, savedAt, links: [[moveId, postId, position, born, seen, fitChoice, likeId]], posts? }`, or
 * null with no batch.
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
          coalesce(sv_m.batch_id = sv_b.id and sv_m.status != 'merged', 0), coalesce(sv_p.first_seen_at, ''), sv_m.fit_choice, sv_l.like_move_id${note}))
        from saved_post_moves sv_l
        left join saved_posts sv_p on sv_p.user_id = sv_l.user_id and sv_p.id = sv_l.post_id
        left join personal_moves sv_m on sv_m.user_id = sv_l.user_id and sv_m.id = sv_l.move_id
        where sv_l.user_id = ${userId} and sv_l.batch_id = sv_b.id and sv_l.status = 'saved')),
      'insights', json(${insightsJsonSql(userId, keptPosts, SAVES_INSIGHTS_MAX, { scoped: !!o.posts })})${posts})
    from save_batches sv_b where sv_b.user_id = ${userId} and sv_b.status = 'saved' and ${which}
    order by sv_b.saved_at desc, sv_b.id desc limit 1)`;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `savesBatchSql`'s value, read; null with no batch (or one that doesn't read). */
export function savedBatchOf(raw: unknown): SavedBatch | null {
  const b = parsedJson(raw) as { id?: unknown; savedAt?: unknown; links?: unknown; posts?: unknown; insights?: unknown } | null;
  if (!b || typeof b !== "object" || typeof b.id !== "string" || typeof b.savedAt !== "string" || !Number.isFinite(Date.parse(b.savedAt))) return null;
  const links = parsedArray(b.links).flatMap((x): SavedLink[] => {
    const [moveId, postId, position, born, seen, fit, like, note] = Array.isArray(x) ? (x as unknown[]) : [];
    return typeof moveId === "string" && typeof postId === "string" && typeof position === "number"
      ? [
          {
            moveId, postId, position, born: born === 1 || born === true, seen: str(seen) ?? "",
            fitChoice: fit === "include" || fit === "skip" ? fit : null, likeId: str(like), note: str(note),
          },
        ]
      : [];
  });
  const posts = new Map(
    parsedArray(b.posts).flatMap((x): Array<[string, SavedPost]> => {
      const [id, url, creator, kind, summary] = Array.isArray(x) ? (x as unknown[]) : [];
      return typeof id === "string" ? [[id, { url: str(url), creator: str(creator), kind: str(kind), summary: str(summary) }]] : [];
    }),
  );
  return { id: b.id, savedAt: b.savedAt, links, posts, insights: scopedInsightsOf(b.insights).slice(0, SAVES_INSIGHTS_MAX) };
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
 * target) — new ones first, then in the order the posts showed them; each with the athlete's choice (a new move's own,
 * else the coach's call) and the move it is like (its first link's that names one the library offers, never itself —
 * resolved here, at no cost). `archived`: the moves left out because the library no longer offers them (archived
 * since, or merged into an archived move), by id; `unread`: how many it no longer holds at all. `find` resolves a link
 * the same way (for a routine's order).
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
    if (!move) byId.set(record.id, (move = { record, new: false, choice: "coach", like: null, postIds: [], notes: [], positions: [] }));
    if (l.born) {
      move.new = true;
      // The athlete chose for the batch's own new moves alone: a move they had already stays the coach's call.
      if (l.fitChoice) move.choice = l.fitChoice;
    }
    if (!move.like && l.likeId) {
      const like = resolve.find(l.likeId);
      if (like && like.id !== record.id) move.like = like;
    }
    if (!move.postIds.includes(l.postId)) {
      move.postIds.push(l.postId);
      move.notes.push(l.note ?? null);
      move.positions.push(l.position);
    }
  }
  // New first; each part in the posts' order (the sort is stable).
  const moves = [...byId.values()].sort((a, b) => Number(b.new) - Number(a.new));
  return { moves, archived: [...archived], unread: unread.size, find: resolve.find };
}

/** A move's words: a personal move's, marked (a model's reading of a post, or the owner's edit); the library's, as they are. */
const wordsOf = (record: ExerciseRecord, text: string): string | Untrusted => (isPersonalId(record.id) ? untrusted(text) : text);

const bytesOf = (value: unknown): number => utf8Bytes(JSON.stringify(value));

// ── The page's evidence (import trail phase 3; design 2026-11-05 §8.1) ──────────────────────────────────────────────

/** One link of the page as its evidence read gives it: the post's reading of the move (the fields the coach weighs and
 * the dose's origin needs), the link's check flag, and its post's latest match step's word on that position. */
interface LinkEvidence {
  check: boolean;
  reading: unknown;
  by: string | null;
  confidence: string | null;
}

/** A correction so far (`import_corrections`), as the read gives it. */
interface CorrectionRow {
  targetId: string;
  field: string;
  after: unknown;
  why: string;
  by: string;
  basis: string;
  at: string;
}

/** A move's or a link's corrections, newest first, at most. */
const CORRECTIONS_SHOWN = 3;
/** How many corrections the read reads for a page at most (newest first): room for three a move. */
const CORRECTIONS_READ = 60;

/**
 * The page's evidence, ONE statement: each link of the page (`pairs`: post id and position, as JSON) with its post's
 * reading of the move — only the fields the coach weighs — its check flag and its post's latest match step's entry for
 * that position; and the corrections of the page's moves (`moveIds`) and of its links' readings and matches, newest
 * first. Its tables go by their own aliases.
 */
function pageEvidenceSql(userId: string, pairs: ReadonlyArray<readonly [string, number]>, moveIds: readonly string[]): SQL {
  const f = (k: string) => sql.raw(`json_extract(case when json_valid(ev_p.extraction) then ev_p.extraction end, '$.moves[' || ev_l.position || '].${k}')`);
  const pairsJson = JSON.stringify(pairs);
  return sql`select
    (select json_group_array(json_array(ev_l.post_id, ev_l.position, ev_l.check_flag,
        json_object('evidence', json(${f("evidence")}), 'confidence', ${f("confidence")}, 'dose', json(${f("dose")}), 'why', ${f("why")},
          'useWhen', json(${f("useWhen")}), 'skipWhen', json(${f("skipWhen")}), 'quotes', json(${f("quotes")}),
          'load', ${f("load")}, 'patterns', json(${f("patterns")}), 'contraction', json(${f("contraction")})),
        json((select json_array(json_extract(ev_m.value, '$.by'), json_extract(ev_m.value, '$.confidence'))
          from json_each((select ev_e.detail from import_events ev_e where ev_e.user_id = ${userId} and ev_e.post_id = ev_l.post_id
              and ev_e.stage = 'match' and json_valid(ev_e.detail) order by ev_e.at desc, ev_e.rowid desc limit 1), '$.moves') ev_m
          where json_extract(ev_m.value, '$.position') = ev_l.position limit 1))))
      from json_each(${pairsJson}) ev_j
      join saved_post_moves ev_l on ev_l.user_id = ${userId} and ev_l.post_id = json_extract(ev_j.value, '$[0]') and ev_l.position = json_extract(ev_j.value, '$[1]')
      join saved_posts ev_p on ev_p.user_id = ev_l.user_id and ev_p.id = ev_l.post_id) as links,
    (select json_group_array(json_array(ev_c.target_id, ev_c.field, case when json_valid(ev_c.after) then json(ev_c.after) end, ev_c.why, ev_c.by, ev_c.basis, ev_c.at)) from (
      select * from import_corrections ev_c0 where ev_c0.user_id = ${userId}
        and ((ev_c0.target = 'move' and ev_c0.target_id in (select value from json_each(${JSON.stringify(moveIds)})))
          or (ev_c0.target in ('reading', 'link') and ev_c0.target_id in (select json_extract(value, '$[0]') || ':' || json_extract(value, '$[1]') from json_each(${pairsJson}))))
        order by ev_c0.at desc, ev_c0.id desc limit ${CORRECTIONS_READ}) ev_c) as corrections`;
}

/** `pageEvidenceSql`'s links, by `<postId>:<position>`. */
function linkEvidenceOf(raw: unknown): Map<string, LinkEvidence> {
  const out = new Map<string, LinkEvidence>();
  for (const x of parsedArray(raw)) {
    const [postId, position, check, reading, matched] = Array.isArray(x) ? (x as unknown[]) : [];
    if (typeof postId !== "string" || typeof position !== "number") continue;
    const [by, confidence] = Array.isArray(matched) ? (matched as unknown[]) : [];
    out.set(`${postId}:${position}`, { check: check === 1 || check === true, reading, by: str(by), confidence: str(confidence) });
  }
  return out;
}

/** `pageEvidenceSql`'s corrections, by their target's id, newest first. */
function correctionsOf(raw: unknown): Map<string, CorrectionRow[]> {
  const out = new Map<string, CorrectionRow[]>();
  for (const x of parsedArray(raw)) {
    const [targetId, field, after, why, by, basis, at] = Array.isArray(x) ? (x as unknown[]) : [];
    if (typeof targetId !== "string" || typeof field !== "string" || typeof why !== "string") continue;
    const list = out.get(targetId) ?? [];
    list.push({ targetId, field, after, why, by: str(by) ?? "coach", basis: str(basis) ?? "evidence", at: str(at) ?? "" });
    out.set(targetId, list);
  }
  for (const list of out.values()) list.sort((a, b) => byBytes(b.at, a.at));
  return out;
}

/** Where a record's dose came from (§8.1): the library's; a correction's (the owner's edit or an approved fix); for a move
 * the batch brought, its first post's reading (`doseOriginOf`: the reading's range, the post's words, or a default);
 * else an earlier post's. */
type DoseFrom = "post" | "reading" | "default" | "library" | "edited" | "an earlier post";
function doseFromOf(m: SavedMove, fixes: readonly CorrectionRow[], firstReading: unknown): DoseFrom {
  if (!isPersonalId(m.record.id)) return "library";
  if (fixes.some((c) => c.field === "dose")) return "edited";
  if (!m.new || !firstReading || typeof firstReading !== "object") return "an earlier post";
  const r = firstReading as Record<string, unknown>;
  const dose = r.dose && typeof r.dose === "object" ? (r.dose as Record<string, unknown>) : {};
  try {
    return doseOriginOf({
      ...r,
      dose: { ...dose, text: typeof dose.text === "string" ? dose.text : "" },
      patterns: Array.isArray(r.patterns) ? r.patterns : [],
      contraction: Array.isArray(r.contraction) ? r.contraction : [],
    } as unknown as Parameters<typeof doseOriginOf>[0]);
  } catch {
    return "an earlier post";
  }
}

/** A correction as the coach reads it: the field, the value it took (in words, marked), why, by whom, on what basis. */
const correctionOut = (c: CorrectionRow, target?: string) => ({
  ...(target ? { target } : {}),
  field: c.field,
  after: untrusted(valueWords(c.after)),
  why: untrusted(c.why),
  by: c.by,
  basis: c.basis,
  at: c.at,
});

/** How the coach closes the batch it read (coach-context audit I2): a pins card naming it, approved, marks it fitted in. */
const closeLine = (batchId: string): string => `pin_moves({ batchId: ${JSON.stringify(batchId)} }) closes this batch once approved — with the moves you pin, or none`;

const input = z
  .object({ batchId: z.string().min(1).max(100).optional(), limit: limitField(SAVES_MOVES_MAX).optional(), offset: z.number().int().min(0).max(10_000).optional() })
  .strict();

export const readSaves: DesignTool = {
  name: "read_saves",
  description:
    "The athlete's saves: the run's batch, else the newest unfitted (or batchId's). Each move — a saved one by its own id — new or theirs, choice, pin, dose; its posts' notes and evidence (quote ids to cite); corrections; insights; routines.",
  inputSchema: {
    type: "object",
    properties: {
      batchId: { type: "string", description: "A saved batch's id; default the run's batch, else the newest not yet fitted in." },
      limit: { type: "integer", minimum: 1, maximum: SAVES_MOVES_MAX, description: `Default ${SAVES_MOVES_MAX}, the most.` },
      offset: { type: "integer", minimum: 0, description: "Moves to skip: the offset missing gives." },
    },
    additionalProperties: false,
  },
  // REBASED 2026-11-06 (coach review, phase 3): the page's evidence is one statement more (§8.1).
  statementCost: 3,
  // Measured (design-cpu-bench.test.ts 8.read_saves: 40 posts, 120 links, 36 moves): 0.97–1.09 ms scaled p50 on a loaded
  // runner (Task 17). Re-measured on a quiet tree (the fix wave, 2026-10-25; 1-minute load 1.9–2.1 on 8 cores, scale
  // ×0.93–×1.07): 0.54, 0.49 and 0.47 ms scaled p50 — declared at the highest, rounded up to the tenth, as its peers are.
  // REBASED 2026-11-06 (coach review, phase 3): the page's evidence — twelve moves' readings at extract-6's widest (eight
  // 200-character quotes, four use-when and skip-when cases, a why), parsed and fitted — measured 1.22 ms scaled p50
  // (calibration ×0.93, 1-minute load 10.7 on 8 cores); declared at the tenth above.
  cpuWeight: 1.3,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally batchId, limit and offset");
    if (isErr(p)) return p;
    const limit = p.limit ?? SAVES_MOVES_MAX;
    // A fit-in run reads the batch it fits (§12.1), whatever its age (§8.2), unless the model names another.
    const batchId = p.batchId ?? ctx.run.savesBatchId;
    const [athlete, rows] = await Promise.all([
      athleteOf(ctx),
      ctx.db.all(sql`select ${savesBatchSql(ctx.userId, { now: ctx.now, batchId, posts: true })} as batch,
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
          ctx.run.savesBatchId ? "Leave batchId out to read the batch this run fits in." : "Leave batchId out to read the newest saved batch not yet fitted in.",
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

    // This page's moves, in the batch's one order — and their evidence (§8.1): one statement, for the candidate page
    // only (the byte fit below may keep fewer).
    const page = moves.slice(offset, offset + limit);
    const linksOf = (m: SavedMove) => m.postIds.slice(0, LINKS_MAX).map((id, k) => [id, m.positions[k]!] as const);
    const ev = page.length
      ? (((await ctx.db.all(pageEvidenceSql(ctx.userId, page.flatMap(linksOf), page.map((m) => m.record.id)))) as Array<{ links: unknown; corrections: unknown }>)[0] ?? null)
      : null;
    const evidence = linkEvidenceOf(ev?.links);
    const fixesOf = correctionsOf(ev?.corrections);
    const read = page.map((m, i) => {
      // The move's place in the batch: its quotes' ids (`q<n>.<k>`), the same on every page.
      const n = offset + i + 1;
      const refs: Array<[string, QuoteRef]> = [];
      const readings: Array<ReadingEvidence | null> = [];
      let firstReading: unknown = null;
      for (const [j, [postId, position]] of linksOf(m).entries()) {
        const e = evidence.get(`${postId}:${position}`);
        if (j === 0) firstReading = e?.reading ?? null;
        const r = e ? readingEvidence(e.reading, { moveNo: n, firstK: refs.length + 1, postId, position }) : null;
        if (r) refs.push(...r.refs);
        readings.push(r?.evidence ?? null);
      }
      const own = fixesOf.get(m.record.id) ?? [];
      const onLinks = linksOf(m).flatMap(([postId, position]) => fixesOf.get(`${postId}:${position}`) ?? []);
      const fixes = [...own.map((c) => correctionOut(c)), ...onLinks.map((c) => correctionOut(c, "reading"))]
        .sort((a, b) => byBytes(b.at, a.at))
        .slice(0, CORRECTIONS_SHOWN);
      const as = !isPersonalId(m.record.id) ? "library" : m.new ? "new" : "yours";
      const entry = {
        id: m.record.id,
        n,
        name: wordsOf(m.record, m.record.name),
        summary: wordsOf(m.record, m.record.text?.summary ?? ""),
        new: m.new,
        choice: m.choice,
        like: m.like ? { id: m.like.id, name: wordsOf(m.like, m.like.name) } : null,
        pinned: pins.has(m.record.id),
        groups: moveGroup(m.record),
        // The dose the move runs with (its record's), and where that came from.
        dose: { record: doseWords(m.record.dose), from: doseFromOf(m, own, firstReading) },
        ...(fixes.length ? { corrections: fixes } : {}),
        posts: m.postIds.length,
        links: linksOf(m).map(([postId, position], k) => {
          const e = evidence.get(`${postId}:${position}`);
          return {
            url: postOf(postId)?.url ?? null,
            creator: untrustedOrNull(postOf(postId)?.creator),
            note: untrustedOrNull(m.notes[k]),
            post: postId,
            at: position,
            // What the match step said, when its trail has it (a post from before the trail has none).
            match: { as, ...(e?.by ? { by: e.by } : {}), ...(e?.confidence ? { confidence: e.confidence } : {}), ...(e?.check ? { check: true } : {}) },
            reading: readings[k] ?? null,
          };
        }),
        fromPost: untrustedOrNull(postOf(m.postIds[0]!)?.summary),
      };
      return { entry, refs, first: [m.record.id, m.postIds[0]!, m.positions[0]!] as const };
    });
    const listed = read.map((x) => x.entry);
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
    // Every scope, each keeping its post (§8.1: a creator's own split is the creator's, not a rule): `ref` names the post
    // and the insight's place in it, as correct_import's target does.
    const insights = batch.insights.map((i) => ({ ref: `${i.postId}:${i.idx}`, text: untrusted(i.text), scope: i.scope, ...(i.quote ? { quote: untrusted(i.quote) } : {}) }));

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
      bytesOf(answer({ source: SOURCE, now: ctx.now, missing, data: { batch: head, moves: ms, routines: rs, insights, next: closeLine(batch.id) }, summary: "" }));

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
    // What the run read, for pin_moves and correct_import (never shown to the model): each move shown, its first post,
    // and each quote id with where it points.
    const keptRead = read.slice(0, kept);
    const receipt = {
      saves: {
        batch: batch.id,
        moves: keptRead.map((x) => [...x.first]),
        posts: [...new Set(shown.flatMap((m) => m.links.map((l) => l.post)))],
        quotes: Object.fromEntries(keptRead.flatMap((x) => x.refs).map(([id, r]) => [id, [r.postId, r.position, r.quote, r.check, r.from, r.at]])),
      },
    };
    return {
      ...answer({
        source: SOURCE,
        now: ctx.now,
        missing,
        data: { batch: head, moves: shown, routines: routines.slice(0, keptRoutines), insights, next: closeLine(batch.id) },
        summary: shown.length ? `Read ${plural(shown.length, "move")} from your saves, ${fresh} new${when}` : `Nothing to fit in from your saves${when}`,
      }),
      receipt,
    };
  },
};
