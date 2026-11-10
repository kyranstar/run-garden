/**
 * PAIRING A PHONE, AND THE LAPTOP'S DEVICES (SLICE-CONTRACT revision 2 §10.1): signed-in laptop web mints the account's
 * one code; the phone redeems it unauthenticated with one conditional UPDATE … RETURNING, and gets a token shown once;
 * the device is pending until the owner confirms its check number on the laptop. Revoke, Revoke all and the phone's own
 * sign-out stop it at once. Device management is cookie only.
 *
 * Each case asserts the rows (the code's HMAC, its tries and use, the device's state and times) and what a device can
 * then do, not only the status. Through the real route modules on the repo's migrations, under a faked `Date`, D1's
 * bind cap on. THE CONCURRENT REDEMPTION runs in-process (better-sqlite3, one connection): the repo has no real-D1
 * harness under apps/worker/test. A barrier holds both requests until each has computed its HMAC, so the two
 * conditional UPDATEs race; the native harness (apps/worker/scripts/native-harness.sh) repeats it on wrangler's local
 * D1. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";

/** Holds the next `count` HMAC computations until all of them have arrived (the concurrent redemption's barrier). */
const barrier = vi.hoisted(() => ({ count: 0, waiting: [] as Array<() => void> }));
vi.mock("../src/auth/crypto.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/auth/crypto.js")>();
  return {
    ...real,
    hmacSha256Hex: async (...args: Parameters<typeof real.hmacSha256Hex>) => {
      const out = await real.hmacSha256Hex(...args);
      if (barrier.count > 0) {
        await new Promise<void>((release) => {
          barrier.waiting.push(release);
          if (barrier.waiting.length === barrier.count) {
            barrier.count = 0;
            for (const r of barrier.waiting.splice(0)) r();
          }
        });
      }
      return out;
    },
  };
});

import { sha256Hex } from "../src/auth/crypto.js";
import { checkNumberOf } from "../src/auth/native-devices.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { nativeRoutes } from "../src/routes/native.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { makeTestUser, pinMiddayToday } from "./helpers.js";
import { nativeWorld, seedDevice, seedSlot, type NativeWorld } from "./native-fixture.js";

const { nativeDevices, nativePairings } = schema;

const MIN = 60_000;
const DAY = 86_400_000;
const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

let today: string;
let w: NativeWorld;
let slot: string;

beforeEach(async () => {
  today = pinMiddayToday();
  w = await nativeWorld([
    ["/api/native", nativeRoutes],
    ["/api/sessions", sessionRoutes],
  ]);
  slot = await seedSlot(w.db, w.userId, today);
});
afterEach(() => {
  vi.useRealTimers();
  barrier.count = 0;
});

const mint = () => w.call("POST", "/api/native/pairings", { body: {} });
const redeem = (code: string, label = "Synthetic phone") => w.call("POST", "/api/native/pair", { cookie: false, body: { code, label } });
const pairing = async () => (await w.db.select().from(nativePairings).where(eq(nativePairings.userId, w.userId)))[0];
const devices = () => w.db.select().from(nativeDevices);
const deviceOf = async (id: string) => (await w.db.select().from(nativeDevices).where(eq(nativeDevices.id, id)))[0]!;
const asDevice = (token: string) => w.call("GET", `/api/sessions/${slot}`, { bearer: token });
/** A code that is not this one: its first character changed. */
const wrongOf = (code: string) => `${code[0] === "Z" ? "Y" : "Z"}${code.slice(1)}`;

/** Mint, redeem and confirm: an active device's token. */
async function paired(label = "Synthetic phone"): Promise<{ token: string; id: string }> {
  const { code } = (await mint()).json;
  const { token, check } = (await redeem(code, label)).json;
  const id = await sha256Hex(token);
  const confirmed = await w.call("POST", `/api/native/devices/${id}/confirm`, { body: { check } });
  expect(confirmed.status, confirmed.text).toBe(200);
  return { token, id };
}

describe("minting, on laptop web (cookie only)", () => {
  it("mints one 8-character Crockford code valid 5 minutes, and stores only its HMAC under SESSION_SECRET", async () => {
    const a = await mint();
    expect(a.status, a.text).toBe(200);
    expect(a.json).toEqual({ code: expect.stringMatching(CROCKFORD), expiresAt: later(5 * MIN) });
    const row = await pairing();
    expect(row).toEqual({ userId: w.userId, codeHmac: expect.stringMatching(/^[0-9a-f]{64}$/), createdAt: nowInstant(), expiresAt: later(5 * MIN), tries: 0, usedAt: null });
    // Keyed: neither the code nor its plain hash is stored, and the code was never bound into a statement.
    expect(row!.codeHmac).not.toBe(await sha256Hex(a.json.code));
    expect(JSON.stringify(await w.db.select().from(nativePairings))).not.toContain(a.json.code);
    expect(w.binds.flat().map(String)).not.toContain(a.json.code);
  });

  it("a new code burns the old: one row for the account, the old code no longer redeems, the new one does", async () => {
    const first = (await mint()).json.code;
    const second = (await mint()).json.code;
    expect(await w.db.select().from(nativePairings)).toHaveLength(1);
    expect([(await redeem(first)).status, (await redeem(second)).status]).toEqual([401, 200]);
    expect(await devices()).toHaveLength(1);
  });

  it("only the owner's account mints: another signed-in account is 403 not_owner, and no code is made", async () => {
    const { userId: other } = await makeTestUser(w.db);
    const cookie = `${SESSION_COOKIE}=${await createSession(w.db, other, "test")}`;
    const a = await w.call("POST", "/api/native/pairings", { cookie, body: {} });
    expect([a.status, a.json]).toEqual([403, { error: "not_owner" }]);
    expect(await w.db.select().from(nativePairings)).toEqual([]);
  });
});

describe("redeeming, from the phone (unauthenticated)", () => {
  it("makes a pending device for the owner: the token once, its check number, the code used; the token is stored nowhere", async () => {
    const { code } = (await mint()).json;
    const a = await redeem(code, "Kitchen iPhone");
    expect(a.status, a.text).toBe(200);
    expect(a.json).toEqual({ token: expect.stringMatching(/^rgd_[A-Za-z0-9_-]{43}$/), check: expect.stringMatching(/^\d{4}$/), state: "pending", confirmBy: later(10 * MIN) });
    const id = await sha256Hex(a.json.token);
    // The phone derives the same check number from its own token.
    expect(a.json.check).toBe(await checkNumberOf(id));
    expect(await devices()).toEqual([
      {
        id,
        userId: w.userId,
        scope: "training-slice-v1",
        label: "Kitchen iPhone",
        state: "pending",
        checkNumber: a.json.check,
        createdAt: nowInstant(),
        expiresAt: later(10 * MIN),
        confirmedAt: null,
        lastUsedAt: null,
        revokedAt: null,
        revokedReason: null,
        checkTries: 0,
      },
    ]);
    expect(await pairing()).toMatchObject({ usedAt: nowInstant(), tries: 0 });
    expect(w.binds.flat().map(String)).not.toContain(a.json.token);
    expect(a.text.match(/rgd_/g)).toHaveLength(1);
    // Pending: 401 device_pending everywhere, until the laptop confirms it.
    expect((await asDevice(a.json.token)).json).toEqual({ error: "device_pending" });
  });

  it("accepts the code as people type it: lower case, spaces, a hyphen, I/L for 1 and O for 0", async () => {
    const { code } = (await mint()).json as { code: string };
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase().replace(/1/g, "l").replace(/0/g, "o");
    expect((await redeem(` ${typed} `)).status).toBe(200);
  });

  it("expiry: a code past its 5 minutes is 401 pair_failed, counts no try, and makes no device", async () => {
    const { code } = (await mint()).json;
    vi.setSystemTime(new Date(Date.now() + 5 * MIN));
    const a = await redeem(code);
    expect([a.status, a.json]).toEqual([401, { error: "pair_failed" }]);
    expect(await pairing()).toMatchObject({ usedAt: null, tries: 0 });
    expect(await devices()).toEqual([]);
  });

  it("reuse: the code used once is 401 pair_failed after, and there is still one device", async () => {
    const { code } = (await mint()).json;
    expect((await redeem(code)).status).toBe(200);
    const again = await redeem(code);
    expect([again.status, again.json]).toEqual([401, { error: "pair_failed" }]);
    expect(await devices()).toHaveLength(1);
  });

  it("every miss counts against the live code; four leave it redeemable, the fifth burns it for good", async () => {
    const { code } = (await mint()).json;
    for (let i = 1; i <= 4; i++) {
      expect((await redeem(wrongOf(code))).json).toEqual({ error: "pair_failed" });
      expect((await pairing())!.tries).toBe(i);
    }
    expect((await redeem(code)).status).toBe(200);

    const next = (await mint()).json.code;
    expect((await pairing())!.tries).toBe(0);
    for (let i = 1; i <= 5; i++) await redeem(i % 2 ? wrongOf(next) : "not-even-a-code");
    expect((await pairing())!.tries).toBe(5);
    const burned = await redeem(next);
    expect([burned.status, burned.json]).toEqual([401, { error: "pair_failed" }]);
    expect((await pairing())).toMatchObject({ tries: 5, usedAt: null });
    expect(await devices()).toHaveLength(1);
  });

  it("no live code, a wrong code, a used, an expired and a burned code all get the same answer, byte for byte", async () => {
    const answers: string[] = [];
    const record = async (code: string) => {
      const a = await redeem(code);
      answers.push(`${a.status} ${a.text}`);
    };
    await record("ABCDEFGH"); // no code minted
    const { code } = (await mint()).json;
    await record(wrongOf(code));
    await redeem(code);
    await record(code); // used
    const expiring = (await mint()).json.code;
    vi.setSystemTime(new Date(Date.now() + 6 * MIN));
    await record(expiring); // expired
    const burning = (await mint()).json.code;
    for (let i = 0; i < 5; i++) await redeem(wrongOf(burning));
    await record(burning); // burned
    expect(new Set(answers)).toEqual(new Set(['401 {"error":"pair_failed"}']));
  });

  it("a body that is not {code, label} is 400 invalid_pair and costs no try", async () => {
    await mint();
    for (const body of [{}, { code: "ABCDEFGH" }, { label: "x" }, { code: 12345678, label: "x" }, { code: "ABCDEFGH", label: "" }, { code: "ABCDEFGH", label: "x".repeat(61) }, { code: "A".repeat(65), label: "x" }]) {
      const a = await w.call("POST", "/api/native/pair", { cookie: false, body });
      expect([JSON.stringify(body), a.status, a.json]).toEqual([JSON.stringify(body), 400, { error: "invalid_pair" }]);
    }
    expect((await pairing())!.tries).toBe(0);
  });

  it("two redemptions of one code at once make exactly one device: the conditional UPDATE lets one through", async () => {
    const { code } = (await mint()).json;
    barrier.count = 2;
    const from = w.statements.length;
    const both = await Promise.all([redeem(code, "Phone A"), redeem(code, "Phone B")]);
    // Both requests had read the owner and computed the HMAC before either UPDATE ran: they raced at the UPDATE.
    const ran = w.statements.slice(from);
    const updates = ran.map((s, i) => [s, i] as const).filter(([s]) => /^update "native_pairings"/.test(s)).map(([, i]) => i);
    const ownerReads = ran.map((s, i) => [s, i] as const).filter(([s]) => /from "users"/.test(s)).map(([, i]) => i);
    expect(updates).toHaveLength(2);
    expect(Math.max(...ownerReads)).toBeLessThan(Math.min(...updates));
    expect(both.map((a) => a.status).sort()).toEqual([200, 401]);
    expect(both.find((a) => a.status === 401)!.json).toEqual({ error: "pair_failed" });
    const made = await devices();
    expect(made).toHaveLength(1);
    expect(made[0]!.id).toBe(await sha256Hex(both.find((a) => a.status === 200)!.json.token));
    expect(await pairing()).toMatchObject({ usedAt: nowInstant(), tries: 0 });
  });
});

describe("confirming on the laptop", () => {
  it("lists the pending phone with its label and check number; Confirm with that number makes it active for 30 days", async () => {
    const { code } = (await mint()).json;
    const { token, check } = (await redeem(code, "Kitchen iPhone")).json;
    const id = await sha256Hex(token);
    const list = await w.call("GET", "/api/native/devices");
    expect(list.status).toBe(200);
    expect(list.json).toEqual({
      enabled: true,
      devices: [{ id, label: "Kitchen iPhone", state: "pending", check, createdAt: nowInstant(), confirmedAt: null, lastUsedAt: null, expiresAt: later(10 * MIN), expiresSoon: false }],
    });
    vi.setSystemTime(new Date(Date.now() + 2 * MIN));
    const a = await w.call("POST", `/api/native/devices/${id}/confirm`, { body: { check } });
    expect([a.status, a.json]).toEqual([200, { ok: true, expiresAt: later(30 * DAY) }]);
    expect(await deviceOf(id)).toMatchObject({ state: "active", confirmedAt: nowInstant(), expiresAt: later(30 * DAY) });
    expect((await asDevice(token)).status).toBe(200);
  });

  it("a wrong check number confirms nothing (409 check_mismatch); the right one still does", async () => {
    const { code } = (await mint()).json;
    const { token, check } = (await redeem(code)).json;
    const id = await sha256Hex(token);
    const wrong = String((Number(check) + 1) % 10000).padStart(4, "0");
    const a = await w.call("POST", `/api/native/devices/${id}/confirm`, { body: { check: wrong } });
    expect([a.status, a.json]).toEqual([409, { error: "check_mismatch" }]);
    expect((await deviceOf(id)).state).toBe("pending");
    expect((await w.call("POST", `/api/native/devices/${id}/confirm`, { body: { check } })).status).toBe(200);
  });

  it("past its 10 minutes a pending phone can't be confirmed (409 confirm_expired) and stays out (device_expired)", async () => {
    const { code } = (await mint()).json;
    const { token, check } = (await redeem(code)).json;
    const id = await sha256Hex(token);
    vi.setSystemTime(new Date(Date.now() + 10 * MIN));
    const a = await w.call("POST", `/api/native/devices/${id}/confirm`, { body: { check } });
    expect([a.status, a.json]).toEqual([409, { error: "confirm_expired" }]);
    expect(await deviceOf(id)).toMatchObject({ state: "pending", confirmedAt: null });
    expect((await asDevice(token)).json).toEqual({ error: "device_expired" });
  });

  it("an active device is 409 not_pending; another account's device or no device is 404; a bad body is 400", async () => {
    const mine = await paired();
    expect((await w.call("POST", `/api/native/devices/${mine.id}/confirm`, { body: { check: "0000" } })).json).toEqual({ error: "not_pending" });
    const { userId: other } = await makeTestUser(w.db);
    const theirs = await seedDevice(w.db, other, { state: "pending", confirmedAt: null, expiresAt: later(5 * MIN) });
    for (const id of [theirs.id, "f".repeat(64)]) {
      const a = await w.call("POST", `/api/native/devices/${id}/confirm`, { body: { check: "0420" } });
      expect([a.status, a.json]).toEqual([404, { error: "not_found" }]);
    }
    expect((await deviceOf(theirs.id)).state).toBe("pending");
    expect((await w.call("POST", `/api/native/devices/${mine.id}/confirm`, { body: { check: 420 } })).status).toBe(400);
  });

  it("lists active and pending devices with label, last use, expiry and the 7-day warning; never a revoked or expired one", async () => {
    const soon = await seedDevice(w.db, w.userId, { label: "Old phone", lastUsedAt: later(-3 * DAY), expiresAt: later(6 * DAY) });
    const fresh = await seedDevice(w.db, w.userId, { label: "New phone", expiresAt: later(29 * DAY) });
    await seedDevice(w.db, w.userId, { label: "Revoked phone", state: "revoked", revokedAt: nowInstant(), revokedReason: "owner" });
    await seedDevice(w.db, w.userId, { label: "Lapsed phone", expiresAt: later(-1) });
    const { userId: other } = await makeTestUser(w.db);
    await seedDevice(w.db, other, { label: "Their phone" });
    const list = (await w.call("GET", "/api/native/devices")).json;
    const rows = list.devices.map((d: any) => [d.id, d.label, d.state, d.check, d.lastUsedAt, d.expiresAt, d.expiresSoon]);
    expect(rows.sort((x: string[], y: string[]) => x[1]!.localeCompare(y[1]!))).toEqual([
      [fresh.id, "New phone", "active", null, null, later(29 * DAY), false],
      [soon.id, "Old phone", "active", null, later(-3 * DAY), later(6 * DAY), true],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/rgd_|code/);
  });
});

describe("revoking", () => {
  it("Revoke stops that phone at once (401 device_revoked); another phone keeps working", async () => {
    const a = await paired("Phone A");
    const b = await paired("Phone B");
    const r = await w.call("POST", `/api/native/devices/${a.id}/revoke`, { body: {} });
    expect([r.status, r.json]).toEqual([200, { ok: true, revoked: true }]);
    expect(await deviceOf(a.id)).toMatchObject({ state: "revoked", revokedAt: nowInstant(), revokedReason: "owner" });
    expect((await asDevice(a.token)).json).toEqual({ error: "device_revoked" });
    expect((await asDevice(b.token)).status).toBe(200);
    // Revoking it again changes nothing; another account's device is not found.
    expect((await w.call("POST", `/api/native/devices/${a.id}/revoke`, { body: {} })).json).toEqual({ ok: true, revoked: false });
    const { userId: other } = await makeTestUser(w.db);
    const theirs = await seedDevice(w.db, other);
    expect((await w.call("POST", `/api/native/devices/${theirs.id}/revoke`, { body: {} })).status).toBe(404);
    expect((await deviceOf(theirs.id)).state).toBe("active");
  });

  it("Revoke all stops every phone of the account, pending ones too; another account's are untouched", async () => {
    const a = await paired("Phone A");
    const b = await paired("Phone B");
    const { code } = (await mint()).json;
    const pending = (await redeem(code, "Phone C")).json.token;
    const { userId: other } = await makeTestUser(w.db);
    const theirs = await seedDevice(w.db, other);
    const r = await w.call("POST", "/api/native/devices/revoke-all", { body: {} });
    expect([r.status, r.json]).toEqual([200, { ok: true, revoked: 3 }]);
    for (const t of [a.token, b.token, pending]) expect((await asDevice(t)).json).toEqual({ error: "device_revoked" });
    expect((await w.db.select().from(nativeDevices).where(eq(nativeDevices.userId, w.userId))).map((d) => [d.state, d.revokedReason])).toEqual([
      ["revoked", "owner_all"],
      ["revoked", "owner_all"],
      ["revoked", "owner_all"],
    ]);
    expect((await deviceOf(theirs.id)).state).toBe("active");
  });

  it("the phone's own sign-out revokes its row (sign_out); its next request is 401; a cookie's sign-out is 400 not_a_device", async () => {
    const a = await paired();
    const b = await paired("Phone B");
    const out = await w.call("POST", "/api/native/sign-out", { bearer: a.token, body: {} });
    expect([out.status, out.json]).toEqual([200, { ok: true }]);
    expect(await deviceOf(a.id)).toMatchObject({ state: "revoked", revokedReason: "sign_out", revokedAt: nowInstant() });
    expect((await w.call("POST", "/api/native/sign-out", { bearer: a.token, body: {} })).json).toEqual({ error: "device_revoked" });
    expect((await deviceOf(b.id)).state).toBe("active");
    expect((await w.call("POST", "/api/native/sign-out", { body: {} })).json).toEqual({ error: "not_a_device" });
  });
});

describe("device management is cookie only", () => {
  it("a device token can't mint, list, confirm, revoke or revoke all: 403 out_of_scope, and nothing changes", async () => {
    const a = await paired();
    const { code } = (await mint()).json;
    const pending = await sha256Hex((await redeem(code, "Phone B")).json.token);
    const before = { devices: await devices(), pairings: await w.db.select().from(nativePairings) };
    for (const [method, path, body] of [
      ["POST", "/api/native/pairings", {}],
      ["GET", "/api/native/devices", undefined],
      ["POST", `/api/native/devices/${pending}/confirm`, { check: "0000" }],
      ["POST", `/api/native/devices/${a.id}/revoke`, {}],
      ["POST", "/api/native/devices/revoke-all", {}],
    ] as const) {
      const r = await w.call(method, path, { bearer: a.token, body });
      expect([path, r.status, r.json]).toEqual([path, 403, { error: "out_of_scope" }]);
      expect(r.writes).toEqual([]);
    }
    expect({ devices: await devices(), pairings: await w.db.select().from(nativePairings) }).toEqual(before);
    // Revoked, it can't re-pair itself either: minting stays cookie only.
    await w.call("POST", `/api/native/devices/${a.id}/revoke`, { body: {} });
    expect((await w.call("POST", "/api/native/pairings", { bearer: a.token, body: {} })).json).toEqual({ error: "device_revoked" });
  });

  it("with the kill switch off, minting, redeeming and confirming are 404; listing and revoking still answer", async () => {
    const a = await paired();
    const { code } = (await mint()).json;
    const pendingToken = (await redeem(code, "Phone B")).json.token as string;
    const pending = await sha256Hex(pendingToken);
    const off = { env: { NATIVE_DEVICES: undefined } };
    expect((await w.call("POST", "/api/native/pairings", { body: {}, ...off })).status).toBe(404);
    expect((await w.call("POST", "/api/native/pair", { cookie: false, body: { code: "ABCDEFGH", label: "x" }, ...off })).status).toBe(404);
    expect((await w.call("POST", `/api/native/devices/${pending}/confirm`, { body: { check: "0000" }, ...off })).status).toBe(404);
    // Both made at the same faked instant: the list's order between them is its ids', so the ids are compared as a set.
    const listed = (await w.call("GET", "/api/native/devices", off)).json;
    expect(listed.enabled).toBe(false);
    expect(listed.devices.map((d: { id: string }) => d.id).sort()).toEqual([a.id, pending].sort());
    expect((await w.call("POST", "/api/native/devices/revoke-all", { body: {}, ...off })).json).toEqual({ ok: true, revoked: 2 });
    expect((await pairing())!.usedAt).toBe(nowInstant());
  });
});
