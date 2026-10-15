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
import { and, asc, desc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { coachMemory } from "@rg/database";
import type { Db } from "./db.js";

/** The pinned core's size: pinned items, then recent facts and rules. */
export const MEMORY_CORE = 20;

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
