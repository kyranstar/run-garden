import { describe, expect, it } from "vitest";
import type { CorosClient } from "@rg/coros";
import { buildActivityBackfill } from "@rg/coros";

/** Minimal stand-in for the two CorosClient methods the backfill touches. */
function fakeClient(items: Array<Record<string, unknown>>): {
  client: CorosClient;
  detailCalls: string[];
} {
  const detailCalls: string[] = [];
  return {
    detailCalls,
    client: {
      async getActivities() {
        return items;
      },
      async getActivityDetail(labelId: string) {
        detailCalls.push(labelId);
        return { summary: { distance: 500000, workoutTime: 180000, avgHr: 140 } };
      },
    } as unknown as CorosClient,
  };
}

describe("buildActivityBackfill", () => {
  it("admits run, strength, yoga, bike, and swim — nothing dropped", async () => {
    const { client } = fakeClient([
      { labelId: "a", date: 20250101, sportType: 100, startTime: 1735732800 },
      { labelId: "b", date: 20250102, sportType: 402, startTime: 1735819200 },
      { labelId: "c", date: 20250103, sportType: 403, startTime: 1735905600 },
      { labelId: "d", date: 20250104, sportType: 200, startTime: 1735992000 }, // bike
      { labelId: "e", date: 20250105, sportType: 300, startTime: 1736078400 }, // swim
    ]);

    const chunk = await buildActivityBackfill(client, "2025-01-01", "2025-01-31", undefined, {
      delayMs: 0,
    });

    expect(chunk.activities.map((a) => a.sport).sort()).toEqual([
      "bike",
      "run",
      "strength",
      "swim",
      "yoga",
    ]);
    // Every code above is registry-named, so nothing is tallied as unnamed.
    expect(chunk.skippedSportTypes).toEqual({});
  });

  it("admits every sport type; unknown codes become 'other' and are tallied", async () => {
    const { client } = fakeClient([
      { labelId: "f", date: 20250106, sportType: 104, startTime: 1736164800 }, // hike
      { labelId: "g", date: 20250107, sportType: 31337, startTime: 1736251200 }, // unknown
    ]);

    const chunk = await buildActivityBackfill(client, "2026-01-01", "2026-01-31", undefined, {
      delayMs: 0,
    });

    expect(chunk.activities.map((a) => a.sport).sort()).toEqual(["hike", "other"]);
    expect(chunk.skippedSportTypes).toEqual({ "31337": 1 });
  });

  it("survives a detail fetch that throws, keeping the list-level activity", async () => {
    const client = {
      async getActivities() {
        return [
          {
            labelId: "a",
            date: 20250101,
            sportType: 100,
            startTime: 1735732800,
            workoutTime: 180000,
          },
        ];
      },
      async getActivityDetail() {
        throw new Error("coros 500");
      },
    } as unknown as CorosClient;

    const chunk = await buildActivityBackfill(client, "2025-01-01", "2025-01-31", undefined, {
      delayMs: 0,
    });

    expect(chunk.activities).toHaveLength(1);
    // Centiseconds on the wire → 1800s. The list-level fields alone still make
    // a usable activity when detail is unavailable.
    expect(chunk.activities[0]!.durationSeconds).toBe(1800);
  });

  it("fetches detail once per activity, including sport types the registry can't name", async () => {
    const { client, detailCalls } = fakeClient([
      { labelId: "a", date: 20250101, sportType: 100, startTime: 1735732800 },
      { labelId: "d", date: 20250104, sportType: 31337, startTime: 1735992000 },
    ]);

    await buildActivityBackfill(client, "2025-01-01", "2025-01-31", undefined, { delayMs: 0 });

    expect(detailCalls).toEqual(["a", "d"]);
  });
});
