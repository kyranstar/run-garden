/**
 * THE COACH'S MEMORY — WHAT IS LIVE, AND THE PINNED CORE (Stage 3 spec §9; principles §6.7). One definition, shared by
 * the designer's opening context (design-context.ts: the core in the cached system blocks, and the index's count of
 * what lies beyond it) and `recall_memory` (design-tools/read-memory.ts: everything live beyond the core), so the two
 * can never disagree about what the coach already holds.
 *
 * Live: active, not superseded, not expired by the athlete's today (an expiry is a local date, or an instant compared
 * as text), and not written by a rehearsal run (`provenance.rehearsal`: the live scenario suite's runs are never the
 * athlete's memory). The core: live items that are pinned, or are facts or rules — pinned first, then the most
 * recently learned or updated — at most MEMORY_CORE.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { coachMemory } from "@rg/database";
import type { Db } from "./db.js";

/** The pinned core's size: pinned items, then recent facts and rules. */
export const MEMORY_CORE = 20;

/**
 * The zone whose local date is the earliest anywhere at any moment (UTC−12; POSIX's sign is inverted): what "live"
 * means to a read with no timezone in hand — the memory list, its edits, and an undo's pin count — so an item still
 * live somewhere counts, and the hourly sweep retires one that lapsed in the athlete's own zone.
 */
export const EARLIEST_ZONE = "Etc/GMT+12";

/**
 * Pinned items, at most (Stage 3 Task 10): every one rides in the core — inside its MEMORY_CORE items, so the cached
 * memory block stays the size the opening context already allows — with room left for recent facts and rules. A pin
 * past it is refused (`PATCH /api/coach/memory/:id`).
 */
export const MEMORY_PIN_CAP = 12;

const m = coachMemory;

/** A row a rehearsal run wrote (`provenance.rehearsal === true`; a provenance that does not read is no rehearsal). */
export const REHEARSAL_MEMORY: SQL = sql`coalesce(case when json_valid(${m.provenance}) then json_extract(${m.provenance}, '$.rehearsal') end, 0) = 1`;

/** The account's live memory on `today` (the athlete's local date). */
export function liveMemoryWhere(userId: string, today: string): SQL {
  return and(
    eq(m.userId, userId),
    eq(m.active, true),
    isNull(m.supersededBy),
    or(isNull(m.expiresAt), gte(m.expiresAt, today)),
    sql`not ${REHEARSAL_MEMORY}`,
  )!;
}

/** A row of `alias` a rehearsal run wrote: REHEARSAL_MEMORY for a row the query names by an alias. */
const rehearsalOf = (alias: string): SQL =>
  sql.raw(`coalesce(case when json_valid(${alias}.provenance) then json_extract(${alias}.provenance, '$.rehearsal') end, 0) = 1`);

/**
 * The account's superseded history (Task 10: the memory list shows it under the item that replaced it): items a newer
 * one superseded, never a rehearsal's, never one the athlete deleted — and only in a CHAIN WHOSE NEWEST ITEM IS LIVE on
 * `today` (fix wave 3B, A-M4): each item reached from a live item down `superseded_by`, through items still the
 * athlete's (not deleted, not a rehearsal's). An orphan — under an item the athlete deleted or one that expired, under
 * a row pointing anywhere but at another item (the migration's old `profile:` markers), or in a loop with no live end —
 * is nobody's history. A scalar subquery of the same statement (a recursive walk, `union` so a loop ends).
 */
export function memoryHistoryWhere(userId: string, today: string): SQL {
  const chain = sql`(with recursive chain(id) as (
      select ${m.id} from ${m} where ${liveMemoryWhere(userId, today)}
      union
      select h.id from coach_memory h join chain on h.superseded_by = chain.id
        where h.user_id = ${userId} and h.active = 1 and not ${rehearsalOf("h")}
    ) select id from chain)`;
  return and(eq(m.userId, userId), eq(m.active, true), isNotNull(m.supersededBy), sql`not ${REHEARSAL_MEMORY}`, sql`${m.id} in ${chain}`)!;
}

/** The core's rows: live, and pinned or a fact or rule. */
export function memoryCoreWhere(userId: string, today: string): SQL {
  return and(liveMemoryWhere(userId, today), or(eq(m.pinned, true), inArray(m.kind, ["fact", "rule"])))!;
}

/** The core's order: pinned first, then the most recently learned or updated. */
export const MEMORY_CORE_ORDER: SQL[] = [desc(m.pinned), desc(sql`coalesce(${m.updatedAt}, ${m.learnedAt})`), asc(m.id)];

/**
 * The core as the opening context lists it: one statement when awaited. A finished query, never a builder to go on
 * with — a second `.where()` (which would replace the core's own) is a type error, held by a test. Built for its
 * columns rather than any caller's: drizzle cannot carry a generic selection through the chain (nor through
 * `$dynamic()`, whose builder would take a second `.where()` anyway).
 */
export function memoryCore(db: Db, userId: string, today: string) {
  return db
    .select({ id: m.id, kind: m.kind, body: m.body, pinned: m.pinned, confidence: m.confidence })
    .from(m)
    .where(memoryCoreWhere(userId, today))
    .orderBy(...MEMORY_CORE_ORDER)
    .limit(MEMORY_CORE);
}

/** The core's ids, as a subquery (`notInArray(id, memoryCoreIds(…))`): the same rows as `memoryCore`. */
export function memoryCoreIds(db: Db, userId: string, today: string) {
  return db.select({ id: m.id }).from(m).where(memoryCoreWhere(userId, today)).orderBy(...MEMORY_CORE_ORDER).limit(MEMORY_CORE);
}
