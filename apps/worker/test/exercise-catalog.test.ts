import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";
import { isExerciseCatalogStale, upsertExerciseCatalog } from "../src/services/exercise-catalog.js";
import { makeTestDb } from "./helpers.js";

const { corosExercises } = schema;

/**
 * Exercise catalog sync (plan-studio-design §4): the bridge fetches COROS's
 * strength catalog and includes it in a sync when the worker last said the
 * stored catalog was stale (no rows, or oldest row untouched for 7+ days).
 */

let db: Db;

beforeEach(() => {
  db = makeTestDb();
});

describe("exercise catalog staleness + upsert", () => {
  it("is stale with no rows", async () => {
    expect(await isExerciseCatalogStale(db)).toBe(true);
  });

  it("a sync with exerciseCatalog upserts rows, and the next check reports not stale", async () => {
    const items = [
      { id: "425898928110747648", name: "Barbell Back Squat" },
      { id: "426109589008859137", name: "Push Up" },
    ];

    const result = await upsertExerciseCatalog(db, items);
    expect(result.upserted).toBe(2);

    const rows = await db.select().from(corosExercises);
    expect(rows).toHaveLength(2);
    const squat = rows.find((r) => r.id === "425898928110747648")!;
    expect(squat.name).toBe("Barbell Back Squat");
    expect(squat.raw).toEqual(items[0]);
    expect(typeof squat.updatedAt).toBe("string");

    // Second sync: fresh rows → not stale.
    expect(await isExerciseCatalogStale(db)).toBe(false);
  });

  it("upserting an existing originId updates it in place rather than duplicating", async () => {
    await upsertExerciseCatalog(db, [{ id: "abc", name: "Old Name" }]);
    await upsertExerciseCatalog(db, [{ id: "abc", name: "New Name" }]);
    const rows = await db.select().from(corosExercises).where(eq(corosExercises.id, "abc"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("New Name");
  });

  it("is stale again once the oldest row is more than 7 days old", async () => {
    await upsertExerciseCatalog(db, [{ id: "abc", name: "Squat" }]);
    expect(await isExerciseCatalogStale(db)).toBe(false);

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await db
      .update(corosExercises)
      .set({ updatedAt: eightDaysAgo })
      .where(eq(corosExercises.id, "abc"));

    expect(await isExerciseCatalogStale(db)).toBe(true);
  });

  it("is not stale when at least the oldest row was refreshed within 7 days", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await db.insert(corosExercises).values({
      id: "stale-one",
      name: "Stale",
      raw: { id: "stale-one", name: "Stale" },
      updatedAt: eightDaysAgo,
    });
    // Oldest row is still 8 days old → stale overall (worker-side rule: OR the
    // oldest updatedAt is older than 7 days).
    expect(await isExerciseCatalogStale(db)).toBe(true);

    await upsertExerciseCatalog(db, [{ id: "fresh-one", name: "Fresh" }]);
    // The oldest row (stale-one) is still 8 days old, so the catalog as a
    // whole is still considered stale even though a fresh row now exists.
    expect(await isExerciseCatalogStale(db)).toBe(true);

    // Refreshing the old row brings the whole catalog back to fresh.
    await upsertExerciseCatalog(db, [{ id: "stale-one", name: "Stale" }]);
    expect(await isExerciseCatalogStale(db)).toBe(false);
  });

  it("no-ops cleanly on an empty catalog", async () => {
    const result = await upsertExerciseCatalog(db, []);
    expect(result.upserted).toBe(0);
    expect(await db.select().from(corosExercises)).toHaveLength(0);
  });
});
