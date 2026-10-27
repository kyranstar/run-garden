/**
 * WHERE A WORKOUT HAPPENS, ONE RULE (default-place.ts): a workout document's save (`docDayContext`), its build
 * (`loadDocEngineContext`), the engine's place (`loadEngineContext`) and the coach's validate_workout read the place
 * alike — the one the document names (the athlete's own, a preset, or "No equipment": bodyweight plus a bare room's
 * props, `NO_EQUIPMENT_GEAR`), else the athlete's default (the profile's choice, the place marked default, the first
 * made). A hotel room's workout raises no gear warning at "No equipment"; a goblet squat still does.
 * Synthetic data only: the made-up athletes of design-read-fixture.ts (its clock for the coach; the real today for a save).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, NO_EQUIPMENT_PLACE, todayInZone } from "@rg/domain";
import { NO_EQUIPMENT_GEAR, NO_EQUIPMENT_PLACE_ID } from "@rg/exercise-library";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { readDocAthlete } from "../src/services/design-tools/act-common.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { loadEngineContext } from "../src/services/engine-inputs.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { clientFor } from "./doc-workout-fixture.js";
import { makeTestDb, pinMiddayToday } from "./helpers.js";

beforeEach(() => {
  pinMiddayToday();
});
afterEach(() => vi.useRealTimers());

let db: Db;
/** The Garage is its default (marked so, and the profile's choice): mat, dumbbells, bench, band — no kettlebell. */
let rich: Awaited<ReturnType<typeof seedRichAthlete>> & { userId: string };
/** The same athlete, whose profile chooses the Gym (a kettlebell) as the default; the Garage is still marked default. */
let chose: Awaited<ReturnType<typeof seedRichAthlete>> & { userId: string };

beforeAll(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  rich = await seedRichAthlete(db);
  chose = await seedRichAthlete(db);
  await db
    .update(schema.athleteProfiles)
    .set({ preferences: sql`json_set(${schema.athleteProfiles.preferences}, '$.defaultPlaceId', ${chose.gymId})` })
    .where(eq(schema.athleteProfiles.userId, chose.userId));
});

/** The loop's context for one main run of the athlete's (the tools read the run's row). */
async function ctx(userId: string): Promise<ToolContext> {
  const id = `run-${newId().slice(0, 8)}`;
  const scope = { kind: "now" } as const;
  await db.insert(schema.coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { ...scope }, request: "a short session",
    status: "active", state: null, steps: 0, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return { db, env: {} as Env, userId, run: { id, role: "main", scope, parentId: null, rehearsal: false }, now: NOW, toolUseId: `toolu_${id}` };
}

const doc = (libraryIds: string[], placeId?: string) => ({
  version: 1,
  title: "Somewhere",
  intent: { summary: "Move a little before the meetings.", goals: ["mobility"], focus: [], effort: "maintain" },
  parts: [{ purpose: "main", format: "straight", items: libraryIds.map((libraryId) => ({ kind: "exercise", libraryId, dose: { sets: 2, reps: 8 } })) }],
  ...(placeId ? { setting: { placeId } } : {}),
  source: { kind: "studio" },
});

const gearOnly = (warnings: Array<{ code: string; path: string }>) => warnings.filter((w) => w.code === "equipment_unavailable").map((w) => w.path);

/** The coach's validate_workout: the gear warnings' paths. */
async function coachGear(userId: string, libraryIds: string[], placeId?: string): Promise<string[]> {
  const validate = ACT_TOOLS.find((t) => t.name === "validate_workout")!;
  const r = await validate.run(await ctx(userId), { doc: doc(libraryIds, placeId), date: TODAY });
  if (isToolErr(r)) throw new Error(`refused: ${r.error} — ${r.why}`);
  return gearOnly((r.data as { warnings: Array<{ code: string; path: string }> }).warnings);
}

/** The Studio's save (`POST /api/workouts`): the gear warnings' paths. */
async function saveGear(userId: string, libraryIds: string[], placeId?: string): Promise<string[]> {
  const today = todayInZone((await loadPreferences(db, userId)).timezone);
  const res = await (await clientFor(db, userId))("POST", "/api/workouts", { date: today, doc: doc(libraryIds, placeId) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return gearOnly(res.body.warnings);
}

describe('"No equipment": bodyweight plus a bare room\'s props', () => {
  it("is the one id the library and the documents use", () => {
    expect(NO_EQUIPMENT_PLACE_ID).toBe(NO_EQUIPMENT_PLACE);
  });

  it("the coach accepts it, with the room's own props as its gear", async () => {
    const a = await readDocAthlete(await ctx(rich.userId), { placeId: NO_EQUIPMENT_PLACE });
    if ("error" in a) throw new Error(`refused: ${a.error}`);
    expect(a.place?.id).toBe(NO_EQUIPMENT_PLACE);
    expect([...(a.place?.equipment ?? [])].sort()).toEqual([...NO_EQUIPMENT_GEAR].sort());
  });

  it("a hotel room's workout — wall angels, a chair's incline plank and thoracic extension — raises no gear warning; a goblet squat does", async () => {
    const room = ["wallAngels", "inclinePlank", "chairThoracicExtension", "deadBug"];
    expect(await coachGear(rich.userId, room, NO_EQUIPMENT_PLACE)).toEqual([]);
    expect(await saveGear(rich.userId, room, NO_EQUIPMENT_PLACE)).toEqual([]);
    expect(await coachGear(rich.userId, ["gobletSquat"], NO_EQUIPMENT_PLACE)).toHaveLength(1);
  });
});

describe("the Studio's save and the coach's validate_workout judge gear at the same place", () => {
  it("none named (the default), one of the athlete's, a preset, No equipment — the same warnings for the same document", async () => {
    const moves = ["gobletSquat", "wallAngels", "bwSplitSquat"];
    // A goblet squat needs a kettlebell or dumbbells; wall angels, a wall.
    const places: Array<[string, string | undefined, number]> = [
      ["the default place (the Garage: dumbbells, no wall)", undefined, 1],
      ["the athlete's gym (a kettlebell, no wall)", rich.gymId, 1],
      ["the gym preset (both)", "gym", 0],
      ["the mat-only preset (a wall, no weight)", "mat", 1],
      ["No equipment (a wall, no weight)", NO_EQUIPMENT_PLACE, 1],
    ];
    for (const [what, placeId, gear] of places) {
      const coach = await coachGear(rich.userId, moves, placeId);
      expect(coach, what).toHaveLength(gear);
      expect(await saveGear(rich.userId, moves, placeId), what).toEqual(coach);
    }
  });

  it("a place deleted since is the default place on save, as in the build — the save never skips the gear check (lead M1)", async () => {
    const moves = ["gobletSquat", "wallAngels", "bwSplitSquat"];
    const atDefault = await saveGear(rich.userId, moves);
    expect(atDefault).toHaveLength(1);
    expect(await saveGear(rich.userId, moves, "a-place-deleted-since")).toEqual(atDefault);
  });

  it("the profile's chosen default place is the default for the save, the coach and the engine alike", async () => {
    // The Gym, chosen in the profile, though the Garage is the place marked default.
    expect(await coachGear(chose.userId, ["gobletSquat"])).toEqual([]);
    expect(await saveGear(chose.userId, ["gobletSquat"])).toEqual([]);
    const engine = await loadEngineContext(db, chose.userId, null, {});
    expect(engine.location.id).toBe(chose.gymId);
    // The rest as they were made, the default first.
    expect(engine.locations.map((l) => l.id)).toEqual([chose.gymId, chose.placeId]);
    // Without a choice, the place marked default — even one made after another.
    expect((await loadEngineContext(db, rich.userId, null, {})).location.id).toBe(rich.placeId);
    const marked = await seedRichAthlete(db);
    await db
      .update(schema.athleteProfiles)
      .set({ preferences: sql`json_remove(${schema.athleteProfiles.preferences}, '$.defaultPlaceId')` })
      .where(eq(schema.athleteProfiles.userId, marked.userId));
    await db.update(schema.locations).set({ isDefault: false }).where(eq(schema.locations.id, marked.placeId));
    await db.update(schema.locations).set({ isDefault: true }).where(eq(schema.locations.id, marked.gymId));
    expect((await loadEngineContext(db, marked.userId, null, {})).location.id).toBe(marked.gymId);
    expect(await coachGear(marked.userId, ["gobletSquat", "wallAngels"])).toEqual(await saveGear(marked.userId, ["gobletSquat", "wallAngels"]));
  });
});

describe("a document's build is at its document's place", () => {
  it("a preset named is that preset, an id that is no place the default, none named the profile's choice", async () => {
    const call = await clientFor(db, chose.userId);
    const today = todayInZone((await loadPreferences(db, chose.userId)).timezone);
    const viewAt = async (placeId?: string) => {
      const made = await call("POST", "/api/workouts", { date: today, doc: doc(["bwSplitSquat"], placeId) });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const built = await call("POST", `/api/sessions/${made.body.workout.id}/build`, {});
      expect(built.status, JSON.stringify(built.body)).toBe(200);
      return built.body.view.location as { id: string; name: string; equipment: string[] };
    };
    expect(await viewAt("mat")).toMatchObject({ id: "mat", name: "Mat only" });
    // One of the athlete's own, not the default: that one, with its gear.
    expect(await viewAt(chose.placeId)).toMatchObject({ id: chose.placeId, equipment: ["mat", "dumbbells", "bench", "band"] });
    expect(await viewAt(NO_EQUIPMENT_PLACE)).toMatchObject({ id: NO_EQUIPMENT_PLACE, name: "No equipment" });
    expect((await viewAt()).id).toBe(chose.gymId);
    expect((await viewAt("nowhere")).id).toBe(chose.gymId);
  });
});
