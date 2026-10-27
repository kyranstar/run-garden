/**
 * "FROM YOUR SAVES", THE REVIEW (saved-posts import, Task 15; the Studio's `/studio/saves/:batchId`). What a batch
 * brought, and the owner's word on it before anything is used:
 *
 *  - the batches (`listBatches`) and one batch's rows (`batchDetail`): each link of a post to a move — a NEW move (a
 *    personal move this batch brought, saved or not, or one still pending whichever batch brought it) or one LINKED to
 *    a move the owner already had (the library's, or a personal move saved before), "check this" where the match or the
 *    reading was unsure, the dose as the post gave it — the list's counts and the page's labels by one rule; and the
 *    insights of its kept posts (spec §17: what they say about when, why or how often, which Save keeps in the coach's
 *    memory);
 *  - an edit of a personal move (`editPersonalMove`), held to the library's own validation (`validatePersonalRecord`);
 *  - a re-match (`rematchLink`): "Same as…" repoints the link to a library move or an active personal move, and a pending
 *    move it leaves (named by no other pending link of the account) is merged into it; "Not this move" makes the post's
 *    move a new move of its own, from the post's stored reading at that position, every time (a pending move it leaves
 *    stays pending: never activated, never offered). Saving writes each link by the move it names, so repointing the
 *    link is what makes the save right;
 *  - Remove (`removeLink`): the row is left out of the save, and its move — if no kept row names it — stays pending,
 *    never used;
 *  - the bootstrap's themed held batches (`createHeldBatch`, gathering posts out of the held batch a check made in hold
 *    mode) and their release (`releaseBatch`: worded as `assembleBatch` words a batch, and — one batch at a time —
 *    never while another batch of the account's is open). Save is `saveBatch` (saves-batches.ts);
 *  - the one path (the saves flow redesigned, 2026-10-26; spec §3.2, §4, §12.1, §12.3): the open batch the card is
 *    about (`readOpenBatch`, cutting the next one when none is open and new moves wait), "Fit them in" (`fitBatch`:
 *    Save with the owner's choices, and the fit started), "not now" (`dismissBatch`: nothing saved) and a fit whose run
 *    could not start (`cancelFit`).
 *
 * Every row a write touches must be the account's and pending; a batch, row or move of another account is not found.
 * A write that changes a move the account's library holds (an active move edited, a merge) forgets this request's read
 * of it. Model-written text (names, summaries, creators) is returned as data; the app draws it as text.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import {
  extractedMoveSchema, FIT_SAVES_REQUEST, groupCounts, isPersonalId, personalMoveId, savesCardLine,
  type CheckWhy, type FitAnswerDto, type FitChoice, type OpenSavesBatchDto, type OpenSavesDto, type PersonalMovePatch,
  type SaveBatchCountsDto, type SaveBatchDetailDto, type SaveBatchDto, type SaveBatchRowDto,
} from "@rg/saves";
import { makeLibraryIndex } from "@rg/workout";
import type { Env } from "../env.js";
import { forgetAccountLibrary, loadAccountLibrary } from "./account-library.js";
import { runAtomically, runAtomicallyClaim, type Db } from "./db.js";
import { buildPersonalRecord } from "./personal-moves.js";
import { validatePersonalRecord } from "./personal-records.js";
import {
  assembleBatch, choicesWrite, fitClaimSql, INSIGHTS_PER_BATCH, insightsJsonSql, insightsOf, isFitting, noticeOf,
  notFittingSql, openBatchSql, parseList, pinsOpenSql, saveBatch,
} from "./saves-batches.js";

const { savedPosts, savedPostMoves, personalMoves, saveBatches } = schema;

/** The most batches the list returns (one is open at a time, and a batch holds at most 12 new moves). */
export const BATCH_LIST_LIMIT = 60;

const publicMove = makeLibraryIndex(EXERCISES);

/** A batch row as read, with its counts (`BATCH_COLUMNS`). */
interface BatchRead {
  id: string;
  status: SaveBatchDto["status"];
  notice: string | null;
  theme: string | null;
  createdAt: string;
  releasedAt: string | null;
  savedAt: string | null;
  fittedAt: string | null;
  dismissedAt: string | null;
  fitStartedAt: string | null;
  /** A card of the moves in rotation naming it is still open (`pinsOpenSql`): 1 or 0. */
  pinsOpen: number | null;
  fresh: number | null;
  linked: number | null;
  removed: number | null;
}

/**
 * A row's move is NEW to its batch when it is a personal move, not merged since (a merged move reads as its target),
 * that the batch brought (`personal_moves.batch_id` is the batch's) — whatever its status now, so a saved batch still
 * shows the moves it brought as new — or that is still `pending`, whichever batch brought it: not yet the owner's, so
 * never "already yours" (spec §12.3: a pending move an earlier, dismissed batch brought is new again in a later one).
 * Anything else — the library's, a personal move saved before — is LINKED. The list's counts, the page's labels and
 * the notice (`noticeOf`) use this one rule. SQL over `l` (the link) and `pm` (its personal move).
 */
export const NEW_IN_BATCH = sql`(l.move_kind = 'personal' and coalesce(pm.status <> 'merged' and (pm.batch_id = l.batch_id or pm.status = 'pending'), 0))`;

/** NEW: each distinct move of a kept row (pending or saved) of the batch `b` that is new to it (`NEW_IN_BATCH`). */
const FRESH_COUNT = sql`(select count(distinct l.move_id) from saved_post_moves l
     left join personal_moves pm on pm.id = l.move_id and pm.user_id = l.user_id
     where l.user_id = b.user_id and l.batch_id = b.id and l.status <> 'removed' and ${NEW_IN_BATCH})`;
/** LINKED: each distinct other move of a kept row of the batch `b` (one the owner already had). */
const LINKED_COUNT = sql`(select count(distinct l.move_id) from saved_post_moves l
     left join personal_moves pm on pm.id = l.move_id and pm.user_id = l.user_id
     where l.user_id = b.user_id and l.batch_id = b.id and l.status <> 'removed' and not ${NEW_IN_BATCH})`;

/**
 * The batch's columns and its counts, for a select over `save_batches b`: NEW (`FRESH_COUNT`), LINKED
 * (`LINKED_COUNT`), REMOVED the rows taken out; and whether its card is still open (`pinsOpenSql`).
 */
const BATCH_COLUMNS = sql`b.id as id, b.status as status, b.notice as notice, b.theme as theme, b.created_at as createdAt,
  b.released_at as releasedAt, b.saved_at as savedAt, b.fitted_at as fittedAt, b.dismissed_at as dismissedAt,
  b.fit_started_at as fitStartedAt, ${pinsOpenSql("b")} as pinsOpen,
  ${FRESH_COUNT} as fresh,
  ${LINKED_COUNT} as linked,
  (select count(*) from saved_post_moves l where l.user_id = b.user_id and l.batch_id = b.id and l.status = 'removed') as removed`;

/** The batch as the app reads it; `fitting` is the one-hour rule at `now`, or its card still open (`isFitting`). */
function batchOf(r: BatchRead, now: string): SaveBatchDto {
  const counts: SaveBatchCountsDto = { new: Number(r.fresh ?? 0), linked: Number(r.linked ?? 0), removed: Number(r.removed ?? 0) };
  const fitStartedAt = r.fitStartedAt ?? null;
  return {
    id: r.id, status: r.status, notice: r.notice, theme: r.theme, createdAt: r.createdAt, releasedAt: r.releasedAt, savedAt: r.savedAt,
    fittedAt: r.fittedAt ?? null, counts, dismissedAt: r.dismissedAt ?? null, fitStartedAt,
    fitting: isFitting(fitStartedAt, now, Boolean(Number(r.pinsOpen ?? 0))),
  };
}

async function readBatch(db: Db, userId: string, batchId: string, now: string): Promise<SaveBatchDto | null> {
  const [row] = (await db.all(sql`select ${BATCH_COLUMNS} from save_batches b where b.id = ${batchId} and b.user_id = ${userId} limit 1`)) as BatchRead[];
  return row ? batchOf(row, now) : null;
}

/** The account's released and saved batches (held ones too with `held`), newest first. ONE statement. */
export async function listBatches(db: Db, userId: string, opts: { held: boolean }, now: string): Promise<{ batches: SaveBatchDto[] }> {
  const statuses = JSON.stringify(opts.held ? ["held", "released", "saved"] : ["released", "saved"]);
  const rows = (await db.all(sql`select ${BATCH_COLUMNS} from save_batches b
    where b.user_id = ${userId} and b.status in (select value from json_each(${statuses}))
    order by coalesce(b.released_at, b.created_at) desc, b.id desc
    limit ${BATCH_LIST_LIMIT}`)) as BatchRead[];
  return { batches: rows.map((r) => batchOf(r, now)) };
}

/** A link of the batch as read. */
interface RowRead {
  postMoveId: string;
  position: number;
  status: SaveBatchRowDto["status"];
  moveId: string;
  moveKind: "library" | "personal";
  checkFlag: number;
  url: string | null;
  creator: string | null;
  postKind: string | null;
  seenName: string | null;
  seenSummary: string | null;
  seenDose: string | null;
  /** The match's confidence (saves-match.ts `CONFIDENCE_VALUE`: 1, 0.6, 0.3). */
  confidence: number | null;
  /** The reading's own confidence in the move, and whether the post said its name and dose. */
  seenConfidence: string | null;
  nameEvidence: string | null;
  doseEvidence: string | null;
  moveStatus: string | null;
  /** The move is new to this batch (`NEW_IN_BATCH`): 1 or 0. */
  born: number;
  /** A pending, active or archived personal move's record, as stored (JSON text). */
  record: string | null;
  /** What the post says the move is for (the reading's `purpose` at the link's position). */
  purpose: unknown;
  /** The move the link's move looks like (a near-duplicate flagged at the cut), and its name. */
  likeId: string | null;
  likeName: unknown;
  /** The personal move's stored fit choice. */
  choice: string | null;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

const choiceOf = (v: unknown): FitChoice | null => (v === "include" || v === "skip" ? v : null);

/**
 * One batch and its rows, in the posts' order and each post's moves in theirs, and the insights of its posts that keep
 * a row (spec §17: what the coach keeps in memory on Save — the same rule, read out by SQLite; a post whose rows were
 * all removed teaches nothing); null when the batch isn't this account's. Each row carries what the post says its move
 * is for (`purpose`), the move it looks like when the cut flagged one (`like`), and — a new row's only — the owner's fit
 * choice. D1 statements: the batch with its insights 1, the rows 1, and the account's library 1 only when a row names a
 * move that has been merged since (its target's name).
 */
export async function batchDetail(db: Db, userId: string, batchId: string, now: string): Promise<SaveBatchDetailDto | null> {
  const keptPosts = sql`select nl.post_id from saved_post_moves nl where nl.user_id = b.user_id and nl.batch_id = b.id and nl.status <> 'removed'`;
  const [head] = (await db.all(sql`select ${BATCH_COLUMNS}, ${insightsJsonSql(userId, keptPosts, INSIGHTS_PER_BATCH)} as insights
    from save_batches b where b.id = ${batchId} and b.user_id = ${userId} limit 1`)) as Array<BatchRead & { insights: unknown }>;
  if (!head) return null;
  const batch = batchOf(head, now);
  const insights = insightsOf(head.insights);
  // The post's reading of each move is read out by SQLite: the extraction is never handed over whole.
  const reads = (await db.all(sql`select l.id as postMoveId, l.position as position, l.status as status, l.move_id as moveId,
      l.move_kind as moveKind, l.check_flag as checkFlag, p.url as url,
      coalesce(nullif(p.creator_handle, ''), p.creator_name) as creator,
      json_extract(p.extraction, '$.kind') as postKind,
      json_extract(p.extraction, '$.moves[' || l.position || '].name') as seenName,
      json_extract(p.extraction, '$.moves[' || l.position || '].summary') as seenSummary,
      json_extract(p.extraction, '$.moves[' || l.position || '].dose.text') as seenDose,
      l.confidence as confidence,
      json_extract(p.extraction, '$.moves[' || l.position || '].confidence') as seenConfidence,
      json_extract(p.extraction, '$.moves[' || l.position || '].evidence.name') as nameEvidence,
      json_extract(p.extraction, '$.moves[' || l.position || '].evidence.dose') as doseEvidence,
      pm.status as moveStatus, ${NEW_IN_BATCH} as born,
      case when pm.status in ('pending', 'active', 'archived') then pm.record end as record,
      json_extract(p.extraction, '$.moves[' || l.position || '].purpose') as purpose,
      l.like_move_id as likeId,
      (select json_extract(lm.record, '$.name') from personal_moves lm where lm.id = l.like_move_id and lm.user_id = l.user_id) as likeName,
      pm.fit_choice as choice
    from saved_post_moves l
      join saved_posts p on p.id = l.post_id and p.user_id = l.user_id
      left join personal_moves pm on pm.id = l.move_id and pm.user_id = l.user_id and l.move_kind = 'personal'
    where l.user_id = ${userId} and l.batch_id = ${batchId}
    order by p.first_seen_at, p.id, l.position`)) as RowRead[];

  // A merged (or missing) personal move: its target's name, through the account's library.
  const merged = reads.some((r) => r.moveKind === "personal" && (r.moveStatus === "merged" || r.moveStatus === null));
  const find = merged ? makeLibraryIndex((await loadAccountLibrary(db, userId)).all) : publicMove;
  const records = new Map<string, ExerciseRecord | null>();
  const recordOf = (r: RowRead): ExerciseRecord | null => {
    if (!r.record) return null;
    if (!records.has(r.moveId)) {
      let rec: ExerciseRecord | null = null;
      try {
        const parsed = JSON.parse(r.record) as ExerciseRecord;
        rec = parsed && typeof parsed === "object" && typeof parsed.name === "string" ? { ...parsed, id: r.moveId } : null;
      } catch {
        rec = null;
      }
      records.set(r.moveId, rec);
    }
    return records.get(r.moveId) ?? null;
  };

  const rows = reads.map((r): SaveBatchRowDto => {
    const record = recordOf(r);
    const fresh = Boolean(r.born);
    const seenName = text(r.seenName);
    const seenSummary = text(r.seenSummary);
    const linkedName = fresh ? undefined : (record?.name ?? find(r.moveId)?.name ?? r.moveId);
    return {
      postMoveId: r.postMoveId,
      position: Number(r.position),
      status: r.status,
      post: { url: r.url, creator: r.creator, kind: text(r.postKind) },
      move: {
        id: r.moveId,
        name: fresh ? (record?.name ?? seenName ?? r.moveId) : (seenName ?? linkedName ?? r.moveId),
        summary: fresh ? (record?.text?.summary ?? seenSummary ?? "") : (seenSummary ?? ""),
        kind: fresh ? "new" : "linked",
        ...(linkedName === undefined ? {} : { linkedName }),
        check: Boolean(r.checkFlag),
        ...(r.checkFlag ? { checkWhy: checkWhyOf(r) } : {}),
        seenDose: text(r.seenDose),
        purpose: text(r.purpose),
        ...(r.likeId ? { like: { id: r.likeId, name: text(r.likeName) ?? r.likeId } } : {}),
        choice: fresh ? choiceOf(r.choice) : null,
      },
      ...(record ? { record } : {}),
    };
  });
  return { batch, rows, insights };
}

/**
 * Why a flagged row says "Check this" (verbatim audit gap 5): the match was not a sure one (below `CONFIDENCE_VALUE.high`)
 * or the reading was unsure of the move (`confidence: "low"`), what the post never said — its name, its dose — the
 * reading inferred (`evidence`), and a move that looks like another (the cut's near-duplicate, spec §12.4).
 */
function checkWhyOf(r: RowRead): CheckWhy[] {
  const out: CheckWhy[] = [];
  if ((r.confidence !== null && Number(r.confidence) < 1) || r.seenConfidence === "low") out.push("low_confidence");
  if (r.nameEvidence === "inferred") out.push("inferred_name");
  if (r.doseEvidence === "inferred") out.push("inferred_dose");
  if (r.likeId) out.push("near_duplicate");
  return out;
}

// ── Edit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type EditOutcome = { kind: "ok"; record: ExerciseRecord } | { kind: "not_found" } | { kind: "invalid"; issues: string[] };

/** The record with the owner's edit: each field sent replaces the record's; the conditions replace the profiles named. */
export function applyPatch(rec: ExerciseRecord, p: PersonalMovePatch): ExerciseRecord {
  const t = p.text ?? {};
  return {
    ...rec,
    ...(p.name !== undefined ? { name: p.name } : {}),
    ...(p.dose ? { dose: p.dose } : {}),
    ...(p.conditions ? { conditions: { ...rec.conditions, ...p.conditions } } : {}),
    text: {
      ...rec.text,
      ...(t.summary !== undefined ? { summary: t.summary } : {}),
      ...(t.steps !== undefined ? { steps: t.steps } : {}),
      ...(t.focus !== undefined ? { focus: t.focus } : {}),
      ...(t.mistakes !== undefined ? { mistakes: t.mistakes } : {}),
      ...(t.conditions ? { conditions: { ...rec.text.conditions, ...t.conditions } } : {}),
    },
    id: rec.id,
  };
}

/**
 * The owner's edit of one of their pending or active moves (an archived or merged one, or another account's, is not
 * found). The edited record must pass `validatePersonalRecord`; the issues come back without the id. Marks the move
 * edited (an import never rewrites it). D1 statements: the move 1, its write 1.
 */
export async function editPersonalMove(db: Db, userId: string, id: string, patch: PersonalMovePatch, now: string): Promise<EditOutcome> {
  const [row] = await db
    .select({ status: personalMoves.status, record: personalMoves.record })
    .from(personalMoves)
    .where(and(eq(personalMoves.id, id), eq(personalMoves.userId, userId)))
    .limit(1);
  if (!row || (row.status !== "pending" && row.status !== "active")) return { kind: "not_found" };
  const rec = row.record as ExerciseRecord | null;
  if (!rec || typeof rec !== "object") return { kind: "not_found" };
  const next = applyPatch({ ...rec, id }, patch);
  const problems = validatePersonalRecord(next);
  if (problems.length) return { kind: "invalid", issues: problems.map((p) => (p.startsWith(`${id}: `) ? p.slice(id.length + 2) : p)) };
  await db
    .update(personalMoves)
    .set({ record: next, editedByOwner: true, updatedAt: now })
    .where(and(eq(personalMoves.id, id), eq(personalMoves.userId, userId), eq(personalMoves.status, row.status)));
  if (row.status === "active") forgetAccountLibrary(db, userId);
  return { kind: "ok", record: next };
}

// ── Re-match, remove ─────────────────────────────────────────────────────────────────────────────────────────────────

export type RematchOutcome =
  | { kind: "ok"; moveId: string; moveKind: "library" | "personal" }
  | { kind: "not_found" }
  | { kind: "target_not_found" }
  | { kind: "conflict"; error: "not_pending" | "same_move" | "no_reading" }
  | { kind: "invalid"; issues: string[] };

interface LinkRead {
  status: string;
  batchId: string | null;
  postId: string;
  position: number;
  moveId: string;
  moveKind: "library" | "personal";
  /** The post's reading of the move at the link's position (JSON text), or null. */
  draft: string | null;
  moveStatus: string | null;
  /** The account's other pending links naming the same move. */
  others: number;
  targetStatus: string | null;
  /** The batch that brought the target, when it is a personal move. */
  targetBatchId: string | null;
}

/**
 * The owner's re-match of one pending row:
 *  - `to` a library move, one of the account's active moves, or a new (pending) move the row's own batch brought
 *    ("Same as…" — two new moves the matcher missed, merged in review): the link names it; a pending move the link
 *    leaves, named by no other pending link of the account, is merged into it (`merged_into`, a public id allowed; a
 *    sibling target is activated on Save, since a kept row names it);
 *  - `to` null ("Not this move"): the post's move is a new move of its own — a pending personal move built from the
 *    post's stored reading at that position — every time (409 only when the reading has no move there). A pending move
 *    the link leaves stays pending: no kept link names it, so saving never activates it, and nothing offers it.
 * Either way the owner's word settles the row: its "Check this" and the move it looked like (`like_move_id`) are
 * cleared, and a merged move's fit choice with it (spec §4).
 * A saved or removed row is 409; a target that isn't a library move, an active move of the account's or a pending move of
 * the row's batch (another batch's pending move included) is not found.
 * D1 statements: the link with all it needs 1, then one transaction of 1–2.
 */
export async function rematchLink(db: Db, userId: string, linkId: string, to: string | null, now: string): Promise<RematchOutcome> {
  const [link] = (await db.all(sql`select l.status as status, l.batch_id as batchId, l.post_id as postId, l.position as position,
      l.move_id as moveId, l.move_kind as moveKind,
      json_extract(p.extraction, '$.moves[' || l.position || ']') as draft,
      pm.status as moveStatus,
      (select count(*) from saved_post_moves o
         where o.user_id = l.user_id and o.status = 'pending' and o.move_id = l.move_id and o.id <> l.id) as others,
      (select t.status from personal_moves t where t.user_id = l.user_id and t.id = ${to ?? ""}) as targetStatus,
      (select t.batch_id from personal_moves t where t.user_id = l.user_id and t.id = ${to ?? ""}) as targetBatchId
    from saved_post_moves l
      join saved_posts p on p.id = l.post_id and p.user_id = l.user_id
      left join personal_moves pm on pm.id = l.move_id and pm.user_id = l.user_id and l.move_kind = 'personal'
    where l.id = ${linkId} and l.user_id = ${userId}
    limit 1`)) as LinkRead[];
  if (!link) return { kind: "not_found" };
  if (link.status !== "pending") return { kind: "conflict", error: "not_pending" };
  const ownPending = link.moveKind === "personal" && link.moveStatus === "pending";
  const pendingLink = and(eq(savedPostMoves.id, linkId), eq(savedPostMoves.userId, userId), eq(savedPostMoves.status, "pending"));

  if (to === null) {
    let raw: unknown = null;
    try {
      raw = link.draft ? JSON.parse(link.draft) : null;
    } catch {
      raw = null;
    }
    const draft = extractedMoveSchema.safeParse(raw);
    if (!draft.success) return { kind: "conflict", error: "no_reading" };
    // A new id each time: the post's move made its own again after a merge is a move of its own again.
    const id = personalMoveId(draft.data.name, `${userId}:${link.postId}:${link.position}:${newId()}`);
    const built = buildPersonalRecord(id, draft.data);
    if (!built.ok) return { kind: "invalid", issues: built.issues };
    await runAtomically(db, [
      db.insert(personalMoves).values({
        id, userId, status: "pending", mergedInto: null, batchId: link.batchId, record: built.record, editedByOwner: false, createdAt: now, updatedAt: now,
      }),
      db.update(savedPostMoves).set({ moveId: id, moveKind: "personal", checkFlag: false, likeMoveId: null }).where(pendingLink),
    ]);
    return { kind: "ok", moveId: id, moveKind: "personal" };
  }

  let target: { id: string; kind: "library" | "personal" } | null = null;
  if (isPersonalId(to)) {
    const sibling = link.targetStatus === "pending" && link.batchId !== null && link.targetBatchId === link.batchId;
    target = link.targetStatus === "active" || sibling ? { id: to, kind: "personal" } : null;
  }
  else {
    const rec = publicMove(to);
    target = rec ? { id: rec.id, kind: "library" } : null;
  }
  if (!target) return { kind: "target_not_found" };
  if (target.id === link.moveId) return { kind: "conflict", error: "same_move" };
  const merge = ownPending && Number(link.others) === 0;
  await runAtomically(db, [
    db.update(savedPostMoves).set({ moveId: target.id, moveKind: target.kind, checkFlag: false, likeMoveId: null }).where(pendingLink),
    ...(merge
      ? [
          db
            .update(personalMoves)
            .set({ status: "merged", mergedInto: target.id, fitChoice: null, updatedAt: now })
            .where(and(eq(personalMoves.id, link.moveId), eq(personalMoves.userId, userId), eq(personalMoves.status, "pending"))),
        ]
      : []),
  ]);
  // The account's library holds a merged move (as its target's): a later read in this request reads it.
  if (merge) forgetAccountLibrary(db, userId);
  return { kind: "ok", moveId: target.id, moveKind: target.kind };
}

/** Take a pending row out of the batch: it is left out of the save. D1 statements: 1 (2 when it can't be). */
export async function removeLink(db: Db, userId: string, linkId: string): Promise<"ok" | "not_found" | "conflict"> {
  const done = await db
    .update(savedPostMoves)
    .set({ status: "removed" })
    .where(and(eq(savedPostMoves.id, linkId), eq(savedPostMoves.userId, userId), eq(savedPostMoves.status, "pending")))
    .returning({ id: savedPostMoves.id });
  if (done.length) return "ok";
  const [row] = await db
    .select({ id: savedPostMoves.id })
    .from(savedPostMoves)
    .where(and(eq(savedPostMoves.id, linkId), eq(savedPostMoves.userId, userId)))
    .limit(1);
  return row ? "conflict" : "not_found";
}

// ── The bootstrap: a held batch, its release ─────────────────────────────────────────────────────────────────────────

/**
 * A themed held batch of these posts' pending rows (the bootstrap's curation, plan Task 20): rows in no batch yet, or
 * in a HELD batch of the account's — in hold mode every check's finish gathers the matched posts into one theme-less
 * held batch (`assembleBatch`), which the curation then splits by theme. A released, saved or dismissed batch's rows are
 * never taken. The new batch is stamped on those rows, on their posts (from no batch, or a held one), and on the pending
 * personal moves they name that no batch or a held batch brought; a held batch left with no rows at all goes (its
 * moveless posts' stamp with it). Null — nothing written — when no post has such a row.
 * D1 statements: the waiting rows 1, one transaction of 6, the new batch with its counts 1.
 */
export async function createHeldBatch(
  db: Db,
  userId: string,
  input: { theme: string | null; postIds: readonly string[] },
  now: string,
): Promise<SaveBatchDto | null> {
  const posts = JSON.stringify([...new Set(input.postIds)]);
  /** The account's held batches as they stand before this one is made. */
  const heldIds = sql`(SELECT ${saveBatches.id} FROM ${saveBatches} WHERE ${saveBatches.userId} = ${userId} AND ${saveBatches.status} = 'held')`;
  const waitingRows = and(
    eq(savedPostMoves.userId, userId),
    eq(savedPostMoves.status, "pending"),
    sql`(${savedPostMoves.batchId} IS NULL OR ${savedPostMoves.batchId} IN ${heldIds})`,
    sql`${savedPostMoves.postId} IN (SELECT value FROM json_each(${posts}))`,
  );
  const [waiting] = await db.select({ n: sql<number>`count(*)` }).from(savedPostMoves).where(waitingRows);
  if (!waiting || Number(waiting.n) === 0) return null;
  const id = newId();
  /** A held batch, other than the new one, that no row names any more. */
  const emptyHeld = sql`${saveBatches.userId} = ${userId} AND ${saveBatches.status} = 'held' AND ${saveBatches.id} <> ${id}
    AND NOT EXISTS (SELECT 1 FROM ${savedPostMoves} WHERE ${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.batchId} = ${saveBatches.id})`;
  // In order: the rows move first (the held batches are read before the new one exists); the new batch is written last.
  await runAtomically(db, [
    db.update(savedPostMoves).set({ batchId: id }).where(waitingRows),
    db
      .update(savedPosts)
      .set({ batchId: id })
      .where(
        and(
          eq(savedPosts.userId, userId),
          sql`(${savedPosts.batchId} IS NULL OR ${savedPosts.batchId} IN ${heldIds})`,
          sql`${savedPosts.id} IN (SELECT ${savedPostMoves.postId} FROM ${savedPostMoves} WHERE ${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.batchId} = ${id})`,
        ),
      ),
    db
      .update(personalMoves)
      .set({ batchId: id })
      .where(
        and(
          eq(personalMoves.userId, userId),
          eq(personalMoves.status, "pending"),
          sql`(${personalMoves.batchId} IS NULL OR ${personalMoves.batchId} IN ${heldIds})`,
          sql`${personalMoves.id} IN (SELECT ${savedPostMoves.moveId} FROM ${savedPostMoves} WHERE ${savedPostMoves.userId} = ${userId} AND ${savedPostMoves.batchId} = ${id} AND ${savedPostMoves.moveKind} = 'personal')`,
        ),
      ),
    db
      .update(savedPosts)
      .set({ batchId: null })
      .where(and(eq(savedPosts.userId, userId), sql`${savedPosts.batchId} IN (SELECT ${saveBatches.id} FROM ${saveBatches} WHERE ${emptyHeld})`)),
    db.delete(saveBatches).where(emptyHeld),
    db.insert(saveBatches).values({
      id, userId, status: "held", theme: input.theme?.trim() || null, createdAt: now, releasedAt: null, savedAt: null, fittedAt: null, notice: null,
    }),
  ]);
  return readBatch(db, userId, id, now);
}

/** The batch with its counts, whether another batch is open, and its kept rows' moves as `noticeOf` reads them. */
interface ReleaseRead extends BatchRead {
  otherOpen: number;
  moveId: string | null;
  moveKind: string | null;
  moveStatus: string | null;
  moveBatchId: string | null;
  regions: unknown;
  contraction: unknown;
}

/**
 * Release a held batch: released now, with its notice worded from its kept rows (as `assembleBatch` words one) — but
 * never while another batch of the account's is open ("batch_open", `openBatchSql`: one batch at a time, spec §5), and
 * never with no row to show ("nothing_to_release": every row was removed — "0 moves you already had" says nothing).
 * D1 statements: the batch with its rows' moves and whether another batch is open 1, the write 1.
 */
export async function releaseBatch(
  db: Db,
  userId: string,
  batchId: string,
  now: string,
): Promise<SaveBatchDto | "not_found" | "conflict" | "batch_open" | "nothing_to_release"> {
  const rows = (await db.all(sql`select ${BATCH_COLUMNS},
      exists (select 1 from save_batches o where o.user_id = b.user_id and o.id <> b.id and ${openBatchSql("o")}) as otherOpen,
      l.move_id as moveId, l.move_kind as moveKind, pm.status as moveStatus, pm.batch_id as moveBatchId,
      json_extract(pm.record, '$.regions') as regions, json_extract(pm.record, '$.contraction') as contraction
    from save_batches b
      left join saved_post_moves l on l.batch_id = b.id and l.user_id = b.user_id and l.status = 'pending'
      left join personal_moves pm on pm.id = l.move_id and pm.user_id = b.user_id
    where b.id = ${batchId} and b.user_id = ${userId}`)) as ReleaseRead[];
  const first = rows[0];
  if (!first) return "not_found";
  if (first.status !== "held") return "conflict";
  if (Number(first.otherOpen)) return "batch_open";
  if (!rows.some((r) => r.moveId)) return "nothing_to_release";
  const notice = noticeOf(rows, batchId);
  await db
    .update(saveBatches)
    .set({ status: "released", releasedAt: now, notice })
    .where(and(eq(saveBatches.id, batchId), eq(saveBatches.userId, userId), eq(saveBatches.status, "held")));
  return { ...batchOf(first, now), status: "released", releasedAt: now, notice };
}

// ── The one path: the open batch, Fit them in, not now, a fit that could not start ─────────────────────────────────

/** `readOpenBatch`'s one read: the open batch as JSON (or null), and how many matched posts wait with a new move. */
interface OpenRead {
  open: string | null;
  waiting: number;
}

/**
 * The open batch (`openBatchSql`; the newest, though one is open at a time) as ONE JSON value — its id, its fit's start
 * and whether its card is still open (`pinsOpenSql`), its NEW and LINKED counts (as the list counts them), and each
 * kept row's new move with the regions and contraction the groups read, and where the move first shows (post first
 * seen, post id, position) so the groups keep the posts' order — and `waiting`: the matched posts in no batch yet with a
 * pending link to a pending personal move (what `assembleBatch` would cut). Two scalar subqueries, one statement.
 */
function openReadSql(userId: string) {
  return sql`select
    (select json_object('id', b.id, 'fitStartedAt', b.fit_started_at, 'pinsOpen', ${pinsOpenSql("b")},
        'new', ${FRESH_COUNT}, 'linked', ${LINKED_COUNT},
        'moves', (select json_group_array(json_array(l.move_id, p.first_seen_at, p.id, l.position,
              json_extract(pm.record, '$.regions'), json_extract(pm.record, '$.contraction')))
            from saved_post_moves l
              join saved_posts p on p.id = l.post_id and p.user_id = l.user_id
              left join personal_moves pm on pm.id = l.move_id and pm.user_id = l.user_id
            where l.user_id = b.user_id and l.batch_id = b.id and l.status <> 'removed' and ${NEW_IN_BATCH}))
      from save_batches b
      where b.user_id = ${userId} and ${openBatchSql("b")}
      order by coalesce(b.released_at, b.created_at) desc, b.id desc
      limit 1) as open,
    (select count(*) from saved_posts w
      where w.user_id = ${userId} and w.status = 'matched' and w.batch_id is null
        and exists (select 1 from saved_post_moves wl
          join personal_moves wm on wm.id = wl.move_id and wm.user_id = wl.user_id
          where wl.user_id = w.user_id and wl.post_id = w.id and wl.status = 'pending' and wl.move_kind = 'personal'
            and wm.status = 'pending')) as waiting`;
}

/** A JSON value as SQLite hands it over: parsed when it is text (a subquery's JSON may arrive as text). */
const jsonValue = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

/** `openReadSql`'s open batch as the card reads it: the groups of its new moves, each once, in the posts' order. */
function openOf(raw: unknown, now: string): OpenSavesBatchDto | null {
  const o = jsonValue(raw) as { id?: unknown; fitStartedAt?: unknown; pinsOpen?: unknown; new?: unknown; linked?: unknown; moves?: unknown } | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string") return null;
  const list = jsonValue(o.moves);
  const seen = (Array.isArray(list) ? list : []).flatMap((x) => {
    const [moveId, firstSeen, postId, position, regions, contraction] = Array.isArray(x) ? (x as unknown[]) : [];
    return typeof moveId === "string"
      ? [{ moveId, key: [text(firstSeen) ?? "", text(postId) ?? ""] as const, position: Number(position ?? 0), regions, contraction }]
      : [];
  });
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  seen.sort((a, b) => cmp(a.key[0], b.key[0]) || cmp(a.key[1], b.key[1]) || a.position - b.position);
  const moves = new Map<string, Pick<ExerciseRecord, "regions" | "contraction">>();
  for (const m of seen) {
    if (!moves.has(m.moveId)) {
      moves.set(m.moveId, {
        regions: parseList(m.regions) as ExerciseRecord["regions"],
        contraction: parseList(m.contraction) as ExerciseRecord["contraction"],
      });
    }
  }
  const groups = groupCounts([...moves.values()]);
  const counts = { new: Number(o.new ?? 0), linked: Number(o.linked ?? 0) };
  const fitting = isFitting(text(o.fitStartedAt), now, Boolean(Number(o.pinsOpen ?? 0)));
  return { id: o.id, counts, groups, line: savesCardLine(counts, groups), fitting };
}

/**
 * The open batch the Today card, the coach's chip and its saves card are about (spec §3.1–§3.2): its id, its counts
 * (new, already yours), its new moves' groups and the card's line (`savesCardLine`), and whether a fit is at work
 * (`isFitting`: the hour, or its card still open). `{ open: null }` when none is open. With none open and new moves
 * waiting, the next batch is cut here (`assembleBatch`) — never while batches are held (`SAVES_HOLD_BATCHES`) — and the
 * open batch read again: the cut's id is only the one it tried to write, so the read is what says a batch is open.
 * D1 statements: ONE; when it cuts, the cut's (7, or 8) and the read again.
 */
export async function readOpenBatch(db: Db, env: Env, userId: string, now: string): Promise<OpenSavesDto> {
  const read = async (): Promise<OpenRead | undefined> => ((await db.all(openReadSql(userId))) as OpenRead[])[0];
  let row = await read();
  if (row && row.open === null && Number(row.waiting) > 0 && env.SAVES_HOLD_BATCHES !== "1") {
    await assembleBatch(db, env, userId, now);
    row = await read();
  }
  return { open: openOf(row?.open ?? null, now) };
}

export type FitOutcome =
  | { kind: "ok"; answer: FitAnswerDto }
  | { kind: "not_found" }
  | { kind: "conflict"; error: "fitting" | "batch_open" | "already_fitted" | "not_released" | "empty" };

/** The batch `fitBatch` reads: its state, whether another batch of the account's is open, and what a saved batch holds. */
interface FitRead {
  status: SaveBatchDto["status"];
  fittedAt: string | null;
  fitStartedAt: string | null;
  /** A card of the moves in rotation naming it is still open (`pinsOpenSql`): 1 or 0. */
  pinsOpen: number;
  otherOpen: number;
  /** The batch's active moves (the new moves its save made usable), and its saved links. */
  moves: number;
  links: number;
  /** Whether it still keeps a row (a link pending or saved). */
  kept: number;
}

/**
 * "Fit them in" (spec §3.2, §4, §12.1, §12.3): the batch saved with the owner's choices (`{ moveId: include | skip }`;
 * a new move left out is the coach's call) and its fit started — the answer is the request the app sends the coach.
 * `choices` undefined is the one-tap fit (Today, the coach's card, the list: the final fix wave), which keeps what the
 * owner chose on the page; the page's Fit these in always sends its whole set.
 *  - a `released` batch: `saveBatch` with the choices (the save route's own writes: the moves, the provenance, the
 *    coach's memory), its fit started, no longer put aside — nothing is stored yet, so undefined is `{}`;
 *  - a `saved` batch (a re-fit once a fit's card was declined, or a batch saved before): its choices rewritten and its
 *    fit started, in one transaction of 2 — nothing is saved twice; with `choices` undefined the stored choices stand,
 *    and the transaction is the claim alone (1).
 * Refused, in order: another account's batch (not found); one already fitted in; one never released (held) or
 * dissolved (superseded); one every row of which was removed (`empty`, the final fix wave: a fit of nothing; it is no
 * open batch either); one whose fit is at work (`isFitting`: the hour, or its card still open — a second tap never
 * starts a second run); one while another batch is open (`openBatchSql`: a dismissed batch comes back only when no
 * other is open, §12.3).
 * The read only answers why; the writes themselves claim the fit (`fitClaimSql`, checked again in the transaction, its
 * last write counted): a tap that loses to another between the read and the write — the other's fit started, or the
 * batch saved since — writes nothing, its choices included, and is refused as `fitting`.
 * D1 statements: the batch with whether another is open 1, then `saveBatch` with the choices (7) — or, for a saved
 * batch, the transaction of 2 (of 1 with `choices` undefined).
 */
export async function fitBatch(
  db: Db,
  userId: string,
  batchId: string,
  choices: Record<string, FitChoice> | undefined,
  now: string,
): Promise<FitOutcome> {
  const [b] = (await db.all(sql`select b.status as status, b.fitted_at as fittedAt, b.fit_started_at as fitStartedAt,
      ${pinsOpenSql("b")} as pinsOpen,
      exists (select 1 from save_batches o where o.user_id = b.user_id and o.id <> b.id and ${openBatchSql("o")}) as otherOpen,
      (select count(*) from personal_moves m where m.user_id = b.user_id and m.batch_id = b.id and m.status = 'active') as moves,
      (select count(*) from saved_post_moves l where l.user_id = b.user_id and l.batch_id = b.id and l.status = 'saved') as links,
      exists (select 1 from saved_post_moves k where k.user_id = b.user_id and k.batch_id = b.id and k.status in ('pending','saved')) as kept
    from save_batches b
    where b.id = ${batchId} and b.user_id = ${userId}
    limit 1`)) as FitRead[];
  if (!b) return { kind: "not_found" };
  if (b.fittedAt) return { kind: "conflict", error: "already_fitted" };
  if (b.status !== "released" && b.status !== "saved") return { kind: "conflict", error: "not_released" };
  if (!Number(b.kept)) return { kind: "conflict", error: "empty" };
  if (isFitting(b.fitStartedAt, now, Boolean(Number(b.pinsOpen)))) return { kind: "conflict", error: "fitting" };
  if (Number(b.otherOpen)) return { kind: "conflict", error: "batch_open" };
  const ok = (moves: number, links: number): FitOutcome => ({ kind: "ok", answer: { batchId, request: FIT_SAVES_REQUEST, moves, links } });

  const lost: FitOutcome = { kind: "conflict", error: "fitting" };

  if (b.status === "released") {
    const saved = await saveBatch(db, userId, batchId, now, { at: now, choices: choices ?? {} });
    if (saved === "lost") return lost;
    return saved ? ok(saved.moves, saved.links) : { kind: "not_found" };
  }
  // A saved batch: its choices (when sent) only while the claim holds, then the claim itself (the transaction's last
  // write). Not sent, the stored choices stand.
  const gate = fitClaimSql(userId, batchId, "saved", now);
  const claimed = await runAtomicallyClaim(db, [
    ...(choices ? [choicesWrite(db, userId, batchId, choices, gate)] : []),
    db
      .update(saveBatches)
      .set({ fitStartedAt: now, dismissedAt: null })
      .where(and(eq(saveBatches.id, batchId), eq(saveBatches.userId, userId), gate))
      .returning({ id: saveBatches.id }),
  ]);
  return claimed ? ok(Number(b.moves), Number(b.links)) : lost;
}

/** Whether the batch is this account's (a refused write's second read: why it was refused). */
async function batchExists(db: Db, userId: string, batchId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: saveBatches.id })
    .from(saveBatches)
    .where(and(eq(saveBatches.id, batchId), eq(saveBatches.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/**
 * "Not now" (spec §3.2, §12.3): the open batch put aside — `dismissed_at` set, and nothing else. It is never saved: its
 * moves and links stay pending, nothing enters the library or the coach's memory, and the next batch can open. Only an
 * open batch whose fit is not at work (a fit under way, or its card still open, is the coach's now); else "conflict".
 * D1 statements: the write 1 (the batch read 1 more when it matched nothing).
 */
export async function dismissBatch(db: Db, userId: string, batchId: string, now: string): Promise<"ok" | "not_found" | "conflict"> {
  const done = await db
    .update(saveBatches)
    .set({ dismissedAt: now })
    .where(
      and(
        eq(saveBatches.id, batchId),
        eq(saveBatches.userId, userId),
        openBatchSql("save_batches"),
        notFittingSql("save_batches", now),
      ),
    )
    .returning({ id: saveBatches.id });
  if (done.length) return "ok";
  return (await batchExists(db, userId, batchId)) ? "conflict" : "not_found";
}

/**
 * A fit whose run could not start (a run already at work, the week's budget, offline — spec §4, §12.1): its start
 * cleared at once, so the card offers "Fit them in" again rather than "Fitting in…" for the hour. The save stands. A
 * batch already fitted in keeps its fit (nothing to cancel). D1 statements: the write 1 (the batch read 1 more when it
 * matched nothing).
 */
export async function cancelFit(db: Db, userId: string, batchId: string): Promise<"ok" | "not_found"> {
  const done = await db
    .update(saveBatches)
    .set({ fitStartedAt: null })
    .where(and(eq(saveBatches.id, batchId), eq(saveBatches.userId, userId), isNull(saveBatches.fittedAt)))
    .returning({ id: saveBatches.id });
  if (done.length) return "ok";
  return (await batchExists(db, userId, batchId)) ? "ok" : "not_found";
}
