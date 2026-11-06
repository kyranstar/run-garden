/**
 * One synthetic post walked through every Worker stage, in fixture mode (no model): each stage leaves its own event on
 * the post's trail, in pipeline order (design 2026-11-05 §4).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { filterPost } from "../src/services/saves-filter.js";
import { upsertPost } from "../src/services/saves-ledger.js";
import { relayExtract } from "../src/services/saves-relay.js";
import { assembleBatch, saveBatch } from "../src/services/saves-batches.js";
import { dismissBatch } from "../src/services/saves-review.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { importEvents } = schema;
const NOW = "2026-11-05T10:00:00.000Z";
const env = { FIXTURE_MODE: "1", SAVES_IMPORT: "1" } as unknown as Env;
const noFetch = (async () => new Response("{}")) as unknown as typeof fetch;
let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
});

const submit = (key: string) => ({
  source: "testsrc", key, url: `https://example.com/p/${key}`, creator: { handle: "maker" }, caption: "a synthetic caption",
  hashtags: [], mediaType: "video" as const,
});
const relayRequest = () =>
  new Request("https://app.test/x", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" });
const stagesOf = async (postId: string) =>
  (await db.select().from(importEvents).where(eq(importEvents.postId, postId)).orderBy(asc(importEvents.at), sql`rowid`)).map((e) => e.stage);

describe("a post's trail, stage by stage", () => {
  it("submit → screen → extract → check → match → batch → save, each written by its stage", async () => {
    const row = await upsertPost(db, userId, submit("k1"), NOW);
    await filterPost(db, env, userId, row, NOW, noFetch);
    await relayExtract(db, env, userId, { id: row.id }, relayRequest(), new Date(NOW), noFetch);
    const batchId = (await assembleBatch(db, env, userId, "2026-11-05T10:01:00.000Z"))!;
    expect(batchId).toBeTruthy();
    await saveBatch(db, userId, batchId, "2026-11-05T10:02:00.000Z");
    expect(await stagesOf(row.id)).toEqual(["submit", "screen", "extract", "check", "match", "batch", "save"]);
  });

  it("a post of the batch whose links were all removed is not told it was saved (final review I2)", async () => {
    const a = await upsertPost(db, userId, submit("ka"), NOW);
    const b = await upsertPost(db, userId, submit("kb"), NOW);
    for (const row of [a, b]) {
      await filterPost(db, env, userId, row, NOW, noFetch);
      await relayExtract(db, env, userId, { id: row.id }, relayRequest(), new Date(NOW), noFetch);
    }
    const batchId = (await assembleBatch(db, env, userId, "2026-11-05T10:01:00.000Z"))!;
    await db.update(schema.savedPostMoves).set({ status: "removed" }).where(eq(schema.savedPostMoves.postId, b.id));
    await saveBatch(db, userId, batchId, "2026-11-05T10:02:00.000Z");
    expect(await stagesOf(a.id)).toContain("save");
    expect(await stagesOf(b.id)).not.toContain("save");
  });

  it("a duplicate submit writes nothing new; putting a batch aside is an owner's choice on each of its posts", async () => {
    const row = await upsertPost(db, userId, submit("k2"), NOW);
    await upsertPost(db, userId, submit("k2"), NOW);
    expect(await stagesOf(row.id)).toEqual(["submit"]);
    await filterPost(db, env, userId, row, NOW, noFetch);
    await relayExtract(db, env, userId, { id: row.id }, relayRequest(), new Date(NOW), noFetch);
    const batchId = (await assembleBatch(db, env, userId, "2026-11-05T10:01:00.000Z"))!;
    expect(await dismissBatch(db, userId, batchId, "2026-11-05T10:03:00.000Z")).toBe("ok");
    const events = await db.select().from(importEvents).where(eq(importEvents.postId, row.id));
    expect(events.find((e) => e.stage === "choice")).toMatchObject({ source: "owner", summary: "Put aside for now" });
  });
});
