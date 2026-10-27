/**
 * BATCHES (saved-posts import, Task 8; spec §4 calls 8–9, §6; the saves flow redesigned, 2026-10-26: §5, §12.3,
 * §12.4). Matched posts wait, unbatched, until a check finishes; then `assembleBatch` cuts one batch from them — but
 * only while no batch is open (`openBatchSql`: released or saved, neither fitted in nor dismissed), so the owner's own
 * action is the gate and there is one batch to answer at a time. A batch takes the oldest posts first and at most
 * `BATCH_NEW_MAX` new moves; the rest wait for the next one. While `SAVES_HOLD_BATCHES` is "1" a batch is created
 * `held` (the bootstrap's batches wait for the lead's curation).
 *
 * Nothing in a batch is usable until the owner saves it: its new moves stay `pending` and its links `pending`, and
 * `exercise_provenance` (what the Studio's "from your saves", the engine's bonus and the coach's "saved" read) is
 * written only by `saveBatch`. Both run in a constant number of set-based statements, however big the batch.
 */
import { and, eq, getTableColumns, isNull, sql, type SQL } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, todayInZone } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { batchNotice, nearDuplicateOf, type FitChoice, type NearCandidate, type SaveBatchInsightDto } from "@rg/saves";
import type { Env } from "../env.js";
import { forgetAccountLibrary } from "./account-library.js";
import type { SavesSkip } from "./design-tools/types.js";
import { SAVED_POST_SOURCE } from "./coach-memory.js";
import { runAtomically, runAtomicallyClaim, type Db } from "./db.js";
import { EARLIEST_ZONE, liveMemoryWhere } from "./memory-core.js";
import { loadPersonalForMatch } from "./personal-moves.js";

const { savedPosts, savedPostMoves, personalMoves, saveBatches, exerciseProvenance, coachMemory } = schema;

/** The most new moves one batch brings (spec §5). Moves the owner already has ride along with their posts. */
export const BATCH_NEW_MAX = 12;

/** How long a fit that began reads as still at work (spec §12.1); past it, the batch offers "Fit them in" again. */
export const FIT_STARTED_TTL_MS = 3_600_000;

/** A batch's fit is at work: it began less than `FIT_STARTED_TTL_MS` ago. */
export function isFitting(fitStartedAt: string | null, now: string): boolean {
  return fitStartedAt !== null && Date.parse(now) - Date.parse(fitStartedAt) < FIT_STARTED_TTL_MS;
}

/**
 * An OPEN batch, over `alias` (a `save_batches` alias): released or saved, neither fitted in nor dismissed (spec §4).
 * While an account has one, no other batch of its is cut (`assembleBatch`) or released (`releaseBatch`).
 */
export function openBatchSql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.status in ('released','saved') and ${a}.fitted_at is null and ${a}.dismissed_at is null)`;
}

/** Not fitting at `now` (`isFitting` false), in SQL over a `fit_started_at` column of ISO instants: no fit, or one
 * begun `FIT_STARTED_TTL_MS` or more ago. */
export function notFittingSql(column: SQL, now: string): SQL {
  const stale = new Date(Date.parse(now) - FIT_STARTED_TTL_MS).toISOString();
  return sql`(${column} is null or ${column} <= ${stale})`;
}

/**
 * A fit may start (spec §12.1, §12.3), in SQL: the batch is the account's, of `status`, not fitted in, not fitting at
 * `now` (`notFittingSql`), and no other batch of the account's is open (`openBatchSql`). Every write a fit makes carries
 * it, and the batch's own write — the transaction's LAST, the only one that changes what it reads — claims the fit: of
 * two taps at once (the transactions run one after the other), one writes everything and the other nothing, however
 * close their clocks.
 */
export function fitClaimSql(userId: string, batchId: string, status: "released" | "saved", now: string): SQL {
  return sql`exists (select 1 from save_batches fc where fc.id = ${batchId} and fc.user_id = ${userId} and fc.status = ${status}
    and fc.fitted_at is null and ${notFittingSql(sql.raw("fc.fit_started_at"), now)}
    and not exists (select 1 from save_batches fo where fo.user_id = fc.user_id and fo.id <> fc.id and ${openBatchSql("fo")}))`;
}

/**
 * A fit ends with its card (spec §12.1): approved, the card's batch is marked fitted in (design-approve.ts, the same
 * write clearing `fit_started_at`); any other ending — its `move_pins` op declined or superseded, or the whole proposal
 * declined, superseded, expired or cancelled — clears the batch's fit, so it comes back with "Fit them in" (a decline
 * means "not like that", not "never"). Of the proposals `proposalIds` names, each one ended so whose `move_pins` op
 * names a batch of the account's, not fitted in, whose fit began no later than the proposal was made (a fit started
 * after it is a newer fit's, never this card's). ONE statement, run only when `proposalIds` names one; callers run it
 * after their own write, never as an error once that is written: past `FIT_STARTED_TTL_MS` the fit reads as over anyway.
 */
export async function releaseFitStarts(db: Db, userId: string, proposalIds: readonly string[]): Promise<void> {
  if (proposalIds.length === 0) return;
  await db.run(sql`update save_batches set fit_started_at = null
    where user_id = ${userId} and fitted_at is null and fit_started_at is not null
      and exists (select 1 from coach_proposals p, json_each(case when json_valid(p.ops) then p.ops else '[]' end) o
        where p.user_id = ${userId} and p.id in (select value from json_each(${JSON.stringify(proposalIds)}))
          and json_extract(o.value, '$.kind') = 'move_pins' and json_extract(o.value, '$.batchId') = save_batches.id
          and (json_extract(o.value, '$.outcome.status') in ('declined', 'superseded') or p.status in ('declined', 'superseded', 'expired', 'cancelled'))
          and save_batches.fit_started_at <= p.created_at)`);
}

const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** A JSON list of strings as SQLite hands it over (a list, or its text); [] when it isn't one. */
export const parseList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw !== "string") return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/**
 * The batch's notice from its moves, as `batchNotice` words it: a move is new when it is a personal move, not merged,
 * that this batch brought (its `batch_id` this batch's) or that is still `pending` — not yet the owner's, whichever
 * batch brought it (spec §12.3: a pending move an earlier, dismissed batch brought is new again here, never "had"; and
 * a batch being assembled, before the stamp, reads its pending moves as new). One the owner already had otherwise (the
 * library's, a personal move saved before). The review's own rule (`NEW_IN_BATCH`, saves-review.ts), so the notice and
 * the page agree. Each move counts once.
 */
export function noticeOf(
  rows: readonly {
    moveId: string | null;
    moveKind: string | null;
    moveStatus: string | null;
    moveBatchId: string | null;
    regions: unknown;
    contraction: unknown;
  }[],
  batchId: string,
): string {
  const fresh = new Map<string, Pick<ExerciseRecord, "regions" | "contraction">>();
  const had = new Set<string>();
  for (const r of rows) {
    if (!r.moveId) continue;
    const born =
      r.moveKind === "personal" && r.moveStatus !== "merged" && (r.moveBatchId === batchId || r.moveStatus === "pending");
    if (born) {
      if (!fresh.has(r.moveId)) {
        fresh.set(r.moveId, {
          regions: parseList(r.regions) as ExerciseRecord["regions"][number][],
          contraction: parseList(r.contraction) as ExerciseRecord["contraction"][number][],
        });
      }
    } else had.add(r.moveId);
  }
  return batchNotice([...fresh.values()], had.size);
}

/**
 * Cut the account's next batch from its matched, unbatched posts (spec §5). Null — and nothing written — while a
 * batch is open (`openBatchSql`), or when the posts it would take bring no new move (posts of only moves the owner has
 * wait, to ride with the next new one). The posts are taken in the order they came in (first seen, then id) while the
 * new moves they bring number at most `BATCH_NEW_MAX` — a new move is a pending personal move, counted once however
 * many posts show it; the oldest post is always taken, whole — and the rest wait for the next batch. A pending move an
 * earlier, dismissed batch brought is new here too (`noticeOf`).
 *
 * Near-duplicates are flagged at the cut (spec §12.4): each new move, in the posts' order, is held to the account's
 * active personal moves and then to the batch's earlier new moves (`nearDuplicateOf`); a hit marks the move's pending
 * links of this batch `check_flag`, with `like_move_id` the move it is like — every hit in ONE statement.
 *
 * A released batch carries its notice; a held one gets it on release. The batch is stamped on the posts it took, their
 * pending links and the pending personal moves those links made that no batch brought yet; the batch row itself is
 * written only if a post took it (two finishes at once make one batch). The gate holds inside the transaction too: the
 * posts are stamped only while still no batch is open, and every later write follows the posts' stamp, so a batch
 * another request opened since the gate's read stops the cut whole — nothing is stamped, and the posts wait. The id
 * returned is the one it tried to write, not proof a batch exists: a caller that needs the open batch re-reads it.
 * D1 statements: the gate 1, the waiting rows 1, the account's personal moves 1, then one transaction of 4 — and 1
 * more in it when the cut flags a near-duplicate. 7, or 8.
 */
export async function assembleBatch(db: Db, env: Env, userId: string, now: string): Promise<string | null> {
  const open = await db.all(sql`select 1 from save_batches o where o.user_id = ${userId} and ${openBatchSql("o")} limit 1`);
  if (open.length) return null;

  const waiting = await db
    .select({
      postId: savedPosts.id,
      moveId: savedPostMoves.moveId,
      moveKind: savedPostMoves.moveKind,
      moveStatus: personalMoves.status,
      moveBatchId: personalMoves.batchId,
      name: sql<unknown>`json_extract(${personalMoves.record}, '$.name')`,
      load: sql<unknown>`json_extract(${personalMoves.record}, '$.load')`,
      doseType: sql<unknown>`json_extract(${personalMoves.record}, '$.dose.type')`,
      regions: sql<unknown>`json_extract(${personalMoves.record}, '$.regions')`,
      contraction: sql<unknown>`json_extract(${personalMoves.record}, '$.contraction')`,
    })
    .from(savedPosts)
    .leftJoin(
      savedPostMoves,
      and(eq(savedPostMoves.postId, savedPosts.id), eq(savedPostMoves.userId, userId), eq(savedPostMoves.status, "pending")),
    )
    .leftJoin(personalMoves, and(eq(personalMoves.id, savedPostMoves.moveId), eq(personalMoves.userId, userId)))
    .where(and(eq(savedPosts.userId, userId), eq(savedPosts.status, "matched"), isNull(savedPosts.batchId)))
    .orderBy(savedPosts.firstSeenAt, savedPosts.id, savedPostMoves.position);

  // Each post's new moves, the posts in the order they came in.
  const byPost = new Map<string, Map<string, NearCandidate>>();
  for (const r of waiting) {
    let own = byPost.get(r.postId);
    if (!own) byPost.set(r.postId, (own = new Map()));
    if (r.moveId && r.moveKind === "personal" && r.moveStatus === "pending" && !own.has(r.moveId)) {
      own.set(r.moveId, { id: r.moveId, name: textOrNull(r.name) ?? "", load: textOrNull(r.load), doseType: textOrNull(r.doseType) });
    }
  }
  const taken = new Set<string>();
  const fresh = new Map<string, NearCandidate>();
  for (const [postId, own] of byPost) {
    let added = 0;
    for (const m of own.keys()) if (!fresh.has(m)) added += 1;
    if (taken.size > 0 && fresh.size + added > BATCH_NEW_MAX) break;
    taken.add(postId);
    for (const [m, c] of own) if (!fresh.has(m)) fresh.set(m, c);
  }
  if (fresh.size === 0) return null;

  // The account's active moves first (a tie keeps the one the owner has), then each new move as it comes.
  const against: NearCandidate[] = (await loadPersonalForMatch(db, userId))
    .filter((r) => r.status === "active" && r.name)
    .map((r) => ({ id: r.id, name: r.name!, load: r.load ?? null, doseType: r.doseType ?? null }));
  const marks = new Map<string, string>();
  for (const m of fresh.values()) {
    if (!m.name) continue;
    const hit = nearDuplicateOf(m, against);
    if (hit && hit.id !== m.id) marks.set(m.id, hit.id);
    against.push(m);
  }

  const id = newId();
  const held = env.SAVES_HOLD_BATCHES === "1";
  const postIds = JSON.stringify([...taken]);
  const batch: typeof saveBatches.$inferInsert = {
    id,
    userId,
    status: held ? "held" : "released",
    theme: null,
    createdAt: now,
    releasedAt: held ? null : now,
    savedAt: null,
    fittedAt: null,
    notice: held ? null : noticeOf(waiting.filter((r) => taken.has(r.postId)), id),
  };
  // `INSERT … SELECT <row> WHERE <a post took the batch>`: every column in the table's order (none is generated),
  // through its own mapping.
  const values = Object.entries(getTableColumns(saveBatches)).map(([key, col]) =>
    sql.param((batch as Record<string, unknown>)[key] ?? null, col),
  );
  await runAtomically(db, [
    db
      .update(savedPosts)
      .set({ batchId: id })
      .where(
        and(
          eq(savedPosts.userId, userId),
          eq(savedPosts.status, "matched"),
          isNull(savedPosts.batchId),
          sql`${savedPosts.id} IN (SELECT value FROM json_each(${postIds}))`,
          sql`NOT EXISTS (SELECT 1 FROM save_batches o WHERE o.user_id = ${userId} AND ${openBatchSql("o")})`,
        ),
      ),
    db
      .update(savedPostMoves)
      .set({ batchId: id })
      .where(
        and(
          eq(savedPostMoves.userId, userId),
          eq(savedPostMoves.status, "pending"),
          isNull(savedPostMoves.batchId),
          sql`${savedPostMoves.postId} IN (SELECT ${savedPosts.id} FROM ${savedPosts} WHERE ${savedPosts.userId} = ${userId} AND ${savedPosts.batchId} = ${id})`,
        ),
      ),
    db
      .update(personalMoves)
      .set({ batchId: id })
      .where(
        and(
          eq(personalMoves.userId, userId),
          eq(personalMoves.status, "pending"),
          isNull(personalMoves.batchId),
          sql`${personalMoves.id} IN (SELECT ${savedPostMoves.moveId} FROM ${savedPostMoves} WHERE ${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.batchId} = ${id} AND ${savedPostMoves.moveKind} = 'personal')`,
        ),
      ),
    db
      .insert(saveBatches)
      .select(
        sql`SELECT ${sql.join(values, sql`, `)} WHERE EXISTS (SELECT 1 FROM ${savedPosts} WHERE ${savedPosts.userId} = ${userId} AND ${savedPosts.batchId} = ${id})`,
      ),
    // The near-duplicates, as one map (move → the move it is like): its keys pick the links, its values fill them.
    ...(marks.size ? [likeWrite(db, userId, id, JSON.stringify(Object.fromEntries(marks)))] : []),
  ]);
  return id;
}

/** Mark the batch's pending links to each move `marks` (JSON `{ moveId: likeMoveId }`) names: check this, like that. */
function likeWrite(db: Db, userId: string, batchId: string, marks: string) {
  return db
    .update(savedPostMoves)
    .set({ checkFlag: true, likeMoveId: sql`(SELECT value FROM json_each(${marks}) WHERE key = ${savedPostMoves.moveId})` })
    .where(
      and(
        eq(savedPostMoves.userId, userId),
        eq(savedPostMoves.batchId, batchId),
        eq(savedPostMoves.status, "pending"),
        sql`${savedPostMoves.moveId} IN (SELECT key FROM json_each(${marks}))`,
      ),
    );
}

/** The import's own key space in `exercise_provenance`: never a curated link's `<code>#<index>`. */
export const IMPORT_KEY_PREFIX = "imp:";

/** A post's insights Save keeps, at most (the extraction's own cap): the first ones, by their place in the post. */
export const INSIGHTS_PER_POST = 5;
/** The insights one Save keeps, at most: the first, by the posts' order and then each post's. */
export const INSIGHTS_PER_BATCH = 20;
/** A memory item's words, at most (as the coach's `remember` and an edit keep them). */
const MEMORY_BODY_MAX = 300;

/** A post's extraction, when it reads as JSON (else null: every JSON function then reads nothing). */
const extractionDoc = (extraction: SQL): SQL => sql`case when json_valid(${extraction}) then ${extraction} end`;

/**
 * The note Save writes on a link (spec §17): the post's reading of the move at the link's position — its `purpose`,
 * what the post says the move is for or when to do it — when it is words; null otherwise. A model's reading of a
 * stranger's post: the app draws it as text, and the coach reads it marked.
 */
function noteAt(): SQL {
  const doc = extractionDoc(sql`${savedPosts.extraction}`);
  const path = sql`'$.moves[' || ${savedPostMoves.position} || '].purpose'`;
  return sql`nullif(trim(case when json_type(${doc}, ${path}) = 'text' then json_extract(${doc}, ${path}) end), '')`;
}

/**
 * A batch's insights as rows (spec §17) — `post_id, url, creator, seen, idx, body`, and `nth`: 1 the first time the
 * batch gives those words, by the posts' order (first seen, then id) and each post's own — from the posts `keptPosts`
 * names (a select of post ids: those with a kept link). An insight is words (at most MEMORY_BODY_MAX, trimmed) among a
 * post's first INSIGHTS_PER_POST places. One rule for what Save keeps, what the batch page shows and what the coach
 * reads. Its tables go by their own aliases (`ins_p`, `ins_j`), so it reads the same inside any select.
 */
export function insightRowsSql(userId: string, keptPosts: SQL): SQL {
  return sql`select ins_p.id as post_id, ins_p.url as url, coalesce(nullif(ins_p.creator_handle, ''), ins_p.creator_name) as creator,
      ins_p.first_seen_at as seen, ins_j.key as idx, trim(ins_j.value) as body,
      row_number() over (partition by trim(ins_j.value) order by ins_p.first_seen_at, ins_p.id, ins_j.key) as nth
    from saved_posts ins_p, json_each(${extractionDoc(sql.raw("ins_p.extraction"))}, '$.insights') ins_j
    where ins_p.user_id = ${userId} and ins_p.id in (${keptPosts})
      and ins_j.type = 'text' and ins_j.key < ${INSIGHTS_PER_POST} and length(trim(ins_j.value)) between 1 and ${MEMORY_BODY_MAX}`;
}

/**
 * `insightRowsSql`'s first `max` distinct insights, in order, as ONE JSON value (a scalar subquery):
 * `[[postId, url, creator, text, seen, index]]` — sort by `seen`, `postId`, `index` (`insightsOf`) rather than trust an
 * aggregate's order.
 */
export function insightsJsonSql(userId: string, keptPosts: SQL, max: number): SQL {
  return sql`(select json_group_array(json_array(ins_i.post_id, ins_i.url, ins_i.creator, ins_i.body, ins_i.seen, ins_i.idx)) from (
      select * from (${insightRowsSql(userId, keptPosts)}) where nth = 1 order by seen, post_id, idx limit ${max}) ins_i)`;
}

/** One insight of a batch's post, as `insightsJsonSql` reads it (the batch page's shape): its text and creator a model's. */
export type BatchInsight = SaveBatchInsightDto;

/** `insightsJsonSql`'s value, read and put in the posts' order; [] when it doesn't read. */
export function insightsOf(raw: unknown): BatchInsight[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const rows = list.flatMap((x): Array<BatchInsight & { seen: string; idx: number }> => {
    const [postId, url, creator, text, seen, idx] = Array.isArray(x) ? (x as unknown[]) : [];
    return typeof postId === "string" && typeof text === "string"
      ? [{ postId, url: textOrNull(url), creator: textOrNull(creator), text, seen: textOrNull(seen) ?? "", idx: typeof idx === "number" ? idx : 0 }]
      : [];
  });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows
    .sort((a, b) => cmp(a.seen, b.seen) || cmp(a.postId, b.postId) || a.idx - b.idx)
    .map(({ postId, url, creator, text }) => ({ postId, url, creator, text }));
}

/**
 * The statement that keeps the batch's insights in the coach's memory (spec §17), set-based: each of `insightRowsSql`'s
 * insights of the posts with a kept (pending) link of the batch becomes an `observation` the coach `inferred`, its
 * provenance a saved post (`SAVED_POST_SOURCE`, the post and its link, when) and its evidence the post's link; not
 * pinned, never expiring. Words the batch gives twice are kept once (the earlier post's); words the account already
 * holds in a live item (memory-core.ts: active, not superseded, not lapsed anywhere yet, not a rehearsal's) are not kept
 * again. At most INSIGHTS_PER_BATCH, by the posts' order and each post's own. The id is the post's and the insight's
 * place (`saved:<post>:<index>`), so a replay writes nothing. The unaliased `coach_memory` in the guard is its own
 * subquery's.
 */
function insightWrites(db: Db, userId: string, kept: SQL, now: string) {
  const today = todayInZone(EARLIEST_ZONE, new Date(now));
  const keptPosts = sql`select ${savedPostMoves.postId} from ${savedPostMoves} where ${kept}`;
  return db
    .insert(coachMemory)
    .select(
      sql`SELECT 'saved:' || i.post_id || ':' || i.idx, ${userId}, 'observation', i.body,
          json_object('source', ${SAVED_POST_SOURCE}, 'postId', i.post_id, 'url', i.url, 'at', ${now}),
          ${now}, NULL, 1, 0, 'inferred', NULL, case when i.url is not null then json_array(i.url) end, ${now}
        FROM (${insightRowsSql(userId, keptPosts)}) i
        WHERE i.nth = 1
          AND NOT EXISTS (SELECT 1 FROM ${coachMemory} WHERE ${liveMemoryWhere(userId, today)} AND ${coachMemory.body} = i.body)
        ORDER BY i.seen, i.post_id, i.idx
        LIMIT ${INSIGHTS_PER_BATCH}`,
    )
    .onConflictDoNothing();
}

/**
 * The owner's choices, `{ moveId: "include" | "skip" }` (JSON), set on the batch's ACTIVE personal moves — the new moves
 * its save made usable (each stamped with the batch): a move the object doesn't name is the coach's call (null). An id
 * that is not one of them — a move whose row was removed (still pending), one merged by Same as…, another account's,
 * none at all — is never written. Looked up as `likeWrite` looks up its marks, so any key reads safely. Only while
 * `gate` holds (the fit's claim, `fitClaimSql`), so a tap that loses the claim never rewrites the winner's choices.
 */
export function choicesWrite(db: Db, userId: string, batchId: string, choices: Record<string, FitChoice>, gate: SQL) {
  const json = JSON.stringify(choices);
  return db
    .update(personalMoves)
    .set({ fitChoice: sql`(SELECT value FROM json_each(${json}) WHERE key = ${personalMoves.id})` })
    .where(and(eq(personalMoves.userId, userId), eq(personalMoves.batchId, batchId), eq(personalMoves.status, "active"), gate));
}

/**
 * The skip set of the batch a fit-in run fits (spec §12.1, §12.5), in ONE statement: null unless the batch is a `saved`
 * batch of the account's (another account's, one not saved, one nobody has: alike); else its new moves — active,
 * stamped with the batch — the owner chose to skip (`fit_choice = 'skip'`), each with its name, by id ([] with none).
 */
export async function skipSetOf(db: Db, userId: string, batchId: string): Promise<SavesSkip[] | null> {
  const rows = (await db.all(sql`
    select (select json_group_array(json_array(m.id, json_extract(m.record, '$.name'))) from personal_moves m
        where m.user_id = ${userId} and m.batch_id = b.id and m.status = 'active' and m.fit_choice = 'skip') as skip
    from save_batches b where b.user_id = ${userId} and b.id = ${batchId} and b.status = 'saved'`)) as Array<{ skip: string | null }>;
  if (rows.length === 0) return null;
  let list: unknown = [];
  try {
    list = JSON.parse(rows[0]!.skip ?? "[]");
  } catch {
    list = [];
  }
  return (Array.isArray(list) ? list : [])
    .flatMap((x): SavesSkip[] => {
      const [id, name] = Array.isArray(x) ? (x as unknown[]) : [];
      return typeof id === "string" ? [{ id, name: textOrNull(name) ?? "" }] : [];
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A fit's start: when (`at`, the request's now) and the owner's choices. */
export interface FitStart {
  at: string;
  choices: Record<string, FitChoice>;
}

/**
 * The owner's "Save these" (and, with `fit`, the save that starts "Fit them in", spec §4, §12.1):
 *  - the pending personal moves a kept (pending) link of the batch names become `active`, and this batch's — one the
 *    owner removed or re-matched away (no kept link names it) stays pending and is never offered; a pending move an
 *    earlier, unsaved batch brought is activated when this batch keeps a link to it, and belongs to this batch since;
 *  - with `fit`, those moves take the owner's choices (`choicesWrite`), right after they are activated;
 *  - each kept link is written to `exercise_provenance` (`exercise_id` = the move, `source_type` = the post's source,
 *    `source_key` = "imp:" + the post's key + "#" + position, url, creator, and its `note`: the post's purpose for the
 *    move, `noteAt`) unless the account already links that move to that post (a curated link stays exactly as it is,
 *    its note none, and a move never lists one post twice). Insert-only: an import never rewrites a provenance row;
 *  - the insights of each post with a kept link become the coach's memory (`insightWrites`, spec §17): nothing from a
 *    batch is used before Save, and a post whose rows were all removed teaches nothing;
 *  - the links become `saved`, the batch `saved` — and with `fit`, its fit started (`fit_started_at` = `fit.at`) and
 *    no longer put aside (`dismissed_at` cleared).
 * With `fit`, every write carries the fit's claim (`fitClaimSql`: still released, not fitting, no other batch open) and
 * the batch's write, last, claims it: "lost" — and nothing written — when another tap claimed it first (or the batch
 * went saved since its read), so two taps never start two fits.
 * A removed link is left out. Null for a batch that isn't this account's; a batch already saved (or dismissed) changes
 * nothing. D1 statements: the batch and its counts 1, then one transaction of 5 (6 with `fit`) — set-based, so the
 * same 6 (or 7) for 6 links or 600.
 */
export async function saveBatch(db: Db, userId: string, batchId: string, now: string): Promise<SavedCounts | null>;
export async function saveBatch(db: Db, userId: string, batchId: string, now: string, fit: FitStart): Promise<SavedCounts | null | "lost">;
export async function saveBatch(db: Db, userId: string, batchId: string, now: string, fit?: FitStart): Promise<SavedCounts | null | "lost"> {
  const pendingLinks = and(
    eq(savedPostMoves.userId, userId),
    eq(savedPostMoves.batchId, batchId),
    eq(savedPostMoves.status, "pending"),
  );
  const keptIn = (links: SQL | undefined) => and(
    eq(personalMoves.userId, userId),
    eq(personalMoves.status, "pending"),
    sql`${personalMoves.id} IN (SELECT ${savedPostMoves.moveId} FROM ${savedPostMoves} WHERE ${links} AND ${savedPostMoves.moveKind} = 'personal')`,
  );
  const movesToKeep = keptIn(pendingLinks);
  // The writes' links (and so their moves): with a fit, only while its claim holds.
  const gate = fit ? fitClaimSql(userId, batchId, "released", now) : undefined;
  const keptLinks = and(pendingLinks, gate)!;
  const movesToActivate = keptIn(keptLinks);
  const [batch] = await db
    .select({
      status: saveBatches.status,
      moves: sql<number>`(SELECT count(*) FROM ${personalMoves} WHERE ${movesToKeep})`,
      links: sql<number>`(SELECT count(*) FROM ${savedPostMoves} WHERE ${pendingLinks})`,
    })
    .from(saveBatches)
    .where(and(eq(saveBatches.id, batchId), eq(saveBatches.userId, userId)))
    .limit(1);
  if (!batch) return null;
  // Saved since the fit read it: another tap's (or the move sheet's) save came first.
  if (batch.status === "saved" || batch.status === "dismissed") return fit ? "lost" : { moves: 0, links: 0 };

  // In order: the moves and the links are read while the links are still pending; the links are marked last, and the
  // batch (with a fit: the claim, the one write that changes what the gate reads) after them.
  const statements = [
    db.update(personalMoves).set({ status: "active", batchId, updatedAt: now }).where(movesToActivate),
    // The choices, once the moves they name are the batch's active moves.
    ...(fit && gate ? [choicesWrite(db, userId, batchId, fit.choices, gate)] : []),
    // One row per kept link, except where the account already links the move to the post (`existing`) or an earlier
    // position of the same post shows the same move (`twin`). The aliased tables are named by their alias inside their
    // subquery, so the unaliased names there are the outer row's.
    db
      .insert(exerciseProvenance)
      .select(
        sql`SELECT ${savedPostMoves.id}, ${savedPostMoves.userId}, ${savedPostMoves.moveId}, ${savedPosts.source}, ${savedPosts.url},
          coalesce(nullif(${savedPosts.creatorHandle}, ''), ${savedPosts.creatorName}),
          ${IMPORT_KEY_PREFIX} || ${savedPosts.sourceKey} || '#' || ${savedPostMoves.position}, ${now}, ${noteAt()}
          FROM ${savedPostMoves} JOIN ${savedPosts} ON ${savedPosts.id} = ${savedPostMoves.postId}
          WHERE ${keptLinks} AND ${savedPosts.userId} = ${userId}
            AND NOT EXISTS (SELECT 1 FROM ${exerciseProvenance} AS existing
              WHERE existing.user_id = ${userId} AND existing.exercise_id = ${savedPostMoves.moveId} AND existing.url = ${savedPosts.url})
            AND NOT EXISTS (SELECT 1 FROM ${savedPostMoves} AS twin
              WHERE twin.user_id = ${userId} AND twin.batch_id = ${batchId} AND twin.status = 'pending'
                AND twin.post_id = ${savedPostMoves.postId} AND twin.move_id = ${savedPostMoves.moveId}
                AND twin.position < ${savedPostMoves.position})`,
      )
      .onConflictDoNothing(),
    // While the links are still pending: they say which posts were kept.
    insightWrites(db, userId, keptLinks, now),
    db.update(savedPostMoves).set({ status: "saved" }).where(keptLinks),
  ] as const;
  const thisBatch = and(eq(saveBatches.id, batchId), eq(saveBatches.userId, userId));
  if (fit && gate) {
    const claimed = await runAtomicallyClaim(db, [
      ...statements,
      db
        .update(saveBatches)
        .set({ status: "saved", savedAt: now, fitStartedAt: fit.at, dismissedAt: null })
        .where(and(thisBatch, gate))
        .returning({ id: saveBatches.id }),
    ]);
    if (!claimed) return "lost";
  } else {
    await runAtomically(db, [...statements, db.update(saveBatches).set({ status: "saved", savedAt: now }).where(thisBatch)]);
  }
  // Its moves are the library's now: a later read in this request reads them.
  forgetAccountLibrary(db, userId);
  return { moves: Number(batch.moves), links: Number(batch.links) };
}

/** What a save made usable: the new moves activated, the links kept. */
export interface SavedCounts {
  moves: number;
  links: number;
}
