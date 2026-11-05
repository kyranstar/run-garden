/**
 * One post's trail, read by its owner (design 2026-11-05 §3.4, §6.3): the account on top, the events oldest first with
 * their blobs listed, a blob's text on its own route; a post from before the trail rebuilt from what was kept.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mySavesRoutes } from "../src/routes/my-saves.js";
import { filterPost } from "../src/services/saves-filter.js";
import { upsertPost, savedPostId } from "../src/services/saves-ledger.js";
import { relayExtract } from "../src/services/saves-relay.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const NOW = "2026-11-05T10:00:00.000Z";
const fixture = { FIXTURE_MODE: "1", SAVES_IMPORT: "1" } as unknown as Env;
const noFetch = (async () => new Response("{}")) as unknown as typeof fetch;
let db: Db;
let userId: string;
let cookie: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ onStatement: () => { statements += 1; } });
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

async function get(path: string, as: string = cookie) {
  const app = mountRoutes(db, "/api/my-saves", mySavesRoutes);
  statements = 0;
  const res = await app.request(`/api/my-saves${path}`, { headers: { Cookie: as } }, fixture);
  return { res, body: (await res.json().catch(() => null)) as any, cost: statements };
}

const submit = (key: string) => ({
  source: "testsrc", key, url: `https://example.com/p/${key}`, creator: { handle: "maker" }, caption: "a synthetic caption",
  hashtags: [], mediaType: "video" as const, readFacts: { via: "saved_list" as const, extVersion: "0.2.0", coverSent: false, mediaCount: 1 },
});

describe("GET /health", () => {
  it("answers the seven lights and the worst line, in at most 5 statements", async () => {
    const { res, body, cost } = await get("/health");
    expect(res.status).toBe(200);
    expect(cost).toBeLessThanOrEqual(5);
    expect(body.lights.map((l: { light: string }) => l.light)).toEqual(["instagram", "youtube", "screening", "reader", "matching", "coach", "budget"]);
    expect(body.worst).toBeNull();
  });
});

describe("GET /posts/:id/trail", () => {
  it("a post walked through the stages: its account, then its events oldest first with their blobs, in at most 6 statements", async () => {
    const row = await upsertPost(db, userId, submit("k1"), NOW);
    await filterPost(db, fixture, userId, row, NOW, noFetch);
    const req = new Request("https://app.test/x", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" });
    await relayExtract(db, fixture, userId, { id: row.id }, req, new Date(NOW), noFetch);
    const { res, body, cost } = await get(`/posts/${row.id}/trail`);
    expect(res.status).toBe(200);
    expect(cost).toBeLessThanOrEqual(6);
    expect(body.rebuilt).toBe(false);
    expect(body.post).toMatchObject({ id: row.id, source: "testsrc", origin: "saved", creator: { handle: "maker" } });
    expect(body.events.map((e: { stage: string }) => e.stage)).toEqual(["read", "submit", "screen", "extract", "check", "match"]);
    const extract = body.events.find((e: { stage: string }) => e.stage === "extract");
    expect(extract.blobs.map((b: { kind: string }) => b.kind)).toEqual(["prompt_user"]);
    expect(body.account).toMatchObject({ kind: "single_move", summary: "A synthetic post showing one mobility move." });
    expect(body.account.moves).toEqual([
      expect.objectContaining({ position: 0, name: "Synthetic hip switch", outcome: "new", purpose: "hip mobility" }),
    ]);
    expect(body.account.health).toEqual({ status: "ok", line: "Read cleanly" });

    const blob = await get(`/blobs/${extract.blobs[0].id}`);
    expect(blob.body).toMatchObject({ kind: "prompt_user", cut: false });
    expect(blob.body.text).toContain("Extract the moves from this saved post.");
  });

  it("a post from before the trail is rebuilt from what was kept, and says so", async () => {
    const id = await savedPostId(userId, "testsrc", "old");
    await db.insert(schema.savedPosts).values({
      id, userId, source: "testsrc", sourceKey: "old", url: "https://example.com/p/old", firstSeenAt: NOW, status: "failed",
      filterVerdict: "training", filterReason: "a mobility routine", filterStage: "model", lastErrorCode: "media_failed", updatedAt: NOW,
    });
    const { body } = await get(`/posts/${id}/trail`);
    expect(body.rebuilt).toBe(true);
    expect(body.events.map((e: { stage: string; rebuilt: boolean }) => [e.stage, e.rebuilt])).toEqual([["screen", true], ["extract", true]]);
    expect(body.events[0].summary).toBe("Kept: a mobility routine");
    expect(body.events[1]).toMatchObject({ status: "fail", summary: "The video wouldn't download" });
    expect(body.account.health).toEqual({ status: "fail", line: "The video wouldn't download" });
  });

  it("another account's post or blob is 404", async () => {
    const other = (await makeTestUser(db)).userId;
    const row = await upsertPost(db, other, submit("theirs"), NOW);
    expect((await get(`/posts/${row.id}/trail`)).res.status).toBe(404);
    const blobs = await db.select().from(schema.importBlobs);
    for (const b of blobs) expect((await get(`/blobs/${b.id}`)).res.status).toBe(404);
    expect((await get(`/blobs/nope`)).res.status).toBe(404);
  });
});
