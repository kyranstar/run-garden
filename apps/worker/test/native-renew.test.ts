/**
 * THE LAPTOP'S RENEW OF A PAIRED PHONE (LifeOS OPEN_QUESTIONS Q-172, amended by Q-173's v0.17/v0.18 rulings): the signed-in
 * owner's laptop gives one ACTIVE, unexpired device of the account a fresh expiry, 30 days from the server's acceptance
 * (`NATIVE_DEVICE_LIFETIME_DAYS`, the pairing's own), through `POST /api/native/devices/:id/renew`, cookie only:
 *
 *  - it keeps the device's id (so its token), account, label, state, scope, confirmation, last use and tries exactly, and
 *    writes only that row's expiry and one audit row (`native_device_renewed`), in one transaction;
 *  - it is 30 days from now, never +30 on the old expiry, and the expiry never moves backwards;
 *  - it is idempotent within a short window (`RENEW_REPEAT_MS`): a double click, a resend or a second tab is 200
 *    `renewed: false` and writes nothing;
 *  - it refuses revoked, expired and pending devices, another account's, a body that isn't empty, a device token (to
 *    itself or another), the switch off, a restore and a foreign origin;
 *  - nothing renews in the background: no device request, read or grant moves the expiry (native-grant.test.ts holds
 *    the grant's and the reads' half of that).
 *
 * Through the real route modules on the repo's migrations, under a faked `Date`. Synthetic data only; `fetch` stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { Hono } from "hono";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";

/** Hold a renew between its read of the device and its one transaction (the next `runAtomicallyClaim`), once. */
const gates = vi.hoisted(() => ({ claim: null as null | (() => Promise<void>) }));
vi.mock("../src/services/db.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/db.js")>();
  return {
    ...real,
    runAtomicallyClaim: async (...args: Parameters<typeof real.runAtomicallyClaim>) => {
      const hold = gates.claim;
      gates.claim = null;
      if (hold) await hold();
      return real.runAtomicallyClaim(...args);
    },
  };
});

import type { AppContext } from "../src/auth/middleware.js";
import type { Env } from "../src/env.js";
import { NATIVE_DEVICE_LIFETIME_DAYS, RENEW_REPEAT_MS } from "../src/auth/native-devices.js";
import { originGuard } from "../src/index.js";
import { nativeRoutes } from "../src/routes/native.js";
import { makeTestUser } from "./helpers.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { accountState, nativeDevices } = schema;

const LA = "America/Los_Angeles";
const V1 = "training-slice-v1";
const V2 = "training-v2";
const V3 = "training-v3";
const V4 = "training-v4";
const D = "2026-11-18";
const DAY = 86_400_000;
const MINUTE = 60_000;
const instant = (date: string, hhmm: string) => DateTime.fromISO(`${date}T${hhmm}`, { zone: LA }).toUTC().toISO()!;
/** Five days out: inside the 7-day warning, when the laptop offers Renew. */
const NEAR = "2026-11-23T08:00:00.000Z";
/** What a renew accepted now sets: 30 days from the server's own now. */
const thirtyFromNow = () => new Date(Date.now() + 30 * DAY).toISOString();

let w: NativeWorld;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  gates.claim = null;
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant(D, "09:00")));
  vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
  w = await nativeWorld([["/api/native", nativeRoutes]]);
});

const client = () => (w.db as unknown as { $client: { prepare(s: string): { all(...a: unknown[]): any[]; run(...a: unknown[]): unknown } } }).$client;
const q = (sql: string, ...args: unknown[]): any[] => client().prepare(sql).all(...args);
const deviceRow = (id: string) => q(`select * from native_devices where id = ?`, id)[0];
const audits = () => q(`select user_id as userId, kind, detail from audit_events where kind = 'native_device_renewed' order by rowid`).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
/** Every table but the cookie's own session row (a signed-in request may slide it): "nothing written" is this, unchanged. */
function everything(): Record<string, unknown[]> {
  const tables = q(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not in ('sessions') order by name`).map((r) => r.name as string);
  return Object.fromEntries(tables.map((t) => [t, q(`select * from "${t}" order by rowid`)]));
}
const renew = (id: string, opts: { body?: unknown; raw?: string; bearer?: string; cookie?: boolean; env?: Partial<Env> } = {}) =>
  w.call("POST", `/api/native/devices/${id}/renew`, {
    ...(opts.raw !== undefined ? { raw: opts.raw } : { body: "body" in opts ? opts.body : {} }),
    ...(opts.bearer ? { bearer: opts.bearer } : {}),
    ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
/**
 * A device of the owner's, active, five days from its expiry. Its time columns are all BEFORE the frozen now (review
 * MINOR-1), so a renew that wrote any of them with "now" would show: made and confirmed at 07:00, last used at 08:30 —
 * within the hour, so its own requests at 09:00 write no last use.
 */
const SEEDED = { createdAt: instant(D, "07:00"), confirmedAt: instant(D, "07:00"), lastUsedAt: instant(D, "08:30") };
const phone = (over: Partial<typeof nativeDevices.$inferInsert> = {}) =>
  seedDevice(w.db, w.userId, { scope: V4, label: "Running phone", expiresAt: NEAR, ...SEEDED, ...over });
/** Every column of a device row but its expiry, as stored: what a renew must leave byte-identical. */
const allButExpiry = (id: string) => {
  const { expires_at: _expiry, ...rest } = deviceRow(id);
  return rest;
};
/** The writes a request made, outside the cookie's own session row. */
const writesOf = (a: { writes: string[] }) => a.writes.filter((s) => !/^update "sessions"/i.test(s));
const tablesWritten = (a: { writes: string[] }) => writesOf(a).map((s) => /^(insert into|update) "?(\w+)"?/i.exec(s)?.[2]).sort();

describe("Renew gives an active phone 30 days from now, in place", () => {
  it("200 renewed: the row identical but its expiry, one audit, and the phone's own /me says the new expiry", async () => {
    const d = await phone();
    const before = deviceRow(d.id);
    const kept = allButExpiry(d.id);
    const to = thirtyFromNow();
    const a = await renew(d.id);
    expect([a.status, a.json], a.text).toEqual([200, { ok: true, expiresAt: to, renewed: true }]);
    // Exactly one column changed: the token (the id is its hash), account, label, state, scope, confirmation, last use and
    // tries are kept, byte for byte — the time columns among them, each seeded before now.
    expect(deviceRow(d.id)).toEqual({ ...before, expires_at: to });
    expect(allButExpiry(d.id)).toStrictEqual(kept);
    expect([deviceRow(d.id).created_at, deviceRow(d.id).confirmed_at, deviceRow(d.id).last_used_at]).toEqual([SEEDED.createdAt, SEEDED.confirmedAt, SEEDED.lastUsedAt]);
    expect(Object.keys(kept).sort()).toEqual(Object.keys(before).filter((k) => k !== "expires_at").sort());
    expect(audits()).toEqual([{ userId: w.userId, kind: "native_device_renewed", detail: { deviceId: d.id, label: "Running phone", from: NEAR, to } }]);
    expect(tablesWritten(a)).toEqual(["audit_events", "native_devices"]);
    // The same token, its scope unchanged, reads its new expiry on its next request.
    expect((await w.call("GET", "/api/native/me", { bearer: d.token })).json.device).toEqual({ label: "Running phone", expiresAt: to, scope: V4 });
    // The laptop's list: the new expiry, no longer expiring soon, the same steps to offer.
    const listed = (await w.call("GET", "/api/native/devices")).json.devices.find((x: { id: string }) => x.id === d.id);
    expect([listed.expiresAt, listed.expiresSoon, listed.scope, listed.nextScope, listed.previousScope]).toEqual([to, false, V4, null, V3]);
  });

  it("the expiry is 30 days from the server's acceptance (the pairing's own lifetime), never +30 on the old expiry", async () => {
    expect(NATIVE_DEVICE_LIFETIME_DAYS).toBe(30);
    const tomorrow = await phone({ expiresAt: instant("2026-11-19", "09:00") });
    const later = await phone({ expiresAt: instant("2026-12-12", "09:00") });
    expect((await renew(tomorrow.id)).json.expiresAt).toBe(thirtyFromNow());
    expect((await renew(later.id)).json.expiresAt).toBe(thirtyFromNow());
    expect(deviceRow(tomorrow.id).expires_at).toBe(instant("2026-12-18", "09:00"));
    expect(deviceRow(later.id).expires_at).toBe(instant("2026-12-18", "09:00"));
  });

  it("the renewed phone keeps working past its old expiry, until the new one — and not a moment past it", async () => {
    const d = await phone();
    await renew(d.id);
    vi.setSystemTime(new Date(Date.parse(NEAR) + DAY));
    expect((await w.call("GET", "/api/native/me", { bearer: d.token })).status).toBe(200);
    vi.setSystemTime(new Date(Date.parse(deviceRow(d.id).expires_at) + 1));
    expect((await w.call("GET", "/api/native/me", { bearer: d.token })).json).toEqual({ error: "device_expired" });
  });

  it("scope, token and state are untouched at every scope: each phone reaches exactly what it did before", async () => {
    for (const scope of [V1, V2, V3, V4]) {
      const d = await phone({ scope, label: `Phone ${scope}` });
      const before = deviceRow(d.id);
      expect((await renew(d.id)).json.renewed).toBe(true);
      expect(deviceRow(d.id)).toEqual({ ...before, expires_at: thirtyFromNow() });
      expect((await w.call("GET", "/api/native/me", { bearer: d.token })).json.device.scope).toBe(scope);
      // A v4 read answers a v4 phone and stays refused to the rest: a renew grants nothing.
      const days = await w.call("GET", `/api/native/days?from=${D}&to=${D}`, { bearer: d.token });
      expect([scope, days.status === 403 ? days.json : "read"]).toEqual([scope, scope === V4 ? "read" : { error: "out_of_scope" }]);
    }
  });
});

describe("Renew is idempotent within a short window, and the expiry never moves backwards", () => {
  it("the same renew again (a double click, a resend): 200 renewed false, the same expiry, nothing written, one audit", async () => {
    const d = await phone();
    const first = await renew(d.id);
    expect(first.json.renewed).toBe(true);
    const held = everything();
    const again = await renew(d.id);
    expect([again.status, again.json]).toEqual([200, { ok: true, expiresAt: first.json.expiresAt, renewed: false }]);
    expect(writesOf(again)).toEqual([]);
    expect(everything()).toEqual(held);
    expect(audits()).toHaveLength(1);
  });

  it(`within ${RENEW_REPEAT_MS / MINUTE} minutes it is the same renew; past that, a new one moves the expiry forward, never back`, async () => {
    expect(RENEW_REPEAT_MS).toBe(10 * MINUTE);
    const d = await phone();
    const first = (await renew(d.id)).json.expiresAt as string;
    vi.setSystemTime(new Date(Date.now() + RENEW_REPEAT_MS - 1));
    expect((await renew(d.id)).json).toEqual({ ok: true, expiresAt: first, renewed: false });
    vi.setSystemTime(new Date(Date.now() + 2));
    const second = (await renew(d.id)).json;
    expect(second).toEqual({ ok: true, expiresAt: thirtyFromNow(), renewed: true });
    expect(second.expiresAt > first).toBe(true);
    expect(audits().map((a) => [a.detail.from, a.detail.to])).toEqual([[NEAR, first], [first, second.expiresAt]]);
  });

  it("an expiry already past 30 days from now (a clock's skew, an older lifetime) is kept: 200 renewed false, nothing written", async () => {
    const far = new Date(Date.now() + 40 * DAY).toISOString();
    const d = await phone({ expiresAt: far });
    const held = everything();
    const a = await renew(d.id);
    expect([a.status, a.json]).toEqual([200, { ok: true, expiresAt: far, renewed: false }]);
    expect(everything()).toEqual(held);
    // Just inside the window: kept too, never pulled back to now + 30 days.
    const close = new Date(Date.now() + 30 * DAY - RENEW_REPEAT_MS + MINUTE).toISOString();
    const e = await phone({ expiresAt: close });
    expect((await renew(e.id)).json).toEqual({ ok: true, expiresAt: close, renewed: false });
    expect(deviceRow(e.id).expires_at).toBe(close);
    expect(audits()).toEqual([]);
  });

  it("two renews at once: one renewed, one not, one audit", async () => {
    const d = await phone();
    const both = await Promise.all([renew(d.id), renew(d.id)]);
    expect(both.map((a) => [a.status, a.json.renewed]).sort()).toEqual([[200, false], [200, true]]);
    expect(deviceRow(d.id).expires_at).toBe(thirtyFromNow());
    expect(audits()).toHaveLength(1);
  });

  it("a renew that lands between another's read and its write: the other renews nothing, and writes no audit", async () => {
    const d = await phone();
    let inner: Awaited<ReturnType<typeof renew>> | null = null;
    gates.claim = async () => void (inner = await renew(d.id));
    const outer = await renew(d.id);
    expect([inner!.json, outer.json]).toEqual([
      { ok: true, expiresAt: thirtyFromNow(), renewed: true },
      { ok: true, expiresAt: thirtyFromNow(), renewed: false },
    ]);
    expect(audits()).toHaveLength(1);
  });
});

describe("what Renew refuses, writing nothing", () => {
  it("revoked, expired and pending devices: 409 with the state; a revoked one stays revoked, an expired one expired", async () => {
    const revoked = await phone({ state: "revoked", revokedAt: nowInstant(), revokedReason: "owner" });
    const expired = await phone({ expiresAt: instant(D, "08:00") });
    const pending = await phone({ state: "pending", confirmedAt: null, expiresAt: new Date(Date.now() + 5 * MINUTE).toISOString() });
    const held = everything();
    expect([(await renew(revoked.id)).status, (await renew(revoked.id)).json]).toEqual([409, { error: "device_revoked" }]);
    expect([(await renew(expired.id)).status, (await renew(expired.id)).json]).toEqual([409, { error: "device_expired" }]);
    expect([(await renew(pending.id)).status, (await renew(pending.id)).json]).toEqual([409, { error: "device_pending" }]);
    expect(everything()).toEqual(held);
    expect((await w.call("GET", "/api/native/me", { bearer: revoked.token })).json).toEqual({ error: "device_revoked" });
    expect((await w.call("GET", "/api/native/me", { bearer: expired.token })).json).toEqual({ error: "device_expired" });
    expect((await w.call("GET", "/api/native/me", { bearer: pending.token })).json).toEqual({ error: "device_pending" });
  });

  it("an expiry of exactly now is expired (review MINOR-2), as the device gate holds it: 409 device_expired, nothing written", async () => {
    const d = await phone({ expiresAt: nowInstant() });
    const held = everything();
    const a = await renew(d.id);
    expect([a.status, a.json]).toEqual([409, { error: "device_expired" }]);
    expect(everything()).toEqual(held);
    // The gate agrees: the phone itself is refused at that instant.
    expect((await w.call("GET", "/api/native/me", { bearer: d.token })).json).toEqual({ error: "device_expired" });
    // A millisecond later than now it is still live, and renews.
    const e = await phone({ expiresAt: new Date(Date.now() + 1).toISOString() });
    expect((await renew(e.id)).json).toEqual({ ok: true, expiresAt: thirtyFromNow(), renewed: true });
  });

  it("another account's device, or none: 404 not_found, and theirs is untouched", async () => {
    const other = await makeTestUser(w.db, { timezone: LA });
    const theirs = await seedDevice(w.db, other.userId, { scope: V4, expiresAt: NEAR });
    const held = everything();
    expect([(await renew(theirs.id)).status, (await renew(theirs.id)).json]).toEqual([404, { error: "not_found" }]);
    expect([(await renew("f".repeat(64))).status, (await renew("f".repeat(64))).json]).toEqual([404, { error: "not_found" }]);
    expect(everything()).toEqual(held);
  });

  it("a device revoked between the renew's read and its write: nothing renewed, no audit, and it stays revoked", async () => {
    const d = await phone();
    gates.claim = async () => {
      expect((await w.call("POST", `/api/native/devices/${d.id}/revoke`, { body: {} })).json).toEqual({ ok: true, revoked: true });
    };
    const a = await renew(d.id);
    expect([a.status, a.json]).toEqual([409, { error: "device_revoked" }]);
    expect([deviceRow(d.id).state, deviceRow(d.id).expires_at]).toEqual(["revoked", NEAR]);
    expect(audits()).toEqual([]);
  });

  it("a device whose expiry has come by the renew's write is not renewed: the claim's own gate holds expiry", async () => {
    const d = await phone();
    const gone = instant(D, "08:00");
    gates.claim = async () => void client().prepare(`update native_devices set expires_at = ? where id = ?`).run(gone, d.id);
    const a = await renew(d.id);
    expect([a.status, a.json]).toEqual([409, { error: "device_expired" }]);
    expect([deviceRow(d.id).expires_at, audits()]).toEqual([gone, []]);
  });

  it("COOKIE ONLY: a device token can't renew itself or another, whatever its scope — 403 out_of_scope; no cookie is 401", async () => {
    const devices = [await phone({ scope: V1 }), await phone({ scope: V2 }), await phone({ scope: V3 }), await phone({ scope: V4 })];
    const held = everything();
    for (const by of devices) {
      for (const target of [by, devices[0]!]) {
        const a = await renew(target.id, { bearer: by.token });
        expect([a.status, a.json]).toEqual([403, { error: "out_of_scope" }]);
      }
    }
    expect([(await renew(devices[3]!.id, { cookie: false })).status]).toEqual([401]);
    // The token and the cookie together: one request, one credential.
    const both = await w.call("POST", `/api/native/devices/${devices[3]!.id}/renew`, { body: {}, bearer: devices[3]!.token, cookie: true });
    expect([both.status, both.json]).toEqual([400, { error: "two_credentials" }]);
    expect(everything()).toEqual(held);
  });

  it("the route's own cookie-only check (review NIT-1), apart from the allowlist: a request a device signed in is 403", async () => {
    // The device-scope list already refuses a device token before the route (above). This pins the route's second layer
    // alone: a request with the owner's cookie that a device nonetheless signed in (`c.get("device")` set) is refused.
    const d = await phone();
    const app = new Hono<AppContext>();
    app.use("*", async (c, next) => {
      c.set("db", w.db);
      c.set("device", { id: d.id, label: "Running phone", expiresAt: NEAR, scope: V4 });
      await next();
    });
    app.route("/api/native", nativeRoutes);
    const held = everything();
    const res = await app.request(`/api/native/devices/${d.id}/renew`, { method: "POST", headers: { Cookie: w.cookie, "Content-Type": "application/json" }, body: "{}" }, w.env);
    expect([res.status, await res.json()]).toEqual([403, { error: "out_of_scope" }]);
    expect(everything()).toEqual(held);
  });

  it("a body that isn't empty or {}: 400 invalid_renew; an empty body and {} renew", async () => {
    const d = await phone();
    const held = everything();
    for (const opts of [{ body: { scope: V4 } }, { body: { expiresAt: "2027-01-01T00:00:00.000Z" } }, { body: [] }, { body: null }, { body: 0 }, { raw: "not json" }]) {
      const a = await renew(d.id, opts);
      expect([JSON.stringify(opts), a.status, a.json]).toEqual([JSON.stringify(opts), 400, { error: "invalid_renew" }]);
    }
    expect(everything()).toEqual(held);
    expect((await renew(d.id, { raw: "" })).json.renewed).toBe(true);
    const e = await phone();
    expect((await renew(e.id, { body: {} })).json.renewed).toBe(true);
  });

  it("device sign-in off: 404, nothing changes (the switch stays the owner's); a restore: 423", async () => {
    const d = await phone();
    const held = everything();
    const off = await renew(d.id, { env: { NATIVE_DEVICES: "0" } });
    expect([off.status, off.json]).toEqual([404, { error: "not_found" }]);
    expect(everything()).toEqual(held);
    await w.db.insert(accountState).values({ userId: w.userId, restoreId: "r-1", restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    const restoring = await renew(d.id);
    expect([restoring.status, restoring.json]).toEqual([423, { error: "restore_in_progress" }]);
    expect([deviceRow(d.id).expires_at, audits()]).toEqual([NEAR, []]);
  });

  it("a cross-site request is refused by the app's origin guard: 403 bad_origin, nothing written", async () => {
    const d = await phone();
    const app = new Hono<AppContext>();
    app.use("*", async (c, next) => {
      c.set("db", w.db);
      await next();
    });
    app.use("/api/*", originGuard);
    app.route("/api/native", nativeRoutes);
    const send = (origin: string) =>
      app.request(`/api/native/devices/${d.id}/renew`, { method: "POST", headers: { Cookie: w.cookie, Origin: origin, "Content-Type": "application/json" }, body: "{}" }, w.env);
    const held = everything();
    const foreign = await send("https://evil.example");
    expect([foreign.status, await foreign.json()]).toEqual([403, { error: "bad_origin" }]);
    expect(everything()).toEqual(held);
    const own = await send(new URL(w.env.APP_URL).origin);
    expect([own.status, ((await own.json()) as { renewed: boolean }).renewed]).toEqual([200, true]);
  });
});
