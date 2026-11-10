/**
 * THE PHONE'S TWO READS, TRIMMED ON THE SERVER (SLICE-CONTRACT revision 2 §10.4). A device never gets `/api/auth/me`
 * or `/api/plan/today` (403, native-gate.test.ts); it gets these:
 *
 *  - `GET /api/native/me`: `{userId, device: {label, expiresAt}}` — no email, no connections, no restore state;
 *  - `GET /api/native/today`: the day's training rows, each `{id, title, sport, category, date, time, state}` — no sleep,
 *    readiness, coach text, garden, email or connections. Rest rows, removed rows and other days are not in it.
 *
 * The account is seeded with each of those things under a sentinel string, and the web's own reads are shown to carry
 * them, so their absence from the native reads is the trimming and not an empty account. The native reads don't even
 * read those tables. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant } from "@rg/domain";
import { authRoutes } from "../src/routes/auth.js";
import { nativeRoutes } from "../src/routes/native.js";
import { planRoutes } from "../src/routes/plan.js";
import { connectTestCoros, pinMiddayToday } from "./helpers.js";
import { nativeWorld, seedDevice, seedSlot, type NativeWorld } from "./native-fixture.js";

const { coachMessages, dailyHealth, plannedWorkouts, sleepRecords } = schema;

const SENTINELS = {
  coach: "SENTINEL-COACH-WORDS",
  focus: "SENTINEL-COACH-FOCUS",
};

let today: string;
let w: NativeWorld;
let rows: { lift: string; run: string };

beforeEach(async () => {
  today = pinMiddayToday();
  w = await nativeWorld([
    ["/api/native", nativeRoutes],
    ["/api/plan", planRoutes],
    ["/api/auth", authRoutes],
  ]);
  const now = nowInstant();
  // Everything the web's Today and me carry that the phone must not get.
  await connectTestCoros(w.db, w.userId);
  await w.db.insert(sleepRecords).values({ id: `${w.userId}:${today}`, userId: w.userId, date: today, durationSeconds: 25_217, contentFingerprint: "fp-sleep", updatedAt: now });
  await w.db.insert(dailyHealth).values({ id: `${w.userId}:${today}`, userId: w.userId, date: today, restingHeartRate: 47, hrv: 61, contentFingerprint: "fp-health", updatedAt: now } as never);
  await w.db.insert(coachMessages).values({ id: "m-1", userId: w.userId, role: "coach", body: SENTINELS.coach, refs: { focus: SENTINELS.focus }, at: now } as never);
  // The day's rows: two sessions, a rest row, one removed, one tomorrow.
  const lift = await seedSlot(w.db, w.userId, today);
  await w.db.update(plannedWorkouts).set({ title: "Strength A", category: "strength", sport: "strength", effectiveTime: "18:00" }).where(eq(plannedWorkouts.id, lift));
  const run = await seedSlot(w.db, w.userId, today);
  await w.db.update(plannedWorkouts).set({ title: "Easy run", category: "easy", sport: "run", effectiveTime: "07:30", completionState: "completed" }).where(eq(plannedWorkouts.id, run));
  const rest = await seedSlot(w.db, w.userId, today);
  await w.db.update(plannedWorkouts).set({ title: "Rest", category: "rest", sport: "rest" }).where(eq(plannedWorkouts.id, rest));
  const removed = await seedSlot(w.db, w.userId, today);
  await w.db.update(plannedWorkouts).set({ title: "Removed", archivedAt: now }).where(eq(plannedWorkouts.id, removed));
  await seedSlot(w.db, w.userId, addDays(today, 1));
  rows = { lift, run };
});
afterEach(() => vi.useRealTimers());

const FORBIDDEN_KEYS = ["email", "connections", "restore", "fixtureMode", "readiness", "sleep", "focus", "garden", "consistency", "sync", "upcoming", "nextWorkout", "watchReviews", "conditions"];
/** The tables a request's statements read or wrote, sorted. */
const tablesOf = (statements: string[]) =>
  [...new Set(statements.flatMap((s) => [...s.matchAll(/(?:from|join|update|into) "(\w+)"/g)].map((m) => m[1]!)))].sort();
/** Every key anywhere in a JSON value. */
const keysOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];

describe("the web's own reads carry what the phone's leave out (the seeds are real)", () => {
  it("/api/auth/me and /api/plan/today, by cookie, hold the email, connections, sleep, readiness and the garden", async () => {
    const me = await w.call("GET", "/api/auth/me");
    expect(me.json.email).toBe(w.email);
    expect(me.json.connections).toEqual([expect.objectContaining({ provider: "coros" })]);
    const plan = await w.call("GET", "/api/plan/today");
    expect(plan.status, plan.text).toBe(200);
    expect(plan.json.readiness.sleep).toEqual(expect.objectContaining({ durationSeconds: 25_217 }));
    expect(Object.keys(plan.json)).toEqual(expect.arrayContaining(["readiness", "garden", "focus", "sync", "consistency"]));
  });
});

describe("GET /api/native/me", () => {
  it("answers the device {userId, device: {label, expiresAt}} and nothing else", async () => {
    const { token } = await seedDevice(w.db, w.userId, { label: "Kitchen iPhone" });
    const [row] = await w.db.select().from(schema.nativeDevices);
    const a = await w.call("GET", "/api/native/me", { bearer: token });
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ userId: w.userId, device: { label: "Kitchen iPhone", expiresAt: row!.expiresAt } });
    expect(a.text).not.toContain(w.email);
    expect(keysOf(a.json).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
    // The device's own read (its account joined) and its last use: no connection, restore or account read besides.
    expect(tablesOf(a.statements)).toEqual(["native_devices", "users"]);
  });

  it("answers a cookie with no device", async () => {
    expect((await w.call("GET", "/api/native/me")).json).toEqual({ userId: w.userId, device: null });
  });

  it("expiresAt is all the phone needs for its 7-day warning: the exact instant its token stops working", async () => {
    const expiresAt = new Date(Date.now() + 6 * 86_400_000).toISOString();
    const { token } = await seedDevice(w.db, w.userId, { expiresAt });
    expect((await w.call("GET", "/api/native/me", { bearer: token })).json.device.expiresAt).toBe(expiresAt);
    vi.setSystemTime(new Date(Date.parse(expiresAt) - 1000));
    expect((await w.call("GET", "/api/native/me", { bearer: token })).status).toBe(200);
    vi.setSystemTime(new Date(expiresAt));
    expect((await w.call("GET", "/api/native/me", { bearer: token })).json).toEqual({ error: "device_expired" });
  });
});

describe("GET /api/native/today", () => {
  it("answers only the day's training rows, each id, title, sport, category, date, time and state; timed rows by time", async () => {
    const { token } = await seedDevice(w.db, w.userId);
    const a = await w.call("GET", "/api/native/today", { bearer: token });
    expect(a.status, a.text).toBe(200);
    expect(a.json).toEqual({
      today,
      sessions: [
        { id: rows.run, title: "Easy run", sport: "run", category: "easy", date: today, time: "07:30", state: "completed" },
        { id: rows.lift, title: "Strength A", sport: "strength", category: "strength", date: today, time: "18:00", state: "scheduled" },
      ],
    });
  });

  it("carries no sleep, readiness, coach text, garden, email or connections — and never reads them", async () => {
    const { token } = await seedDevice(w.db, w.userId);
    const a = await w.call("GET", "/api/native/today", { bearer: token });
    expect(keysOf(a.json).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
    for (const s of [w.email, SENTINELS.coach, SENTINELS.focus, "25217", "coros", "Rest", "Removed"]) expect(a.text, s).not.toContain(s);
    expect(tablesOf(a.statements)).toEqual(["native_devices", "planned_workouts", "user_preferences", "users"]);
  });

  it("answers a cookie the same rows", async () => {
    const { token } = await seedDevice(w.db, w.userId);
    expect((await w.call("GET", "/api/native/today")).json).toEqual((await w.call("GET", "/api/native/today", { bearer: token })).json);
  });
});
