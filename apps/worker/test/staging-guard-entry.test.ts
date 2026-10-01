/**
 * Audit 2 I2: the staging guard is only as good as its wiring. These drive
 * the Worker's REAL default export — `fetch` and `scheduled` from
 * src/index.ts — so a refactor that drops, moves or defers the line that
 * installs the guard fails here, not in staging.
 *
 * The only stand-in is the database: `makeDb` (what `withDb` calls with the
 * D1 binding) hands back an in-memory test db. Everything else — the origin
 * guard, `requireUser`, the COROS route and the read it starts — is the
 * production pipeline.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { StagingOutboundBlocked, uninstallStagingGuardForTests } from "../src/services/staging.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const holder = vi.hoisted(() => ({ db: undefined as unknown, makeDbCalls: 0 }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/db.js")>();
  return {
    ...actual,
    makeDb: () => {
      holder.makeDbCalls += 1;
      return holder.db;
    },
  };
});

// Imported after the mock is registered (vi.mock is hoisted above imports).
const { default: worker } = await import("../src/index.js");

const KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "0",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    ...overrides,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  uninstallStagingGuardForTests();
  globalThis.fetch = realFetch;
});

/** A signed-in athlete with a cloud COROS connection whose stored password
 * hash decrypts — so POST /api/coros/read-now really goes to COROS. */
async function connectedAthlete(): Promise<{ db: Db; cookie: string }> {
  const db = makeTestDb();
  const { userId } = await makeTestUser(db);
  await db.insert(schema.providerConnections).values({
    id: newId(),
    userId,
    provider: "coros",
    status: "connected",
    encryptedRefreshToken: await encryptSecret(createHash("md5").update("pw").digest("hex"), KEY),
    externalAccountId: "98765",
    meta: { email: "runner@example.com", region: "us" },
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  holder.db = db;
  return { db, cookie: `${SESSION_COOKIE}=${await createSession(db, userId)}` };
}

/** Every URL the network beneath the guard was asked for. */
function recordNetwork(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ result: "1001", message: "no" }), { status: 200 });
  }) as typeof fetch;
  return urls;
}

async function readNow(env: Env, cookie: string): Promise<{ status: string }> {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const res = await worker.fetch(
    new Request("https://app.test/api/coros/read-now", { method: "POST", headers: { Cookie: cookie } }),
    env,
    ctx,
  );
  await Promise.allSettled(pending);
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string };
}

describe("the Worker's real entry point (src/index.ts)", () => {
  it("control: without STAGING, the read-now route does reach COROS", async () => {
    const { cookie } = await connectedAthlete();
    const network = recordNetwork();
    await readNow(makeEnv(), cookie);
    expect(network.some((u) => new URL(u).hostname.endsWith("coros.com"))).toBe(true);
  });

  it("with STAGING=1, fetch installs the guard before any route: the route's COROS call never leaves", async () => {
    const { cookie } = await connectedAthlete();
    const network = recordNetwork();
    const body = await readNow(makeEnv({ STAGING: "1" }), cookie);

    expect(body.status).toBe("coros_unreachable");
    expect(network).toEqual([]);
    // …and it stays installed for everything else this isolate runs.
    for (const url of [
      "https://teamapi.coros.com/account/login",
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      "https://mcp.coros.com/mcp",
      "https://ai-gateway.vercel.sh/v1/chat/completions",
    ]) {
      await expect(fetch(url)).rejects.toBeInstanceOf(StagingOutboundBlocked);
    }
    expect(network).toEqual([]);
  });

  it("with STAGING=1, scheduled returns before any work: no database, no task, no network", async () => {
    holder.makeDbCalls = 0;
    const network = recordNetwork();
    const waitUntil = vi.fn();
    for (const cron of ["*/30 * * * *", "15 * * * *", "0 20 * * MON", "unknown"]) {
      await worker.scheduled(
        { cron } as ScheduledController,
        makeEnv({ STAGING: "1" }),
        { waitUntil } as unknown as ExecutionContext,
      );
    }
    expect(waitUntil).not.toHaveBeenCalled();
    expect(holder.makeDbCalls).toBe(0);
    expect(network).toEqual([]);
  });
});
