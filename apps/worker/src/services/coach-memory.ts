/**
 * MEMORY V2, WRITTEN (Stage 3 spec §9; principles §6.7). One item a row of `coach_memory`, with the v2 fields
 * migration 0028 added: `confidence` (stated — the athlete said it; inferred — the coach's own conclusion; confirmed —
 * the athlete confirmed it, which only the athlete's own action ever sets), `evidence` (what supports an observation,
 * JSON as text), `pinned`, `superseded_by` (a newer item that replaces one keeps it, as history) and `updated_at`.
 * Provenance says where an item came from and when; a rehearsal run's item says so (`provenance.rehearsal`), and the
 * memory every run reads (memory-core.ts) never includes it.
 *
 * What is live and what rides in the pinned core is read in memory-core.ts; this is the writing side.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { coachMemory } from "@rg/database";
import type { AtomicStatement, Db } from "./db.js";

export const MEMORY_KINDS = ["fact", "rule", "note", "observation"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** What the coach may write. `confirmed` is the athlete's alone. */
export const COACH_CONFIDENCES = ["stated", "inferred"] as const;
export type CoachConfidence = (typeof COACH_CONFIDENCES)[number];

/** The provenance source of an item kept from a saved post's insights (saved-posts import, spec §17). */
export const SAVED_POST_SOURCE = "saved post";

/**
 * Where an item kept from a saved post came from (spec §17): written only by Save (saves-batches.ts `insightWrites`,
 * set-based, so as SQL rather than through `memoryWrites`) — the post, its link, and when. An `observation` the coach
 * `inferred`: live and outside the pinned core like any other, unless the athlete pins it.
 */
export interface SavedPostMemoryProvenance {
  source: typeof SAVED_POST_SOURCE;
  postId: string;
  url: string | null;
  at: string;
}

/** Where a coach-designer item came from. */
export interface DesignMemoryProvenance {
  /** The athlete's words (stated), or the coach's inference. */
  source: "athlete_words" | "coach_inference";
  /** The main run whose tree wrote it. */
  runId: string;
  role: "main" | "designer";
  at: string;
  /** Written by a rehearsal run: never the athlete's memory. */
  rehearsal?: true;
}

/** Where a memory v2 item came from: a coach's run, or a saved post. */
export type MemoryProvenance = DesignMemoryProvenance | SavedPostMemoryProvenance;

export interface NewMemory {
  id: string;
  userId: string;
  kind: MemoryKind;
  body: string;
  confidence: CoachConfidence;
  evidence: string[] | null;
  /** A note's last day (the athlete's local date). */
  expiresAt: string | null;
  provenance: MemoryProvenance;
  /** The item this one replaces: kept, marked superseded by this one. */
  replaces?: string;
}

/**
 * The statements that write `m` — the row, and (when it replaces one) the older item marked superseded — for one
 * atomic batch. A replay of the same id writes nothing new, and an item already superseded is never re-pointed. A
 * replacement keeps the pin of the item it replaces (fix wave 3B, A-M1), read in its own insert while that item is
 * still live: the athlete's pins stay as many as they were, each where they put it.
 */
export function memoryWrites(db: Db, m: NewMemory): AtomicStatement[] {
  const pinned = m.replaces
    ? sql`coalesce((select ${coachMemory.pinned} from ${coachMemory} where ${coachMemory.id} = ${m.replaces} and ${coachMemory.userId} = ${m.userId}
        and ${coachMemory.active} = 1 and ${coachMemory.supersededBy} is null), 0)`
    : false;
  const writes: AtomicStatement[] = [
    db
      .insert(coachMemory)
      .values({
        id: m.id,
        userId: m.userId,
        kind: m.kind,
        body: m.body,
        provenance: m.provenance as unknown as typeof coachMemory.$inferInsert.provenance,
        learnedAt: m.provenance.at,
        expiresAt: m.expiresAt,
        active: true,
        pinned,
        confidence: m.confidence,
        supersededBy: null,
        evidence: m.evidence ? JSON.stringify(m.evidence) : null,
        updatedAt: m.provenance.at,
      })
      .onConflictDoNothing(),
  ];
  if (m.replaces) {
    writes.push(
      db
        .update(coachMemory)
        .set({ supersededBy: m.id, updatedAt: m.provenance.at })
        .where(and(eq(coachMemory.id, m.replaces), eq(coachMemory.userId, m.userId), isNull(coachMemory.supersededBy))),
    );
  }
  return writes;
}
