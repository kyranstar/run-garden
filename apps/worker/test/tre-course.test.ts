/**
 * The TRE course through the app's real routes: a session goes on the plan on a chosen evening with nothing to warn
 * about for an athlete whose condition profile is on, is booked as mobility, plays its holds at their doses, goes to the
 * watch whole, and saves as a template. Offers for other sessions never bring its moves in. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant } from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { makeLibraryIndex, treSessionDoc } from "@rg/workout";
import type { Db } from "../src/services/db.js";
import { libraryOffers } from "../src/services/doc-build.js";
import { createDocWorkout } from "../src/services/doc-workouts.js";
import { buildSession } from "../src/services/session-build.js";
import { watchPreview } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser, pinMiddayToday } from "./helpers.js";
import { activateTmj, clientFor, type Reply } from "./doc-workout-fixture.js";
import { seedCatalog, switchOn } from "./watch-push-fixture.js";

const { plannedWorkouts } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let userId: string;
let today: string;
let call: (method: string, path: string, body?: unknown) => Promise<Reply>;

beforeEach(async () => {
  today = pinMiddayToday();
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await makeTestUser(db));
  await activateTmj(db, userId);
  call = await clientFor(db, userId);
});

afterEach(() => vi.useRealTimers());

const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;

describe("a TRE session on the plan", () => {
  it.each([1, 5, 10, 11])("session %i goes on an evening ahead with nothing to warn about", async (n) => {
    const date = addDays(today, 3);
    const res = await call("POST", "/api/workouts", { date, time: "19:30", doc: treSessionDoc(n), clientId: `tre-${n}` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings).toEqual([]);
    const row = await rowOf(res.body.workout.id);
    expect([row.effectiveDate, row.effectiveTime, row.title, row.sport, row.category]).toEqual([date, "19:30", treSessionDoc(n).title, "yoga", "yoga"]);
  });

  it("a retry with the same key makes no second session", async () => {
    const date = addDays(today, 3);
    const first = await call("POST", "/api/workouts", { date, time: "19:30", doc: treSessionDoc(1), clientId: "tre-1" });
    const again = await call("POST", "/api/workouts", { date, time: "19:30", doc: treSessionDoc(1), clientId: "tre-1" });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.workout.id).toBe(first.body.workout.id);
  });

  it("plays the tremor and the wall sit at the session's doses, with its cues", async () => {
    const made = await call("POST", "/api/workouts", { date: today, time: "19:30", doc: treSessionDoc(1) });
    const built = await call("POST", `/api/sessions/${made.body.workout.id}/build`, {});
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    const steps: Array<{ exerciseId: string | null; kind: string; seconds: number; slotKey: string }> = built.body.build.steps;
    const secondsOf = (id: string) => steps.filter((s) => s.exerciseId === id).map((s) => s.seconds);
    expect(secondsOf("highWallSit")).toEqual([180]);
    expect(secondsOf("floorTremor")).toEqual([300]);
    const tremorSlot = steps.find((s) => s.exerciseId === "floorTremor")!.slotKey;
    expect(built.body.build.fromDoc.slots[tremorSlot].cue).toMatch(/roll onto your side/);
  });

  it("goes to the watch whole, in order, with nothing refused", async () => {
    const watcher = await makeTestUser(db, { corosWritesEnabled: true });
    await connectTestCoros(db, watcher.userId);
    await activateTmj(db, watcher.userId);
    await seedCatalog(db);
    const ctx = { today, now: nowInstant(), prefs: watcher.prefs };
    const { workout } = await createDocWorkout(db, watcher.userId, { date: today, time: "19:30", doc: treSessionDoc(1) }, ctx);
    await buildSession(db, watcher.userId, workout.id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx);
    const preview = await watchPreview(db, switchOn(), watcher.userId, workout.id, ctx);
    expect(preview.refusal).toBeNull();
    const names = preview.steps.map((s) => s.name);
    const shifts = names.findIndex((n) => n.includes("Foot-edge weight shifts"));
    const wallSit = names.findIndex((n) => n.includes("High wall sit"));
    const tremor = names.findIndex((n) => n.includes("Floor tremor"));
    expect(shifts).toBe(0);
    expect(wallSit).toBeGreaterThan(shifts);
    expect(tremor).toBeGreaterThan(wallSit);
  });
});

describe("TRE as a saved workout", () => {
  it.each([
    ["TRE · whole sequence", 10],
    ["TRE · floor", 11],
  ])("%s saves with nothing to warn about", async (name, session) => {
    const res = await call("POST", "/api/templates", { name, doc: { ...treSessionDoc(session), title: name } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings).toEqual([]);
  });
});

describe("the ⇄ offers for other sessions", () => {
  const find = makeLibraryIndex(EXERCISES);
  const none = { ids: new Set<string>(), keys: new Set<string>() };
  const TRE_ONLY = new Set(["footEdgeShifts", "supportedOneLegSquat", "wideForwardFold", "standingPsoasStretch", "highWallSit", "hangingForwardFold", "floorTremor"]);
  const general = EXERCISES.filter((e: ExerciseRecord) => !TRE_ONLY.has(e.id));

  it("never bring in a move of a fixed practice", () => {
    for (const rec of general) {
      const offered = libraryOffers(rec, EXERCISES, find, none).map((o) => o.to.id);
      expect(offered.filter((id) => TRE_ONLY.has(id)), rec.id).toEqual([]);
    }
  });

  it("still offer a way out of the sequence's own moves", () => {
    expect(libraryOffers(find("highWallSit")!, EXERCISES, find, none).map((o) => o.to.id)).toContain("wallSit");
  });
});
