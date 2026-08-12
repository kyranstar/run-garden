import { describe, expect, it } from "vitest";
import { FIXTURE_PLAN_ID } from "@rg/providers";
import type { DailyHealth } from "@rg/domain";
import { CorosClient } from "@rg/coros";
import { createBridgeState, handleLine, handleRequest, type BridgeState } from "../src/protocol.js";
import { buildSnapshot, type BridgeSnapshot } from "../src/snapshot.js";
import { mockCorosServer, type MockCorosServer } from "./mock-coros-server.js";

const BASE_MONDAY = "2026-08-03";
const noop = (): void => undefined;

function makeState(): { server: MockCorosServer; state: BridgeState } {
  const server = mockCorosServer({ baseMonday: BASE_MONDAY });
  const state = createBridgeState({
    fetchImpl: server.fetchImpl,
    makeClient: (region) =>
      new CorosClient({ region, fetchImpl: server.fetchImpl, logger: noop }),
  });
  return { server, state };
}

async function authenticate(state: BridgeState, server: MockCorosServer) {
  return handleRequest(state, {
    id: "auth-1",
    op: "authenticate",
    params: { email: server.email, password: server.password, region: "us" },
  });
}

describe("NDJSON protocol", () => {
  it("rejects an invalid line with id null", async () => {
    const { state } = makeState();
    const res = await handleLine(state, "this is not json{");
    expect(res).toMatchObject({
      id: null,
      ok: false,
      error: { category: "invalid_request" },
    });
  });

  it("rejects malformed requests and unknown ops", async () => {
    const { state } = makeState();
    expect(await handleRequest(state, { id: "1" })).toMatchObject({
      id: "1",
      ok: false,
      error: { category: "invalid_request" },
    });
    expect(await handleRequest(state, { id: "2", op: "fly" })).toMatchObject({
      id: "2",
      ok: false,
      error: { category: "unknown_op" },
    });
  });

  it("authenticates and reports userId + capabilities", async () => {
    const { server, state } = makeState();
    const res = await authenticate(state, server);
    expect(res.ok).toBe(true);
    const result = (res as { result: { userId: string; capabilities: Record<string, boolean> } })
      .result;
    expect(result.userId).toBe(server.userId);
    expect(result.capabilities.updateExistingScheduledWorkout).toBe(true);
    expect(result.capabilities.verifyWatchSync).toBe(false);
    expect(result.capabilities.readSleep).toBe(false);
  });

  it("surfaces bad credentials as an error response", async () => {
    const { server, state } = makeState();
    const res = await handleRequest(state, {
      id: "auth-bad",
      op: "authenticate",
      params: { email: server.email, password: "nope", region: "us" },
    });
    expect(res).toMatchObject({ ok: false, error: { category: "bad_credentials" } });
    expect(state.client).toBeNull();
  });

  it("testConnection reflects authentication state", async () => {
    const { server, state } = makeState();
    expect(await handleRequest(state, { id: "t0", op: "testConnection" })).toMatchObject({
      ok: true,
      result: { connected: false },
    });
    await authenticate(state, server);
    expect(await handleRequest(state, { id: "t1", op: "testConnection" })).toMatchObject({
      ok: true,
      result: { connected: true },
    });
  });

  it("getCapabilities works unauthenticated", async () => {
    const { state } = makeState();
    const res = await handleRequest(state, { id: "c1", op: "getCapabilities" });
    expect(res.ok).toBe(true);
    expect((res as { result: Record<string, boolean> }).result.readSchedule).toBe(true);
  });

  it("readSnapshot returns normalized plan, workouts, activities, laps, health", async () => {
    const { server, state } = makeState();
    await authenticate(state, server);
    const res = await handleRequest(state, {
      id: "s1",
      op: "readSnapshot",
      params: { rangeStart: "2026-07-27", rangeEnd: "2026-08-31" },
    });
    expect(res.ok).toBe(true);
    const snapshot = (res as { result: BridgeSnapshot }).result;

    // Plan (TrainingPlanInfo from normalizeCorosSchedule).
    expect(snapshot.plan?.sourcePlanId).toBe(FIXTURE_PLAN_ID);
    expect(snapshot.plan?.name).toBe("Fall Half Marathon Build");
    expect(snapshot.plan?.startDate).toBe(BASE_MONDAY);
    expect(snapshot.plan?.sourceVersion).toBe("7");

    // Workouts carry COROS-native duration estimates.
    expect(snapshot.workouts.length).toBe(11);
    const threshold = snapshot.workouts.find((w) => w.sourceIdInPlan === "11");
    expect(threshold?.title).toBe("Threshold 5x5");
    expect(threshold?.estimatedDurationSeconds).toBe(3240);
    expect(threshold?.date).toBe("2026-08-04");
    const rest = snapshot.workouts.find((w) => w.sourceIdInPlan === "10");
    expect(rest?.isRestDay).toBe(true);
    // Raw entity/program payloads are stripped before leaving the bridge.
    expect(threshold && "raw" in threshold ? threshold.raw : undefined).toBeUndefined();

    // Stage names resolved through the CDN locale bundle.
    const strides = snapshot.workouts.find((w) => w.sourceIdInPlan === "13");
    expect(strides?.stages.some((s) => s.label === "Warm Up")).toBe(true);
    expect(server.counts.localeFetches).toBe(1);

    // Activities: every sport type is admitted, with laps keyed by labelId.
    expect(snapshot.activities.map((a) => a.providerActivityId)).toEqual([
      "act-run-1",
      "act-bike-1",
      "act-strength-1",
      "act-yoga-1",
    ]);
    expect(snapshot.activities[0]?.sport).toBe("run");
    expect(snapshot.activities[0]?.distanceMeters).toBe(10000);
    expect(snapshot.activities.find((a) => a.providerActivityId === "act-bike-1")?.sport).toBe(
      "bike",
    );
    expect(
      snapshot.activities.find((a) => a.providerActivityId === "act-strength-1")?.sport,
    ).toBe("strength");
    expect(snapshot.activities.find((a) => a.providerActivityId === "act-yoga-1")?.sport).toBe(
      "yoga",
    );
    expect(snapshot.lapsByProviderId["act-run-1"]?.length).toBe(2);
    expect(snapshot.lapsByProviderId["act-run-1"]?.[0]?.durationSeconds).toBe(300);

    // Every sportType in this fixture set resolves to a named registry id, so
    // nothing is tallied as unnamed ("other").
    expect(snapshot.skippedSportTypes).toBeUndefined();

    // Health mapping: rhr/t7d/tiredRateNew/avgSleepHrv.
    expect(snapshot.health.length).toBe(2);
    const day1 = snapshot.health[0] as DailyHealth;
    expect(day1.date).toBe(BASE_MONDAY);
    expect(day1.restingHeartRate).toBe(47);
    expect(day1.trainingLoad7d).toBe(320);
    expect(day1.fatigueScore).toBe(28);
    expect(day1.hrv).toBe(72);
    expect(day1.provider).toBe("coros");
  });

  it("attaches the dashboard recovery % to the latest daily-health record when it matches the sync's rangeEnd", async () => {
    // Minimal fake client (pattern: services/coros-bridge/test/backfill.test.ts) —
    // buildSnapshot's health mapping only needs getDailyMetrics + getDashboard;
    // the other calls just need to resolve to empty/valid shapes.
    const client = {
      async getRawSchedule() {
        return {};
      },
      async getActivities() {
        return [];
      },
      async getDailyMetrics() {
        return [{ happenDay: 20260101 }, { happenDay: 20260102 }];
      },
      async getDashboard() {
        return { recoveryPct: 72 };
      },
    } as unknown as CorosClient;

    // Happy path: Coros's latest metrics day (2026-01-02) IS the sync's
    // rangeEnd — the dashboard's recoveryPct is "today's" value, so stamping
    // it there is correct.
    const snap = await buildSnapshot(client, "2026-01-01", "2026-01-02", undefined, {});
    const latest = snap.health.find((h) => h.date === "2026-01-02");
    expect(latest?.recoveryScore).toBe(72);
    expect(snap.health.find((h) => h.date === "2026-01-01")?.recoveryScore).toBeUndefined();
  });

  it("does NOT stamp recovery % anywhere when Coros's latest metrics day lags behind the sync's rangeEnd", async () => {
    // Same fake client as above, but the sync window (rangeEnd 2026-01-03)
    // runs a day past Coros's latest daily-health record (2026-01-02) — a
    // metrics-lag scenario. Stamping the dashboard's "today" recoveryPct onto
    // 2026-01-02 here would misattribute it to the wrong day, and the
    // worker's COALESCE would never let a later, correct value replace it.
    const client = {
      async getRawSchedule() {
        return {};
      },
      async getActivities() {
        return [];
      },
      async getDailyMetrics() {
        return [{ happenDay: 20260101 }, { happenDay: 20260102 }];
      },
      async getDashboard() {
        return { recoveryPct: 72 };
      },
    } as unknown as CorosClient;

    const snap = await buildSnapshot(client, "2026-01-01", "2026-01-03", undefined, {});
    expect(snap.health.length).toBe(2);
    expect(snap.health.every((h) => h.recoveryScore === undefined)).toBe(true);
  });

  it("survives a getDashboard() that throws, still building the snapshot with recoveryScore undefined", async () => {
    // Same fake-client shape as the happy-path test above, but getDashboard
    // throws — recovery is best-effort and must never break a sync.
    const client = {
      async getRawSchedule() {
        return {};
      },
      async getActivities() {
        return [];
      },
      async getDailyMetrics() {
        return [{ happenDay: 20260101 }, { happenDay: 20260102 }];
      },
      async getDashboard() {
        throw new Error("coros 500");
      },
    } as unknown as CorosClient;

    const snap = await buildSnapshot(client, "2026-01-01", "2026-01-02", undefined, {});
    expect(snap.health.length).toBe(2);
    expect(snap.health.find((h) => h.date === "2026-01-02")?.recoveryScore).toBeUndefined();
    expect(snap.health.find((h) => h.date === "2026-01-01")?.recoveryScore).toBeUndefined();
  });

  it("caches the locale bundle across snapshots", async () => {
    const { server, state } = makeState();
    await authenticate(state, server);
    const params = { rangeStart: "2026-07-27", rangeEnd: "2026-08-31" };
    await handleRequest(state, { id: "s1", op: "readSnapshot", params });
    await handleRequest(state, { id: "s2", op: "readSnapshot", params });
    expect(server.counts.localeFetches).toBe(1);
  });

  it("executeJob runs the move protocol", async () => {
    const { server, state } = makeState();
    await authenticate(state, server);
    const res = await handleRequest(state, {
      id: "j1",
      op: "executeJob",
      params: {
        job: {
          id: "job-p1",
          originalDate: "2026-08-04",
          destinationDate: "2026-08-07",
          workout: { sourceIdInPlan: "11", sourcePlanId: FIXTURE_PLAN_ID },
        },
      },
    });
    expect(res.ok).toBe(true);
    expect((res as { result: { outcome: string; pathUsed: string } }).result).toMatchObject({
      outcome: "verified",
      pathUsed: "direct_update",
      observedDate: "2026-08-07",
    });
    expect(Number(server.entityByIdInPlan("11")?.happenDay)).toBe(20260807);
  });

  it("requires authentication for snapshot and job ops", async () => {
    const { state } = makeState();
    expect(
      await handleRequest(state, {
        id: "s0",
        op: "readSnapshot",
        params: { rangeStart: "2026-08-01", rangeEnd: "2026-08-02" },
      }),
    ).toMatchObject({ ok: false, error: { category: "not_authenticated" } });
  });

  it("eraseCredentials wipes the session", async () => {
    const { server, state } = makeState();
    await authenticate(state, server);
    expect(state.client).not.toBeNull();
    const res = await handleRequest(state, { id: "e1", op: "eraseCredentials" });
    expect(res).toMatchObject({ ok: true, result: { erased: true } });
    expect(state.client).toBeNull();
    expect(await handleRequest(state, { id: "t2", op: "testConnection" })).toMatchObject({
      ok: true,
      result: { connected: false },
    });
  });

  it("readGarden needs an active cloud sync, then delegates to it", async () => {
    const { state } = makeState();
    // No cloud sync started yet → a clear, non-fatal signal for the ambient view.
    expect(await handleRequest(state, { id: "g0", op: "readGarden" })).toMatchObject({
      ok: false,
      error: { category: "not_connected" },
    });

    // With a running sync, the op returns exactly what the signed cloud read gives.
    const garden = { snapshot: { plants: [] }, condition: "flourishing", species: [] };
    state.cloudSync = { readGarden: async () => garden } as unknown as BridgeState["cloudSync"];
    const res = await handleRequest(state, { id: "g1", op: "readGarden" });
    expect(res).toMatchObject({ ok: true, result: garden });
  });

  it("shutdown flags the state for the main loop", async () => {
    const { state } = makeState();
    const res = await handleRequest(state, { id: "x1", op: "shutdown" });
    expect(res).toMatchObject({ ok: true, result: { shuttingDown: true } });
    expect(state.shuttingDown).toBe(true);
  });
});
