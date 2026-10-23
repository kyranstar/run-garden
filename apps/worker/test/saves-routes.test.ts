/**
 * The saved-posts import's token routes (/api/saves/*): behind SAVES_IMPORT and a bearer token, never a cookie; the
 * ledger's idempotence; the work list; and each route's D1 statement count (Workers Free: 45 a request).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sha256Hex } from "../src/auth/crypto.js";
import { savesRoutes } from "../src/routes/saves.js";
import { savedPostId } from "../src/services/saves-ledger.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { savedPosts, saveChecks } = schema;
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
    FIXTURE_MODE: "0",
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

async function seedPost(key: string, fields: Partial<typeof savedPosts.$inferInsert> = {}) {
  await db.insert(savedPosts).values({
    id: await savedPostId(userId, SRC, key),
    userId,
    source: SRC,
    sourceKey: key,
    url: `https://example.com/p/${key}`,
    firstSeenAt: "2026-10-01T00:00:00.000Z",
    status: "queued",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...fields,
  });
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
    expect(body).toEqual({ status: "queued" });
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
    expect(again.body).toEqual({ status: "queued" });
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
      { source: SRC, key: "failed2", url: "https://example.com/p/failed2" },
      { source: SRC, key: "queued", url: "https://example.com/p/queued" },
    ]);
  });
  it("hands out at most 20", async () => {
    for (let i = 0; i < 25; i++) await seedPost(`q${i}`);
    expect((await call("/work")).body.keys).toHaveLength(20);
  });
});

describe("POST /checks", () => {
  const checkId = "6f1c1d0e-2b7a-4b8e-9c55-0a1b2c3d4e5f";
  it("opens a row on start and sets the counts and error on finish, within 4 statements", async () => {
    expect((await post("/checks", { checkId, phase: "start" })).body).toEqual({ ok: true });
    const fin = await post("/checks", {
      checkId, phase: "finish", found: 5, fresh: 3, filtered: 1, extracted: 1, failed: 1,
      error: { code: "login_needed", message: "signed out" },
    });
    expect(fin.body).toEqual({ ok: true });
    expect(fin.cost).toBeLessThanOrEqual(4);
    const rows = await db.select().from(saveChecks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ found: 5, fresh: 3, filtered: 1, extracted: 1, failed: 1, errorCode: "login_needed", errorMessage: "signed out" });
    expect(rows[0]!.finishedAt).not.toBeNull();
  });
  it("a finish without its start still lands", async () => {
    await post("/checks", { checkId, phase: "finish", found: 2 });
    expect((await db.select().from(saveChecks))[0]).toMatchObject({ found: 2 });
  });
});

describe("GET /status", () => {
  it("is idle with nothing, and reads the latest check and posts, within 5 statements", async () => {
    const idle = await call("/status");
    expect(idle.body).toMatchObject({ state: "idle", lastCheckAt: null, checks: [], posts: [] });
    expect(idle.body.spend.capMicros).toBe(5_000_000);
    await seedPost("p1");
    await post("/checks", { checkId: "6f1c1d0e-2b7a-4b8e-9c55-0a1b2c3d4e5f", phase: "finish", error: { code: "budget_paused", message: "cap" } });
    const { body, cost } = await call("/status");
    expect(cost).toBeLessThanOrEqual(5);
    expect(body.state).toBe("paused_budget");
    expect(body.checks).toHaveLength(1);
    expect(body.posts).toEqual([
      { key: "p1", url: "https://example.com/p/p1", creator: { handle: "" }, status: "queued", reason: null, updatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });
});
