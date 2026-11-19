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
import { runAtomically, type AtomicStatement, type Db } from "./db.js";
import { sha256Hex } from "../auth/crypto.js";

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
  /** A drift's conclusion (where you stand, spec §7.2): the chip's id and the day to look again. */
  drift?: string;
  checkBack?: string;
}

/** R1 (3c): an item the owner told the training coach from LifeOS, by a tap on the exact sentence shown (`training_tell`). */
export const LIFEOS_SOURCE = "lifeos";
export interface LifeosMemoryProvenance {
  source: typeof LIFEOS_SOURCE;
  /** The phone that sent it (`native_devices.id`). */
  deviceId: string;
  at: string;
}

/** Where a memory v2 item came from: a coach's run, a saved post, or the owner's tap in LifeOS. */
export type MemoryProvenance = DesignMemoryProvenance | SavedPostMemoryProvenance | LifeosMemoryProvenance;

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

// ── R1: what the owner tells the training coach from LifeOS ──────────────────────────────────────────────────────────

/** A told item's words, at most: one line (DESIGN-3 §3.7). */
export const STATED_BODY_MAX = 140;
/** The kinds the owner may tell: never an observation, which is learned from outcomes. */
export const STATED_KINDS = ["note", "fact", "rule"] as const;
/** A told note's life: a note is time-boxed, as the coach's own are. */
export const STATED_NOTE_DAYS = 30;

/** One line of at most 140 characters, no control characters; or null. */
export function statedBodyOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const body = v.trim();
  // eslint-disable-next-line no-control-regex
  return body.length >= 1 && body.length <= STATED_BODY_MAX && !/[\u0000-\u001f\u007f]/.test(body) ? body : null;
}

/**
 * THE OWNER'S OWN WORDS, TOLD FROM LIFEOS (R1, 3c; DESIGN-3 §3.7 pair 24): an item of the training coach's memory with
 * confidence `stated` and provenance `lifeos`, written only on the owner's tap (the route). Keyed by the phone's `clientId`,
 * so a resend is the same item (`repeated`). Run-garden's own rule against two of the same: a live item of the same kind
 * saying the same words (case and spacing aside) is answered as it is, nothing written (`existing`) — the told item never
 * replaces anything else, so nothing the owner confirmed is ever superseded from the phone. A note lasts STATED_NOTE_DAYS.
 */
export async function addStatedMemory(
  db: Db,
  userId: string,
  input: { kind: (typeof STATED_KINDS)[number]; body: string; clientId: string; deviceId: string },
  now: string,
  today: string,
  addDays: (d: string, n: number) => string,
): Promise<{ item: typeof coachMemory.$inferSelect; repeated?: true; existing?: true }> {
  const m = coachMemory;
  const id = `mem:lifeos:${(await sha256Hex(`${userId}|${input.clientId}`)).slice(0, 32)}`;
  const [again] = await db.select().from(m).where(and(eq(m.id, id), eq(m.userId, userId))).limit(1);
  if (again) return { item: again, repeated: true };
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const live = await db
    .select()
    .from(m)
    .where(and(eq(m.userId, userId), eq(m.kind, input.kind), eq(m.active, true), isNull(m.supersededBy)));
  const same = live.find((x) => norm(x.body) === norm(input.body) && (x.expiresAt === null || x.expiresAt >= today));
  if (same) return { item: same, existing: true };
  const writes = memoryWrites(db, {
    id,
    userId,
    kind: input.kind,
    body: input.body,
    confidence: "stated",
    evidence: null,
    expiresAt: input.kind === "note" ? addDays(today, STATED_NOTE_DAYS) : null,
    provenance: { source: LIFEOS_SOURCE, deviceId: input.deviceId, at: now },
  });
  await runAtomically(db, writes);
  const [item] = await db.select().from(m).where(and(eq(m.id, id), eq(m.userId, userId))).limit(1);
  return { item: item! };
}
