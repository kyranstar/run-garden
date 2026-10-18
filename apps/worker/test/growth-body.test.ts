/**
 * `GET /api/growth/body?period=month|season` (the new shape §7): Growth's body map — how much each area of the figure
 * was worked over the last 30 or 90 days, from the coach's own exposure computation (`readExposure`, read_balance's),
 * what carried the period, the area gone quiet, and the period's longest holds.
 *
 *  - an area gathers the library regions it draws, and a move counts once per area (a band row loads the upper back and
 *    the lats: three sets of the back, not six);
 *  - a run loads the hips and the legs: those areas count the period's runs, and a run is the last day they were worked;
 *  - the quiet area is, of those worked in the period and the athlete's focus areas, the one longest without work, from
 *    QUIET_DAYS; an area the athlete focuses on and never worked is quiet for the whole period;
 *  - a hold is an isometric strength move done for time; a set held a side at a time counts at its shorter side;
 *  - the athlete's own rows only; two statements and the session's, within D1's bound-variable cap.
 *
 * Synthetic data only. Dates are relative to the athlete's today, read as the route reads it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, QUIET_DAYS, todayInZone, type GrowthBodyDto } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { growthRoutes } from "../src/routes/growth.js";
import { areaLevel, GROWTH_BODY_STATEMENTS } from "../src/services/growth-body.js";
import { RUN_REGIONS } from "../src/services/body-exposure.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { activities, athleteProfiles, performedSessions, performedSets } = schema;
const T0 = "2026-10-01T12:00:00.000Z";
const ENV = { DB: {} as Env["DB"], ASSETS: {} as Env["ASSETS"], APP_URL: "https://app.test", SESSION_SECRET: "s", AI_DEFAULT_ENABLED: "0" } as Env;

let db: Db;
let statements = 0;
let userId: string;
let cookie: string;
let today: string;
const day = (n: number) => addDays(today, -n);

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  const user = await makeTestUser(db, { timezone: "America/Los_Angeles" });
  userId = user.userId;
  today = todayInZone(user.prefs.timezone);
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
});

async function get(query = "?period=month", as: string | null = cookie) {
  const app = mountRoutes(db, "/api/growth", growthRoutes);
  statements = 0;
  const res = await app.request(`/api/growth/body${query}`, { headers: as ? { Cookie: as } : {} }, ENV);
  return { status: res.status, body: (await res.json().catch(() => null)) as GrowthBodyDto & { error?: string }, cost: statements };
}

type SetSeed = { ex: string; reps?: number; seconds?: number; side?: "left" | "right"; perSide?: boolean; entry?: number; set?: number };

/** A session logged `n` days ago, its done sets as given (each its own set unless `set` says otherwise). */
async function session(
  n: number,
  sets: SetSeed[],
  o: { owner?: string; moves?: Array<{ exerciseId: string; seconds: number }>; source?: string; activityId?: string } = {},
): Promise<string> {
  const id = newId();
  await db.insert(performedSessions).values({
    id, userId: o.owner ?? userId, source: o.source ?? "app", sourceRef: o.source === "watch" ? `w-${id}` : null, activityId: o.activityId ?? null, localDate: day(n), seconds: 1800,
    movesDone: o.moves ?? [], payloadHash: "h", createdAt: T0, updatedAt: T0,
  });
  let i = 0;
  for (const s of sets) {
    await db.insert(performedSets).values({
      id: newId(), performedSessionId: id, entryIndex: s.entry ?? i, exerciseId: s.ex, setIndex: s.set ?? 0, reps: s.reps ?? null, seconds: s.seconds ?? null,
      side: s.side ?? null, perSide: s.perSide ?? false, done: true,
    });
    i += 1;
  }
  return id;
}

const sets = (ex: string, count: number, o: Omit<SetSeed, "ex" | "set"> = { reps: 8 }): SetSeed[] =>
  Array.from({ length: count }, (_, k) => ({ ex, entry: 0, set: k, ...o }));

async function run(n: number, owner = userId): Promise<void> {
  const date = day(n);
  await db.insert(activities).values({
    id: newId(), userId: owner, sport: "run", startTime: `${date}T15:00:00.000Z`, startTimeLocal: `${date}T08:00:00`,
    durationSeconds: 2400, distanceMeters: 7000, avgPaceSecPerKm: 343, createdAt: T0, updatedAt: T0,
  });
}

async function focusOn(...areas: Array<{ id: string; label: string; refs: string[] }>): Promise<void> {
  await db.insert(athleteProfiles).values({ id: newId(), userId, focusAreas: areas, updatedAt: T0 });
}

const area = (b: GrowthBodyDto, id: string) => b.areas.find((a) => a.area === id)!;

describe("GET /api/growth/body", () => {
  it("signed in only; a period it does not know is refused; none given reads the month", async () => {
    expect((await get("?period=month", null)).status).toBe(401);
    const bad = await get("?period=year");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_period");
    const none = await get("");
    expect(none.status).toBe(200);
    expect(none.body.period).toBe("month");
  });

  it("the month is today and the 29 days before; the season today and the 89 before", async () => {
    const m = await get("?period=month");
    expect(m.body).toMatchObject({ period: "month", today, from: day(29) });
    const s = await get("?period=season");
    expect(s.body).toMatchObject({ period: "season", today, from: day(89) });
  });

  it("nothing logged: every area at rest, nothing carried, nothing called quiet, no holds", async () => {
    const { body } = await get();
    expect(body.areas.map((a) => a.area)).toEqual(["neck", "shoulders", "chest", "arms", "back", "core", "hips", "glutes", "quads", "hamstrings", "calves"]);
    expect(body.areas.every((a) => a.level === 0 && a.sets === 0 && a.runs === 0 && a.last === null && a.daysAgo === null)).toBe(true);
    expect(body).toMatchObject({ sessions: 0, runs: 0, other: 0, carried: [], quiet: null, holds: [] });
  });

  it("an area gathers its regions and counts a move once: a band row is three sets of the back (upper back and lats), and of the arms", async () => {
    await session(3, [...sets("bandRow", 3), ...sets("gobletSquat", 3).map((s) => ({ ...s, entry: 1 }))], { moves: [{ exerciseId: "catCow", seconds: 120 }] });
    const { body } = await get();
    // The cat-cow played (thoracic and low back): one more for the back, once.
    expect(area(body, "back")).toMatchObject({ sets: 4, last: day(3), daysAgo: 3 });
    expect(area(body, "arms")).toMatchObject({ sets: 3, last: day(3) });
    for (const id of ["quads", "glutes", "hips"]) expect(area(body, id), id).toMatchObject({ sets: 3, runs: 0, last: day(3) });
    expect(area(body, "neck")).toMatchObject({ sets: 0, level: 0, last: null });
    expect(body.sessions).toBe(1);
  });

  it("a move both logged with sets and played counts by its sets, once", async () => {
    await session(3, sets("bandRow", 3), { moves: [{ exerciseId: "bandRow", seconds: 60 }] });
    expect(area((await get()).body, "back")).toMatchObject({ sets: 3 });
  });

  it("runs work the hips, glutes, quads, hamstrings and calves (RUN_REGIONS, the one list): those areas count the period's runs, and the latest run is their last day", async () => {
    expect([...RUN_REGIONS]).toEqual(["hips", "glutes", "quads", "hamstrings", "calves"]);
    await run(2);
    await run(9);
    await run(40);
    const { body } = await get();
    expect(body.runs).toBe(2);
    for (const id of ["hips", "glutes", "quads", "hamstrings", "calves"]) expect(area(body, id), id).toMatchObject({ sets: 0, runs: 2, last: day(2), daysAgo: 2 });
    for (const id of ["core", "back", "neck"]) expect(area(body, id), id).toMatchObject({ runs: 0, level: 0 });
    // The season holds the older run too.
    expect(area((await get("?period=season")).body, "calves")).toMatchObject({ runs: 3 });
  });

  it("the level is per week of the period: a little, steadily (4 a week), a lot (10 a week)", () => {
    expect(areaLevel(0, 30)).toBe(0);
    expect(areaLevel(1, 30)).toBe(1);
    expect(areaLevel(17, 30)).toBe(1);
    expect(areaLevel(18, 30)).toBe(2);
    expect(areaLevel(42, 30)).toBe(2);
    expect(areaLevel(43, 30)).toBe(3);
    // A season spreads the same work over thirteen weeks.
    expect(areaLevel(43, 90)).toBe(1);
  });

  it("levels on the map: a lot of core, some quads; each run is three sets' worth for the areas it loads", async () => {
    for (let n = 1; n <= 10; n++) await session(n * 2, sets("deadBug", 5));
    await session(4, sets("gobletSquat", 3));
    for (const n of [1, 3, 5, 8, 12, 15]) await run(n);
    const { body } = await get();
    expect(area(body, "core")).toMatchObject({ sets: 50, level: 3 });
    // Quads: 3 sets and 6 runs (18 sets' worth) = 21 in 30 days, 4.9 a week.
    expect(area(body, "quads")).toMatchObject({ sets: 3, runs: 6, level: 2 });
    expect(area(body, "calves")).toMatchObject({ sets: 0, runs: 6, level: 2 });
    expect(area(body, "chest").level).toBe(0);
    // What carried it: the most worked, most first — core, then the hips' and quads' tie broken head to foot.
    expect(body.carried).toEqual(["core", "hips"]);
  });

  it("an area that carried the period is never the quiet one: the quiet area comes from the rest", async () => {
    // Six runs, nine to fourteen days ago, carry the hips and the glutes (and the legs); the core was worked two days ago.
    for (let n = 9; n <= 14; n++) await run(n);
    await session(2, sets("deadBug", 3));
    const { body } = await get();
    expect(body.carried).toEqual(["hips", "glutes"]);
    // The hips were the longest without work, but carried the month: the quads are named, the next head to foot.
    expect(body.quiet).toEqual({ area: "quads", daysAgo: 9 });
  });

  it("the quiet area: of those worked, the one longest without work — from QUIET_DAYS on, never before", async () => {
    // The core and the hips carry it (six sets each); the glutes and the quads, worked yesterday, are the rest.
    await session(QUIET_DAYS - 1, sets("deadBug", 6));
    await session(1, sets("gobletSquat", 6));
    expect((await get()).body.quiet).toBeNull();
    await session(QUIET_DAYS + 3, sets("bandRow", 3));
    // The back and the arms both last worked QUIET_DAYS + 3 days ago: head to foot, the arms come first.
    expect((await get()).body.quiet).toEqual({ area: "arms", daysAgo: QUIET_DAYS + 3 });
  });

  it("quiet from exactly QUIET_DAYS without work", async () => {
    // Yesterday's squats carry the month; the core was worked QUIET_DAYS ago.
    await session(1, sets("gobletSquat", 6));
    await session(QUIET_DAYS, sets("deadBug", 3));
    expect((await get()).body.quiet).toEqual({ area: "core", daysAgo: QUIET_DAYS });
  });

  it("an area the athlete focuses on and never worked in the period is quiet for all of it; one never worked and not a focus is not named", async () => {
    await session(QUIET_DAYS + 1, sets("gobletSquat", 3));
    await focusOn({ id: "upper-back", label: "Upper back", refs: ["upper-back"] }, { id: "left-hip", label: "Left hip", refs: ["deep-hip-rotators"] });
    const { body } = await get();
    // The upper back (the back) was never worked: quiet the whole month. The hip rotators' area (the hips) was, 6 days ago.
    expect(body.quiet).toEqual({ area: "back", daysAgo: null });
  });

  it("holds: an isometric strength move done for time, its longest set in the period, longest first; a side-at-a-time hold at its shorter side", async () => {
    await session(6, [
      { ex: "wallSit", seconds: 45, entry: 0, set: 0 },
      { ex: "wallSit", seconds: 70, entry: 0, set: 1 },
      { ex: "sidePlank", seconds: 40, side: "left", perSide: true, entry: 1, set: 0 },
      { ex: "sidePlank", seconds: 35, side: "right", perSide: true, entry: 1, set: 0 },
      // Held for time and isometric, but no strength hold: a stretch.
      { ex: "couchStretch", seconds: 90, entry: 2, set: 0 },
      // Reps, not a hold.
      { ex: "deadBug", reps: 10, entry: 3, set: 0 },
    ]);
    await session(2, [{ ex: "wallSit", seconds: 60, entry: 0, set: 0 }]);
    // Out of the month.
    await session(45, [{ ex: "wallSit", seconds: 120, entry: 0, set: 0 }]);
    const { body } = await get();
    expect(body.holds).toEqual([
      { exerciseId: "wallSit", name: "Wall sit", seconds: 70, date: day(6) },
      { exerciseId: "sidePlank", name: expect.any(String), seconds: 35, date: day(6) },
    ]);
    expect((await get("?period=season")).body.holds[0]).toMatchObject({ exerciseId: "wallSit", seconds: 120, date: day(45) });
  });

  it("one physical session counts once: the athlete's own record's hold, not the watch's copy of the same activity", async () => {
    const activityId = newId();
    const date = day(4);
    await db.insert(activities).values({
      id: activityId, userId, sport: "strength", startTime: `${date}T15:00:00.000Z`, startTimeLocal: `${date}T08:00:00`, durationSeconds: 1800, createdAt: T0, updatedAt: T0,
    });
    await session(4, [{ ex: "wallSit", seconds: 50, entry: 0, set: 0 }], { activityId });
    await session(4, [{ ex: "wallSit", seconds: 80, entry: 0, set: 0 }], { activityId, source: "watch" });
    const { body } = await get();
    expect(body.sessions).toBe(1);
    expect(body.holds).toEqual([{ exerciseId: "wallSit", name: "Wall sit", seconds: 50, date }]);
  });

  it("a side logged with no time is no side held: the other side's time stands", async () => {
    await session(4, [
      { ex: "sidePlank", seconds: 0, side: "left", perSide: true, entry: 0, set: 0 },
      { ex: "sidePlank", seconds: 35, side: "right", perSide: true, entry: 0, set: 0 },
    ]);
    expect((await get()).body.holds).toEqual([{ exerciseId: "sidePlank", name: expect.any(String), seconds: 35, date: day(4) }]);
  });

  it("a hold equalled later keeps the day it was first held", async () => {
    await session(9, [{ ex: "wallSit", seconds: 60, entry: 0, set: 0 }]);
    await session(3, [{ ex: "wallSit", seconds: 60, entry: 0, set: 0 }]);
    expect((await get()).body.holds).toEqual([{ exerciseId: "wallSit", name: "Wall sit", seconds: 60, date: day(9) }]);
  });

  it("a watch's hold counts as the library move its key maps to", async () => {
    await session(3, [{ ex: "coros:T1231", seconds: 50, entry: 0, set: 0 }], { source: "watch" });
    const { body } = await get();
    expect(body.holds).toEqual([{ exerciseId: "wallSit", name: "Wall sit", seconds: 50, date: day(3) }]);
  });

  it("only the athlete's own rows", async () => {
    const other = (await makeTestUser(db, { timezone: "America/Los_Angeles" })).userId;
    await session(2, sets("deadBug", 5), { owner: other });
    await session(2, [{ ex: "wallSit", seconds: 90, entry: 0, set: 0 }], { owner: other });
    await run(2, other);
    const { body } = await get();
    expect(body).toMatchObject({ sessions: 0, runs: 0, holds: [], carried: [] });
  });

  it("costs the session's statement and GROWTH_BODY_STATEMENTS (two), however much was logged", async () => {
    expect(GROWTH_BODY_STATEMENTS).toBe(2);
    for (let n = 0; n < 30; n++) await session(n, [...sets("deadBug", 3), { ex: "wallSit", seconds: 40 + n, entry: 1, set: 0 }]);
    for (let n = 0; n < 20; n++) await run(n);
    const month = await get("?period=month");
    expect(month.status).toBe(200);
    expect(month.cost).toBe(1 + GROWTH_BODY_STATEMENTS);
    expect((await get("?period=season")).cost).toBe(1 + GROWTH_BODY_STATEMENTS);
  });
});
