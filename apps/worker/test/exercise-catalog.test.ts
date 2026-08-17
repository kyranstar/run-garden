import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";
import {
  buildExerciseIndex,
  isExerciseCatalogStale,
  normalizeExerciseKey,
  resolveExerciseOriginId,
  resolveOpsExercises,
  upsertExerciseCatalog,
} from "../src/services/exercise-catalog.js";
import { coachSessionSchema, offCatalogExercises } from "@rg/domain";
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

/**
 * The REVERSE resolution (2026-08-16). The coach is never handed the
 * catalog, so a model-authored "Wall sit" has to find T1231 on the server or
 * the exercise can never reach the watch. Matching runs on COROS's own
 * English names because the synced catalog stores i18n keys.
 */
describe("name → originId resolution", () => {
  /** Real T-codes and real ids, in the shape the live catalog stores them. */
  const liveCatalog = new Map<string, string>([
    ["425827615547506000", "T1231"], // Wall Sit
    ["425827615547506001", "T1010"], // Planks
    ["425827615547506002", "T1275"], // Single-Leg Calf Raise
    ["425827615547506003", "T1368"], // Copenhagen Plank
    ["425827615547506004", "T1185"], // Side Plank
    ["425827615547506005", "T1070"], // Standing Calf Raises
  ]);

  const index = () => buildExerciseIndex(liveCatalog);

  it("resolves the athlete's own words to real catalog ids", () => {
    const i = index();
    expect(resolveExerciseOriginId("Wall sit", i)).toBe("425827615547506000");
    expect(resolveExerciseOriginId("wall sits", i)).toBe("425827615547506000");
    expect(resolveExerciseOriginId("Wall Squat", i)).toBe("425827615547506000"); // synonym
    expect(resolveExerciseOriginId("Plank", i)).toBe("425827615547506001"); // "Planks" → singular
    expect(resolveExerciseOriginId("single-leg calf raises", i)).toBe("425827615547506002");
    expect(resolveExerciseOriginId("SL calf raise", i)).toBe("425827615547506002"); // abbreviation
    expect(resolveExerciseOriginId("Copenhagen plank", i)).toBe("425827615547506003");
    expect(resolveExerciseOriginId("heel raises", i)).toBe("425827615547506005"); // phrase alias
  });

  it("a movement the catalog does not have resolves to null, not to a near-enough guess", () => {
    const i = index();
    expect(resolveExerciseOriginId("Skier hops", i)).toBeNull();
    expect(resolveExerciseOriginId("Nordic hamstring curl", i)).toBeNull();
    // "Plank" is a token of four different entries — an ambiguous single
    // token must not silently become one of them.
    expect(resolveExerciseOriginId("Reverse hyper", i)).toBeNull();
  });

  it("ops are stamped in place; a miss keeps the exercise and reports it", () => {
    const i = index();
    const ops = [
      {
        kind: "add" as const,
        date: "2026-08-18",
        session: coachSessionSchema.parse({
          category: "strength",
          title: "Ski legs",
          durationMinutes: 30,
          lift: {
            exercises: [
              { name: "Wall sit", sets: 3, holdSeconds: 45 },
              { name: "Skier hops", sets: 3, holdSeconds: 30 },
              // A hallucinated originId must be discarded and re-resolved.
              { name: "Plank", sets: 2, holdSeconds: 60, originId: "999-made-up" },
            ],
          },
        }),
      },
    ];
    const report = resolveOpsExercises(ops as never, i);
    expect(report).toEqual([
      { name: "Wall sit", originId: "425827615547506000", via: "name" },
      { name: "Skier hops", originId: null, via: null },
      { name: "Plank", originId: "425827615547506001", via: "name" },
    ]);
    const ex = ops[0]!.session.lift!.exercises;
    // Nothing was dropped — three in, three out.
    expect(ex).toHaveLength(3);
    expect(ex[1]!.originId).toBeUndefined();
    expect(ex[2]!.originId).toBe("425827615547506001"); // not "999-made-up"
    // And the session names its own off-catalog movements honestly.
    expect(offCatalogExercises(ops[0]!.session)).toEqual(["Skier hops"]);
  });

  it("a model-supplied originId that IS in the catalog is kept (the dossier can carry the catalog)", () => {
    const i = index();
    const ops = [
      {
        kind: "add" as const,
        date: "2026-08-18",
        session: coachSessionSchema.parse({
          category: "strength",
          title: "Ski legs",
          durationMinutes: 30,
          lift: {
            exercises: [
              // The model paraphrased the name but cited a real id — trust
              // the id, which is the better-informed answer.
              { name: "Wall squat hold thing", sets: 3, holdSeconds: 45, originId: "425827615547506000" },
            ],
          },
        }),
      },
    ];
    expect(resolveOpsExercises(ops as never, i)).toEqual([
      { name: "Wall squat hold thing", originId: "425827615547506000", via: "model" },
    ]);
  });

  it("normalization folds the forms a coach actually writes", () => {
    expect(normalizeExerciseKey("Single-Leg Calf Raises")).toBe(normalizeExerciseKey("single leg calf raise"));
    expect(normalizeExerciseKey("Push-ups")).toBe(normalizeExerciseKey("pushup"));
    expect(normalizeExerciseKey("DB Row")).toBe(normalizeExerciseKey("dumbbell rows"));
    // Prescription adjectives are not part of any catalog name.
    expect(normalizeExerciseKey("Eccentric wall sit")).toBe(normalizeExerciseKey("wall sit"));
  });
});
