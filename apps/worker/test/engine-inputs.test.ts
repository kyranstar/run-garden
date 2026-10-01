/**
 * The session engine's inputs, read from the database (Phase 2 spec §2a "Build API" → Inputs):
 * history = every performed session of the user (all sources) with its sets and checks; program state = the
 * program's latest `program_blocks` row; prefs, saved ids, the place, the weight unit, and the active / cared-for
 * condition profiles.
 *
 * Fixed dates throughout: nothing here reads a clock.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId, type AdaptiveConfig, type UserPreferences } from "@rg/domain";
import { LOCATION_PRESETS } from "@rg/exercise-library";
import type { Block } from "@rg/session-engine";
import type { Db } from "../src/services/db.js";
import {
  loadEngineContext,
  loadHistory,
  loadProgramState,
  saveProgramState,
} from "../src/services/engine-inputs.js";
import { isWrite, makeTestDb, makeTestUser } from "./helpers.js";

const {
  performedSessions,
  performedSets,
  conditionChecks,
  programs,
  programBlocks,
  userConditions,
  locations,
  exercisePrefs,
  exerciseProvenance,
  accountState,
} = schema;

const NOW = "2026-10-05T12:00:00.000Z";

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
});

interface SetSeed {
  entry: number;
  exerciseId: string;
  setIndex: number;
  reps?: number | null;
  seconds?: number | null;
  load?: { v: number; u: string } | null;
  perSide?: boolean;
  format?: string | null;
  implement?: string | null;
  done?: boolean;
  flags?: string[];
}

async function seedSession(
  owner: string,
  o: {
    id?: string;
    date: string;
    startedAt?: string | null;
    mode?: string | null;
    theme?: string | null;
    blockNumber?: number | null;
    workoutId?: string | null;
    source?: string;
    sets?: SetSeed[];
    movesDone?: Array<{ exerciseId: string; seconds: number }>;
  },
): Promise<string> {
  const id = o.id ?? newId();
  await db.insert(performedSessions).values({
    id,
    userId: owner,
    workoutId: o.workoutId ?? null,
    activityId: null,
    buildId: null,
    source: o.source ?? "app",
    sourceRef: o.source === "import" ? `ref-${id}` : null,
    localDate: o.date,
    startedAt: o.startedAt === undefined ? `${o.date}T17:00:00.000Z` : o.startedAt,
    endedAt: null,
    seconds: 1800,
    plannedSeconds: 1800,
    minutes: 30,
    mode: o.mode ?? "consistent",
    theme: o.theme ?? null,
    locationId: null,
    blockRef: null,
    blockNumber: o.blockNumber ?? null,
    completed: true,
    stepsTotal: 10,
    stepsDone: 10,
    movesDone: o.movesDone ?? [],
    note: null,
    newMove: null,
    payloadHash: "h",
    createdAt: NOW,
    updatedAt: NOW,
  });
  for (const s of o.sets ?? []) {
    await db.insert(performedSets).values({
      id: newId(),
      performedSessionId: id,
      entryIndex: s.entry,
      exerciseId: s.exerciseId,
      implement: s.implement ?? null,
      format: s.format === undefined ? "straight" : s.format,
      perSide: s.perSide ?? false,
      setIndex: s.setIndex,
      side: null,
      reps: s.reps ?? null,
      seconds: s.seconds ?? null,
      loadValue: s.load ? s.load.v : null,
      loadUnit: s.load ? s.load.u : null,
      loadKg: null,
      done: s.done ?? true,
      flags: s.flags ?? [],
    });
  }
  return id;
}

async function seedCheck(
  owner: string,
  o: {
    profileId?: string;
    kind: "pre" | "post" | "daily";
    value: number | null;
    feelingOff?: boolean;
    date: string;
    performedSessionId?: string | null;
    workoutId?: string | null;
  },
): Promise<void> {
  await db.insert(conditionChecks).values({
    id: newId(),
    userId: owner,
    profileId: o.profileId ?? "tmj",
    kind: o.kind,
    value: o.value,
    feelingOff: o.feelingOff ?? false,
    localDate: o.date,
    at: `${o.date}T16:00:00.000Z`,
    performedSessionId: o.performedSessionId ?? null,
    workoutId: o.workoutId ?? null,
  });
}

async function seedProgram(owner: string, config: Partial<AdaptiveConfig> = {}): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id,
    userId: owner,
    kind: "adaptive",
    name: "Mobility",
    status: "active",
    disciplines: ["yoga", "strength"],
    startDate: null,
    endDate: null,
    raceDate: null,
    source: null,
    config: adaptiveConfigSchema.parse(config),
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  });
  return id;
}

async function seedLocation(
  owner: string,
  o: { id?: string; name: string; equipment?: string[]; implements?: Record<string, unknown>; isDefault?: boolean; createdAt?: string },
): Promise<string> {
  const id = o.id ?? newId();
  await db.insert(locations).values({
    id,
    userId: owner,
    name: o.name,
    equipment: o.equipment ?? ["mat"],
    implements: o.implements ?? {},
    isDefault: o.isDefault ?? false,
    createdAt: o.createdAt ?? NOW,
    updatedAt: NOW,
  });
  return id;
}

describe("loadHistory", () => {
  it("maps sessions, sets (weights as typed), flags, per-side, formats and checks per profile, date-ascending", async () => {
    const later = await seedSession(userId, {
      date: "2026-09-20",
      mode: "build",
      theme: "hipsPosture",
      blockNumber: 2,
      movesDone: [{ exerciseId: "chinTuck", seconds: 45 }],
      sets: [
        { entry: 0, exerciseId: "gobletSquat", setIndex: 0, reps: 8, load: { v: 25, u: "lb" }, implement: "kettlebell", flags: ["clenched"] },
        { entry: 0, exerciseId: "gobletSquat", setIndex: 1, reps: 7, load: { v: 12, u: "kg" }, implement: "kettlebell", flags: ["clenched"] },
        // Not done: never history.
        { entry: 0, exerciseId: "gobletSquat", setIndex: 2, reps: null, load: null, done: false },
        { entry: 1, exerciseId: "splitSquat", setIndex: 0, reps: 6, perSide: true, format: "superset" },
        { entry: 2, exerciseId: "jawOpen", setIndex: 0, seconds: 40, format: "holds" },
        // An entry with no done set is dropped.
        { entry: 3, exerciseId: "rdl", setIndex: 0, reps: 5, done: false },
      ],
    });
    const earlier = await seedSession(userId, { date: "2026-09-18", mode: "recovery", sets: [] });
    await seedCheck(userId, { kind: "pre", value: 2, date: "2026-09-20", performedSessionId: later });
    await seedCheck(userId, { kind: "post", value: 3, date: "2026-09-20", performedSessionId: later });
    await seedCheck(userId, { kind: "pre", value: null, feelingOff: true, date: "2026-09-18", performedSessionId: earlier });
    // A daily check is not a session's check.
    await seedCheck(userId, { kind: "daily", value: 6, date: "2026-09-20" });

    const history = await loadHistory(db, userId);
    expect(history.map((s) => s.id)).toEqual([earlier, later]);
    expect(history[0]).toEqual({
      id: earlier,
      date: "2026-09-18",
      startedAt: "2026-09-18T17:00:00.000Z",
      mode: "recovery",
      theme: null,
      blockNumber: null,
      checks: { tmj: { pre: null, post: null, feelingOff: true } },
      done: [],
      entries: [],
    });
    expect(history[1]).toEqual({
      id: later,
      date: "2026-09-20",
      startedAt: "2026-09-20T17:00:00.000Z",
      mode: "build",
      theme: "hipsPosture",
      blockNumber: 2,
      checks: { tmj: { pre: 2, post: 3, feelingOff: false } },
      done: [{ id: "chinTuck", secs: 45 }],
      entries: [
        {
          id: "gobletSquat",
          implement: "kettlebell",
          perSide: false,
          format: "straight",
          flags: ["clenched"],
          sets: [
            { w: { v: 25, u: "lb" }, reps: 8, secs: null },
            { w: { v: 12, u: "kg" }, reps: 7, secs: null },
          ],
        },
        { id: "splitSquat", implement: null, perSide: true, format: "superset", flags: [], sets: [{ w: null, reps: 6, secs: null }] },
        { id: "jawOpen", implement: null, perSide: false, format: "holds", flags: [], sets: [{ w: null, reps: null, secs: 40 }] },
      ],
    });
  });

  it("keeps every source, and a pre-check recorded for the slot before the save belongs to that session", async () => {
    const app = await seedSession(userId, { date: "2026-09-21", workoutId: "slot-x" });
    const imported = await seedSession(userId, { date: "2026-09-10", source: "import", startedAt: null });
    // Recorded by the session sheet before Start: linked to the workout and date, not yet to the session.
    await seedCheck(userId, { kind: "pre", value: 1, date: "2026-09-21", workoutId: "slot-x" });
    // Another day's pre-check for the same slot id is not this session's.
    await seedCheck(userId, { kind: "pre", value: 7, date: "2026-09-22", workoutId: "slot-x" });
    const history = await loadHistory(db, userId);
    expect(history.map((s) => s.id)).toEqual([imported, app]);
    expect(history[0]!.startedAt).toBeNull();
    expect(history[1]!.checks).toEqual({ tmj: { pre: 1, post: null, feelingOff: false } });
  });

  it("passes an exercise id the library no longer has through unchanged (the engine ignores it)", async () => {
    await seedSession(userId, {
      date: "2026-09-20",
      movesDone: [{ exerciseId: "retiredMove", seconds: 30 }],
      sets: [{ entry: 0, exerciseId: "retiredMove", setIndex: 0, reps: 10, format: "straight" }],
    });
    const [s] = await loadHistory(db, userId);
    expect(s!.done).toEqual([{ id: "retiredMove", secs: 30 }]);
    expect(s!.entries.map((e) => e.id)).toEqual(["retiredMove"]);
  });

  it("never mixes two users", async () => {
    const { userId: other } = await makeTestUser(db);
    const mine = await seedSession(userId, { date: "2026-09-20", sets: [{ entry: 0, exerciseId: "rdl", setIndex: 0, reps: 5 }] });
    const theirs = await seedSession(other, { date: "2026-09-20", sets: [{ entry: 0, exerciseId: "deadlift", setIndex: 0, reps: 3 }] });
    await seedCheck(other, { kind: "pre", value: 9, date: "2026-09-20", performedSessionId: theirs });
    const history = await loadHistory(db, userId);
    expect(history.map((s) => s.id)).toEqual([mine]);
    expect(history[0]!.entries.map((e) => e.id)).toEqual(["rdl"]);
    expect(history[0]!.checks).toEqual({});
    expect((await loadHistory(db, other)).map((s) => s.id)).toEqual([theirs]);
  });

  it("reads a long history within D1's bound-variable cap", async () => {
    for (let i = 0; i < 130; i++) {
      const date = `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}`;
      await seedSession(userId, { id: `s-${String(i).padStart(3, "0")}`, date, sets: [{ entry: 0, exerciseId: "rdl", setIndex: 0, reps: 5 }] });
    }
    const history = await loadHistory(db, userId);
    expect(history).toHaveLength(130);
    expect(history.every((s) => s.entries.length === 1)).toBe(true);
  });

  it("is empty for an account with no sessions", async () => {
    expect(await loadHistory(db, userId)).toEqual([]);
  });
});

describe("loadProgramState / saveProgramState", () => {
  const block = (over: Partial<Block> = {}): Block => ({
    id: "b1",
    number: 1,
    startedAt: "2026-09-14",
    weeks: 5,
    core: { squat: "gobletSquat", hinge: "rdl", row: null, press: null, carry: null },
    rotations: [],
    ...over,
  });

  it("is null before the first block", async () => {
    const p = await seedProgram(userId);
    expect(await loadProgramState(db, p)).toBeNull();
  });

  it("round-trips a block with rotations, keeping the row's id", async () => {
    const p = await seedProgram(userId);
    const b = block({
      rotations: [{ family: "hinge", from: "deadlift", to: "rdl", date: "2026-09-21", why: "clenched in 2 of the last 3 sessions" }],
    });
    const rowId = await saveProgramState(db, p, b, NOW);
    const loaded = await loadProgramState(db, p);
    expect(loaded).toEqual({ ...b, id: rowId });
    const [row] = await db.select().from(programBlocks).where(eq(programBlocks.programId, p));
    expect(row).toMatchObject({
      id: rowId,
      number: 1,
      kind: "core_block",
      startDate: "2026-09-14",
      weeks: 5,
      intent: { core: b.core, rotations: b.rotations },
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("updates the intent of the same block number, and inserts the next number as a new row", async () => {
    const p = await seedProgram(userId);
    const first = await saveProgramState(db, p, block(), NOW);
    const later = "2026-09-22T08:00:00.000Z";
    const rotated = block({
      id: first,
      core: { ...block().core, squat: "boxSquat" },
      rotations: [{ family: "squat", from: "gobletSquat", to: "boxSquat", date: "2026-09-22", why: "no progress in 3 sessions" }],
    });
    expect(await saveProgramState(db, p, rotated, later)).toBe(first);
    let rows = await db.select().from(programBlocks).where(eq(programBlocks.programId, p));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first, createdAt: NOW, updatedAt: later, intent: { core: rotated.core } });

    // The engine starts block 2 with its own id ("b2"); the row gets a unique id and becomes the latest.
    const next = block({ id: "b2", number: 2, startedAt: "2026-10-19", core: { ...block().core, hinge: "deadlift" } });
    const second = await saveProgramState(db, p, next, later);
    expect(second).not.toBe(first);
    expect(second).not.toBe("b2");
    rows = await db.select().from(programBlocks).where(eq(programBlocks.programId, p));
    expect(rows).toHaveLength(2);
    expect(await loadProgramState(db, p)).toEqual({ ...next, id: second });
  });

  it("two programs keep their own blocks", async () => {
    const a = await seedProgram(userId);
    const b = await seedProgram(userId);
    await saveProgramState(db, a, block(), NOW);
    expect(await loadProgramState(db, b)).toBeNull();
  });

  it("writes nothing while a restore is replacing the account", async () => {
    const p = await seedProgram(userId);
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: NOW, updatedAt: NOW });
    statements.length = 0;
    await saveProgramState(db, p, block(), NOW);
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await loadProgramState(db, p)).toBeNull();
  });
});

describe("loadEngineContext", () => {
  async function activate(owner: string, profileId: string, active = true): Promise<void> {
    await db.insert(userConditions).values({
      id: `${owner}:${profileId}`,
      userId: owner,
      profileId,
      active,
      since: "2026-09-01",
      settings: {},
    });
  }

  it("reads prefs, saved ids, the weight unit, active profiles and care = config ∩ active", async () => {
    ({ userId, prefs } = await makeTestUser(db, { weightUnit: "kg" }));
    const p = await seedProgram(userId, { careProfiles: ["tmj"] });
    await activate(userId, "tmj");
    const prefRow = (exerciseId: string, o: { rating?: number | null; excluded?: boolean; pinned?: boolean }) => ({
      id: `${userId}:${exerciseId}`,
      userId,
      exerciseId,
      rating: o.rating ?? null,
      excluded: o.excluded ?? false,
      pinned: o.pinned ?? false,
      introducedOn: null,
      updatedAt: NOW,
    });
    await db.insert(exercisePrefs).values([
      prefRow("rdl", { rating: 1, pinned: true }),
      prefRow("deadlift", { rating: -1 }),
      prefRow("jawOpen", { excluded: true }),
      prefRow("boxSquat", {}),
    ]);
    const provenance = (exerciseId: string, key: string) => ({
      id: newId(),
      userId,
      exerciseId,
      sourceType: "video",
      url: null,
      creator: null,
      sourceKey: key,
      createdAt: NOW,
    });
    await db.insert(exerciseProvenance).values([provenance("chinTuck", "a"), provenance("chinTuck", "b"), provenance("rdl", "c")]);
    // Someone else's settings never leak in.
    const { userId: other } = await makeTestUser(db);
    await db.insert(exercisePrefs).values({ ...prefRow("stepUp", { rating: 1 }), id: `${other}:stepUp`, userId: other });

    const ctx = await loadEngineContext(db, userId, p, {});
    expect(ctx.prefs).toEqual({ ratings: { deadlift: -1, rdl: 1 }, excluded: ["jawOpen"], pinned: ["rdl"] });
    expect(ctx.savedIds).toEqual(["chinTuck", "rdl"]);
    expect(ctx.unit).toBe("kg");
    expect(ctx.activeProfiles).toEqual(["tmj"]);
    expect(ctx.careProfiles).toEqual(["tmj"]);
  });

  it("cares only for profiles that are active; inactive and unknown profiles are not active", async () => {
    const p = await seedProgram(userId, { careProfiles: ["tmj"] });
    await activate(userId, "tmj", false);
    await activate(userId, "notAProfile");
    const ctx = await loadEngineContext(db, userId, p, {});
    expect(ctx.activeProfiles).toEqual([]);
    expect(ctx.careProfiles).toEqual([]);
    expect(ctx.prefs).toEqual({ ratings: {}, excluded: [], pinned: [] });
    expect(ctx.savedIds).toEqual([]);
    expect(ctx.unit).toBe("lb");
  });

  it("the place: the override, else the program's, else the default place, else the first", async () => {
    const first = await seedLocation(userId, { name: "Studio", createdAt: "2026-09-01T00:00:00.000Z" });
    const second = await seedLocation(userId, { name: "Garage", createdAt: "2026-09-02T00:00:00.000Z" });
    const p = await seedProgram(userId);
    expect((await loadEngineContext(db, userId, p, {})).location.id).toBe(first);

    const home = await seedLocation(userId, { name: "Home", isDefault: true, createdAt: "2026-09-03T00:00:00.000Z" });
    const ctx = await loadEngineContext(db, userId, p, {});
    expect(ctx.location.id).toBe(home);
    // Blocks are judged with the default place's gear: it comes first.
    expect(ctx.locations.map((l) => l.id)).toEqual([home, first, second]);

    const withDefault = await seedProgram(userId, { defaultLocationId: second });
    expect((await loadEngineContext(db, userId, withDefault, {})).location.id).toBe(second);
    expect((await loadEngineContext(db, userId, withDefault, { locationId: first })).location.id).toBe(first);

    // Another user's place, or one that no longer exists, is not a place for this user.
    const { userId: other } = await makeTestUser(db);
    const theirs = await seedLocation(other, { name: "Theirs" });
    expect((await loadEngineContext(db, userId, p, { locationId: theirs })).location.id).toBe(home);
    expect((await loadEngineContext(db, userId, p, { locationId: "gone" })).location.id).toBe(home);
  });

  it("parses implement weights from the stored typed list", async () => {
    ({ userId, prefs } = await makeTestUser(db, { weightUnit: "kg" }));
    await seedLocation(userId, {
      name: "Home",
      isDefault: true,
      equipment: ["mat", "kettlebell"],
      implements: { kettlebell: "8, 12, 16", dumbbells: "10, 15 lb", band: "" },
    });
    const p = await seedProgram(userId);
    const { location } = await loadEngineContext(db, userId, p, {});
    expect(location).toEqual({
      id: location.id,
      name: "Home",
      equipment: ["mat", "kettlebell"],
      implements: {
        kettlebell: [{ v: 8, u: "kg" }, { v: 12, u: "kg" }, { v: 16, u: "kg" }],
        dumbbells: [{ v: 10, u: "lb" }, { v: 15, u: "lb" }],
        band: [],
      },
    });
  });

  it("with no place at all, sessions plan for the library's Home preset", async () => {
    const p = await seedProgram(userId);
    const { location, locations: all } = await loadEngineContext(db, userId, p, {});
    const preset = LOCATION_PRESETS.find((l) => l.id === "home")!;
    expect(location).toEqual({ id: "home", name: "Home", equipment: [...preset.equipment], implements: {} });
    expect(all).toEqual([location]);
  });

  it("refuses another user's program", async () => {
    const { userId: other } = await makeTestUser(db);
    const theirs = await seedProgram(other);
    await expect(loadEngineContext(db, userId, theirs, {})).rejects.toThrow("program_not_found");
  });
});
