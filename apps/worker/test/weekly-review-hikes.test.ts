/**
 * THE WEEKLY REVIEW COUNTS HIKES (owner, 2026-10-23): a 3.6 h hike on 2026-10-16 was left out of the week's totals —
 * the review read only run, strength and yoga — though the coach discussed it. The Monday cron's facts now count a
 * hike in the week's hours, distance and sessions, named a hike; the run/strength/yoga dashboard keeps its three tabs.
 * Other sports the watch records (a walk, a ride…) stay out for now. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, startOfIsoWeek, todayInZone } from "@rg/domain";
import type { Env } from "../src/env.js";
import { weekly } from "../src/index.js";
import { insightRoutes } from "../src/routes/misc.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    // No key: the facts are stored without a narrative, and no model is asked.
  };
}

describe("the weekly review's facts", () => {
  it("count a hike in the week's hours, distance and sessions, named a hike — a walk and a ride stay out", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const weekStart = addDays(startOfIsoWeek(todayInZone(prefs.timezone)), -7);
    const seed = async (sport: string, day: number, durationSeconds: number, distanceMeters: number | null) => {
      const local = `${addDays(weekStart, day)}T09:00:00`;
      await db.insert(schema.activities).values({
        id: newId(), userId, startTime: `${local}Z`, startTimeLocal: local, sport, durationSeconds, distanceMeters,
        title: sport, sourceMergeConfidence: 1, createdAt: nowInstant(), updatedAt: nowInstant(),
      });
    };
    await seed("run", 0, 3600, 10_000);
    await seed("strength", 1, 2400, null);
    await seed("hike", 4, 12_960, 14_000); // the 3.6 h hike
    await seed("walk", 5, 1800, 2_000);
    await seed("bike", 6, 3600, 30_000);

    await weekly(db, makeEnv());

    const [review] = await db.select().from(schema.weeklyReviews).where(eq(schema.weeklyReviews.userId, userId));
    const facts = review!.facts as Record<string, unknown>;
    expect(review!.weekStart).toBe(weekStart);
    expect(facts.totalDurationSeconds).toBe(3600 + 2400 + 12_960);
    expect(facts.totalDistanceMeters).toBe(10_000 + 14_000);
    expect(facts.sessions).toEqual({ runs: 1, lifts: 1, hikes: 1 });
    const [run] = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.userId, userId));
    expect((run!.stats as { activityCount: number }).activityCount).toBe(3);

    // The dashboard's disciplines stay three: a hike is no tab of its own.
    const app = mountRoutes(db, "/api/insights", insightRoutes);
    const res = await app.request("/api/insights", { headers: { Cookie: `${SESSION_COOKIE}=${await createSession(db, userId)}` } }, makeEnv());
    expect(((await res.json()) as { availableDisciplines: string[] }).availableDisciplines).toEqual(["run", "strength"]);
  });
});
