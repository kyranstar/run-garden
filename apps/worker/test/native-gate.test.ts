/**
 * THE DEVICE GATE (SLICE-CONTRACT revision 2 §10.2, §10.3): one branch at the top of `requireUser`, taken only for
 * `Authorization: Bearer rgd_…` with no session cookie. Every answer here is asserted with what the request ran and
 * wrote, not only its status: a refused device request runs no handler and writes nothing, and the cookie path runs
 * exactly the statements it ran before the branch existed.
 *
 * Through the real route modules (sessions, plan, settings, auth) on the repo's migrations, under a faked `Date`, D1's
 * bind cap on. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { randomToken } from "../src/auth/crypto.js";
import { authRoutes } from "../src/routes/auth.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { planRoutes } from "../src/routes/plan.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { makeTestUser, pinMiddayToday } from "./helpers.js";
import { nativeStatements, nativeWorld, seedDevice, seedSlot, type NativeWorld } from "./native-fixture.js";

const { accountState, nativeDevices, sessionBuilds, users } = schema;

vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

const HOUR = 3_600_000;
let today: string;
let w: NativeWorld;
let slot: string;

beforeEach(async () => {
  today = pinMiddayToday();
  w = await nativeWorld([
    ["/api/sessions", sessionRoutes],
    ["/api/plan", planRoutes],
    ["/api/settings", settingsRoutes],
    ["/api/auth", authRoutes],
  ]);
  slot = await seedSlot(w.db, w.userId, today);
});
afterEach(() => vi.useRealTimers());

const deviceOf = async (id: string) => (await w.db.select().from(nativeDevices).where(eq(nativeDevices.id, id)))[0]!;

describe("credentials: each refusal runs no handler and writes nothing", () => {
  it("absent: no header and no cookie is the cookie path's own 401, as before, and reads no device", async () => {
    const a = await w.call("GET", `/api/sessions/${slot}`, { cookie: false });
    expect([a.status, a.json]).toEqual([401, { error: "unauthenticated" }]);
    expect(nativeStatements(a.statements)).toEqual([]);
    expect(a.writes).toEqual([]);
  });

  it("malformed: an rgd_ bearer that is not 43 base64url characters is 401 unauthenticated before any read", async () => {
    const good = `rgd_${randomToken(32)}`;
    for (const bad of ["rgd_", "rgd_short", `${good}x`, `${good.slice(0, -1)}!`, `${good.slice(0, -1)} `, `${good}, ${good}`]) {
      const a = await w.call("GET", `/api/sessions/${slot}`, { bearer: bad });
      expect([bad, a.status, a.json]).toEqual([bad, 401, { error: "unauthenticated" }]);
      expect(a.statements).toEqual([]);
    }
  });

  it("wrong: a well-formed token nobody holds is 401 unauthenticated; one read, nothing written", async () => {
    await seedDevice(w.db, w.userId);
    const a = await w.call("GET", `/api/sessions/${slot}`, { bearer: `rgd_${randomToken(32)}` });
    expect([a.status, a.json]).toEqual([401, { error: "unauthenticated" }]);
    expect(a.statements).toHaveLength(1);
    expect(a.statements[0]).toMatch(/from "native_devices"/);
    expect(a.writes).toEqual([]);
  });

  // Each row's times are read off the faked clock when the case runs.
  for (const [name, over, error] of [
    ["revoked", () => ({ state: "revoked", revokedAt: "2026-01-01T00:00:00.000Z", revokedReason: "owner" }), "device_revoked"],
    ["expired", () => ({ expiresAt: new Date(Date.now() - 1000).toISOString() }), "device_expired"],
    ["expired this instant", () => ({ expiresAt: new Date(Date.now()).toISOString() }), "device_expired"],
    ["pending", () => ({ state: "pending", confirmedAt: null, expiresAt: new Date(Date.now() + 600_000).toISOString() }), "device_pending"],
  ] as const) {
    it(`${name}: 401 ${error}; the device row is unchanged and the handler never ran`, async () => {
      const { token, id } = await seedDevice(w.db, w.userId, over() as never);
      const before = await deviceOf(id);
      const a = await w.call("GET", `/api/sessions/${slot}`, { bearer: token });
      expect([a.status, a.json]).toEqual([401, { error }]);
      expect(a.statements).toHaveLength(1);
      expect(a.writes).toEqual([]);
      expect(await deviceOf(id)).toEqual(before);
    });
  }

  it("expired a millisecond ago, revoked and pending at once: revoked answers first, then expired, then pending", async () => {
    const past = new Date(Date.now() - 1).toISOString();
    const both = await seedDevice(w.db, w.userId, { state: "revoked", revokedAt: past, revokedReason: "owner", expiresAt: past });
    expect((await w.call("GET", `/api/sessions/${slot}`, { bearer: both.token })).json).toEqual({ error: "device_revoked" });
    const pendingExpired = await seedDevice(w.db, w.userId, { state: "pending", confirmedAt: null, expiresAt: past });
    expect((await w.call("GET", `/api/sessions/${slot}`, { bearer: pendingExpired.token })).json).toEqual({ error: "device_expired" });
  });

  it("switched off: unless NATIVE_DEVICES is exactly \"1\", a live device is 401 device_access_off and nothing is read", async () => {
    const { token, id } = await seedDevice(w.db, w.userId);
    const before = await deviceOf(id);
    for (const value of [undefined, "", "0", "true", " 1", "1 ", "yes"]) {
      const a = await w.call("GET", `/api/sessions/${slot}`, { bearer: token, env: { NATIVE_DEVICES: value } });
      expect([String(value), a.status, a.json]).toEqual([String(value), 401, { error: "device_access_off" }]);
      expect(a.statements).toEqual([]);
    }
    expect(await deviceOf(id)).toEqual(before);
    // The cookie is not behind the switch.
    expect((await w.call("GET", `/api/sessions/${slot}`, { env: { NATIVE_DEVICES: undefined } })).status).toBe(200);
  });

  it("another account's device is not the owner's: 401 unauthenticated, nothing written", async () => {
    const { userId: other } = await makeTestUser(w.db);
    const theirs = await seedSlot(w.db, other, today);
    const { token } = await seedDevice(w.db, other);
    const a = await w.call("GET", `/api/sessions/${theirs}`, { bearer: token });
    expect([a.status, a.json]).toEqual([401, { error: "unauthenticated" }]);
    expect(a.writes).toEqual([]);
  });

  it("a device token sent as the session cookie is no session: the cookie path's 401", async () => {
    const { token } = await seedDevice(w.db, w.userId);
    const a = await w.call("GET", `/api/sessions/${slot}`, { cookie: `rg_session=${token}` });
    expect([a.status, a.json]).toEqual([401, { error: "unauthenticated" }]);
    expect(nativeStatements(a.statements)).toEqual([]);
  });
});

describe("an active device", () => {
  it("reads an allowed route as the cookie does, as the owner", async () => {
    const { token } = await seedDevice(w.db, w.userId);
    const byCookie = await w.call("GET", `/api/sessions/${slot}`);
    const byDevice = await w.call("GET", `/api/sessions/${slot}`, { bearer: token });
    expect(byDevice.status).toBe(200);
    expect(byDevice.json).toEqual(byCookie.json);
    expect(byDevice.json.workoutId).toBe(slot);
  });

  it("last use is written at most hourly: once now, nothing for the rest of the hour, once again after it", async () => {
    const { token, id } = await seedDevice(w.db, w.userId, { lastUsedAt: null });
    const first = await w.call("GET", `/api/sessions/${slot}`, { bearer: token });
    expect(first.writes.filter((s) => /native_devices/.test(s))).toHaveLength(1);
    expect((await deviceOf(id)).lastUsedAt).toBe(nowInstant());
    const stamped = (await deviceOf(id)).lastUsedAt;

    vi.setSystemTime(new Date(Date.now() + HOUR - 1000));
    const within = await w.call("GET", `/api/sessions/${slot}`, { bearer: token });
    expect(within.writes).toEqual([]);
    expect((await deviceOf(id)).lastUsedAt).toBe(stamped);

    vi.setSystemTime(new Date(Date.now() + 2000));
    const after = await w.call("GET", `/api/sessions/${slot}`, { bearer: token });
    expect(after.writes.filter((s) => /native_devices/.test(s))).toHaveLength(1);
    expect((await deviceOf(id)).lastUsedAt).toBe(nowInstant());
  });

  it("everything off the list is 403 out_of_scope: no handler runs, nothing is written, every method", async () => {
    const { token } = await seedDevice(w.db, w.userId, { lastUsedAt: nowInstant() });
    const refused: Array<[string, string, unknown?]> = [
      ["GET", "/api/plan/today"],
      ["GET", "/api/auth/me"],
      ["POST", "/api/settings/delete-all", { confirm: "delete everything" }],
      ["GET", "/api/settings/export"],
      ["GET", `/api/sessions/${slot}/state`],
      ["GET", `/api/sessions/${slot}/current`],
      ["POST", `/api/sessions/${slot}/unstart`, {}],
      ["POST", `/api/sessions/${slot}/send-to-watch`, {}],
      ["HEAD", `/api/sessions/${slot}`],
      ["OPTIONS", `/api/sessions/${slot}`],
      ["DELETE", `/api/sessions/${slot}`],
      ["PUT", `/api/sessions/${slot}`, {}],
      ["POST", `/api/sessions/${slot}`, {}],
      ["GET", `/api/sessions/${slot}/build`],
      ["GET", `/api/sessions/${slot}/review-basis/`],
      ["GET", `/api/sessions/${slot}/`],
      ["GET", `/api/sessions/performed/p-1`],
      ["POST", `/api/sessions/performed/p-1`, {}],
      ["POST", "/api/sessions/watch/drain", {}],
    ];
    for (const [method, path, body] of refused) {
      const a = await w.call(method, path, { bearer: token, body });
      expect([method, path, a.status, method === "HEAD" ? {} : a.json]).toEqual([method, path, 403, method === "HEAD" ? {} : { error: "out_of_scope" }]);
      expect(a.statements, `${method} ${path}`).toHaveLength(1);
      expect(a.writes).toEqual([]);
    }
    // Delete-all never ran: the account is whole.
    expect(await w.db.select().from(users).where(eq(users.id, w.userId))).toHaveLength(1);
  });

  it("the list is checked before the 423: while a restore runs, an off-list write is 403, an on-list write 423, a read answers", async () => {
    const { token } = await seedDevice(w.db, w.userId, { lastUsedAt: nowInstant() });
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    const off = await w.call("POST", `/api/sessions/${slot}/unstart`, { bearer: token, body: {} });
    expect([off.status, off.json]).toEqual([403, { error: "out_of_scope" }]);
    const on = await w.call("POST", `/api/sessions/${slot}/build`, { bearer: token, body: {} });
    expect([on.status, on.json]).toEqual([423, { error: "restore_in_progress" }]);
    expect(on.writes).toEqual([]);
    expect(await w.db.select().from(sessionBuilds)).toEqual([]);
    expect((await w.call("GET", `/api/sessions/${slot}`, { bearer: token })).status).toBe(200);
  });

  it("Build carries exactly {}: a check, an override or a swap is 403 out_of_scope and builds nothing; {} builds", async () => {
    const { token } = await seedDevice(w.db, w.userId, { lastUsedAt: nowInstant() });
    for (const raw of ['{"overrides":{"mode":"build"}}', '{"checks":{}}', '{"swaps":{}}', "", "[]", "null", "{} {}", "not json", '{"__proto__":{}}']) {
      const a = await w.call("POST", `/api/sessions/${slot}/build`, { bearer: token, raw });
      expect([raw, a.status, a.json]).toEqual([raw, 403, { error: "out_of_scope" }]);
      expect(a.writes).toEqual([]);
    }
    expect(await w.db.select().from(sessionBuilds)).toEqual([]);
    const built = await w.call("POST", `/api/sessions/${slot}/build`, { bearer: token, raw: " { } " });
    expect(built.status, built.text).toBe(200);
    expect(built.json.build.buildId).toEqual(expect.any(String));
    const started = await w.call("POST", `/api/sessions/${slot}/start`, { bearer: token, body: { buildId: built.json.build.buildId } });
    expect(started.status, started.text).toBe(200);
    expect(started.json.contentState).toBe("started");
    // The cookie's Build is not held to it.
    const other = await seedSlot(w.db, w.userId, today);
    expect((await w.call("POST", `/api/sessions/${other}/build`, { body: { overrides: { mode: "build" } } })).status).toBe(200);
  });
});

describe("a cookie and a device token on one request", () => {
  it("is refused 400 before anything is read, whichever is valid", async () => {
    const { token } = await seedDevice(w.db, w.userId);
    for (const cookie of [true, "rg_session=not-a-session", "rg_session="]) {
      const a = await w.call("GET", `/api/sessions/${slot}`, { cookie, bearer: token });
      expect([String(cookie), a.status, a.json]).toEqual([String(cookie), 400, { error: "two_credentials" }]);
      expect(a.statements).toEqual([]);
    }
    // Another cookie, not the session's, is no session cookie.
    expect((await w.call("GET", `/api/sessions/${slot}`, { cookie: "theme=dark", bearer: token })).status).toBe(200);
  });
});

describe("the kill switch is a Worker secret", () => {
  it("no wrangler config declares NATIVE_DEVICES (a declared var is reset by the next deploy; a secret persists)", () => {
    for (const file of ["../wrangler.toml", "../wrangler.dev.toml", "../wrangler.copier.toml", "../../web/e2e/fixture-stack.sh"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(/NATIVE_DEVICES/);
    }
  });
});

describe("the cookie path is unchanged", () => {
  it("a read runs the one session lookup it always ran, then the handler; no device table is touched", async () => {
    const a = await w.call("GET", `/api/sessions/${slot}/state`);
    expect(a.status).toBe(200);
    expect(a.statements).toHaveLength(2);
    expect(a.statements[0]).toMatch(/from "sessions" inner join "users"/);
    expect(nativeStatements(a.statements)).toEqual([]);
  });

  it("a write still checks the restore marker, and is 423 during a restore", async () => {
    const ok = await w.call("POST", `/api/sessions/${slot}/build`, { body: {} });
    expect(ok.status).toBe(200);
    expect(ok.statements.slice(0, 2).map((s) => s.match(/from "(\w+)"/)?.[1])).toEqual(["sessions", "account_state"]);
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-2", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    expect((await w.call("POST", `/api/sessions/${slot}/unstart`, { body: {} })).status).toBe(423);
  });

  it("another bearer (the LifeOS token, say) with the cookie: the cookie path, as before", async () => {
    const a = await w.call("GET", `/api/sessions/${slot}`, { cookie: true, bearer: "a".repeat(64) });
    expect(a.status).toBe(200);
    expect(nativeStatements(a.statements)).toEqual([]);
    const lower = await w.call("GET", `/api/sessions/${slot}`, { cookie: false, headers: { Authorization: "Basic cmdkXzpv" } });
    expect(lower.status).toBe(401);
  });
});
