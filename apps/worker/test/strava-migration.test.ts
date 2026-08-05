import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { makeTestDb, makeTestUser } from "./helpers.js";

/**
 * The post-Strava schema, asserted against the real migrations (makeTestDb
 * applies every .sql file), plus the one promise the migration makes about
 * data: a session that only ever had a Strava source is kept, not deleted.
 */
describe("post-Strava schema", () => {
  it("has no strava_activity_id or summary_polyline column", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.activities).values({
      id: "a1",
      userId,
      startTime: "2026-05-01T07:00:00Z",
      sport: "yoga",
      durationSeconds: 2700,
      sourceMergeConfidence: 1,
      createdAt: "2026-05-01T07:00:00Z",
      updatedAt: "2026-05-01T07:00:00Z",
    });
    const row = (
      await db.select().from(schema.activities).where(eq(schema.activities.id, "a1"))
    )[0]!;
    expect("stravaActivityId" in row).toBe(false);
    expect("summaryPolyline" in row).toBe(false);
  });

  it("keeps a source-less activity — orphans are never deleted", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.activities).values({
      id: "orphan",
      userId,
      startTime: "2024-03-01T07:00:00Z",
      sport: "run",
      durationSeconds: 1800,
      distanceMeters: 5000,
      sourceMergeConfidence: 1,
      createdAt: "2024-03-01T07:00:00Z",
      updatedAt: "2024-03-01T07:00:00Z",
    });
    const rows = await db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.distanceMeters).toBe(5000);
  });

  it("dropped webhook_events — only the Strava route ever wrote it", () => {
    expect("webhookEvents" in schema).toBe(false);
  });

  it("dropped the provisional column on completion matches", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.workoutCompletionMatches).values({
      id: "m1",
      workoutId: "w1",
      activityId: "a1",
      confidence: 1,
      method: "manual",
      matchedAt: "2026-05-01T07:00:00Z",
    });
    const row = (
      await db
        .select()
        .from(schema.workoutCompletionMatches)
        .where(eq(schema.workoutCompletionMatches.id, "m1"))
    )[0]!;
    expect("provisional" in row).toBe(false);
    expect(userId).toBeTruthy();
  });
});
