/**
 * The coach-notices journey's fixture lever (stream H; coach-notices.spec.ts): `POST /api/dev/coach-notices` puts last
 * week's review and a run finished this morning in the account, as the Monday cron and a watch import would — and the
 * coach's opening read then says them. Fixture mode only. Driven through the Worker's real default export with the
 * fixture stack's env; only the database is a stand-in, and nothing reaches the network. Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { parseCoachNoticesSeed } from "../src/services/fixture-coach-notices.js";
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

async function call(env: Env, method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.cookie ? { Cookie: opts.cookie } : {}) };
  const res = await worker.fetch(
    new Request(`http://localhost:8971${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }),
    env,
    ctx,
  );
  await Promise.allSettled(pending);
  return res;
}

const REVIEW = "You ran 4 times for 32.1 kilometres. Two strength sessions too.";
const RUN = { meters: 16_000, seconds: 5440, zones: [1200, 3500, 600, 100, 40] };

describe("the coach-notices journey's fixture lever", () => {
  it("does not exist outside fixture mode", async () => {
    holder.db = makeTestDb();
    expect((await call(stackEnv({ FIXTURE_MODE: "0" }), "POST", "/api/dev/coach-notices", { body: { review: REVIEW } })).status).toBe(404);
  });

  it("takes a review's words and a run's figures, nothing else", () => {
    expect(parseCoachNoticesSeed({ review: REVIEW, run: RUN })).toEqual({ review: REVIEW, run: RUN });
    expect(parseCoachNoticesSeed({ run: { ...RUN, zones: [1, 2] } })).toEqual({ run: { meters: 16_000, seconds: 5440 } });
    for (const bad of [{}, null, { review: "  " }, { run: { meters: -1, seconds: 600 } }, { run: { meters: 5000, seconds: 10 } }]) {
      expect(parseCoachNoticesSeed(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("fixture mode: the review and this morning's run seeded — the opening read says the review, then (seen) the run", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error(`unexpected network call: ${String(input instanceof Request ? input.url : input)}`);
    }) as typeof fetch;
    const env = stackEnv();
    holder.db = makeTestDb();
    const login = await call(env, "POST", "/api/dev/fixture-login");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect((await call(env, "POST", "/api/dev/coach-notices", { body: { review: REVIEW } })).status).toBe(401);
    expect((await call(env, "POST", "/api/dev/coach-notices", { cookie, body: {} })).status).toBe(400);
    const seeded = (await (await call(env, "POST", "/api/dev/coach-notices", { cookie, body: { review: REVIEW, run: RUN } })).json()) as {
      weekStart: string;
      activityId: string;
    };
    const read = async (seen = "") =>
      (await (await call(env, "GET", `/api/coach/nudges${seen ? `?seen=${encodeURIComponent(seen)}` : ""}`, { cookie })).json()) as {
        opening?: { id: string; line: string; chips: Array<{ label: string }> };
      };
    expect((await read()).opening).toMatchObject({
      id: `review:${seeded.weekStart}`,
      line: "From last week's review: You ran 4 times for 32.1 kilometres.",
      chips: [{ label: "Plan this week" }],
    });
    expect((await read(`review:${seeded.weekStart}`)).opening).toMatchObject({
      id: `session:${seeded.activityId}`,
      line: "Today's run is in — 16 km at 5:40 /km, mostly easy.",
      chips: [{ label: "Plan tomorrow around it" }],
    });
    // Seeded again: the review's words replaced, the one row kept.
    await call(env, "POST", "/api/dev/coach-notices", { cookie, body: { review: "A quieter week. Rest mattered." } });
    expect((await read()).opening?.line).toBe("From last week's review: A quieter week.");
  });
});
