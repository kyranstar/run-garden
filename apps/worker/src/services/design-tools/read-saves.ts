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
 *    offers it — its id and name, a personal move's marked — else left out;
 *  - `pinned` (`exercise_prefs.pinned`, when it is) and `groups` (the notice's grouping: @rg/saves `moveGroup`);
 *  - `posts`: how many of the batch's posts show it; `links`: the first LINKS_MAX of them, each by its post's id, and
 *    the first's note (spec §17: what the post says the move is for, or when to do it — the post's reading of it,
 *    `purpose`: marked).
 * And the page's `posts`, each once: its url (plain: an address, not prose), its creator (the handle, else the name:
 * marked), its reading (`extraction.summary`: marked) and, a routine's, its moves in the post's order by their place in
 * the batch (`order`). And `insights` (at most SAVES_INSIGHTS_MAX, spec §17): what the batch's kept posts say about when, why
 * or how often to do something, in the posts' order (marked) — Save kept them in the coach's memory too. A move merged
 * since reads as the move it went into (the account's library, Task 12); a move the library no longer offers —
 * archived since, or merged into an archived move — is left out of both and named in `missing` (an archived move is
 * resolvable but never offered).
 *
 * Nothing to read — no such batch — is an answer that says so (`missing`), never an error. A batchId that is not a saved
 * batch of the athlete's — another account's, one not saved, one nobody has — is refused alike (`not_found`), so nothing
 * says another account's batch exists.
 *
 * SIZE (the budgets review, 2026-11-06). At most SAVES_MOVES_MAX moves a read (`limit`), from `offset` in the batch's one
 * order, and of those as many as fit RESULT_BUDGET_BYTES with the posts they name; `missing` says how many moves are left
 * and the offset that reads them (a batch stays readable by id once it is fitted in). A page is COMPACT unless `full`:
 * each post the page's moves name is in `posts` once — its address, creator and reading (a head), and a routine's moves
 * in the post's order by their `n` — never on each link; a move's summary, its first post's why and use-when cases are
 * the full form's; its first post's reading keeps what it stated and inferred, the post's dose words, the skip-when cases
 * the post stated (heads) and each quote as `[id, field, check, head]`; its later posts' readings their quotes'
 * `[id, field, check]` alone. A lone move too wide even so reads TIGHT — every post's quotes by id, its words cut to
 * heads — so one move never passes the budget (the widest: three posts at extract-6's widest, five quoted insights).
 * The insights are on the first page only; the line on closing the batch (`next`) on its last. `full: true` gives every
 * word (each quote whole, why, use and skip when, every post's whole reading, the move's summary) and no insights —
 * one move at a time is the way to read one whole (`offset: n − 1, limit: 1`).
 *
 * THE EVIDENCE (import trail phase 3; design 2026-11-05 §8.1). Each move of the page carries `n` (its place in the batch:
 * its quotes' ids are `q<n>.<k>`, saves-evidence.ts), the dose its record runs with and where that came from, and the
 * corrections so far; each link its post's id and the move's position in it (`post`, `at`: correct_import's targets),
 * the match step's word (by name, the judge or new, its confidence and check) when its trail has one, and the post's
 * reading as evidence — stated or inferred, the post's dose words, and each quote with its id and how it checked out
 * (said, in the caption, heard, on screen, not in the post). Insights keep their post (`ref`) and scope, every scope.
 * The answer's receipt (never the model's) maps each move shown to its first post, its `n` and the fields its posts
 * stated, names the posts read (its moves' and its insights'), and each quote id sent to where it points: pin_moves and
 * correct_import read it from the run's trail.
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
import { compactEvidence, doseWords, headOf, QUOTE_HEAD, readingEvidence, valueWords, type QuoteRef, type ReadingEvidence } from "../saves-evidence.js";
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
/** A page's forms (the budgets review, 2026-11-06): every word (`full: true`); compact, a page's default; tight, a lone
 * move too wide for its page in the compact form. */
type Form = "full" | "compact" | "tight";
/** A link's note and a correction's words in the compact form: their heads. */
const SUMMARY_HEAD = 100;
const NOTE_HEAD = 100;
/** A post's reading in the compact and tight forms: its head. */
const POST_HEAD = 100;
/** The tight form's heads. */
const TIGHT_HEAD = 60;
/** Where a later page's insights are. */
const INSIGHTS_FIRST = "insights: on the first page (offset 0, not full)";
/** How a compact page's move reads whole. */
const FULL_WORDS = "a move's every word (whole quotes, why, use and skip when): full: true, offset: its n − 1, limit: 1";
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
  const doc = "case when json_valid(ev_p.extraction) then ev_p.extraction end";
  const path = (k: string) => `'$.moves[' || ev_l.position || '].${k}'`;
  const f = (k: string) => sql.raw(`json_extract(${doc}, ${path(k)})`);
  // A field that should be a list or an object, only when it is one (the controller's fix pass, D12): one malformed
  // stored reading reads as no evidence, never failing the page.
  const j = (k: string) => sql.raw(`(case when json_type(${doc}, ${path(k)}) in ('object', 'array') then json(json_extract(${doc}, ${path(k)})) end)`);
  const pairsJson = JSON.stringify(pairs);
  return sql`select
    (select json_group_array(json_array(ev_l.post_id, ev_l.position, ev_l.check_flag,
        json_object('evidence', ${j("evidence")}, 'confidence', ${f("confidence")}, 'dose', ${j("dose")}, 'why', ${f("why")},
          'useWhen', ${j("useWhen")}, 'skipWhen', ${j("skipWhen")}, 'quotes', ${j("quotes")},
          'load', ${f("load")}, 'patterns', ${j("patterns")}, 'contraction', ${j("contraction")}),
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
const correctionOut = (c: CorrectionRow, form: Form, target?: string) => ({
  ...(target ? { target } : {}),
  field: c.field,
  after: untrusted(form === "full" ? valueWords(c.after) : headOf(valueWords(c.after), form === "tight" ? TIGHT_HEAD : SUMMARY_HEAD)),
  why: untrusted(form === "full" ? c.why : headOf(c.why, form === "tight" ? TIGHT_HEAD : SUMMARY_HEAD)),
  by: c.by,
  basis: c.basis,
  at: c.at,
});

/** How the coach closes the batch it read (coach-context audit I2): a pins card naming it, approved, marks it fitted in. */
const closeLine = (batchId: string): string => `pin_moves({ batchId: ${JSON.stringify(batchId)} }) closes this batch once approved — with the moves you pin, or none`;

const input = z
  .object({
    batchId: z.string().min(1).max(100).optional(),
    limit: limitField(SAVES_MOVES_MAX).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
    full: z.boolean().optional(),
  })
  .strict();

export const readSaves: DesignTool = {
  name: "read_saves",
  description:
    "The athlete's saves: the run's batch, else the newest unfitted (or batchId's). Each move — a saved one by its own id — new or theirs, choice, pin, dose, notes, evidence (quote ids to cite), corrections; the posts; insights on page one.",
  inputSchema: {
    type: "object",
    properties: {
      batchId: { type: "string", description: "A saved batch's id; default the run's batch, else the newest not yet fitted in." },
      limit: { type: "integer", minimum: 1, maximum: SAVES_MOVES_MAX, description: `Default ${SAVES_MOVES_MAX}, the most.` },
      offset: { type: "integer", minimum: 0, description: "Moves to skip: the offset missing gives." },
      full: { type: "boolean", description: "Every word: each quote whole, why, use-when, skip-when, every post's reading — fewer moves a page, no insights." },
    },
    additionalProperties: false,
  },
  // REBASED 2026-11-06 (coach review, phase 3): the page's evidence is one statement more (§8.1).
  statementCost: 3,
  // Measured (design-cpu-bench.test.ts 8.read_saves: 40 posts, 120 links, 36 moves): 0.97–1.09 ms scaled p50 on a loaded
  // runner (Task 17). Re-measured on a quiet tree (the fix wave, 2026-10-25; 1-minute load 1.9–2.1 on 8 cores, scale
  // ×0.93–×1.07): 0.54, 0.49 and 0.47 ms scaled p50 — declared at the highest, rounded up to the tenth, as its peers are.
  // REBASED 2026-11-06 (coach review, phase 3): the page's evidence — twelve moves' readings at extract-6's widest (eight
  // 200-character quotes, four use-when and skip-when cases, a why), parsed and fitted — measured 1.22 and 1.37 ms scaled
  // p50 on two loaded passes (×0.93 at load 10.7; ×0.78 at load 24.7, 8 cores; no quiet run to be had): declared at the
  // tenth above the higher.
  cpuWeight: 1.4,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally batchId, limit, offset and full");
    if (isErr(p)) return p;
    const limit = p.limit ?? SAVES_MOVES_MAX;
    const full = p.full === true;
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
    // Each move's place in the batch (`n`): its quotes' ids are `q<n>.<k>`, and a routine names its moves by it.
    const nOf = new Map(moves.map((m, i) => [m.record.id, i + 1] as const));
    // Each candidate's evidence, made when the page comes to it (the page often stops well before the last).
    const readOf = (m: SavedMove, i: number) => {
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
      const fixes = [...own.map((c) => ({ c, target: undefined as string | undefined })), ...onLinks.map((c) => ({ c, target: "reading" as string | undefined }))].sort((a, b) => byBytes(b.c.at, a.c.at)).slice(0, CORRECTIONS_SHOWN);
      /** The move's entry in a form (the budgets review, 2026-11-06): `full` — every word; `compact` — its first post's
       * reading with quote heads, its later posts' quotes by id and check; `tight` (a lone move too wide for its page) —
       * every post's quotes by id and check, its words cut to heads. */
      const entryOf = (form: Form) => {
        const cut = (text: string | null | undefined, n: number): Untrusted | null => (form === "full" ? untrustedOrNull(text) : untrustedOrNull(text ? headOf(text, n) : text));
        const summary = m.record.text?.summary ?? "";
        return {
          id: m.record.id,
          n,
          name: wordsOf(m.record, m.record.name),
          // What the move is: the full form's (the name, its post's note and its quotes say it on a compact page).
          ...(form === "full" ? { summary: wordsOf(m.record, summary) } : {}),
          new: m.new,
          choice: m.choice,
          // Each only when it is so (the budgets review, 2026-11-06): no like, not pinned.
          ...(m.like ? { like: { id: m.like.id, name: wordsOf(m.like, m.like.name) } } : {}),
          ...(pins.has(m.record.id) ? { pinned: true } : {}),
          groups: moveGroup(m.record),
          // The dose the move runs with (its record's), and where that came from.
          dose: { record: doseWords(m.record.dose), from: doseFromOf(m, own, firstReading) },
          ...(fixes.length ? { corrections: (form === "tight" ? fixes.slice(0, 1) : fixes).map((f) => correctionOut(f.c, form, f.target)) } : {}),
          posts: m.postIds.length,
          links: linksOf(m).map(([postId, position], k) => {
            const e = evidence.get(`${postId}:${position}`);
            const r = readings[k] ?? null;
            // What the match step said, when its trail has it (a post from before the trail has none).
            // How it matched is its id's and `new`'s (library, new, theirs); `match` is the step's word, when its trail has
            // one (a post from before the trail has none).
            const said = { ...(e?.by ? { by: e.by } : {}), ...(e?.confidence ? { confidence: e.confidence } : {}), ...(e?.check ? { check: true } : {}) };
            const link = { post: postId, at: position, ...(Object.keys(said).length ? { match: said } : {}) };
            if (form === "full") return { ...link, note: untrustedOrNull(m.notes[k]), reading: r };
            if (k > 0) return { ...link, reading: r ? compactEvidence(r, { heads: false }) : null };
            return { ...link, note: cut(m.notes[k], form === "tight" ? TIGHT_HEAD : NOTE_HEAD), reading: r ? compactEvidence(r, { heads: form === "compact" }) : null };
          }),
        };
      };
      // What it stated on the posts read (a stated field may back a claim as the reader's report: stated:<field>).
      const stated = [...new Set(readings.flatMap((r) => r?.stated ?? []))];
      return { entryOf, refs, postIds: linksOf(m).map(([postId]) => postId), first: [m.record.id, m.postIds[0]!, m.positions[0]!, n, stated] as const };
    };
    // The routine posts' moves in the post's order, by their place in the batch (a merged move as the move it went into).
    const orderOf = new Map<string, number[]>();
    for (const l of inPostOrder(batch.links)) {
      if (postOf(l.postId)?.kind !== "routine") continue;
      const n = nOf.get(find(l.moveId)?.id ?? "");
      if (n === undefined) continue;
      const order = orderOf.get(l.postId);
      if (order) order.push(n);
      else orderOf.set(l.postId, [n]);
    }
    /** A post the page's moves name, once a page: its address, its creator and its reading (marked), and a routine's order. */
    const postEntry = (postId: string, form: Form) => {
      const post = postOf(postId);
      const reading = post?.summary ?? null;
      return {
        id: postId,
        url: post?.url ?? null,
        creator: untrustedOrNull(post?.creator),
        reading: untrustedOrNull(form === "full" || !reading ? reading : headOf(reading, POST_HEAD)),
        ...(orderOf.has(postId) ? { order: orderOf.get(postId)! } : {}),
      };
    };
    // What the kept posts say about when, why or how often (a model's reading): on the first page only (the budgets
    // review, 2026-11-06), each a quote's head. Every scope, each keeping its post (§8.1: a creator's own split is the
    // creator's, not a rule): `ref` names the post and the insight's place in it, as correct_import's target does.
    const withInsights = offset === 0 && !full;
    const insights = withInsights
      ? batch.insights.map((i) => ({ ref: `${i.postId}:${i.idx}`, text: untrusted(i.text), scope: i.scope, ...(i.quote ? { quote: untrusted(headOf(i.quote, QUOTE_HEAD)) } : {}) }))
      : [];

    const head = { id: batch.id, savedAt: localDateOf(athlete.tz, batch.savedAt) };
    const fixed = [
      ...athlete.missing,
      ...(archived.length > 0 ? [`${plural(archived.length, "move")} of this batch archived since, not offered: ${archived.join(", ")}`] : []),
      ...(unread > 0 ? [`${plural(unread, "move")} of this batch no longer in the library`] : []),
      ...(moves.length === 0 ? ["the batch holds no move the athlete kept and the library offers"] : []),
      ...(!withInsights && batch.insights.length > 0 ? [INSIGHTS_FIRST] : []),
      ...(!full && page.length > 0 ? [FULL_WORDS] : []),
    ];
    /** The moves after this page: how many, and the offset that reads them. */
    const movesLeft = (kept: number): string[] => {
      const left = moves.length - (offset + kept);
      return left > 0 ? [`${plural(left, "more move", "more moves")} — pass offset: ${offset + kept}`] : [];
    };
    const sizeOf = (missing: string[], ms: unknown[], ps: unknown[]): number =>
      bytesOf(answer({ source: SOURCE, now: ctx.now, missing, data: { batch: head, posts: ps, moves: ms, insights }, summary: "" }));
    /** The last page's line on closing the batch, and what it adds. */
    const next = { next: closeLine(batch.id) };
    const nextBytes = bytesOf(next) - 1;

    // A page that fits: as many moves as fit with the posts they name (each post once), room kept for the line that says
    // what is left — at least one, the lone move in the narrowest form that fits (full asks for every word: compact, then
    // tight, when even one move's every word won't fit).
    let total = sizeOf([...fixed, `${moves.length} more moves — pass offset: ${moves.length}`], [], []);
    type Read = ReturnType<typeof readOf>;
    const shown: Array<ReturnType<Read["entryOf"]>> = [];
    const posts: Array<ReturnType<typeof postEntry>> = [];
    const keptRead: Read[] = [];
    for (const [i, m] of page.entries()) {
      const x = readOf(m, i);
      const forms: Form[] = full ? ["full", "compact", "tight"] : ["compact", "tight"];
      let picked: { entry: (typeof shown)[number]; fresh: Array<(typeof posts)[number]>; add: number } | null = null;
      for (const form of shown.length === 0 ? forms : forms.slice(0, 1)) {
        const entry = x.entryOf(form);
        const fresh = [...new Set(x.postIds)].filter((id) => !posts.some((q) => q.id === id)).map((id) => postEntry(id, form));
        const add = bytesOf(entry) + (shown.length > 0 ? 1 : 0) + fresh.reduce((sum, q, j) => sum + bytesOf(q) + (posts.length + j > 0 ? 1 : 0), 0);
        picked = { entry, fresh, add };
        if (total + add <= RESULT_BUDGET_BYTES) break;
        if (shown.length > 0) picked = null;
      }
      if (!picked) break;
      // The page that reads the batch's last move says how to close it: room for that line too.
      const last = offset + shown.length + 1 >= moves.length;
      if (last && shown.length > 0 && total + picked.add + nextBytes > RESULT_BUDGET_BYTES) break;
      total += picked.add;
      shown.push(picked.entry);
      posts.push(...picked.fresh);
      keptRead.push(x);
    }
    const isLast = offset + shown.length >= moves.length;
    const missing = [...fixed, ...movesLeft(shown.length)];
    const fresh = shown.filter((m) => m.new).length;
    const when = head.savedAt ? ` (saved ${dayLabel(head.savedAt)})` : "";
    // What the run read, for pin_moves and correct_import (never shown to the model): each move shown — its first post,
    // its place in the batch and the fields its posts stated — the posts it read (its moves' and its insights'), and each
    // quote id it was given with where it points (every form gives every quote's id).
    const receipt = {
      saves: {
        batch: batch.id,
        moves: keptRead.map((x) => [...x.first]),
        posts: [...new Set([...shown.flatMap((m) => m.links.map((l) => l.post)), ...batch.insights.filter(() => withInsights).map((i) => i.postId)])],
        quotes: Object.fromEntries(keptRead.flatMap((x) => x.refs).map(([id, r]) => [id, [r.postId, r.position, r.quote, r.check, r.from, r.at]])),
      },
    };
    return {
      ...answer({
        source: SOURCE,
        now: ctx.now,
        missing,
        // How to close the batch: on its last page, once every move is read.
        data: { batch: head, posts, moves: shown, insights, ...(isLast ? next : {}) },
        summary: shown.length ? `Read ${plural(shown.length, "move")} from your saves, ${fresh} new${when}` : `Nothing to fit in from your saves${when}`,
      }),
      receipt,
    };
  },
};
