/**
 * PAIRING THE QA PHONE (the phone QA harness, kit v0.16; services/qa-account.ts, auth/native-devices.ts): a code minted
 * for the QA account pairs a phone to the QA account, active at once, at the pairing scope — and never touches the owner's
 * code, pairing or devices. With no QA account, the owner's pairing is exactly what it was. A QA device signs in as the QA
 * account and reads only its rows; any other non-owner account's device is still refused. Through the real route modules
 * on the repo's migrations, D1's bind cap on, the clock held at midday. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { sha256Hex } from "../src/auth/crypto.js";
import { checkNumberOf } from "../src/auth/native-devices.js";
import { nativeRoutes } from "../src/routes/native.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createQaUser, mintQaPairing, QA_EMAIL, seedQaFixtures, type QaTarget } from "../src/services/qa-account.js";
import { makeTestUser, pinMiddayToday } from "./helpers.js";
import { nativeWorld, seedDevice, seedSlot, type NativeWorld } from "./native-fixture.js";

const { nativeDevices, nativePairings, nativePairLimits, users } = schema;
const DAY = 86_400_000;
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

let today: string;
let w: NativeWorld;

beforeEach(async () => {
  today = pinMiddayToday();
  w = await nativeWorld([
    ["/api/native", nativeRoutes],
    ["/api/sessions", sessionRoutes],
  ]);
});
afterEach(() => vi.useRealTimers());

const mint = () => w.call("POST", "/api/native/pairings", { body: {} });
const redeem = (code: string, label = "QA phone") => w.call("POST", "/api/native/pair", { cookie: false, body: { code, label } });
const pairingOf = async (userId: string) => (await w.db.select().from(nativePairings).where(eq(nativePairings.userId, userId)))[0];
const wrongOf = (code: string) => `${code[0] === "Z" ? "Y" : "Z"}${code.slice(1)}`;

async function qaAccount(): Promise<QaTarget> {
  return createQaUser(w.db, w.env, w.userId);
}
async function qaCode(target: QaTarget): Promise<string> {
  const minted = await mintQaPairing(w.db, w.env, target, { tokens: false });
  if ("refused" in minted) throw new Error("refused");
  return minted.code;
}
/** The state of the QA account's phone that `token` names, or null. */
async function qaPhoneState(target: QaTarget, token: string): Promise<string | null> {
  const [row] = await w.db.select().from(nativeDevices).where(eq(nativeDevices.id, await sha256Hex(token)));
  return row && row.userId === target.userId ? row.state : null;
}

describe("the QA account's code", () => {
  it("pairs a phone to the QA account, active at once at the pairing scope, with its check number", async () => {
    const qa = await qaAccount();
    const code = await qaCode(qa);
    const a = await redeem(code, "LifeOS QA phone");
    expect(a.status, a.text).toBe(200);
    // The wire answer is the owner's own shape (LifeOS takes no other): pending, until its first `/me`.
    expect(a.json).toEqual({ token: expect.stringMatching(/^rgd_[A-Za-z0-9_-]{43}$/), check: expect.stringMatching(/^\d{4}$/), state: "pending", confirmBy: later(10 * 60_000) });
    expect(a.json.check).toBe(await checkNumberOf(await sha256Hex(a.json.token)));
    const id = await sha256Hex(a.json.token);
    expect(await w.db.select().from(nativeDevices)).toEqual([
      expect.objectContaining({ id, userId: qa.userId, scope: "training-v5", label: "LifeOS QA phone", state: "active", confirmedAt: nowInstant(), expiresAt: later(30 * DAY) }),
    ]);
    expect((await pairingOf(qa.userId))?.usedAt).toBe(nowInstant());
    // Its token signs in as the QA account, at once (no Confirm), and says so — on the QA account's clock, the owner's zone.
    const me = await w.call("GET", "/api/native/me", { bearer: a.json.token });
    expect([me.status, me.json]).toEqual([200, { userId: qa.userId, timezone: "America/Los_Angeles", device: { label: "LifeOS QA phone", expiresAt: later(30 * DAY), scope: "training-v5" } }]);
  });

  it("reads only the QA account's day: its fixtures, never the owner's sessions", async () => {
    await seedSlot(w.db, w.userId, today);
    const qa = await qaAccount();
    const seeded = await seedQaFixtures(w.db, w.env, qa);
    const { token } = (await redeem(await qaCode(qa))).json;
    const day = await w.call("GET", "/api/native/today", { bearer: token });
    expect(day.status, day.text).toBe(200);
    expect(day.json.today).toBe(today);
    const ids = day.json.sessions.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual(seeded.fixtures.filter((f) => f.date === today).map((f) => f.id).sort());
    expect(day.json.sessions.every((s: { title: string }) => s.title.startsWith("QA "))).toBe(true);
  });

  it("never counts a try at the owner's live code, and the owner's code still pairs the owner (pending)", async () => {
    const qa = await qaAccount();
    const ownerCode = (await mint()).json.code as string;
    const code = await qaCode(qa);
    expect(await qaPhoneState(qa, (await redeem(code)).json.token)).toBe("active");
    expect((await pairingOf(w.userId))).toMatchObject({ tries: 0, usedAt: null });
    const owner = await redeem(ownerCode, "Running phone");
    expect([owner.status, owner.json.state]).toEqual([200, "pending"]);
    const ownerDevice = (await w.db.select().from(nativeDevices).where(eq(nativeDevices.userId, w.userId)))[0];
    expect(ownerDevice).toMatchObject({ state: "pending", label: "Running phone" });
  });

  it("a wrong code counts its try at the owner's code only, as before; the QA code is untouched and still pairs", async () => {
    const qa = await qaAccount();
    const ownerCode = (await mint()).json.code as string;
    const code = await qaCode(qa);
    expect((await redeem(wrongOf(ownerCode))).status).toBe(401);
    expect((await pairingOf(w.userId))?.tries).toBe(1);
    expect(await pairingOf(qa.userId)).toMatchObject({ tries: 0, usedAt: null });
    expect(await qaPhoneState(qa, (await redeem(code)).json.token)).toBe("active");
  });

  it("is used once: a second redemption of it is 401 pair_failed and makes no device", async () => {
    const qa = await qaAccount();
    const code = await qaCode(qa);
    expect((await redeem(code)).status).toBe(200);
    const again = await redeem(code);
    expect([again.status, again.json]).toEqual([401, { error: "pair_failed" }]);
    expect(await w.db.select().from(nativeDevices)).toHaveLength(1);
  });

  it("expires with its 5 minutes, as the owner's does", async () => {
    const qa = await qaAccount();
    const code = await qaCode(qa);
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000 + 1));
    expect((await redeem(code)).status).toBe(401);
    expect(await w.db.select().from(nativeDevices)).toEqual([]);
  });

  it("minting it leaves the redeem throttles as they are (only the owner's own Pair lifts them)", async () => {
    const qa = await qaAccount();
    await w.db.insert(nativePairLimits).values({ key: "redeem:global", windowStart: nowInstant(), count: 11, blockedUntil: later(60_000), expiresAt: later(600_000) });
    await qaCode(qa);
    expect((await w.db.select().from(nativePairLimits).where(eq(nativePairLimits.key, "redeem:global")))[0]?.blockedUntil).toBe(later(60_000));
    await mint();
    expect(await w.db.select().from(nativePairLimits).where(eq(nativePairLimits.key, "redeem:global"))).toEqual([]);
  });

  it("with no QA account, the owner's redemption reads one account row and pairs pending, as before", async () => {
    const { code } = (await mint()).json;
    const a = await redeem(code);
    expect([a.status, a.json.state]).toEqual([200, "pending"]);
    expect(a.statements.filter((s) => /from "users"/.test(s))).toHaveLength(1);
    expect(a.writes.filter((s) => /native_pairings/.test(s))).toHaveLength(1);
  });
});

describe("signing in with a device", () => {
  it("a device of the QA account signs in as the QA account", async () => {
    const qa = await qaAccount();
    const { token } = await seedDevice(w.db, qa.userId, { scope: "training-v3" });
    const me = await w.call("GET", "/api/native/me", { bearer: token });
    expect([me.status, me.json.userId]).toEqual([200, qa.userId]);
  });

  it("a device of any other account is still 401 unauthenticated", async () => {
    await qaAccount();
    const { userId: other } = await makeTestUser(w.db);
    const { token } = await seedDevice(w.db, other);
    const me = await w.call("GET", "/api/native/me", { bearer: token });
    expect([me.status, me.json]).toEqual([401, { error: "unauthenticated" }]);
  });

  it("a QA-addressed account's device is refused where the owner's own address is the QA address", async () => {
    const [qaRow] = await w.db.insert(users).values({ id: "qa-id", email: QA_EMAIL, name: null, googleSub: null, createdAt: nowInstant() }).returning();
    const { token } = await seedDevice(w.db, qaRow!.id);
    const me = await w.call("GET", "/api/native/me", { bearer: token, env: { ALLOWED_GOOGLE_EMAIL: "" } });
    expect(me.status).toBe(401);
  });
});
