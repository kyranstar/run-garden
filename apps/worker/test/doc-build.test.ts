/**
 * A document workout played through the app's own session path (programme spec §3.11; Stage 2 spec §10): the build is
 * MATERIALISED from the document (`playerStepsFromDoc`; the build's `workout_doc` is the snapshot) instead of running
 * the engine, and Start re-gates it with the day's reading — a move the day's check now closes swaps to its first
 * passing alternate (shown before anything locks), or Start refuses with the issues. Route tests on the real today.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone, workoutDocSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc, playerStepsFromDoc } from "@rg/workout";
import type { Db } from "../src/services/db.js";
import { GatedError, lockCurrentBuild } from "../src/services/session-build.js";
import { savePerformedSession } from "../src/services/session-save.js";
import { applyMove } from "../src/services/jobs.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { activateTmj, calmDoc, clientFor, landingsDoc, type Reply } from "./doc-workout-fixture.js";

const { plannedWorkouts, sessionBuilds } = schema;

vi.setConfig({ testTimeout: 30_000 });

// Making a workout hands the calendar a sync step (doc-workouts.test.ts counts it); none runs here.
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let today: string;
let call: (method: string, path: string, body?: unknown) => Promise<Reply>;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => statements.push(s) });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  call = await clientFor(db, userId);
});

const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const buildRow = async (buildId: string) => (await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, buildId)))[0]!;

async function create(doc: WorkoutDoc, date = today): Promise<string> {
  const res = await call("POST", "/api/workouts", { date, doc });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.workout.id;
}

const check = async (value: number) => {
  const res = await call("POST", "/api/conditions/checks", { profileId: "tmj", value, feelingOff: false });
  expect(res.status).toBe(200);
};

/** Save the started session as the player's review does: one move's two sets. Answers the activity's discipline. */
async function saveSession(workoutId: string, build: Record<string, any>, move: string): Promise<string | undefined> {
  const performedId = "3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
  const now = nowInstant();
  const saved = await savePerformedSession(
    db,
    userId,
    performedId,
    {
      id: performedId, source: "app", sourceRef: null, workoutId, buildId: build.buildId, localDate: today,
      startedAt: now, endedAt: now, seconds: 600, plannedSeconds: build.plannedSeconds, minutes: build.minutes, mode: build.mode,
      theme: null, locationId: build.locationId, blockRef: null, blockNumber: null, completed: true,
      stepsTotal: build.steps.length, stepsDone: build.steps.length,
      movesDone: build.items.map((i: { exerciseId: string }) => ({ exerciseId: i.exerciseId, seconds: 60 })), note: null, newMove: null,
      entries: [{ exerciseId: move, implement: null, format: "holds", perSide: false, sets: [{ setIndex: 0, reps: null, seconds: 60, load: null }] }],
      checks: [], review: {},
    },
    { now, prefs },
  );
  expect(saved.status).toBe("saved");
  const [activity] = await db.select().from(schema.activities).where(eq(schema.activities.id, performedId));
  return activity?.sport;
}

/** Every move a document build's ⇄ may offer: its slots' alternates and offers. */
const offeredIn = (build: { fromDoc?: { slots?: Record<string, { alternates?: Array<{ id: string }>; offers?: Array<{ id: string }> }> } }): string[] =>
  Object.values(build.fromDoc?.slots ?? {}).flatMap((s) => [...(s.alternates ?? []), ...(s.offers ?? [])].map((c) => c.id));

const movesOf = (steps: Array<{ kind: string; exerciseId: string | null }>) => [...new Set(steps.filter((s) => s.kind !== "rest").map((s) => s.exerciseId))];

describe("building a document workout", () => {
  it("is the document's own steps, its snapshot stored beside it; the row keeps what its document says", async () => {
    const doc = calmDoc();
    const id = await create(doc);
    const before = await rowOf(id);
    const res = await call("POST", `/api/sessions/${id}/build`, {});
    expect(res.status).toBe(200);
    const build = res.body.build;
    expect(build.steps).toEqual(playerStepsFromDoc(doc, EXERCISES));
    expect(build).toMatchObject({ version: 1, date: today, mode: "consistent", theme: null, blockRef: null, fromDoc: { rev: 1, swaps: [], blocked: [] } });
    expect(build.engineVersion).toMatch(/^doc-build-/);
    expect(build.items.map((i: { exerciseId: string }) => i.exerciseId)).toEqual(["bridge", "deadBug"]);
    // The moves it plays, and every move ⇄ may offer in their place (offline: their records with them).
    expect(Object.keys(build.exercises).sort()).toEqual([...new Set(["bridge", "deadBug", ...offeredIn(build)])].sort());
    expect(build.exercises.bridge.providers).toBeUndefined();
    expect(res.body.view).toMatchObject({ mode: "consistent", theme: null, block: null, minutes: deriveDoc(doc, EXERCISES).estimatedMinutes });
    expect(res.body).toMatchObject({ contentState: "built", locked: false });
    // Its mode, moves and place are its document's: the sheet is offered no choices (overrides are not read).
    expect(res.body.choices).toEqual({ modes: [], themes: [], locations: [] });
    expect((await call("GET", `/api/sessions/${id}`)).body.choices).toEqual({ modes: [], themes: [], locations: [] });

    expect(JSON.parse((await buildRow(build.buildId)).workoutDoc!)).toEqual(doc);
    const row = await rowOf(id);
    expect(row).toMatchObject({ contentState: "built", title: "Hips and back", workoutDocRev: 1 });
    // Its title, discipline and booked length are its document's (derived when it was made), never the build's.
    const shown = ["title", "category", "sport", "calendarBlockDurationSeconds", "fallbackEstimatedDurationSeconds", "calendarSyncState"] as const;
    for (const k of shown) expect(row[k], k).toEqual(before[k]);

    // The same inputs again: the stored build, nothing written.
    const again = await call("POST", `/api/sessions/${id}/build`, {});
    expect(again.body.build.buildId).toBe(build.buildId);
  });

  it("the player's ⇄ (Task 8): an item's planned alternates ride the build with their steps and records — never a hidden move", async () => {
    const id = await create(landingsDoc());
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    expect(built.status).toBe(200);
    const planned = built.body.build.fromDoc.slots["accessory:0"].alternates;
    expect(planned.map((a: { id: string; reasons: string[] }) => [a.id, a.reasons])).toEqual([["tempoSquat", ["The same legs, no landing."]]]);
    expect(planned[0].steps.length).toBeGreaterThan(0);
    expect(built.body.build.exercises.tempoSquat).toBeDefined();
    // The engine's own swap list stays empty: the sheet offers no ⇄ it cannot rebuild.
    expect(built.body.build.alternatives).toEqual({});
    // Then the library's usual offers, each with its steps and record.
    const offers = built.body.build.fromDoc.slots["accessory:0"].offers;
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) expect(built.body.build.exercises[o.id]).toBeDefined();
    // "Not for me" or 👎 since: never offered, in every response (ruling 2a-R1).
    const thumbsDown = offers[0].id as string;
    await db.insert(schema.exercisePrefs).values([
      { id: `${userId}:tempoSquat`, userId, exerciseId: "tempoSquat", rating: null, excluded: true, pinned: false, introducedOn: null, updatedAt: nowInstant() },
      { id: `${userId}:${thumbsDown}`, userId, exerciseId: thumbsDown, rating: -1, excluded: false, pinned: false, introducedOn: null, updatedAt: nowInstant() },
    ]);
    const shown = (await call("GET", `/api/sessions/${id}`)).body.build;
    expect(offeredIn(shown)).not.toContain("tempoSquat");
    expect(offeredIn(shown)).not.toContain(thumbsDown);
    expect(shown.fromDoc.slots["accessory:0"]?.alternates).toBeUndefined();
  });

  it("the build judges ⇄'s moves with the day, the athlete and the place: one the place's gear can't serve comes last, saying so", async () => {
    const doc = workoutDocSchema.parse({
      ...calmDoc(),
      parts: [{ purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "deadBug", dose: { sets: 2, reps: 8 }, alternates: [{ libraryId: "bandPallofPress", why: "Resists the twist." }, { libraryId: "birdDog" }] },
      ] }],
    });
    const built = (await call("POST", `/api/sessions/${await create(doc)}/build`, {})).body.build;
    const planned = built.fromDoc.slots["core:0"].alternates as Array<{ id: string; reasons: string[] }>;
    expect(planned.map((a) => a.id)).toEqual(["birdDog", "bandPallofPress"]);
    expect(planned[1]!.reasons[0]).toBe("Resists the twist.");
    expect(planned[1]!.reasons[1]).toMatch(/band/i);
  });

  it("the review's basis reads a document's planned alternates too (a move ⇄ may bring in)", async () => {
    await db.insert(schema.exercisePrefs).values({ id: `${userId}:tempoSquat`, userId, exerciseId: "tempoSquat", rating: 1, excluded: false, pinned: false, introducedOn: null, updatedAt: nowInstant() });
    const id = await create(landingsDoc());
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    expect((await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId })).status).toBe(200);
    const basis = await call("GET", `/api/sessions/${id}/review-basis`);
    expect(basis.status).toBe(200);
    expect(basis.body.prefs.ratings).toEqual({ tempoSquat: 1 });
  });

  it("Start locks it, and the build after Start is the locked one", async () => {
    const id = await create(calmDoc());
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    const started = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ locked: true, contentState: "started" });
    expect((await rowOf(id)).contentState).toBe("started");
    const after = await call("POST", `/api/sessions/${id}/build`, {});
    expect(after.status).toBe(409);
    expect(after.body.error).toBe("locked");
  });

  it("moved to another day it is an outline again, keeping its document's title — built again on its new day", async () => {
    const id = await create(calmDoc());
    expect((await call("POST", `/api/sessions/${id}/build`, {})).status).toBe(200);
    await applyMove(db, { userId, workoutId: id, toDate: addDays(today, 1), toTime: "18:00", source: "app", corosWritesEnabled: true });
    expect(await rowOf(id)).toMatchObject({ contentState: "outline", title: "Hips and back", effectiveDate: addDays(today, 1), corosSyncState: "calendar_only" });
  });

  it("a day ahead is a preview (version 0) that never locks", async () => {
    const id = await create(calmDoc(), addDays(today, 2));
    const res = await call("POST", `/api/sessions/${id}/build`, {});
    expect(res.status).toBe(200);
    expect(res.body.build.version).toBe(0);
    expect((await rowOf(id)).contentState).toBe("outline");
    expect((await call("POST", `/api/sessions/${id}/start`, { buildId: res.body.build.buildId })).body.error).toBe("not_today");
  });

  it("a revised document makes the shown build stale: Start answers with the fresh one, made from the new revision", async () => {
    const id = await create(calmDoc());
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    const next = calmDoc({ title: "Hips, back and more" });
    next.parts[0]!.items.push({ kind: "exercise", libraryId: "birdDog", dose: { sets: 2, reps: 6 } });
    expect((await call("PUT", `/api/workouts/${id}/doc`, { doc: next, baseRev: 1 })).status).toBe(200);
    expect((await call("GET", `/api/sessions/${id}/current`)).body.current).toBe(false);
    const stale = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("stale");
    expect(stale.body.session.build.fromDoc.rev).toBe(2);
    expect(stale.body.session.build.steps).toEqual(playerStepsFromDoc(next, EXERCISES));
    const started = await call("POST", `/api/sessions/${id}/start`, { buildId: stale.body.session.build.buildId });
    expect(started.status).toBe(200);
  });

  it("a performed document session is credited with its document's discipline, not the build's slot blocks", async () => {
    // A main part of held stretches: its slots are the build's "core" block, yet the session is mobility (yoga).
    const doc: WorkoutDoc = {
      ...calmDoc({ title: "Long holds" }),
      parts: [
        {
          purpose: "main",
          format: "holds",
          items: [
            { kind: "exercise", libraryId: "lowLunge", dose: { sets: 1, holdSec: 45, perSide: true } },
            { kind: "exercise", libraryId: "puppyFloor", dose: { sets: 1, holdSec: 60 } },
          ],
        },
      ],
    };
    expect(deriveDoc(doc, EXERCISES).discipline).toBe("yoga");
    const id = await create(doc);
    expect((await rowOf(id)).sport).toBe("yoga");
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    expect(built.body.build.items.every((i: { block: string }) => i.block === "core")).toBe(true);
    // The build leaves the row its document's discipline (an engine build's core block would make it strength).
    expect(await rowOf(id)).toMatchObject({ sport: "yoga", category: "yoga" });
    const started = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
    expect(await saveSession(id, started.body.build, "puppyFloor")).toBe("yoga");
    expect(await rowOf(id)).toMatchObject({ completionState: "completed", contentState: "done", sport: "yoga", category: "yoga" });
  });

  it("…and as it was played: a lift the day swapped for a mobility move is credited as mobility", async () => {
    await activateTmj(db, userId);
    await check(1);
    const doc: WorkoutDoc = {
      ...calmDoc({ title: "Landings, gently" }),
      parts: [
        { purpose: "power", format: "straight", items: [{ kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "catCow" }] }] },
        { purpose: "cooldown", format: "holds", items: [{ kind: "exercise", libraryId: "puppyFloor", dose: { sets: 1, holdSec: 60 } }] },
      ],
    };
    const id = await create(doc);
    expect((await rowOf(id)).sport).toBe("strength");
    await check(6);
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    expect(built.body.build.fromDoc.swaps.map((x: { to: string }) => x.to)).toEqual(["catCow"]);
    const started = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
    expect(await saveSession(id, started.body.build, "catCow")).toBe("yoga");
  });

  it("reads no programme: builds, starts and shows its profiles the same with the Studio programme gone", async () => {
    await activateTmj(db, userId);
    const id = await create(calmDoc());
    await db.delete(schema.programs).where(eq(schema.programs.userId, userId));
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    expect(built.status).toBe(200);
    expect(built.body.profiles.map((p: { profileId: string }) => p.profileId)).toEqual(["tmj"]);
    const shown = await call("GET", `/api/sessions/${id}`);
    expect(shown.body.profiles.map((p: { profileId: string }) => p.profileId)).toEqual(["tmj"]);
    expect((await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId })).status).toBe(200);
  });

  it("a stored document too large to build answers 409 too_large with the issue — a build, a preview, Start's fresh build — never a 500", async () => {
    // Twenty sets of an hour's hold: far past the 600 minutes a Worker builds. The validator refuses it when made or
    // revised, so it is written as an older document would have been stored.
    const huge = JSON.stringify({ ...calmDoc(), parts: [{ purpose: "main", format: "holds", items: [{ kind: "exercise", libraryId: "bridge", dose: { sets: 20, holdSec: 3600 } }] }] });
    const tooLarge = { error: "too_large", issues: [expect.objectContaining({ path: "parts", code: "too_large", severity: "error" })] };
    const todays = await create(calmDoc());
    const built = await call("POST", `/api/sessions/${todays}/build`, {});
    await db.update(plannedWorkouts).set({ workoutDoc: huge }).where(eq(plannedWorkouts.id, todays));
    const started = await call("POST", `/api/sessions/${todays}/start`, { buildId: built.body.build.buildId });
    expect(started).toEqual({ status: 409, body: tooLarge });
    expect(await call("POST", `/api/sessions/${todays}/build`, {})).toEqual({ status: 409, body: tooLarge });
    expect((await rowOf(todays)).contentState).toBe("built");
    const ahead = await create(calmDoc({ title: "Ahead" }), addDays(today, 2));
    await db.update(plannedWorkouts).set({ workoutDoc: huge }).where(eq(plannedWorkouts.id, ahead));
    expect(await call("POST", `/api/sessions/${ahead}/build`, {})).toEqual({ status: 409, body: tooLarge });
    expect(await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, ahead))).toEqual([]);
  });

  it("409 no_document for a document row whose document cannot be read; 404 for another user's", async () => {
    const id = await create(calmDoc());
    await db.update(plannedWorkouts).set({ workoutDoc: "{not json" }).where(eq(plannedWorkouts.id, id));
    expect(await call("POST", `/api/sessions/${id}/build`, {})).toEqual({ status: 409, body: { error: "no_document" } });
    const other = await makeTestUser(db);
    const theirs = await (await clientFor(db, other.userId))("POST", "/api/workouts", { date: today, doc: calmDoc() });
    expect((await call("POST", `/api/sessions/${theirs.body.workout.id}/build`, {})).status).toBe(404);
  });
});

describe("Start re-gates with the day's reading", () => {
  beforeEach(async () => {
    await activateTmj(db, userId);
    // A calm jaw: jumps are open when the workout is made and first built.
    await check(1);
  });

  it("a move the day's check now closes swaps to its first passing alternate — shown first, then locked", async () => {
    const doc = landingsDoc();
    const id = await create(doc);
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    expect(movesOf(built.body.build.steps)).toEqual(["snapDown", "bwSplitSquat"]);

    await check(6);
    const stale = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("stale");
    const fresh = stale.body.session.build;
    expect(fresh.fromDoc.swaps).toEqual([{ path: "parts[0].items[0]", from: "snapDown", to: "tempoSquat", reason: expect.stringContaining("Snap") }]);
    expect(fresh.fromDoc.blocked).toEqual([]);
    expect(movesOf(fresh.steps)).toEqual(["tempoSquat", "bwSplitSquat"]);
    // The snapshot is what is played; the row's own document is not revised by the day's swap.
    const snapshot = JSON.parse((await buildRow(fresh.buildId)).workoutDoc!) as WorkoutDoc;
    expect(snapshot.parts[0]!.items[0]).toMatchObject({ kind: "exercise", libraryId: "tempoSquat" });
    expect(JSON.parse((await rowOf(id)).workoutDoc!)).toEqual(doc);

    const started = await call("POST", `/api/sessions/${id}/start`, { buildId: fresh.buildId });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ locked: true, contentState: "started" });
  });

  it("with no passing alternate Start refuses with the issues, and nothing locks", async () => {
    const id = await create(landingsDoc({ alternates: false }));
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    await check(6);
    const refused = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("gated");
    expect(refused.body.issues).toContainEqual(
      expect.objectContaining({ path: "parts[0].items[0].libraryId", code: "condition_gate", severity: "error" }),
    );
    expect((await rowOf(id)).contentState).not.toBe("started");
    // The fresh build was made and holds the reason; Start on it refuses the same way.
    const shown = await call("GET", `/api/sessions/${id}`);
    expect(shown.body.build.fromDoc.blocked).toContainEqual(expect.objectContaining({ code: "condition_gate" }));
    const again = await call("POST", `/api/sessions/${id}/start`, { buildId: shown.body.build.buildId });
    expect(again.body.error).toBe("gated");
    expect(await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, id)).then((b) => b.filter((x) => x.lockedAt !== null))).toEqual([]);
  });

  it("a build made once the day's check closed a move already holds the swap, and Start locks it as shown", async () => {
    const id = await create(landingsDoc());
    await check(6);
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    expect(built.body.build.fromDoc.swaps).toHaveLength(1);
    expect(movesOf(built.body.build.steps)).toEqual(["tempoSquat", "bwSplitSquat"]);
    expect((await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId })).status).toBe(200);
  });

  it("the sheet's own pre-check is the day's reading too", async () => {
    const id = await create(landingsDoc());
    const built = await call("POST", `/api/sessions/${id}/build`, { checks: { tmj: { pre: 7, feelingOff: false } } });
    expect(built.body.checks).toEqual({ tmj: { pre: 7, feelingOff: false } });
    expect(built.body.build.fromDoc.swaps.map((s: { to: string }) => s.to)).toEqual(["tempoSquat"]);
  });

  it("Start of a sent build takes off what ⇄ offers that the day's check now closes — kept so — and plays what was sent", async () => {
    const doc = workoutDocSchema.parse({
      ...landingsDoc(),
      parts: [{ purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "tempoSquat", dose: { sets: 2, reps: 5, restSec: 45 }, alternates: [{ libraryId: "snapDown", why: "Land softly." }, { libraryId: "bwSplitSquat" }] },
      ] }],
    });
    const id = await create(doc);
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    expect(built.body.build.fromDoc.slots["core:0"].alternates.map((a: { id: string }) => a.id)).toEqual(["snapDown", "bwSplitSquat"]);
    await lockCurrentBuild(db, userId, id, built.body.build.buildId, nowInstant(), { as: "send", prefs });
    await db.insert(schema.corosWriteJobs).values({
      id: `push:${built.body.build.buildId}`, userId, workoutId: id, kind: "program_session_push", expectedContentFingerprint: "fp",
      originalDate: today, destinationDate: today, requestedAt: nowInstant(), updatedAt: nowInstant(), status: "verified",
    });
    await check(6);
    const started = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
    expect(started.status).toBe(200);
    expect(started.body.contentState).toBe("started");
    expect(started.body.build.buildId).toBe(built.body.build.buildId);
    expect(started.body.build.steps).toEqual(built.body.build.steps);
    expect(started.body.build.fromDoc.slots["core:0"].alternates.map((a: { id: string }) => a.id)).toEqual(["bwSplitSquat"]);
    expect(offeredIn(started.body.build)).not.toContain("snapDown");
    // Kept so: every later read shows the same.
    expect((await call("GET", `/api/sessions/${id}`)).body.build.fromDoc.slots).toEqual(started.body.build.fromDoc.slots);
  });

  it("Send re-gates too, and a sent build that the day's check now closes cannot Start", async () => {
    const id = await create(landingsDoc({ alternates: false }));
    const other = await create(landingsDoc({ alternates: false, title: "Second" }));
    const built = await call("POST", `/api/sessions/${id}/build`, {});
    const second = await call("POST", `/api/sessions/${other}/build`, {});
    await lockCurrentBuild(db, userId, id, built.body.build.buildId, nowInstant(), { as: "send", prefs });
    await check(6);
    // A push names the sent build (the watch switch is off in tests, so the job is written by hand).
    await db.insert(schema.corosWriteJobs).values({
      id: `push:${built.body.build.buildId}`, userId, workoutId: id, kind: "program_session_push", expectedContentFingerprint: "fp",
      originalDate: today, destinationDate: today, requestedAt: nowInstant(), updatedAt: nowInstant(), status: "verified",
    });
    const refused = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("gated");
    expect((await rowOf(id)).contentState).toBe("built");

    // Send of a build the day's check has since closed: the fresh build is blocked, and nothing locks.
    await expect(lockCurrentBuild(db, userId, other, second.body.build.buildId, nowInstant(), { as: "send", prefs })).rejects.toBeInstanceOf(GatedError);
  });

  it("build and Start each stay within the statement budget (≤ 45)", async () => {
    const id = await create(landingsDoc());
    statements.length = 0;
    const built = await call("POST", `/api/sessions/${id}/build`, { checks: { tmj: { pre: 6, feelingOff: false } } });
    expect(built.status).toBe(200);
    expect(statements.length).toBeLessThanOrEqual(45);
    await check(1);
    statements.length = 0;
    const stale = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
    expect(stale.body.error).toBe("stale");
    expect(statements.length).toBeLessThanOrEqual(45);
    statements.length = 0;
    expect((await call("POST", `/api/sessions/${id}/start`, { buildId: stale.body.session.build.buildId })).status).toBe(200);
    expect(statements.length).toBeLessThanOrEqual(45);
  });
});
