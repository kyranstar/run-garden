import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { buildSnapshot, CorosClient } from "@rg/coros";
import type { Db } from "../src/services/db.js";
import {
  buildExerciseIndex,
  catalogMeta,
  catalogMetaById,
  isExerciseCatalogStale,
  normalizeExerciseKey,
  resolveExerciseOriginId,
  resolveOpsExercises,
  upsertExerciseCatalog,
} from "../src/services/exercise-catalog.js";
import { coachSessionSchema, offCatalogExercises } from "@rg/domain";
import { makeTestDb } from "./helpers.js";
import { mockCorosServer, STRENGTH_CATALOG } from "../../../packages/coros/test/mock-coros-server.js";

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
    // An item with no tags stores empty ones (one-workout-system spec §8.5).
    expect(squat.raw).toEqual({ ...items[0], muscle: [], part: [], equipment: [], exerciseType: null, targetType: null });
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

/**
 * The near-miss class (2026-08-17). A survival harness measured 43.5% of
 * coach-written movement names failing to resolve, and the cheapest slice of
 * that was ONE extra word on COROS's side: "Cat cow" vs "Cat-Cow Stretch" is
 * a Jaccard overlap of 2/3, under the 0.7 floor, so the match was lost.
 *
 * Two rules fix it without letting the matcher guess — a generic TRAILING
 * word ("stretch", "pose", "hold", "drill", "variation") shaved off both
 * sides but never below two tokens, and containment: every word the coach
 * wrote is in the entry, the coach wrote at least two words, the entry adds
 * at most one of its own, and exactly one entry qualifies.
 */
describe("name → originId: the one-extra-word near miss", () => {
  /** Real T-codes and their real English names, chosen to be the traps. */
  const cat = new Map<string, string>([
    ["id-cat-cow", "T1234"], // Cat-Cow Stretch
    ["id-thoracic", "T1248"], // Thoracic Spine Rotation
    ["id-side-plank", "T1185"], // Side Plank
    ["id-lunge-stretch", "T1274"], // Lunge Stretch
    ["id-bird-dog", "T1150"], // Bird Dog
    ["id-standing-ham", "T1255"], // Standing Hamstring Curl
    ["id-nordic-ham", "T1365"], // Nordic Hamstring Curl
    ["id-split-bench", "T1164"], // Split Bench Squat
    ["id-trx-split", "T1086"], // TRX Suspended Split Squat
    ["id-sumo-squat", "T1295"], // Sumo Squat
    ["id-box-squat", "T1291"], // Box Squat
    ["id-frog-pose", "T1240"], // Frog Pose
  ]);
  const index = () => buildExerciseIndex(cat);

  it("resolves a name COROS spells with one extra generic word", () => {
    const i = index();
    // The measured bug: folded "cat cow" vs "cat cow stretch" is 2/3 overlap.
    expect(resolveExerciseOriginId("Cat cow", i)).toBe("id-cat-cow");
    expect(resolveExerciseOriginId("Cat-Cow", i)).toBe("id-cat-cow");
    expect(resolveExerciseOriginId("cat cows", i)).toBe("id-cat-cow");
    // Same class, generic word on the COACH's side instead — the fold is
    // symmetric, so "Side plank hold" still finds plain "Side Plank".
    expect(resolveExerciseOriginId("Side plank hold", i)).toBe("id-side-plank");
  });

  it("resolves a name COROS spells with one extra ORDINARY word", () => {
    const i = index();
    // "thoracic rotation" ⊂ "thoracic spine rotation": containment, not a
    // generic word, and exactly one entry qualifies.
    expect(resolveExerciseOriginId("Thoracic rotation", i)).toBe("id-thoracic");
  });

  it("a one-word name never reaches the containment rule", () => {
    const i = index();
    // Three squats in the catalog and no plain one: "squat" must stay null
    // rather than silently becoming any of them.
    expect(resolveExerciseOriginId("squat", i)).toBeNull();
    expect(resolveExerciseOriginId("Squats", i)).toBeNull();
    // The generic-tail fold must never collapse an entry to a lone word:
    // "Lunge Stretch" stays two tokens, so a coach writing "Lunge" is not
    // handed a mobility drill.
    expect(resolveExerciseOriginId("Lunge", i)).toBeNull();
    expect(resolveExerciseOriginId("Plank", i)).toBeNull();
    expect(resolveExerciseOriginId("Stretch", i)).toBeNull();
    // ...but the full name still resolves exactly.
    expect(resolveExerciseOriginId("Lunge stretch", i)).toBe("id-lunge-stretch");
  });

  it("a name two entries could equally claim stays null", () => {
    const i = index();
    // Both "Standing Hamstring Curl" and "Nordic Hamstring Curl" contain the
    // whole of "hamstring curl" with one extra word. A naive containment
    // rule takes whichever it saw first; this one refuses.
    expect(resolveExerciseOriginId("Hamstring curl", i)).toBeNull();
    // Spelling out which one is meant works.
    expect(resolveExerciseOriginId("Nordic hamstring curl", i)).toBe("id-nordic-ham");
  });

  it("containment is not mere word-sharing", () => {
    const i = index();
    // "Bird Dog" shares "dog" and nothing else — the coach's whole name has
    // to be inside the entry, so this is a miss, not a Bird Dog.
    expect(resolveExerciseOriginId("Downward dog", i)).toBeNull();
    // "Frog Pose" folds to "frog", not to "pose": no pigeon here.
    expect(resolveExerciseOriginId("Pigeon pose", i)).toBeNull();
    // Two extra words is past the budget — "TRX Suspended Split Squat" is
    // not what a coach writing "suspended squat" meant.
    expect(resolveExerciseOriginId("Suspended squat", i)).toBeNull();
  });

  it("two catalog rows of the SAME name are one answer, not a tie", () => {
    // The live catalog carries genuine duplicates: "Plank Jacks" is both
    // T1077 and T1259. Ambiguity is judged on the name, so a near match
    // across a duplicated name must still resolve.
    const dup = buildExerciseIndex(
      new Map([
        ["id-jacks-a", "T1077"], // Plank Jacks
        ["id-jacks-b", "T1259"], // Plank Jacks (same name, second row)
        ["id-side-plank", "T1185"], // Side Plank
      ]),
    );
    expect(resolveExerciseOriginId("Plank jack hold", dup)).toBe("id-jacks-a");
  });
});

/**
 * The catalog's muscle, part and equipment tags, exercise type and target
 * type (one-workout-system spec §8.5): kept in `raw` on every sync and read
 * back by `catalogMeta`. Nothing reads them yet; the Phase 3 mapping will.
 */
describe("catalog tags", () => {
  const META_DEFAULTS = { muscle: [], part: [], equipment: [], exerciseType: null, targetType: null };

  it("a mock COROS catalog item's tags round-trip from the wire into raw, and catalogMeta reads them", async () => {
    const server = mockCorosServer({ baseMonday: "2026-08-03" });
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: () => undefined });
    await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
    const snapshot = await buildSnapshot(client, "2026-08-01", "2026-08-10", "2026-08-05", undefined, {
      includeExerciseCatalog: true,
    });
    await upsertExerciseCatalog(db, snapshot.exerciseCatalog!);

    const tagged = STRENGTH_CATALOG[0]!;
    const [row] = await db.select().from(corosExercises).where(eq(corosExercises.id, tagged.id));
    expect(row!.raw).toEqual({
      id: tagged.id,
      name: tagged.name,
      muscle: tagged.muscle,
      part: tagged.part,
      equipment: tagged.equipment,
      exerciseType: tagged.exerciseType,
      targetType: tagged.targetType,
    });
    expect(await catalogMeta(db, tagged.id)).toEqual({
      id: tagged.id,
      name: "T2001",
      muscle: [3, 7],
      part: [2],
      equipment: [1, 4],
      exerciseType: 1,
      targetType: 2,
    });
    expect(await catalogMeta(db, STRENGTH_CATALOG[1]!.id)).toEqual({
      id: STRENGTH_CATALOG[1]!.id,
      name: "T2101",
      ...META_DEFAULTS,
      exerciseType: 2,
      targetType: 3,
    });
  });

  it("a re-sync replaces the tags, and catalogMetaById reads every row in one go", async () => {
    await upsertExerciseCatalog(db, [{ id: "t1", name: "T1", ...META_DEFAULTS, equipment: [1] }]);
    await upsertExerciseCatalog(db, [
      { id: "t1", name: "T1", ...META_DEFAULTS, equipment: [2, 5] },
      { id: "t2", name: "T2", ...META_DEFAULTS, muscle: ["x"] },
    ]);
    const all = await catalogMetaById(db);
    expect([...all.keys()].sort()).toEqual(["t1", "t2"]);
    expect(all.get("t1")!.equipment).toEqual([2, 5]);
    expect(all.get("t2")!.muscle).toEqual(["x"]);
  });

  it("a row synced before the tags were kept reads as untagged, never as junk", async () => {
    await db.insert(corosExercises).values([
      { id: "old", name: "T9", raw: { id: "old", name: "T9" }, updatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "no-raw", name: "T8", raw: null, updatedAt: "2026-09-01T00:00:00.000Z" },
      {
        id: "odd",
        name: "T7",
        raw: { muscle: "3", part: [1, { x: 2 }], equipment: null, exerciseType: "1", targetType: 4 },
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    expect(await catalogMeta(db, "old")).toEqual({ id: "old", name: "T9", ...META_DEFAULTS });
    expect(await catalogMeta(db, "no-raw")).toEqual({ id: "no-raw", name: "T8", ...META_DEFAULTS });
    expect(await catalogMeta(db, "odd")).toEqual({ id: "odd", name: "T7", ...META_DEFAULTS, part: [1], targetType: 4 });
  });

  it("has no meta for an id the catalog does not hold", async () => {
    expect(await catalogMeta(db, "missing")).toBeNull();
  });
});
