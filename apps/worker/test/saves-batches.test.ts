/**
 * Batches: matched posts are gathered into at most one released batch per 20 h (or a held one while
 * SAVES_HOLD_BATCHES is on), with the notice the coach will read; nothing in a batch is usable until it is saved, and
 * saving writes the links into `exercise_provenance` once, in a constant number of statements however big the batch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EXERCISES, PROFILES, type ExerciseRecord } from "@rg/exercise-library";
import { batchNotice, type Extraction, type ExtractedMove } from "@rg/saves";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import { insertBatches, type Db } from "../src/services/db.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { matchPost } from "../src/services/saves-match.js";
import { assembleBatch, BATCH_GAP_MS, saveBatch } from "../src/services/saves-batches.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const { savedPosts, personalMoves, savedPostMoves, saveBatches, exerciseProvenance } = schema;
const T0 = "2026-10-23T10:00:00.000Z";
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const SRC = "testsrc";
const HIP_SWITCH = EXERCISES.find((e) => e.name === "90/90 hip switches")!;

let db: Db;
let userId: string;
let statements = 0;
let writes = 0;

const ratings = Object.fromEntries(
  Object.values(PROFILES).map((p) => [
    p.id,
    { attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])), note: "Fine." },
  ]),
) as ExtractedMove["conditions"];
const move = (name: string, over: Partial<ExtractedMove> = {}): ExtractedMove => ({
  name, aliases: [], summary: "A synthetic move.", steps: ["Start.", "Finish."], cues: [], mistakes: [], purpose: "mobility",
  dose: { text: "8", type: "reps", range: [6, 10] }, patterns: ["mobility"], regions: ["hips"], equipment: [], position: "seated",
  laterality: "alternating", load: "none", contraction: ["isotonic"], difficulty: 2, conditions: ratings,
  evidence: { name: "stated", dose: "inferred", steps: "stated" }, confidence: "high", ...over,
});
const extraction = (moves: ExtractedMove[]): Extraction => ({ kind: "routine", summary: "s", themes: [], moves });

const env = (over: Partial<Env> = {}): Env => ({ FIXTURE_MODE: "1", ...over }) as unknown as Env;
const noFetch = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;

/** An extracted post, matched (fixture mode: no judge). */
async function matched(key: string, moves: ExtractedMove[], owner = userId, now = T0) {
  const id = await savedPostId(owner, SRC, key);
  await db.insert(savedPosts).values({
    id, userId: owner, source: SRC, sourceKey: key, url: `https://example.com/p/${key}`, creatorHandle: "someone",
    firstSeenAt: now, status: "extracted", extraction: extraction(moves), extractAttempts: 1, updatedAt: now,
  });
  await matchPost(db, env(), owner, id, now, noFetch);
  return id;
}

const batchOf = async (id: string) => (await db.select().from(saveBatches).where(eq(saveBatches.id, id)))[0]!;

beforeEach(async () => {
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (sql) => {
      statements += 1;
      if (isWrite(sql)) writes += 1;
    },
  });
  ({ userId } = await makeTestUser(db));
  statements = 0;
  writes = 0;
});

describe("assembleBatch", () => {
  it("releases one batch of the matched posts, with the notice, and stamps posts, links and new moves", async () => {
    const a = await matched("a", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    const b = await matched("b", [move("Zorbex quad shuffles"), move("Zorbex neck nod", { regions: ["neck"] })]);
    statements = 0;
    const id = await assembleBatch(db, env(), userId, at(1));
    expect(id).toBeTruthy();
    // gate 1, waiting moves 1, the batch and its stamps 4
    expect(statements).toBe(6);
    const records = (await db.select().from(personalMoves)).map((m) => m.record as ExerciseRecord);
    expect(records).toHaveLength(2);
    expect(await batchOf(id!)).toMatchObject({
      userId, status: "released", releasedAt: at(1), createdAt: at(1), savedAt: null, notice: batchNotice(records, 1),
    });
    expect((await batchOf(id!)).notice).toBe("From your saves: 2 new moves (1 hip, 1 neck), 1 you already had.");
    const posts = await db.select().from(savedPosts);
    expect(posts.map((p) => p.batchId)).toEqual([id, id]);
    expect((await db.select().from(savedPostMoves)).every((l) => l.batchId === id && l.status === "pending")).toBe(true);
    expect((await db.select().from(personalMoves)).every((m) => m.batchId === id && m.status === "pending")).toBe(true);
    expect([a, b]).toHaveLength(2);
  });

  it("does nothing within 20 h of the last release, then gathers what waited", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const first = await assembleBatch(db, env(), userId, at(0));
    expect(first).toBeTruthy();
    await matched("b", [move("Zorbex neck nod")], userId, at(2));
    writes = 0;
    expect(await assembleBatch(db, env(), userId, at(19))).toBeNull();
    expect(writes).toBe(0);
    const second = await assembleBatch(db, env(), userId, new Date(Date.parse(T0) + BATCH_GAP_MS).toISOString());
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    const posts = await db.select().from(savedPosts);
    expect(Object.fromEntries(posts.map((p) => [p.sourceKey, p.batchId]))).toEqual({ a: first, b: second });
  });

  it("holds the batch while SAVES_HOLD_BATCHES is on: no release, no notice yet", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const id = await assembleBatch(db, env({ SAVES_HOLD_BATCHES: "1" }), userId, at(1));
    expect(await batchOf(id!)).toMatchObject({ status: "held", releasedAt: null, notice: null });
  });

  it("does nothing with no matched post waiting", async () => {
    await db.insert(savedPosts).values({
      id: "q", userId, source: SRC, sourceKey: "q", firstSeenAt: T0, status: "queued", updatedAt: T0,
    });
    writes = 0;
    expect(await assembleBatch(db, env(), userId, at(1))).toBeNull();
    expect(writes).toBe(0);
    expect(await db.select().from(saveBatches)).toEqual([]);
  });

  it("does not make a batch of posts that showed no moves", async () => {
    await matched("tips", []);
    expect(await assembleBatch(db, env(), userId, at(1))).toBeNull();
    expect(await db.select().from(saveBatches)).toEqual([]);
  });

  it("leaves another account's posts alone", async () => {
    const other = (await makeTestUser(db)).userId;
    await matched("theirs", [move("Zorbex quad shuffle")], other);
    expect(await assembleBatch(db, env(), userId, at(1))).toBeNull();
    expect((await db.select().from(savedPosts))[0]!.batchId).toBeNull();
  });

  it("counts a move another post already brought as the owner's when it was saved before", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const first = await assembleBatch(db, env(), userId, at(0));
    await saveBatch(db, userId, first!, at(1));
    await matched("b", [move("Zorbex quad shuffles")], userId, at(2));
    const second = await assembleBatch(db, env(), userId, at(21));
    expect((await batchOf(second!)).notice).toBe("From your saves: 1 move you already had.");
  });
});

describe("assembleBatch's notice and the review page agree on what is new (final review M1)", () => {
  it("a pending move an earlier, unsaved batch brought reads as one the owner had, not new", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const first = await assembleBatch(db, env(), userId, at(0));
    expect((await batchOf(first!)).notice).toBe("From your saves: 1 new move (hip).");
    // Never saved: the move stays pending, the first batch's. A later post shows it again, and a new one.
    await matched("b", [move("Zorbex quad shuffles"), move("Zorbex neck nod", { regions: ["neck"] })], userId, at(2));
    const second = await assembleBatch(db, env(), userId, at(21));
    // The page counts 1 New (the neck nod, born here) and 1 Linked (the shuffle, the first batch's): the notice too.
    expect((await batchOf(second!)).notice).toBe("From your saves: 1 new move (neck), 1 you already had.");
  });
});

describe("saveBatch", () => {
  it("writes provenance only on save: moves active, links saved, the batch saved", async () => {
    await matched("a", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    await matched("b", [move("Zorbex quad shuffles")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    expect(await db.select().from(exerciseProvenance)).toEqual([]);
    statements = 0;
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 1, links: 3 });
    // The batch and its counts, then one transaction of 5 (the insights kept in memory, spec §17).
    expect(statements).toBe(6);
    const [pm] = await db.select().from(personalMoves);
    expect(pm).toMatchObject({ status: "active", updatedAt: at(2) });
    expect((await db.select().from(savedPostMoves)).every((l) => l.status === "saved")).toBe(true);
    expect(await batchOf(id)).toMatchObject({ status: "saved", savedAt: at(2) });
    const links = (await db.select().from(exerciseProvenance)).sort((x, y) => (x.sourceKey ?? "").localeCompare(y.sourceKey ?? ""));
    expect(links.map((l) => ({ ...l, id: undefined }))).toEqual([
      // Each with its note: the post's purpose for the move (spec §17).
      { id: undefined, userId, exerciseId: pm!.id, sourceType: SRC, url: "https://example.com/p/a", creator: "someone", sourceKey: "imp:a#0", createdAt: at(2), note: "mobility" },
      { id: undefined, userId, exerciseId: HIP_SWITCH.id, sourceType: SRC, url: "https://example.com/p/a", creator: "someone", sourceKey: "imp:a#1", createdAt: at(2), note: "mobility" },
      { id: undefined, userId, exerciseId: pm!.id, sourceType: SRC, url: "https://example.com/p/b", creator: "someone", sourceKey: "imp:b#0", createdAt: at(2), note: "mobility" },
    ]);
  });

  it("twice writes nothing new", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    await saveBatch(db, userId, id, at(2));
    const before = await db.select().from(exerciseProvenance);
    writes = 0;
    expect(await saveBatch(db, userId, id, at(3))).toEqual({ moves: 0, links: 0 });
    expect(writes).toBe(0);
    expect(await db.select().from(exerciseProvenance)).toEqual(before);
    expect(await batchOf(id)).toMatchObject({ savedAt: at(2) });
  });

  it("is null for another account's batch, and writes nothing", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    const other = (await makeTestUser(db)).userId;
    writes = 0;
    expect(await saveBatch(db, other, id, at(2))).toBeNull();
    expect(writes).toBe(0);
    expect(await db.select().from(exerciseProvenance)).toEqual([]);
  });

  it("leaves a removed link out", async () => {
    await matched("a", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    await db.update(savedPostMoves).set({ status: "removed" }).where(eq(savedPostMoves.position, 1));
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 1, links: 1 });
    expect((await db.select().from(exerciseProvenance)).map((l) => l.sourceKey)).toEqual(["imp:a#0"]);
  });

  it("leaves a new move whose only link was removed pending, and does not count it", async () => {
    await matched("a", [move("Zorbex quad shuffle"), move("90/90 Hip Switch")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    await db.update(savedPostMoves).set({ status: "removed" }).where(eq(savedPostMoves.position, 0));
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 0, links: 1 });
    expect((await db.select().from(personalMoves))[0]).toMatchObject({ status: "pending" });
    expect((await db.select().from(exerciseProvenance)).map((l) => l.exerciseId)).toEqual([HIP_SWITCH.id]);
  });

  it("leaves a curated link to the same post and move exactly as it is, and adds no second one", async () => {
    await db.insert(exerciseProvenance).values({
      id: "curated", userId, exerciseId: HIP_SWITCH.id, sourceType: SRC, url: "https://example.com/p/a", creator: "curated",
      sourceKey: "a#3", createdAt: T0,
    });
    const [before] = await db.select().from(exerciseProvenance);
    await matched("a", [move("90/90 Hip Switch")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 0, links: 1 });
    expect(await db.select().from(exerciseProvenance)).toEqual([before]);
  });

  it("never overwrites a curated link whose key reads like an import's, and adds its own under imp:", async () => {
    await db.insert(exerciseProvenance).values({
      id: "curated", userId, exerciseId: "someOtherMove", sourceType: SRC, url: "https://example.com/p/a", creator: "curated",
      sourceKey: "a#0", createdAt: T0,
    });
    const [before] = await db.select().from(exerciseProvenance);
    await matched("a", [move("90/90 Hip Switch")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    await saveBatch(db, userId, id, at(2));
    const rows = await db.select().from(exerciseProvenance);
    expect(rows.find((r) => r.id === "curated")).toEqual(before);
    expect(rows.filter((r) => r.id !== "curated").map((r) => [r.exerciseId, r.sourceKey])).toEqual([[HIP_SWITCH.id, "imp:a#0"]]);
  });

  it("lists a move once per post, however many times the post shows it", async () => {
    await matched("a", [move("90/90 Hip Switch"), move("90-90 hip switches")]);
    const id = (await assembleBatch(db, env(), userId, at(1)))!;
    expect(await saveBatch(db, userId, id, at(2))).toEqual({ moves: 0, links: 2 });
    expect((await db.select().from(exerciseProvenance)).map((r) => [r.exerciseId, r.sourceKey])).toEqual([[HIP_SWITCH.id, "imp:a#0"]]);
    expect((await db.select().from(savedPostMoves)).every((l) => l.status === "saved")).toBe(true);
  });

  it("makes usable a pending move an earlier, unsaved batch brought, when this batch links to it", async () => {
    await matched("a", [move("Zorbex quad shuffle")]);
    await assembleBatch(db, env(), userId, at(0));
    await matched("b", [move("Zorbex quad shuffles")], userId, at(2));
    const second = (await assembleBatch(db, env(), userId, at(21)))!;
    expect(await saveBatch(db, userId, second, at(22))).toEqual({ moves: 1, links: 1 });
    expect((await db.select().from(personalMoves))[0]).toMatchObject({ status: "active" });
  });

  it("saves a 600-link batch in the same few statements", async () => {
    const batchId = "big";
    await db.insert(saveBatches).values({ id: batchId, userId, status: "released", createdAt: T0, releasedAt: T0 });
    const posts = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`, userId, source: SRC, sourceKey: `k${i}`, url: `https://example.com/p/k${i}`, creatorHandle: "someone",
      firstSeenAt: T0, status: "matched", batchId, updatedAt: T0,
    }));
    // Five a statement: the table's defaulted columns bind too.
    for (let i = 0; i < posts.length; i += 5) await db.insert(savedPosts).values(posts.slice(i, i + 5));
    const links = posts.flatMap((p) =>
      Array.from({ length: 12 }, (_, position) => ({
        id: newId(), userId, postId: p.id, position, moveId: EXERCISES[position]!.id, moveKind: "library" as const, batchId,
        confidence: 1, checkFlag: false, status: "pending" as const, createdAt: T0,
      })),
    );
    for (const chunk of insertBatches(links)) await db.insert(savedPostMoves).values(chunk);
    statements = 0;
    expect(await saveBatch(db, userId, batchId, at(1))).toEqual({ moves: 0, links: 600 });
    expect(statements).toBe(6);
    expect(await db.select().from(exerciseProvenance)).toHaveLength(600);
  });
});
