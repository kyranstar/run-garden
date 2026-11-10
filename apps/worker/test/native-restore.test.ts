/**
 * REVOKING DURING A RESTORE (worker review L1). `restoreInProgress` stays true while a restore's id is set, even one
 * abandoned days ago, and the restore rule (423) froze the owner's Revoke and Revoke all and the phone's own sign-out,
 * while the device's reads still answered. Those three write only `native_devices`, which no restore touches, so they are
 * open while restoring (`OPEN_WHILE_RESTORING`, auth/middleware.ts); everything else keeps its answer.
 *
 *  - The reviewer's scenario: a restore abandoned 3 days ago; Revoke, Revoke all and sign-out land, and the device is
 *    refused at once; its other writes, and the cookie's, are still 423.
 *  - Every mounted route, under every write method, by cookie, while a restore is marked, against the real default
 *    export (every switch on): the writes that pass the restore rule are exactly the ones that did before, plus those
 *    three. A spy on the real `requireUser` says which requests reached it.
 *
 * Synthetic data only; `fetch` stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, pinMiddayToday } from "./helpers.js";
import { nativeEnv, nativeWorld, seedDevice, seedSlot, type NativeWorld } from "./native-fixture.js";

const holder = vi.hoisted(() => ({ db: undefined as unknown, reached: false }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/db.js")>();
  return { ...actual, makeDb: () => holder.db };
});
vi.mock("../src/auth/middleware.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/middleware.js")>();
  return {
    ...actual,
    requireUser: async (...args: Parameters<typeof actual.requireUser>) => {
      holder.reached = true;
      return actual.requireUser(...args);
    },
  };
});
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

const { default: worker, mountedRoutes } = await import("../src/index.js");
const { nativeRoutes } = await import("../src/routes/native.js");
const { sessionRoutes } = await import("../src/routes/sessions.js");
const { settingsRoutes } = await import("../src/routes/misc.js");

vi.setConfig({ testTimeout: 600_000 });

const { accountState, nativeDevices } = schema;
const DAY = 86_400_000;

/** A restore begun and abandoned 3 days ago: its id still set, its heartbeat long stale. */
async function abandonedRestore(db: ReturnType<typeof makeTestDb>, userId: string) {
  const stale = new Date(Date.now() - 3 * DAY).toISOString();
  await db.delete(accountState).where(eq(accountState.userId, userId));
  await db.insert(accountState).values({ userId, restoreId: "r-abandoned", restoreStartedAt: stale, restoreHeartbeatAt: stale, updatedAt: stale } as never);
}

describe("during an abandoned restore, the phone can still be stopped", () => {
  let w: NativeWorld;
  let slot: string;
  beforeEach(async () => {
    const today = pinMiddayToday();
    w = await nativeWorld([
      ["/api/native", nativeRoutes],
      ["/api/sessions", sessionRoutes],
      ["/api/settings", settingsRoutes],
    ]);
    slot = await seedSlot(w.db, w.userId, today);
    await abandonedRestore(w.db as never, w.userId);
  });
  afterEach(() => vi.useRealTimers());
  const deviceOf = async (id: string) => (await w.db.select().from(nativeDevices).where(eq(nativeDevices.id, id)))[0]!;

  it("Revoke lands, and the device is refused at once", async () => {
    const { token, id } = await seedDevice(w.db, w.userId);
    expect((await w.call("GET", `/api/sessions/${slot}`, { bearer: token })).status).toBe(200);
    const r = await w.call("POST", `/api/native/devices/${id}/revoke`, { body: {} });
    expect([r.status, r.json]).toEqual([200, { ok: true, revoked: true }]);
    expect(await deviceOf(id)).toMatchObject({ state: "revoked", revokedReason: "owner" });
    expect((await w.call("GET", `/api/sessions/${slot}`, { bearer: token })).json).toEqual({ error: "device_revoked" });
    expect((await w.call("GET", "/api/native/today", { bearer: token })).json).toEqual({ error: "device_revoked" });
  });

  it("Revoke all lands, and every device is refused", async () => {
    const a = await seedDevice(w.db, w.userId);
    const b = await seedDevice(w.db, w.userId);
    const r = await w.call("POST", "/api/native/devices/revoke-all", { body: {} });
    expect([r.status, r.json]).toEqual([200, { ok: true, revoked: 2 }]);
    for (const t of [a.token, b.token]) expect((await w.call("GET", `/api/sessions/${slot}`, { bearer: t })).json).toEqual({ error: "device_revoked" });
  });

  it("the phone's own sign-out lands; its next request is refused", async () => {
    const { token, id } = await seedDevice(w.db, w.userId);
    const out = await w.call("POST", "/api/native/sign-out", { bearer: token, body: {} });
    expect([out.status, out.json]).toEqual([200, { ok: true }]);
    expect(await deviceOf(id)).toMatchObject({ state: "revoked", revokedReason: "sign_out" });
    expect((await w.call("GET", "/api/native/me", { bearer: token })).json).toEqual({ error: "device_revoked" });
  });

  it("every other write still waits for the restore: the device's, the cookie's, and pairing's", async () => {
    const { token, id } = await seedDevice(w.db, w.userId, { state: "pending", confirmedAt: null, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    const active = await seedDevice(w.db, w.userId);
    for (const [who, method, path, body] of [
      ["device", "POST", `/api/sessions/${slot}/build`, {}],
      ["cookie", "POST", `/api/sessions/${slot}/build`, {}],
      ["cookie", "POST", "/api/native/pairings", {}],
      ["cookie", "POST", `/api/native/devices/${id}/confirm`, { check: "0420" }],
    ] as const) {
      const a = await w.call(method, path, { ...(who === "device" ? { bearer: active.token } : {}), body });
      expect([who, path, a.status, a.json]).toEqual([who, path, 423, { error: "restore_in_progress" }]);
      expect(a.writes).toEqual([]);
    }
    expect((await deviceOf(id)).state).toBe("pending");
    expect((await w.call("GET", "/api/native/me", { bearer: token })).json).toEqual({ error: "device_pending" });
  });
});

/** Writes that passed the restore rule before this change, by cookie, under every write method (generated, reviewed). */
const OPEN_BEFORE = [
  "DELETE /api/coros/read-now",
  "DELETE /api/settings/delete-all",
  "DELETE /api/settings/restore/begin",
  "DELETE /api/settings/restore/check",
  "DELETE /api/settings/restore/check/start",
  "DELETE /api/settings/restore/finish",
  "DELETE /api/settings/restore/rows",
  "DELETE /api/settings/restore/start-fresh",
  "DELETE /api/settings/restore/status",
  "DELETE /api/settings/restore/tables",
  "DELETE /api/sync/read-now",
  "PATCH /api/coros/read-now",
  "PATCH /api/settings/delete-all",
  "PATCH /api/settings/restore/begin",
  "PATCH /api/settings/restore/check",
  "PATCH /api/settings/restore/check/start",
  "PATCH /api/settings/restore/finish",
  "PATCH /api/settings/restore/rows",
  "PATCH /api/settings/restore/start-fresh",
  "PATCH /api/settings/restore/status",
  "PATCH /api/settings/restore/tables",
  "PATCH /api/sync/read-now",
  "POST /api/auth/coros-mcp/disconnect",
  "POST /api/auth/coros-mcp/sync-now",
  "POST /api/coros/read-now",
  "POST /api/settings/delete-all",
  "POST /api/settings/restore/begin",
  "POST /api/settings/restore/check",
  "POST /api/settings/restore/check/start",
  "POST /api/settings/restore/finish",
  "POST /api/settings/restore/rows",
  "POST /api/settings/restore/start-fresh",
  "POST /api/settings/restore/status",
  "POST /api/settings/restore/tables",
  "POST /api/sync/read-now",
  "PUT /api/coros/read-now",
  "PUT /api/settings/delete-all",
  "PUT /api/settings/restore/begin",
  "PUT /api/settings/restore/check",
  "PUT /api/settings/restore/check/start",
  "PUT /api/settings/restore/finish",
  "PUT /api/settings/restore/rows",
  "PUT /api/settings/restore/start-fresh",
  "PUT /api/settings/restore/status",
  "PUT /api/settings/restore/tables",
  "PUT /api/sync/read-now",
];
/** Open while restoring since this change: they write only `native_devices`. */
const OPEN_NOW = ["POST /api/native/devices/:id/revoke", "POST /api/native/devices/revoke-all", "POST /api/native/sign-out"];

describe("every other cookie write keeps its restore answer", () => {
  let env: Env;
  let cookie: string;
  let userId: string;
  let db: ReturnType<typeof makeTestDb>;
  beforeAll(async () => {
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
    db = makeTestDb();
    holder.db = db;
    ({ userId } = await makeTestUser(db));
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    env = nativeEnv({
      ALLOWED_GOOGLE_EMAIL: user!.email,
      FIXTURE_MODE: "1",
      COACH_DESIGNER: "1",
      PARITY_ENABLED: "1",
      SAVES_IMPORT: "1",
      IMPORT_ENABLED: "1",
      WATCH_PUSH_ENABLED: "1",
      THREAD_COACH: "1",
      SPOTIFY_CLIENT_ID: "fixture-client",
      LIFEOS_TOKEN_SHA256: "a".repeat(64),
      SAVES_TOKEN_SHA256: "b".repeat(64),
      ASSETS: { fetch: async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }) } as unknown as Env["ASSETS"],
    });
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  });
  afterAll(() => vi.unstubAllGlobals());

  it("the writes open while restoring are the ones before, and the three native ones", async () => {
    const mounted = [...new Set(mountedRoutes().map((r) => `${r.method} ${r.path}`))];
    const paths = [...new Set(mounted.map((k) => k.split(" ")[1]!))];
    const open: string[] = [];
    for (const path of paths) {
      const url = path.replace(/:\w+/g, "probe-id").replace(/\*/g, "__probe__");
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        // The restore stays marked, and the owner signed in, for every probe, whatever the last route did (logout ends the
        // session it is sent with).
        await abandonedRestore(db, userId);
        cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
        holder.reached = false;
        const pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
        const res = await worker.fetch(new Request(`https://app.test${url}`, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" }), env, ctx);
        await Promise.allSettled(pending);
        const reached = holder.reached;
        await res.text();
        if (reached && res.status !== 423) open.push(`${method} ${path}`);
      }
    }
    expect(open.sort()).toEqual([...OPEN_BEFORE, ...OPEN_NOW].sort());
  });
});
