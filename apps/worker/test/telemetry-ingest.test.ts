/**
 * Telemetry through the ingest path (effort-analysis spec §2): the JSON
 * column round-trips, lap columns land, and the fingerprint-match skip still
 * short-circuits unchanged snapshots.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { SourceActivity } from "@rg/domain";
import { ingestActivities } from "../src/services/completion.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const TELEMETRY = {
  avgCadenceSpm: 152,
  avgPowerWatts: 160,
  aerobicEffect: 2.9,
  weatherTempC: 25.5,
  humidityPercent: 59,
  feelRating: 4,
  hrZones: [{ lo: 138, hi: 155, seconds: 492 }],
};

function src(overrides: Partial<SourceActivity> = {}): SourceActivity {
  return {
    provider: "coros",
    providerActivityId: "tele-1",
    startTime: "2026-08-06T12:08:02Z",
    startTimeLocal: "2026-08-06T05:08:02",
    sport: "run",
    durationSeconds: 4038,
    distanceMeters: 9489,
    avgHeartRate: 153,
    telemetry: TELEMETRY,
    contentFingerprint: "fp-v2-1",
    ...overrides,
  };
}

describe("telemetry ingest", () => {
  it("stores telemetry JSON and lap telemetry columns", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await ingestActivities(db, {
      userId,
      sources: [src()],
      lapsByProviderId: {
        "tele-1": [
          {
            lapIndex: 1,
            durationSeconds: 300,
            distanceMeters: 530,
            avgHeartRate: 133,
            avgPaceSecPerKm: 566,
            splitType: "workout",
            avgCadenceSpm: 143,
            minHeartRate: 112,
            maxHeartRate: 148,
            elevGainMeters: 26,
            avgGradePercent: 3,
            avgPowerWatts: 152,
          },
        ],
      },
    });

    const rows = await db.select().from(schema.activities);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.telemetry).toEqual(TELEMETRY);

    const laps = await db
      .select()
      .from(schema.activityLaps)
      .where(eq(schema.activityLaps.activityId, rows[0]!.id));
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({
      avgCadenceSpm: 143,
      minHeartRate: 112,
      maxHeartRate: 148,
      elevGainMeters: 26,
      avgGradePercent: 3,
      avgPowerWatts: 152,
      exerciseNameKey: null,
    });
  });

  it("refreshes telemetry when the fingerprint changes, skips when unchanged", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await ingestActivities(db, { userId, sources: [src({ telemetry: undefined })] });
    let row = (await db.select().from(schema.activities))[0]!;
    expect(row.telemetry).toBeNull();

    // Same fingerprint → skip (telemetry must NOT appear).
    await ingestActivities(db, { userId, sources: [src()] });
    row = (await db.select().from(schema.activities))[0]!;
    expect(row.telemetry).toBeNull();

    // Fingerprint salt bump (v1→v2 in the wild) → refresh lands telemetry.
    await ingestActivities(db, { userId, sources: [src({ contentFingerprint: "fp-v2-2" })] });
    row = (await db.select().from(schema.activities))[0]!;
    expect(row.telemetry).toEqual(TELEMETRY);
  });
});
