/**
 * The training-line journey's fixture lever (coach-training-line.spec.ts): `POST /api/dev/training-line` puts a running
 * plan in two abutting phases and a coach one-off in the account, written by the coach's own appliers, and answers what
 * "Stop this plan" would take off the calendar (the journey's confirm must say exactly that) — the same answer, one-off
 * and all, when called again. Fixture mode only: 404 outside it, before any sign-in. Driven through the Worker's real default export; only the database is a
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
    const seeded = (await res.json()) as { phases: string[]; oneOff: string; oneOffDate: string; stopCount: number };
    expect(seeded.phases).toHaveLength(2);
    type Lines = { plans: Array<{ id: string; name: string; status: string }>; lines: Array<{ phases: Array<{ id: string; futureSessions: number }> }> };
    const read = async () => (await (await call(env, "GET", "/api/coach/plans", { cookie })).json()) as Lines;
    const { plans, lines } = await read();
    expect(plans.filter((p) => seeded.phases.includes(p.id)).map((p) => [p.name, p.status])).toEqual([
      ["Base", "active"],
      ["Build", "active"],
    ]);
    // What a Stop takes off, as the line's confirm counts it: the journey asserts its confirm says exactly this.
    const line = lines.find((l) => l.phases.some((p) => p.id === seeded.phases[0]))!;
    expect(line.phases.map((p) => p.id)).toEqual(seeded.phases);
    expect(seeded.stopCount).toBe(line.phases.reduce((n, p) => n + p.futureSessions, 0));
    expect(seeded.stopCount).toBeGreaterThanOrEqual(6); // the whole second phase is ahead
    // The one-off is a session in a bucket, no phase's.
    const oneOff = (await (await call(env, "GET", `/api/plan/workouts/${seeded.oneOff}`, { cookie })).json()) as { workout: { id: string; planId: string; effectiveDate: string } };
    expect(oneOff.workout).toMatchObject({ id: seeded.oneOff, effectiveDate: seeded.oneOffDate });
    expect(oneOff.workout.planId.startsWith("adhoc-run-")).toBe(true);
    // Again: nothing written twice, and the same answer — the one-off's id too.
    const again = await call(env, "POST", "/api/dev/training-line", { cookie });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(seeded);
    expect((await read()).plans).toHaveLength(plans.length);
  });
});
