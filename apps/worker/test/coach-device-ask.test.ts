/**
 * A PHONE'S ASK, ONCE: ITS RACE AND ITS FAILURE PATHS (R1.2 item 4; the R1.2 review's MINOR-2). coach-device.test.ts pins
 * the ask itself; here, what its first answer's loss can meet:
 *  - two of the same ask at once: one run and one key, both answers naming it, one of them `repeated`;
 *  - the race's loser, whose lookup ran before the winner's key landed (made deterministic: the route's lookup, wrapped,
 *    misses once), finding the ask's own run in its way: that run, `repeated`;
 *  - a key taken with no live run in the way: the run it made, `repeated`; its run gone: 409 `client_id_taken`, nothing
 *    started;
 *  - a week that can't pay: 409 `week_budget`, no key written, so the same clientId goes again once it can.
 * On better-sqlite3's transaction (the tests' driver), not D1's batch: the native harness is where local D1 runs. Synthetic
 * data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The route's lookup (`keyedRun`), made to miss when told: the race's loser, on one connection, deterministically. */
const holder = vi.hoisted(() => ({ miss: 0 }));
vi.mock("../src/services/coach-runs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/coach-runs.js")>();
  const keyedRun: typeof actual.keyedRun = async (...args) => {
    if (holder.miss > 0) {
      holder.miss -= 1;
      return null;
    }
    return actual.keyedRun(...args);
  };
  return { ...actual, keyedRun };
});

import { DateTime } from "luxon";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { coachRoutes } from "../src/routes/coach.js";
import { coachRunRoutes } from "../src/routes/coach-runs.js";
import { nativeRoutes } from "../src/routes/native.js";
import { deviceAskKey } from "../src/services/coach-runs.js";
import { nativeWorld, seedDevice, type NativeWorld } from "./native-fixture.js";

const { auditEvents, coachRuns, llmUsage } = schema;
const LA = "America/Los_Angeles";
const T = "2026-11-19";
const NOW = DateTime.fromISO(`${T}T07:40`, { zone: LA }).toUTC().toISO()!;
const U = "7d1c9f0e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";

let w: NativeWorld;
let v5: { token: string; id: string };

beforeEach(async () => {
  holder.miss = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", (async () => {
    throw new Error("no model call from a create");
  }) as typeof fetch);
  w = await nativeWorld(
    [
      ["/api/coach/runs", coachRunRoutes],
      ["/api/coach", coachRoutes],
      ["/api/native", nativeRoutes],
    ],
    { env: { COACH_DESIGNER: "1", AI_GATEWAY_API_KEY: "test-key" } },
  );
  v5 = await seedDevice(w.db, w.userId, { scope: "training-v5", lastUsedAt: nowInstant(), expiresAt: "2099-01-01T00:00:00.000Z" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ask = (over: Record<string, unknown> = {}) => ({ scope: { kind: "later_today" }, request: "A short mobility session tonight", clientId: U, ...over });
const create = (body: Record<string, unknown>) => w.call("POST", "/api/coach/runs", { bearer: v5.token, body });
const cancel = (id: string) => w.call("POST", `/api/coach/runs/${id}/cancel`, { bearer: v5.token, body: {} });
const runs = () => w.db.select().from(coachRuns);
const keys = () => w.db.select().from(auditEvents).where(eq(auditEvents.kind, "coach.device_ask"));

describe("a phone's ask, once: the race and the failure paths (R1.2 item 4; review MINOR-2)", () => {
  it("two of the same ask at once: one run and one key, both answers naming it, one of them repeated", async () => {
    const [a, b] = await Promise.all([create(ask()), create(ask())]);
    expect([a.status, b.status], `${a.text} ${b.text}`).toEqual([200, 200]);
    expect(a.json.run.id).toBe(b.json.run.id);
    expect([a, b].filter((x) => x.json.repeated === true)).toHaveLength(1);
    // Neither is "a live run in the way": each is the ask's own run.
    expect([a, b].map((x) => x.json.existing)).toEqual([false, false]);
    expect([(await runs()).length, (await keys()).length]).toEqual([1, 1]);
  });

  it("the race's loser, its lookup before the winner's key landed, finds the ask's own run in its way: that run, repeated", async () => {
    const a = await create(ask());
    expect(a.status, a.text).toBe(200);
    holder.miss = 1;
    const b = await create(ask());
    expect([b.status, b.json.run?.id, b.json.existing, b.json.repeated], b.text).toEqual([200, a.json.run.id, false, true]);
    expect(holder.miss).toBe(0);
    expect([(await runs()).length, (await keys()).length]).toEqual([1, 1]);
  });

  it("a key taken with no live run in the way: the run it made, repeated; that run gone, 409 client_id_taken and nothing starts", async () => {
    const a = await create(ask());
    expect((await cancel(a.json.run.id)).status).toBe(200);
    // Its lookup missed, the run is over: the create meets the key, and answers the run it made.
    holder.miss = 1;
    const b = await create(ask());
    expect([b.status, b.json.run?.id, b.json.repeated], b.text).toEqual([200, a.json.run.id, true]);
    // The run gone under its standing key (an account deleted or restored meanwhile): 409, the phone asks again anew.
    await w.db.delete(coachRuns).where(eq(coachRuns.id, a.json.run.id));
    const c = await create(ask());
    expect([c.status, c.json]).toEqual([409, { error: "client_id_taken" }]);
    expect([await runs(), (await keys()).length]).toEqual([[], 1]);
  });

  it("a week that can't pay: 409 week_budget, no key written, so the same clientId goes again once it can", async () => {
    await w.db.insert(llmUsage).values({
      id: newId(), userId: w.userId, kind: "design_main", model: "m", inputTokens: 1, outputTokens: 1, costMicros: 20_000_000, cacheHit: false,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const over = await create(ask());
    expect([over.status, over.json.error], over.text).toEqual([409, "week_budget"]);
    expect([await runs(), await keys()]).toEqual([[], []]);
    await w.db.delete(llmUsage);
    const a = await create(ask());
    expect([a.status, a.json.existing, "repeated" in a.json], a.text).toEqual([200, false, false]);
    expect((await keys()).map((k) => k.id)).toEqual([await deviceAskKey(w.userId, U)]);
  });
});
