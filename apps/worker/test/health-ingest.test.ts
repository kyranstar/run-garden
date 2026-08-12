/**
 * `ingestDailyHealth`'s per-column null-guard: a watch that missed one
 * metric last night must not wipe the previously stored good value, while
 * fields that actually arrived update normally. Ported from the retired
 * device-route tests (Phase C) — the guard now serves the cloud pull.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant } from "@rg/domain";
import { ingestDailyHealth } from "../src/services/health-ingest.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

describe("ingestDailyHealth null-guard", () => {
  it("a null field keeps the stored value; a present field updates", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const date = "2026-07-01";
    await db.insert(schema.dailyHealth).values({
      id: `${userId}:${date}`,
      userId,
      date,
      restingHeartRate: 48,
      hrv: 60,
      recoveryScore: null,
      fatigueScore: null,
      trainingLoad7d: null,
      provider: "coros",
      contentFingerprint: "seed-fingerprint",
      updatedAt: nowInstant(),
    });

    await ingestDailyHealth(db, userId, [{ date, restingHeartRate: null, hrv: 55 }]);

    const row = (
      await db.select().from(schema.dailyHealth).where(eq(schema.dailyHealth.id, `${userId}:${date}`))
    )[0]!;
    expect(row.restingHeartRate).toBe(48);
    expect(row.hrv).toBe(55);
  });

  it("the three score columns update on a real push and survive a null one", async () => {
    // A COALESCE typo on any of these three (arguments swapped, or one
    // column reading another's excluded value) is invisible to the test
    // above — pin each column through both halves.
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const date = "2026-07-02";
    await db.insert(schema.dailyHealth).values({
      id: `${userId}:${date}`,
      userId,
      date,
      restingHeartRate: null,
      hrv: null,
      recoveryScore: 10,
      fatigueScore: 20,
      trainingLoad7d: 30,
      provider: "coros",
      contentFingerprint: "seed-fingerprint",
      updatedAt: nowInstant(),
    });
    const rowNow = async () =>
      (await db.select().from(schema.dailyHealth).where(eq(schema.dailyHealth.id, `${userId}:${date}`)))[0]!;

    await ingestDailyHealth(db, userId, [
      { date, recoveryScore: 71, fatigueScore: 42, trainingLoad7d: 355 },
    ]);
    let row = await rowNow();
    expect(row.recoveryScore).toBe(71);
    expect(row.fatigueScore).toBe(42);
    expect(row.trainingLoad7d).toBe(355);

    await ingestDailyHealth(db, userId, [
      { date, recoveryScore: null, fatigueScore: null, trainingLoad7d: null },
    ]);
    row = await rowNow();
    expect(row.recoveryScore).toBe(71);
    expect(row.fatigueScore).toBe(42);
    expect(row.trainingLoad7d).toBe(355);
  });
});
