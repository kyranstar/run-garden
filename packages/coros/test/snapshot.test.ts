/**
 * Recovery-freshness guard of buildSnapshot (audit finding T1): the
 * dashboard's recoveryPct — a "now" value — lands only on COROS's latest
 * daily-health day, and only when that day is actually current (today or
 * yesterday in the user's timezone). The old guard compared against rangeEnd,
 * which live callers set in the FUTURE (schedule-ahead reads), so recovery
 * was never stamped in production.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { addDays } from "@rg/domain";
import { CorosClient, type CorosExerciseCatalogItem } from "../src/client.js";
import { buildSnapshot, catalogExercise } from "../src/snapshot.js";
import { mockCorosServer } from "./mock-coros-server.js";

const noop = (): void => undefined;
const BASE_MONDAY = "2026-08-03";
const TODAY = "2026-08-05"; // fixed: buildSnapshot never reads the wall clock

const corosDay = (iso: string): number => Number(iso.replaceAll("-", ""));

/** Mock server + logged-in client, with dayList pinned to the given dates. */
async function setup(healthDates: string[]) {
  const server = mockCorosServer({ baseMonday: BASE_MONDAY });
  server.state.dayList = healthDates.map((date, i) => ({
    happenDay: corosDay(date),
    rhr: 47 + i,
    t7d: 320,
    tiredRateNew: 28,
    avgSleepHrv: 72,
  }));
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.loginWithHash(
    server.email,
    createHash("md5").update(server.password, "utf8").digest("hex"),
  );
  return { server, client };
}

const RANGE_START = addDays(TODAY, -14);

function snapshotFor(client: CorosClient, rangeEnd: string) {
  return buildSnapshot(client, RANGE_START, rangeEnd, TODAY, undefined);
}

describe("buildSnapshot recovery stamping", () => {
  it("stamps the dashboard recoveryPct when the latest health day is today", async () => {
    const { client } = await setup([addDays(TODAY, -1), TODAY]);
    const snapshot = await snapshotFor(client, addDays(TODAY, 7));
    const byDate = new Map(snapshot.health.map((h) => [h.date, h]));
    expect(byDate.get(TODAY)?.recoveryScore).toBe(88); // mock dashboard value
    expect(byDate.get(addDays(TODAY, -1))?.recoveryScore).toBeUndefined();
  });

  it("stamps when the latest health day is yesterday (COROS can lag a day)", async () => {
    const { client } = await setup([addDays(TODAY, -2), addDays(TODAY, -1)]);
    const snapshot = await snapshotFor(client, addDays(TODAY, 7));
    const byDate = new Map(snapshot.health.map((h) => [h.date, h]));
    expect(byDate.get(addDays(TODAY, -1))?.recoveryScore).toBe(88);
    expect(byDate.get(addDays(TODAY, -2))?.recoveryScore).toBeUndefined();
  });

  it("never stamps a stale latest day (5 days ago) as current recovery", async () => {
    const { client } = await setup([addDays(TODAY, -6), addDays(TODAY, -5)]);
    const snapshot = await snapshotFor(client, addDays(TODAY, 7));
    expect(snapshot.health).toHaveLength(2);
    for (const h of snapshot.health) expect(h.recoveryScore).toBeUndefined();
  });

  it("stamps a latest day sitting ahead of the user's today (COROS zone skew)", async () => {
    const { client } = await setup([TODAY, addDays(TODAY, 1)]);
    const snapshot = await snapshotFor(client, addDays(TODAY, 7));
    const byDate = new Map(snapshot.health.map((h) => [h.date, h]));
    expect(byDate.get(addDays(TODAY, 1))?.recoveryScore).toBe(88);
    expect(byDate.get(TODAY)?.recoveryScore).toBeUndefined();
  });

  it("PROD REPRO: future rangeEnd (schedule-ahead and full-schedule reads) still stamps today", async () => {
    // The live caller's two shapes: rangeEnd = today+7, or rangeStart+89.
    // Both end in the future; the old rangeEnd-equality guard matched neither,
    // so 0 of 73 production daily_health rows ever got a recovery_score.
    for (const rangeEnd of [addDays(TODAY, 7), addDays(RANGE_START, 89)]) {
      const { client } = await setup([addDays(TODAY, -1), TODAY]);
      const snapshot = await snapshotFor(client, rangeEnd);
      const todayRow = snapshot.health.find((h) => h.date === TODAY);
      expect(todayRow?.recoveryScore).toBe(88);
    }
  });
});

describe("sleep-HRV band + full-recovery mapping (0020)", () => {
  it("maps per-day sleepHrvSd from the dashboard's night list, and fullRecoveryHours onto the stamp day only", async () => {
    const yesterday = addDays(TODAY, -1);
    const { server, client } = await setup([yesterday, TODAY]);
    server.state.sleepHrvData = {
      happenDay: corosDay(TODAY),
      avgSleepHrv: 72,
      sleepHrvBase: 68,
      sleepHrvSd: 6,
      sleepHrvList: [
        { happenDay: corosDay(yesterday), avgSleepHrv: 65, sleepHrvBase: 67, sleepHrvSd: 5 },
      ],
    };
    const snapshot = await snapshotFor(client, addDays(TODAY, 7));
    const byDate = new Map(snapshot.health.map((h) => [h.date, h]));
    expect(byDate.get(TODAY)?.sleepHrvSd).toBe(6);
    expect(byDate.get(yesterday)?.sleepHrvSd).toBe(5);
    expect(byDate.get(TODAY)?.fullRecoveryHours).toBe(9); // mock dashboard value
    expect(byDate.get(yesterday)?.fullRecoveryHours).toBeUndefined();
  });

  it("carries no sd when the dashboard has none — absent, never invented", async () => {
    const { server, client } = await setup([TODAY]);
    server.state.sleepHrvData = { avgSleepHrv: 72 };
    const snapshot = await snapshotFor(client, addDays(TODAY, 7));
    expect(snapshot.health.find((h) => h.date === TODAY)?.sleepHrvSd).toBeUndefined();
  });
});

describe("buildSnapshot exercise catalog (one-workout-system spec §8.5)", () => {
  it("keeps each item's muscle, part and equipment tags, exercise type and target type", async () => {
    const { client } = await setup([TODAY]);
    const snapshot = await buildSnapshot(client, RANGE_START, addDays(TODAY, 7), TODAY, undefined, {
      includeExerciseCatalog: true,
    });
    expect(snapshot.exerciseCatalog).toEqual([
      {
        id: "425898928110747648",
        name: "T2001",
        muscle: [3, 7],
        part: [2],
        equipment: [1, 4],
        exerciseType: 1,
        targetType: 2,
      },
      // No tags on the wire: empty lists, never undefined.
      { id: "426109589008859137", name: "T2101", muscle: [], part: [], equipment: [], exerciseType: 2, targetType: 3 },
    ]);
  });

  it("leaves the catalog out unless asked", async () => {
    const { client } = await setup([TODAY]);
    const snapshot = await snapshotFor(client, addDays(TODAY, 7));
    expect(snapshot.exerciseCatalog).toBeUndefined();
  });
});

describe("catalogExercise", () => {
  it("keeps scalar tags only, and reads a missing or malformed field as empty / null", () => {
    // The wire is untyped JSON: CorosExerciseCatalogItem is what we expect, not what we are promised.
    const malformed = {
      id: 42,
      name: "T1",
      muscle: [1, "2", null, { x: 1 }, Number.NaN, [3]],
      part: "2",
      exerciseType: "1",
      targetType: 3,
    } as unknown as CorosExerciseCatalogItem;
    expect(catalogExercise(malformed)).toEqual({
      id: "42",
      name: "T1",
      muscle: [1, "2"],
      part: [],
      equipment: [],
      exerciseType: null,
      targetType: 3,
    });
  });

  it("has no catalog entry for an item without a name", () => {
    expect(catalogExercise({ id: 1 })).toBeNull();
  });
});
