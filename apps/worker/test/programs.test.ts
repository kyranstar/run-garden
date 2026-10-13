/**
 * Adaptive programs: create, list, update (Phase 2 spec §2a "Programs API").
 *
 * The service tests pass `today` and `now` explicitly, so their fixed dates cannot go stale; the route tests use
 * the real today, because the routes do.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { EQUIPMENT_IDS, EXERCISES, TMJ } from "@rg/exercise-library";
import { quickStartDoc } from "@rg/workout";
import {
  adaptiveConfigSchema,
  addDays,
  daysBetween,
  isWeekend,
  newId,
  nowInstant,
  startOfIsoWeek,
  todayInZone,
  type UserPreferences,
} from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import {
  createAdaptiveProgram,
  listPrograms,
  ProgramNotFoundError,
  RestoreInProgressError,
  updateProgram,
} from "../src/services/programs.js";
import { programRoutes } from "../src/routes/programs.js";
import { slotId } from "../src/services/program-slots.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { programs, programBlocks, plannedWorkouts, accountState } = schema;

/** A Monday. */
const MON = "2026-10-05";
const T0 = "2026-10-05T12:00:00.000Z";
const T1 = "2026-10-06T09:30:00.000Z";

let db: Db;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db));
});

const config = (over: Record<string, unknown> = {}) => adaptiveConfigSchema.parse(over);

async function programRow(id: string) {
  const [p] = await db.select().from(programs).where(eq(programs.id, id));
  return p!;
}

describe("the service", () => {
  it("creates an active adaptive program with the config validated and its defaults filled", async () => {
    const id = await createAdaptiveProgram(db, userId, { name: "  Mobility  ", config: config({ weeklyGoal: 3 }) }, T0);
    expect(await programRow(id)).toMatchObject({
      id,
      userId,
      kind: "adaptive",
      name: "Mobility",
      status: "active",
      disciplines: ["yoga", "strength"],
      config: config({ weeklyGoal: 3 }),
      source: null,
      createdAt: T0,
      updatedAt: T0,
      archivedAt: null,
    });
  });

  it("refuses an invalid config or an empty name and writes nothing", async () => {
    await expect(
      createAdaptiveProgram(db, userId, { name: "x", config: { ...config(), weeklyGoal: 9 } }, T0),
    ).rejects.toThrow();
    await expect(createAdaptiveProgram(db, userId, { name: "   ", config: config() }, T0)).rejects.toThrow();
    expect(await db.select().from(programs)).toEqual([]);
  });

  it("lists only this user's adaptive programs, with this week's slots against the goal", async () => {
    const mine = await createAdaptiveProgram(db, userId, { name: "Mobility", config: config({ weeklyGoal: 4 }) }, T0);
    const retired = await createAdaptiveProgram(db, userId, { name: "Old", config: config() }, T0);
    await updateProgram(db, userId, retired, { status: "retired" }, T1);
    const { userId: other } = await makeTestUser(db);
    await createAdaptiveProgram(db, other, { name: "Theirs", config: config() }, T0);
    await db.insert(programs).values({
      id: newId(),
      userId,
      kind: "coach",
      name: "A coach plan",
      status: "active",
      disciplines: ["run"],
      startDate: null,
      endDate: null,
      raceDate: null,
      source: null,
      config: {},
      createdAt: T0,
      updatedAt: T0,
      archivedAt: null,
    });
    // This week (by where a slot sits now): three live slots, one done; one archived, one next week.
    const slot = async (date: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}) =>
      db.insert(plannedWorkouts).values({
        id: slotId(mine, date),
        userId,
        planId: mine,
        sourceWorkoutId: slotId(mine, date),
        title: "Mobility",
        category: "yoga",
        sport: "yoga",
        originalPlanDate: date,
        lastVerifiedCorosDate: "",
        effectiveDate: date,
        effectiveTime: "07:00",
        sourceContentFingerprint: "program",
        calendarBlockDurationSeconds: 1800,
        corosSyncState: "calendar_only",
        origin: "program",
        contentState: "outline",
        createdAt: T0,
        updatedAt: T0,
        ...over,
      });
    await slot(addDays(MON, 0), { completionState: "completed", contentState: "done" });
    await slot(addDays(MON, 2));
    await slot(addDays(MON, 4));
    await slot(addDays(MON, 5), { archivedAt: T0, archiveReason: "program_replaced" });
    await slot(addDays(MON, 7));

    const list = await listPrograms(db, userId, addDays(MON, 3));
    expect(list.map((p) => [p.name, p.status]).sort()).toEqual([
      ["Mobility", "active"],
      ["Old", "retired"],
    ]);
    const dto = list.find((p) => p.id === mine)!;
    expect(dto).toEqual({
      id: mine,
      kind: "adaptive",
      name: "Mobility",
      status: "active",
      config: config({ weeklyGoal: 4 }),
      block: null,
      week: { placed: 3, done: 1, goal: 4 },
    });
  });

  it("a care-only programme (recovery alone, its care switch on) counts this week's completed Studio condition care; a mixed one does not (CUJ R13)", async () => {
    const careOnly = await createAdaptiveProgram(db, userId, { name: "Jaw care", config: config({ weeklyGoal: 2, modes: ["recovery"], careProfiles: ["tmj"] }) }, T0);
    const mixed = await createAdaptiveProgram(db, userId, { name: "Strength", config: config({ weeklyGoal: 3, careProfiles: ["tmj"] }) }, T0);
    const noSwitch = await createAdaptiveProgram(db, userId, { name: "Easy days", config: config({ weeklyGoal: 2, modes: ["recovery"] }) }, T0);
    const oneOther = await createAdaptiveProgram(db, userId, { name: "Steady", config: config({ weeklyGoal: 2, modes: ["consistent"], careProfiles: ["tmj"] }) }, T0);
    const ctx = { activeProfiles: [TMJ], day: null, focusRefs: [], recentIds: [], pinned: [], excluded: [], equipment: EQUIPMENT_IDS, seed: 3 };
    const care = quickStartDoc("condition_care", EXERCISES, ctx);
    const hips = quickStartDoc("hip_opener", EXERCISES, ctx);
    if (!("doc" in care) || !("doc" in hips)) throw new Error("no quick start");
    const studio = (id: string, date: string, doc: unknown, over: Partial<typeof plannedWorkouts.$inferInsert> = {}) =>
      db.insert(plannedWorkouts).values({
        id, userId, planId: `studio-${userId}`, sourceWorkoutId: id, title: "Studio", category: "yoga", sport: "yoga", originalPlanDate: date,
        lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "studio", calendarBlockDurationSeconds: 600,
        corosSyncState: "calendar_only", origin: "studio", contentState: "done", completionState: "completed", workoutDoc: JSON.stringify(doc),
        createdAt: T0, updatedAt: T0, ...over,
      });
    await studio("care-done", addDays(MON, 1), care.doc);
    await studio("care-template", addDays(MON, 2), care.doc, { origin: "template" });
    // Not counted: one still to do, one removed, one last week, and a hip opener (no condition care).
    await studio("care-todo", addDays(MON, 3), care.doc, { contentState: "outline", completionState: "scheduled" });
    await studio("care-removed", addDays(MON, 1), care.doc, { archivedAt: T0 });
    await studio("care-last-week", addDays(MON, -2), care.doc);
    await studio("hips-done", addDays(MON, 1), hips.doc);
    // Nor a session that is more than care (a main part too), nor a care part holding no care move.
    const squat = { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 2, reps: 8 } };
    await studio("care-and-lifts", addDays(MON, 1), { ...care.doc, parts: [...care.doc.parts, { purpose: "main", format: "straight", items: [squat] }] });
    await studio("care-of-squats", addDays(MON, 1), { ...care.doc, parts: [{ purpose: "care", format: "straight", items: [squat] }] });
    // The programme's own slot, done with the same care document: counted once, as its slot.
    await studio("slot-done", addDays(MON, 2), care.doc, { origin: "program", planId: careOnly });
    const list = await listPrograms(db, userId, addDays(MON, 3));
    const week = (id: string) => list.find((p) => p.id === id)!.week;
    expect(week(careOnly)).toEqual({ placed: 1, done: 3, goal: 2 });
    // Its lifts and other sessions are not care: a mixed programme counts its own slots alone.
    expect(week(mixed)).toEqual({ placed: 0, done: 0, goal: 3 });
    expect(week(noSwitch)).toEqual({ placed: 0, done: 0, goal: 2 });
    expect(week(oneOther)).toEqual({ placed: 0, done: 0, goal: 2 });
  });

  it("with no care-only programme, the list reads no Studio sessions", async () => {
    const seen: string[] = [];
    const counted = makeTestDb({ boundVariableCap: 100, onStatement: (s) => seen.push(s) });
    const { userId: u } = await makeTestUser(counted);
    await createAdaptiveProgram(counted, u, { name: "Strength", config: config({ careProfiles: ["tmj"] }) }, T0);
    seen.length = 0;
    await listPrograms(counted, u, addDays(MON, 3));
    expect(seen.filter((s) => /workout_doc/.test(s))).toEqual([]);
  });

  it("summarises the latest block: number, week of weeks, and the core lift per family with its name", async () => {
    const id = await createAdaptiveProgram(db, userId, { name: "Strength", config: config() }, T0);
    const block = (number: number, startDate: string, core: Record<string, string | null>) =>
      db.insert(programBlocks).values({
        id: newId(),
        programId: id,
        number,
        kind: "core_block",
        startDate,
        weeks: 5,
        intent: { core, rotations: [] },
        createdAt: T0,
        updatedAt: T0,
      });
    await block(1, addDays(MON, -60), { squat: "boxSquat" });
    await block(2, addDays(MON, -8), { hinge: null, squat: "gobletSquat", row: "notInTheLibrary" });

    const [dto] = await listPrograms(db, userId, MON);
    expect(dto!.block).toEqual({
      number: 2,
      week: 2,
      weeks: 5,
      // Family order is the library's (squat, hinge, row, press, carry), not the stored key order.
      core: [
        { family: "squat", exerciseId: "gobletSquat", name: "Goblet squat" },
        { family: "hinge", exerciseId: null, name: null },
        { family: "row", exerciseId: "notInTheLibrary", name: null },
      ],
    });
  });

  it("update merges the config, renames, and bumps updated_at", async () => {
    const id = await createAdaptiveProgram(
      db,
      userId,
      { name: "Mobility", config: config({ weeklyGoal: 4, preferredDays: [0, 2] }) },
      T0,
    );
    await updateProgram(db, userId, id, { name: "Mobility and jaw", config: { weeklyGoal: 2 } }, T1);
    expect(await programRow(id)).toMatchObject({
      name: "Mobility and jaw",
      config: config({ weeklyGoal: 2, preferredDays: [0, 2] }),
      createdAt: T0,
      updatedAt: T1,
    });
  });

  it("update refuses a merged config that is invalid, and a program that is not this user's", async () => {
    const id = await createAdaptiveProgram(db, userId, { name: "Mobility", config: config() }, T0);
    await expect(updateProgram(db, userId, id, { config: { blockWeeks: 9 } }, T1)).rejects.toThrow();
    expect((await programRow(id)).updatedAt).toBe(T0);
    const { userId: other } = await makeTestUser(db);
    await expect(updateProgram(db, other, id, { name: "Mine now" }, T1)).rejects.toBeInstanceOf(ProgramNotFoundError);
    await expect(updateProgram(db, userId, "nope", { name: "x" }, T1)).rejects.toBeInstanceOf(ProgramNotFoundError);
  });

  it("writes nothing for an account a restore is replacing", async () => {
    const writes: string[] = [];
    const recDb = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => isWrite(sql) && writes.push(sql) });
    const { userId: u } = await makeTestUser(recDb);
    const id = await createAdaptiveProgram(recDb, u, { name: "Mobility", config: config() }, T0);
    await recDb.insert(accountState).values({ userId: u, restoreId: newId(), restoreStartedAt: T0, updatedAt: T0 });
    writes.length = 0;

    await expect(createAdaptiveProgram(recDb, u, { name: "Another", config: config() }, T1)).rejects.toBeInstanceOf(
      RestoreInProgressError,
    );
    await updateProgram(recDb, u, id, { name: "Renamed", status: "retired" }, T1);
    expect(writes).toEqual([]);
  });
});

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
  } as Env;
}

describe("the routes", () => {
  let cookie: string;
  beforeEach(async () => {
    cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  });

  const call = (method: string, path: string, body?: unknown, as: string = cookie) =>
    mountRoutes(db, "/api/programs", programRoutes).request(
      path,
      {
        method,
        headers: { Cookie: as, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      makeEnv(),
    );

  it("POST validates the config: 422 with the issues, nothing written", async () => {
    const res = await call("POST", "/api/programs", {
      name: "Mobility",
      config: { weeklyGoal: 9, preferredDays: [1, 1], surprise: true },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; issues: Array<{ path: Array<string | number> }> };
    expect(body.error).toBe("invalid_program");
    const paths = body.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["config.weeklyGoal", "config.preferredDays", "config"]));
    expect((await call("POST", "/api/programs", { config: {} })).status).toBe(422);
    expect(await db.select().from(programs)).toEqual([]);
  });

  it("POST creates the program, places its slots and returns it", async () => {
    // This runs on the real clock, and today gets a slot only while today's window is still ahead in the
    // athlete's zone (ruling 2a-R11): read the clock on both sides of the request.
    const today = todayInZone(prefs.timezone);
    const window = isWeekend(today) ? prefs.weekendMorningTime : prefs.weekdayMorningTime;
    const localTime = () =>
      new Intl.DateTimeFormat("en-GB", { timeZone: prefs.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    const goneBefore = localTime() >= window;
    const res = await call("POST", "/api/programs", {
      name: "Mobility",
      config: { weeklyGoal: 7, placementWeeksAhead: 1 },
    });
    const goneAfter = localTime() >= window;
    expect(res.status).toBe(201);
    const { program } = (await res.json()) as { program: { id: string; week: { placed: number; goal: number } } };
    const daysLeft = 7 - daysBetween(startOfIsoWeek(today), today);
    expect(program).toMatchObject({ kind: "adaptive", name: "Mobility", status: "active", block: null });
    // Every day from tomorrow to next Sunday holds one, and today too unless its window has gone; this week's
    // count is what is left of it.
    const slots = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, program.id));
    const todayHeld = slots.some((s) => s.effectiveDate === today);
    if (!goneAfter) expect(todayHeld).toBe(true);
    if (goneBefore) expect(todayHeld).toBe(false);
    const thisWeek = daysLeft - (todayHeld ? 0 : 1);
    expect(slots).toHaveLength(thisWeek + 7);
    expect(program.week).toEqual({ placed: thisWeek, done: 0, goal: 7 });
  });

  it("GET also names the account's places and its switched-on profiles — what the program settings pick from", async () => {
    const empty = (await (await call("GET", "/api/programs")).json()) as { places: unknown[]; profiles: unknown[] };
    expect(empty.places).toEqual([]);
    expect(empty.profiles).toEqual([]);
    await db.insert(schema.locations).values([
      { id: "l-gym", userId, name: "Gym", equipment: ["mat"], implements: {}, isDefault: false, createdAt: T0, updatedAt: T0 },
      { id: "l-home", userId, name: "Flat", equipment: ["mat"], implements: {}, isDefault: true, createdAt: T1, updatedAt: T1 },
    ]);
    await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: MON, settings: {} });
    const { userId: other } = await makeTestUser(db);
    await db.insert(schema.locations).values({ id: "l-x", userId: other, name: "Theirs", equipment: [], implements: {}, isDefault: true, createdAt: T0, updatedAt: T0 });
    const body = (await (await call("GET", "/api/programs")).json()) as { places: unknown[]; profiles: unknown[] };
    expect(body.places).toEqual([
      { id: "l-home", name: "Flat", isDefault: true },
      { id: "l-gym", name: "Gym", isDefault: false },
    ]);
    expect(body.profiles).toEqual([{ profileId: "tmj", check: { label: "Jaw / head", min: 0, max: 10 }, care: "Jaw care" }]);
  });

  it("GET lists this user's programs only", async () => {
    await call("POST", "/api/programs", { name: "Mobility", config: {} });
    const { userId: other } = await makeTestUser(db);
    await createAdaptiveProgram(db, other, { name: "Theirs", config: config() }, nowInstant());
    const res = await call("GET", "/api/programs");
    expect(res.status).toBe(200);
    const { programs: list } = (await res.json()) as { programs: Array<{ name: string }> };
    expect(list.map((p) => p.name)).toEqual(["Mobility"]);
  });

  it("PATCH merges the config and re-places; retiring takes the future slots off; 404 and 422 as due", async () => {
    const created = await call("POST", "/api/programs", {
      name: "Mobility",
      config: { weeklyGoal: 2, preferredDays: [0, 3], placementWeeksAhead: 2 },
    });
    const { program } = (await created.json()) as { program: { id: string } };
    const live = async () =>
      (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.planId, program.id))).filter((r) => !r.archivedAt);
    const today = todayInZone(prefs.timezone);
    const nextMonday = addDays(startOfIsoWeek(today), 7);

    const patched = await call("PATCH", `/api/programs/${program.id}`, { config: { weeklyGoal: 1 } });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { program: { config: { weeklyGoal: number; preferredDays: number[] } } };
    expect(body.program.config).toMatchObject({ weeklyGoal: 1, preferredDays: [0, 3] });
    // Next week keeps its Monday and loses its Thursday.
    const nextWeek = (await live()).filter((r) => r.effectiveDate >= nextMonday && r.effectiveDate < addDays(nextMonday, 7));
    expect(nextWeek.map((r) => r.effectiveDate)).toEqual([nextMonday]);

    const retired = await call("PATCH", `/api/programs/${program.id}`, { status: "retired" });
    expect(retired.status).toBe(200);
    expect((await live()).filter((r) => r.effectiveDate > today)).toEqual([]);

    expect((await call("PATCH", `/api/programs/${program.id}`, { config: { modes: [] } })).status).toBe(422);
    expect((await call("PATCH", `/api/programs/${program.id}`, { status: "archived" })).status).toBe(422);
    expect((await call("PATCH", "/api/programs/nope", { name: "x" })).status).toBe(404);
    const { userId: other } = await makeTestUser(db);
    const otherCookie = `${SESSION_COOKIE}=${await createSession(db, other, "test")}`;
    expect((await call("PATCH", `/api/programs/${program.id}`, { name: "Mine" }, otherCookie)).status).toBe(404);
  });

  it("refuses writes while a restore is replacing the account (423), still answers the list", async () => {
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    expect((await call("POST", "/api/programs", { name: "Mobility", config: {} })).status).toBe(423);
    expect((await call("GET", "/api/programs")).status).toBe(200);
  });
});
