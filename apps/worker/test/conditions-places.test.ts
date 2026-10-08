/**
 * Health conditions, places and equipment, weight units and the wishlist — the server (Phase 2 spec §2c "Settings
 * sections"; plan Task 2, Review Focus 5).
 *
 * The services take `today` and `now` explicitly (fixed dates: nothing here can go stale); the routes use the real
 * clock, and their tests assert nothing that depends on it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { EQUIPMENT, EQUIPMENT_IDS, LOAD_IMPLEMENTS, PROFILE_IDS, TMJ } from "@rg/exercise-library";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { conditionSettingsRoutes } from "../src/routes/conditions.js";
import { conditionRoutes } from "../src/routes/sessions.js";
import type { AppContext } from "../src/auth/middleware.js";
import { placeRoutes } from "../src/routes/places.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { listConditions, setCondition } from "../src/services/user-conditions.js";
import { createPlace, deletePlace, listPlaces, PlaceInUseError, PlaceNotFoundError, updatePlace } from "../src/services/places.js";
import { RestoreInProgressError } from "../src/services/programs.js";
import { loadEngineContext } from "../src/services/engine-inputs.js";
import { todayConditions } from "../src/services/condition-views.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { accountState, locations, programs, userConditions } = schema;

const T0 = "2026-06-02T12:00:00.000Z";
const T1 = "2026-09-20T12:00:00.000Z";
const T2 = "2026-10-07T12:00:00.000Z";

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let cookie: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

function makeEnv(): Env {
  return { DB: {} as Env["DB"], ASSETS: {} as Env["ASSETS"], APP_URL: "https://app.test", SESSION_SECRET: "s", AI_DEFAULT_ENABLED: "0" } as Env;
}

const request = (routes: Parameters<typeof mountRoutes>[2], base: string) => (method: string, path: string, body?: unknown, as: string = cookie) =>
  mountRoutes(db, base, routes).request(
    path,
    { method, headers: { Cookie: as, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    makeEnv(),
  );
const conditions = request(conditionSettingsRoutes, "/api/conditions");
const places = request(placeRoutes, "/api/places");
const settings = request(settingsRoutes, "/api/settings");

async function markRestoring(owner: string = userId): Promise<void> {
  await db.insert(accountState).values({ userId: owner, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
}

async function seedProgram(name: string, defaultLocationId: string | null, status = "active"): Promise<string> {
  const id = newId();
  await db.insert(programs).values({
    id, userId, kind: "adaptive", name, status, disciplines: ["yoga", "strength"], startDate: null, endDate: null, raceDate: null,
    source: null, config: adaptiveConfigSchema.parse({ defaultLocationId }), createdAt: T0, updatedAt: T0, archivedAt: null,
  });
  return id;
}

// ── Health conditions ────────────────────────────────────────────────────────────────────────────────────────────

describe("health conditions", () => {
  it("lists every profile the library knows, labelled by the profile, off until switched on", async () => {
    expect(await listConditions(db, userId)).toEqual(
      PROFILE_IDS.map((id) => ({ profileId: id, label: id === "tmj" ? TMJ.label : expect.any(String), active: false, since: null })),
    );
  });

  it("Review Focus 5: off and on again keeps the first day; the rules apply only while it is on", async () => {
    await setCondition(db, userId, { profileId: "tmj", active: true }, { today: "2026-06-02" });
    expect(await listConditions(db, userId)).toEqual([{ profileId: "tmj", label: TMJ.label, active: true, since: "2026-06-02" }]);
    const programId = await seedProgram("Mobility", null);
    await db.update(programs).set({ config: adaptiveConfigSchema.parse({ careProfiles: ["tmj"] }) }).where(eq(programs.id, programId));
    expect(await loadEngineContext(db, userId, programId, {})).toMatchObject({ activeProfiles: ["tmj"], careProfiles: ["tmj"] });
    expect((await todayConditions(db, userId, "2026-06-02")).map((c) => c.profileId)).toEqual(["tmj"]);

    await setCondition(db, userId, { profileId: "tmj", active: false }, { today: "2026-09-20" });
    expect(await listConditions(db, userId)).toEqual([{ profileId: "tmj", label: TMJ.label, active: false, since: "2026-06-02" }]);
    // Off: no rules, no care, no chip.
    expect(await loadEngineContext(db, userId, programId, {})).toMatchObject({ activeProfiles: [], careProfiles: [] });
    expect(await todayConditions(db, userId, "2026-09-20")).toEqual([]);

    await setCondition(db, userId, { profileId: "tmj", active: true }, { today: "2026-10-07" });
    expect(await listConditions(db, userId)).toEqual([{ profileId: "tmj", label: TMJ.label, active: true, since: "2026-06-02" }]);
    expect(await loadEngineContext(db, userId, programId, {})).toMatchObject({ activeProfiles: ["tmj"], careProfiles: ["tmj"] });
    expect(await db.select().from(userConditions)).toHaveLength(1);
  });

  it("switching off a profile never switched on writes nothing", async () => {
    statements.length = 0;
    await setCondition(db, userId, { profileId: "tmj", active: false }, { today: "2026-10-07" });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await db.select().from(userConditions)).toEqual([]);
  });

  it("is per account", async () => {
    const other = (await makeTestUser(db)).userId;
    await setCondition(db, other, { profileId: "tmj", active: true }, { today: "2026-10-07" });
    expect((await listConditions(db, userId))[0]).toMatchObject({ active: false, since: null });
  });

  it("refuses while a restore is replacing the account", async () => {
    await markRestoring();
    await expect(setCondition(db, userId, { profileId: "tmj", active: true }, { today: "2026-10-07" })).rejects.toBeInstanceOf(RestoreInProgressError);
    expect(await db.select().from(userConditions)).toEqual([]);
  });

  describe("GET/PUT /api/conditions", () => {
    it("PUT switches a profile and answers with the list; the first day is the athlete's today", async () => {
      const res = await conditions("PUT", "/api/conditions", { profileId: "tmj", active: true });
      expect(res.status).toBe(200);
      const today = todayInZone(prefs.timezone);
      expect(await res.json()).toEqual({ profiles: [{ profileId: "tmj", label: TMJ.label, active: true, since: today }] });
      expect(await (await conditions("GET", "/api/conditions")).json()).toEqual({ profiles: [{ profileId: "tmj", label: TMJ.label, active: true, since: today }] });
    });

    it("shares its base path with the day's check, as the app mounts them, each authenticated once", async () => {
      const app = new Hono<AppContext>();
      app.use("*", async (c, next) => {
        c.set("db", db);
        await next();
      });
      app.route("/api/conditions", conditionRoutes);
      app.route("/api/conditions", conditionSettingsRoutes);
      const send = (method: string, path: string, body?: unknown) =>
        app.request(path, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, makeEnv());
      expect((await send("PUT", "/api/conditions", { profileId: "tmj", active: true })).status).toBe(200);
      statements.length = 0;
      const check = await send("POST", "/api/conditions/checks", { profileId: "tmj", value: 2 });
      expect(check.status).toBe(200);
      expect(statements.filter((s) => /from "sessions"/i.test(s))).toHaveLength(1);
      statements.length = 0;
      expect((await (await send("GET", "/api/conditions")).json()) as object).toMatchObject({ profiles: [{ profileId: "tmj", active: true }] });
      expect(statements.filter((s) => /from "sessions"/i.test(s))).toHaveLength(1);
    });

    it("422 for an unknown profile or a malformed body; 423 while restoring; 401 signed out", async () => {
      for (const body of [{ profileId: "gout", active: true }, { profileId: "tmj" }, { profileId: "tmj", active: "yes" }, { profileId: "tmj", active: true, extra: 1 }]) {
        const res = await conditions("PUT", "/api/conditions", body);
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
      expect((await conditions("GET", "/api/conditions", undefined, "")).status).toBe(401);
      await markRestoring();
      expect((await conditions("PUT", "/api/conditions", { profileId: "tmj", active: true })).status).toBe(423);
      expect(await db.select().from(userConditions)).toEqual([]);
    });
  });
});

// ── Places & equipment ─────────────────────────────────────────────────────────────────────────────────────────

describe("places and equipment", () => {
  it("the first place is the default; places list the default first, then by age", async () => {
    const home = await createPlace(db, userId, { name: " Home ", equipment: ["mat", "kettlebell"], implements: { kettlebell: "10, 15, 20 lb" } }, T0);
    const gym = await createPlace(db, userId, { name: "Gym", equipment: ["mat", "dumbbells", "barbell"] }, T1);
    expect(await listPlaces(db, userId)).toEqual([
      { id: home, name: "Home", equipment: ["mat", "kettlebell"], implements: { kettlebell: "10, 15, 20 lb" }, isDefault: true },
      { id: gym, name: "Gym", equipment: ["mat", "dumbbells", "barbell"], implements: {}, isDefault: false },
    ]);
    await updatePlace(db, userId, gym, { isDefault: true }, T2);
    expect((await listPlaces(db, userId)).map((p) => [p.name, p.isDefault])).toEqual([["Gym", true], ["Home", false]]);
  });

  it("Review Focus 3: an implement list is stored exactly as typed, and the build reads each weight in its own unit", async () => {
    const id = await createPlace(db, userId, { name: "Home", equipment: ["kettlebell", "mat"], implements: { kettlebell: "10, 15, 20 lb, 12kg" } }, T0);
    const [row] = await db.select().from(locations).where(eq(locations.id, id));
    expect(row!.implements).toEqual({ kettlebell: "10, 15, 20 lb, 12kg" });
    expect((await listPlaces(db, userId))[0]!.implements).toEqual({ kettlebell: "10, 15, 20 lb, 12kg" });
    const programId = await seedProgram("Mobility", id);
    const ctx = await loadEngineContext(db, userId, programId, {});
    expect(ctx.location.implements?.kettlebell).toEqual([
      { v: 10, u: "lb" },
      { v: 15, u: "lb" },
      { v: 20, u: "lb" },
      { v: 12, u: "kg" },
    ]);
  });

  it("a list typed with no unit is saved with the unit then in force, so toggling Weights never changes what it means (Audit 2c-A MINOR-4)", async () => {
    const setUnit = async (weightUnit: "lb" | "kg") => expect((await settings("PUT", "/api/settings", { weightUnit })).status).toBe(200);
    await setUnit("kg");
    const created = await places("POST", "/api/places", { name: "Home", equipment: ["kettlebell", "dumbbells"], implements: { kettlebell: "10, 15, 20", dumbbells: "5, 10 lb" } });
    const { place } = (await created.json()) as { place: { id: string; implements: Record<string, string> } };
    expect(place.implements).toEqual({ kettlebell: "10, 15, 20 kg", dumbbells: "5, 10 lb" });
    await setUnit("lb");
    const programId = await seedProgram("Mobility", place.id);
    const ctx = await loadEngineContext(db, userId, programId, {});
    expect(ctx.location.implements?.kettlebell).toEqual([{ v: 10, u: "kg" }, { v: 15, u: "kg" }, { v: 20, u: "kg" }]);
    // A change typed in pounds now: the unit in force then.
    const patched = await places("PATCH", `/api/places/${place.id}`, { implements: { kettlebell: "35, 40" } });
    expect(((await patched.json()) as { place: { implements: Record<string, string> } }).place.implements).toEqual({ kettlebell: "35, 40 lb" });
  });

  it("validates gear against the vocabulary and every list as weights; nothing is written for a refusal", async () => {
    const bad = [
      { name: "X", equipment: ["mat", "trampoline"] },
      { name: "X", equipment: ["mat", "mat"] },
      { name: "", equipment: ["mat"] },
      { name: "X", equipment: ["kettlebell"], implements: { kettlebell: "10, 12 stone" } },
      { name: "X", equipment: ["kettlebell"], implements: { kettlebell: "heavy" } },
      { name: "X", equipment: ["mat"], implements: { mat: "10 lb" } },
    ];
    for (const body of bad) {
      const res = await places("POST", "/api/places", body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_place");
    }
    expect(await db.select().from(locations)).toEqual([]);
  });

  it("a list for gear the place does not have is not kept; an empty list is no list", async () => {
    const id = await createPlace(db, userId, { name: "Home", equipment: ["mat", "kettlebell"], implements: { kettlebell: "8, 12 kg", dumbbells: "10 lb" } }, T0);
    expect((await listPlaces(db, userId))[0]!.implements).toEqual({ kettlebell: "8, 12 kg" });
    await updatePlace(db, userId, id, { equipment: ["mat"] }, T1);
    expect((await listPlaces(db, userId))[0]!.implements).toEqual({});
    await updatePlace(db, userId, id, { equipment: ["mat", "dumbbells"], implements: { dumbbells: "  " } }, T1);
    expect((await listPlaces(db, userId))[0]!.implements).toEqual({});
  });

  it("deleting the default promotes the oldest other place", async () => {
    const a = await createPlace(db, userId, { name: "A", equipment: ["mat"] }, T0);
    const b = await createPlace(db, userId, { name: "B", equipment: ["mat"] }, T1);
    const c = await createPlace(db, userId, { name: "C", equipment: ["mat"] }, T2);
    await updatePlace(db, userId, c, { isDefault: true }, T2);
    await deletePlace(db, userId, c);
    expect((await listPlaces(db, userId)).map((p) => [p.id, p.isDefault])).toEqual([[a, true], [b, false]]);
    await deletePlace(db, userId, b);
    await deletePlace(db, userId, a);
    expect(await listPlaces(db, userId)).toEqual([]);
  });

  it("a place a program builds at cannot be deleted: 409 naming the program", async () => {
    const a = await createPlace(db, userId, { name: "A", equipment: ["mat"] }, T0);
    const programId = await seedProgram("Jaw care", a);
    await expect(deletePlace(db, userId, a)).rejects.toEqual(new PlaceInUseError({ id: programId, name: "Jaw care" }));
    const res = await places("DELETE", `/api/places/${a}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "place_in_use", program: { id: programId, name: "Jaw care" } });
    expect(await db.select().from(locations)).toHaveLength(1);
    // A retired program does not hold the place (its sessions build at the default when it comes back).
    await db.update(programs).set({ status: "retired" }).where(eq(programs.id, programId));
    expect((await places("DELETE", `/api/places/${a}`)).status).toBe(200);
  });

  it("another account's place is not found, for every verb", async () => {
    const other = (await makeTestUser(db)).userId;
    const theirs = await createPlace(db, other, { name: "Theirs", equipment: ["mat"] }, T0);
    await expect(updatePlace(db, userId, theirs, { name: "Mine" }, T1)).rejects.toBeInstanceOf(PlaceNotFoundError);
    await expect(deletePlace(db, userId, theirs)).rejects.toBeInstanceOf(PlaceNotFoundError);
    expect((await places("PATCH", `/api/places/${theirs}`, { name: "Mine" })).status).toBe(404);
    expect((await places("DELETE", `/api/places/${theirs}`)).status).toBe(404);
    expect(await listPlaces(db, userId)).toEqual([]);
    const [row] = await db.select().from(locations).where(and(eq(locations.id, theirs), eq(locations.userId, other)));
    expect(row!.name).toBe("Theirs");
  });

  it("every writer refuses while a restore is replacing the account", async () => {
    const a = await createPlace(db, userId, { name: "A", equipment: ["mat"] }, T0);
    await markRestoring();
    statements.length = 0;
    await expect(createPlace(db, userId, { name: "B", equipment: ["mat"] }, T1)).rejects.toBeInstanceOf(RestoreInProgressError);
    await expect(updatePlace(db, userId, a, { name: "Z" }, T1)).rejects.toBeInstanceOf(RestoreInProgressError);
    await expect(deletePlace(db, userId, a)).rejects.toBeInstanceOf(RestoreInProgressError);
    expect(statements.filter(isWrite)).toEqual([]);
  });

  describe("the routes", () => {
    it("GET lists the places with the gear vocabulary and the gear that takes weights, labelled", async () => {
      const res = await places("GET", "/api/places");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        places: [],
        equipment: EQUIPMENT_IDS.map((id) => ({ id, label: EQUIPMENT[id], weighted: (LOAD_IMPLEMENTS as readonly string[]).includes(id) })),
      });
    });

    it("POST creates (201), PATCH changes only what is sent, DELETE removes", async () => {
      const created = await places("POST", "/api/places", { name: "Home", equipment: ["mat", "kettlebell"], implements: { kettlebell: "10, 15, 20 lb, 12kg" } });
      expect(created.status).toBe(201);
      const { place } = (await created.json()) as { place: { id: string } };
      expect(place).toMatchObject({ name: "Home", isDefault: true, implements: { kettlebell: "10, 15, 20 lb, 12kg" } });
      const patched = await places("PATCH", `/api/places/${place.id}`, { name: "Flat" });
      expect(await patched.json()).toEqual({ place: { id: place.id, name: "Flat", equipment: ["mat", "kettlebell"], implements: { kettlebell: "10, 15, 20 lb, 12kg" }, isDefault: true } });
      expect((await places("PATCH", `/api/places/${place.id}`, { isDefault: false })).status).toBe(422);
      expect((await places("DELETE", `/api/places/${place.id}`)).status).toBe(200);
      expect(await db.select().from(locations)).toEqual([]);
    });

    it("423 while restoring; 401 signed out", async () => {
      expect((await places("GET", "/api/places", undefined, "")).status).toBe(401);
      await markRestoring();
      expect((await places("POST", "/api/places", { name: "Home", equipment: ["mat"] })).status).toBe(423);
    });
  });
});

// ── Units and the wishlist (preferences) ─────────────────────────────────────────────────────────────────────────

describe("weights unit and wishlist preferences", () => {
  it("PUT /api/settings keeps the weight unit and a wishlist of known gear only, once each", async () => {
    const res = await settings("PUT", "/api/settings", { weightUnit: "kg", equipmentWishlist: ["band", "trampoline", "band", "massage-ball"] });
    expect(res.status).toBe(200);
    const stored = await loadPreferences(db, userId);
    expect(stored.weightUnit).toBe("kg");
    expect(stored.equipmentWishlist).toEqual(["band", "massage-ball"]);
    expect((await settings("PUT", "/api/settings", { weightUnit: "stone" })).status).toBe(400);
    expect((await loadPreferences(db, userId)).weightUnit).toBe("kg");
  });
});
