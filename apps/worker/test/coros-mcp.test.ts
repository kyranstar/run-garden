/**
 * The official COROS sleep connection (sleep/recovery phase 2): OAuth
 * discovery → dynamic registration → PKCE exchange → refresh rotation →
 * MCP tools/call → normalized sleep_records. The mock speaks the same
 * protocol stack the probes verified on mcpus.coros.com (2026-08-19),
 * including the SSE response variant Streamable HTTP servers may use.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { oauthStates, providerConnections, sleepRecords } from "@rg/database";
import type { Env } from "../src/env.js";
import {
  buildDateArgs,
  completeCorosMcpAuth,
  consumeCorosMcpState,
  corosMcpAccessToken,
  disconnectCorosMcp,
  extractNights,
  ingestSleep,
  normalizeNight,
  startCorosMcpAuth,
  syncCorosMcpSleep,
} from "../src/services/coros-mcp.js";
import { decryptSecret } from "../src/auth/crypto.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "0",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

const ISSUER = "https://mcpus.test";

interface MockOpts {
  /** tools/call result payload; default = a realistic querySleepData. */
  toolResult?: unknown;
  /** Wrap the tools/call response as SSE instead of plain JSON. */
  sse?: boolean;
  /** Reject refresh_token grants with invalid_grant. */
  refreshDies?: boolean;
  /** Input schema advertised for querySleepData. */
  inputSchema?: Record<string, unknown>;
}

/** The full OAuth + MCP surface as one scripted fetch. */
function mockMcp(opts: MockOpts = {}) {
  const calls: Array<{ url: string; body?: string }> = [];
  let issuedRefresh = "refresh-1";
  const toolResult =
    opts.toolResult ??
    ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            dayDataList: [
              {
                happenDay: 20260817,
                performance: 78,
                sleepData: {
                  totalSleepTime: 432, // minutes
                  deepTime: 80,
                  lightTime: 260,
                  eyeTime: 76,
                  wakeTime: 16,
                  startTime: 1786930200, // epoch seconds
                  endTime: 1786956600,
                },
              },
              {
                happenDay: 20260818,
                performance: 84,
                sleepData: { totalSleepTime: 465, deepTime: 88, lightTime: 280, eyeTime: 82, wakeTime: 15 },
              },
              // Junk the normalizer must refuse: a 10-minute "night".
              { happenDay: 20260819, sleepData: { totalSleepTime: 10 } },
            ],
          }),
        },
      ],
    } as unknown);

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : init?.body?.toString();
    calls.push({ url, body });
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      });

    if (url.includes("/.well-known/oauth-protected-resource")) {
      return json({ authorization_servers: [ISSUER] });
    }
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        registration_endpoint: `${ISSUER}/connect/register`,
        revocation_endpoint: `${ISSUER}/oauth2/revoke`,
      });
    }
    if (url === `${ISSUER}/connect/register`) {
      return json({ client_id: "client-abc" });
    }
    if (url === `${ISSUER}/oauth2/token`) {
      const params = new URLSearchParams(body ?? "");
      if (params.get("grant_type") === "authorization_code") {
        if (!params.get("code_verifier")) return json({ error: "invalid_request" }, 400);
        return json({
          access_token: "access-1",
          refresh_token: issuedRefresh,
          expires_in: 3600,
          scope: "openid mcp.tools offline_access",
        });
      }
      if (params.get("grant_type") === "refresh_token") {
        if (opts.refreshDies) return json({ error: "invalid_grant" }, 400);
        // Rotation: each refresh mints a new refresh token.
        issuedRefresh = `refresh-${Number(issuedRefresh.split("-")[1]) + 1}`;
        return json({ access_token: "access-2", refresh_token: issuedRefresh, expires_in: 3600 });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (url === `${ISSUER}/oauth2/revoke`) {
      return new Response(null, { status: 200 });
    }
    if (url === "https://mcp.coros.com/mcp") {
      const req = JSON.parse(body ?? "{}") as { method?: string; params?: { name?: string } };
      if (req.method === "initialize") {
        return json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
      }
      if (req.method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              {
                name: "querySleepData",
                inputSchema:
                  opts.inputSchema ??
                  ({
                    properties: {
                      startDate: { type: "integer", description: "Start date, YYYYMMDD" },
                      endDate: { type: "integer", description: "End date, YYYYMMDD" },
                    },
                    required: ["startDate", "endDate"],
                  } as Record<string, unknown>),
              },
            ],
          },
        });
      }
      if (req.method === "tools/call") {
        const payload = { jsonrpc: "2.0", id: 1, result: toolResult };
        if (opts.sse) {
          return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return json(payload);
      }
    }
    return json({ error: "unexpected url " + url }, 500);
  }) as typeof fetch;

  return { fetchImpl, calls };
}

async function connect(db: ReturnType<typeof makeTestDb>, env: Env, userId: string, mock: ReturnType<typeof mockMcp>) {
  const authUrl = await startCorosMcpAuth(db, env, userId, "/settings", mock.fetchImpl);
  const state = new URL(authUrl).searchParams.get("state")!;
  const stored = await consumeCorosMcpState(db, state);
  const ok = await completeCorosMcpAuth(db, env, userId, "code-1", stored!.codeVerifier, mock.fetchImpl);
  expect(ok).toBe(true);
}

describe("coros-mcp OAuth lifecycle", () => {
  it("start: discovers, registers a public client, parks PKCE, builds the authorize URL", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const mock = mockMcp();
    const url = new URL(await startCorosMcpAuth(db, makeEnv(), userId, "/settings", mock.fetchImpl));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth2/authorize`);
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/api/auth/coros-mcp/callback");
    const state = url.searchParams.get("state")!;
    const row = (await db.select().from(oauthStates).where(eq(oauthStates.state, state)))[0];
    expect(row?.provider).toBe("coros_mcp");
    expect(row?.codeVerifier).toBeTruthy();
    // The state is one-shot.
    expect(await consumeCorosMcpState(db, state)).not.toBeNull();
    expect(await consumeCorosMcpState(db, state)).toBeNull();
  });

  it("callback: exchanges with the parked verifier and stores tokens ENCRYPTED", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const env = makeEnv();
    const mock = mockMcp();
    await connect(db, env, userId, mock);
    const conn = (
      await db.select().from(providerConnections).where(eq(providerConnections.userId, userId))
    ).find((c) => c.provider === "coros_mcp")!;
    expect(conn.status).toBe("connected");
    expect(conn.encryptedAccessToken).not.toContain("access-1");
    expect(await decryptSecret(conn.encryptedAccessToken!, TEST_KEY)).toBe("access-1");
    expect(await decryptSecret(conn.encryptedRefreshToken!, TEST_KEY)).toBe("refresh-1");
    // The exchange really carried the PKCE verifier.
    const exchange = mock.calls.find((c) => c.url.endsWith("/oauth2/token"));
    expect(exchange?.body).toContain("code_verifier=");
  });

  it("refresh: rotates the refresh token; a dead one marks needs_reauth", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const env = makeEnv();
    const mock = mockMcp();
    await connect(db, env, userId, mock);
    // Force expiry, then fetch a token — must refresh and store the rotation.
    await db
      .update(providerConnections)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(providerConnections.userId, userId));
    expect(await corosMcpAccessToken(db, env, userId, mock.fetchImpl)).toBe("access-2");
    const conn = (
      await db.select().from(providerConnections).where(eq(providerConnections.userId, userId))
    ).find((c) => c.provider === "coros_mcp")!;
    expect(await decryptSecret(conn.encryptedRefreshToken!, TEST_KEY)).toBe("refresh-2");

    // Now the refresh dies: needs_reauth, and no token comes back.
    const dead = mockMcp({ refreshDies: true });
    await db
      .update(providerConnections)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(providerConnections.userId, userId));
    expect(await corosMcpAccessToken(db, env, userId, dead.fetchImpl)).toBeNull();
    const after = (
      await db.select().from(providerConnections).where(eq(providerConnections.userId, userId))
    ).find((c) => c.provider === "coros_mcp")!;
    expect(after.status).toBe("error");
    expect(after.lastErrorCategory).toBe("needs_reauth");
  });

  it("disconnect: best-effort revoke, tokens forgotten", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const env = makeEnv();
    const mock = mockMcp();
    await connect(db, env, userId, mock);
    await disconnectCorosMcp(db, env, userId, mock.fetchImpl);
    const conn = (
      await db.select().from(providerConnections).where(eq(providerConnections.userId, userId))
    ).find((c) => c.provider === "coros_mcp")!;
    expect(conn.status).toBe("disconnected");
    expect(conn.encryptedAccessToken).toBeNull();
    expect(conn.encryptedRefreshToken).toBeNull();
    expect(mock.calls.some((c) => c.url.endsWith("/oauth2/revoke"))).toBe(true);
  });
});

describe("sleep sync", () => {
  it("pulls, normalizes (minutes→seconds, wake-date keyed) and ingests; junk nights refused", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const env = makeEnv();
    const mock = mockMcp();
    await connect(db, env, userId, mock);
    const result = await syncCorosMcpSleep(db, env, userId, "America/New_York", mock.fetchImpl);
    expect(result.status).toBe("ok");
    expect(result.written).toBe(2); // the 10-minute "night" was refused
    const rows = await db.select().from(sleepRecords).where(eq(sleepRecords.userId, userId));
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const n17 = byDate.get("2026-08-17")!;
    expect(n17.durationSeconds).toBe(432 * 60);
    expect(n17.deepSeconds).toBe(80 * 60);
    expect(n17.remSeconds).toBe(76 * 60); // eyeTime IS REM on this wire
    expect(n17.startTime).toContain("T"); // epoch seconds became an instant
    expect(n17.qualityScore).toBe(78);
    expect(byDate.get("2026-08-19")).toBeUndefined();
    // First pull reaches 42 days back, as YYYYMMDD ints per the inputSchema.
    const call = mock.calls.filter((c) => c.url.endsWith("/mcp")).map((c) => JSON.parse(c.body!))
      .find((b) => b.method === "tools/call");
    expect(call.params.arguments.startDate).toBeTypeOf("number");
    expect(String(call.params.arguments.endDate)).toHaveLength(8);
    // Second sync with identical payload: fingerprint-skipped, not rewritten.
    const again = await syncCorosMcpSleep(db, env, userId, "America/New_York", mock.fetchImpl);
    expect(again.status).toBe("ok");
    expect(again.written).toBe(0);
    expect(again.skipped).toBe(2);
  });

  it("reads the SSE response variant identically", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const env = makeEnv();
    const mock = mockMcp({ sse: true });
    await connect(db, env, userId, mock);
    const result = await syncCorosMcpSleep(db, env, userId, "America/New_York", mock.fetchImpl);
    expect(result.status).toBe("ok");
    expect(result.written).toBe(2);
  });

  it("a substantial payload it cannot read is a shape_error on the connection — never a guessed record", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const env = makeEnv();
    const mock = mockMcp({
      toolResult: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              // Plenty of content, none of it night-shaped.
              blob: Array.from({ length: 40 }, (_, i) => ({ mysteryField: i, value: `x${i}` })),
            }),
          },
        ],
      },
    });
    await connect(db, env, userId, mock);
    const result = await syncCorosMcpSleep(db, env, userId, "America/New_York", mock.fetchImpl);
    expect(result.status).toBe("shape_error");
    expect(await db.select().from(sleepRecords).where(eq(sleepRecords.userId, userId))).toHaveLength(0);
    const conn = (
      await db.select().from(providerConnections).where(eq(providerConnections.userId, userId))
    ).find((c) => c.provider === "coros_mcp")!;
    expect(conn.lastErrorCategory).toBe("shape_error");
  });
});

describe("shape helpers", () => {
  it("buildDateArgs follows the tool's own schema — ISO strings when it asks for strings", () => {
    const args = buildDateArgs(
      {
        name: "querySleepData",
        inputSchema: {
          properties: {
            startDate: { type: "string", description: "ISO date" },
            endDate: { type: "string", description: "ISO date" },
          },
        },
      },
      "2026-08-01",
      "2026-08-19",
    );
    expect(args).toEqual({ startDate: "2026-08-01", endDate: "2026-08-19" });
  });

  it("normalizeNight handles ratio-shaped stages and refuses the unreadable", () => {
    const night = normalizeNight({
      date: "2026-08-18",
      duration: 27000, // seconds (>1200 → already seconds)
      deepRatio: 0.2,
      remRatio: 18, // 0..100 style
      score: 81,
    });
    expect(night).toEqual({
      date: "2026-08-18",
      durationSeconds: 27000,
      deepSeconds: 5400,
      remSeconds: 4860,
      lightSeconds: null,
      awakeSeconds: null,
      startTime: null,
      endTime: null,
      qualityScore: 81,
    });
    expect(normalizeNight({ note: "no dates here" })).toBeNull();
    expect(normalizeNight({ happenDay: 20260818 })).toBeNull(); // no duration
  });

  it("extractNights prefers structuredContent and dedupes by date", () => {
    const nights = extractNights({
      structuredContent: {
        list: [
          { happenDay: 20260818, totalSleepTime: 400 },
          { happenDay: 20260818, totalSleepTime: 410 },
          { happenDay: 20260817, totalSleepTime: 420 },
        ],
      },
    });
    expect(nights.map((n) => n.date)).toEqual(["2026-08-17", "2026-08-18"]);
    expect(nights[1]!.durationSeconds).toBe(410 * 60);
  });

  it("ingestSleep COALESCEs: a later stage-less pull never blanks stored stages", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await ingestSleep(db, userId, [
      {
        date: "2026-08-18",
        durationSeconds: 27000,
        deepSeconds: 5400,
        remSeconds: 4800,
        lightSeconds: null,
        awakeSeconds: null,
        startTime: null,
        endTime: null,
        qualityScore: 80,
      },
    ]);
    await ingestSleep(db, userId, [
      {
        date: "2026-08-18",
        durationSeconds: 27060,
        deepSeconds: null,
        remSeconds: null,
        lightSeconds: null,
        awakeSeconds: null,
        startTime: null,
        endTime: null,
        qualityScore: null,
      },
    ]);
    const row = (await db.select().from(sleepRecords).where(eq(sleepRecords.userId, userId)))[0]!;
    expect(row.durationSeconds).toBe(27060); // duration follows the newest read
    expect(row.deepSeconds).toBe(5400); // stages survive a stage-less pull
    expect(row.qualityScore).toBe(80);
  });
});
