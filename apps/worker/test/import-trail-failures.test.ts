/**
 * Every path that fails a post leaves a failed step on its trail (final review, 2026-11-05): a post can never read
 * "Read cleanly" while it is failed, and the health lights see the failure.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";
import { markFetchFailed, savedPostId, workList } from "../src/services/saves-ledger.js";
import { markTooLarge } from "../src/services/saves-relay.js";
import { readPostTrail } from "../src/services/import-trail-read.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const NOW = "2026-11-05T10:00:00.000Z";
let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
});

async function seed(key: string, over: Partial<typeof schema.savedPosts.$inferInsert> = {}) {
  const id = await savedPostId(userId, "testsrc", key);
  await db.insert(schema.savedPosts).values({
    id, userId, source: "testsrc", sourceKey: key, url: `https://example.com/p/${key}`, firstSeenAt: NOW, status: "queued", updatedAt: NOW, ...over,
  });
  return id;
}
const failedSteps = async (id: string) =>
  (await db.select().from(schema.importEvents).where(eq(schema.importEvents.postId, id))).filter((e) => e.status === "fail").map((e) => [e.stage, e.summary]);

describe("a failed post's trail says so", () => {
  it("a post the extension found gone, or too large at any size, has a failed read step", async () => {
    const gone = await seed("g");
    expect(await markFetchFailed(db, userId, gone, "gone", NOW)).toBe("ok");
    expect(await failedSteps(gone)).toEqual([["read", "The post is gone"]]);
    const big = await seed("b");
    await markTooLarge(db, userId, big, NOW);
    expect(await failedSteps(big)).toEqual([["read", "Too large to send, at any size"]]);
  });

  it("a reading whose request died on its last attempt is given up with a failed reading step", async () => {
    const id = await seed("x", { status: "extracting", extractAttempts: 3, updatedAt: "2026-11-05T09:00:00.000Z" });
    await workList(db, userId, NOW);
    expect(await failedSteps(id)).toEqual([["extract", "Something went wrong: the reading that held it never finished"]]);
  });

  it("a failed post with no failed step of its own still reads as failed, never 'Read cleanly'", async () => {
    const id = await seed("f", { status: "failed", lastErrorCode: "unknown", lastError: "matching failed" });
    await db.insert(schema.importEvents).values({ id: "ok1", userId, postId: id, stage: "extract", source: "gateway", status: "ok", summary: "Read 1 move", at: NOW });
    const trail = await readPostTrail(db, userId, id);
    expect(trail!.account.health).toEqual({ status: "fail", line: "Something went wrong: matching failed" });
  });
});
