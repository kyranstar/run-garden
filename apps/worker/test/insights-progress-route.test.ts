/**
 * GET /api/insights carries the Progress tiles' numbers (Phase 2d Task 3): `progress` — the condition trend per
 * switched-on profile, weekly strength volume and the block's core lifts — under every discipline the page asks for,
 * from the athlete's own today. The clock is pinned (Date only), so "today" is a known Wednesday.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserPreferences } from "@rg/domain";
import { insightRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { importStandalone } from "../src/services/standalone-import.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { makeEnv } from "./watch-sets-fixture.js";
import { backup, history } from "./fixtures/standalone-backup.js";

let db: Db;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Wednesday 2026-09-30, noon in Los Angeles (the test user's zone).
  vi.setSystemTime(new Date("2026-09-30T19:00:00.000Z"));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { weightUnit: "lb" }));
});

afterEach(() => {
  vi.useRealTimers();
});

async function insights(discipline: string) {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const app = mountRoutes(db, "/api/insights", insightRoutes);
  const res = await app.request(`/api/insights?discipline=${discipline}`, { headers: { Cookie: cookie } }, makeEnv());
  expect(res.status).toBe(200);
  return (await res.json()) as {
    progress: {
      weightUnit: string;
      conditions: Array<{ profileId: string; label: string; trend: { status: string; value?: { pairs: number } } }>;
      volume: { status: string; value?: { weeks: Array<{ weekStart: string; kg: number }> } };
      lifts: Array<{ exerciseId: string; name: string; trend: { status: string } }>;
    };
  };
}

describe("GET /api/insights — progress", () => {
  it("an imported history: the condition trend, weekly volume ending this week, and the block's core lifts — under every discipline", async () => {
    await importStandalone(db, userId, backup(history()), { today: "2026-09-30", now: "2026-09-30T19:00:00.000Z", timezone: prefs.timezone, dryRun: false });
    for (const discipline of ["run", "strength", "yoga"]) {
      const { progress } = await insights(discipline);
      expect(progress.weightUnit).toBe("lb");
      expect(progress.conditions.map((c) => [c.profileId, c.label, c.trend.status])).toEqual([["tmj", "Jaw / head", "ok"]]);
      expect(progress.volume.status).toBe("ok");
      expect(progress.volume.value!.weeks.at(-1)!.weekStart).toBe("2026-09-28");
      expect(progress.lifts.map((l) => l.exerciseId)).toEqual(["gobletSquat", "deadlift", "supportedRow", "floorPress", "suitcaseCarry"]);
    }
  });

  it("a new account: honest emptiness, never an error", async () => {
    const { progress } = await insights("run");
    expect(progress).toEqual({
      weightUnit: "lb",
      conditions: [],
      volume: { status: "insufficient_data", needed: 1, have: 0, explanation: expect.any(String) },
      lifts: [],
    });
  });
});
