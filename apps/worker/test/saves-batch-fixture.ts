/**
 * A batch from the athlete's saves, as saving one leaves it (saved-posts import, Task 17): its posts (example.com links,
 * made-up creators, a model's reading in `extraction`), the personal moves the batch brought (active once saved, their
 * `batch_id` the batch's), and the links (`saved_post_moves`, `saved`) from each post's position to a move — a library
 * move or one of the batch's own. Inserted directly, so a test or a bench shapes the batch it needs. Synthetic data only.
 */
import { schema } from "@rg/database";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import { personalMoveId, type ExtractedMove } from "@rg/saves";
import type { Db } from "../src/services/db.js";
import { toPersonalRecord } from "../src/services/personal-records.js";

const { savedPosts, savedPostMoves, personalMoves, saveBatches, exercisePrefs } = schema;

const RATINGS = Object.fromEntries(
  Object.values(PROFILES).map((p) => [
    p.id,
    { attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])), note: "Fine." },
  ]),
) as ExtractedMove["conditions"];

/** An extracted move, as the reading of a post gives one. */
export const savedMoveDraft = (name: string, over: Partial<ExtractedMove> = {}): ExtractedMove => ({
  name, aliases: [], summary: `${name}, slow and even.`, steps: ["Start.", "Finish."], cues: [], mistakes: [], purpose: "mobility",
  dose: { text: "8 each side", type: "reps", range: [6, 10] }, patterns: ["mobility"], regions: ["hips"], equipment: [], position: "seated",
  laterality: "alternating", load: "none", contraction: ["isotonic"], difficulty: 2, conditions: RATINGS,
  evidence: { name: "stated", dose: "inferred", steps: "stated" }, confidence: "high", ...over,
});

/** A move one of the batch's posts shows: a library move by id, or a new one by its draft (the batch brings it). */
export type SavedLink = { library: string } | { draft: ExtractedMove };

export interface SavedPostSpec {
  /** Its moves, by position. */
  moves: SavedLink[];
  kind?: "routine" | "single_move" | "tips";
  summary?: string;
  handle?: string;
  name?: string | null;
  url?: string;
  /** A position whose link the owner removed before saving. */
  removed?: number[];
}

export interface SeededBatch {
  batchId: string;
  postIds: string[];
  /** Each post's move ids, by position. */
  moveIds: string[][];
}

let seq = 0;

/**
 * A batch of the account's with `posts`: `status` saved unless said (`savedAt` then stamped), unfitted unless
 * `fittedAt`. A draft named twice in the batch makes one move with a link from each post. `pinned` move ids get a pin.
 */
export async function seedSavedBatch(
  db: Db,
  userId: string,
  o: { savedAt: string; posts: SavedPostSpec[]; status?: "held" | "released" | "saved" | "dismissed"; fittedAt?: string | null; pinned?: string[] },
): Promise<SeededBatch> {
  const n = ++seq;
  const batchId = `batch-${n}-${userId.slice(0, 8)}`;
  const status = o.status ?? "saved";
  await db.insert(saveBatches).values({
    id: batchId, userId, status, theme: null, createdAt: o.savedAt, releasedAt: o.savedAt, savedAt: status === "saved" ? o.savedAt : null,
    fittedAt: o.fittedAt ?? null, notice: "From your saves.",
  });
  const born = new Map<string, string>();
  const postIds: string[] = [];
  const moveIds: string[][] = [];
  for (const [i, post] of o.posts.entries()) {
    const postId = `post-${n}-${i}-${userId.slice(0, 8)}`;
    postIds.push(postId);
    const seen = new Date(Date.parse(o.savedAt) - (o.posts.length - i) * 60_000).toISOString();
    const drafts = post.moves.flatMap((m) => ("draft" in m ? [m.draft] : []));
    await db.insert(savedPosts).values({
      id: postId, userId, source: "testsrc", sourceKey: `k${n}-${i}`, url: post.url ?? `https://example.com/p/${n}-${i}`,
      creatorHandle: post.handle ?? `coach_${i}`, creatorName: post.name === undefined ? `Coach ${i}` : post.name, caption: "", hashtags: [], mediaType: "video",
      firstSeenAt: seen, status: "matched",
      extraction: { kind: post.kind ?? "routine", summary: post.summary ?? `A short routine, post ${i}.`, themes: [], moves: drafts },
      extractAttempts: 1, batchId, updatedAt: seen,
    });
    const ids: string[] = [];
    for (const [position, m] of post.moves.entries()) {
      let moveId: string;
      if ("library" in m) {
        if (!EXERCISES.some((e) => e.id === m.library)) throw new Error(`no library move ${m.library}`);
        moveId = m.library;
      } else {
        moveId = born.get(m.draft.name) ?? personalMoveId(m.draft.name, `${userId}:${batchId}:${m.draft.name}`);
        if (!born.has(m.draft.name)) {
          born.set(m.draft.name, moveId);
          await db.insert(personalMoves).values({
            id: moveId, userId, status: "active", mergedInto: null, batchId, record: toPersonalRecord(moveId, m.draft), editedByOwner: false,
            createdAt: seen, updatedAt: o.savedAt,
          });
        }
      }
      ids.push(moveId);
      await db.insert(savedPostMoves).values({
        id: `spm-${postId}-${position}`, userId, postId, position, moveId, moveKind: "library" in m ? "library" : "personal", batchId,
        confidence: 0.9, checkFlag: false, status: post.removed?.includes(position) ? "removed" : status === "saved" ? "saved" : "pending", createdAt: seen,
      });
    }
    moveIds.push(ids);
  }
  for (const id of o.pinned ?? []) {
    await db.insert(exercisePrefs).values({ id: `${userId}:${id}`, userId, exerciseId: id, pinned: true, updatedAt: o.savedAt }).onConflictDoNothing();
  }
  return { batchId, postIds, moveIds };
}

/** Text of `n` characters exactly, starting with `lead`. */
export const longText = (lead: string, n: number): string => (lead + " " + "slow and even through the whole range ".repeat(20)).slice(0, n);

/**
 * Twelve new moves at their longest — an 80-character name, a 160-character summary — across four routine posts of
 * three, each post with a long link, creator and reading: the most read_saves or the context's section holds.
 */
export function longBatchPosts(lead = "LONG"): SavedPostSpec[] {
  return [0, 1, 2, 3].map((p) => ({
    kind: "routine" as const,
    summary: longText(`${lead}-reading-${p}`, 300),
    handle: longText(`${lead}-handle-${p}`, 64).replace(/ /g, "_"),
    url: `https://example.com/${"p".repeat(120)}/${lead}-${p}`,
    moves: [0, 1, 2].map((m) => ({
      draft: savedMoveDraft(longText(`${lead} move ${p * 3 + m}`, 80), { summary: longText(`${lead}-summary-${p * 3 + m}`, 160) }),
    })),
  }));
}
