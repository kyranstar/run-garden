/**
 * The athlete's profile (programme spec §3.6, Amendment A; principles §5.1): goals, focus areas with their region and
 * muscle refs, events and a few preferences, written by `PUT /api/profile`; units, timezone, the race, places and
 * conditions returned read-only from where they live. And the restore safety the profile row needs: its id IS the
 * account's id, so a restore into another account re-keys it, and the file's row wins the account's one profile.
 *
 * Synthetic data only; fixed dates where a service takes them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, type ProfileDto, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { profileRoutes } from "../src/routes/profile.js";
import { loadProfile, updateProfile } from "../src/services/profile.js";
import { createPlace, deletePlace } from "../src/services/places.js";
import { setCondition } from "../src/services/user-conditions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { exportAll, restoreAll } from "./restore-driver.js";

const { accountState, athleteProfiles } = schema;

const T0 = "2026-06-02T12:00:00.000Z";

let db: Db;
let statements: string[];
let userId: string;
let prefs: UserPreferences;
let cookie: string;

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (sql) => statements.push(sql) });
  ({ userId, prefs } = await makeTestUser(db, { units: "mi", weightUnit: "kg", temperatureUnit: "C", raceDate: "2026-11-15", raceDistanceKm: 21.0975 }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

function makeEnv(): Env {
  return { DB: {} as Env["DB"], ASSETS: {} as Env["ASSETS"], APP_URL: "https://app.test", SESSION_SECRET: "s", AI_DEFAULT_ENABLED: "0" } as Env;
}

const call = (method: string, body?: unknown, as: string = cookie) =>
  mountRoutes(db, "/api/profile", profileRoutes).request(
    "/api/profile",
    { method, headers: { Cookie: as, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    makeEnv(),
  );

async function cookieFor(owner: string): Promise<string> {
  return `${SESSION_COOKIE}=${await createSession(db, owner, "test")}`;
}

const GOALS = [
  { id: "ski", words: "Ski a whole day without sore knees" },
  { id: "posture", words: "Sit and stand taller" },
];
const FOCUS = [{ id: "upper-back", label: "Upper back", refs: ["upper-back", "rhomboids"], note: "tight after long days" }];
const EVENTS = [{ label: "Half marathon", kind: "race", start: "2026-11-15", priority: "A", taper: true }];

describe("GET /api/profile", () => {
  it("answers an empty profile before the first write, with units, timezone, race, places and conditions read-only — and writes nothing", async () => {
    const placeId = await createPlace(db, userId, { name: "Home", equipment: ["dumbbells"], implements: { dumbbells: "10, 15 kg" } }, T0);
    await setCondition(db, userId, { profileId: "tmj", active: true }, { today: "2026-06-02" });
    statements.length = 0;

    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileDto;
    expect(body).toMatchObject({
      goals: [],
      focusAreas: [],
      events: [],
      preferences: {},
      units: { distance: "mi", weight: "kg", temperature: "C" },
      timezone: prefs.timezone,
      race: { date: "2026-11-15", distanceKm: 21.0975 },
      places: [{ id: placeId, name: "Home", equipment: ["dumbbells"], implements: { dumbbells: "10, 15 kg" }, isDefault: true }],
      updatedAt: null,
    });
    expect(body.conditions).toContainEqual({ profileId: "tmj", label: expect.any(String), active: true, since: "2026-06-02" });
    expect(statements.filter(isWrite)).toEqual([]);
    expect(statements.length).toBeLessThanOrEqual(45);
  });

  it("is 401 without a session", async () => {
    expect((await call("GET", undefined, "")).status).toBe(401);
  });

  it("shows only this account's profile", async () => {
    const { userId: other } = await makeTestUser(db);
    await updateProfile(db, other, { goals: GOALS }, T0);
    const body = (await (await call("GET")).json()) as ProfileDto;
    expect(body.goals).toEqual([]);
    expect((await loadProfile(db, other)).goals).toEqual(GOALS);
  });

  it("leaves out a default place that has since been deleted", async () => {
    const gym = await createPlace(db, userId, { name: "Gym", equipment: [] }, T0);
    await createPlace(db, userId, { name: "Home", equipment: [] }, T0);
    await updateProfile(db, userId, { preferences: { defaultPlaceId: gym, trainingDays: [1] } }, T0);
    await deletePlace(db, userId, gym);
    const body = (await (await call("GET")).json()) as ProfileDto;
    expect(body.preferences).toEqual({ trainingDays: [1] });
  });

  it("reads past a stored list that is no longer valid: the valid entries stay, the rest are left out, never a 500", async () => {
    await db.insert(athleteProfiles).values({
      id: userId,
      userId,
      goals: [{ id: "ski", words: "Ski" }, { id: "not-a-goal", words: "x" }, "junk"] as unknown[],
      focusAreas: { not: "a list" } as unknown as unknown[],
      events: [],
      preferences: { trainingDays: "monday" },
      updatedAt: T0,
    });
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileDto;
    expect(body.goals).toEqual([{ id: "ski", words: "Ski" }]);
    expect(body.focusAreas).toEqual([]);
    expect(body.preferences).toEqual({});
  });
});

describe("PUT /api/profile", () => {
  it("writes goals, focus areas, events and preferences, and answers the whole profile", async () => {
    const placeId = await createPlace(db, userId, { name: "Gym", equipment: ["barbell"] }, T0);
    const res = await call("PUT", {
      goals: GOALS,
      focusAreas: FOCUS,
      events: EVENTS,
      preferences: { sessionMinutes: { default: 40, max: 60 }, trainingDays: [0, 2, 4], defaultPlaceId: placeId },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileDto;
    expect(body.goals).toEqual(GOALS);
    expect(body.focusAreas).toEqual(FOCUS);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ ...EVENTS[0], id: expect.any(String) });
    expect(body.preferences).toEqual({ sessionMinutes: { default: 40, max: 60 }, trainingDays: [0, 2, 4], defaultPlaceId: placeId });
    expect(body.updatedAt).not.toBeNull();
    expect(await loadProfile(db, userId)).toEqual(body);
  });

  it("changes only what is sent; an event keeps the id it was given", async () => {
    await call("PUT", { goals: GOALS, events: EVENTS });
    const first = (await (await call("GET")).json()) as ProfileDto;
    const eventId = first.events[0]!.id;

    const res = await call("PUT", { focusAreas: FOCUS, events: [{ ...first.events[0], label: "Half marathon (goal race)" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProfileDto;
    expect(body.goals).toEqual(GOALS);
    expect(body.focusAreas).toEqual(FOCUS);
    expect(body.events).toEqual([{ ...first.events[0], id: eventId, label: "Half marathon (goal race)" }]);
    const rows = await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(eq(athleteProfiles.userId, userId));
    expect(rows).toEqual([{ id: userId }]);
  });

  it.each([
    ["units", { units: { distance: "km" } }],
    ["the weight unit", { weightUnit: "lb" }],
    ["the timezone", { timezone: "Europe/Paris" }],
    ["places", { places: [] }],
    ["conditions", { conditions: [] }],
    ["the race", { race: { date: "2027-01-01" } }],
  ])("refuses %s (they are changed where they live) — 422, nothing written", async (_what, body) => {
    const res = await call("PUT", { goals: GOALS, ...body });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_profile", issues: expect.any(Array) });
    expect(await db.select().from(athleteProfiles)).toEqual([]);
    const after = (await (await call("GET")).json()) as ProfileDto;
    expect(after.units).toEqual({ distance: "mi", weight: "kg", temperature: "C" });
  });

  it.each([
    ["an empty body", {}],
    ["a goal outside the goal ids", { goals: [{ id: "flying", words: "fly" }] }],
    ["a goal listed twice", { goals: [GOALS[0], GOALS[0]] }],
    ["a focus area with no refs", { focusAreas: [{ id: "hips", label: "Hips", refs: [] }] }],
    ["a focus area id that is not a slug", { focusAreas: [{ id: "Left Hip", label: "Hip", refs: ["hips"] }] }],
    ["an event ending before it starts", { events: [{ ...EVENTS[0], end: "2026-11-01" }] }],
    ["an event kind outside the list", { events: [{ ...EVENTS[0], kind: "party" }] }],
    ["a training day past Sunday", { preferences: { trainingDays: [7] } }],
    ["a session max shorter than its usual", { preferences: { sessionMinutes: { default: 50, max: 30 } } }],
    ["an unknown preference", { preferences: { theme: "dark" } }],
  ])("is 422 for %s", async (_what, body) => {
    const res = await call("PUT", body);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_profile", issues: expect.any(Array) });
  });

  it("is 422 for a focus-area ref the library's regions and muscles do not hold, naming it", async () => {
    const res = await call("PUT", { focusAreas: [{ id: "hips", label: "Hips", refs: ["hips", "elbow-wings"] }] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: Array<{ path: Array<string | number>; message: string }> };
    expect(body.issues).toContainEqual(expect.objectContaining({ path: ["focusAreas", 0, "refs", 1] }));
    expect(await db.select().from(athleteProfiles)).toEqual([]);
  });

  it("is 422 for a default place that is not one of this account's", async () => {
    const { userId: other } = await makeTestUser(db);
    const theirs = await createPlace(db, other, { name: "Their gym", equipment: [] }, T0);
    for (const defaultPlaceId of [theirs, "no-such-place"]) {
      const res = await call("PUT", { preferences: { defaultPlaceId } });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { issues: Array<{ path: Array<string | number> }> };
      expect(body.issues).toContainEqual(expect.objectContaining({ path: ["preferences", "defaultPlaceId"] }));
    }
  });

  it("is 423 while a restore is replacing the account", async () => {
    await db.insert(accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    expect((await call("PUT", { goals: GOALS })).status).toBe(423);
    await expect(updateProfile(db, userId, { goals: GOALS }, T0)).rejects.toThrow();
    expect(await db.select().from(athleteProfiles)).toEqual([]);
  });

  it("stays within 45 statements, one write", async () => {
    await createPlace(db, userId, { name: "Home", equipment: [] }, T0);
    statements.length = 0;
    const res = await call("PUT", { goals: GOALS, focusAreas: FOCUS, events: EVENTS, preferences: { trainingDays: [1] } });
    expect(res.status).toBe(200);
    expect(statements.length).toBeLessThanOrEqual(45);
    expect(statements.filter(isWrite)).toHaveLength(1);
  });

  it("never touches another account's profile", async () => {
    const { userId: other } = await makeTestUser(db);
    await updateProfile(db, other, { goals: [GOALS[1]!] }, T0);
    await call("PUT", { goals: [GOALS[0]!] });
    expect((await loadProfile(db, other)).goals).toEqual([GOALS[1]]);
    const otherCookie = await cookieFor(other);
    const theirs = (await (await call("GET", undefined, otherCookie)).json()) as ProfileDto;
    expect(theirs.goals).toEqual([GOALS[1]]);
  });
});

// ── Restore: the profile row's id is the account's id ─────────────────────────────────────────────────────────────

describe("restore", () => {
  it("restoring a copy of one account into another re-keys the profile to the new account, leaving the source's alone", async () => {
    await updateProfile(db, userId, { goals: GOALS, focusAreas: FOCUS }, T0);
    const file = await exportAll(db, userId);
    expect(file.tables.athlete_profiles).toEqual([expect.objectContaining({ id: userId, userId })]);

    const { userId: fresh } = await makeTestUser(db);
    const outcome = await restoreAll(db, fresh, file);
    expect(outcome.lost).toBe(0);
    expect(outcome.short).toEqual([]);

    const rows = await db.select({ id: athleteProfiles.id, userId: athleteProfiles.userId }).from(athleteProfiles);
    expect(rows.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(
      [{ id: userId, userId }, { id: fresh, userId: fresh }].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
    expect((await loadProfile(db, fresh)).goals).toEqual(GOALS);
    // The restored account writes its own profile as any other: one row, its own.
    await updateProfile(db, fresh, { goals: [GOALS[1]!] }, T0);
    expect((await loadProfile(db, fresh)).goals).toEqual([GOALS[1]]);
    expect((await loadProfile(db, userId)).goals).toEqual(GOALS);
  });

  it("the file's profile wins the account's one row over a profile written after the restore began", async () => {
    await updateProfile(db, userId, { goals: GOALS }, T0);
    const file = await exportAll(db, userId);
    const { userId: fresh } = await makeTestUser(db);

    const outcome = await restoreAll(db, fresh, file, {
      // A writer that missed the restore marker: the account's profile appears before the file's row arrives.
      beforeRows: async () => {
        await db.insert(athleteProfiles).values({ id: fresh, userId: fresh, goals: [{ id: "speed", words: "late writer" }], updatedAt: T0 });
      },
    });
    expect(outcome.lost).toBe(0);
    const rows = await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(eq(athleteProfiles.userId, fresh));
    expect(rows).toEqual([{ id: fresh }]);
    expect((await loadProfile(db, fresh)).goals).toEqual(GOALS);
  });

  it("a file's profile whose id another account holds is counted lost, and the restore carries on", async () => {
    // A row from an older writer: its id is not the account's id, so nothing re-keys it.
    await db.insert(athleteProfiles).values({ id: "profile-older-writer", userId, goals: GOALS, updatedAt: T0 });
    const file = await exportAll(db, userId);
    await db.delete(athleteProfiles);
    const { userId: holder } = await makeTestUser(db);
    await db.insert(athleteProfiles).values({ id: "profile-older-writer", userId: holder, goals: [GOALS[1]!], updatedAt: T0 });

    const { userId: fresh } = await makeTestUser(db);
    const outcome = await restoreAll(db, fresh, file);
    expect(outcome.lost).toBe(1);
    expect(await db.select({ id: athleteProfiles.id }).from(athleteProfiles).where(eq(athleteProfiles.userId, fresh))).toEqual([]);
    expect((await loadProfile(db, holder)).goals).toEqual([GOALS[1]]);
  });

  it("a same-account restore round-trips the profile exactly", async () => {
    await updateProfile(db, userId, { goals: GOALS, events: EVENTS }, T0);
    const before = await exportAll(db, userId);
    await restoreAll(db, userId, before);
    const after = await exportAll(db, userId);
    expect(after.tables.athlete_profiles).toEqual(before.tables.athlete_profiles);
  });
});
