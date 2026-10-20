/**
 * The training-line journey's fixture lever (coach-training-line.spec.ts): `POST /api/dev/training-line` puts a running
 * plan in two abutting phases and a coach one-off in the account, written by the coach's own appliers. Fixture mode
 * only: 404 outside it, before any sign-in. Driven through the Worker's real default export; only the database is a
 * stand-in, and nothing reaches the network. Synthetic data only.
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
    COACH_DESIGNER: "1",
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(env: Env, method: string, path: string, opts: { cookie?: string } = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.cookie ? { Cookie: opts.cookie } : {}) };
  const res = await worker.fetch(new Request(`http://localhost:8971${path}`, { method, headers }), env, ctx);
  await Promise.allSettled(pending);
  return res;
}

describe("the training-line journey's fixture lever", () => {
  it("does not exist outside fixture mode, signed in or not", async () => {
    holder.db = makeTestDb();
    const off = stackEnv({ FIXTURE_MODE: "0" });
    expect((await call(off, "POST", "/api/dev/training-line")).status).toBe(404);
    const login = await call(stackEnv(), "POST", "/api/dev/fixture-login");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call(off, "POST", "/api/dev/training-line", { cookie })).status).toBe(404);
  });

  it("fixture mode: two abutting run phases, and again does nothing twice", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error(`unexpected network call: ${String(input instanceof Request ? input.url : input)}`);
    }) as typeof fetch;
    const env = stackEnv();
    holder.db = makeTestDb();
    expect((await call(env, "POST", "/api/dev/training-line")).status).toBe(401);
    const login = await call(env, "POST", "/api/dev/fixture-login");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const res = await call(env, "POST", "/api/dev/training-line", { cookie });
    expect(res.status).toBe(200);
    const seeded = (await res.json()) as { phases: string[]; oneOff: string };
    expect(seeded.phases).toHaveLength(2);
    const read = async () => ((await (await call(env, "GET", "/api/coach/plans", { cookie })).json()) as { plans: Array<{ id: string; name: string; status: string }> }).plans;
    const plans = await read();
    expect(plans.filter((p) => seeded.phases.includes(p.id)).map((p) => [p.name, p.status])).toEqual([
      ["Base", "active"],
      ["Build", "active"],
    ]);
    expect((await call(env, "POST", "/api/dev/training-line", { cookie })).status).toBe(200);
    expect(await read()).toHaveLength(plans.length);
  });
});
