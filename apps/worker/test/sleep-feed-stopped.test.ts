/**
 * THE SLEEP FEED STOPPED, AND THE COACH IS TOLD (audit C2, seen in prod 2026-09-18 → 10-23).
 *
 * The official COROS connection that brings each night's sleep expired (`coros_mcp`: status `error`, `needs_reauth`)
 * on 09-18; `sleep_records` stop at 09-14. Only Settings said so. The thread coach's dossier printed "30d sleep
 * baseline: unknownh" — a blank baseline with a stray unit — and the designer's context only a date. Now every coach
 * context says since when there is no sleep, and that the connection needs reconnecting; and the sync line on Today,
 * the one place that already speaks for the watch's connections, says it in one short clause.
 *
 * Synthetic data only; every date is relative to the athlete's today.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { syncRoutes } from "../src/routes/sync.js";
import { buildDossier } from "../src/services/coach-context.js";
import { SLEEP_RECONNECT_WORDS } from "../src/services/coros-mcp.js";
import { buildDesignContext } from "../src/services/design-context.js";
import { allTools } from "../src/services/design-tools/index.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const ENV = {
  DB: {} as unknown as Env["DB"],
  ASSETS: {} as unknown as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
} as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
});

/** Nights of sleep `from`..`to` days ago, six hours each. */
async function nights(from: number, to: number) {
  for (let i = from; i <= to; i++) {
    const date = addDays(today, -i);
    await db.insert(schema.sleepRecords).values({ id: `${userId}:${date}`, userId, date, durationSeconds: 6 * 3600, contentFingerprint: `s${i}`, updatedAt: nowInstant() });
  }
}

/** The official COROS sleep connection, expired (coros-mcp.ts `markNeedsReauth`) — or healthy. */
async function sleepConnection(expired: boolean) {
  await db.insert(schema.providerConnections).values({
    id: newId(), userId, provider: "coros_mcp", status: expired ? "error" : "connected", lastErrorCategory: expired ? "needs_reauth" : null,
    createdAt: nowInstant(), updatedAt: nowInstant(), lastSyncAt: nowInstant(),
  });
}

describe("the thread coach's dossier", () => {
  it("a feed that stopped over a month ago: since when, and that the connection needs reconnecting — never 'unknownh'", async () => {
    await nights(39, 45);
    await sleepConnection(true);
    const d = await buildDossier(db, userId, prefs, today);
    expect(SLEEP_RECONNECT_WORDS).toBe("the watch's sleep connection needs reconnecting");
    expect(d.text).toContain(`sleep: no data since ${addDays(today, -39)} — ${SLEEP_RECONNECT_WORDS}.`);
    expect(d.text).not.toContain("unknownh");
    expect(d.text).not.toContain("NO DATA AT ALL");
  });

  it("a feed that stopped with no connection problem known: since when, plainly", async () => {
    await nights(39, 45);
    const d = await buildDossier(db, userId, prefs, today);
    expect(d.text).toContain(`sleep: no data since ${addDays(today, -39)}.`);
    expect(d.text).not.toContain(SLEEP_RECONNECT_WORDS);
    expect(d.text).not.toContain("unknownh");
  });

  it("a feed that stopped inside the month: the baseline, and since when — the connection needs reconnecting", async () => {
    await nights(5, 12);
    await sleepConnection(true);
    const d = await buildDossier(db, userId, prefs, today);
    expect(d.text).toContain(`30d sleep baseline: 6.0h · no data since ${addDays(today, -5)} — ${SLEEP_RECONNECT_WORDS}.`);
  });

  it("a healthy feed reads as it did", async () => {
    await nights(1, 3);
    await sleepConnection(false);
    const d = await buildDossier(db, userId, prefs, today);
    expect(d.text).toContain("30d sleep baseline: 6.0h");
    expect(d.text).not.toContain("no data since");
  });
});

describe("the coach designer's context and read_readiness", () => {
  const build = async () =>
    buildDesignContext(db, ENV, userId, { id: "run-1", role: "main", scope: { kind: "now" }, request: "Something calm.", parentId: null }, new Date());

  it("the readiness line says the connection needs reconnecting", async () => {
    await nights(39, 45);
    await sleepConnection(true);
    const { header } = await build();
    const line = header.split("\n").find((l) => l.startsWith("- readiness:"))!;
    expect(line).toMatch(/sleep last .* — the watch's sleep connection needs reconnecting/);
  });

  it("and says nothing of it while the connection is healthy", async () => {
    await nights(1, 3);
    await sleepConnection(false);
    const { header } = await build();
    expect(header).not.toContain(SLEEP_RECONNECT_WORDS);
  });

  it("read_readiness says since when, and why", async () => {
    await nights(39, 45);
    await sleepConnection(true);
    const tool = allTools().find((t) => t.name === "read_readiness")!;
    const out = (await tool.run(
      { db, env: ENV, userId, now: new Date(), toolUseId: "toolu_r1", run: { id: "run-1", role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false } },
      {},
    )) as { data: unknown; summary: string };
    expect(JSON.stringify(out)).toContain(`no sleep since ${addDays(today, -39)} — ${SLEEP_RECONNECT_WORDS}`);
  });
});

describe("GET /api/sync/status", () => {
  it("says when the sleep connection needs reconnecting — and not otherwise", async () => {
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const status = async () =>
      (await (await mountRoutes(db, "/api/sync", syncRoutes).request("/api/sync/status", { headers: { Cookie: cookie } }, ENV)).json()) as Record<string, unknown>;
    expect((await status()).sleepNeedsReconnect).toBe(false);
    await sleepConnection(true);
    expect((await status()).sleepNeedsReconnect).toBe(true);
  });
});
