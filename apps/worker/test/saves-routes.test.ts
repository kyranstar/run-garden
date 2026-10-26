/**
 * The saved-posts import's token routes (/api/saves/*): behind SAVES_IMPORT and a bearer token, never a cookie; the
 * ledger's idempotence; the work list; and each route's D1 statement count (Workers Free: 45 a request).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sha256Hex } from "../src/auth/crypto.js";
import { savesRoutes } from "../src/routes/saves.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedPosts, saveChecks } = schema;
const eqId = (id: string) => eq(savedPosts.id, id);
const TOKEN = "b".repeat(64);
const SRC = "testsrc";

let db: Db;
let userId: string;
let email: string;
let statements = 0;

async function makeEnv(over: Partial<Env> = {}, token: string | null = TOKEN): Promise<Env> {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "1",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: email,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    SAVES_IMPORT: "1",
    ...(token === null ? {} : { SAVES_TOKEN_SHA256: await sha256Hex(token) }),
    ...over,
  };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

async function call(path: string, init: RequestInit = {}, env?: Env) {
  const app = mountRoutes(db, "/api/saves", savesRoutes);
  statements = 0;
  const res = await app.request(`/api/saves${path}`, { headers: auth, ...init }, env ?? (await makeEnv()));
  return { res, body: (await res.json().catch(() => null)) as any, cost: statements };
}
const post = (path: string, json: unknown, headers: Record<string, string> = auth, env?: Env) =>
  call(path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(json) }, env);

const submit = (key: string, over: Record<string, unknown> = {}) => ({
  source: SRC,
  key,
  url: `https://example.com/p/${key}`,
  creator: { handle: "someone" },
  caption: "a synthetic caption",
  hashtags: ["one"],
  mediaType: "video",
  ...over,
});

async function seedPost(key: string, fields: Partial<typeof savedPosts.$inferInsert> = {}): Promise<string> {
  const id = await savedPostId(userId, SRC, key);
  await db.insert(savedPosts).values({
    id,
    userId,
    source: SRC,
    sourceKey: key,
    url: `https://example.com/p/${key}`,
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    status: "queued",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...fields,
  });
  return id;
}

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db));
  email = `runner-${userId}@example.com`;
});

describe("the door", () => {
  it("is a 404 without SAVES_IMPORT", async () => {
    const { res } = await call("/status", {}, await makeEnv({ SAVES_IMPORT: undefined }));
    expect(res.status).toBe(404);
  });
  it("is a 404 without the secret", async () => {
    const { res } = await call("/status", {}, await makeEnv({}, null));
    expect(res.status).toBe(404);
  });
  it("is a 401 with a wrong token, and with none", async () => {
    expect((await call("/status", { headers: { Authorization: `Bearer ${"c".repeat(64)}` } })).res.status).toBe(401);
    expect((await call("/status", { headers: {} })).res.status).toBe(401);
  });
  it("is a 401 for a cookie alone", async () => {
    const { res } = await call("/status", { headers: { Cookie: "rg_session=anything" } });
    expect(res.status).toBe(401);
  });
  it("answers no-store", async () => {
    const { res } = await call("/status");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("lets an extension origin POST through (not a 403)", async () => {
    const { res } = await post("/known", { source: SRC, keys: ["a"] }, { ...auth, Origin: "chrome-extension://abc" });
    expect(res.status).toBe(200);
  });
});

describe("the origin guard (index.ts)", () => {
  it("exempts /api/saves/ only", async () => {
    const { originGuard } = await import("../src/index.js");
    const { Hono } = await import("hono");
    const app = new Hono();
    app.use("*", originGuard as never);
    app.post("/api/saves/known", (c) => c.json({ ok: true }));
    app.post("/api/lifeos/plan", (c) => c.json({ ok: true }));
    const env = { APP_URL: "https://app.test" };
    const init = { method: "POST", headers: { Origin: "chrome-extension://abc" } };
    expect((await app.request("/api/saves/known", init, env)).status).toBe(200);
    expect((await app.request("/api/lifeos/plan", init, env)).status).toBe(403);
  });
});

describe("POST /known", () => {
  it("returns only the unseen keys, in input order", async () => {
    await seedPost("k2");
    const { body, cost } = await post("/known", { source: SRC, keys: ["k3", "k2", "k1", "k3"] });
    expect(body).toEqual({ fresh: ["k3", "k1"] });
    expect(cost).toBeLessThanOrEqual(3);
  });
  it("takes 200 keys in one statement, refuses 201", async () => {
    const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
    const ok = await post("/known", { source: SRC, keys });
    expect(ok.body.fresh).toHaveLength(200);
    expect(ok.cost).toBeLessThanOrEqual(3);
    expect((await post("/known", { source: SRC, keys: [...keys, "extra"] })).res.status).toBe(422);
  });
  it("keeps another source's rows apart", async () => {
    await seedPost("k1");
    expect((await post("/known", { source: "other", keys: ["k1"] })).body).toEqual({ fresh: ["k1"] });
  });
});

describe("POST /posts", () => {
  it("records a fresh post, queued, within 8 statements", async () => {
    const { res, body, cost } = await post("/posts", submit("p1"));
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "queued", verdict: "maybe", reason: "fixture mode: not asked" });
    expect(cost).toBeLessThanOrEqual(8);
    const rows = await db.select().from(savedPosts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, source: SRC, sourceKey: "p1", status: "queued", creatorHandle: "someone" });
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  });
  it("changes nothing the second time", async () => {
    await post("/posts", submit("p1"));
    const [first] = await db.select().from(savedPosts);
    await new Promise((r) => setTimeout(r, 5));
    const again = await post("/posts", submit("p1", { caption: "changed" }));
    expect(again.body).toEqual({ status: "queued", verdict: "maybe", reason: "fixture mode: not asked" });
    const rows = await db.select().from(savedPosts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(first);
  });
  it("takes a seed's status and reason", async () => {
    const { body } = await post("/posts", submit("p1", { seed: { status: "filtered_out", reason: "older than the window" } }));
    expect(body).toEqual({ status: "filtered_out", verdict: "not", reason: "older than the window" });
  });
  it("refuses a bad body with 422", async () => {
    expect((await post("/posts", { ...submit("p1"), url: "http://insecure.example.com/x" })).res.status).toBe(422);
  });
});

describe("POST /posts with the model (filter)", () => {
  const live = () => makeEnv({ FIXTURE_MODE: "0", AI_GATEWAY_API_KEY: "k", AI_GATEWAY_BASE_URL: "https://gw.test/v1" });
  const answer = (content: string) =>
    vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 }));
  afterEach(() => vi.unstubAllGlobals());

  it("filters out a 'not' within 12 statements (2 auth, 2 ledger, claim, creator history, reserve 2, settle, credits note 2, outcome; the model call excluded)", async () => {
    vi.stubGlobal("fetch", answer('{"verdict":"not","reason":"a recipe"}'));
    const { body, cost } = await post("/posts", submit("m1"), auth, await live());
    expect(body).toEqual({ status: "filtered_out", verdict: "not", reason: "a recipe" });
    expect(cost).toBeLessThanOrEqual(12);
  });
  it("makes ONE model call and ONE usage row for two simultaneous submits of a new key", async () => {
    const fetchMock = answer('{"verdict":"training","reason":"drills"}');
    vi.stubGlobal("fetch", fetchMock);
    const env = await live();
    const [a, b] = await Promise.all([post("/posts", submit("race"), auth, env), post("/posts", submit("race"), auth, env)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.llmUsage)).toHaveLength(1);
    expect([a.res.status, b.res.status]).toEqual([200, 200]);
    expect(a.body.status === "queued" || b.body.status === "queued").toBe(true);
  });
});

describe("POST /posts resubmitting a stranded post", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("re-runs the filter on a known seen post, with the fresh cover", async () => {
    await seedPost("again", { status: "seen", lastErrorCode: "model_failed", creatorHandle: "someone", caption: "c", mediaType: "video" });
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"training","reason":"x"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    }));
    const env = await makeEnv({ FIXTURE_MODE: "0", AI_GATEWAY_API_KEY: "k", AI_GATEWAY_BASE_URL: "https://gw.test/v1" });
    const { body } = await post("/posts", submit("again", { cover: { mime: "image/jpeg", base64: "AAAA" } }), auth, env);
    expect(body.status).toBe("queued");
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].messages[1].content)).toContain("data:image/jpeg;base64,AAAA");
  });
});

describe("GET /work", () => {
  it("lists a queued post and a failed one with 2 attempts, not one with 3, oldest first", async () => {
    await seedPost("queued", { updatedAt: "2026-10-02T00:00:00.000Z" });
    await seedPost("failed2", { status: "failed", extractAttempts: 2, lastErrorCode: "model_failed", updatedAt: "2026-10-01T00:00:00.000Z" });
    await seedPost("failed3", { status: "failed", extractAttempts: 3, lastErrorCode: "model_failed" });
    await seedPost("gone", { status: "failed", extractAttempts: 1, lastErrorCode: "gone" });
    await seedPost("done", { status: "extracted", extraction: { kind: "tips" } });
    await seedPost("withExtraction", { status: "queued", extraction: { kind: "tips" } });
    const { body } = await call("/work");
    expect(body.keys).toEqual([
      { source: SRC, key: "failed2", url: "https://example.com/p/failed2", action: "extract" },
      { source: SRC, key: "queued", url: "https://example.com/p/queued", action: "extract" },
    ]);
  });
  it("lists stranded seen posts as filter work, first: model_failed, budget_paused under the cap, a stale claim", async () => {
    await seedPost("q", { updatedAt: "2026-10-01T00:00:00.000Z" });
    await seedPost("mf", { status: "seen", lastErrorCode: "model_failed", updatedAt: "2026-10-02T00:00:00.000Z" });
    await seedPost("bp", { status: "seen", lastErrorCode: "budget_paused", updatedAt: "2026-10-03T00:00:00.000Z" });
    await seedPost("stale", { status: "seen", lastErrorCode: "filtering", updatedAt: "2026-10-04T00:00:00.000Z" });
    await seedPost("fresh", { status: "seen", lastErrorCode: "filtering", updatedAt: new Date().toISOString() });
    await seedPost("plain", { status: "seen", updatedAt: "2026-10-01T00:00:00.000Z" });
    const { body } = await call("/work");
    expect(body.keys.map((k: any) => `${k.key}:${k.action}`)).toEqual(["mf:filter", "bp:filter", "stale:filter", "q:extract"]);
  });
  it("leaves budget_paused posts out while the import budget is spent", async () => {
    await seedPost("bp", { status: "seen", lastErrorCode: "budget_paused" });
    await db.insert(schema.llmUsage).values({
      id: "spent", userId, kind: "import_extract", model: "m", inputTokens: 1, outputTokens: 1,
      costMicros: 5_000_000, cacheHit: false, createdAt: new Date().toISOString(),
    });
    expect((await call("/work")).body.keys).toEqual([]);
  });
  it("hands out at most 20", async () => {
    for (let i = 0; i < 25; i++) await seedPost(`q${i}`);
    expect((await call("/work")).body.keys).toHaveLength(20);
  });
});

describe("POST /posts/:key/failed (a post the extension could not fetch)", () => {
  const failed = (key: string, code: string, query = `?source=${SRC}`) => post(`/posts/${key}/failed${query}`, { code });

  it("marks a gone post failed/gone, within 4 statements; it is never handed out again", async () => {
    const id = await seedPost("g");
    const { res, body, cost } = await failed("g", "gone");
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "failed", errorCode: "gone" });
    expect(cost).toBeLessThanOrEqual(4); // auth 2 + the update 1 (+1 only to tell 404 from 409)
    const [row] = await db.select().from(savedPosts).where(eqId(id));
    expect(row).toMatchObject({ status: "failed", lastErrorCode: "gone", extractAttempts: 0 });
    expect((await call("/work")).body.keys).toEqual([]);
  });

  it("marks a seen post gone too (filter work whose post was deleted)", async () => {
    await seedPost("s", { status: "seen", lastErrorCode: "model_failed" });
    expect((await failed("s", "gone")).body).toEqual({ status: "failed", errorCode: "gone" });
    expect((await call("/work")).body.keys).toEqual([]);
  });

  it("counts a media failure as an attempt and moves the post to the back of the work list; after 3 it is not handed out", async () => {
    await seedPost("m", { updatedAt: "2026-10-01T00:00:00.000Z" });
    await seedPost("other", { updatedAt: "2026-10-02T00:00:00.000Z" });
    expect((await failed("m", "media_failed")).body).toEqual({ status: "failed", errorCode: "media_failed" });
    const [row] = await db.select().from(savedPosts).where(eqId(await savedPostId(userId, SRC, "m")));
    expect(row).toMatchObject({ status: "failed", lastErrorCode: "media_failed", extractAttempts: 1 });
    expect((await call("/work")).body.keys.map((k: any) => k.key)).toEqual(["other", "m"]);
    await failed("m", "media_failed");
    await failed("m", "media_failed");
    expect((await call("/work")).body.keys.map((k: any) => k.key)).toEqual(["other"]);
  });

  it("marks a post too large to send at any size failed/too_large, as the relay's own cap does: an attempt, and off the work list", async () => {
    await seedPost("big");
    expect((await failed("big", "too_large")).body).toEqual({ status: "failed", errorCode: "too_large" });
    const [row] = await db.select().from(savedPosts).where(eqId(await savedPostId(userId, SRC, "big")));
    expect(row).toMatchObject({ status: "failed", lastErrorCode: "too_large", extractAttempts: 1 });
    expect((await call("/work")).body.keys).toEqual([]);
  });

  it("leaves a finished post as it is (409), 404s an unknown one, refuses a bad code or source", async () => {
    await seedPost("done", { status: "matched" });
    expect((await failed("done", "gone")).res.status).toBe(409);
    expect((await failed("nope", "gone")).res.status).toBe(404);
    expect((await failed("done", "model_failed")).res.status).toBe(422);
    expect((await failed("done", "gone", "?source=Bad Source")).res.status).toBe(400);
    const [row] = await db.select().from(savedPosts).where(eqId(await savedPostId(userId, SRC, "done")));
    expect(row!.status).toBe("matched");
  });

  it("a media failure leaves a seen post to its filter work", async () => {
    await seedPost("s", { status: "seen", lastErrorCode: "model_failed" });
    expect((await failed("s", "media_failed")).res.status).toBe(409);
  });
});

describe("POST /checks", () => {
  const checkId = "6f1c1d0e-2b7a-4b8e-9c55-0a1b2c3d4e5f";
  it("opens a row on start and sets the counts and error on finish, within 4 statements plus assembleBatch's (nothing waiting: 2)", async () => {
    expect((await post("/checks", { checkId, phase: "start" })).body).toEqual({ ok: true });
    const fin = await post("/checks", {
      checkId, phase: "finish", found: 5, fresh: 3, filtered: 1, extracted: 1, failed: 1,
      error: { code: "login_needed", message: "signed out" },
    });
    expect(fin.body).toEqual({ ok: true });
    expect(fin.cost).toBeLessThanOrEqual(4 + 2);
    const rows = await db.select().from(saveChecks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ found: 5, fresh: 3, filtered: 1, extracted: 1, failed: 1, errorCode: "login_needed", errorMessage: "signed out" });
    expect(rows[0]!.finishedAt).not.toBeNull();
  });
  it("a finish without its start still lands", async () => {
    await post("/checks", { checkId, phase: "finish", found: 2 });
    expect((await db.select().from(saveChecks))[0]).toMatchObject({ found: 2 });
  });
  it("a finish gathers the matched posts into a released batch, within 4 + 6 statements; a start never does", async () => {
    const id = await seedPost("m", { status: "matched", updatedAt: "2026-10-22T00:00:00.000Z" });
    await db.insert(schema.savedPostMoves).values({
      id: "spm1", userId, postId: id, position: 0, moveId: "hip9090", moveKind: "library", confidence: 1, status: "pending",
      createdAt: "2026-10-22T00:00:00.000Z",
    });
    await post("/checks", { checkId, phase: "start" });
    expect(await db.select().from(schema.saveBatches)).toEqual([]);
    const fin = await post("/checks", { checkId, phase: "finish", found: 1 });
    expect(fin.body).toEqual({ ok: true });
    expect(fin.cost).toBeLessThanOrEqual(4 + 6);
    const [batch] = await db.select().from(schema.saveBatches);
    expect(batch).toMatchObject({ userId, status: "released", notice: "From your saves: 1 move you already had." });
    expect((await db.select().from(savedPosts))[0]!.batchId).toBe(batch!.id);
  });
});

describe("GET /status", () => {
  it("is idle with nothing, and reads the latest check and posts, within 6 statements", async () => {
    const idle = await call("/status");
    expect(idle.body).toMatchObject({ state: "idle", lastCheckAt: null, lastImportAt: null, checks: [], posts: [], totals: { moves: 0, posts: 0 } });
    expect(idle.body.spend.capMicros).toBe(5_000_000);
    await seedPost("p1");
    await post("/checks", { checkId: "6f1c1d0e-2b7a-4b8e-9c55-0a1b2c3d4e5f", phase: "finish", error: { code: "budget_paused", message: "cap" } });
    const { body, cost } = await call("/status");
    // 2 auth, checks, posts, spend, the import's totals
    expect(cost).toBeLessThanOrEqual(6);
    expect(body.state).toBe("paused_budget");
    expect(body.checks).toHaveLength(1);
    expect(body.posts).toEqual([
      { id: await savedPostId(userId, SRC, "p1"), key: "p1", url: "https://example.com/p/p1", creator: { handle: "" }, status: "queued", reason: null, updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });
  it("counts the moves and posts the owner saved, and dates the last import by its batch, not its check", async () => {
    const a = await seedPost("a", { status: "matched" });
    const b = await seedPost("b", { status: "matched" });
    const c = await seedPost("c", { status: "matched" });
    const link = (id: string, postId: string, position: number, moveId: string, status: "pending" | "saved" | "removed") => ({
      id, userId, postId, position, moveId, moveKind: "library" as const, confidence: 1, status, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await db.insert(schema.savedPostMoves).values([
      link("1", a, 0, "hip9090", "saved"),
      link("2", a, 1, "otherMove", "saved"),
      link("3", b, 0, "hip9090", "saved"),
      link("4", c, 0, "thirdMove", "pending"),
      link("5", b, 1, "fourthMove", "removed"),
    ]);
    await db.insert(schema.saveBatches).values([
      { id: "b1", userId, status: "saved", createdAt: "2026-10-01T00:00:00.000Z", releasedAt: "2026-10-01T00:00:00.000Z", savedAt: "2026-10-03T00:00:00.000Z" },
      { id: "b2", userId, status: "released", createdAt: "2026-10-05T00:00:00.000Z", releasedAt: "2026-10-05T00:00:00.000Z" },
      { id: "b3", userId, status: "held", createdAt: "2026-10-09T00:00:00.000Z" },
    ]);
    await post("/checks", { checkId: "6f1c1d0e-2b7a-4b8e-9c55-0a1b2c3d4e5f", phase: "start" });
    const { body } = await call("/status");
    expect(body.totals).toEqual({ moves: 2, posts: 2 });
    expect(body.lastImportAt).toBe("2026-10-05T00:00:00.000Z");
    expect(body.lastCheckAt).not.toBe(body.lastImportAt);
  });
});

describe("POST /posts/:key/override (the owner's word, from the popup)", () => {
  const override = (key: string, body: unknown, query = `?source=${SRC}`, headers: Record<string, string> = auth) =>
    post(`/posts/${key}/override${query}`, body, headers);
  const rowOf = async (key: string) => (await db.select().from(savedPosts).where(eqId(await savedPostId(userId, SRC, key))))[0]!;

  it("process puts a filtered_out post back to queued for the owner, within 5 statements", async () => {
    await seedPost("a", { status: "filtered_out", filterStage: "model", extractAttempts: 3 });
    const { res, body, cost } = await override("a", { action: "process" });
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(cost).toBeLessThanOrEqual(5);
    expect(await rowOf("a")).toMatchObject({ status: "queued", filterStage: "owner", extractAttempts: 0 });
  });

  it("process retries a failed post; skip and reference set their statuses", async () => {
    await seedPost("f", { status: "failed", lastErrorCode: "media_failed" });
    await seedPost("s", { status: "queued" });
    await seedPost("r", { status: "filtered_out" });
    expect((await override("f", { action: "process" })).res.status).toBe(200);
    expect((await override("s", { action: "skip" })).res.status).toBe(200);
    expect((await override("r", { action: "reference" })).res.status).toBe(200);
    expect((await rowOf("f")).status).toBe("queued");
    expect((await rowOf("s")).status).toBe("skipped_by_owner");
    expect((await rowOf("r")).status).toBe("reference_only");
  });

  it("process on a failed post that kept its extraction clears it, so /work hands it out as extract work (final review I1)", async () => {
    await seedPost("kept", {
      status: "failed", lastErrorCode: "model_failed", extractAttempts: 3, extraction: { kind: "tips" }, lastError: "moves.0: bad",
    });
    expect((await call("/work")).body.keys).toEqual([]);
    expect((await override("kept", { action: "process" })).res.status).toBe(200);
    expect(await rowOf("kept")).toMatchObject({ status: "queued", extraction: null, extractAttempts: 0, lastErrorCode: null, lastError: null });
    expect((await call("/work")).body.keys).toEqual([{ source: SRC, key: "kept", url: "https://example.com/p/kept", action: "extract" }]);
  });

  it("process never requeues a post that moved on between its read and its write: 409, the post as it stood", async () => {
    type Raw = { $client: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } };
    let racyId = "";
    let armed = false;
    // A relay's claim lands after the override read the row as failed, before its write.
    db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (text) => {
        statements += 1;
        if (armed && /^\s*update\s+"saved_posts"/i.test(text)) {
          armed = false;
          (db as unknown as Raw).$client.prepare(`UPDATE saved_posts SET status = 'extracting' WHERE id = ?`).run(racyId);
        }
      },
    });
    ({ userId } = await makeTestUser(db));
    email = `runner-${userId}@example.com`;
    racyId = await seedPost("racy", { status: "failed", lastErrorCode: "media_failed" });
    armed = true;
    expect((await override("racy", { action: "process" })).res.status).toBe(409);
    expect(await rowOf("racy")).toMatchObject({ status: "extracting", lastErrorCode: "media_failed" });
  });

  it("409s a post that cannot be processed, 404s an unknown one or another user's", async () => {
    await seedPost("done", { status: "extracted" });
    expect((await override("done", { action: "process" })).res.status).toBe(409);
    expect((await override("nope", { action: "skip" })).res.status).toBe(404);
    const other = (await makeTestUser(db)).userId;
    await db.insert(savedPosts).values({
      id: await savedPostId(other, SRC, "theirs"), userId: other, source: SRC, sourceKey: "theirs", url: "https://example.com/p/t",
      firstSeenAt: "2026-10-01T00:00:00.000Z", status: "filtered_out", updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect((await override("theirs", { action: "skip" })).res.status).toBe(404);
    const [theirs] = await db.select().from(savedPosts).where(eqId(await savedPostId(other, SRC, "theirs")));
    expect(theirs!.status).toBe("filtered_out");
  });

  it("refuses a bad action (422), a bad source (400), and a missing or cookie-only token (401)", async () => {
    await seedPost("a", { status: "filtered_out" });
    expect((await override("a", { action: "nope" })).res.status).toBe(422);
    expect((await override("a", { action: "skip" }, "?source=Bad Source")).res.status).toBe(400);
    expect((await override("a", { action: "skip" }, `?source=${SRC}`, {})).res.status).toBe(401);
    expect((await override("a", { action: "skip" }, `?source=${SRC}`, { Cookie: "rg_session=x" })).res.status).toBe(401);
    expect((await rowOf("a")).status).toBe("filtered_out");
  });
});
