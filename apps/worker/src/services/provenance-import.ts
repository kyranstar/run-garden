/**
 * SAVED-POST LINKS INTO THE ACCOUNT (Phase 2 spec §2c "Provenance import"; plan 2c Task 6).
 *
 * The owner builds a provenance file on their own machine (`apps/worker/scripts/build-provenance.mjs`, which reads the
 * private saves and writes outside the repository) and imports it from Settings → Import → "Saved-post links…". Each
 * item says where a library move was seen: `{exerciseId, sourceType, url, creator, sourceKey}`.
 *
 *  - Upserted into `exercise_provenance` by (user, source type, source key): a link already there with the same move,
 *    URL and creator is left alone, a changed one is updated in place (its row and first-seen date kept), a new one is
 *    added — so the same file imported twice writes nothing the second time.
 *  - A move id is read through the library's legacy ids; an id the library doesn't have is left out and counted.
 *  - One source twice in a file is one link (the later wins).
 *  - Refused while a restore is replacing the account; the dry run (the summary before Import) writes nothing.
 *  - Links are web links only, the file at most `MAX_PROVENANCE_ITEMS` items; the route caps the body's size.
 *
 * The answer is counts only: a link or a creator never travels back.
 */
import { eq, sql } from "drizzle-orm";
import { z, type ZodIssue } from "zod";
import { exerciseProvenance } from "@rg/database";
import { newId } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { restoreInProgress } from "./account-state.js";
import { insertBatches, runAtomically, type Db } from "./db.js";
import { RestoreInProgressError } from "./programs.js";

export const PROVENANCE_FORMAT = "rg-provenance";
export const PROVENANCE_VERSION = 1;
export const MAX_PROVENANCE_ITEMS = 5000;

const isWebLink = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const itemSchema = z.object({
  exerciseId: z.string().min(1).max(200),
  sourceType: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "must be a short lowercase name"),
  url: z.string().max(2000).refine(isWebLink, "must be a web address").nullable().optional(),
  creator: z.string().max(200).nullable().optional(),
  sourceKey: z.string().min(1).max(300),
});

const fileSchema = z.object({
  format: z.literal(PROVENANCE_FORMAT),
  version: z.literal(PROVENANCE_VERSION),
  items: z.array(itemSchema).max(MAX_PROVENANCE_ITEMS),
});

export type InvalidProvenanceReason = "newer_version";

export class InvalidProvenanceError extends Error {
  constructor(
    public readonly issues: ReadonlyArray<Pick<ZodIssue, "message" | "path">>,
    public readonly reason: InvalidProvenanceReason | null = null,
  ) {
    super("invalid_provenance");
  }
}

export interface ProvenanceImportSummary {
  dryRun: boolean;
  /** Links in the file (one per source). */
  items: number;
  /** Library moves those links name. */
  moves: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Links whose move this library doesn't have — left out. */
  unknownMoves: number;
}

function parseFile(body: unknown): z.infer<typeof fileSchema> {
  const raw = body as { format?: unknown; version?: unknown } | null;
  if (raw && typeof raw === "object" && raw.format === PROVENANCE_FORMAT && typeof raw.version === "number" && raw.version > PROVENANCE_VERSION) {
    throw new InvalidProvenanceError([{ path: ["version"], message: "a newer provenance file than this app reads" }], "newer_version");
  }
  const parsed = fileSchema.safeParse(body);
  if (!parsed.success) throw new InvalidProvenanceError(parsed.error.issues.map(({ path, message }) => ({ path, message })));
  return parsed.data;
}

/** A library move's id from any id it has had. */
function canonicalOf(exercises: readonly ExerciseRecord[]): (id: string) => string | null {
  const ids = new Map<string, string>();
  for (const e of exercises) for (const old of e.legacyIds) if (!ids.has(old)) ids.set(old, e.id);
  for (const e of exercises) ids.set(e.id, e.id);
  return (id) => ids.get(id) ?? null;
}

const pairOf = (sourceType: string, sourceKey: string) => `${sourceType}\u0000${sourceKey}`;

export async function importProvenance(
  db: Db,
  userId: string,
  body: unknown,
  o: { now: string; dryRun: boolean; exercises?: readonly ExerciseRecord[] },
): Promise<ProvenanceImportSummary> {
  const file = parseFile(body);
  const canonical = canonicalOf(o.exercises ?? EXERCISES);

  const bySource = new Map<string, z.infer<typeof itemSchema>>();
  for (const item of file.items) {
    const pair = pairOf(item.sourceType, item.sourceKey);
    bySource.delete(pair); // the later one wins, in its own place
    bySource.set(pair, item);
  }

  const existing = new Map(
    (
      await db
        .select({
          sourceType: exerciseProvenance.sourceType,
          sourceKey: exerciseProvenance.sourceKey,
          exerciseId: exerciseProvenance.exerciseId,
          url: exerciseProvenance.url,
          creator: exerciseProvenance.creator,
        })
        .from(exerciseProvenance)
        .where(eq(exerciseProvenance.userId, userId))
    ).flatMap((r) => (r.sourceKey === null ? [] : [[pairOf(r.sourceType, r.sourceKey), r] as const])),
  );

  const summary: ProvenanceImportSummary = { dryRun: o.dryRun, items: bySource.size, moves: 0, added: 0, updated: 0, unchanged: 0, unknownMoves: 0 };
  const moves = new Set<string>();
  const writes: Array<typeof exerciseProvenance.$inferInsert> = [];
  for (const [pair, item] of bySource) {
    const exerciseId = canonical(item.exerciseId);
    if (!exerciseId) {
      summary.unknownMoves += 1;
      continue;
    }
    moves.add(exerciseId);
    const url = item.url ?? null;
    const creator = item.creator ?? null;
    const before = existing.get(pair);
    if (before && before.exerciseId === exerciseId && before.url === url && before.creator === creator) {
      summary.unchanged += 1;
      continue;
    }
    if (before) summary.updated += 1;
    else summary.added += 1;
    writes.push({ id: newId(), userId, exerciseId, sourceType: item.sourceType, url, creator, sourceKey: item.sourceKey, createdAt: o.now });
  }
  summary.moves = moves.size;
  if (o.dryRun || writes.length === 0) return summary;

  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
  // One upsert per batch, all in one transaction: a changed link keeps its row (id, first-seen date) and takes the
  // file's move, link and creator.
  await runAtomically(
    db,
    insertBatches(writes).map((batch) =>
      db
        .insert(exerciseProvenance)
        .values(batch)
        .onConflictDoUpdate({
          target: [exerciseProvenance.userId, exerciseProvenance.sourceType, exerciseProvenance.sourceKey],
          set: { exerciseId: sql`excluded.exercise_id`, url: sql`excluded.url`, creator: sql`excluded.creator` },
        }),
    ),
  );
  return summary;
}
