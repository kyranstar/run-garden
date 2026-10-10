/**
 * The library list folds a renamed move's old ids into its current id when it reports lastDoneOn / timesDone30d. No
 * record carries a legacy id today, so this gives one to goblet squat for the test.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { listLibrary } from "../src/services/library-view.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

vi.mock("@rg/exercise-library", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rg/exercise-library")>();
  return { ...real, EXERCISES: real.EXERCISES.map((e) => (e.id === "gobletSquat" ? { ...e, legacyIds: ["oldGobletSquat"] } : e)) };
});

let db: Db;
let userId: string;
let timezone: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  const u = await makeTestUser(db);
  userId = u.userId;
  timezone = u.prefs.timezone;
});

it("a set logged under an old id counts for the move's current id", async () => {
  const today = todayInZone(timezone);
  const sid = newId();
  await db.insert(schema.performedSessions).values({
    id: sid, userId, workoutId: null, activityId: null, buildId: null, source: "import", sourceRef: sid, localDate: addDays(today, -4),
    startedAt: null, endedAt: null, seconds: 600, plannedSeconds: null, minutes: 10, mode: "build", theme: null, locationId: null,
    blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [], note: null, newMove: null,
    payloadHash: "h", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  });
  await db.insert(schema.performedSets).values({
    id: newId(), performedSessionId: sid, entryIndex: 0, exerciseId: "oldGobletSquat", implement: null, format: "straight", perSide: false,
    setIndex: 0, side: null, reps: 8, seconds: null, loadValue: null, loadUnit: null, loadKg: null, done: true, flags: [],
  });
  const row = (await listLibrary(db, userId, { limit: 200 })).items.find((r) => r.id === "gobletSquat")!;
  expect(row).toMatchObject({ lastDoneOn: addDays(today, -4), timesDone30d: 1 });
});
