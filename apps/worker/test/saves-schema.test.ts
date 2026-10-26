/**
 * Migration 0029's tables (saved posts, checks, batches, personal moves, post moves). Lives in the worker's
 * tests because only they have a SQLite driver and the real migrations applied (`makeTestDb`).
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { makeTestDb } from "./helpers.js";

const { savedPosts, savedPostMoves, personalMoves, saveBatches, saveChecks } = schema;
const T = "2026-10-01T00:00:00.000Z";

const post = (id: string, key: string): typeof savedPosts.$inferInsert => ({
  id,
  userId: "u1",
  source: "example",
  sourceKey: key,
  firstSeenAt: T,
  status: "new",
  updatedAt: T,
});

describe("saved_posts", () => {
  it("defaults the counters and JSON, and round-trips a row", async () => {
    const db = makeTestDb();
    await db.insert(savedPosts).values({ ...post("p1", "k1"), hashtags: ["a", "b"], filterStage: "seed", seeded: true });
    const [row] = await db.select().from(savedPosts);
    expect(row).toMatchObject({ hashtags: ["a", "b"], extractAttempts: 0, costMicros: 0, seeded: true, filterStage: "seed", extraction: null });
  });

  it("refuses the same (user, source, key) twice, but allows another user or key", async () => {
    const db = makeTestDb();
    await db.insert(savedPosts).values(post("p1", "k1"));
    await expect(db.insert(savedPosts).values(post("p2", "k1"))).rejects.toThrow(/UNIQUE/i);
    await db.insert(savedPosts).values(post("p3", "k2"));
    await db.insert(savedPosts).values({ ...post("p4", "k1"), userId: "u2" });
    expect(await db.select().from(savedPosts)).toHaveLength(3);
  });
});

describe("personal moves and post moves", () => {
  it("holds a move and two post-moves at different positions, and refuses a repeated position", async () => {
    const db = makeTestDb();
    await db.insert(savedPosts).values(post("p1", "k1"));
    await db.insert(personalMoves).values({ id: "m1", userId: "u1", status: "active", record: { id: "m1", name: "Example" }, createdAt: T, updatedAt: T });
    const link = (id: string, position: number): typeof savedPostMoves.$inferInsert => ({
      id, userId: "u1", postId: "p1", position, moveId: "m1", moveKind: "personal", status: "pending", createdAt: T,
    });
    await db.insert(savedPostMoves).values([link("l1", 0), link("l2", 1)]);
    await expect(db.insert(savedPostMoves).values(link("l3", 1))).rejects.toThrow(/UNIQUE/i);
    const [move] = await db.select().from(personalMoves);
    expect(move).toMatchObject({ editedByOwner: false, record: { name: "Example" }, mergedInto: null });
    const links = await db.select().from(savedPostMoves);
    expect(links.map((l) => [l.position, l.checkFlag, l.confidence])).toEqual([[0, false, null], [1, false, null]]);
  });
});

describe("save_batches and save_checks", () => {
  it("insert with nullable timestamps and zero counts", async () => {
    const db = makeTestDb();
    await db.insert(saveBatches).values({ id: "b1", userId: "u1", status: "held", createdAt: T });
    await db.insert(saveChecks).values({ id: "c1", userId: "u1", startedAt: T });
    expect((await db.select().from(saveBatches))[0]).toMatchObject({ releasedAt: null, notice: null });
    expect((await db.select().from(saveChecks))[0]).toMatchObject({ found: 0, failed: 0, finishedAt: null });
  });

  it("0031: a batch's dismissal and fit start, a move's fit choice, a link's like — null until written", async () => {
    const db = makeTestDb();
    await db.insert(saveBatches).values({ id: "b1", userId: "u1", status: "released", createdAt: T });
    await db.insert(personalMoves).values({ id: "m1", userId: "u1", status: "pending", record: { id: "m1", name: "Example" }, createdAt: T, updatedAt: T });
    await db.insert(savedPostMoves).values({ id: "l1", userId: "u1", postId: "p1", position: 0, moveId: "m1", moveKind: "personal", status: "pending", createdAt: T });
    expect((await db.select().from(saveBatches))[0]).toMatchObject({ dismissedAt: null, fitStartedAt: null });
    expect((await db.select().from(personalMoves))[0]!.fitChoice).toBeNull();
    expect((await db.select().from(savedPostMoves))[0]!.likeMoveId).toBeNull();
    await db.update(saveBatches).set({ status: "superseded", dismissedAt: T, fitStartedAt: T });
    await db.update(personalMoves).set({ fitChoice: "skip" });
    await db.update(savedPostMoves).set({ likeMoveId: "m0" });
    expect((await db.select().from(saveBatches))[0]).toMatchObject({ status: "superseded", dismissedAt: T, fitStartedAt: T });
    expect((await db.select().from(personalMoves))[0]!.fitChoice).toBe("skip");
    expect((await db.select().from(savedPostMoves))[0]!.likeMoveId).toBe("m0");
  });
});
