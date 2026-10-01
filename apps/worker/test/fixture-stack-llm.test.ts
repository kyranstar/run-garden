/**
 * Audit 2 I1 / Ruling C2: the fixture stack (the e2e suite's, CI's) must
 * never reach the LLM gateway. `AI_DEFAULT_ENABLED:0` does not gate the coach
 * wake, and the Plan page's open wake fired against the real gateway with
 * `Bearer undefined` and the fixture dossier.
 *
 * These drive the Worker's REAL default export with the stack's own env
 * (FIXTURE_MODE=1, AI_DEFAULT_ENABLED=0, no key): fixture login, the seed,
 * then what the Plan page does — read `/api/coach/state`, and POST
 * `/api/coach/wake` when it says a wake is advised. The only stand-in is the
 * database (an in-memory test db behind `makeDb`) and the network beneath
 * `fetch`, which records every URL asked for.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/db.js")>();
  return { ...actual, makeDb: () => holder.db };
});

// Imported after the mock is registered (vi.mock is hoisted above imports).
const { default: worker } = await import("../src/index.js");

/** The env `apps/web/e2e/fixture-stack.sh` boots the worker with. */
function stackEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "http://localhost:5271",
    FIXTURE_MODE: "1",
    AI_DEFAULT_ENABLED: "0",
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

/** Every URL the network was asked for; answers like an OpenAI-style gateway. */
function recordNetwork(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const content = JSON.stringify({ briefing: "From the recorded model.", proposals: [], memoryOps: [] });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return urls;
}

const isLoopback = (u: string): boolean => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname);

async function call(env: Env, path: string, cookie?: string, method = "POST"): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};
  const res = await worker.fetch(new Request(`http://localhost:8971${path}`, { method, headers }), env, ctx);
  await Promise.allSettled(pending);
  return res;
}

/** fixture-stack.sh's own sequence: fixture login, then the seed. */
async function seededFixtureUser(env: Env): Promise<{ cookie: string; userId: string }> {
  holder.db = makeTestDb();
  const login = await call(env, "/api/dev/fixture-login");
  expect(login.status).toBe(200);
  const { userId } = (await login.json()) as { userId: string };
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const seed = await call(env, "/api/dev/seed", cookie);
  expect(seed.status).toBe(200);
  return { cookie, userId };
}

async function coachMessages(userId: string) {
  const db = holder.db as ReturnType<typeof makeTestDb>;
  return db
    .select()
    .from(schema.coachMessages)
    .where(and(eq(schema.coachMessages.userId, userId)));
}

describe("the fixture stack never reaches the LLM gateway (Audit 2 I1, Ruling C2)", () => {
  it("the Plan page's open wake on a freshly seeded fixture user: a canned reply, no network", async () => {
    const env = stackEnv();
    const { cookie, userId } = await seededFixtureUser(env);
    const db = holder.db as ReturnType<typeof makeTestDb>;
    const usageBefore = (await db.select().from(schema.llmUsage)).length; // the seed's own rows
    const network = recordNetwork();

    const state = await call(env, "/api/coach/state", cookie, "GET");
    expect(state.status).toBe(200);
    expect(((await state.json()) as { wakeAdvised: boolean }).wakeAdvised).toBe(true);

    const res = await call(env, "/api/coach/wake", cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
    expect(network).toEqual([]);
    const coach = (await coachMessages(userId)).filter((m) => m.role === "coach");
    expect(coach).toHaveLength(1);
    expect(coach[0]!.body).toMatch(/fixture mode/i);
    // Nothing was spent.
    expect((await db.select().from(schema.llmUsage)).length).toBe(usageBefore);
  });

  it("a message wake in fixture mode answers too, without the network — even with a key and a gateway URL", async () => {
    const env = stackEnv({ AI_GATEWAY_API_KEY: "a-real-looking-key", AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v1" });
    const { cookie } = await seededFixtureUser(env);
    const network = recordNetwork();
    const res = await worker.fetch(
      new Request("http://localhost:8971/api/coach/message", {
        method: "POST",
        headers: { Cookie: cookie, "content-type": "application/json" },
        body: JSON.stringify({ body: "How's my week looking?" }),
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(network).toEqual([]);
  });

  it("fixture mode reaches a model only at a loopback FIXTURE_MODEL_URL (the coach replay specs' recorded model)", async () => {
    const env = stackEnv({ AI_GATEWAY_API_KEY: "stub", FIXTURE_MODEL_URL: "http://127.0.0.1:8899" });
    const { cookie } = await seededFixtureUser(env);
    const network = recordNetwork();
    const res = await call(env, "/api/coach/wake", cookie);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
    expect(network).toEqual(["http://127.0.0.1:8899/chat/completions"]);
    expect(network.every(isLoopback)).toBe(true);

    // A FIXTURE_MODEL_URL that is not loopback is ignored: the canned reply.
    const remote = stackEnv({ AI_GATEWAY_API_KEY: "stub", FIXTURE_MODEL_URL: "https://ai-gateway.vercel.sh/v1" });
    const second = await seededFixtureUser(remote);
    const network2 = recordNetwork();
    await call(remote, "/api/coach/wake", second.cookie);
    expect(network2).toEqual([]);
  });

  it("outside fixture mode, no key means no gateway call — a receipt says why (no_key, like coach reads)", async () => {
    const db = makeTestDb();
    holder.db = db;
    const { userId } = await makeTestUser(db);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const env = stackEnv({ FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", APP_URL: "https://app.test" });
    const network = recordNetwork();
    const res = await call(env, "/api/coach/wake", cookie);
    expect(((await res.json()) as { status: string }).status).toBe("error");
    expect(network).toEqual([]);
    const receipts = (await coachMessages(userId)).filter((m) => m.role === "receipt");
    expect(receipts.map((r) => r.body)).toEqual([expect.stringMatching(/no model key/i)]);

    // Control: with a key, the same wake does reach the gateway.
    const keyed = { ...env, AI_GATEWAY_API_KEY: "test-key" };
    const db2 = makeTestDb();
    holder.db = db2;
    const user2 = await makeTestUser(db2);
    const cookie2 = `${SESSION_COOKIE}=${await createSession(db2, user2.userId)}`;
    const network2 = recordNetwork();
    await call(keyed, "/api/coach/wake", cookie2);
    expect(network2.some((u) => new URL(u).hostname === "ai-gateway.vercel.sh")).toBe(true);
  });

  it("fixture-stack.sh boots the worker in fixture mode with the gateway pointed at a dead local port", () => {
    const script = readFileSync(new URL("../../web/e2e/fixture-stack.sh", import.meta.url), "utf8");
    const dev = /npx wrangler dev [\s\S]*?&\n/.exec(script)?.[0] ?? "";
    expect(dev).toContain("--var FIXTURE_MODE:1");
    expect(dev).toMatch(/--var AI_GATEWAY_BASE_URL:http:\/\/127\.0\.0\.1:\d+ /);
    expect(dev).not.toContain("FIXTURE_MODEL_URL");
  });
});
