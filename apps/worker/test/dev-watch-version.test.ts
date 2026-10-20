/**
 * The watch-version journey's fixture lever (stream S; watch-version.spec.ts): `POST /api/dev/watch-version` puts in
 * the account three sessions whose watch holds an earlier version — one ahead a rewrite can reach, one ahead none can,
 * one weeks past and missed — and the app then says them as the athlete would meet them. Fixture mode only. Driven
 * through the Worker's real default export with the fixture stack's env; only the database is a stand-in, and nothing
 * reaches the network. Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/db.js")>();
  return { ...actual, makeDb: () => holder.db };
});

const { default: worker } = await import("../src/index.js");

vi.setConfig({ testTimeout: 60_000 });

function stackEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "http://localhost:5271",
    FIXTURE_MODE: "1",
    AI_DEFAULT_ENABLED: "0",
    AI_GATEWAY_BASE_URL: "http://127.0.0.1:9",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: "fixture@example.com",
    GOOGLE_CLIENT_ID: "x",
    GOOGLE_CLIENT_SECRET: "x",
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(env: Env, method: string, path: string, cookie?: string): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(
    new Request(`http://localhost:8971${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) } }),
    env,
    ctx,
  );
  await Promise.allSettled(pending);
  return res;
}

describe("the watch-version journey's fixture lever", () => {
  it("does not exist outside fixture mode", async () => {
    holder.db = makeTestDb();
    expect((await call(stackEnv({ FIXTURE_MODE: "0" }), "POST", "/api/dev/watch-version")).status).toBe(404);
  });

  it("fixture mode: two sessions ahead counted, the past one not; one can be sent, the other kept", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error(`unexpected network call: ${String(input instanceof Request ? input.url : input)}`);
    }) as typeof fetch;
    const env = stackEnv();
    holder.db = makeTestDb();
    const login = await call(env, "POST", "/api/dev/fixture-login");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call(env, "POST", "/api/dev/watch-version")).status).toBe(401);
    const seeded = (await (await call(env, "POST", "/api/dev/watch-version", cookie)).json()) as { sendable: string; keepOnly: string; past: string };

    const status = (await (await call(env, "GET", "/api/sync/status", cookie)).json()) as {
      contentStaleCount: number;
      contentStaleSessions: Array<{ workoutId: string; title: string }>;
    };
    expect(status.contentStaleCount).toBe(2);
    expect(status.contentStaleSessions.map((s) => [s.workoutId, s.title])).toEqual([
      [seeded.sendable, "Easy 30"],
      [seeded.keepOnly, "Hills 6x1"],
    ]);
    const detail = async (id: string) =>
      (await (await call(env, "GET", `/api/plan/workouts/${id}`, cookie)).json()) as { workout: { corosSyncView: string }; watchVersion?: unknown };
    expect(await detail(seeded.sendable)).toMatchObject({ workout: { corosSyncView: "content_stale" }, watchVersion: { send: true } });
    expect(await detail(seeded.keepOnly)).toMatchObject({ workout: { corosSyncView: "content_stale" }, watchVersion: { send: false, why: "cant_rewrite" } });
    expect((await detail(seeded.past)).watchVersion).toBeUndefined();

    // Seeded again after a keep: the same rows, the claim open again.
    expect((await call(env, "POST", `/api/plan/workouts/${seeded.keepOnly}/watch-version/keep`, cookie)).status).toBe(200);
    expect(((await (await call(env, "GET", "/api/sync/status", cookie)).json()) as { contentStaleCount: number }).contentStaleCount).toBe(1);
    await call(env, "POST", "/api/dev/watch-version", cookie);
    expect(((await (await call(env, "GET", "/api/sync/status", cookie)).json()) as { contentStaleCount: number }).contentStaleCount).toBe(2);
  });
});
