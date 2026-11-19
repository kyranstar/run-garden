/**
 * COROS REFUSING THE GRANT, READ AS WHAT IT IS (seen live from 2026-11-18 ~00:30Z).
 *
 * From then on every COROS MCP tool call answered HTTP 200, `isError` false, with one double-encoded text item in place
 * of data: "Client authentication credentials missing, expired, or identity mismatched. Diagnostic advice: …". The
 * sleep pull read it as an unreadable daily report (no nights), fell back to `querySleepData` — which COROS no longer
 * lists — and returned `tool_missing` without a write. So `last_sync_at` froze at 11-18 00:00Z, no error category was
 * recorded, the sweep counted the attempt (`"sleep":true`) and retried every half hour, and Settings kept saying
 * "Connected · synced 1d ago".
 *
 * Now the refusal (or a 401) is an auth failure on every tool through one check: one refresh grant and one retry, and
 * if COROS still says no, the connection needs reconnecting — never synced, never zero sleep — and reconnecting reads
 * the gap back from the last good sync. The mock speaks the live server's shape: `tools/list` unchanged, no
 * `querySleepData`, the FIT tools listed (and never called). Synthetic data only; dates are relative to today.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerConnections, sleepRecords } from "@rg/database";
import { addDays, daysBetween, nowInstant, todayInZone, type LocalDate, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { syncRoutes } from "../src/routes/sync.js";
import { buildDossier } from "../src/services/coach-context.js";
import {
  completeCorosMcpAuth,
  consumeCorosMcpState,
  corosMcpSleepSweep,
  corosRefusesGrant,
  probeMcpTool,
  SLEEP_RECONNECT_WORDS,
  startCorosMcpAuth,
  syncCorosMcpSleep,
} from "../src/services/coros-mcp.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const TZ = "America/Los_Angeles";
const ISSUER = "https://mcpus.test";
const MCP = "https://mcp.coros.com/mcp";

const ENV = {
  DB: {} as unknown as Env["DB"],
  ASSETS: {} as unknown as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "0",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
} as Env;

const REFUSAL =
  "Client authentication credentials missing, expired, or identity mismatched. Diagnostic advice: Verify COROS App login status, or confirm whether the current App account aligns with the MCP authorized account.";
/** The live reply: double-encoded, not flagged an error. */
const REFUSED_REPLY = { content: [{ type: "text", text: JSON.stringify(REFUSAL) }], isError: false };

/** queryDailyHealthData's prose (coros-mcp.ts parseDailyHealthText), one block a day; `nights` carry a sleep summary. */
function dailyReport(days: LocalDate[], nights: Set<LocalDate>): string {
  const blocks = days.map((d) => {
    const head = `--- ${d.replaceAll("-", "")} ---\nSteps: 4,000 | Calories: 200 kcal | Exercise: 10 min\nStress: Avg 20\n`;
    return nights.has(d)
      ? `${head}Sleep Summary:\n  Total: 7h 0min | Deep: 1h 0min | Light: 4h 30min | REM: 1h 10min | Awake: 20 min\n  Sleep HR: Avg 50 bpm | Min 45 bpm | Max 60 bpm\n`
      : head;
  });
  return `Daily Health Data — Last ${days.length} days | Resting HR: 46 bpm\nNote: sleep entries are dated by their wake-up day.\n\n${blocks.join("\n")}`;
}

interface MockOpts {
  /** Which bearer tokens COROS refuses (its 200 + refusal text); default none. */
  refuses?: (token: string) => boolean;
  /** Which bearer tokens get a bare HTTP 401 on tools/call. */
  unauthorized?: (token: string) => boolean;
  /** The token endpoint's answer to a refresh grant: 200 (default), 400 (invalid_grant) or 503. */
  refreshStatus?: number;
  /** The nights COROS holds (wake dates). */
  nights?: LocalDate[];
  /** queryDailyHealthData's reply, overriding the report built from `nights`. */
  dailyReply?: unknown;
}

function mockCoros(opts: MockOpts = {}) {
  const toolCalls: Array<{ name: string; token: string; args: Record<string, unknown> }> = [];
  let refreshGrants = 0;
  let minted = 1;
  const held = new Set(opts.nights ?? []);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : (init?.body?.toString() ?? "");
    if (url.includes("/.well-known/oauth-protected-resource")) return json({ authorization_servers: [ISSUER] });
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        registration_endpoint: `${ISSUER}/connect/register`,
        revocation_endpoint: `${ISSUER}/oauth2/revoke`,
      });
    }
    if (url === `${ISSUER}/connect/register`) return json({ client_id: "client-abc" });
    if (url === `${ISSUER}/oauth2/token`) {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        refreshGrants += 1;
        const status = opts.refreshStatus ?? 200;
        if (status !== 200) return json({ error: status === 400 ? "invalid_grant" : "unavailable" }, status);
      }
      minted += 1;
      return json({ access_token: `access-${minted}`, refresh_token: `refresh-${minted}`, expires_in: 30 * 86400 });
    }
    if (url === MCP) {
      const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "") ?? "";
      const req = JSON.parse(body) as { method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (req.method === "initialize") return json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
      // tools/list is unchanged under the refusal — the live server's list, querySleepData long gone, the FIT tools in it.
      if (req.method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "queryDailyHealthData", inputSchema: { properties: { days: { type: "integer" } } } },
              { name: "querySleepOverview", inputSchema: { properties: { days: { type: "integer" } } } },
              { name: "querySleepHrv", inputSchema: { properties: { days: { type: "integer" } } } },
              { name: "queryRecoveryStatus", inputSchema: { properties: {} } },
              { name: "downloadActivityFitFiles", inputSchema: { properties: { labelIds: { type: "array" } } } },
              { name: "queryActivityFitFileDownloadUrls", inputSchema: { properties: { labelIds: { type: "array" } } } },
            ],
          },
        });
      }
      if (req.method === "tools/call") {
        const name = req.params?.name ?? "";
        toolCalls.push({ name, token, args: req.params?.arguments ?? {} });
        if (opts.unauthorized?.(token)) return new Response("unauthorized", { status: 401 });
        if (opts.refuses?.(token)) return json({ jsonrpc: "2.0", id: 1, result: REFUSED_REPLY });
        if (name === "queryDailyHealthData") {
          if (opts.dailyReply !== undefined) return json({ jsonrpc: "2.0", id: 1, result: opts.dailyReply });
          const n = Number(req.params?.arguments?.days ?? 7);
          const today = todayInZone(TZ);
          const days = Array.from({ length: n }, (_, i) => addDays(today, -(n - 1 - i)));
          const text = dailyReport(days, held);
          return json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(text) }], isError: false } });
        }
        return json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify("Recovery: ok") }], isError: false } });
      }
    }
    return json({ error: `unexpected ${url}` }, 500);
  }) as typeof fetch;
  return {
    fetchImpl,
    toolCalls,
    refreshGrants: () => refreshGrants,
    hold: (d: LocalDate) => held.add(d),
  };
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: LocalDate;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(TZ);
});

async function connect(fetchImpl: typeof fetch) {
  const authUrl = await startCorosMcpAuth(db, ENV, userId, "/settings", fetchImpl);
  const state = new URL(authUrl).searchParams.get("state")!;
  const stored = await consumeCorosMcpState(db, state);
  expect(await completeCorosMcpAuth(db, ENV, userId, "code-1", stored!.codeVerifier, fetchImpl)).toBe(true);
}

const sleepRow = async () =>
  (await db.select().from(providerConnections).where(eq(providerConnections.userId, userId))).find((r) => r.provider === "coros_mcp")!;

/** The production picture: last good sync `daysAgo` days back, one night on record from before it. */
async function lastGoodSync(daysAgo: number, night: LocalDate) {
  await db.insert(sleepRecords).values({ id: `${userId}:${night}`, userId, date: night, durationSeconds: 7 * 3600, provider: "coros", contentFingerprint: "seed", updatedAt: nowInstant() });
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  await db.update(providerConnections).set({ lastSyncAt: at, updatedAt: at }).where(eq(providerConnections.userId, userId));
  return at;
}

const fitCalls = (calls: Array<{ name: string }>) => calls.filter((c) => /fit/i.test(c.name));

describe("the refusal is recognized in any tool reply", () => {
  it("double-encoded, plain, or flagged isError — and only from a reply's first line", () => {
    expect(corosRefusesGrant(REFUSED_REPLY)).toBe(true);
    expect(corosRefusesGrant({ content: [{ type: "text", text: REFUSAL }] })).toBe(true);
    expect(corosRefusesGrant({ content: [{ type: "text", text: JSON.stringify(REFUSAL) }], isError: true })).toBe(true);
    // A real report is data, and a reply that only mentions the words further down is not a refusal.
    expect(corosRefusesGrant({ content: [{ type: "text", text: dailyReport([today], new Set([today])) }] })).toBe(false);
    expect(corosRefusesGrant({ content: [{ type: "text", text: `Activities\n\nRun: ${REFUSAL}` }] })).toBe(false);
    expect(corosRefusesGrant({ content: [] })).toBe(false);
    expect(corosRefusesGrant(undefined)).toBe(false);
  });
});

describe("a refusal is an auth failure, like a 401", () => {
  it("one refresh grant, one retry, then the connection needs reconnecting — never synced, never zero sleep", async () => {
    const mock = mockCoros({ refuses: () => true });
    await connect(mock.fetchImpl);
    const lastNight = addDays(today, -8);
    const at = await lastGoodSync(1, lastNight);

    const result = await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl);

    expect(result.status).toBe("needs_reauth");
    expect(mock.refreshGrants()).toBe(1);
    expect(mock.toolCalls.map((c) => [c.name, c.token])).toEqual([
      ["queryDailyHealthData", "access-2"],
      ["queryDailyHealthData", "access-3"],
    ]);
    const row = await sleepRow();
    expect(row.status).toBe("error");
    expect(row.lastErrorCategory).toBe("credentials_rejected");
    expect(row.lastSyncAt).toBe(at);
    expect((row.meta as { lastToolError?: string }).lastToolError).toMatch(/refused/i);
    // Unknown, not missing: nothing written, no zero nights.
    expect((await db.select().from(sleepRecords)).map((r) => r.date)).toEqual([lastNight]);
    expect(fitCalls(mock.toolCalls)).toEqual([]);
  });

  it("the refresh is enough when COROS takes the new token: the retry reads, and the sync is ok", async () => {
    const mock = mockCoros({ refuses: (t) => t === "access-2", nights: [addDays(today, -1)] });
    await connect(mock.fetchImpl);
    const result = await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl);
    expect(result).toMatchObject({ status: "ok", written: 1 });
    expect(mock.refreshGrants()).toBe(1);
    const row = await sleepRow();
    expect(row.status).toBe("connected");
    expect(row.lastErrorCategory).toBeNull();
    expect(row.lastSyncAt).not.toBeNull();
  });

  it("a refusal whose refresh COROS turns down needs reconnecting, with no retry on a dead grant", async () => {
    const mock = mockCoros({ refuses: () => true, refreshStatus: 400 });
    await connect(mock.fetchImpl);
    expect((await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl)).status).toBe("needs_reauth");
    expect(mock.toolCalls).toHaveLength(1);
    const row = await sleepRow();
    expect(row.status).toBe("error");
    expect(row.lastErrorCategory).toBe("credentials_rejected");
  });

  it("an HTTP 401 on a tool call takes the same path: refresh, retry, and reconnect if it persists", async () => {
    const once = mockCoros({ unauthorized: (t) => t === "access-2", nights: [addDays(today, -1)] });
    await connect(once.fetchImpl);
    expect((await syncCorosMcpSleep(db, ENV, userId, TZ, once.fetchImpl)).status).toBe("ok");
    expect(once.refreshGrants()).toBe(1);

    const always = mockCoros({ unauthorized: () => true });
    expect((await syncCorosMcpSleep(db, ENV, userId, TZ, always.fetchImpl)).status).toBe("needs_reauth");
    expect((await sleepRow()).lastErrorCategory).toBe("credentials_rejected");
  });

  it("a refresh that fails for a moment (503) marks nothing: an error, still connected for the next sweep", async () => {
    const mock = mockCoros({ refuses: () => true, refreshStatus: 503 });
    await connect(mock.fetchImpl);
    const at = await lastGoodSync(1, addDays(today, -8));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl)).status).toBe("error");
    } finally {
      error.mockRestore();
    }
    const row = await sleepRow();
    expect(row.status).toBe("connected");
    expect(row.lastSyncAt).toBe(at);
  });
});

describe("the sweep", () => {
  it("says what the pull did, and stops pulling once the connection needs reconnecting", async () => {
    const mock = mockCoros({ refuses: () => true });
    await connect(mock.fetchImpl);
    await lastGoodSync(1, addDays(today, -8));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await corosMcpSleepSweep(db, ENV, async () => TZ, mock.fetchImpl, userId)).toEqual({ pulled: 1, outcomes: ["needs_reauth"] });
      expect(await corosMcpSleepSweep(db, ENV, async () => TZ, mock.fetchImpl, userId)).toEqual({ pulled: 0, outcomes: [] });
    } finally {
      warn.mockRestore();
    }
    expect(mock.refreshGrants()).toBe(1);
  });
});

describe("every surface says reconnect", () => {
  it("the sync line, and the coach: no data since the last night — the connection needs reconnecting", async () => {
    const mock = mockCoros({ refuses: () => true });
    await connect(mock.fetchImpl);
    const lastNight = addDays(today, -8);
    await lastGoodSync(1, lastNight);
    await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl);

    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const res = await mountRoutes(db, "/api/sync", syncRoutes).request("/api/sync/status", { headers: { Cookie: cookie } }, ENV);
    expect(((await res.json()) as { sleepNeedsReconnect?: boolean }).sleepNeedsReconnect).toBe(true);

    const d = await buildDossier(db, userId, prefs, today);
    expect(d.text).toContain(`no data since ${lastNight} — ${SLEEP_RECONNECT_WORDS}.`);
  });

  it("the debug probe goes through the same check", async () => {
    const mock = mockCoros({ refuses: () => true });
    await connect(mock.fetchImpl);
    const out = await probeMcpTool(db, ENV, userId, "querySleepHrv", 3, TZ, mock.fetchImpl);
    expect(out.error).toMatch(/stopped accepting/i);
    expect(out.preview).toBeUndefined();
    expect((await sleepRow()).lastErrorCategory).toBe("credentials_rejected");
  });
});

describe("after reconnecting, the gap fills", () => {
  it("from a week before the last good sync, through queryDailyHealthData only — never a FIT tool", async () => {
    const refusing = mockCoros({ refuses: () => true });
    await connect(refusing.fetchImpl);
    const lastNight = addDays(today, -8);
    const at = await lastGoodSync(8, lastNight);
    await syncCorosMcpSleep(db, ENV, userId, TZ, refusing.fetchImpl);
    expect((await sleepRow()).status).toBe("error");

    // The owner reconnects; COROS takes the new grant. The callback's pull reads the gap back.
    const gap = [addDays(today, -7), addDays(today, -6), addDays(today, -2), addDays(today, -1)];
    const accepting = mockCoros({ nights: gap });
    await connect(accepting.fetchImpl);
    const result = await syncCorosMcpSleep(db, ENV, userId, TZ, accepting.fetchImpl);

    expect(result).toMatchObject({ status: "ok", written: gap.length });
    const lastSyncDay = todayInZone(TZ, new Date(at));
    const daily = accepting.toolCalls.filter((c) => c.name === "queryDailyHealthData");
    expect(daily).toHaveLength(1);
    expect(daily[0]!.args.days).toBe(daysBetween(addDays(lastSyncDay, -7), today) + 1);
    expect(accepting.toolCalls.map((c) => c.name)).toEqual(["queryDailyHealthData"]);
    expect(fitCalls(accepting.toolCalls)).toEqual([]);
    const dates = (await db.select().from(sleepRecords)).map((r) => r.date).sort();
    expect(dates).toEqual([lastNight, ...gap].sort());
    const row = await sleepRow();
    expect(row.status).toBe("connected");
    expect(row.lastSyncAt! > at).toBe(true);
  });

  it("a refused grant COROS takes again (Sync now, once the COROS app is signed back in) reads as connected", async () => {
    const mock = mockCoros({ nights: [addDays(today, -1)] });
    await connect(mock.fetchImpl);
    await db
      .update(providerConnections)
      .set({ status: "error", lastErrorCategory: "credentials_rejected" })
      .where(eq(providerConnections.userId, userId));
    expect(await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl)).toMatchObject({ status: "ok", written: 1 });
    const row = await sleepRow();
    expect(row.status).toBe("connected");
    expect(row.lastErrorCategory).toBeNull();
  });

  it("a gap longer than COROS's window reads the 42 days it can", async () => {
    const mock = mockCoros({ nights: [addDays(today, -1)] });
    await connect(mock.fetchImpl);
    await lastGoodSync(60, addDays(today, -61));
    await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl);
    expect(mock.toolCalls[0]!.args.days).toBe(42);
  });

  it("a healthy steady sync still re-reads a week", async () => {
    const mock = mockCoros({ nights: [addDays(today, -1)] });
    await connect(mock.fetchImpl);
    await lastGoodSync(0, addDays(today, -2));
    await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl);
    expect(mock.toolCalls[0]!.args.days).toBe(8);
  });
});

describe("the fallback tool COROS no longer lists", () => {
  it("a week the watch logged no nights is a real, empty read — synced, not a silent tool_missing", async () => {
    const mock = mockCoros({ nights: [] });
    await connect(mock.fetchImpl);
    const at = await lastGoodSync(1, addDays(today, -20));
    const result = await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl);
    expect(result).toMatchObject({ status: "ok", written: 0 });
    const row = await sleepRow();
    expect(row.lastSyncAt! > at).toBe(true);
    expect(row.lastErrorCategory).toBeNull();
  });

  it("a daily reply it cannot read, with nothing to fall back on, is recorded on the connection — never silent", async () => {
    const mock = mockCoros({ dailyReply: { content: [{ type: "text", text: JSON.stringify("Something else entirely") }], isError: false } });
    await connect(mock.fetchImpl);
    const at = await lastGoodSync(1, addDays(today, -8));
    expect((await syncCorosMcpSleep(db, ENV, userId, TZ, mock.fetchImpl)).status).toBe("tool_missing");
    const row = await sleepRow();
    expect(row.status).toBe("connected");
    expect(row.lastErrorCategory).toBe("tool_missing");
    expect((row.meta as { lastToolError?: string }).lastToolError).toMatch(/querySleepData/);
    expect(row.lastSyncAt).toBe(at);
  });
});
