/**
 * PAIRING RATE CONTROLS (kit v0.5). The code's own 5 tries bound guesses at one live code; these bound the rest:
 *
 *  - REDEEM, unauthenticated: failed redemptions per window per client (`CF-Connecting-IP`, hashed) and globally. Each
 *    attempt is counted BEFORE it is evaluated, in one atomic statement, so concurrent requests can't slip past a bound;
 *    a success gives its count back. Past a bound, every redeem gets the same 401 `pair_failed` for the cool-off, even with
 *    the right code, and is never evaluated: the live code's tries are untouched. Guesses while no code is live, of an
 *    expired or a used code, all count. A new code from the laptop lifts the throttle (the owner's recovery: Pair again).
 *  - MINT, cookie: a few codes per account per window, then 429 `too_many_codes` for a cool-off.
 *  - CONFIRM, cookie: a few wrong check numbers revoke the pending phone, in the same statement that counts them.
 *
 * Unchanged, and pinned again here: single-use redemption, the laptop's confirmation, identical failure answers.
 * Through the real route modules on the repo's migrations, under a faked `Date`, D1's bind cap on. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { sha256Hex } from "../src/auth/crypto.js";
import {
  CONFIRM_MAX_WRONG,
  MINT_COOL_OFF_MS,
  MINTS_PER_WINDOW,
  PAIR_COOL_OFF_MS,
  PAIR_FAILS_GLOBAL,
  PAIR_FAILS_PER_IP,
  PAIR_WINDOW_MS,
  PAIRING_CODE_TTL_MS,
} from "../src/auth/native-devices.js";
import { nativeRoutes } from "../src/routes/native.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { pinMiddayToday } from "./helpers.js";
import { nativeWorld, seedSlot, type Answer, type NativeWorld } from "./native-fixture.js";

const { nativeDevices, nativePairings, nativePairLimits } = schema;

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

const ip = (n: number | string) => `198.51.100.${n}`;
const mint = () => w.call("POST", "/api/native/pairings", { body: {} });
const redeem = (code: string, from?: string, label = "Synthetic phone") =>
  w.call("POST", "/api/native/pair", { cookie: false, body: { code, label }, ...(from ? { headers: { "CF-Connecting-IP": from } } : {}) });
const pairing = async () => (await w.db.select().from(nativePairings).where(eq(nativePairings.userId, w.userId)))[0];
const devices = () => w.db.select().from(nativeDevices);
const wrongOf = (code: string) => `${code[0] === "Z" ? "Y" : "Z"}${code.slice(1)}`;
const later = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
/** Requests that evaluated a code: the redeem's conditional UPDATE ran. */
const evaluated = (a: Answer) => a.statements.filter((s) => /^update "native_pairings"/.test(s)).length;
/** A failure as the phone sees it: status, body and the headers that matter, byte for byte. */
const asSeen = (a: Answer) => JSON.stringify([a.status, a.text, a.headers["content-type"], a.headers["cache-control"]]);
const MISS = JSON.stringify([401, '{"error":"pair_failed"}', "application/json", "no-store"]);

describe("redeem: failures are bounded per client and in all", () => {
  it("a client's wrong and malformed codes count; past the bound it gets pair_failed even with the right code, which is never touched", async () => {
    const { code } = (await mint()).json;
    for (const guess of [wrongOf(code), "not a code", wrongOf(code)].slice(0, PAIR_FAILS_PER_IP)) expect(asSeen(await redeem(guess, ip(1)))).toBe(MISS);
    expect((await pairing())!.tries).toBe(PAIR_FAILS_PER_IP);
    const throttled = await redeem(code, ip(1));
    expect(asSeen(throttled)).toBe(MISS);
    expect(evaluated(throttled)).toBe(0);
    expect(await pairing()).toMatchObject({ tries: PAIR_FAILS_PER_IP, usedAt: null });
    expect(await devices()).toEqual([]);
    // Another client is not throttled: the owner's phone pairs.
    const phone = await redeem(code, ip(2));
    expect(phone.status, phone.text).toBe(200);
  });

  it("guesses while no code is live count, from any number of clients: past the global bound none is evaluated", async () => {
    for (let i = 1; i <= PAIR_FAILS_GLOBAL; i++) {
      const a = await redeem("ABCDEFGH", ip(i));
      expect([i, asSeen(a), evaluated(a)]).toEqual([i, MISS, 1]);
    }
    const past = await redeem("ABCDEFGH", ip(200));
    expect([asSeen(past), evaluated(past)]).toEqual([MISS, 0]);
    // No client header at all (the worker can't see one): the global bound still holds.
    expect(evaluated(await redeem("ABCDEFGH"))).toBe(0);
  });

  it("an expired code's and a used code's guesses are failures that count", async () => {
    const first = (await mint()).json.code;
    expect((await redeem(first, ip(1))).status).toBe(200);
    for (let i = 0; i < PAIR_FAILS_PER_IP; i++) expect(asSeen(await redeem(first, ip(3)))).toBe(MISS);
    expect(evaluated(await redeem(first, ip(3)))).toBe(0);
    const second = (await mint()).json.code;
    later(PAIRING_CODE_TTL_MS);
    for (let i = 0; i < PAIR_FAILS_PER_IP; i++) expect(asSeen(await redeem(second, ip(4)))).toBe(MISS);
    expect(evaluated(await redeem(second, ip(4)))).toBe(0);
    expect(await devices()).toHaveLength(1);
  });

  it("the throttled answer is a miss byte for byte, and both are the no-code answer", async () => {
    const none = await redeem("ABCDEFGH", ip(9));
    const { code } = (await mint()).json;
    const wrong = await redeem(wrongOf(code), ip(1));
    for (let i = 1; i < PAIR_FAILS_PER_IP; i++) await redeem(wrongOf(code), ip(1));
    const throttled = await redeem(code, ip(1));
    expect(new Set([none, wrong, throttled].map(asSeen))).toEqual(new Set([MISS]));
  });

  it("a success gives its count back: the owner's own typos and right code leave the client's count at its typos", async () => {
    const { code } = (await mint()).json;
    for (let i = 1; i < PAIR_FAILS_PER_IP; i++) await redeem(wrongOf(code), ip(1));
    expect((await redeem(code, ip(1))).status).toBe(200);
    const rows = await w.db.select().from(nativePairLimits).where(like(nativePairLimits.key, "redeem:ip:%"));
    expect(rows.map((r) => [r.count, r.blockedUntil])).toEqual([[PAIR_FAILS_PER_IP - 1, null]]);
    // No raw address is stored: the key is the address's hash.
    expect(JSON.stringify(await w.db.select().from(nativePairLimits))).not.toContain(ip(1));
  });
});

describe("concurrent attempts across a bound", () => {
  /** Codes evaluated by everything since `from` (concurrent requests share the log, so it is counted once, in all). */
  const evaluatedSince = (from: number) => w.statements.slice(from).filter((s) => /^update "native_pairings"/.test(s)).length;

  it("one client's burst: exactly the per-client bound is evaluated, every answer a miss, and the code survives for the phone", async () => {
    const { code } = (await mint()).json;
    const from = w.statements.length;
    const burst = await Promise.all(Array.from({ length: 8 }, () => redeem(wrongOf(code), ip(1))));
    expect(new Set(burst.map(asSeen))).toEqual(new Set([MISS]));
    expect(evaluatedSince(from)).toBe(PAIR_FAILS_PER_IP);
    expect(await pairing()).toMatchObject({ tries: PAIR_FAILS_PER_IP, usedAt: null });
    expect((await redeem(code, ip(2))).status).toBe(200);
  });

  it("a burst from many clients with no code live: exactly the global bound is evaluated", async () => {
    const from = w.statements.length;
    const burst = await Promise.all(Array.from({ length: PAIR_FAILS_GLOBAL + 6 }, (_, i) => redeem("ABCDEFGH", ip(i + 1))));
    expect(new Set(burst.map(asSeen))).toEqual(new Set([MISS]));
    expect(evaluatedSince(from)).toBe(PAIR_FAILS_GLOBAL);
  });

  it("the right code racing wrong ones at the bound: one device at most, single use kept, never past the bound", async () => {
    const { code } = (await mint()).json;
    for (let i = 1; i < PAIR_FAILS_PER_IP; i++) await redeem(wrongOf(code), ip(1));
    const from = w.statements.length;
    const race = await Promise.all([redeem(code, ip(1)), redeem(code, ip(1)), redeem(wrongOf(code), ip(1)), redeem(code, ip(1))]);
    expect(race.filter((a) => a.status === 200).length).toBeLessThanOrEqual(1);
    expect(evaluatedSince(from)).toBe(1);
    expect((await devices()).length).toBe(race.filter((a) => a.status === 200).length);
    for (const a of race.filter((x) => x.status !== 200)) expect(asSeen(a)).toBe(MISS);
  });
});

describe("the cool-off and the owner's recovery", () => {
  it("a tripped bound holds to its window's end (review F1): the cool-off doesn't hand out a new allowance; attempts in it change nothing", async () => {
    const t0 = Date.now();
    for (let i = 0; i < PAIR_FAILS_PER_IP; i++) expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(1);
    expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(0); // the bound crossed at t0
    later(PAIR_COOL_OFF_MS);
    expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(0); // the old behavior gave a fresh window here
    vi.setSystemTime(new Date(t0 + PAIR_WINDOW_MS - 1000));
    expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(0);
    vi.setSystemTime(new Date(t0 + PAIR_WINDOW_MS));
    expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(1);
  });

  it("crossed near its window's end, the throttle lasts at least the cool-off", async () => {
    const t0 = Date.now();
    await redeem("ABCDEFGH", ip(1)); // opens the window
    vi.setSystemTime(new Date(t0 + PAIR_WINDOW_MS - 30_000));
    for (let i = 1; i < PAIR_FAILS_PER_IP; i++) await redeem("ABCDEFGH", ip(1));
    const crossedAt = Date.now();
    expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(0);
    vi.setSystemTime(new Date(crossedAt + PAIR_COOL_OFF_MS - 1000));
    expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(0);
    vi.setSystemTime(new Date(crossedAt + PAIR_COOL_OFF_MS));
    expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(1);
  });

  it("a sustained flood, tripping the bounds on purpose: at most 3 per client and 10 in all are evaluated per window (review F1)", async () => {
    const t0 = Date.now();
    const from = w.statements.length;
    let n = 0;
    const evaluatedFor: Record<string, number> = {};
    // Every 15 seconds for the whole window: a burst from one steady client, and a burst from fresh addresses.
    while (Date.now() < t0 + PAIR_WINDOW_MS) {
      for (let i = 0; i <= PAIR_FAILS_PER_IP; i++) evaluatedFor.steady = (evaluatedFor.steady ?? 0) + evaluated(await redeem("ABCDEFGH", ip(250)));
      for (let i = 0; i <= PAIR_FAILS_GLOBAL; i++) await redeem("ABCDEFGH", ip(++n % 240));
      later(15_000);
    }
    expect(w.statements.slice(from).filter((s) => /^update "native_pairings"/.test(s)).length).toBeLessThanOrEqual(PAIR_FAILS_GLOBAL);
    expect(evaluatedFor.steady).toBeLessThanOrEqual(PAIR_FAILS_PER_IP);
  });

  it("one client can't burn a live code in its life by waiting out cool-offs: the phone still pairs (review F1, P2)", async () => {
    const { code } = (await mint()).json;
    // Two rounds, a cool-off apart, inside the code's 5 minutes: the old behavior burned it (5/5 tries) in the second.
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i <= PAIR_FAILS_PER_IP; i++) await redeem(wrongOf(code), ip(7));
      later(PAIR_COOL_OFF_MS);
    }
    expect(await pairing()).toMatchObject({ tries: PAIR_FAILS_PER_IP, usedAt: null });
    expect(Date.now()).toBeLessThan(Date.parse((await pairing())!.expiresAt));
    expect((await redeem(code, ip(8))).status).toBe(200);
  });

  it("an attempt the global bound refuses doesn't count against its client (review F2, P3): the owner is evaluated the moment the global throttle ends", async () => {
    for (let i = 0; i <= PAIR_FAILS_GLOBAL; i++) await redeem("ABCDEFGH", ip(100 + i));
    later(PAIR_COOL_OFF_MS - 5_000);
    for (let i = 0; i <= PAIR_FAILS_PER_IP; i++) expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(0);
    const [global] = await w.db.select().from(nativePairLimits).where(eq(nativePairLimits.key, "redeem:global"));
    vi.setSystemTime(new Date(global!.blockedUntil!));
    expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(1);
  });

  it("while the global bound refuses, a new address writes nothing (review F3, P4)", async () => {
    for (let i = 0; i <= PAIR_FAILS_GLOBAL; i++) await redeem("ABCDEFGH", ip(i + 1));
    const before = (await w.db.select().from(nativePairLimits)).length;
    let writes = 0;
    for (let i = 0; i < 200; i++) writes += (await redeem("ABCDEFGH", `2001:db8:${(i + 1).toString(16)}::1`)).writes.length;
    expect(writes).toBe(0);
    expect((await w.db.select().from(nativePairLimits)).length).toBe(before);
  });

  it("a new code lifts every redeem throttle at once: Pair again on the laptop, and the phone pairs", async () => {
    const old = (await mint()).json.code;
    for (let i = 0; i < PAIR_FAILS_PER_IP; i++) await redeem(wrongOf(old), ip(1));
    for (let i = 10; i < 10 + PAIR_FAILS_GLOBAL; i++) await redeem("ABCDEFGH", ip(i));
    expect(evaluated(await redeem("ABCDEFGH", ip(1)))).toBe(0);
    const fresh = (await mint()).json.code;
    const phone = await redeem(fresh, ip(1));
    expect(phone.status, phone.text).toBe(200);
  });
});

describe("the client's key (review F3, F4)", () => {
  const clientKeys = async () => (await w.db.select().from(nativePairLimits).where(like(nativePairLimits.key, "redeem:ip:%"))).map((r) => r.key);

  it("an IPv6 client is its /64: every address in it shares one count, however it is written; the next /64 is another client", async () => {
    for (const a of ["2001:db8:1:2::a", "2001:0db8:0001:0002:0000:0000:0000:000b", "2001:DB8:1:2:ffff::c"]) expect(evaluated(await redeem("ABCDEFGH", a))).toBe(1);
    expect(evaluated(await redeem("ABCDEFGH", "2001:db8:1:2:1:2:3:4"))).toBe(0);
    expect(evaluated(await redeem("ABCDEFGH", "[2001:db8:1:2::9%en0]"))).toBe(0);
    expect(evaluated(await redeem("ABCDEFGH", "2001:db8:1:3::a"))).toBe(1);
    expect(await clientKeys()).toHaveLength(2);
  });

  it("an IPv4 address written as IPv4-mapped IPv6 is the same client", async () => {
    for (let i = 0; i < PAIR_FAILS_PER_IP; i++) await redeem("ABCDEFGH", ip(5));
    expect(evaluated(await redeem("ABCDEFGH", `::ffff:${ip(5)}`))).toBe(0);
  });

  it("is an HMAC under SESSION_SECRET: no unkeyed digest of the address is stored, and another secret makes another key", async () => {
    await redeem("ABCDEFGH", ip(1));
    const [key] = await clientKeys();
    for (const guess of [ip(1), `run-garden native pairing client v1\n${ip(1)}`]) expect(key).not.toContain(await sha256Hex(guess));
    await mint(); // lifts the throttles: the next attempt writes a fresh row
    await w.call("POST", "/api/native/pair", { cookie: false, body: { code: "ABCDEFGH", label: "x" }, headers: { "CF-Connecting-IP": ip(1) }, env: { SESSION_SECRET: "another-synthetic-secret" } });
    const [other] = await clientKeys();
    expect(other).toMatch(/^redeem:ip:[0-9a-f]{64}$/);
    expect(other).not.toBe(key);
  });
});

describe("mint: a few codes per account per window", () => {
  it("MINTS_PER_WINDOW codes, then 429 too_many_codes with when to try again; the live code stays; after the cool-off it mints", async () => {
    let last = "";
    for (let i = 0; i < MINTS_PER_WINDOW; i++) {
      const a = await mint();
      expect(a.status).toBe(200);
      last = a.json.code;
    }
    const before = await pairing();
    const refused = await mint();
    expect([refused.status, refused.json]).toEqual([429, { error: "too_many_codes", retryAfter: MINT_COOL_OFF_MS / 1000 }]);
    expect(await pairing()).toEqual(before);
    expect((await redeem(last, ip(1))).status).toBe(200);
    later(MINT_COOL_OFF_MS);
    expect((await mint()).status).toBe(200);
  });
});

describe("confirm: wrong check numbers revoke the pending phone", () => {
  async function pendingPhone() {
    const { code } = (await mint()).json;
    const { token, check } = (await redeem(code, ip(1))).json;
    return { token: token as string, check: check as string, id: await sha256Hex(token) };
  }
  const confirm = (id: string, check: string) => w.call("POST", `/api/native/devices/${id}/confirm`, { body: { check } });
  const otherThan = (check: string, n: number) => String((Number(check) + 1 + n) % 10_000).padStart(4, "0");
  const deviceOf = async (id: string) => (await w.db.select().from(nativeDevices).where(eq(nativeDevices.id, id)))[0]!;

  it("wrong numbers short of the bound leave it pending, and the right one then confirms it", async () => {
    const p = await pendingPhone();
    for (let i = 0; i < CONFIRM_MAX_WRONG - 1; i++) expect((await confirm(p.id, otherThan(p.check, i))).json).toEqual({ error: "check_mismatch" });
    expect(await deviceOf(p.id)).toMatchObject({ state: "pending", checkTries: CONFIRM_MAX_WRONG - 1 });
    expect((await confirm(p.id, p.check)).status).toBe(200);
    expect((await deviceOf(p.id)).state).toBe("active");
  });

  it("the bound's wrong number revokes it (check_failed): the right number then confirms nothing, and the phone is refused", async () => {
    const p = await pendingPhone();
    for (let i = 0; i < CONFIRM_MAX_WRONG - 1; i++) await confirm(p.id, otherThan(p.check, i));
    const last = await confirm(p.id, otherThan(p.check, CONFIRM_MAX_WRONG));
    expect([last.status, last.json]).toEqual([409, { error: "check_mismatch", revoked: true }]);
    expect(await deviceOf(p.id)).toMatchObject({ state: "revoked", revokedReason: "check_failed", revokedAt: nowInstant(), checkTries: CONFIRM_MAX_WRONG });
    expect((await confirm(p.id, p.check)).json).toEqual({ error: "not_pending" });
    expect((await w.call("GET", `/api/sessions/${slot}`, { bearer: p.token })).json).toEqual({ error: "device_revoked" });
  });

  it("a laptop can't be walked through the check numbers, even all at once: exactly the bound is evaluated, then it is revoked", async () => {
    const p = await pendingPhone();
    const walk = Array.from({ length: 40 }, (_, i) => otherThan(p.check, i));
    walk.splice(20, 0, p.check);
    const answers = await Promise.all(walk.map((c) => confirm(p.id, c)));
    const d = await deviceOf(p.id);
    expect(d.checkTries).toBeLessThanOrEqual(CONFIRM_MAX_WRONG);
    const confirmed = answers.filter((a) => a.status === 200).length;
    // At most the bound's numbers were tried before it was decided; the right one can only win among those.
    expect(answers.filter((a) => a.json.error === "check_mismatch").length + confirmed).toBeLessThanOrEqual(CONFIRM_MAX_WRONG);
    expect(d.state).toBe(confirmed === 1 ? "active" : "revoked");
    for (const a of answers.filter((x) => x.status !== 200 && x.json.error !== "check_mismatch")) expect(a.json).toEqual({ error: "not_pending" });
  });

  it("the owner's recovery after a revoked phone: Pair again, and the new phone confirms", async () => {
    const p = await pendingPhone();
    for (let i = 0; i < CONFIRM_MAX_WRONG; i++) await confirm(p.id, otherThan(p.check, i));
    expect((await deviceOf(p.id)).state).toBe("revoked");
    const again = await pendingPhone();
    expect((await confirm(again.id, again.check)).status).toBe(200);
    expect((await w.call("GET", `/api/sessions/${slot}`, { bearer: again.token })).status).toBe(200);
  });
});
