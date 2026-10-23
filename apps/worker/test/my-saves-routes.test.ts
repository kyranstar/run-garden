/**
 * The owner's door onto the saved-posts import (/api/my-saves/*): cookie-signed, 404 while SAVES_IMPORT is off; the
 * status read, and the owner's override of one post (process anyway / skip / reference only).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mySavesRoutes } from "../src/routes/my-saves.js";
import { overridePost, savedPostId } from "../src/services/saves-ledger.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedPosts } = schema;
const SRC = "testsrc";
const NOW = "2026-10-23T10:00:00.000Z";

let db: Db;
let userId: string;
let cookie: string;

const env = (over: Partial<Env> = {}) => ({ SAVES_IMPORT: "1", ...over }) as unknown as Env;

async function seedPost(owner: string, key: string, status: string, over: Record<string, unknown> = {}) {
  const id = await savedPostId(owner, SRC, key);
  await db.insert(savedPosts).values({
    id, userId: owner, source: SRC, sourceKey: key, url: `https://example.com/p/${key}`, creatorHandle: "someone",
    caption: "c", hashtags: [], mediaType: "video", firstSeenAt: NOW, status, filterStage: "model",
    filterReason: "not a workout", extractAttempts: 3, updatedAt: "2026-10-01T00:00:00.000Z", ...over,
  });
  return id;
}
const rowOf = async (id: string) => (await db.select().from(savedPosts).where(eq(savedPosts.id, id)))[0]!;

function call(path: string, init: RequestInit = {}, e: Env = env(), as: string | null = cookie) {
  const app = mountRoutes(db, "/api/my-saves", mySavesRoutes);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(as ? { Cookie: as } : {}) };
  return app.request(`/api/my-saves${path}`, { headers, ...init }, e);
}
const override = (id: string, body: unknown, e: Env = env(), as: string | null = cookie) =>
  call(`/posts/${id}/override`, { method: "POST", body: JSON.stringify(body) }, e, as);

beforeEach(async () => {
  db = makeTestDb();
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

describe("/api/my-saves", () => {
  it("is 404 while the import is off, 401 without a session", async () => {
    expect((await call("/status", {}, env({ SAVES_IMPORT: "0" }))).status).toBe(404);
    expect((await call("/status", {}, env(), null)).status).toBe(401);
  });

  it("GET /status answers the ledger, with each post's id", async () => {
    const id = await seedPost(userId, "a", "filtered_out");
    const res = await call("/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.state).toBe("idle");
    expect(body.posts[0]).toMatchObject({ id, key: "a", status: "filtered_out" });
  });

  it("process puts a filtered_out post back to queued, filter_stage owner, attempts reset", async () => {
    const id = await seedPost(userId, "a", "filtered_out", { lastErrorCode: "gone", lastError: "x" });
    const res = await override(id, { action: "process" });
    expect(res.status).toBe(200);
    expect(await rowOf(id)).toMatchObject({ status: "queued", filterStage: "owner", extractAttempts: 0, lastErrorCode: null, lastError: null });
  });

  it("process also retries a failed post", async () => {
    const id = await seedPost(userId, "a", "failed", { lastErrorCode: "media_failed" });
    expect((await override(id, { action: "process" })).status).toBe(200);
    expect(await rowOf(id)).toMatchObject({ status: "queued", extractAttempts: 0 });
  });

  it("process leaves a post that is not filtered out or failed alone (409)", async () => {
    const id = await seedPost(userId, "a", "extracted");
    expect((await override(id, { action: "process" })).status).toBe(409);
    expect((await rowOf(id)).status).toBe("extracted");
  });

  it("skip and reference set their statuses", async () => {
    const a = await seedPost(userId, "a", "queued");
    const b = await seedPost(userId, "b", "filtered_out");
    expect((await override(a, { action: "skip" })).status).toBe(200);
    expect((await override(b, { action: "reference" })).status).toBe(200);
    expect((await rowOf(a)).status).toBe("skipped_by_owner");
    expect((await rowOf(b)).status).toBe("reference_only");
  });

  it("another user's post is 404 and untouched", async () => {
    const other = (await makeTestUser(db)).userId;
    const id = await seedPost(other, "a", "filtered_out");
    expect((await override(id, { action: "skip" })).status).toBe(404);
    expect((await rowOf(id)).status).toBe("filtered_out");
  });

  it("an unknown action is 422", async () => {
    const id = await seedPost(userId, "a", "filtered_out");
    expect((await override(id, { action: "nope" })).status).toBe(422);
  });
});

describe("overridePost", () => {
  it("finds a post by (source, key) too", async () => {
    const id = await seedPost(userId, "k1", "filtered_out");
    expect(await overridePost(db, userId, { source: SRC, key: "k1" }, "skip", NOW)).toBe("ok");
    expect((await rowOf(id)).status).toBe("skipped_by_owner");
    expect(await overridePost(db, userId, { source: SRC, key: "zzz" }, "skip", NOW)).toBe("not_found");
  });
});
