/**
 * THE LIFEOS QA ACCOUNT (services/qa-account.ts): who it is, the guard that keeps every write on it and never on the owner,
 * its fixtures, its run tokens, and its purge — everything gone, checked table by table, and the owner's account untouched
 * row for row. On the repo's migrations, D1's bind cap on, the clock held at midday. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant } from "@rg/domain";
import { tableHashes } from "../src/services/parity.js";
import { ACCOUNT_TABLES } from "../src/services/account-tables.js";
import { loadPreferences, savePreferences } from "../src/services/calendar-sync.js";
import {
  createQaUser,
  HARNESS_TOKEN_MAX_MS,
  isQaEmail,
  mintQaPairing,
  purgeQa,
  QA_EMAIL,
  qaHarnessToken,
  qaPlanToken,
  qaPlanTokenAccount,
  qaPossible,
  qaRowCounts,
  qaTimes,
  qaUserIdOf,
  purgeQa as purge,
  QaAlreadySeededError,
  QaExistsError,
  QaGuardError,
  resolveQaTarget,
  seedQaFixtures,
  verifyHarnessToken,
  type QaTarget,
} from "../src/services/qa-account.js";
import { seedFullAccount } from "./account-fixture.js";
import { makeTestDb, makeTestUser, pinMiddayToday } from "./helpers.js";
import { nativeEnv, seedDevice } from "./native-fixture.js";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";

const { nativeDevices, nativePairings, nativePairLimits, plannedWorkouts, providerConnections, users } = schema;

let db: Db;
let ownerId: string;
let env: Env;
let today: string;

beforeEach(async () => {
  today = pinMiddayToday();
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId: ownerId } = await makeTestUser(db, { timezone: "America/Los_Angeles" }));
  const [owner] = await db.select().from(users).where(eq(users.id, ownerId));
  env = nativeEnv({ ALLOWED_GOOGLE_EMAIL: owner!.email });
});
afterEach(() => vi.useRealTimers());

/** A target made by hand around any id — what no caller can do, to show the writes refuse it anyway. */
const forged = (userId: string) => ({ userId }) as QaTarget;

describe("who the QA account is", () => {
  it("is lifeos-qa@invalid, only where the owner's own address is something else", () => {
    expect(QA_EMAIL).toBe("lifeos-qa@invalid");
    expect(qaPossible(env)).toBe(true);
    expect(qaPossible({ ALLOWED_GOOGLE_EMAIL: "" })).toBe(false);
    expect(qaPossible({ ALLOWED_GOOGLE_EMAIL: " LifeOS-QA@invalid " })).toBe(false);
    expect(isQaEmail("lifeos-qa@invalid", env)).toBe(true);
    expect(isQaEmail(" LIFEOS-QA@INVALID", env)).toBe(true);
    expect(isQaEmail("lifeos-qa@invalid", { ALLOWED_GOOGLE_EMAIL: "lifeos-qa@invalid" })).toBe(false);
    expect(isQaEmail(env.ALLOWED_GOOGLE_EMAIL, env)).toBe(false);
  });

  it("is made with no Google identity, no provider, AI and COROS writes off, no calendar, on the owner's timezone", async () => {
    await savePreferences(db, ownerId, { ...(await loadPreferences(db, ownerId)), timezone: "America/New_York", calendarId: "owner-cal", corosWritesEnabled: true });
    const qa = await createQaUser(db, env, ownerId);
    const [row] = await db.select().from(users).where(eq(users.id, qa.userId));
    expect(row).toMatchObject({ email: QA_EMAIL, name: "LifeOS QA", googleSub: null });
    const prefs = await loadPreferences(db, qa.userId);
    expect(prefs).toMatchObject({ timezone: "America/New_York", aiEnabled: false, corosWritesEnabled: false, calendarId: null });
    expect(await db.select().from(providerConnections).where(eq(providerConnections.userId, qa.userId))).toEqual([]);
    expect(await qaUserIdOf(db)).toBe(qa.userId);
  });

  it("is made once: a second is QaExistsError", async () => {
    await createQaUser(db, env, ownerId);
    await expect(createQaUser(db, env, ownerId)).rejects.toBeInstanceOf(QaExistsError);
    expect(await db.select().from(users).where(eq(users.email, QA_EMAIL))).toHaveLength(1);
  });

  it("resolves to null with none, to its own id with one, and refuses to resolve to the caller's own account", async () => {
    expect(await resolveQaTarget(db, env, ownerId)).toBeNull();
    const qa = await createQaUser(db, env, ownerId);
    expect((await resolveQaTarget(db, env, ownerId))?.userId).toBe(qa.userId);
    expect(qa.userId).not.toBe(ownerId);
    await expect(resolveQaTarget(db, env, qa.userId)).rejects.toMatchObject({ code: "qa_is_owner" });
    await expect(resolveQaTarget(db, { ALLOWED_GOOGLE_EMAIL: QA_EMAIL }, ownerId)).rejects.toMatchObject({ code: "qa_impossible" });
  });
});

describe("the guard: every write re-reads its target, and the owner's account is never one", () => {
  it("seed, mint and purge refuse a target that names the owner's account, and write nothing", async () => {
    await seedFullAccount(db, ownerId);
    const before = await tableHashes(db, ownerId);
    const owner = forged(ownerId);
    await expect(seedQaFixtures(db, env, owner)).rejects.toMatchObject({ code: "not_qa" });
    await expect(mintQaPairing(db, env, owner)).rejects.toMatchObject({ code: "not_qa" });
    await expect(purgeQa(db, env, owner)).rejects.toMatchObject({ code: "not_qa" });
    expect(await tableHashes(db, ownerId)).toEqual(before);
    expect(await db.select().from(nativePairings)).toEqual([]);
    expect(await db.select().from(users).where(eq(users.id, ownerId))).toHaveLength(1);
  });

  it("…and a target naming any other account, or no account", async () => {
    const { userId: other } = await makeTestUser(db);
    for (const id of [other, "no-such-account"]) {
      await expect(purgeQa(db, env, forged(id))).rejects.toBeInstanceOf(QaGuardError);
      await expect(seedQaFixtures(db, env, forged(id))).rejects.toBeInstanceOf(QaGuardError);
    }
    expect(await db.select().from(users).where(eq(users.id, other))).toHaveLength(1);
  });

  it("…and the QA account's own target once the owner's address became the QA address (no QA account then)", async () => {
    const qa = await createQaUser(db, env, ownerId);
    await expect(purgeQa(db, { ALLOWED_GOOGLE_EMAIL: QA_EMAIL }, qa)).rejects.toMatchObject({ code: "qa_impossible" });
    expect(await qaUserIdOf(db)).toBe(qa.userId);
  });
});

describe("the fixtures", () => {
  it("today: a document workout, a programme slot and a run, all titled QA, later today; tomorrow a document workout and the next slot", async () => {
    const qa = await createQaUser(db, env, ownerId);
    const seeded = await seedQaFixtures(db, env, qa);
    expect(seeded.today).toBe(today);
    expect(seeded.tomorrow).toBe(addDays(today, 1));
    const [t1, t2, t3] = qaTimes(nowInstant(), "America/Los_Angeles");
    // Midday held (12:00 PDT / 11:00 PST): the next three whole hours.
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "America/Los_Angeles" }).format(new Date()));
    expect([t1, t2, t3]).toEqual([hour + 1, hour + 2, hour + 3].map((h) => `${h}:00`));
    expect(seeded.fixtures.filter((f) => f.date === today).map((f) => f.time)).toEqual([t1, t2, t3]);
    expect(seeded.fixtures.map((f) => [f.title, f.date, f.kind])).toEqual([
      ["QA Hips and back", today, "document"],
      ["QA Mobility", today, "programme_slot"],
      ["QA Mobility", addDays(today, 1), "programme_slot"],
      ["QA Easy run", today, "run"],
      ["QA Core reset", addDays(today, 1), "document"],
    ]);
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, qa.userId));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.title.startsWith("QA ") && r.archivedAt === null && r.completionState === "scheduled")).toBe(true);
    const hips = rows.find((r) => r.title === "QA Hips and back")!;
    expect([hips.effectiveDate, hips.effectiveTime, hips.workoutDocRev, hips.origin]).toEqual([today, seeded.fixtures[0]!.time, 1, "studio"]);
    const run = rows.find((r) => r.title === "QA Easy run")!;
    expect([run.sport, run.origin, run.effectiveTime]).toEqual(["run", null, seeded.fixtures[3]!.time]);
    // The owner's plan holds none of them.
    expect(await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, ownerId))).toEqual([]);
  });

  it("are seeded once: a second seed is QaAlreadySeededError and adds nothing", async () => {
    const qa = await createQaUser(db, env, ownerId);
    await seedQaFixtures(db, env, qa);
    await expect(seedQaFixtures(db, env, qa)).rejects.toBeInstanceOf(QaAlreadySeededError);
    expect(await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, qa.userId))).toHaveLength(5);
  });

  it("keep today's times between 06:00 and 21:00 on the account's clock", () => {
    expect(qaTimes("2026-11-18T03:30:00.000Z", "UTC")).toEqual(["06:00", "06:00", "06:00"]);
    expect(qaTimes("2026-11-18T19:10:00.000Z", "UTC")).toEqual(["20:00", "21:00", "21:00"]);
    expect(qaTimes("2026-11-18T19:10:00.000Z", "America/New_York")).toEqual(["15:00", "16:00", "17:00"]);
  });
});

describe("the run's tokens", () => {
  it("the plan token is 64 hex, bound to the QA account, and names it only while it exists", async () => {
    const qa = await createQaUser(db, env, ownerId);
    const token = await qaPlanToken(env, qa.userId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await qaPlanTokenAccount(db, env, token)).toBe(qa.userId);
    expect(await qaPlanTokenAccount(db, env, await qaPlanToken(env, ownerId))).toBeNull();
    expect(await qaPlanTokenAccount(db, env, token.replace(/.$/, (c) => (c === "0" ? "1" : "0")))).toBeNull();
    expect(await qaPlanTokenAccount(db, { ...env, SESSION_SECRET: "another" }, token)).toBeNull();
    await purge(db, env, qa);
    expect(await qaPlanTokenAccount(db, env, token)).toBeNull();
  });

  it("the harness token carries its account and expiry, and is refused expired, too long, altered or under another secret", async () => {
    const qa = await createQaUser(db, env, ownerId);
    const now = Date.now();
    const token = await qaHarnessToken(env, qa.userId, now + 60_000);
    expect(token).toMatch(/^rgq_[0-9a-f-]{36}_\d{10}_[0-9a-f]{64}$/);
    expect(await verifyHarnessToken(env, token, now)).toBe(qa.userId);
    expect(await verifyHarnessToken(env, token, now + 61_000)).toBeNull();
    expect(await verifyHarnessToken(env, await qaHarnessToken(env, qa.userId, now + HARNESS_TOKEN_MAX_MS + 3_600_000), now)).toBeNull();
    expect(await verifyHarnessToken(env, token.replace(qa.userId, ownerId), now)).toBeNull();
    expect(await verifyHarnessToken({ ...env, SESSION_SECRET: "another" }, token, now)).toBeNull();
    expect(await verifyHarnessToken({ ...env, ALLOWED_GOOGLE_EMAIL: QA_EMAIL }, token, now)).toBeNull();
  });

  it("the mint answers a code and both tokens, and counts against the QA account's own mint bound", async () => {
    const qa = await createQaUser(db, env, ownerId);
    const minted = await mintQaPairing(db, env, qa);
    if ("refused" in minted) throw new Error("refused");
    expect(minted).toMatchObject({ code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{8}$/), scope: "training-v3", planToken: await qaPlanToken(env, qa.userId) });
    expect(await verifyHarnessToken(env, minted.harnessToken)).toBe(qa.userId);
    for (let i = 0; i < 4; i++) await mintQaPairing(db, env, qa);
    expect(await mintQaPairing(db, env, qa)).toMatchObject({ refused: true });
    expect((await db.select().from(nativePairLimits).where(eq(nativePairLimits.key, `mint:${ownerId}`)))).toEqual([]);
  });
});

describe("the purge", () => {
  it("removes every row the QA account holds in every table, checks each is zero, and leaves the owner's account row for row", async () => {
    await seedFullAccount(db, ownerId);
    const qa = await createQaUser(db, env, ownerId);
    await seedFullAccount(db, qa.userId);
    await seedQaFixtures(db, env, qa).catch(() => undefined); // already holds plan rows: the full seed is the harder case
    await seedDevice(db, qa.userId, { scope: "training-v3" });
    await seedDevice(db, ownerId, { scope: "training-v2" });
    await mintQaPairing(db, env, qa);
    const ownerBefore = await tableHashes(db, ownerId);
    const ownerDevices = await db.select().from(nativeDevices).where(eq(nativeDevices.userId, ownerId));
    const held = await qaRowCounts(db, qa.userId);
    // Every user and child table of the registry holds QA rows before (the full seed), and the sign-ins too.
    for (const t of ACCOUNT_TABLES) if (t.scope.kind === "user" || t.scope.kind === "child") expect(held[t.name] ?? 0, t.name).toBeGreaterThan(0);
    expect(held).toMatchObject({ users: 1, native_devices: 1, native_pairings: 1, "native_pair_limits": 1 });

    const done = await purgeQa(db, env, qa);
    expect(done.total).toBe(0);
    expect(Object.values(done.remaining).every((n) => n === 0)).toBe(true);
    expect(Object.keys(done.remaining).sort()).toEqual(
      [...ACCOUNT_TABLES.filter((t) => t.scope.kind !== "excluded").map((t) => t.name), "sessions", "native_devices", "native_pairings", "native_pair_limits", "account_state"].sort(),
    );
    expect(done.removed).toEqual(held);
    expect(await qaRowCounts(db, qa.userId)).toEqual({});
    expect(await qaUserIdOf(db)).toBeNull();
    // The owner's: every table's hash as it was, and the paired phone.
    expect(await tableHashes(db, ownerId)).toEqual(ownerBefore);
    expect(await db.select().from(nativeDevices).where(eq(nativeDevices.userId, ownerId))).toEqual(ownerDevices);
  });

  it("leaves no QA child row behind even when its parent went first (checked by the ids the parent held)", async () => {
    const qa = await createQaUser(db, env, ownerId);
    await seedQaFixtures(db, env, qa);
    const minted = await mintQaPairing(db, env, qa);
    expect("code" in minted).toBe(true);
    const done = await purgeQa(db, env, qa);
    expect(done.removed.planned_workouts).toBe(5);
    expect(done.removed.schedule_overrides ?? 0).toBeGreaterThan(0);
    expect(done.total).toBe(0);
  });

  it("then a new QA account starts empty, and the old account's tokens name nothing", async () => {
    const qa = await createQaUser(db, env, ownerId);
    const minted = await mintQaPairing(db, env, qa);
    if ("refused" in minted) throw new Error("refused");
    await purgeQa(db, env, qa);
    const again = await createQaUser(db, env, ownerId);
    expect(again.userId).not.toBe(qa.userId);
    expect(await qaRowCounts(db, again.userId)).toEqual({ users: 1, user_preferences: 1 });
    expect(await qaPlanTokenAccount(db, env, minted.planToken)).toBeNull();
    expect(await verifyHarnessToken(env, minted.harnessToken)).toBe(qa.userId); // genuine, but its account is gone
  });
});
