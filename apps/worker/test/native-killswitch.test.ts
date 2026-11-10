/**
 * THE OFF SWITCH, AND A REVOKE AGAINST A REQUEST IN FLIGHT (kit v0.5).
 *
 *  - `NATIVE_DEVICES` absent, or any value but exactly "1": every `rgd_` bearer request is refused on every route the
 *    app mounts, every method — 401 `device_access_off` wherever `requireUser` stands, and elsewhere exactly the
 *    anonymous answer — and minting, redeeming and confirming are 404, while listing, revoking and revoking all answer.
 *  - IN FLIGHT: revocation applies at the authorization boundary — `requireUser`'s device branch, which reads the device's
 *    row once, before the handler runs. A request already past it runs to its end: the write it was authorized for lands.
 *    The device's next request, read after the revoke committed, is refused. Nothing is cancelled retroactively.
 *
 * Against the real default export (the sweep, every other switch on, a spy on the real `requireUser`) and the real route
 * modules (the rest). Synthetic data only; `fetch` stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser, pinMiddayToday } from "./helpers.js";
import { nativeEnv, nativeWorld, seedDevice, seedSlot, type NativeWorld } from "./native-fixture.js";

const holder = vi.hoisted(() => ({ db: undefined as unknown, reached: false, hold: null as null | (() => Promise<void>) }));
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
// Holds a Build after `requireUser` let it through, while a revoke lands (the in-flight case).
vi.mock("../src/services/session-build.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/session-build.js")>();
  return {
    ...actual,
    buildSessionOutcome: async (...args: Parameters<typeof actual.buildSessionOutcome>) => {
      const hold = holder.hold;
      holder.hold = null;
      if (hold) await hold();
      return actual.buildSessionOutcome(...args);
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

vi.setConfig({ testTimeout: 600_000 });

const { nativeDevices, sessionBuilds } = schema;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
/** Every way the switch can be not exactly "1". */
const OFF: Array<string | undefined> = [undefined, "", "0", "true", "TRUE", "on", "yes", " 1", "1 ", "01", "1.0", "11"];
const SLICE = [
  ["GET", "/api/native/me"],
  ["GET", "/api/native/today"],
  ["POST", "/api/native/sign-out"],
  ["GET", "/api/sessions/probe-id"],
  ["GET", "/api/sessions/probe-id/review-basis"],
  ["POST", "/api/sessions/probe-id/build"],
  ["POST", "/api/sessions/probe-id/start"],
  ["PUT", "/api/sessions/performed/probe-id"],
] as const;

describe("off or absent: every native access path is shut", () => {
  let env: Env;
  let token: string;
  let deviceId: string;
  beforeAll(async () => {
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
    const db = makeTestDb();
    holder.db = db;
    const { userId } = await makeTestUser(db);
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
    ({ token, id: deviceId } = await seedDevice(db, userId, { expiresAt: "2099-01-01T00:00:00.000Z" }));
  });
  afterAll(() => vi.unstubAllGlobals());

  async function probe(method: string, path: string, switchValue: string | undefined, bearer?: string) {
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    const headers: Record<string, string> = bearer ? { Authorization: `Bearer ${bearer}` } : {};
    const withBody = !["GET", "HEAD", "OPTIONS"].includes(method);
    if (withBody) headers["Content-Type"] = "application/json";
    holder.reached = false;
    const res = await worker.fetch(new Request(`https://app.test${path}`, { method, headers, ...(withBody ? { body: "{}" } : {}) }), { ...env, NATIVE_DEVICES: switchValue }, ctx);
    const text = await res.text();
    let error: string | null = null;
    try {
      const e = (JSON.parse(text) as { error?: unknown }).error;
      error = typeof e === "string" ? e : e === undefined ? null : JSON.stringify(e);
    } catch {
      error = null;
    }
    return { status: res.status, error, reached: holder.reached };
  }

  for (const value of [undefined, "0"]) {
    it(`NATIVE_DEVICES ${JSON.stringify(value) ?? "absent"}: a device token is refused on every mounted route, every method`, async () => {
      const paths = [...new Set(mountedRoutes().map((r) => r.path))].map((p) => p.replace(/:\w+/g, "probe-id").replace(/\*/g, "__probe__"));
      const failures: string[] = [];
      for (const path of paths) {
        for (const method of METHODS) {
          const anonymous = await probe(method, path, value);
          const device = await probe(method, path, value, token);
          if (anonymous.reached) {
            if (device.status !== 401 || device.error !== (method === "HEAD" ? null : "device_access_off")) failures.push(`${method} ${path}: ${device.status} ${device.error}`);
          } else if (device.status !== anonymous.status || device.error !== anonymous.error) {
            failures.push(`${method} ${path}: ${device.status} ${device.error}, anonymous ${anonymous.status} ${anonymous.error}`);
          }
        }
      }
      expect(failures).toEqual([]);
      expect((await (holder.db as ReturnType<typeof makeTestDb>).select().from(nativeDevices).where(eq(nativeDevices.id, deviceId)))[0]!.state).toBe("active");
    });
  }

  it("every other value but exactly \"1\": the slice's eight pairs are 401 device_access_off; \"1\" opens them", async () => {
    for (const value of OFF) {
      for (const [method, path] of SLICE) expect([String(value), method, path, (await probe(method, path, value, token)).error]).toEqual([String(value), method, path, "device_access_off"]);
    }
    expect((await probe("GET", "/api/native/me", "1", token)).status).toBe(200);
  });
});

describe("off or absent: pairing is 404, the laptop can still see and stop phones", () => {
  let w: NativeWorld;
  beforeEach(async () => {
    pinMiddayToday();
    w = await nativeWorld([["/api/native", nativeRoutes]]);
  });
  afterEach(() => vi.useRealTimers());

  it.each(OFF.map((v) => [JSON.stringify(v) ?? "absent", v] as const))("NATIVE_DEVICES %s", async (_name, value) => {
    const a = await seedDevice(w.db, w.userId);
    const pending = await seedDevice(w.db, w.userId, { state: "pending", confirmedAt: null, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
    const off = { env: { NATIVE_DEVICES: value } };
    expect((await w.call("POST", "/api/native/pairings", { body: {}, ...off })).status).toBe(404);
    expect((await w.call("POST", "/api/native/pair", { cookie: false, body: { code: "ABCDEFGH", label: "x" }, ...off })).status).toBe(404);
    expect((await w.call("POST", `/api/native/devices/${pending.id}/confirm`, { body: { check: "0420" }, ...off })).status).toBe(404);
    const listed = await w.call("GET", "/api/native/devices", off);
    expect([listed.status, listed.json.enabled, listed.json.devices.map((d: { id: string }) => d.id).sort()]).toEqual([200, false, [a.id, pending.id].sort()]);
    expect((await w.call("POST", `/api/native/devices/${a.id}/revoke`, { body: {}, ...off })).json).toEqual({ ok: true, revoked: true });
    expect((await w.call("POST", "/api/native/devices/revoke-all", { body: {}, ...off })).json).toEqual({ ok: true, revoked: 1 });
    expect((await w.db.select().from(nativeDevices)).map((d) => d.state)).toEqual(["revoked", "revoked"]);
    expect(await w.db.select().from(schema.nativePairings)).toEqual([]);
  });
});

describe("a revoke against a request already in flight", () => {
  let w: NativeWorld;
  let slot: string;
  beforeEach(async () => {
    const today = pinMiddayToday();
    w = await nativeWorld([
      ["/api/native", nativeRoutes],
      ["/api/sessions", sessionRoutes],
    ]);
    slot = await seedSlot(w.db, w.userId, today);
  });
  afterEach(() => vi.useRealTimers());

  it("a Build already past the authorization boundary lands; the device's next request is refused", async () => {
    const { token, id } = await seedDevice(w.db, w.userId);
    let revoked: Promise<unknown> | null = null;
    holder.hold = async () => {
      revoked = w.call("POST", `/api/native/devices/${id}/revoke`, { body: {} });
      expect((await revoked as { json: unknown }).json).toEqual({ ok: true, revoked: true });
    };
    const build = await w.call("POST", `/api/sessions/${slot}/build`, { bearer: token, body: {} });
    expect(revoked).not.toBeNull();
    expect((await w.db.select().from(nativeDevices).where(eq(nativeDevices.id, id)))[0]!.state).toBe("revoked");
    // Authorized before the revoke committed: it ran to its end, and its write stands.
    expect(build.status, build.text).toBe(200);
    expect(await w.db.select().from(sessionBuilds)).toHaveLength(1);
    // Read after it: refused at the boundary, before any handler.
    const next = await w.call("POST", `/api/sessions/${slot}/start`, { bearer: token, body: { buildId: build.json.build.buildId } });
    expect([next.status, next.json]).toEqual([401, { error: "device_revoked" }]);
    expect(next.statements).toHaveLength(1);
  });
});
